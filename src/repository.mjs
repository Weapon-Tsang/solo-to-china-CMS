import { id, json, now, sha256, slugify } from "./utils.mjs";
import { transaction } from "./db.mjs";
import { AI_MODELS, VISUAL_MODELS } from "./config.mjs";
import { CONTENT_STRATEGY } from "./content-strategy.mjs";
import { contentBlockSummary, markdownToContentBlocks } from "./content-blocks.mjs";
import { classifyClaimPair, detectClaimExtractionIssue, structureClaim } from "./claim-resolution.mjs";
import { assessEntityIdentity, inferEntityMetadata, normalizeEntityType, normalizeGranularity, ENTITY_RELATION_TYPES } from "./entity-resolution.mjs";
import { legacyOfferToAsset } from "./commercial.mjs";

export class Repository {
  constructor(db, contentConfig = {}) {
    this.db = db;
    this.contentConfig = {
      staleAfterDays: 365, volatileStaleAfterDays: 90, searchConsoleMinimumImpressions: 10,
      contentStrategy: CONTENT_STRATEGY, ...contentConfig,
    };
    // A running job belongs to the Node process that claimed it. Creating a new
    // repository happens during process startup, so any existing lock was left by
    // an interrupted process and must be made retryable immediately.
    this.db.prepare(`
      UPDATE jobs SET status = 'queued', attempts = 0, locked_at = NULL, started_at = NULL,
        completed_at = NULL, duration_ms = NULL, queue_latency_ms = NULL, updated_at = ?
      WHERE status = 'running'
    `).run(now());
  }

  get strategyVersion() {
    return this.contentConfig.contentStrategy?.version || CONTENT_STRATEGY.version;
  }

  getAiSettings(defaultModel) {
    const saved = this.db.prepare("SELECT value_json FROM runtime_settings WHERE setting_key='ai'").get();
    const model = json(saved?.value_json, {}).model;
    const selected = AI_MODELS.some((item) => item.id === model) ? model : defaultModel;
    const active = AI_MODELS.find((item) => item.id === selected) || AI_MODELS[0];
    return {
      id: active.id, model: active.model, provider: active.provider,
      ...(active.location ? { location: active.location } : {}),
      defaultModel,
      source: AI_MODELS.some((item) => item.id === model) ? "dashboard" : "environment",
      models: AI_MODELS,
    };
  }

  setAiModel(model, defaultModel) {
    if (!AI_MODELS.some((item) => item.id === model)) throw new Error("Unsupported AI model.");
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO runtime_settings(setting_key, value_json, updated_at) VALUES ('ai', ?, ?)
      ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at
    `).run(JSON.stringify({ model }), timestamp);
    return this.getAiSettings(defaultModel);
  }

  getVisualSettings(defaultModel) {
    const saved = this.db.prepare("SELECT value_json FROM runtime_settings WHERE setting_key='visuals'").get();
    const model = json(saved?.value_json, {}).model;
    const selected = VISUAL_MODELS.some((item) => item.id === model) ? model : defaultModel;
    const active = VISUAL_MODELS.find((item) => item.id === selected) || VISUAL_MODELS[0];
    return {
      id: active.id, model: active.model, provider: active.provider, location: active.location || null,
      supportsGeneration: active.supportsGeneration,
      source: VISUAL_MODELS.some((item) => item.id === model) ? "dashboard" : "environment",
      models: VISUAL_MODELS,
    };
  }

  setVisualModel(model, defaultModel) {
    const selected = VISUAL_MODELS.find((item) => item.id === model);
    if (!selected) throw new Error("Unsupported visual model.");
    if (!selected.supportsGeneration) throw new Error("This model can understand images but cannot generate image files through its API.");
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO runtime_settings(setting_key, value_json, updated_at) VALUES ('visuals', ?, ?)
      ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at
    `).run(JSON.stringify({ model }), timestamp);
    return this.getVisualSettings(defaultModel);
  }

  getFrontendContractState() {
    return this.db.prepare("SELECT * FROM frontend_contract_state WHERE singleton=1").get() || null;
  }

  recordFrontendContractAttempt(status, error = null) {
    const timestamp = now();
    this.db.prepare(`
      UPDATE frontend_contract_state SET last_attempt_at=?, last_error=?, status=?, updated_at=? WHERE singleton=1
    `).run(timestamp, error ? String(error).slice(0, 4_000) : null, status, timestamp);
  }

  getActiveFrontendContractSnapshot() {
    return this.db.prepare(`
      SELECT s.* FROM frontend_contract_state st JOIN frontend_contract_snapshots s ON s.id=st.active_snapshot_id
      WHERE st.singleton=1
    `).get() || null;
  }

  listFrontendContractSnapshots(limit = 20) {
    return this.db.prepare(`
      SELECT id, source_repository, registry_source, page_schema_source, frontend_commit_sha, contract_version, schema_version,
        checksum, diff_json, status, synced_at, accepted_at
      FROM frontend_contract_snapshots ORDER BY synced_at DESC LIMIT ?
    `).all(limit).map((row) => ({ ...row, diff: json(row.diff_json, {}) }));
  }

  saveFrontendContractSnapshot(snapshot) {
    const timestamp = now();
    return transaction(this.db, () => {
      let row = this.db.prepare("SELECT * FROM frontend_contract_snapshots WHERE checksum=?").get(snapshot.checksum);
      if (!row) {
        const snapshotId = id("fcontract");
        this.db.prepare(`
          INSERT INTO frontend_contract_snapshots(id, source_repository, registry_source, page_schema_source, frontend_commit_sha,
            contract_version, schema_version, checksum, registry_json, page_schema_json, diff_json, status, synced_at, accepted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(snapshotId, snapshot.sourceRepository, snapshot.registrySource, snapshot.pageSchemaSource, snapshot.frontendCommitSha,
          snapshot.contractVersion, snapshot.schemaVersion, snapshot.checksum, JSON.stringify(snapshot.registry), JSON.stringify(snapshot.pageSchema),
          JSON.stringify(snapshot.diff || {}), snapshot.activate ? "active" : "major_mismatch", timestamp, snapshot.activate ? timestamp : null);
        row = this.db.prepare("SELECT * FROM frontend_contract_snapshots WHERE id=?").get(snapshotId);
      }
      if (snapshot.activate) {
        this.db.prepare("UPDATE frontend_contract_snapshots SET status='superseded' WHERE status='active' AND id<>?").run(row.id);
        this.db.prepare("UPDATE frontend_contract_snapshots SET status='active', accepted_at=COALESCE(accepted_at, ?) WHERE id=?").run(timestamp, row.id);
        this.db.prepare(`
          UPDATE frontend_contract_state SET active_snapshot_id=?, last_attempt_at=?, last_success_at=?, last_error=NULL,
            status='healthy', updated_at=? WHERE singleton=1
        `).run(row.id, timestamp, timestamp, timestamp);
      } else {
        this.db.prepare(`
          UPDATE frontend_contract_state SET last_attempt_at=?, last_error=?, status='major_mismatch', updated_at=? WHERE singleton=1
        `).run(timestamp, `Major Frontend Contract update ${snapshot.contractVersion} requires explicit acceptance.`, timestamp);
      }
      return this.db.prepare("SELECT * FROM frontend_contract_snapshots WHERE id=?").get(row.id);
    });
  }

  acceptFrontendContractSnapshot(snapshotId) {
    const timestamp = now();
    return transaction(this.db, () => {
      const snapshot = this.db.prepare("SELECT * FROM frontend_contract_snapshots WHERE id=?").get(snapshotId);
      if (!snapshot) return null;
      this.db.prepare("UPDATE frontend_contract_snapshots SET status='superseded' WHERE status='active' AND id<>?").run(snapshotId);
      this.db.prepare("UPDATE frontend_contract_snapshots SET status='active', accepted_at=? WHERE id=?").run(timestamp, snapshotId);
      this.db.prepare(`
        UPDATE frontend_contract_state SET active_snapshot_id=?, last_attempt_at=?, last_success_at=?, last_error=NULL,
          status='healthy', updated_at=? WHERE singleton=1
      `).run(snapshotId, timestamp, timestamp, timestamp);
      return this.db.prepare("SELECT * FROM frontend_contract_snapshots WHERE id=?").get(snapshotId);
    });
  }

  saveFrontendPagePlan(briefId, snapshot, plan, validation, model = null) {
    const timestamp = now();
    const existing = this.db.prepare("SELECT id FROM frontend_page_plans WHERE brief_id=?").get(briefId);
    const planId = existing?.id || id("fplan");
    this.db.prepare(`
      INSERT INTO frontend_page_plans(id, brief_id, snapshot_id, contract_version, schema_version, contract_checksum,
        plan_json, validation_json, status, model, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(brief_id) DO UPDATE SET snapshot_id=excluded.snapshot_id, contract_version=excluded.contract_version,
        schema_version=excluded.schema_version, contract_checksum=excluded.contract_checksum, plan_json=excluded.plan_json,
        validation_json=excluded.validation_json, status=excluded.status, model=excluded.model, updated_at=excluded.updated_at
    `).run(planId, briefId, snapshot.id, snapshot.contractVersion, snapshot.schemaVersion, snapshot.checksum,
      JSON.stringify(plan), JSON.stringify(validation), validation.valid ? "ready" : "invalid", model, timestamp, timestamp);
    return this.getFrontendPagePlan(briefId);
  }

  getFrontendPagePlan(briefId) {
    const row = this.db.prepare("SELECT * FROM frontend_page_plans WHERE brief_id=?").get(briefId);
    return row ? { ...row, plan: json(row.plan_json, {}), validation: json(row.validation_json, {}) } : null;
  }

  saveFrontendPageComposition(draftId, planId, snapshot, payload, validation, model = null) {
    const timestamp = now();
    const existing = this.db.prepare("SELECT id FROM frontend_page_compositions WHERE draft_id=?").get(draftId);
    const compositionId = existing?.id || id("fpage");
    this.db.prepare(`
      INSERT INTO frontend_page_compositions(id, draft_id, plan_id, snapshot_id, contract_version, schema_version,
        contract_checksum, payload_json, validation_json, status, model, generated_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(draft_id) DO UPDATE SET plan_id=excluded.plan_id, snapshot_id=excluded.snapshot_id,
        contract_version=excluded.contract_version, schema_version=excluded.schema_version, contract_checksum=excluded.contract_checksum,
        payload_json=excluded.payload_json, validation_json=excluded.validation_json, status=excluded.status, model=excluded.model,
        generated_at=excluded.generated_at, updated_at=excluded.updated_at
    `).run(compositionId, draftId, planId || null, snapshot.id, snapshot.contractVersion, snapshot.schemaVersion,
      snapshot.checksum, JSON.stringify(payload), JSON.stringify(validation), validation.valid ? "valid" : "invalid", model, timestamp, timestamp);
    return this.getFrontendPageComposition(draftId);
  }

  getFrontendPageComposition(draftId) {
    const row = this.db.prepare("SELECT * FROM frontend_page_compositions WHERE draft_id=?").get(draftId);
    return row ? { ...row, payload: json(row.payload_json, {}), validation: json(row.validation_json, {}) } : null;
  }

  listFrontendPageCompositions() {
    return this.db.prepare(`
      SELECT pc.*, ad.title FROM frontend_page_compositions pc JOIN article_drafts ad ON ad.id=pc.draft_id
      ORDER BY pc.updated_at DESC
    `).all().map((row) => ({ ...row, payload: json(row.payload_json, {}), validation: json(row.validation_json, {}) }));
  }

  createFrontendCapabilityRequest({ briefId = null, draftId = null, semanticNeed, useCase, reason }) {
    const timestamp = now();
    const normalizedNeed = String(semanticNeed || "").slice(0, 160);
    const existing = this.db.prepare(`SELECT id FROM frontend_capability_requests
      WHERE status='open' AND semantic_need=? AND COALESCE(draft_id,'')=COALESCE(?,'') AND COALESCE(brief_id,'')=COALESCE(?,'')`)
      .get(normalizedNeed, draftId, briefId);
    if (existing) {
      this.db.prepare("UPDATE frontend_capability_requests SET use_case=?, reason=?, updated_at=? WHERE id=?")
        .run(String(useCase || "").slice(0, 1_000), String(reason || "").slice(0, 2_000), timestamp, existing.id);
      return this.db.prepare("SELECT * FROM frontend_capability_requests WHERE id=?").get(existing.id);
    }
    const requestId = id("fcap");
    this.db.prepare(`
      INSERT INTO frontend_capability_requests(id, brief_id, draft_id, semantic_need, use_case, reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(requestId, briefId, draftId, normalizedNeed, String(useCase || "").slice(0, 1_000), String(reason || "").slice(0, 2_000), timestamp, timestamp);
    return this.db.prepare("SELECT * FROM frontend_capability_requests WHERE id=?").get(requestId);
  }

  listFrontendCapabilityRequests() {
    return this.db.prepare("SELECT * FROM frontend_capability_requests WHERE status='open' ORDER BY updated_at DESC").all();
  }

  saveCapture(capture) {
    const timestamp = now();
    const contentHash = sha256(`${capture.rawText}\n${capture.assets.map((item) => item.url).join("\n")}\n${(capture.files || []).map((item) => item.sha256).join("\n")}`);
    const sourceKind = capture.sourceKind || (capture.adapter === "xiaohongshu" ? "xiaohongshu_note" : "manual_source");
    const submittedUrl = capture.submittedUrl || capture.canonicalUrl;
    const submissionMetadata = capture.submissionMetadata || {};

    return transaction(this.db, () => {
      // A note ID remains stable when Xiaohongshu changes a share URL or adds
      // transient tokens. Canonical URL remains the fallback for old captures.
      const existingByExternalId = capture.externalId
        ? this.db.prepare("SELECT id, content_hash, capture_version FROM sources WHERE adapter = ? AND external_id = ? LIMIT 1").get(capture.adapter, capture.externalId)
        : null;
      const existing = existingByExternalId
        || this.db.prepare("SELECT id, content_hash, capture_version FROM sources WHERE canonical_url = ?").get(capture.canonicalUrl);
      let sourceId;
      let duplicate = false;
      let captureVersion = 1;
      if (existing && existing.content_hash === contentHash) {
        sourceId = existing.id;
        duplicate = true;
        captureVersion = existing.capture_version;
        this.db.prepare("UPDATE sources SET captured_at = ?, updated_at = ? WHERE id = ?").run(capture.capturedAt, timestamp, sourceId);
      } else if (existing) {
        sourceId = existing.id;
        captureVersion = existing.capture_version + 1;
        this.db.prepare(`
          UPDATE sources SET external_id = ?, submitted_url = ?, source_kind = ?, submission_metadata_json = ?,
            title = ?, author_name = ?, author_url = ?, published_at = ?,
            captured_at = ?, raw_text = ?, raw_html = ?, raw_payload_json = ?, content_hash = ?,
            capture_version = capture_version + 1, status = 'captured', last_error = NULL, updated_at = ?
          WHERE id = ?
        `).run(
          capture.externalId, submittedUrl, sourceKind, JSON.stringify(submissionMetadata),
          capture.title, capture.authorName, capture.authorUrl, capture.publishedAt,
          capture.capturedAt, capture.rawText, capture.rawHtml, JSON.stringify(capture), contentHash, timestamp, sourceId,
        );
        this.db.prepare("DELETE FROM source_assets WHERE source_id = ?").run(sourceId);
        this.db.prepare("DELETE FROM source_files WHERE source_id = ?").run(sourceId);
        this.db.prepare("DELETE FROM jobs WHERE entity_id = ? AND status IN ('queued', 'failed')").run(sourceId);
      } else {
        sourceId = id("src");
        this.db.prepare(`
          INSERT INTO sources(id, adapter, external_id, canonical_url, submitted_url, source_kind, submission_metadata_json,
            title, author_name, author_url, published_at, captured_at, raw_text, raw_html, raw_payload_json, content_hash, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          sourceId, capture.adapter, capture.externalId, capture.canonicalUrl, submittedUrl, sourceKind, JSON.stringify(submissionMetadata), capture.title, capture.authorName,
          capture.authorUrl, capture.publishedAt, capture.capturedAt, capture.rawText, capture.rawHtml,
          JSON.stringify(capture), contentHash, timestamp, timestamp,
        );
      }

      if (!duplicate) {
        const insertAsset = this.db.prepare(`
          INSERT OR IGNORE INTO source_assets(id, source_id, kind, remote_url, alt_text, position, local_path, mime_type, original_filename)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const asset of capture.assets) {
          insertAsset.run(id("asset"), sourceId, asset.kind, asset.url, asset.alt, asset.position,
            asset.localPath || "", asset.mimeType || "", asset.originalFilename || "");
        }
        const insertFile = this.db.prepare(`
          INSERT INTO source_files(id, source_id, file_kind, original_filename, mime_type, storage_path, size_bytes, sha256, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const file of capture.files || []) {
          insertFile.run(file.id || id("source_file"), sourceId, file.fileKind, file.originalFilename,
            file.mimeType, file.storagePath, file.sizeBytes, file.sha256, timestamp);
        }
        this.enqueue("extract_source", sourceId);
      }

      return {
        id: sourceId,
        duplicate,
        queued: !duplicate,
        captureVersion,
        identity: {
          adapter: capture.adapter,
          externalId: capture.externalId || null,
          contentFingerprint: contentHash.slice(0, 12),
        },
      };
    });
  }

  enqueue(type, entityId) {
    const timestamp = now();
    const active = this.db.prepare(`
      SELECT id FROM jobs WHERE type = ? AND entity_id = ? AND status IN ('queued', 'running') LIMIT 1
    `).get(type, entityId);
    if (active) return active.id;
    const jobId = id("job");
    this.db.prepare(`
      INSERT INTO jobs(id, type, entity_id, available_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    `).run(jobId, type, entityId, timestamp, timestamp, timestamp);
    return jobId;
  }

  claimJob() {
    return transaction(this.db, () => {
      const timestamp = now();
      const job = this.db.prepare(`
        SELECT * FROM jobs
        WHERE status = 'queued' AND available_at <= ?
        ORDER BY created_at ASC LIMIT 1
      `).get(timestamp);
      if (!job) return null;
      const queueLatencyMs = Math.max(0, Date.parse(timestamp) - Date.parse(job.created_at));
      this.db.prepare(`
        UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_at = ?,
          started_at = COALESCE(started_at, ?), queue_latency_ms = COALESCE(queue_latency_ms, ?), updated_at = ?
        WHERE id = ?
      `).run(timestamp, timestamp, queueLatencyMs, timestamp, job.id);
      if (job.type === "extract_source") {
        this.db.prepare("UPDATE sources SET status = 'processing', updated_at = ? WHERE id = ?").run(timestamp, job.entity_id);
      }
      return { ...job, attempts: job.attempts + 1, started_at: job.started_at || timestamp, queue_latency_ms: job.queue_latency_ms ?? queueLatencyMs };
    });
  }

  completeJob(jobId) {
    const timestamp = now();
    const job = this.db.prepare("SELECT started_at FROM jobs WHERE id=?").get(jobId);
    const durationMs = job?.started_at ? Math.max(0, Date.parse(timestamp) - Date.parse(job.started_at)) : null;
    this.db.prepare(`
      UPDATE jobs SET status='succeeded', completed_at=?, duration_ms=?, updated_at=? WHERE id=?
    `).run(timestamp, durationMs, timestamp, jobId);
  }

  failJob(job, error) {
    const retry = job.attempts < job.max_attempts;
    const delaySeconds = Math.min(300, 10 * 2 ** Math.max(0, job.attempts - 1));
    const availableAt = new Date(Date.now() + delaySeconds * 1_000).toISOString();
    const timestamp = now();
    const durationMs = job.started_at ? Math.max(0, Date.parse(timestamp) - Date.parse(job.started_at)) : null;
    this.db.prepare(`
      UPDATE jobs SET status=?, available_at=?, last_error=?, completed_at=?, duration_ms=?, updated_at=? WHERE id=?
    `).run(retry ? "queued" : "failed", availableAt, String(error?.message || error).slice(0, 4_000),
      retry ? null : timestamp, retry ? null : durationMs, timestamp, job.id);
    const message = String(error?.message || error).slice(0, 4_000);
    if (job.type === "extract_source") {
      this.db.prepare("UPDATE sources SET status = 'exception', last_error = ?, updated_at = ? WHERE id = ?").run(message, now(), job.entity_id);
    } else if (!retry && job.type === "plan_content") {
      this.db.prepare("UPDATE topic_candidates SET status='candidate', updated_at=? WHERE id=?").run(now(), job.entity_id);
    } else if (!retry && ["generate_draft", "compose_frontend_page_plan"].includes(job.type)) {
      this.db.prepare("UPDATE content_briefs SET status='exception', last_error=?, updated_at=? WHERE id=?").run(message, now(), job.entity_id);
    } else if (!retry && ["review_draft", "revise_draft", "compose_frontend_page"].includes(job.type)) {
      this.db.prepare("UPDATE article_drafts SET status='exception', updated_at=? WHERE id=?").run(now(), job.entity_id);
    }
  }

  getSource(sourceId) {
    const source = this.db.prepare("SELECT * FROM sources WHERE id = ?").get(sourceId);
    if (!source) return null;
    const assets = this.db.prepare("SELECT * FROM source_assets WHERE source_id = ? ORDER BY position").all(sourceId);
    const files = this.db.prepare("SELECT id, file_kind, original_filename, mime_type, size_bytes, sha256, created_at FROM source_files WHERE source_id = ? ORDER BY created_at, id").all(sourceId);
    const structured = this.db.prepare("SELECT * FROM structured_sources WHERE source_id = ?").get(sourceId) || null;
    const claims = this.db.prepare("SELECT * FROM claims WHERE source_id = ? ORDER BY normalized_key").all(sourceId);
    const extractionRuns = this.db.prepare("SELECT * FROM extraction_runs WHERE source_id=? ORDER BY revision DESC").all(sourceId);
    const claimHistory = this.db.prepare("SELECT * FROM claim_history WHERE source_id=? ORDER BY extraction_revision DESC, claim_id").all(sourceId);
    const blueprint = this.db.prepare("SELECT * FROM source_blueprints WHERE source_id = ?").get(sourceId) || null;
    const analysis = this.db.prepare("SELECT * FROM content_intake_analyses WHERE source_id = ?").get(sourceId) || null;
    const recommendation = this.db.prepare("SELECT * FROM content_recommendations WHERE source_id = ? ORDER BY updated_at DESC LIMIT 1").get(sourceId) || null;
    return hydrateSource({ source, assets, files, structured, claims, extractionRuns, claimHistory, blueprint, analysis, recommendation });
  }

  getIntakePackage(sourceId) {
    const source = this.getSource(sourceId);
    if (!source?.structured) return null;
    return {
      strategy_version: this.strategyVersion,
      source: {
        id: source.id, title: source.title, captured_at: source.captured_at,
        text: String(source.raw_text || "").slice(0, 40_000),
        destination: source.structured.destination_name,
        destination_slug: source.structured.destination_slug,
        summary: source.structured.summary,
      },
      claims: source.claims.map((claim) => ({
        key: claim.normalized_key, subject: claim.subject, predicate: claim.predicate,
        value: claim.value_text, qualifiers: claim.qualifiers, confidence: claim.confidence,
      })),
      existing_knowledge: this.knowledgeForDestination(source.structured.destination_slug).slice(0, 80),
    };
  }

  saveIntakeAnalysis(sourceId, analysis, model) {
    const source = this.db.prepare(`
      SELECT s.id, ss.destination_slug FROM sources s JOIN structured_sources ss ON ss.source_id=s.id WHERE s.id=?
    `).get(sourceId);
    if (!source) throw new Error(`Source ${sourceId} is not ready for intake analysis.`);
    const normalized = normalizeIntakeAnalysis(analysis, this.strategyVersion);
    const timestamp = now();
    const analysisId = `intake_${sha256(sourceId).slice(0, 24)}`;
    const recommendationId = `recommendation_${sha256(sourceId).slice(0, 24)}`;
    transaction(this.db, () => {
      this.db.prepare(`
        INSERT INTO content_intake_analyses(id, source_id, strategy_version, classification, confidence, primary_topic,
          article_potential, information_density, topic_completeness, duplicate_likelihood, analysis_json, model, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id) DO UPDATE SET strategy_version=excluded.strategy_version, classification=excluded.classification,
          confidence=excluded.confidence, primary_topic=excluded.primary_topic, article_potential=excluded.article_potential,
          information_density=excluded.information_density, topic_completeness=excluded.topic_completeness,
          duplicate_likelihood=excluded.duplicate_likelihood, analysis_json=excluded.analysis_json, model=excluded.model,
          updated_at=excluded.updated_at
      `).run(analysisId, sourceId, this.strategyVersion, normalized.classification, normalized.confidence,
        normalized.primary_topic, normalized.article_potential, normalized.information_density,
        normalized.topic_completeness, normalized.duplicate_likelihood, JSON.stringify(normalized), model, timestamp, timestamp);
      this.db.prepare(`
        INSERT INTO content_recommendations(id, analysis_id, source_id, strategy_version, classification, recommended_action,
          suggested_content_type, suggested_article_title, reasoning_summary, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(analysis_id) DO UPDATE SET strategy_version=excluded.strategy_version, classification=excluded.classification,
          recommended_action=excluded.recommended_action, suggested_content_type=excluded.suggested_content_type,
          suggested_article_title=excluded.suggested_article_title, reasoning_summary=excluded.reasoning_summary,
          decision='pending', decision_note=NULL, approved_candidate_id=NULL, decided_at=NULL, updated_at=excluded.updated_at
      `).run(recommendationId, analysisId, sourceId, this.strategyVersion, normalized.classification,
        normalized.recommended_action, normalized.suggested_content_type || null, normalized.suggested_article_title || null,
        normalized.reasoning_summary, timestamp, timestamp);
    });
    const recommendation = this.db.prepare("SELECT * FROM content_recommendations WHERE analysis_id=?").get(analysisId);
    this.upsertContentOpportunity(source.destination_slug, sourceId, recommendation, normalized);
    return this.getSource(sourceId).analysis;
  }

  listContentRecommendations(limit = 100) {
    return this.db.prepare(`
      SELECT r.*, a.confidence, a.primary_topic, a.article_potential, a.information_density, a.topic_completeness,
        a.duplicate_likelihood, a.analysis_json, s.title AS source_title, ss.destination_name, ss.destination_slug
      FROM content_recommendations r
      JOIN content_intake_analyses a ON a.id=r.analysis_id
      JOIN sources s ON s.id=r.source_id
      LEFT JOIN structured_sources ss ON ss.source_id=r.source_id
      ORDER BY CASE r.decision WHEN 'pending' THEN 0 ELSE 1 END, r.updated_at DESC LIMIT ?
    `).all(limit).map(hydrateRecommendation);
  }

  listContentOpportunities(limit = 100) {
    return this.db.prepare(`
      SELECT o.*, tc.coverage_score AS candidate_coverage_score, tc.status AS candidate_status
      FROM content_opportunities o LEFT JOIN topic_candidates tc ON tc.id=o.candidate_id
      ORDER BY CASE o.status WHEN 'recommended' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, o.readiness_score DESC, o.updated_at DESC
      LIMIT ?
    `).all(limit).map((row) => ({ ...row, coverage: json(row.coverage_json, {}) }));
  }

  decideRecommendation(recommendationId, decision, note = "") {
    const allowed = new Set(["approved_article", "knowledge_only", "cluster", "research_first", "ignored"]);
    if (!allowed.has(decision)) throw new Error("Unsupported recommendation decision.");
    const recommendation = this.db.prepare(`
      SELECT r.*, a.analysis_json, a.primary_topic, a.article_potential, ss.destination_slug
      FROM content_recommendations r
      JOIN content_intake_analyses a ON a.id=r.analysis_id
      JOIN structured_sources ss ON ss.source_id=r.source_id
      WHERE r.id=?
    `).get(recommendationId);
    if (!recommendation) return null;
    const analysis = json(recommendation.analysis_json, {});
    const candidate = decision === "approved_article" ? this.db.prepare(`
      SELECT * FROM topic_candidates WHERE destination_slug=? AND status='candidate'
      ORDER BY coverage_score DESC LIMIT 1
    `).get(recommendation.destination_slug) : null;
    const timestamp = now();
    const opportunityStatus = decision === "approved_article" ? candidate ? "planned" : "research_required"
      : decision === "knowledge_only" ? "knowledge_only" : decision === "cluster" ? "cluster"
        : decision === "research_first" ? "research_required" : "ignored";
    this.db.prepare(`
      UPDATE content_recommendations SET decision=?, decision_note=?, approved_candidate_id=?, decided_at=?, updated_at=? WHERE id=?
    `).run(decision, String(note || "").slice(0, 1_000), candidate?.id || null, timestamp, timestamp, recommendationId);
    this.upsertContentOpportunity(recommendation.destination_slug, recommendation.source_id, { ...recommendation, decision, id: recommendationId }, analysis, {
      status: opportunityStatus, candidateId: candidate?.id || null,
    });
    const queued = candidate ? this.queueCandidate(candidate.id) : false;
    return { recommendation: this.db.prepare("SELECT * FROM content_recommendations WHERE id=?").get(recommendationId), candidateId: candidate?.id || null, queued, needsResearch: decision === "approved_article" && !candidate };
  }

  upsertContentOpportunity(destinationSlug, sourceId, recommendation, analysis, overrides = {}) {
    const topic = analysis.primary_topic || recommendation.suggested_article_title || "travel topic";
    const topicKey = `${destinationSlug}:strategy:${slugify(topic) || sha256(sourceId).slice(0, 8)}`;
    const opportunityId = `opportunity_${sha256(topicKey).slice(0, 24)}`;
    const coverage = opportunityCoverage(destinationSlug, this.knowledgeForDestination(destinationSlug), analysis);
    const status = overrides.status || classificationOpportunityStatus(analysis.classification);
    const title = analysis.suggested_article_title || recommendation.suggested_article_title || `${topic} guide`;
    const candidateId = overrides.candidateId || recommendation.approved_candidate_id || null;
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO content_opportunities(id, destination_slug, topic_key, strategy_version, source_id, recommendation_id,
        candidate_id, title, content_type, readiness_score, coverage_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(topic_key) DO UPDATE SET recommendation_id=excluded.recommendation_id, candidate_id=excluded.candidate_id,
        title=excluded.title, content_type=excluded.content_type, readiness_score=excluded.readiness_score,
        coverage_json=excluded.coverage_json, status=excluded.status, updated_at=excluded.updated_at
    `).run(opportunityId, destinationSlug, topicKey, this.strategyVersion, sourceId, recommendation.id, candidateId,
      title, analysis.suggested_content_type || null, coverage.readiness, JSON.stringify(coverage), status, timestamp, timestamp);
    return opportunityId;
  }

  listSources(limit = 100) {
    return this.db.prepare(`
      SELECT s.id, s.adapter, s.external_id, s.title, s.author_name, s.canonical_url, s.submitted_url, s.source_kind,
        s.status, s.last_error, s.captured_at, s.capture_version,
        ss.destination_name, ss.summary, ss.extraction_method,
        (SELECT COUNT(*) FROM claims c WHERE c.source_id = s.id) AS claim_count,
        (SELECT COUNT(*) FROM source_files sf WHERE sf.source_id = s.id) AS file_count
      FROM sources s LEFT JOIN structured_sources ss ON ss.source_id = s.id
      ORDER BY s.captured_at DESC LIMIT ?
    `).all(limit);
  }

  saveExtraction(sourceId, result, method, model = null) {
    const timestamp = now();
    transaction(this.db, () => {
      const previousRevision = this.db.prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM extraction_runs WHERE source_id=?").get(sourceId).revision;
      const extractionRevision = previousRevision + 1;
      const extractionRunId = id("extraction");
      this.db.prepare(`UPDATE extraction_runs SET status='superseded', superseded_at=?
        WHERE source_id=? AND status='active'`).run(timestamp, sourceId);
      this.db.prepare(`INSERT INTO extraction_runs(id, source_id, revision, method, model, status, created_at, completed_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`).run(
        extractionRunId, sourceId, extractionRevision, method, model, timestamp, timestamp,
      );
      const archiveClaim = this.db.prepare(`INSERT OR IGNORE INTO claim_history(
        id, claim_id, source_id, extraction_run_id, extraction_revision, lifecycle_status, snapshot_json, superseded_at
      ) VALUES (?, ?, ?, ?, ?, 'superseded', ?, ?)`);
      for (const claim of this.db.prepare("SELECT * FROM claims WHERE source_id=?").all(sourceId)) {
        const claimRevision = Number(claim.extraction_revision || previousRevision || 1);
        archiveClaim.run(`claim_history_${sha256(`${claim.id}:${claimRevision}`).slice(0, 24)}`,
          claim.id, sourceId, claim.extraction_run_id || null, claimRevision, JSON.stringify(claim), timestamp);
      }
      this.db.prepare("DELETE FROM claims WHERE source_id = ?").run(sourceId);
      this.db.prepare(`
        INSERT INTO structured_sources(source_id, language, summary, destination_name, destination_slug,
          traveler_fit_json, practical_tips_json, warnings_json, confidence, extraction_method, model, extracted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id) DO UPDATE SET language=excluded.language, summary=excluded.summary,
          destination_name=excluded.destination_name, destination_slug=excluded.destination_slug,
          traveler_fit_json=excluded.traveler_fit_json, practical_tips_json=excluded.practical_tips_json,
          warnings_json=excluded.warnings_json, confidence=excluded.confidence,
          extraction_method=excluded.extraction_method, model=excluded.model, extracted_at=excluded.extracted_at
      `).run(
        sourceId, result.source.language, result.source.summary, result.source.destination_name,
        result.source.destination_slug, JSON.stringify(result.source.traveler_fit),
        JSON.stringify(result.source.practical_tips), JSON.stringify(result.source.warnings),
        result.source.confidence, method, model, timestamp,
      );
      const insertClaim = this.db.prepare(`
        INSERT OR IGNORE INTO claims(id, source_id, normalized_key, subject, predicate, value_text,
          qualifiers_json, source_quote, confidence, created_at, original_normalized_key, entity_key,
          canonical_subject, entity_aliases_json, entity_resolution_status, entity_type, granularity,
          entity_location_json, structured_value_json, scope_json, claim_kind, cardinality,
          extraction_run_id, extraction_revision, claim_role, knowledge_eligible)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const claim of result.claims) {
        const normalizedKey = normalizeClaimKey(claim.key);
        const inferredEntity = inferEntityIdentity(normalizedKey, claim.subject, claim.predicate);
        const entityMetadata = inferEntityMetadata(claim.subject, inferredEntity.entityKey);
        const structured = structureClaim({ predicate: claim.predicate, value: claim.value, qualifiers: claim.qualifiers, sourceQuote: claim.source_quote });
        const claimRole = normalizeClaimRole(claim.claim_role, claim.subject, claim.predicate);
        const knowledgeEligible = claim.knowledge_eligible === true
          || (claim.knowledge_eligible == null && !["personal_experience", "editorial_metadata", "promotional_observation"].includes(claimRole));
        insertClaim.run(
          id("claim"), sourceId, normalizedKey, claim.subject, claim.predicate, claim.value,
          JSON.stringify(claim.qualifiers), claim.source_quote, claim.confidence, timestamp, normalizedKey,
          inferredEntity.entityKey, inferredEntity.canonicalSubject, JSON.stringify(inferredEntity.aliases), inferredEntity.status,
          entityMetadata.entityType, entityMetadata.granularity, JSON.stringify(entityMetadata.location),
          JSON.stringify(structured), JSON.stringify(structured.scope), structured.claim_kind, structured.cardinality,
          extractionRunId, extractionRevision,
          claimRole, knowledgeEligible ? 1 : 0,
        );
      }
      this.db.prepare(`
        INSERT INTO source_blueprints(source_id, format, hook, angle, sections_json, strengths_json, gaps_json, extracted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id) DO UPDATE SET format=excluded.format, hook=excluded.hook, angle=excluded.angle,
          sections_json=excluded.sections_json, strengths_json=excluded.strengths_json,
          gaps_json=excluded.gaps_json, extracted_at=excluded.extracted_at
      `).run(
        sourceId, result.blueprint.format, result.blueprint.hook, result.blueprint.angle,
        JSON.stringify(result.blueprint.sections), JSON.stringify(result.blueprint.strengths),
        JSON.stringify(result.blueprint.gaps), timestamp,
      );
      this.db.prepare("UPDATE sources SET status = ?, last_error = NULL, updated_at = ? WHERE id = ?")
        .run(method === "heuristic" ? "needs_ai" : "processed", timestamp, sourceId);
      this.enqueue("resolve_entities", result.source.destination_slug);
      this.enqueue("rebuild_editorial", "global");
    });
  }

  getEntityResolutionPackage(destinationSlug, limit = 300) {
    const rows = this.db.prepare(`
      SELECT c.id, c.normalized_key, c.original_normalized_key, c.subject, c.predicate, c.value_text,
        c.source_quote, c.confidence, c.entity_key, c.canonical_subject, c.entity_aliases_json,
        c.entity_type, c.granularity, c.entity_location_json,
        s.captured_at, s.title AS source_title
      FROM claims c JOIN structured_sources ss ON ss.source_id=c.source_id
      JOIN sources s ON s.id=c.source_id
      WHERE ss.destination_slug=? AND c.knowledge_eligible=1
      ORDER BY s.captured_at DESC, c.normalized_key LIMIT ?
    `).all(destinationSlug, limit);
    const destination = this.db.prepare("SELECT name FROM destinations WHERE slug=?").get(destinationSlug);
    return {
      destination: { slug: destinationSlug, name: destination?.name || destinationSlug },
      claims: rows.map((row) => ({
        id: row.id, key: row.normalized_key, original_key: row.original_normalized_key || row.normalized_key,
        subject: row.subject, predicate: row.predicate, value: row.value_text, source_quote: row.source_quote,
        confidence: row.confidence, current_entity_key: row.entity_key || null,
        current_canonical_subject: row.canonical_subject || null, current_aliases: json(row.entity_aliases_json, []),
        entity_type: row.entity_type, granularity: row.granularity, location: json(row.entity_location_json, {}),
        captured_at: row.captured_at, source_title: row.source_title,
      })),
      known_aliases: this.listEntityAliases(destinationSlug),
    };
  }

  listEntityAliases(destinationSlug = null) {
    const rows = destinationSlug
      ? this.db.prepare("SELECT * FROM entity_aliases WHERE destination_slug=? ORDER BY canonical_subject, alias_normalized").all(destinationSlug)
      : this.db.prepare("SELECT * FROM entity_aliases ORDER BY destination_slug, canonical_subject, alias_normalized").all();
    return rows.map((row) => ({ ...row, aliases: json(row.aliases_json, []), location: json(row.location_json, {}) }));
  }

  listEntityMergeCandidates(status = "pending") {
    return this.db.prepare(`
      SELECT * FROM entity_merge_candidates WHERE status=? ORDER BY confidence DESC, updated_at DESC
    `).all(status).map((row) => ({ ...row, location: json(row.location_json, {}), assessment: assessEntityIdentity(row) }))
      .filter((row) => status !== "pending" || row.assessment.decision !== "DO_NOT_MERGE");
  }

  enqueueEntityResolutionForAllDestinations() {
    const destinations = this.db.prepare("SELECT DISTINCT destination_slug FROM structured_sources WHERE destination_slug<>'' AND destination_slug<>'unknown'").all();
    for (const row of destinations) this.enqueue("resolve_entities", row.destination_slug);
    return destinations.length;
  }

  resolveEntitiesDeterministically(destinationSlug) {
    const rows = this.db.prepare(`
      SELECT c.* FROM claims c JOIN structured_sources ss ON ss.source_id=c.source_id WHERE ss.destination_slug=?
    `).all(destinationSlug);
    const timestamp = now();
    transaction(this.db, () => {
      for (const row of rows) {
        const originalKey = row.original_normalized_key || row.normalized_key;
        const inferred = inferEntityIdentity(originalKey, row.subject, row.predicate);
        const inferredMetadata = inferEntityMetadata(row.subject, inferred.entityKey, { entityType: row.entity_type, granularity: row.granularity, location: json(row.entity_location_json, {}) });
        const alias = normalizeEntityAlias(row.subject);
        const mapped = alias ? this.db.prepare("SELECT * FROM entity_aliases WHERE destination_slug=? AND alias_normalized=?").get(destinationSlug, alias) : null;
        const identity = mapped ? {
          entityKey: mapped.entity_key,
          canonicalSubject: mapped.canonical_subject,
          aliases: json(mapped.aliases_json, []),
          status: mapped.resolution_source === "manual" || mapped.resolution_source === "model" ? "resolved" : "derived",
          entityType: mapped.entity_type, granularity: mapped.granularity, location: json(mapped.location_json, {}),
        } : { ...inferred, ...inferredMetadata };
        this.db.prepare(`
          UPDATE claims SET original_normalized_key=CASE WHEN original_normalized_key='' THEN ? ELSE original_normalized_key END,
            entity_key=?, canonical_subject=?, entity_aliases_json=?, entity_resolution_status=?, entity_type=?, granularity=?,
            entity_location_json=? WHERE id=?
        `).run(originalKey, identity.entityKey, identity.canonicalSubject, JSON.stringify(identity.aliases), identity.status,
          identity.entityType || "other", identity.granularity || "general_topic", JSON.stringify(identity.location || {}), row.id);
        if (!mapped && identity.entityKey && alias) this.upsertEntityAlias(destinationSlug, alias, identity, "derived", 0.55, timestamp);
      }
    });
    return rows.length;
  }

  applyEntityResolution(destinationSlug, resolution, model = null) {
    const timestamp = now();
    const entities = new Map();
    for (const item of resolution?.entities || []) {
      if (Number(item?.confidence) < 0.85) continue;
      const entityKey = normalizeEntityKey(item?.entity_key);
      const canonicalSubject = cleanEntityName(item?.canonical_subject);
      if (!entityKey || !canonicalSubject) continue;
      const aliases = uniqueEntityAliases([canonicalSubject, ...(item.aliases || [])]);
      const metadata = inferEntityMetadata(canonicalSubject, entityKey, {
        entityType: item.entity_type, granularity: item.granularity, location: item.location,
      });
      const identity = { entityKey, canonicalSubject, aliases, status: "resolved", ...metadata };
      entities.set(entityKey, identity);
      for (const alias of aliases) this.upsertEntityAlias(destinationSlug, normalizeEntityAlias(alias), identity, "model", Number(item.confidence), timestamp);
    }
    const claims = new Map(this.db.prepare(`
      SELECT c.* FROM claims c JOIN structured_sources ss ON ss.source_id=c.source_id WHERE ss.destination_slug=?
    `).all(destinationSlug).map((row) => [row.id, row]));
    transaction(this.db, () => {
      for (const item of resolution?.claim_updates || []) {
        if (Number(item?.confidence) < 0.85) continue;
        const row = claims.get(item?.claim_id);
        const entityKey = normalizeEntityKey(item?.entity_key);
        const canonicalSubject = cleanEntityName(item?.canonical_subject);
        if (!row || !entityKey || !canonicalSubject) continue;
        const metadata = inferEntityMetadata(canonicalSubject, entityKey, {
          entityType: item.entity_type, granularity: item.granularity, location: item.location,
        });
        const assessment = assessEntityIdentity({
          alias: row.subject, candidate_entity_key: row.entity_key, candidate_entity_type: row.entity_type,
          candidate_granularity: row.granularity, proposed_entity_key: entityKey,
          proposed_canonical_subject: canonicalSubject, proposed_entity_type: metadata.entityType,
          proposed_granularity: metadata.granularity, location: metadata.location, confidence: item.confidence,
        });
        if (assessment.decision === "DO_NOT_MERGE") {
          if (row.entity_key && assessment.suggestedRelation) this.upsertEntityRelation(destinationSlug, row.entity_key, assessment.suggestedRelation, entityKey, "model", Number(item.confidence), assessment.reasons.join("; "));
          continue;
        }
        const identity = entities.get(entityKey) || { entityKey, canonicalSubject, aliases: uniqueEntityAliases([canonicalSubject, row.subject]), status: "resolved", ...metadata };
        const canonicalKey = normalizeClaimKey(item?.canonical_key);
        this.db.prepare(`
          UPDATE claims SET original_normalized_key=CASE WHEN original_normalized_key='' THEN normalized_key ELSE original_normalized_key END,
            normalized_key=?, entity_key=?, canonical_subject=?, entity_aliases_json=?, entity_resolution_status='resolved',
            entity_type=?, granularity=?, entity_location_json=? WHERE id=?
        `).run(canonicalKey || row.normalized_key, identity.entityKey, identity.canonicalSubject, JSON.stringify(identity.aliases),
          identity.entityType, identity.granularity, JSON.stringify(identity.location || {}), row.id);
        for (const alias of uniqueEntityAliases([row.subject, ...identity.aliases])) this.upsertEntityAlias(destinationSlug, normalizeEntityAlias(alias), identity, "model", Number(item.confidence), timestamp);
      }
      for (const item of resolution?.candidates || []) {
        const confidence = Number(item?.confidence);
        const alias = cleanEntityName(item?.alias);
        const entityKey = normalizeEntityKey(item?.proposed_entity_key);
        const canonicalSubject = cleanEntityName(item?.proposed_canonical_subject);
        if (!alias || !entityKey || !canonicalSubject || confidence < 0.6 || confidence >= 0.85) continue;
        const candidateMetadata = inferEntityMetadata(alias, item?.candidate_entity_key, {
          entityType: item?.candidate_entity_type, granularity: item?.candidate_granularity, location: item?.candidate_location,
        });
        const proposedMetadata = inferEntityMetadata(canonicalSubject, entityKey, {
          entityType: item?.proposed_entity_type, granularity: item?.proposed_granularity, location: item?.proposed_location,
        });
        const assessment = assessEntityIdentity({
          ...item, alias, proposed_entity_key: entityKey, proposed_canonical_subject: canonicalSubject,
          candidate_entity_type: candidateMetadata.entityType, candidate_granularity: candidateMetadata.granularity,
          proposed_entity_type: proposedMetadata.entityType, proposed_granularity: proposedMetadata.granularity,
        });
        if (assessment.decision === "DO_NOT_MERGE") {
          const candidateEntityKey = normalizeEntityKey(item?.candidate_entity_key);
          if (candidateEntityKey && assessment.suggestedRelation) this.upsertEntityRelation(destinationSlug, candidateEntityKey, assessment.suggestedRelation, entityKey, "model", confidence, assessment.reasons.join("; "));
          continue;
        }
        const candidateId = `entity_candidate_${sha256(`${destinationSlug}:${normalizeEntityAlias(alias)}:${entityKey}`).slice(0, 24)}`;
        this.db.prepare(`
          INSERT INTO entity_merge_candidates(id, destination_slug, alias, alias_normalized, proposed_entity_key,
            proposed_canonical_subject, confidence, rationale, status, model, created_at, updated_at,
            candidate_entity_key, candidate_entity_type, candidate_granularity, proposed_entity_type,
            proposed_granularity, location_json, ai_recommendation, suggested_relation)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(destination_slug, alias_normalized, proposed_entity_key) DO UPDATE SET confidence=excluded.confidence,
            rationale=excluded.rationale, status='pending', model=excluded.model, updated_at=excluded.updated_at,
            candidate_entity_key=excluded.candidate_entity_key, candidate_entity_type=excluded.candidate_entity_type,
            candidate_granularity=excluded.candidate_granularity, proposed_entity_type=excluded.proposed_entity_type,
            proposed_granularity=excluded.proposed_granularity, location_json=excluded.location_json,
            ai_recommendation=excluded.ai_recommendation, suggested_relation=excluded.suggested_relation
        `).run(candidateId, destinationSlug, alias, normalizeEntityAlias(alias), entityKey, canonicalSubject, confidence,
          String(item?.rationale || "Possible multilingual alias requires an operator decision.").slice(0, 1_000), model, timestamp, timestamp,
          normalizeEntityKey(item?.candidate_entity_key), candidateMetadata.entityType, candidateMetadata.granularity,
          proposedMetadata.entityType, proposedMetadata.granularity, JSON.stringify({ candidate: candidateMetadata.location, proposed: proposedMetadata.location }),
          String(item?.recommendation || "UNCERTAIN").toUpperCase(), ENTITY_RELATION_TYPES.has(item?.suggested_relation) ? item.suggested_relation : assessment.suggestedRelation);
      }
    });
    this.resolveEntitiesDeterministically(destinationSlug);
    return { resolvedEntities: entities.size, candidates: this.listEntityMergeCandidates().filter((item) => item.destination_slug === destinationSlug).length };
  }

  decideEntityMergeCandidate(candidateId, decision, options = {}) {
    const normalizedDecision = ({ accepted: "same_entity", rejected: "different_entity" })[decision] || decision;
    if (!["same_entity", "different_entity", "create_relation", "defer"].includes(normalizedDecision)) {
      throw new Error("Entity decision must be same_entity, different_entity, create_relation, or defer.");
    }
    const candidate = this.db.prepare("SELECT * FROM entity_merge_candidates WHERE id=? AND status='pending'").get(candidateId);
    if (!candidate) return null;
    const timestamp = now();
    if (normalizedDecision === "defer") {
      this.db.prepare("UPDATE entity_merge_candidates SET decision_reason=?, updated_at=? WHERE id=?")
        .run(String(options.reason || "Deferred by operator.").slice(0, 1_000), timestamp, candidateId);
      return { ...candidate, status: "pending", decision: "defer" };
    }
    const assessment = assessEntityIdentity(candidate);
    if (normalizedDecision === "same_entity" && assessment.decision === "DO_NOT_MERGE") {
      throw new Error(`Entity merge violates hard constraints: ${assessment.reasons.join("; ")}`);
    }
    const finalStatus = normalizedDecision === "same_entity" ? "accepted" : "rejected";
    const aliasNormals = uniqueEntityAliases([candidate.alias, candidate.proposed_canonical_subject]).map(normalizeEntityAlias);
    const beforeState = normalizedDecision === "same_entity" ? {
      aliases: aliasNormals.flatMap((alias) => this.db.prepare("SELECT * FROM entity_aliases WHERE destination_slug=? AND alias_normalized=?").all(candidate.destination_slug, alias)),
      claims: this.db.prepare(`SELECT id, normalized_key, entity_key, canonical_subject, entity_aliases_json,
        entity_resolution_status, entity_type, granularity, entity_location_json FROM claims WHERE id IN (
          SELECT c.id FROM claims c JOIN structured_sources ss ON ss.source_id=c.source_id
          WHERE ss.destination_slug=? AND lower(trim(c.subject))=lower(trim(?))
        )`).all(candidate.destination_slug, candidate.alias),
      alias_normals: aliasNormals,
    } : null;
    let historyId = null;
    transaction(this.db, () => {
      this.db.prepare("UPDATE entity_merge_candidates SET status=?, decision_reason=?, decided_at=?, updated_at=? WHERE id=?")
        .run(finalStatus, String(options.reason || assessment.reasons.join("; ")).slice(0, 1_000), timestamp, timestamp, candidateId);
      if (normalizedDecision === "same_entity") {
        const metadata = inferEntityMetadata(candidate.proposed_canonical_subject, candidate.proposed_entity_key, {
          entityType: candidate.proposed_entity_type, granularity: candidate.proposed_granularity,
          location: json(candidate.location_json, {}).proposed,
        });
        const identity = {
          entityKey: candidate.proposed_entity_key,
          canonicalSubject: candidate.proposed_canonical_subject,
          aliases: uniqueEntityAliases([candidate.alias, candidate.proposed_canonical_subject]),
          status: "resolved", ...metadata,
        };
        for (const alias of identity.aliases) this.upsertEntityAlias(candidate.destination_slug, normalizeEntityAlias(alias), identity, "manual", 1, timestamp);
        historyId = id("entity_merge");
        this.db.prepare(`INSERT INTO entity_merge_history(id, candidate_id, destination_slug, merged_from_entity_ids_json,
          target_entity_key, decision, operator, ai_recommendation, ai_confidence, reason, before_state_json,
          after_state_json, status, created_at) VALUES (?, ?, ?, ?, ?, 'same_entity', ?, ?, ?, ?, ?, ?, 'active', ?)`)
          .run(historyId, candidateId, candidate.destination_slug,
            JSON.stringify([candidate.candidate_entity_key || normalizeEntityKey(candidate.alias)].filter(Boolean)), candidate.proposed_entity_key,
            String(options.operator || "administrator").slice(0, 200), candidate.ai_recommendation,
            candidate.confidence, String(options.reason || candidate.rationale).slice(0, 1_000), JSON.stringify(beforeState), JSON.stringify(identity), timestamp);
      } else if (normalizedDecision === "create_relation") {
        const relationType = options.relationType || candidate.suggested_relation || assessment.suggestedRelation;
        if (!ENTITY_RELATION_TYPES.has(relationType)) throw new Error("A supported entity relation type is required.");
        const subjectKey = candidate.candidate_entity_key || `other.candidate_${sha256(`${candidate.destination_slug}:${candidate.alias_normalized}`).slice(0, 16)}`;
        this.upsertEntityRelation(candidate.destination_slug, subjectKey, relationType, candidate.proposed_entity_key,
          "manual", 1, String(options.reason || candidate.rationale).slice(0, 1_000));
      }
    });
    if (normalizedDecision === "same_entity") {
      this.resolveEntitiesDeterministically(candidate.destination_slug);
      this.enqueue("rebuild_knowledge", candidate.destination_slug);
    }
    return { ...candidate, status: finalStatus, decision: normalizedDecision, historyId };
  }

  undoEntityMerge(historyId, operator = "administrator") {
    const history = this.db.prepare("SELECT * FROM entity_merge_history WHERE id=? AND status='active'").get(historyId);
    if (!history) return null;
    const before = json(history.before_state_json, {});
    const timestamp = now();
    transaction(this.db, () => {
      for (const alias of before.alias_normals || []) this.db.prepare("DELETE FROM entity_aliases WHERE destination_slug=? AND alias_normalized=?").run(history.destination_slug, alias);
      for (const row of before.aliases || []) this.db.prepare(`INSERT INTO entity_aliases(
        id, destination_slug, alias_normalized, entity_key, canonical_subject, aliases_json,
        resolution_source, confidence, created_at, updated_at, entity_type, granularity, location_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(row.id, row.destination_slug, row.alias_normalized, row.entity_key, row.canonical_subject, row.aliases_json,
          row.resolution_source, row.confidence, row.created_at, timestamp, row.entity_type, row.granularity, row.location_json);
      for (const row of before.claims || []) this.db.prepare(`UPDATE claims SET normalized_key=?, entity_key=?, canonical_subject=?,
        entity_aliases_json=?, entity_resolution_status=?, entity_type=?, granularity=?, entity_location_json=? WHERE id=?`)
        .run(row.normalized_key, row.entity_key, row.canonical_subject, row.entity_aliases_json, row.entity_resolution_status,
          row.entity_type, row.granularity, row.entity_location_json, row.id);
      this.db.prepare("UPDATE entity_merge_history SET status='undone', undone_at=?, undo_operator=? WHERE id=?")
        .run(timestamp, String(operator || "administrator").slice(0, 200), historyId);
    });
    this.enqueue("rebuild_knowledge", history.destination_slug);
    return { id: historyId, status: "undone", destinationSlug: history.destination_slug };
  }

  upsertEntityAlias(destinationSlug, aliasNormalized, identity, source, confidence, timestamp = now()) {
    if (!aliasNormalized || !identity?.entityKey || !identity?.canonicalSubject) return;
    const aliasId = `entity_alias_${sha256(`${destinationSlug}:${aliasNormalized}`).slice(0, 24)}`;
    this.db.prepare(`
      INSERT INTO entity_aliases(id, destination_slug, alias_normalized, entity_key, canonical_subject, aliases_json,
        resolution_source, confidence, created_at, updated_at, entity_type, granularity, location_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(destination_slug, alias_normalized) DO UPDATE SET entity_key=excluded.entity_key,
        canonical_subject=excluded.canonical_subject, aliases_json=excluded.aliases_json, resolution_source=excluded.resolution_source,
        confidence=excluded.confidence, updated_at=excluded.updated_at, entity_type=excluded.entity_type,
        granularity=excluded.granularity, location_json=excluded.location_json
    `).run(aliasId, destinationSlug, aliasNormalized, identity.entityKey, identity.canonicalSubject,
      JSON.stringify(identity.aliases || []), source, confidence, timestamp, timestamp,
      normalizeEntityType(identity.entityType), normalizeGranularity(identity.granularity), JSON.stringify(identity.location || {}));
  }

  upsertEntityRelation(destinationSlug, subjectEntityKey, relationType, objectEntityKey, source = "derived", confidence = 1, rationale = "") {
    if (!ENTITY_RELATION_TYPES.has(relationType) || !subjectEntityKey || !objectEntityKey || subjectEntityKey === objectEntityKey) return null;
    const timestamp = now();
    const relationId = `entity_relation_${sha256(`${destinationSlug}:${subjectEntityKey}:${relationType}:${objectEntityKey}`).slice(0, 24)}`;
    this.db.prepare(`INSERT INTO entity_relations(id, destination_slug, subject_entity_key, relation_type,
      object_entity_key, source, confidence, rationale, provenance_json, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', 1, ?, ?)
      ON CONFLICT(destination_slug, subject_entity_key, relation_type, object_entity_key) DO UPDATE SET
        source=excluded.source, confidence=excluded.confidence, rationale=excluded.rationale, active=1, updated_at=excluded.updated_at`)
      .run(relationId, destinationSlug, subjectEntityKey, relationType, objectEntityKey, source, confidence, rationale, timestamp, timestamp);
    return this.db.prepare("SELECT * FROM entity_relations WHERE id=?").get(relationId);
  }

  listEntityRelations(destinationSlug = null) {
    return destinationSlug
      ? this.db.prepare("SELECT * FROM entity_relations WHERE destination_slug=? AND active=1 ORDER BY updated_at DESC").all(destinationSlug)
      : this.db.prepare("SELECT * FROM entity_relations WHERE active=1 ORDER BY updated_at DESC").all();
  }

  listEntityMergeHistory(destinationSlug = null) {
    const rows = destinationSlug
      ? this.db.prepare("SELECT * FROM entity_merge_history WHERE destination_slug=? ORDER BY created_at DESC").all(destinationSlug)
      : this.db.prepare("SELECT * FROM entity_merge_history ORDER BY created_at DESC").all();
    return rows.map((row) => ({ ...row, merged_from_entity_ids: json(row.merged_from_entity_ids_json, []) }));
  }

  rebuildKnowledge(destinationSlug) {
    this.resolveEntitiesDeterministically(destinationSlug);
    const allSourceRows = this.db.prepare(`
      SELECT c.*, ss.destination_name, ss.destination_slug, s.captured_at
      FROM claims c JOIN structured_sources ss ON ss.source_id = c.source_id
      JOIN sources s ON s.id = c.source_id
      WHERE ss.destination_slug = ?
    `).all(destinationSlug);
    const timestamp = now();
    for (const row of allSourceRows) {
      row.structured_value = structureClaim({ predicate: row.predicate, value: row.value_text, qualifiers: json(row.qualifiers_json, []), sourceQuote: row.source_quote });
      row.scope = row.structured_value.scope;
    }
    const sourceRows = allSourceRows.filter((row) => row.knowledge_eligible !== 0);
    const previousReviewDecisions = new Map(this.db.prepare(`
      SELECT id, review_type, status FROM claim_review_cases
      WHERE destination_slug=? AND status IN ('resolved','dismissed')
    `).all(destinationSlug).map((row) => [row.id, row]));
    transaction(this.db, () => {
      const destinationId = `dst_${sha256(destinationSlug).slice(0, 20)}`;
      this.db.prepare(`DELETE FROM claim_relations WHERE claim_a_id IN (
        SELECT c.id FROM claims c JOIN structured_sources ss ON ss.source_id=c.source_id WHERE ss.destination_slug=?
      )`).run(destinationSlug);
      this.db.prepare(`DELETE FROM claim_review_cases WHERE claim_a_id IN (
        SELECT c.id FROM claims c JOIN structured_sources ss ON ss.source_id=c.source_id WHERE ss.destination_slug=?
      )`).run(destinationSlug);
      if (!sourceRows.length) {
        this.db.prepare("DELETE FROM knowledge_facts WHERE destination_id = ?").run(destinationId);
        return;
      }
      const displayName = sourceRows[0].destination_name || destinationSlug;
      this.db.prepare(`
        INSERT INTO destinations(id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(slug) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at
      `).run(destinationId, destinationSlug, displayName, timestamp, timestamp);
      this.db.prepare("DELETE FROM knowledge_facts WHERE destination_id = ?").run(destinationId);
      const updateStructuredClaim = this.db.prepare(`UPDATE claims SET structured_value_json=?, scope_json=?, claim_kind=?, cardinality=? WHERE id=?`);
      const reviewedExtractionQuotes = new Set();
      for (const row of sourceRows) {
        updateStructuredClaim.run(JSON.stringify(row.structured_value), JSON.stringify(row.scope), row.structured_value.claim_kind, row.structured_value.cardinality, row.id);
        const siblingClaims = sourceRows.filter((candidate) => candidate.source_id === row.source_id && candidate.id !== row.id);
        const extractionIssue = detectClaimExtractionIssue(row, siblingClaims);
        if (extractionIssue) {
          const quoteKey = `${row.source_id}:${sha256(row.source_quote)}:${extractionIssue}`;
          if (reviewedExtractionQuotes.has(quoteKey)) continue;
          reviewedExtractionQuotes.add(quoteKey);
          const reviewId = `claim_review_${sha256(`${row.id}:${extractionIssue}`).slice(0, 24)}`;
          const previous = previousReviewDecisions.get(reviewId);
          // A legacy "resolved" extraction review only acknowledged the issue; it did not
          // correct the Claim. Re-open genuine issues, while preserving explicit false-positive dismissals.
          const status = previous?.status === "dismissed" ? "dismissed" : "pending";
          this.db.prepare(`INSERT INTO claim_review_cases(id, destination_slug, claim_a_id, claim_b_id,
            review_type, reason, status, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`)
            .run(reviewId, destinationSlug, row.id, extractionIssue,
              "The original source contains negation or a limiting qualifier that is absent from the normalized Claim.", status, timestamp, timestamp);
        }
      }
      for (let left = 0; left < sourceRows.length; left += 1) {
        for (let right = left + 1; right < sourceRows.length; right += 1) {
          const a = sourceRows[left];
          const b = sourceRows[right];
          if (a.normalized_key === b.normalized_key || normalizeValue(a.predicate) !== normalizeValue(b.predicate)) continue;
          const broad = [a, b].find((row) => ["collection", "category", "general_topic"].includes(row.granularity));
          const specific = [a, b].find((row) => row.granularity === "specific_entity");
          if (!broad || !specific) continue;
          const claimA = [broad.id, specific.id].sort()[0];
          const claimB = [broad.id, specific.id].sort()[1];
          const relationId = `claim_relation_${sha256(`${claimA}:${claimB}`).slice(0, 24)}`;
          this.db.prepare(`INSERT OR IGNORE INTO claim_relations(id, destination_slug, claim_a_id, claim_b_id,
            relation_type, can_coexist, reason, scope_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'GENERALIZATION', 1, ?, '{}', ?, ?)`)
            .run(relationId, destinationSlug, claimA, claimB,
              "A specific Claim may support a broader collection/category Claim, but the two are not merged.", timestamp, timestamp);
          if (specific.entity_key && broad.entity_key) this.upsertEntityRelation(destinationSlug, specific.entity_key,
            "applies_to", broad.entity_key, "derived", 0.8, "Specific Claim supports a broader collection/category Claim.");
        }
      }

      const groups = Map.groupBy(sourceRows, (row) => row.normalized_key);
      for (const [key, rows] of groups) {
        const canonicalPredicates = new Set(rows.map((row) => row.structured_value.canonical_predicate).filter(Boolean));
        const typedFact = canonicalPredicates.size === 1 && rows.every((row) => row.structured_value.typed_value != null);
        const canonicalPredicate = typedFact ? [...canonicalPredicates][0] : null;
        const variants = Map.groupBy(rows, (row) => typedFact
          ? `${canonicalPredicate}:${JSON.stringify(row.structured_value.typed_value)}`
          : normalizeValue(row.value_text));
        const ranked = [...variants.entries()].sort((a, b) => b[1].length - a[1].length);
        const relations = [];
        for (let left = 0; left < rows.length; left += 1) {
          for (let right = left + 1; right < rows.length; right += 1) {
            const comparison = classifyClaimPair(rows[left], rows[right]);
            relations.push({ claim_a_id: rows[left].id, claim_b_id: rows[right].id, ...comparison });
            const relationId = `claim_relation_${sha256(`${rows[left].id}:${rows[right].id}`).slice(0, 24)}`;
            this.db.prepare(`INSERT INTO claim_relations(id, destination_slug, claim_a_id, claim_b_id,
              relation_type, can_coexist, reason, scope_json, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(relationId, destinationSlug, rows[left].id, rows[right].id, comparison.relation,
                comparison.canCoexist ? 1 : 0, comparison.reason, JSON.stringify(comparison.scope), timestamp, timestamp);
            if (comparison.reviewType && !comparison.reviewType.includes("EXTRACTION_ERROR")) {
              const reviewId = `claim_review_${sha256(`${rows[left].id}:${rows[right].id}:${comparison.reviewType}`).slice(0, 24)}`;
              const status = previousReviewDecisions.get(reviewId)?.status || "pending";
              this.db.prepare(`INSERT INTO claim_review_cases(id, destination_slug, claim_a_id, claim_b_id,
                review_type, reason, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(reviewId, destinationSlug, rows[left].id, rows[right].id, comparison.reviewType, comparison.reason, status, timestamp, timestamp);
            }
          }
        }
        const conflicts = relations.filter((relation) => !relation.canCoexist);
        const status = conflicts.length ? "conflicted" : rows.length > 1 ? "corroborated" : "single_source";
        const preferredValue = typedFact
          ? String(ranked[0][1][0].structured_value.typed_value)
          : ranked[0][1][0].value_text;
        const freshness = classifyFreshness(rows, this.contentConfig);
        const verificationPriority = freshness.volatile || status === "conflicted"
          ? "requires_official" : status === "single_source" || freshness.state === "stale" ? "review" : "normal";
        const entity = aggregateEntityIdentity(rows);
        const evidence = rows.map((row) => ({
          source_id: row.source_id,
          value: row.value_text,
          quote: row.source_quote,
          confidence: row.confidence,
          qualifiers: json(row.qualifiers_json, []),
          structured_value: row.structured_value,
          scope: row.scope,
          original_key: row.original_normalized_key || row.normalized_key,
          source_subject: row.subject,
          captured_at: row.captured_at,
        }));
        this.db.prepare(`
          INSERT INTO knowledge_facts(id, destination_id, normalized_key, subject, predicate, consensus_status,
            preferred_value, support_count, contradiction_count, evidence_json, updated_at,
            freshness_state, latest_evidence_at, verification_priority, entity_key, canonical_subject,
            entity_aliases_json, entity_resolution_status, entity_type, granularity, entity_location_json,
            claim_relations_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(destination_id, normalized_key) DO UPDATE SET subject=excluded.subject,
            predicate=excluded.predicate, consensus_status=excluded.consensus_status,
            preferred_value=excluded.preferred_value, support_count=excluded.support_count,
            contradiction_count=excluded.contradiction_count, evidence_json=excluded.evidence_json,
            updated_at=excluded.updated_at, freshness_state=excluded.freshness_state,
            latest_evidence_at=excluded.latest_evidence_at, verification_priority=excluded.verification_priority,
            entity_key=excluded.entity_key, canonical_subject=excluded.canonical_subject,
            entity_aliases_json=excluded.entity_aliases_json, entity_resolution_status=excluded.entity_resolution_status,
            entity_type=excluded.entity_type, granularity=excluded.granularity,
            entity_location_json=excluded.entity_location_json, claim_relations_json=excluded.claim_relations_json
        `).run(
          `fact_${sha256(`${destinationId}:${key}`).slice(0, 24)}`, destinationId, key, entity.canonicalSubject || rows[0].subject,
          canonicalPredicate || rows[0].predicate, status, preferredValue, status === "conflicted" ? ranked[0][1].length : rows.length,
          conflicts.length, JSON.stringify(evidence), timestamp,
          freshness.state, freshness.latestEvidenceAt, verificationPriority, entity.entityKey,
          entity.canonicalSubject, JSON.stringify(entity.aliases), entity.status, entity.entityType,
          entity.granularity, JSON.stringify(entity.location || {}), JSON.stringify(relations),
        );
      }
    });
  }

  rebuildEditorialLibrary() {
    const rows = this.db.prepare("SELECT * FROM source_blueprints ORDER BY extracted_at DESC").all();
    const groups = Map.groupBy(rows, (row) => `${row.format}:${row.angle}`.toLowerCase());
    const timestamp = now();
    transaction(this.db, () => {
      this.db.prepare("DELETE FROM editorial_blueprints").run();
      for (const [key, entries] of groups) {
        const sectionCounts = countStrings(entries.flatMap((row) => json(row.sections_json, []).map((section) => section.heading)));
        const strengths = countStrings(entries.flatMap((row) => json(row.strengths_json, [])));
        const gaps = countStrings(entries.flatMap((row) => json(row.gaps_json, [])));
        this.db.prepare(`
          INSERT INTO editorial_blueprints(id, blueprint_key, format, angle, sample_count, section_patterns_json,
            strengths_json, gaps_json, source_ids_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(blueprint_key) DO UPDATE SET sample_count=excluded.sample_count,
            section_patterns_json=excluded.section_patterns_json, strengths_json=excluded.strengths_json,
            gaps_json=excluded.gaps_json, source_ids_json=excluded.source_ids_json, updated_at=excluded.updated_at
        `).run(
          `ebp_${sha256(key).slice(0, 24)}`, key, entries[0].format, entries[0].angle, entries.length,
          JSON.stringify(sectionCounts), JSON.stringify(strengths), JSON.stringify(gaps),
          JSON.stringify(entries.map((row) => row.source_id)), timestamp,
        );
      }
    });
  }

  rebuildTopicCandidates(destinationSlug, minFacts = 5, maxPerDestination = 1) {
    const allFacts = this.knowledgeForDestination(destinationSlug);
    const facts = allFacts.filter((fact) => fact.freshness_state !== "stale");
    if (facts.length < minFacts || maxPerDestination < 1) return [];
    const destination = this.db.prepare("SELECT name FROM destinations WHERE slug = ?").get(destinationSlug);
    if (!destination) return [];
    const conflictCount = facts.filter((fact) => fact.consensus_status === "conflicted").length;
    const staleFactCount = allFacts.filter((fact) => fact.freshness_state === "stale").length;
    const verificationFactCount = facts.filter((fact) => fact.verification_priority === "requires_official").length;
    const evidenceCount = new Set(facts.flatMap((fact) => fact.evidence.map((item) => item.source_id))).size;
    if (evidenceCount < 2) return [];
    const timestamp = now();
    const proposals = [{
      topicKey: `${destinationSlug}:first-time-solo-guide`,
      title: `First-Time ${destination.name} Solo Travel Guide`,
      rationale: `${facts.length} knowledge facts from ${evidenceCount} independent sources; ${conflictCount} conflicts, ${staleFactCount} stale facts, and ${verificationFactCount} official-verification flags require editorial handling.`,
      coverageScore: Math.max(0, Math.min(100, facts.length * 8 + evidenceCount * 6 - conflictCount * 5 - staleFactCount * 4)),
      evidenceCount,
      conflictCount,
      staleFactCount,
      verificationFactCount,
      selectionPriority: 0,
    }];
    const subjects = Map.groupBy(facts, (fact) => fact.subject.trim().toLowerCase());
    for (const subjectFacts of subjects.values()) {
      if (subjectFacts.length < 3) continue;
      const subjectSources = new Set(subjectFacts.flatMap((fact) => fact.evidence.map((item) => item.source_id))).size;
      if (subjectSources < 2) continue;
      const subjectConflicts = subjectFacts.filter((fact) => fact.consensus_status === "conflicted").length;
      const subject = subjectFacts[0].subject;
      proposals.push({
        topicKey: `${destinationSlug}:visit:${slugify(subject)}`,
        title: `How to Visit ${subject} Independently`,
        rationale: `${subjectFacts.length} practical facts about ${subject} from ${subjectSources} independent sources.`,
        coverageScore: Math.max(0, Math.min(100, subjectFacts.length * 12 + subjectSources * 8 - subjectConflicts * 5)),
        evidenceCount: subjectSources,
        conflictCount: subjectConflicts,
        staleFactCount: subjectFacts.filter((fact) => fact.freshness_state === "stale").length,
        verificationFactCount: subjectFacts.filter((fact) => fact.verification_priority === "requires_official").length,
        selectionPriority: 1,
      });
    }

    const itineraryFacts = facts.filter((fact) => /route|transport|duration|time|day|itinerary|station|metro|travel.?between|order|sequence|district|area/i
      .test(`${fact.normalized_key} ${fact.subject} ${fact.predicate}`));
    const itinerarySources = new Set(itineraryFacts.flatMap((fact) => fact.evidence.map((item) => item.source_id))).size;
    if (itineraryFacts.length >= 6 && itinerarySources >= 2) {
      const itineraryConflicts = itineraryFacts.filter((fact) => fact.consensus_status === "conflicted").length;
      proposals.push({
        topicKey: `${destinationSlug}:practical-solo-itinerary`,
        title: `A Practical ${destination.name} Itinerary for Solo Travelers`,
        rationale: `${itineraryFacts.length} route, timing, and area facts from ${itinerarySources} independent sources support an evidence-bounded itinerary.`,
        coverageScore: Math.max(0, Math.min(100, itineraryFacts.length * 9 + itinerarySources * 8 - itineraryConflicts * 5)),
        evidenceCount: itinerarySources,
        conflictCount: itineraryConflicts,
        staleFactCount: itineraryFacts.filter((fact) => fact.freshness_state === "stale").length,
        verificationFactCount: itineraryFacts.filter((fact) => fact.verification_priority === "requires_official").length,
        selectionPriority: 1,
      });
    }

    const upsert = this.db.prepare(`
      INSERT INTO topic_candidates(id, destination_slug, topic_key, proposed_title, rationale, coverage_score,
        evidence_count, conflict_count, stale_fact_count, verification_fact_count, strategy_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(topic_key) DO UPDATE SET proposed_title=excluded.proposed_title, rationale=excluded.rationale,
        coverage_score=excluded.coverage_score, evidence_count=excluded.evidence_count,
        conflict_count=excluded.conflict_count, stale_fact_count=excluded.stale_fact_count,
        verification_fact_count=excluded.verification_fact_count, updated_at=excluded.updated_at
    `);
    const selectedIds = proposals
      .sort((a, b) => a.selectionPriority - b.selectionPriority || b.coverageScore - a.coverageScore)
      .slice(0, maxPerDestination)
      .map((proposal) => {
        const candidateId = `topic_${sha256(proposal.topicKey).slice(0, 24)}`;
        upsert.run(candidateId, destinationSlug, proposal.topicKey, proposal.title, proposal.rationale,
          proposal.coverageScore, proposal.evidenceCount, proposal.conflictCount,
          proposal.staleFactCount, proposal.verificationFactCount, this.strategyVersion, timestamp, timestamp);
        const candidate = this.db.prepare("SELECT status, suppression_reason FROM topic_candidates WHERE id=?").get(candidateId);
        const wordpressCollision = this.findWordPressCollision(proposal.title);
        const searchCollision = wordpressCollision ? null : this.findSearchConsoleCollision(proposal.title);
        const collisionDismissal = candidate.status === "dismissed"
          && /^(wordpress|search_console):/.test(candidate.suppression_reason || "");
        if ((wordpressCollision || searchCollision) && (["candidate", "brief_queued"].includes(candidate.status) || collisionDismissal)) {
          const reason = wordpressCollision
            ? `wordpress:${wordpressCollision.post_id}:${wordpressCollision.title || wordpressCollision.slug}`
            : `search_console:${searchCollision.id}:${searchCollision.query}`;
          this.db.prepare("UPDATE topic_candidates SET status='dismissed', suppression_reason=?, updated_at=? WHERE id=?")
            .run(reason, timestamp, candidateId);
          this.db.prepare("DELETE FROM jobs WHERE type='plan_content' AND entity_id=? AND status='queued'").run(candidateId);
        } else if (!wordpressCollision && !searchCollision && collisionDismissal) {
          this.db.prepare("UPDATE topic_candidates SET status='candidate', suppression_reason=NULL, updated_at=? WHERE id=?")
            .run(timestamp, candidateId);
        }
        return candidateId;
      });
    if (!selectedIds.length) return [];
    const placeholders = selectedIds.map(() => "?").join(",");
    return this.db.prepare(`SELECT * FROM topic_candidates WHERE id IN (${placeholders}) AND status='candidate' ORDER BY coverage_score DESC`).all(...selectedIds);
  }

  queueCandidate(candidateId) {
    const candidate = this.db.prepare("SELECT * FROM topic_candidates WHERE id = ?").get(candidateId);
    if (!candidate || !["candidate", "brief_queued"].includes(candidate.status)) return false;
    if (candidate.strategy_version === this.strategyVersion) {
      const approved = this.db.prepare(`
        SELECT id FROM content_opportunities
        WHERE candidate_id=? AND strategy_version=? AND status='planned'
        LIMIT 1
      `).get(candidateId, this.strategyVersion);
      if (!approved) return false;
    }
    this.db.prepare("UPDATE topic_candidates SET status = 'brief_queued', updated_at = ? WHERE id = ?").run(now(), candidateId);
    this.enqueue("plan_content", candidateId);
    return true;
  }

  getTopicPackage(candidateId) {
    const candidate = this.db.prepare("SELECT * FROM topic_candidates WHERE id = ?").get(candidateId);
    if (!candidate) return null;
    return {
      candidate,
      facts: this.knowledgeForDestination(candidate.destination_slug),
      editorial_patterns: this.getEditorialBlueprints().slice(0, 8).map((item) => ({
        format: item.format, angle: item.angle, sample_count: item.sample_count,
        section_patterns: item.section_patterns.slice(0, 8), strengths: item.strengths.slice(0, 8), gaps: item.gaps.slice(0, 8),
      })),
      constraints: {
        research_only: true,
        audience: ["solo travelers", "first-time China visitors", "non-Chinese-speaking visitors"],
        commercial_layer_allowed: false,
      },
    };
  }

  saveBrief(candidateId, plan, model, { deferDraft = false } = {}) {
    const candidate = this.db.prepare("SELECT * FROM topic_candidates WHERE id = ?").get(candidateId);
    if (!candidate) throw new Error(`Topic candidate ${candidateId} not found.`);
    const existing = this.db.prepare("SELECT id FROM content_briefs WHERE candidate_id = ?").get(candidateId);
    const briefId = existing?.id || id("brief");
    const timestamp = now();
    const ledger = [...new Set((plan.outline || []).flatMap((section) => section.claim_keys || []))];
    const canonical = canonicalFromPlan(plan, candidate, this.contentConfig);
    if (existing) {
      this.db.prepare(`
        UPDATE content_briefs SET destination_slug=?, topic=?, audience=?, search_intent=?, plan_json=?, canonical_json=?,
          evidence_ledger_json=?, model=?, strategy_version=?, status='ready', last_error=NULL, updated_at=? WHERE id=?
      `).run(candidate.destination_slug, plan.title, JSON.stringify(plan.audience), plan.search_intent, JSON.stringify(plan),
        JSON.stringify(canonical), JSON.stringify(ledger), model, this.strategyVersion, timestamp, briefId);
    } else {
      this.db.prepare(`
        INSERT INTO content_briefs(id, destination_slug, topic, audience, search_intent, plan_json, canonical_json, status,
          created_at, updated_at, candidate_id, evidence_ledger_json, model, strategy_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?)
      `).run(briefId, candidate.destination_slug, plan.title, JSON.stringify(plan.audience), plan.search_intent, JSON.stringify(plan),
        JSON.stringify(canonical), timestamp, timestamp, candidateId, JSON.stringify(ledger), model, this.strategyVersion);
    }
    this.db.prepare("UPDATE topic_candidates SET status='brief_ready', updated_at=? WHERE id=?").run(timestamp, candidateId);
    if (!deferDraft) this.enqueue("generate_draft", briefId);
    return briefId;
  }

  getBriefPackage(briefId) {
    const brief = this.db.prepare("SELECT * FROM content_briefs WHERE id = ?").get(briefId);
    if (!brief) return null;
    const topicPackage = this.getTopicPackage(brief.candidate_id);
    return {
      brief: {
        ...brief, plan: json(brief.plan_json, {}), canonical: json(brief.canonical_json, {}),
        evidence_ledger: json(brief.evidence_ledger_json, []),
      },
      frontend_page_plan: this.getFrontendPagePlan(briefId),
      ...topicPackage,
    };
  }

  saveDraft(briefId, draft, model, { deferReview = false } = {}) {
    const brief = this.db.prepare("SELECT * FROM content_briefs WHERE id = ?").get(briefId);
    if (!brief) throw new Error(`Content brief ${briefId} not found.`);
    const existing = this.db.prepare("SELECT id, revision FROM article_drafts WHERE brief_id = ?").get(briefId);
    const draftId = existing?.id || id("draft");
    const timestamp = now();
    const authorizedSourceAssets = this.authorizedSourceAssetsForBrief(brief);
    const metadata = draftMetadata(draft, brief, this.contentConfig, authorizedSourceAssets);
    if (existing) {
      this.db.prepare(`
        UPDATE article_drafts SET title=?, slug=?, body_markdown=?, meta_description=?, evidence_ledger_json=?,
          unresolved_conflicts_json=?, verification_notes_json=?, model=?, revision=revision+1,
          seo_json=?, schema_jsonld=?, content_blocks_json=?, strategy_version=?, quality_report_json='{}', status='qa_queued', updated_at=?
        WHERE id=?
      `).run(draft.title, draft.slug, draft.body_markdown, draft.meta_description, JSON.stringify(draft.evidence_ledger),
        JSON.stringify(draft.unresolved_conflicts), JSON.stringify(draft.verification_notes || []), model,
        JSON.stringify(metadata.seo), JSON.stringify(metadata.schema), JSON.stringify(metadata.blocks), brief.strategy_version || this.strategyVersion, timestamp, draftId);
    } else {
      this.db.prepare(`
        INSERT INTO article_drafts(id, brief_id, title, slug, body_markdown, quality_report_json, status,
          created_at, updated_at, meta_description, evidence_ledger_json, unresolved_conflicts_json,
          verification_notes_json, model, seo_json, schema_jsonld, content_blocks_json, strategy_version)
        VALUES (?, ?, ?, ?, ?, '{}', 'qa_queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(draftId, briefId, draft.title, draft.slug, draft.body_markdown, timestamp, timestamp,
        draft.meta_description, JSON.stringify(draft.evidence_ledger), JSON.stringify(draft.unresolved_conflicts),
        JSON.stringify(draft.verification_notes || []), model, JSON.stringify(metadata.seo), JSON.stringify(metadata.schema),
        JSON.stringify(metadata.blocks), brief.strategy_version || this.strategyVersion);
    }
    this.replaceDraftVisuals(draftId, metadata.visuals, brief.strategy_version || this.strategyVersion);
    this.db.prepare("UPDATE topic_candidates SET status='drafted', updated_at=? WHERE id=?").run(timestamp, brief.candidate_id);
    this.db.prepare("UPDATE content_briefs SET status='drafted', updated_at=? WHERE id=?").run(timestamp, briefId);
    if (!deferReview) this.enqueue("review_draft", draftId);
    return draftId;
  }

  getDraftPackage(draftId) {
    const draft = this.db.prepare("SELECT * FROM article_drafts WHERE id = ?").get(draftId);
    if (!draft) return null;
    const briefPackage = this.getBriefPackage(draft.brief_id);
    const review = this.db.prepare("SELECT * FROM quality_reviews WHERE draft_id = ? ORDER BY created_at DESC LIMIT 1").get(draftId) || null;
    const publication = this.db.prepare("SELECT * FROM wordpress_publications WHERE draft_id = ?").get(draftId) || null;
    const compositionRow = this.db.prepare("SELECT * FROM commercial_compositions WHERE draft_id = ?").get(draftId) || null;
    return {
      ...briefPackage,
      draft: {
        ...draft,
        evidence_ledger: json(draft.evidence_ledger_json, []),
        unresolved_conflicts: json(draft.unresolved_conflicts_json, []),
        verification_notes: json(draft.verification_notes_json, []),
        seo: json(draft.seo_json, {}),
        schema_jsonld: json(draft.schema_jsonld, {}),
        content_blocks: json(draft.content_blocks_json, []),
        visuals: this.listDraftVisuals(draftId),
      },
      frontend_page: this.getFrontendPageComposition(draftId),
      review: review ? hydrateReview(review) : null,
      publication,
      commercial_composition: compositionRow ? {
        ...compositionRow,
        slots: json(compositionRow.slots_json, []),
        offer_ids: json(compositionRow.offer_ids_json, []),
        asset_ids: json(compositionRow.asset_ids_json, []),
        commercial_blocks: json(compositionRow.commercial_blocks_json, []),
        content_blocks: json(compositionRow.content_blocks_json, []),
      } : null,
    };
  }

  listDraftVisuals(draftId) {
    return this.db.prepare("SELECT * FROM article_visuals WHERE draft_id=? ORDER BY slot").all(draftId);
  }

  replaceDraftVisuals(draftId, visuals, strategyVersion) {
    const timestamp = now();
    transaction(this.db, () => {
      this.db.prepare("DELETE FROM article_visuals WHERE draft_id=?").run(draftId);
      const insert = this.db.prepare(`
        INSERT INTO article_visuals(id, draft_id, slot, placement, purpose, alt_text, caption, generation_prompt, aspect_ratio,
          strategy_version, image_type, image_role, image_subject, acquisition_strategy, factual_image_required,
          source_asset_id, source_remote_url, status, media_url, provider, model, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      visuals.forEach((visual, index) => insert.run(id("visual"), draftId, index + 1, visual.placement, visual.purpose,
        visual.alt_text, visual.caption, visual.generation_prompt, visual.aspect_ratio, strategyVersion, visual.image_type,
        visual.image_role, visual.image_subject, visual.acquisition_strategy, visual.factual_image_required ? 1 : 0,
        visual.source_asset_id || null, visual.source_remote_url || null, visual.status || "planned", visual.media_url || null,
        visual.provider || null, visual.model || null, timestamp, timestamp));
    });
  }

  plannedVisuals(draftId) {
    return this.db.prepare(`
      SELECT * FROM article_visuals WHERE draft_id=? AND status='planned' AND acquisition_strategy='generate_illustration'
      ORDER BY slot
    `).all(draftId);
  }

  saveGeneratedVisual(visualId, result) {
    this.db.prepare(`
      UPDATE article_visuals SET status='generated', media_path=?, media_url=?, provider=?, model=?, last_error=NULL, updated_at=?
      WHERE id=?
    `).run(result.mediaPath, result.mediaUrl, result.provider, result.model, now(), visualId);
    const visual = this.db.prepare("SELECT draft_id FROM article_visuals WHERE id=?").get(visualId);
    if (visual) this.refreshDraftSchema(visual.draft_id);
  }

  failVisual(visualId, error) {
    this.db.prepare("UPDATE article_visuals SET status='failed', last_error=?, updated_at=? WHERE id=?")
      .run(String(error?.message || error).slice(0, 4_000), now(), visualId);
  }

  saveWordPressVisual(visualId, media) {
    const before = this.db.prepare(`
      SELECT av.draft_id, av.media_url AS previous_media_url, ad.seo_json
      FROM article_visuals av JOIN article_drafts ad ON ad.id=av.draft_id WHERE av.id=?
    `).get(visualId);
    this.db.prepare("UPDATE article_visuals SET wordpress_media_id=?, wordpress_media_url=?, media_url=?, updated_at=? WHERE id=?")
      .run(media.id, media.url, media.url, now(), visualId);
    if (before) {
      const seo = json(before.seo_json, {});
      if (!seo.og_image || seo.og_image === before.previous_media_url) {
        seo.og_image = media.url;
        this.db.prepare("UPDATE article_drafts SET seo_json=?, updated_at=? WHERE id=?")
          .run(JSON.stringify(seo), now(), before.draft_id);
      }
      this.refreshDraftSchema(before.draft_id);
    }
  }

  refreshDraftSchema(draftId) {
    const row = this.db.prepare(`
      SELECT ad.*, cb.destination_slug, cb.canonical_json FROM article_drafts ad JOIN content_briefs cb ON cb.id=ad.brief_id WHERE ad.id=?
    `).get(draftId);
    if (!row) return;
    const schema = buildArticleSchema({ ...row, seo: json(row.seo_json, {}), canonical: json(row.canonical_json, {}) }, this.listDraftVisuals(draftId), this.contentConfig);
    this.db.prepare("UPDATE article_drafts SET schema_jsonld=?, updated_at=? WHERE id=?").run(JSON.stringify(schema), now(), draftId);
  }

  saveReview(draftId, review, reviewer) {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO quality_reviews(id, draft_id, passed, score, checks_json, issues_json,
        unsupported_claims_json, reviewer, strategy_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id("review"), draftId, review.passed ? 1 : 0, review.score, JSON.stringify(review.checks), JSON.stringify(review.issues),
      JSON.stringify(review.unsupported_claims), reviewer, this.db.prepare("SELECT strategy_version FROM article_drafts WHERE id=?").get(draftId)?.strategy_version || this.strategyVersion, timestamp);
    this.db.prepare("UPDATE article_drafts SET quality_report_json=?, status=?, updated_at=? WHERE id=?")
      .run(JSON.stringify(review), review.passed ? "ready_for_wordpress" : "qa_failed", timestamp, draftId);
    return this.db.prepare("SELECT revision FROM article_drafts WHERE id = ?").get(draftId)?.revision || 1;
  }

  prepareWordPressPublication(draftId, siteUrl) {
    const timestamp = now();
    const existing = this.db.prepare("SELECT * FROM wordpress_publications WHERE draft_id = ?").get(draftId);
    if (existing) {
      this.db.prepare("UPDATE wordpress_publications SET status='queued', last_error=NULL, updated_at=? WHERE draft_id=?").run(timestamp, draftId);
      return existing;
    }
    const publication = { id: id("wp"), draft_id: draftId, site_url: siteUrl, post_id: null };
    this.db.prepare(`
      INSERT INTO wordpress_publications(id, draft_id, site_url, status, strategy_version, created_at, updated_at)
      VALUES (?, ?, ?, 'queued', ?, ?, ?)
    `).run(publication.id, draftId, siteUrl, this.db.prepare("SELECT strategy_version FROM article_drafts WHERE id=?").get(draftId)?.strategy_version || this.strategyVersion, timestamp, timestamp);
    return publication;
  }

  completeWordPressPublication(draftId, result) {
    this.db.prepare(`
      UPDATE wordpress_publications SET post_id=?, post_url=?, status='synced', last_error=NULL, updated_at=? WHERE draft_id=?
    `).run(result.postId, result.postUrl, now(), draftId);
    for (const visual of result.visuals || []) this.saveWordPressVisual(visual.visualId, visual);
    this.db.prepare("UPDATE article_drafts SET status='wordpress_draft', updated_at=? WHERE id=?").run(now(), draftId);
  }

  failWordPressPublication(draftId, error) {
    this.db.prepare("UPDATE wordpress_publications SET status='failed', last_error=?, updated_at=? WHERE draft_id=?")
      .run(String(error?.message || error).slice(0, 4000), now(), draftId);
  }

  listContent() {
    return this.db.prepare(`
      SELECT tc.*, cb.id AS brief_id, cb.status AS brief_status, ad.id AS draft_id, ad.status AS draft_status,
        ad.title AS draft_title, ad.revision, qr.passed AS qa_passed, qr.score AS qa_score,
        wp.post_id AS wordpress_post_id, wp.post_url AS wordpress_post_url, wp.status AS wordpress_status,
        cc.status AS commercial_status, json_array_length(COALESCE(cc.offer_ids_json, '[]')) AS commercial_offer_count
      FROM topic_candidates tc
      LEFT JOIN content_briefs cb ON cb.candidate_id = tc.id
      LEFT JOIN article_drafts ad ON ad.brief_id = cb.id
      LEFT JOIN quality_reviews qr ON qr.id = (
        SELECT id FROM quality_reviews WHERE draft_id = ad.id ORDER BY created_at DESC LIMIT 1
      )
      LEFT JOIN wordpress_publications wp ON wp.draft_id = ad.id
      LEFT JOIN commercial_compositions cc ON cc.draft_id = ad.id
      ORDER BY tc.coverage_score DESC, tc.updated_at DESC
    `).all();
  }

  upsertAffiliateProviderAccount(account) {
    const timestamp = now();
    const existing = this.db.prepare("SELECT id FROM affiliate_provider_accounts WHERE provider_key=?").get(account.providerKey);
    const providerId = existing?.id || account.id;
    this.db.prepare(`INSERT INTO affiliate_provider_accounts(id, provider_key, display_name, connection_mode,
      site_name, default_language, default_disclosure, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_key) DO UPDATE SET display_name=excluded.display_name, connection_mode=excluded.connection_mode,
        site_name=excluded.site_name, default_language=excluded.default_language,
        default_disclosure=excluded.default_disclosure, status=excluded.status, updated_at=excluded.updated_at`)
      .run(providerId, account.providerKey, account.displayName, account.connectionMode, account.siteName,
        account.defaultLanguage, account.defaultDisclosure, account.status, timestamp, timestamp);
    return this.getAffiliateProviderAccount(providerId);
  }

  getAffiliateProviderAccount(providerId) {
    return this.db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM affiliate_assets a
      WHERE a.provider_account_id=p.id AND a.active=1) AS active_asset_count
      FROM affiliate_provider_accounts p WHERE p.id=?`).get(providerId) || null;
  }

  listAffiliateProviderAccounts() {
    return this.db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM affiliate_assets a
      WHERE a.provider_account_id=p.id AND a.active=1) AS active_asset_count
      FROM affiliate_provider_accounts p ORDER BY p.display_name`).all();
  }

  upsertAffiliateAsset(asset) {
    const provider = this.getAffiliateProviderAccount(asset.providerAccountId);
    if (!provider) throw new Error("Affiliate asset provider account does not exist.");
    const timestamp = now();
    this.db.prepare(`INSERT INTO affiliate_assets(id, provider_account_id, provider, asset_type, product_category,
      scope_type, scope_key, destination_slug, area_key, route_key, entity_key, entity_name, provider_entity_id,
      title, description, cta_label, target_url, embed_config_json, language, priority, active, valid_from,
      valid_until, source_updated_at, legacy_offer_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET provider_account_id=excluded.provider_account_id, provider=excluded.provider,
        asset_type=excluded.asset_type, product_category=excluded.product_category, scope_type=excluded.scope_type,
        scope_key=excluded.scope_key, destination_slug=excluded.destination_slug, area_key=excluded.area_key,
        route_key=excluded.route_key, entity_key=excluded.entity_key, entity_name=excluded.entity_name,
        provider_entity_id=excluded.provider_entity_id, title=excluded.title, description=excluded.description,
        cta_label=excluded.cta_label, target_url=excluded.target_url, embed_config_json=excluded.embed_config_json,
        language=excluded.language, priority=excluded.priority, active=excluded.active, valid_from=excluded.valid_from,
        valid_until=excluded.valid_until, source_updated_at=excluded.source_updated_at, updated_at=excluded.updated_at`)
      .run(asset.id, asset.providerAccountId, asset.provider, asset.assetType, asset.productCategory, asset.scopeType,
        asset.scopeKey, asset.destinationSlug, asset.areaKey, asset.routeKey, asset.entityKey, asset.entityName,
        asset.providerEntityId, asset.title, asset.description, asset.ctaLabel, asset.targetUrl,
        JSON.stringify(asset.embedConfig || {}), asset.language, asset.priority, asset.active ? 1 : 0, asset.validFrom,
        asset.validUntil, asset.sourceUpdatedAt, asset.legacyOfferId, timestamp, timestamp);
    this.db.prepare(`INSERT OR IGNORE INTO affiliate_asset_mappings(id, affiliate_asset_id, scope_type, scope_key, destination_slug, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(`asset_mapping_${sha256(`${asset.id}:${asset.scopeType}:${asset.scopeKey}`).slice(0, 24)}`,
        asset.id, asset.scopeType, asset.scopeKey || asset.destinationSlug || asset.productCategory, asset.destinationSlug, timestamp);
    return this.getAffiliateAsset(asset.id);
  }

  getAffiliateAsset(assetId) {
    const row = this.db.prepare("SELECT * FROM affiliate_assets WHERE id=?").get(assetId);
    return row ? { ...row, embed_config: json(row.embed_config_json, {}) } : null;
  }

  listAffiliateAssets({ activeOnly = false, providerAccountId = null } = {}) {
    const clauses = [];
    const values = [];
    if (activeOnly) { clauses.push("active=1 AND (valid_from IS NULL OR valid_from<=?) AND (valid_until IS NULL OR valid_until>?)"); values.push(now(), now()); }
    if (providerAccountId) { clauses.push("provider_account_id=?"); values.push(providerAccountId); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db.prepare(`SELECT * FROM affiliate_assets ${where} ORDER BY provider, active DESC, priority DESC, product_category, title`)
      .all(...values).map((row) => ({ ...row, embed_config: json(row.embed_config_json, {}) }));
  }

  listAffiliateAssetMappings() {
    return this.db.prepare(`SELECT m.*, a.title, a.provider, a.product_category, a.asset_type
      FROM affiliate_asset_mappings m JOIN affiliate_assets a ON a.id=m.affiliate_asset_id
      ORDER BY m.destination_slug, m.scope_type, m.scope_key`).all();
  }

  listAffiliateOpportunities(status = "open") {
    return this.db.prepare("SELECT * FROM affiliate_opportunities WHERE status=? ORDER BY score DESC, updated_at DESC")
      .all(status).map((row) => ({ ...row, factors: json(row.factors_json, {}) }));
  }

  recordCommercialEvent(event) {
    this.db.prepare(`INSERT INTO commercial_events(id, event_type, article_id, draft_id, offer_id,
      affiliate_asset_id, provider, category, slot_key, component_variant, placement, entity_key, route_key,
      destination_slug, device, locale, strategy_version, value_amount, occurred_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(event.id, event.eventType, event.articleId, event.draftId, event.offerId, event.affiliateAssetId,
        event.provider, event.category, event.slotKey, event.componentVariant, event.placement, event.entityKey,
        event.routeKey, event.destinationSlug, event.device, event.locale, event.strategyVersion,
        event.valueAmount, event.occurredAt, now());
    return { id: event.id, eventType: event.eventType, occurredAt: event.occurredAt };
  }

  commercialPerformance() {
    const rows = this.db.prepare(`SELECT provider, category, slot_key, component_variant, destination_slug,
      SUM(event_type='impression') AS impressions, SUM(event_type='click') AS clicks,
      SUM(event_type='booking') AS bookings, SUM(CASE WHEN event_type='commission' THEN COALESCE(value_amount,0) ELSE 0 END) AS commission
      FROM commercial_events GROUP BY provider, category, slot_key, component_variant, destination_slug
      ORDER BY commission DESC, clicks DESC`).all();
    return rows.map((row) => ({ ...row, ctr: row.impressions ? row.clicks / row.impressions : 0,
      conversion_rate: row.clicks ? row.bookings / row.clicks : 0, epc: row.clicks ? row.commission / row.clicks : 0,
      rpm: row.impressions ? row.commission * 1_000 / row.impressions : 0 }));
  }

  upsertCommissionRule(rule) {
    const timestamp = now();
    const validFrom = rule.validFrom || "";
    this.db.prepare(`INSERT INTO commission_rules(id, provider, product_category, commission_model,
      effective_rate, valid_from, valid_until, promotion_multiplier, source_updated_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, product_category, valid_from) DO UPDATE SET commission_model=excluded.commission_model,
        effective_rate=excluded.effective_rate, valid_until=excluded.valid_until,
        promotion_multiplier=excluded.promotion_multiplier, source_updated_at=excluded.source_updated_at,
        updated_at=excluded.updated_at`)
      .run(rule.id, rule.provider, rule.productCategory, rule.commissionModel, rule.effectiveRate, validFrom,
        rule.validUntil, rule.promotionMultiplier, rule.sourceUpdatedAt, timestamp, timestamp);
    return this.db.prepare("SELECT * FROM commission_rules WHERE provider=? AND product_category=? AND valid_from=?")
      .get(rule.provider, rule.productCategory, validFrom);
  }

  listCommissionRules() {
    return this.db.prepare("SELECT * FROM commission_rules ORDER BY provider, product_category, valid_from DESC").all();
  }

  upsertCommercialOffer(offer) {
    const timestamp = now();
    const existing = this.db.prepare("SELECT id FROM commercial_offers WHERE offer_key=?").get(offer.offerKey);
    const offerId = existing?.id || offer.id;
    this.db.prepare(`
      INSERT INTO commercial_offers(id, provider, category, destination_slug, payload_json, active, updated_at,
        offer_key, title, target_url, cta_label, description, price_text, valid_until, priority, source_updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(offer_key) DO UPDATE SET provider=excluded.provider, category=excluded.category,
        destination_slug=excluded.destination_slug, payload_json=excluded.payload_json, active=excluded.active,
        updated_at=excluded.updated_at, title=excluded.title, target_url=excluded.target_url,
        cta_label=excluded.cta_label, description=excluded.description, price_text=excluded.price_text,
        valid_until=excluded.valid_until, priority=excluded.priority, source_updated_at=excluded.source_updated_at
    `).run(
      offerId, offer.provider, offer.category, offer.destinationSlug, JSON.stringify({ externalId: offer.offerKey.split(":").slice(1).join(":") }),
      offer.active ? 1 : 0, timestamp, offer.offerKey, offer.title, offer.targetUrl, offer.ctaLabel,
      offer.description, offer.priceText, offer.validUntil, offer.priority, offer.sourceUpdatedAt,
    );
    const providerKey = slugify(offer.provider);
    const provider = this.upsertAffiliateProviderAccount({
      id: `provider_${sha256(providerKey).slice(0, 24)}`, providerKey, displayName: offer.provider,
      connectionMode: "FEED", siteName: "", defaultLanguage: "en", defaultDisclosure: "", status: "CONFIGURED",
    });
    this.upsertAffiliateAsset(legacyOfferToAsset({ ...offer, id: offerId }, provider.id));
    return this.db.prepare("SELECT * FROM commercial_offers WHERE id=?").get(offerId);
  }

  listCommercialOffers({ activeOnly = false } = {}) {
    const where = activeOnly ? "WHERE active=1 AND (valid_until IS NULL OR valid_until > ?)" : "";
    return activeOnly
      ? this.db.prepare(`SELECT * FROM commercial_offers ${where} ORDER BY destination_slug, priority DESC, category`).all(now())
      : this.db.prepare("SELECT * FROM commercial_offers ORDER BY destination_slug, active DESC, priority DESC, category").all();
  }

  activeOffersForDestination(destinationSlug) {
    return this.db.prepare(`SELECT * FROM affiliate_assets
      WHERE active=1 AND (destination_slug=? OR scope_type IN ('COUNTRY','CATEGORY','GLOBAL'))
        AND (valid_from IS NULL OR valid_from<=?) AND (valid_until IS NULL OR valid_until>?)
      ORDER BY priority DESC, product_category, title`).all(destinationSlug, now(), now());
  }

  saveCommercialComposition(draftId, composition) {
    const timestamp = now();
    const compositionId = `composition_${sha256(draftId).slice(0, 24)}`;
    transaction(this.db, () => {
      this.db.prepare("DELETE FROM commercial_slots WHERE draft_id=?").run(draftId);
      this.db.prepare("DELETE FROM affiliate_opportunities WHERE draft_id=?").run(draftId);
      this.db.prepare("DELETE FROM commercial_intents WHERE draft_id=?").run(draftId);
      for (const intent of composition.intents || []) this.db.prepare(`INSERT INTO commercial_intents(
        id, draft_id, block_index, block_key, intent_type, product_category, destination_slug, area_key,
        route_key, entity_key, intent_strength, decision_stage, recommended_component, reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(intent.id, draftId, intent.blockIndex, intent.blockKey, intent.intentType, intent.productCategory,
          intent.destinationSlug, intent.areaKey, intent.routeKey, intent.entityKey, intent.intentStrength,
          intent.decisionStage, intent.recommendedComponent, intent.reason, timestamp, timestamp);
      for (const slot of composition.slots || []) this.db.prepare(`INSERT INTO commercial_slots(
        id, draft_id, intent_id, affiliate_asset_id, slot_key, component_type, placement, block_index,
        strategy_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(`commercial_slot_${sha256(`${draftId}:${slot.slot_key}`).slice(0, 24)}`, draftId,
          (composition.intents || []).find((intent) => intent.blockIndex === slot.block_index && intent.productCategory === slot.product_category)?.id || null,
          slot.affiliate_asset_id, slot.slot_key, slot.component_type, slot.placement, slot.block_index,
          this.strategyVersion, timestamp, timestamp);
      for (const opportunity of composition.opportunities || []) this.db.prepare(`INSERT INTO affiliate_opportunities(
        id, draft_id, intent_id, provider, product_category, scope_type, scope_key, score, factors_json,
        reason, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`)
        .run(opportunity.id, draftId, opportunity.intentId, opportunity.provider, opportunity.productCategory,
          opportunity.scopeType, opportunity.scopeKey, opportunity.score, JSON.stringify(opportunity.factors), opportunity.reason, timestamp, timestamp);
      this.db.prepare(`INSERT INTO commercial_compositions(id, draft_id, publishable_body_markdown, slots_json, offer_ids_json,
        disclosure_text, status, created_at, updated_at, asset_ids_json, commercial_blocks_json,
        content_blocks_json, strategy_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(draft_id) DO UPDATE SET publishable_body_markdown=excluded.publishable_body_markdown,
          slots_json=excluded.slots_json, offer_ids_json=excluded.offer_ids_json, disclosure_text=excluded.disclosure_text,
          status=excluded.status, updated_at=excluded.updated_at, asset_ids_json=excluded.asset_ids_json,
          commercial_blocks_json=excluded.commercial_blocks_json, content_blocks_json=excluded.content_blocks_json,
          strategy_version=excluded.strategy_version`)
        .run(compositionId, draftId, composition.publishableBodyMarkdown, JSON.stringify(composition.slots),
          JSON.stringify(composition.offerIds), composition.disclosureText, composition.status, timestamp, timestamp,
          JSON.stringify(composition.assetIds || []), JSON.stringify(composition.commercialBlocks || []),
          JSON.stringify(composition.contentBlocks || []), this.strategyVersion);
      this.db.prepare("UPDATE article_drafts SET status='commercial_ready', updated_at=? WHERE id=?").run(timestamp, draftId);
    });
  }

  retryContent(candidateId) {
    const row = this.db.prepare(`
      SELECT tc.id, tc.status AS candidate_status, cb.id AS brief_id, cb.status AS brief_status,
        ad.id AS draft_id, ad.status AS draft_status, ad.revision, qr.passed AS qa_passed,
        wp.status AS wordpress_status, cc.status AS commercial_status
      FROM topic_candidates tc
      LEFT JOIN content_briefs cb ON cb.candidate_id=tc.id
      LEFT JOIN article_drafts ad ON ad.brief_id=cb.id
      LEFT JOIN quality_reviews qr ON qr.id=(SELECT id FROM quality_reviews WHERE draft_id=ad.id ORDER BY created_at DESC LIMIT 1)
      LEFT JOIN wordpress_publications wp ON wp.draft_id=ad.id
      LEFT JOIN commercial_compositions cc ON cc.draft_id=ad.id
      WHERE tc.id=?
    `).get(candidateId);
    if (!row) return null;
    if (!row.brief_id) return this.queueCandidate(candidateId) ? "plan_content" : null;
    if (!row.draft_id) {
      this.db.prepare("UPDATE content_briefs SET status='ready', last_error=NULL, updated_at=? WHERE id=?").run(now(), row.brief_id);
      this.enqueue("generate_draft", row.brief_id);
      return "generate_draft";
    }
    if (row.qa_passed && !row.commercial_status) {
      this.enqueue("compose_commercial", row.draft_id);
      return "compose_commercial";
    }
    if (row.qa_passed && row.wordpress_status === "failed") {
      this.enqueue("push_wordpress_draft", row.draft_id);
      return "push_wordpress_draft";
    }
    if (!row.qa_passed) {
      this.enqueue("revise_draft", row.draft_id);
      return "revise_draft";
    }
    return null;
  }

  enqueueStartupReconciliation({ wordpressEnabled = false } = {}) {
    const researchSlugs = new Set(this.db.prepare("SELECT DISTINCT destination_slug FROM structured_sources").all().map((row) => row.destination_slug));
    for (const slug of researchSlugs) this.enqueue("rebuild_knowledge", slug);
    for (const row of this.db.prepare("SELECT slug FROM destinations").all()) {
      if (!researchSlugs.has(row.slug)) this.enqueue("rebuild_topics", row.slug);
    }
    if (wordpressEnabled) {
      for (const row of this.db.prepare("SELECT id FROM article_drafts WHERE status IN ('ready_for_wordpress','commercial_ready')").all()) {
        this.enqueue("compose_commercial", row.id);
      }
    }
  }

  maintenanceDue(taskKey, intervalHours) {
    const state = this.db.prepare("SELECT status, last_succeeded_at FROM maintenance_runs WHERE task_key=?").get(taskKey);
    if (!state?.last_succeeded_at || state.status !== "succeeded") return true;
    return Date.now() - Date.parse(state.last_succeeded_at) >= Math.max(1 / 60, intervalHours) * 3_600_000;
  }

  startMaintenance(taskKey) {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO maintenance_runs(task_key, status, last_started_at, updated_at)
      VALUES (?, 'running', ?, ?)
      ON CONFLICT(task_key) DO UPDATE SET status='running', last_started_at=excluded.last_started_at,
        last_error=NULL, updated_at=excluded.updated_at
    `).run(taskKey, timestamp, timestamp);
  }

  completeMaintenance(taskKey, itemCount = 0, metadata = {}) {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO maintenance_runs(task_key, status, last_started_at, last_succeeded_at, item_count, metadata_json, updated_at)
      VALUES (?, 'succeeded', ?, ?, ?, ?, ?)
      ON CONFLICT(task_key) DO UPDATE SET status='succeeded', last_succeeded_at=excluded.last_succeeded_at,
        last_error=NULL, item_count=excluded.item_count, metadata_json=excluded.metadata_json, updated_at=excluded.updated_at
    `).run(taskKey, timestamp, timestamp, itemCount, JSON.stringify(metadata), timestamp);
  }

  failMaintenance(taskKey, error) {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO maintenance_runs(task_key, status, last_error, updated_at)
      VALUES (?, 'failed', ?, ?)
      ON CONFLICT(task_key) DO UPDATE SET status='failed', last_error=excluded.last_error, updated_at=excluded.updated_at
    `).run(taskKey, String(error?.message || error).slice(0, 4_000), timestamp);
  }

  listMaintenanceRuns() {
    return this.db.prepare("SELECT * FROM maintenance_runs ORDER BY task_key").all().map((row) => ({
      ...row,
      metadata: json(row.metadata_json, {}),
    }));
  }

  jobTelemetry(windowHours = 24) {
    const hours = Math.max(1, Number(windowHours) || 24);
    const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
    const counts = { queued: 0, running: 0, succeeded: 0, failed: 0 };
    for (const row of this.db.prepare("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status").all()) counts[row.status] = row.count;
    const oldest = this.db.prepare("SELECT MIN(created_at) AS created_at FROM jobs WHERE status='queued'").get().created_at;
    const completed = this.db.prepare(`
      SELECT type, status, queue_latency_ms, duration_ms FROM jobs
      WHERE completed_at >= ? AND status IN ('succeeded','failed')
      ORDER BY completed_at DESC LIMIT 5000
    `).all(cutoff);
    const queueLatencies = completed.map((row) => row.queue_latency_ms).filter(Number.isFinite);
    const durations = completed.map((row) => row.duration_ms).filter(Number.isFinite);
    const succeeded = completed.filter((row) => row.status === "succeeded").length;
    const failed = completed.length - succeeded;
    const typeMap = new Map();
    for (const row of completed) {
      const summary = typeMap.get(row.type) || { type: row.type, completed: 0, succeeded: 0, failed: 0, durations: [], queueLatencies: [] };
      summary.completed += 1;
      summary[row.status] += 1;
      if (Number.isFinite(row.duration_ms)) summary.durations.push(row.duration_ms);
      if (Number.isFinite(row.queue_latency_ms)) summary.queueLatencies.push(row.queue_latency_ms);
      typeMap.set(row.type, summary);
    }
    const active = this.db.prepare(`
      SELECT type, status, COUNT(*) AS count FROM jobs WHERE status IN ('queued','running') GROUP BY type, status
    `).all();
    for (const row of active) {
      const summary = typeMap.get(row.type) || { type: row.type, completed: 0, succeeded: 0, failed: 0, durations: [], queueLatencies: [] };
      summary[row.status] = row.count;
      typeMap.set(row.type, summary);
    }
    return {
      generatedAt: now(),
      windowHours: hours,
      counts,
      active: counts.queued + counts.running,
      oldestQueuedAt: oldest || null,
      oldestQueuedAgeSeconds: oldest ? Math.max(0, Math.round((Date.now() - Date.parse(oldest)) / 1000)) : 0,
      recent: {
        completed: completed.length,
        succeeded,
        failed,
        successRate: completed.length ? Math.round((succeeded / completed.length) * 1000) / 10 : null,
        queueLatencyMs: distribution(queueLatencies),
        durationMs: distribution(durations),
      },
      types: [...typeMap.values()].map((item) => ({
        type: item.type,
        queued: item.queued || 0,
        running: item.running || 0,
        completed: item.completed,
        succeeded: item.succeeded,
        failed: item.failed,
        queueP95Ms: percentile(item.queueLatencies, 0.95),
        durationP95Ms: percentile(item.durations, 0.95),
      })).sort((a, b) => b.queued + b.running - a.queued - a.running || b.completed - a.completed || a.type.localeCompare(b.type)),
    };
  }

  notificationCandidates(exceptions, repeatHours = 24, clock = new Date()) {
    const state = new Map(this.db.prepare("SELECT * FROM exception_notification_state").all().map((row) => [row.exception_key, row]));
    const repeatMs = Math.max(1, Number(repeatHours) || 24) * 3_600_000;
    return exceptions.flatMap((item) => {
      const fingerprint = sha256(JSON.stringify([item.key, item.severity, item.title, item.subject, item.detail, item.retryable]));
      const previous = state.get(item.key);
      const due = !previous || previous.fingerprint !== fingerprint || previous.status === "failed"
        || !previous.last_sent_at || clock.getTime() - Date.parse(previous.last_sent_at) >= repeatMs;
      return due ? [{ ...item, fingerprint }] : [];
    });
  }

  pruneResolvedNotificationState(activeKeys) {
    const active = new Set(activeKeys);
    let removed = 0;
    const remove = this.db.prepare("DELETE FROM exception_notification_state WHERE exception_key=?");
    for (const row of this.db.prepare("SELECT exception_key FROM exception_notification_state").all()) {
      if (!active.has(row.exception_key)) removed += remove.run(row.exception_key).changes;
    }
    return removed;
  }

  recordNotificationSent(exceptionKey, fingerprint, timestamp = now()) {
    this.db.prepare(`
      INSERT INTO exception_notification_state(exception_key, fingerprint, status, attempts, last_attempted_at, last_sent_at, updated_at)
      VALUES (?, ?, 'sent', 1, ?, ?, ?)
      ON CONFLICT(exception_key) DO UPDATE SET fingerprint=excluded.fingerprint, status='sent',
        attempts=exception_notification_state.attempts+1, last_attempted_at=excluded.last_attempted_at,
        last_sent_at=excluded.last_sent_at, last_error=NULL, updated_at=excluded.updated_at
    `).run(exceptionKey, fingerprint, timestamp, timestamp, timestamp);
  }

  recordNotificationFailed(exceptionKey, fingerprint, error, timestamp = now()) {
    this.db.prepare(`
      INSERT INTO exception_notification_state(exception_key, fingerprint, status, attempts, last_attempted_at, last_error, updated_at)
      VALUES (?, ?, 'failed', 1, ?, ?, ?)
      ON CONFLICT(exception_key) DO UPDATE SET fingerprint=excluded.fingerprint, status='failed',
        attempts=exception_notification_state.attempts+1, last_attempted_at=excluded.last_attempted_at,
        last_error=excluded.last_error, updated_at=excluded.updated_at
    `).run(exceptionKey, fingerprint, timestamp, String(error?.message || error).slice(0, 4_000), timestamp);
  }

  notificationOverview() {
    const rows = this.db.prepare("SELECT * FROM exception_notification_state ORDER BY updated_at DESC").all();
    return {
      tracked: rows.length,
      sent: rows.filter((row) => row.status === "sent").length,
      failed: rows.filter((row) => row.status === "failed").length,
      lastAttemptedAt: rows[0]?.last_attempted_at || null,
      lastSentAt: rows.find((row) => row.last_sent_at)?.last_sent_at || null,
      lastError: rows.find((row) => row.status === "failed")?.last_error || null,
    };
  }

  enqueueKnowledgeReconciliation() {
    const rows = this.db.prepare("SELECT DISTINCT destination_slug FROM structured_sources ORDER BY destination_slug").all();
    for (const row of rows) this.enqueue("rebuild_knowledge", row.destination_slug);
    return rows.length;
  }

  pruneSucceededJobs(retentionDays = 30) {
    const cutoff = new Date(Date.now() - Math.max(1, retentionDays) * 86_400_000).toISOString();
    return this.db.prepare("DELETE FROM jobs WHERE status='succeeded' AND updated_at < ?").run(cutoff).changes;
  }

  enqueueWordPressInventorySync(siteUrl, syncHours = 24, force = false) {
    if (!siteUrl) return null;
    const state = this.getWordPressSyncState(siteUrl);
    const lastSucceeded = state?.last_succeeded_at ? Date.parse(state.last_succeeded_at) : 0;
    const staleAfterMs = Math.max(1, syncHours) * 60 * 60 * 1_000;
    if (!force && state?.status === "succeeded" && lastSucceeded && Date.now() - lastSucceeded < staleAfterMs) return null;
    return this.enqueue("sync_wordpress_inventory", siteUrl);
  }

  startWordPressInventorySync(siteUrl) {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO integration_sync_state(sync_key, status, last_started_at, updated_at)
      VALUES (?, 'running', ?, ?)
      ON CONFLICT(sync_key) DO UPDATE SET status='running', last_started_at=excluded.last_started_at,
        last_error=NULL, updated_at=excluded.updated_at
    `).run(wordpressSyncKey(siteUrl), timestamp, timestamp);
  }

  replaceWordPressInventory(siteUrl, items) {
    const timestamp = now();
    return transaction(this.db, () => {
      // V1 has one WordPress destination. Dropping previous-site rows prevents stale
      // candidates from being suppressed after the configured site changes.
      this.db.prepare("DELETE FROM wordpress_content_inventory").run();
      const insert = this.db.prepare(`
        INSERT INTO wordpress_content_inventory(id, site_url, post_id, slug, title, status, post_url, modified_at, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of items) {
        insert.run(`wpi_${sha256(`${siteUrl}:${item.postId}`).slice(0, 24)}`, siteUrl, item.postId,
          item.slug, item.title, item.status, item.postUrl, item.modifiedAt, timestamp);
      }
      this.db.prepare(`
        INSERT INTO integration_sync_state(sync_key, status, last_started_at, last_succeeded_at, item_count, updated_at)
        VALUES (?, 'succeeded', ?, ?, ?, ?)
        ON CONFLICT(sync_key) DO UPDATE SET status='succeeded', last_succeeded_at=excluded.last_succeeded_at,
          last_error=NULL, item_count=excluded.item_count, updated_at=excluded.updated_at
      `).run(wordpressSyncKey(siteUrl), timestamp, timestamp, items.length, timestamp);
      for (const row of this.db.prepare("SELECT slug FROM destinations").all()) this.enqueue("rebuild_topics", row.slug);
      return items.length;
    });
  }

  failWordPressInventorySync(siteUrl, error) {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO integration_sync_state(sync_key, status, last_error, updated_at)
      VALUES (?, 'failed', ?, ?)
      ON CONFLICT(sync_key) DO UPDATE SET status='failed', last_error=excluded.last_error, updated_at=excluded.updated_at
    `).run(wordpressSyncKey(siteUrl), String(error?.message || error).slice(0, 4_000), timestamp);
  }

  listWordPressInventory(siteUrl = null) {
    if (siteUrl) return this.db.prepare("SELECT * FROM wordpress_content_inventory WHERE site_url=? ORDER BY modified_at DESC, post_id DESC").all(siteUrl);
    return this.db.prepare("SELECT * FROM wordpress_content_inventory ORDER BY modified_at DESC, post_id DESC").all();
  }

  getWordPressSyncState(siteUrl) {
    if (!siteUrl) return null;
    return this.db.prepare("SELECT * FROM integration_sync_state WHERE sync_key=?").get(wordpressSyncKey(siteUrl)) || null;
  }

  findWordPressCollision(title) {
    const titleSlug = slugify(title);
    const normalizedTitle = normalizeTitle(title);
    const titleTokens = topicTokens(title);
    for (const row of this.db.prepare("SELECT * FROM wordpress_content_inventory").all()) {
      if (row.slug === titleSlug || normalizeTitle(row.title) === normalizedTitle) return row;
      const rowTokens = topicTokens(row.title);
      const union = new Set([...titleTokens, ...rowTokens]);
      const intersection = [...titleTokens].filter((token) => rowTokens.has(token)).length;
      if (union.size && intersection / union.size >= 0.78) return row;
    }
    return null;
  }

  enqueueSearchConsoleSync(propertyUrl, syncHours = 24, force = false) {
    if (!propertyUrl) return null;
    const state = this.getSearchConsoleSyncState(propertyUrl);
    const lastSucceeded = state?.last_succeeded_at ? Date.parse(state.last_succeeded_at) : 0;
    const staleAfterMs = Math.max(1, syncHours) * 3_600_000;
    if (!force && state?.status === "succeeded" && lastSucceeded && Date.now() - lastSucceeded < staleAfterMs) return null;
    return this.enqueue("sync_search_console", propertyUrl);
  }

  startSearchConsoleSync(propertyUrl) {
    this.startIntegrationSync(searchConsoleSyncKey(propertyUrl));
  }

  replaceSearchConsoleInventory(propertyUrl, inventory) {
    const timestamp = now();
    return transaction(this.db, () => {
      this.db.prepare("DELETE FROM search_console_inventory").run();
      const insert = this.db.prepare(`
        INSERT INTO search_console_inventory(id, property_url, query, page_url, clicks, impressions, ctr, position,
          start_date, end_date, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of inventory.rows) {
        insert.run(`gsc_${sha256(`${propertyUrl}:${item.query}:${item.pageUrl}`).slice(0, 24)}`, propertyUrl,
          item.query, item.pageUrl, item.clicks, item.impressions, item.ctr, item.position,
          inventory.startDate, inventory.endDate, timestamp);
      }
      this.completeIntegrationSync(searchConsoleSyncKey(propertyUrl), inventory.rows.length, timestamp);
      for (const row of this.db.prepare("SELECT slug FROM destinations").all()) this.enqueue("rebuild_topics", row.slug);
      return inventory.rows.length;
    });
  }

  failSearchConsoleSync(propertyUrl, error) {
    this.failIntegrationSync(searchConsoleSyncKey(propertyUrl), error);
  }

  listSearchConsoleInventory(propertyUrl = null, limit = 500) {
    if (propertyUrl) return this.db.prepare("SELECT * FROM search_console_inventory WHERE property_url=? ORDER BY impressions DESC LIMIT ?").all(propertyUrl, limit);
    return this.db.prepare("SELECT * FROM search_console_inventory ORDER BY impressions DESC LIMIT ?").all(limit);
  }

  getSearchConsoleSyncState(propertyUrl) {
    if (!propertyUrl) return null;
    return this.db.prepare("SELECT * FROM integration_sync_state WHERE sync_key=?").get(searchConsoleSyncKey(propertyUrl)) || null;
  }

  findSearchConsoleCollision(title) {
    const titleTokens = topicTokens(title);
    const minimumImpressions = Math.max(0, this.contentConfig.searchConsoleMinimumImpressions || 10);
    for (const row of this.db.prepare("SELECT * FROM search_console_inventory WHERE impressions>=? ORDER BY impressions DESC").all(minimumImpressions)) {
      const queryTokens = topicTokens(row.query);
      if (normalizeTitle(row.query) === normalizeTitle(title) || tokenOverlap(titleTokens, queryTokens) >= 0.72) return row;
    }
    return null;
  }

  startIntegrationSync(syncKey) {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO integration_sync_state(sync_key, status, last_started_at, updated_at)
      VALUES (?, 'running', ?, ?)
      ON CONFLICT(sync_key) DO UPDATE SET status='running', last_started_at=excluded.last_started_at,
        last_error=NULL, updated_at=excluded.updated_at
    `).run(syncKey, timestamp, timestamp);
  }

  completeIntegrationSync(syncKey, itemCount, timestamp = now()) {
    this.db.prepare(`
      INSERT INTO integration_sync_state(sync_key, status, last_started_at, last_succeeded_at, item_count, updated_at)
      VALUES (?, 'succeeded', ?, ?, ?, ?)
      ON CONFLICT(sync_key) DO UPDATE SET status='succeeded', last_succeeded_at=excluded.last_succeeded_at,
        last_error=NULL, item_count=excluded.item_count, updated_at=excluded.updated_at
    `).run(syncKey, timestamp, timestamp, itemCount, timestamp);
  }

  failIntegrationSync(syncKey, error) {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO integration_sync_state(sync_key, status, last_error, updated_at)
      VALUES (?, 'failed', ?, ?)
      ON CONFLICT(sync_key) DO UPDATE SET status='failed', last_error=excluded.last_error, updated_at=excluded.updated_at
    `).run(syncKey, String(error?.message || error).slice(0, 4_000), timestamp);
  }

  enqueueCommercialForDestination(destinationSlug) {
    const rows = this.db.prepare(`
      SELECT ad.id FROM article_drafts ad JOIN content_briefs cb ON cb.id=ad.brief_id
      WHERE cb.destination_slug=? AND ad.status IN ('ready_for_wordpress','commercial_ready')
    `).all(destinationSlug);
    for (const row of rows) this.enqueue("compose_commercial", row.id);
    return rows.length;
  }

  knowledgeForDestination(destinationSlug) {
    return this.db.prepare(`
      SELECT k.*, kr.status AS resolution_status, kr.preferred_value AS resolved_value, kr.note AS resolution_note,
        kr.resolved_at AS resolution_resolved_at
      FROM knowledge_facts k JOIN destinations d ON d.id=k.destination_id
      LEFT JOIN knowledge_resolutions kr ON kr.destination_slug=d.slug AND kr.normalized_key=k.normalized_key
      WHERE d.slug=? ORDER BY k.consensus_status='conflicted' DESC, k.support_count DESC, k.normalized_key
    `).all(destinationSlug).map((row) => ({
      normalized_key: row.normalized_key, subject: row.subject, predicate: row.predicate,
      entity_key: row.entity_key || null,
      canonical_subject: row.canonical_subject || row.subject,
      entity_aliases: json(row.entity_aliases_json, []),
      entity_resolution_status: row.entity_resolution_status || "unresolved",
      entity_type: row.entity_type || "other", granularity: row.granularity || "general_topic",
      entity_location: json(row.entity_location_json, {}), claim_relations: json(row.claim_relations_json, []),
      consensus_status: resolvedConsensusStatus(row), preferred_value: resolvedPreferredValue(row),
      support_count: row.support_count, contradiction_count: row.contradiction_count,
      evidence: json(row.evidence_json, []),
      freshness_state: row.freshness_state,
      latest_evidence_at: row.latest_evidence_at,
      verification_priority: resolvedVerificationPriority(row),
      manual_resolution: hydrateKnowledgeResolution(row),
    }));
  }

  authorizedSourceAssetsForBrief(brief) {
    const claimKeys = json(brief.evidence_ledger_json, []);
    const supportingFacts = this.knowledgeForDestination(brief.destination_slug)
      .filter((fact) => !claimKeys.length || claimKeys.includes(fact.normalized_key));
    const sourceIds = [...new Set(supportingFacts
      .flatMap((fact) => fact.evidence || [])
      .map((evidence) => evidence.source_id)
      .filter(Boolean))];
    if (!sourceIds.length) return [];
    const placeholders = sourceIds.map(() => "?").join(",");
    return this.db.prepare(`
      SELECT sa.id, sa.source_id, sa.remote_url, sa.alt_text, sa.position, s.title AS source_title
      FROM source_assets sa JOIN sources s ON s.id=sa.source_id
      WHERE sa.kind='image' AND s.adapter='xiaohongshu' AND sa.source_id IN (${placeholders})
      ORDER BY s.captured_at DESC, sa.position ASC
      LIMIT 12
    `).all(...sourceIds);
  }

  retrySource(sourceId) {
    const source = this.db.prepare("SELECT id FROM sources WHERE id = ?").get(sourceId);
    if (!source) return false;
    const timestamp = now();
    const active = this.db.prepare(`
      SELECT id, status FROM jobs
      WHERE type='extract_source' AND entity_id=? AND status IN ('queued','running')
      ORDER BY created_at DESC LIMIT 1
    `).get(sourceId);
    if (active?.status === "running") {
      this.db.prepare("UPDATE sources SET status='processing', last_error=NULL, updated_at=? WHERE id=?")
        .run(timestamp, sourceId);
      return true;
    }
    transaction(this.db, () => {
      this.db.prepare("UPDATE sources SET status='queued', last_error=NULL, updated_at=? WHERE id=?")
        .run(timestamp, sourceId);
      if (active?.status === "queued") {
        this.db.prepare(`UPDATE jobs SET attempts=0, available_at=?, locked_at=NULL, last_error=NULL,
          started_at=NULL, completed_at=NULL, queue_latency_ms=NULL, duration_ms=NULL, updated_at=? WHERE id=?`)
          .run(timestamp, timestamp, active.id);
      } else this.enqueue("extract_source", sourceId);
    });
    return true;
  }

  listOperationalExceptions() {
    const items = [];
    for (const row of this.db.prepare("SELECT id, title, status, last_error, updated_at FROM sources WHERE status='exception'").all()) {
      items.push(exceptionItem("source", row.id, "blocker", "Source extraction failed", row.title || row.id, row.last_error, true, row.updated_at));
    }
    for (const row of this.db.prepare(`
      SELECT id, type, entity_id, last_error, updated_at FROM jobs
      WHERE status='failed' AND type NOT IN (
        'extract_source','sync_wordpress_inventory','sync_search_console','push_wordpress_draft','generate_draft','review_draft','revise_draft'
      )
      AND NOT EXISTS (
        SELECT 1 FROM jobs recovered
        WHERE recovered.type=jobs.type AND recovered.entity_id=jobs.entity_id
          AND recovered.status='succeeded' AND recovered.updated_at>=jobs.updated_at
      )
    `).all()) {
      items.push(exceptionItem("job", row.id, "blocker", `Job failed: ${row.type}`, row.entity_id, row.last_error, true, row.updated_at));
    }
    for (const row of this.db.prepare(`
      SELECT k.*, d.slug AS destination_slug, kr.status AS resolution_status, kr.preferred_value AS resolved_value,
        kr.note AS resolution_note, kr.resolved_at AS resolution_resolved_at
      FROM knowledge_facts k JOIN destinations d ON d.id=k.destination_id
      LEFT JOIN knowledge_resolutions kr ON kr.destination_slug=d.slug AND kr.normalized_key=k.normalized_key
      WHERE (k.consensus_status='conflicted' AND COALESCE(kr.status, '') <> 'resolved' AND NOT EXISTS (
        SELECT 1 FROM claim_review_cases crc JOIN claims ca ON ca.id=crc.claim_a_id
        WHERE crc.destination_slug=d.slug AND crc.status='pending' AND ca.normalized_key=k.normalized_key
      )) OR k.freshness_state='stale'
    `).all()) {
      const stale = row.freshness_state === "stale";
      const item = exceptionItem("knowledge", row.id, stale ? "blocker" : "warning",
        stale ? "Knowledge fact is stale" : "Knowledge conflict needs judgment",
        `${row.subject} · ${row.predicate}`, stale ? `Latest evidence: ${row.latest_evidence_at || "unknown"}` : row.preferred_value,
        false, row.updated_at);
      if (!stale) item.knowledge = {
        id: row.id,
        destinationSlug: row.destination_slug,
        normalizedKey: row.normalized_key,
        preferredValue: row.preferred_value,
        evidence: json(row.evidence_json, []),
      };
      items.push(item);
    }
    for (const row of this.db.prepare(`SELECT r.*, a.source_id AS source_id_a, a.subject AS subject_a, a.predicate AS predicate_a,
      a.value_text AS value_a, a.source_quote AS source_quote_a, a.structured_value_json AS structured_a,
      b.subject AS subject_b, b.predicate AS predicate_b, b.value_text AS value_b,
      b.source_quote AS source_quote_b, b.structured_value_json AS structured_b
      FROM claim_review_cases r JOIN claims a ON a.id=r.claim_a_id
      LEFT JOIN claims b ON b.id=r.claim_b_id WHERE r.status='pending' ORDER BY r.updated_at DESC`).all()) {
      const kind = ({ CLAIM_CONFLICT: "claim_conflict", SOURCE_CONFLICT: "source_conflict", TEMPORAL_CONFLICT: "temporal_conflict",
        GRANULARITY_CONFLICT: "granularity_conflict", NEGATION_EXTRACTION_ERROR: "extraction_error",
        QUALIFIER_EXTRACTION_ERROR: "extraction_error" })[row.review_type] || "claim_conflict";
      const title = row.review_type.includes("EXTRACTION_ERROR") ? "Claim extraction needs correction" : `${row.review_type.replaceAll("_", " ").toLowerCase()} needs judgment`;
      const item = exceptionItem(kind, row.id, "warning", title, `${row.subject_a} · ${row.predicate_a}`, row.reason, false, row.updated_at);
      item.claim_review = {
        id: row.id, reviewType: row.review_type, destinationSlug: row.destination_slug,
        claimA: { id: row.claim_a_id, sourceId: row.source_id_a, originalSentence: row.source_quote_a, normalized: { subject: row.subject_a, predicate: row.predicate_a, value: row.value_a, structured: json(row.structured_a, {}) } },
        claimB: row.claim_b_id ? { id: row.claim_b_id, originalSentence: row.source_quote_b, normalized: { subject: row.subject_b, predicate: row.predicate_b, value: row.value_b, structured: json(row.structured_b, {}) } } : null,
      };
      items.push(item);
    }
    for (const row of this.listEntityMergeCandidates("pending")) {
      const item = exceptionItem("entity_identity", row.id, "warning", "Entity identity needs confirmation",
        `${row.alias} → ${row.proposed_canonical_subject}`,
        row.rationale || "The model found a possible multilingual reference to the same destination entity.",
        false, row.updated_at);
      item.entity_alias = {
        id: row.id, destinationSlug: row.destination_slug, alias: row.alias,
        proposedEntityKey: row.proposed_entity_key, proposedCanonicalSubject: row.proposed_canonical_subject,
        candidateEntityKey: row.candidate_entity_key, candidateEntityType: row.candidate_entity_type,
        candidateGranularity: row.candidate_granularity, proposedEntityType: row.proposed_entity_type,
        proposedGranularity: row.proposed_granularity, location: row.location,
        confidence: row.confidence, aiRecommendation: row.ai_recommendation,
        reason: row.rationale, suggestedRelation: row.suggested_relation || row.assessment?.suggestedRelation,
        linkedClaims: this.db.prepare(`SELECT c.id, c.subject, c.predicate, c.value_text, c.source_quote,
          s.title AS source_title FROM claims c JOIN structured_sources ss ON ss.source_id=c.source_id
          JOIN sources s ON s.id=c.source_id WHERE ss.destination_slug=? AND (
            lower(trim(c.subject))=lower(trim(?)) OR c.entity_key=?
          ) ORDER BY s.captured_at DESC LIMIT 20`).all(row.destination_slug, row.alias, row.proposed_entity_key),
      };
      items.push(item);
    }
    for (const row of this.db.prepare("SELECT sync_key, last_error, updated_at FROM integration_sync_state WHERE status='failed'").all()) {
      items.push(exceptionItem("sync", row.sync_key, "blocker", "Integration sync failed", row.sync_key, row.last_error, true, row.updated_at));
    }
    for (const row of this.db.prepare("SELECT task_key, last_error, updated_at FROM maintenance_runs WHERE status='failed'").all()) {
      items.push(exceptionItem("maintenance", row.task_key, "blocker", "Automatic maintenance failed", row.task_key, row.last_error, false, row.updated_at));
    }
    for (const row of this.db.prepare("SELECT id, candidate_id, topic, last_error, updated_at FROM content_briefs WHERE status='exception'").all()) {
      items.push({ ...exceptionItem("brief", row.id, "blocker", "Draft generation failed", row.topic, row.last_error, true, row.updated_at), candidateId: row.candidate_id });
    }
    for (const row of this.db.prepare(`
      SELECT ad.id, ad.title, ad.status, ad.updated_at, cb.candidate_id
      FROM article_drafts ad JOIN content_briefs cb ON cb.id=ad.brief_id
      WHERE ad.status='exception' OR (ad.status='qa_failed' AND ad.revision>=2)
    `).all()) {
      items.push({ ...exceptionItem("draft", row.id, "blocker", "Draft needs editorial intervention", row.title, row.status, true, row.updated_at), candidateId: row.candidate_id });
    }
    for (const row of this.db.prepare(`
      SELECT wp.draft_id, wp.last_error, wp.updated_at, ad.title, cb.candidate_id
      FROM wordpress_publications wp JOIN article_drafts ad ON ad.id=wp.draft_id
      JOIN content_briefs cb ON cb.id=ad.brief_id WHERE wp.status='failed'
    `).all()) {
      items.push({ ...exceptionItem("wordpress", row.draft_id, "blocker", "WordPress draft sync failed", row.title, row.last_error, true, row.updated_at), candidateId: row.candidate_id });
    }
    const severityRank = { blocker: 0, warning: 1 };
    return items.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]
      || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  retryOperationalException(exceptionKey) {
    const separator = exceptionKey.indexOf(":");
    const kind = exceptionKey.slice(0, separator);
    const entityId = exceptionKey.slice(separator + 1);
    if (!kind || !entityId) return false;
    if (kind === "source") return this.retrySource(entityId);
    if (kind === "job") {
      const result = this.db.prepare(`
        UPDATE jobs SET status='queued', attempts=0, available_at=?, locked_at=NULL, last_error=NULL, updated_at=?
        WHERE id=? AND status='failed'
      `).run(now(), now(), entityId);
      return result.changes > 0;
    }
    if (kind === "sync" && entityId.startsWith("wordpress_inventory:")) {
      const siteUrl = entityId.slice("wordpress_inventory:".length);
      return Boolean(this.enqueueWordPressInventorySync(siteUrl, 1, true));
    }
    if (kind === "sync" && entityId.startsWith("search_console:")) {
      const propertyUrl = entityId.slice("search_console:".length);
      return Boolean(this.enqueueSearchConsoleSync(propertyUrl, 1, true));
    }
    if (kind === "brief") {
      const row = this.db.prepare("SELECT candidate_id FROM content_briefs WHERE id=?").get(entityId);
      return Boolean(row && this.retryContent(row.candidate_id));
    }
    if (["draft", "wordpress"].includes(kind)) {
      const row = this.db.prepare(`
        SELECT cb.candidate_id FROM article_drafts ad JOIN content_briefs cb ON cb.id=ad.brief_id WHERE ad.id=?
      `).get(entityId);
      return Boolean(row && this.retryContent(row.candidate_id));
    }
    return false;
  }

  resolveKnowledgeConflict(factId, preferredValue, note = "") {
    const fact = this.db.prepare(`
      SELECT k.id, k.normalized_key, k.consensus_status, d.slug AS destination_slug
      FROM knowledge_facts k JOIN destinations d ON d.id=k.destination_id WHERE k.id=?
    `).get(factId);
    if (!fact || fact.consensus_status !== "conflicted") return null;
    const value = String(preferredValue || "").trim().slice(0, 2_000);
    if (!value) throw new Error("A confirmed knowledge value is required to resolve a conflict.");
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO knowledge_resolutions(id, destination_slug, normalized_key, status, preferred_value, note, resolved_at, created_at, updated_at)
      VALUES (?, ?, ?, 'resolved', ?, ?, ?, ?, ?)
      ON CONFLICT(destination_slug, normalized_key) DO UPDATE SET status='resolved', preferred_value=excluded.preferred_value,
        note=excluded.note, resolved_at=excluded.resolved_at, updated_at=excluded.updated_at
    `).run(`resolution_${sha256(`${fact.destination_slug}:${fact.normalized_key}`).slice(0, 24)}`,
      fact.destination_slug, fact.normalized_key, value, String(note || "").trim().slice(0, 1_000), timestamp, timestamp, timestamp);
    this.rebuildTopicCandidates(fact.destination_slug);
    return { factId, destinationSlug: fact.destination_slug, normalizedKey: fact.normalized_key, preferredValue: value };
  }

  decideClaimReviewCase(caseId, decision, note = "") {
    if (!["resolved", "dismissed"].includes(decision)) throw new Error("Claim review decision must be resolved or dismissed.");
    const row = this.db.prepare("SELECT * FROM claim_review_cases WHERE id=? AND status='pending'").get(caseId);
    if (!row) return null;
    if (decision === "resolved" && row.review_type.includes("EXTRACTION_ERROR")) {
      const error = new Error("An extraction review can only be resolved by re-extracting the source; dismiss it only when the complete Claim already preserves the source meaning.");
      error.statusCode = 409;
      throw error;
    }
    const timestamp = now();
    this.db.prepare("UPDATE claim_review_cases SET status=?, reason=?, updated_at=? WHERE id=?")
      .run(decision, `${row.reason}${note ? ` Operator note: ${String(note).slice(0, 1_000)}` : ""}`, timestamp, caseId);
    return { id: caseId, status: decision, destinationSlug: row.destination_slug };
  }

  getKnowledge() {
    return this.db.prepare(`
      SELECT k.*, d.slug AS destination_slug, d.name AS destination_name,
        kr.status AS resolution_status, kr.preferred_value AS resolved_value, kr.note AS resolution_note,
        kr.resolved_at AS resolution_resolved_at
      FROM knowledge_facts k JOIN destinations d ON d.id = k.destination_id
      LEFT JOIN knowledge_resolutions kr ON kr.destination_slug=d.slug AND kr.normalized_key=k.normalized_key
      ORDER BY d.name, k.normalized_key
    `).all().map((row) => ({
      ...row,
      raw_consensus_status: row.consensus_status,
      consensus_status: resolvedConsensusStatus(row),
      preferred_value: resolvedPreferredValue(row),
      evidence: json(row.evidence_json, []),
      entity_aliases: json(row.entity_aliases_json, []),
      canonical_subject: row.canonical_subject || row.subject,
      entity_resolution_status: row.entity_resolution_status || "unresolved",
      entity_location: json(row.entity_location_json, {}),
      claim_relations: json(row.claim_relations_json, []),
      manual_resolution: hydrateKnowledgeResolution(row),
      verification_priority: resolvedVerificationPriority(row),
    }));
  }

  getEditorialBlueprints() {
    return this.db.prepare("SELECT * FROM editorial_blueprints ORDER BY sample_count DESC, updated_at DESC").all()
      .map((row) => ({
        ...row,
        section_patterns: json(row.section_patterns_json, []),
        strengths: json(row.strengths_json, []),
        gaps: json(row.gaps_json, []),
        source_ids: json(row.source_ids_json, []),
      }));
  }

  dashboard() {
    const statuses = this.db.prepare("SELECT status, COUNT(*) AS count FROM sources GROUP BY status").all();
    const operationalExceptions = this.listOperationalExceptions();
    const exceptionCount = (kind) => operationalExceptions.filter((item) => item.kind === kind).length;
    return {
      sources: Object.fromEntries(statuses.map((row) => [row.status, row.count])),
      actionCounts: {
        sources: exceptionCount("source"),
        recommendations: this.db.prepare("SELECT COUNT(*) AS count FROM content_recommendations WHERE decision='pending'").get().count,
        knowledge: 0,
        blueprints: 0,
        content: 0,
        wordpress: exceptionCount("wordpress") + operationalExceptions.filter((item) => item.kind === "sync" && String(item.subject || "").startsWith("wordpress_inventory:")).length,
        commercial: this.db.prepare("SELECT COUNT(*) AS count FROM affiliate_opportunities WHERE status='open'").get().count,
        exceptions: operationalExceptions.length,
        maintenance: exceptionCount("maintenance") + exceptionCount("sync"),
        settings: 0,
      },
      totals: {
        sources: this.db.prepare("SELECT COUNT(*) AS count FROM sources").get().count,
        claims: this.db.prepare("SELECT COUNT(*) AS count FROM claims").get().count,
        knowledgeFacts: this.db.prepare("SELECT COUNT(*) AS count FROM knowledge_facts").get().count,
        conflicts: this.db.prepare(`
          SELECT COUNT(*) AS count FROM knowledge_facts k
          JOIN destinations d ON d.id=k.destination_id
          LEFT JOIN knowledge_resolutions kr ON kr.destination_slug=d.slug AND kr.normalized_key=k.normalized_key
          WHERE k.consensus_status='conflicted' AND COALESCE(kr.status, '') <> 'resolved'
        `).get().count,
        exceptions: operationalExceptions.length,
        topicCandidates: this.db.prepare("SELECT COUNT(*) AS count FROM topic_candidates").get().count,
        draftsReady: this.db.prepare("SELECT COUNT(*) AS count FROM article_drafts WHERE status IN ('ready_for_wordpress','commercial_ready','wordpress_draft')").get().count,
        activeOffers: this.db.prepare("SELECT COUNT(*) AS count FROM affiliate_assets WHERE active=1").get().count,
        wordpressInventory: this.db.prepare("SELECT COUNT(*) AS count FROM wordpress_content_inventory").get().count,
        searchQueries: this.db.prepare("SELECT COUNT(*) AS count FROM search_console_inventory").get().count,
      },
      jobs: this.db.prepare("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status").all(),
    };
  }
}

function hydrateReview(row) {
  return {
    ...row,
    passed: Boolean(row.passed),
    checks: json(row.checks_json, []),
    issues: json(row.issues_json, []),
    unsupported_claims: json(row.unsupported_claims_json, []),
  };
}

function hydrateSource({ source, assets, files = [], structured, claims, extractionRuns = [], claimHistory = [], blueprint, analysis = null, recommendation = null }) {
  if (structured) {
    structured.traveler_fit = json(structured.traveler_fit_json, []);
    structured.practical_tips = json(structured.practical_tips_json, []);
    structured.warnings = json(structured.warnings_json, []);
  }
  for (const claim of claims) {
    claim.qualifiers = json(claim.qualifiers_json, []);
    claim.entity_aliases = json(claim.entity_aliases_json, []);
    claim.entity_location = json(claim.entity_location_json, {});
    claim.structured_value = json(claim.structured_value_json, {});
    claim.scope = json(claim.scope_json, {});
    claim.canonical_subject ||= claim.subject;
    claim.entity_resolution_status ||= "unresolved";
  }
  if (blueprint) {
    blueprint.sections = json(blueprint.sections_json, []);
    blueprint.strengths = json(blueprint.strengths_json, []);
    blueprint.gaps = json(blueprint.gaps_json, []);
  }
  source.submission_metadata = json(source.submission_metadata_json, {});
  delete source.raw_payload_json;
  delete source.submission_metadata_json;
  return {
    ...source, assets, files, structured, claims, extraction_runs: extractionRuns,
    claim_history: claimHistory.map((row) => ({ ...row, snapshot: json(row.snapshot_json, {}) })), blueprint,
    analysis: analysis ? { ...analysis, data: json(analysis.analysis_json, {}) } : null,
    recommendation: recommendation ? hydrateRecommendation(recommendation) : null,
  };
}

function draftMetadata(draft, brief, config, authorizedSourceAssets = []) {
  const canonical = json(brief.canonical_json, {});
  const canonicalUrl = config.publicSiteUrl && draft.slug ? `${config.publicSiteUrl}/${draft.slug}/` : null;
  const seo = {
    primary_keyword: truncateText(draft.seo?.primary_keyword || draft.seo?.focus_keyword || canonical.seo?.primary_keyword || brief.topic || draft.title, 160),
    secondary_keywords: (draft.seo?.secondary_keywords || canonical.secondary_queries || []).slice(0, 8).map((item) => truncateText(item, 160)),
    search_intent: truncateText(draft.seo?.search_intent || canonical.content_intent || brief.search_intent || "informational", 120),
    seo_title: truncateText(draft.seo?.seo_title || draft.seo?.meta_title || draft.title, 60),
    meta_title: truncateText(draft.seo?.seo_title || draft.seo?.meta_title || draft.title, 60),
    focus_keyword: truncateText(draft.seo?.primary_keyword || draft.seo?.focus_keyword || brief.topic || draft.title, 160),
    meta_description: truncateText(draft.meta_description, 160),
    slug: draft.slug,
    canonical_url: canonicalUrl,
    robots: "index,follow",
    og_title: truncateText(draft.seo?.og_title || draft.seo?.seo_title || draft.seo?.meta_title || draft.title, 60),
    og_description: truncateText(draft.seo?.og_description || draft.meta_description, 160),
    og_image: null,
    key_takeaways: (draft.seo?.key_takeaways || []).slice(0, 6).map((item) => truncateText(item, 240)),
    faqs: (draft.faqs || []).slice(0, 5).map((item) => ({ question: truncateText(item.question, 220), answer: truncateText(item.answer, 700) })),
  };
  const visuals = normalizeVisuals(draft.visuals, draft, brief, authorizedSourceAssets);
  const firstGenerated = visuals.find((visual) => visual.status === "generated" && visual.media_url);
  if (firstGenerated) seo.og_image = firstGenerated.media_url;
  const blocks = markdownToContentBlocks(draft.body_markdown);
  return {
    seo, visuals, blocks,
    schema: buildArticleSchema({ ...draft, seo, destination_slug: brief.destination_slug, canonical }, visuals, config),
  };
}

function normalizeVisuals(values, draft, brief, authorizedSourceAssets = []) {
  const target = visualCountForWords(wordCount(draft.body_markdown));
  const allowedPlacements = ["hero", "after_intro", "mid_article", "before_faq", "closing"];
  const allowedRatios = ["16:9", "4:3", "1:1", "3:2", "9:16"];
  const supplied = Array.isArray(values) ? values : [];
  const visuals = supplied.slice(0, target).map((item, index) => normalizeVisual(item, index, draft, brief, allowedPlacements, allowedRatios));
  while (visuals.length < target) {
    const index = visuals.length;
    visuals.push(normalizeVisual({}, index, draft, brief, allowedPlacements, allowedRatios));
  }
  if (!authorizedSourceAssets.length) return visuals;

  // The source owner has confirmed the rights for every explicitly saved
  // Xiaohongshu image. Turn the first slot into a factual source-photo slot
  // when the model did not plan one, then map every real-photo slot to a
  // distinct evidence-linked source asset.
  if (!visuals.some((visual) => visual.image_type === "real_world_photo")) {
    visuals[0] = normalizeVisual({
      ...visuals[0], image_type: "real_world_photo", factual_image_required: true,
    }, 0, draft, brief, allowedPlacements, allowedRatios);
  }
  let assetIndex = 0;
  return visuals.map((visual) => {
    if (visual.image_type !== "real_world_photo") return visual;
    const asset = authorizedSourceAssets[assetIndex % authorizedSourceAssets.length];
    assetIndex += 1;
    return {
      ...visual,
      purpose: truncateText(visual.purpose || `Evidence-linked view for ${draft.title}`, 300),
      alt_text: truncateText(visual.alt_text || `${brief.destination_slug} travel scene`, 220),
      caption: truncateText(`Authorized source photo from the saved research note: ${asset.source_title || "Xiaohongshu"}`, 300),
      generation_prompt: "",
      acquisition_strategy: "use_authorized_source_image",
      factual_image_required: true,
      source_asset_id: asset.id,
      source_remote_url: asset.remote_url,
      status: "generated",
      media_url: asset.remote_url,
      provider: "authorized_xiaohongshu_source",
      model: "user-authorized-source-image",
    };
  });
}

function normalizeVisual(item, index, draft, brief, allowedPlacements, allowedRatios) {
  const allowedTypes = ["real_world_photo", "infographic", "map_or_route", "illustration"];
  const imageType = allowedTypes.includes(item?.image_type) ? item.image_type : "illustration";
  const strategy = imageType === "real_world_photo" ? "search_real_image"
    : imageType === "infographic" ? "render_infographic"
      : imageType === "map_or_route" ? "render_map" : "generate_illustration";
  const factualRequired = imageType === "real_world_photo" || Boolean(item?.factual_image_required);
  return {
    placement: allowedPlacements.includes(item?.placement) ? item.placement : defaultPlacement(index),
    purpose: truncateText(item?.purpose || `Orient readers to ${draft.title}`, 300),
    alt_text: truncateText(item?.alt_text || `${draft.title} editorial illustration`, 220),
    caption: truncateText(item?.caption || "Original editorial illustration", 300),
    generation_prompt: strategy === "generate_illustration"
      ? truncateText(item?.generation_prompt || defaultVisualPrompt(draft.title, brief.destination_slug, index), 2_000) : "",
    aspect_ratio: allowedRatios.includes(item?.aspect_ratio) ? item.aspect_ratio : index === 0 ? "16:9" : "3:2",
    image_type: imageType,
    image_role: truncateText(item?.image_role || (index === 0 ? "hero" : "support"), 80),
    image_subject: truncateText(item?.image_subject || draft.title, 240),
    acquisition_strategy: strategy,
    factual_image_required: factualRequired,
  };
}

function buildArticleSchema(draft, visuals, config) {
  const canonicalUrl = config.publicSiteUrl && draft.slug ? `${config.publicSiteUrl}/${draft.slug}/` : null;
  const generatedImages = visuals.filter((item) => item.status === "generated" && item.media_url).map((item) => item.media_url);
  const organizationId = config.publicSiteUrl ? `${config.publicSiteUrl}#organization` : undefined;
  const organization = { "@type": "Organization", name: config.publisherName || "SoloToChina" };
  if (organizationId) organization["@id"] = organizationId;
  if (config.publisherLogoUrl) organization.logo = { "@type": "ImageObject", url: config.publisherLogoUrl };
  const article = {
    "@type": "Article",
    headline: draft.title,
    description: draft.meta_description,
    inLanguage: "en",
    author: organizationId ? { "@id": organizationId } : organization,
    publisher: organizationId ? { "@id": organizationId } : organization,
    keywords: draft.seo?.primary_keyword || draft.seo?.focus_keyword || "",
    about: draft.destination_slug || "China travel",
  };
  const graph = [organization];
  if (canonicalUrl) {
    graph.push({ "@type": "WebPage", "@id": canonicalUrl, name: draft.title, description: draft.meta_description, inLanguage: "en" });
    graph.push({
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "China travel", item: config.publicSiteUrl },
        { "@type": "ListItem", position: 2, name: draft.canonical?.destination?.name || draft.destination_slug || "Travel guide", item: canonicalUrl },
      ],
    });
    article.mainEntityOfPage = { "@type": "WebPage", "@id": canonicalUrl };
  }
  if (generatedImages.length) article.image = generatedImages;
  graph.push(article);
  for (const image of generatedImages) graph.push({ "@type": "ImageObject", contentUrl: image });
  const faqs = draft.seo?.faqs || [];
  if (faqs.length) graph.push({
    "@type": "FAQPage",
    mainEntity: faqs.map((item) => ({ "@type": "Question", name: item.question, acceptedAnswer: { "@type": "Answer", text: item.answer } })),
  });
  return { "@context": "https://schema.org", "@graph": graph };
}

function canonicalFromPlan(plan, candidate, config) {
  const supplied = plan.canonical || {};
  const contentTypes = new Set([
    "city_guide", "itinerary", "attraction_guide", "food_guide", "transport_guide", "neighborhood_guide",
    "hotel_area_guide", "shopping_guide", "practical_guide", "first_time_guide", "comparison", "listicle", "how_to",
  ]);
  const destinationName = config.destinationName || candidate.destination_slug.replace(/-/g, " ");
  const faqs = normalizeFaqs(supplied.faq || supplied.faqs || []);
  return {
    strategy_version: config.contentStrategy?.version || CONTENT_STRATEGY.version,
    content_id: `canonical_${sha256(candidate.id).slice(0, 24)}`,
    content_type: contentTypes.has(supplied.content_type) ? supplied.content_type : "first_time_guide",
    title: truncateText(plan.title || candidate.proposed_title, 180),
    slug: slugify(plan.slug || plan.title || candidate.proposed_title),
    destination: { name: truncateText(supplied.destination?.name || destinationName, 160), slug: candidate.destination_slug },
    entities: cleanStrings(supplied.entities, 20, 160),
    content_intent: truncateText(plan.search_intent || supplied.content_intent || "informational", 120),
    audience: cleanStrings(plan.audience || supplied.audience, 8, 160),
    primary_query: truncateText(plan.primary_keyword || supplied.primary_query || candidate.proposed_title, 160),
    secondary_queries: cleanStrings(supplied.secondary_queries, 8, 160),
    summary: truncateText(supplied.summary || plan.reader_promise || candidate.rationale, 700),
    quick_answer: truncateText(supplied.quick_answer || plan.reader_promise || candidate.rationale, 700),
    highlights: cleanStrings(supplied.highlights, 8, 300),
    places: cleanObjects(supplied.places, 12),
    days: cleanObjects(supplied.days, 8),
    transport: cleanStrings(supplied.transport, 12, 300),
    food: cleanStrings(supplied.food, 12, 300),
    accommodation: cleanStrings(supplied.accommodation, 12, 300),
    practical_tips: cleanStrings(supplied.practical_tips || plan.adaptation_requirements, 12, 300),
    warnings: cleanStrings(supplied.warnings || plan.conflict_instructions, 12, 300),
    faq: faqs,
    answer_blocks: normalizeAnswerBlocks(supplied.answer_blocks, candidate.destination_slug),
    image_plan: normalizeCanonicalImagePlan(supplied.image_plan),
    internal_link_opportunities: [],
    seo: {
      primary_keyword: truncateText(plan.primary_keyword || supplied.seo?.primary_keyword || candidate.proposed_title, 160),
      secondary_keywords: cleanStrings(supplied.seo?.secondary_keywords || supplied.secondary_queries, 8, 160),
      search_intent: truncateText(plan.search_intent || supplied.seo?.search_intent || "informational", 120),
    },
    schema: {},
    quality: { evidence_count: candidate.evidence_count, conflict_count: candidate.conflict_count, readiness_score: candidate.coverage_score },
    last_verified: null,
  };
}

function normalizeIntakeAnalysis(value, strategyVersion) {
  const classifications = new Set(["ARTICLE_CANDIDATE", "KNOWLEDGE_ONLY", "CLAIM_ONLY", "CLUSTER_CANDIDATE", "RESEARCH_REQUIRED", "DUPLICATE", "LOW_VALUE", "UNSURE"]);
  const classification = classifications.has(value?.classification) ? value.classification : "UNSURE";
  const fallbackAction = {
    ARTICLE_CANDIDATE: "CREATE_CONTENT_PLAN", KNOWLEDGE_ONLY: "ADD_TO_KNOWLEDGE", CLAIM_ONLY: "ADD_TO_KNOWLEDGE",
    CLUSTER_CANDIDATE: "ADD_TO_CLUSTER", RESEARCH_REQUIRED: "RESEARCH_FIRST", DUPLICATE: "MERGE_OR_IGNORE",
    LOW_VALUE: "IGNORE", UNSURE: "HUMAN_REVIEW",
  }[classification];
  return {
    strategy_version: strategyVersion,
    classification,
    confidence: normalizedFraction(value?.confidence),
    primary_topic: truncateText(value?.primary_topic || "Unclassified travel topic", 240),
    entities: cleanStrings(value?.entities, 24, 160),
    knowledge_points: cleanStrings(value?.knowledge_points, 20, 320),
    claims: cleanStrings(value?.claims, 20, 240),
    article_potential: normalizedScore(value?.article_potential),
    information_density: normalizedScore(value?.information_density),
    topic_completeness: normalizedScore(value?.topic_completeness),
    duplicate_likelihood: normalizedScore(value?.duplicate_likelihood),
    recommended_action: truncateText(value?.recommended_action || fallbackAction, 80),
    suggested_content_type: truncateText(value?.suggested_content_type || "", 80),
    suggested_article_title: truncateText(value?.suggested_article_title || "", 180),
    missing_information: cleanStrings(value?.missing_information, 16, 240),
    possible_cluster_topics: cleanStrings(value?.possible_cluster_topics, 10, 180),
    reasoning_summary: truncateText(value?.reasoning_summary || "Review the evidence before deciding the next content action.", 700),
  };
}

function hydrateRecommendation(row) {
  const analysis = row.analysis_json ? json(row.analysis_json, {}) : null;
  return { ...row, analysis, missing_information: analysis?.missing_information || [], possible_cluster_topics: analysis?.possible_cluster_topics || [] };
}

function classificationOpportunityStatus(classification) {
  if (classification === "RESEARCH_REQUIRED") return "research_required";
  if (classification === "KNOWLEDGE_ONLY" || classification === "CLAIM_ONLY") return "knowledge_only";
  if (classification === "CLUSTER_CANDIDATE") return "cluster";
  if (["LOW_VALUE", "DUPLICATE"].includes(classification)) return "ignored";
  return "recommended";
}

function opportunityCoverage(destinationSlug, facts, analysis) {
  const values = Array.isArray(facts) ? facts : [];
  const coverage = {
    core_answer: Boolean(analysis.primary_topic && values.length),
    transport: values.some((fact) => /transport|metro|train|bus|station|airport|route/i.test(`${fact.normalized_key} ${fact.subject} ${fact.predicate}`)),
    cost: values.some((fact) => /price|cost|fee|budget|ticket/i.test(`${fact.normalized_key} ${fact.subject} ${fact.predicate}`)),
    practical_tips: (analysis.knowledge_points || []).length > 0,
    faq: (analysis.possible_cluster_topics || []).length > 0 || analysis.article_potential >= 60,
    destination: destinationSlug,
  };
  const complete = Object.values(coverage).filter((value) => value === true).length;
  return { readiness: Math.round(Math.min(100, analysis.article_potential * 0.55 + analysis.topic_completeness * 0.35 + complete * 2)), coverage };
}

function normalizeFaqs(values) {
  return (Array.isArray(values) ? values : []).slice(0, 5).map((item) => ({
    question: truncateText(item?.question || "", 220), answer: truncateText(item?.answer || "", 700),
  })).filter((item) => item.question && item.answer);
}

function normalizeAnswerBlocks(values, destinationSlug) {
  return (Array.isArray(values) ? values : []).slice(0, 6).map((item) => ({
    question: truncateText(item?.question || "", 220), direct_answer: truncateText(item?.direct_answer || "", 700),
    supporting_points: cleanStrings(item?.supporting_points, 6, 240), entity: truncateText(item?.entity || destinationSlug, 160), last_verified: null,
  })).filter((item) => item.question && item.direct_answer);
}

function normalizeCanonicalImagePlan(values) {
  return (Array.isArray(values) ? values : []).slice(0, 5).map((item) => ({
    type: ["real_world_photo", "infographic", "map_or_route", "illustration"].includes(item?.type) ? item.type : "illustration",
    role: truncateText(item?.role || "support", 80), subject: truncateText(item?.subject || "", 240),
    placement: truncateText(item?.placement || "mid_article", 80),
    strategy: truncateText(item?.strategy || "generate_illustration", 80), factual_image_required: Boolean(item?.factual_image_required),
  }));
}

function cleanStrings(values, maxItems, maxLength) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => truncateText(value, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function cleanObjects(values, maxItems) {
  return (Array.isArray(values) ? values : []).slice(0, maxItems).filter((item) => item && typeof item === "object");
}

function normalizedScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, number <= 1 ? number * 100 : number));
}

function normalizedFraction(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number > 1 ? number / 100 : number));
}

function defaultPlacement(index) {
  return ["hero", "after_intro", "mid_article", "before_faq", "closing"][index] || "mid_article";
}

function defaultVisualPrompt(title, destination, index) {
  return `Original editorial illustration for \"${title}\" in ${destination || "China"}, scene ${index + 1}; calm editorial travel artwork, simplified authentic atmosphere, no realistic documentary claim, no readable text, no logos, no watermark, no copied social-media imagery.`;
}

function visualCountForWords(words) {
  if (words < 1300) return 2;
  if (words < 2200) return 3;
  if (words < 3200) return 4;
  return 5;
}

function wordCount(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

function truncateText(value, max) {
  const text = String(value || "");
  return text.length <= max ? text : text.slice(0, max);
}

function normalizeValue(value) {
  return String(value).trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeClaimRole(value, subject = "", predicate = "") {
  const roles = new Set(["fact", "recommendation", "personal_experience", "promotional_observation", "editorial_metadata"]);
  const supplied = String(value || "").trim().toLowerCase();
  if (roles.has(supplied)) return supplied;
  const normalizedSubject = normalizeValue(subject);
  const normalizedPredicate = normalizeValue(predicate);
  if (["recommendations", "recommendation", "guide", "source author"].includes(normalizedSubject)
    || /\b(?:editorial|disclaimer|stated as)\b/u.test(normalizedPredicate)) return "editorial_metadata";
  if (["author's trip", "author trip", "the author"].includes(normalizedSubject)
    || /\b(?:personal experience|author experience)\b/u.test(normalizedPredicate)) return "personal_experience";
  if (/\b(?:recommend|recommended|best time|worth visiting|suitable for)\b/u.test(normalizedPredicate)) return "recommendation";
  return "fact";
}

function normalizeClaimKey(value) {
  return String(value || "").toLowerCase().trim().replace(/[^a-z0-9._]+/g, ".").replace(/\.{2,}/g, ".").replace(/^\.|\.$/g, "").slice(0, 300);
}

function normalizeEntityKey(value) {
  const key = normalizeClaimKey(value);
  return key && key.split(".").length >= 2 ? key : "";
}

function cleanEntityName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function normalizeEntityAlias(value) {
  return cleanEntityName(value).normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[\s\p{P}\p{S}_]+/gu, "").slice(0, 300);
}

function uniqueEntityAliases(values) {
  return [...new Map((values || []).map(cleanEntityName).filter(Boolean).map((item) => [normalizeEntityAlias(item), item])).values()].slice(0, 24);
}

function inferEntityIdentity(key, subject, predicate) {
  const normalizedKey = normalizeClaimKey(key);
  const segments = normalizedKey.split(".").filter(Boolean);
  const category = new Set(["attraction", "place", "venue", "restaurant", "museum", "road", "street", "hotel", "neighborhood", "station", "market", "park", "temple", "district", "route"]);
  let entityKey = "";
  if (segments.length >= 3 && category.has(segments[0])) entityKey = segments.slice(0, -1).join(".");
  if (!entityKey && /^[\x00-\x7F]+$/.test(cleanEntityName(subject))) {
    const subjectKey = normalizeClaimKey(cleanEntityName(subject));
    if (subjectKey) entityKey = `subject.${subjectKey}`;
  }
  const canonicalSubject = cleanEntityName(subject);
  return {
    entityKey,
    canonicalSubject,
    aliases: uniqueEntityAliases([subject]),
    status: entityKey ? "derived" : "unresolved",
  };
}

function aggregateEntityIdentity(rows) {
  const keys = rows.map((row) => row.entity_key).filter(Boolean);
  const entityKey = keys.length ? countStrings(keys)[0].value : "";
  const aliases = uniqueEntityAliases(rows.flatMap((row) => [row.subject, row.canonical_subject, ...json(row.entity_aliases_json, [])]));
  const names = rows.map((row) => cleanEntityName(row.canonical_subject || row.subject)).filter(Boolean);
  const preferred = names.sort((left, right) => entityNameScore(right) - entityNameScore(left) || left.length - right.length || left.localeCompare(right))[0] || rows[0]?.subject || "";
  const states = new Set(rows.map((row) => row.entity_resolution_status));
  const entityType = countStrings(rows.map((row) => row.entity_type).filter(Boolean))[0]?.value || "other";
  const granularity = countStrings(rows.map((row) => row.granularity).filter(Boolean))[0]?.value || "general_topic";
  const location = rows.map((row) => json(row.entity_location_json, {})).find((item) => Object.keys(item).length) || {};
  return {
    entityKey,
    canonicalSubject: preferred,
    aliases,
    status: states.has("resolved") ? "resolved" : states.has("derived") ? "derived" : "unresolved",
    entityType,
    granularity,
    location,
  };
}

function entityNameScore(value) {
  const text = String(value || "");
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const han = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  return latin * 4 + (han ? 1 : 0);
}

function classifyFreshness(rows, config) {
  const volatile = rows.some((row) => /price|cost|fee|ticket|opening|hours?|schedule|timetable|policy|rule|visa|payment|booking|reservation|closure|closed|route|metro|train|bus/i
    .test(`${row.normalized_key} ${row.subject} ${row.predicate}`));
  const latestMillis = Math.max(...rows.map((row) => Date.parse(row.captured_at) || 0));
  const latestEvidenceAt = latestMillis ? new Date(latestMillis).toISOString() : null;
  const ageDays = latestMillis ? (Date.now() - latestMillis) / 86_400_000 : Number.POSITIVE_INFINITY;
  const staleAfterDays = volatile ? config.volatileStaleAfterDays : config.staleAfterDays;
  return {
    volatile,
    latestEvidenceAt,
    state: ageDays > staleAfterDays ? "stale" : volatile ? "time_sensitive" : "current",
  };
}

function resolvedConsensusStatus(row) {
  return row.consensus_status === "conflicted" && row.resolution_status === "resolved" ? "resolved" : row.consensus_status;
}

function resolvedPreferredValue(row) {
  return row.consensus_status === "conflicted" && row.resolution_status === "resolved" && row.resolved_value
    ? row.resolved_value : row.preferred_value;
}

function resolvedVerificationPriority(row) {
  return row.consensus_status === "conflicted" && row.resolution_status === "resolved"
    ? "manual_confirmed" : row.verification_priority;
}

function hydrateKnowledgeResolution(row) {
  if (row.resolution_status !== "resolved") return null;
  return {
    status: row.resolution_status,
    preferred_value: row.resolved_value,
    note: row.resolution_note || "",
    resolved_at: row.resolution_resolved_at || null,
  };
}

function exceptionItem(kind, entityId, severity, title, subject, detail, retryable, updatedAt) {
  return {
    key: `${kind}:${entityId}`,
    kind,
    entityId,
    severity,
    title,
    subject,
    detail: detail || "No diagnostic detail was recorded.",
    retryable,
    updatedAt,
  };
}

function wordpressSyncKey(siteUrl) {
  return `wordpress_inventory:${siteUrl}`;
}

function searchConsoleSyncKey(propertyUrl) {
  return `search_console:${propertyUrl}`;
}

function distribution(values) {
  if (!values.length) return { samples: 0, p50: null, p95: null, max: null };
  return {
    samples: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
  };
}

function percentile(values, quantile) {
  if (!values?.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index];
}

function normalizeTitle(value) {
  return String(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function topicTokens(value) {
  const stopWords = new Set(["a", "an", "and", "for", "in", "of", "the", "to", "travel", "guide"]);
  return new Set(normalizeTitle(value).split(" ").filter((token) => token && !stopWords.has(token)));
}

function tokenOverlap(left, right) {
  const union = new Set([...left, ...right]);
  if (!union.size) return 0;
  return [...left].filter((token) => right.has(token)).length / union.size;
}

function countStrings(values) {
  const counts = new Map();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
}
