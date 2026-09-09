import { canonicalizeUrl, id, json, now, sha256, slugify } from "./utils.mjs";
import { transaction } from "./db.mjs";
import { AI_MODELS, VISUAL_MODELS } from "./config.mjs";
import { CONTENT_STRATEGY } from "./content-strategy.mjs";
import { contentBlockSummary, markdownToContentBlocks } from "./content-blocks.mjs";
import { classifyClaimPair, detectClaimExtractionIssue, structureClaim } from "./claim-resolution.mjs";
import { assessEntityIdentity, inferEntityMetadata, normalizeEntityType, normalizeGranularity, ENTITY_RELATION_TYPES } from "./entity-resolution.mjs";
import { legacyOfferToAsset } from "./commercial.mjs";
import {
  affiliateAssetFromQueueTask, exportAffiliateQueue, loadAffiliateQueueSeeds,
  normalizeAffiliateQueueTask, parseAffiliateQueueImport, queueTaskFromOpportunity,
} from "./affiliate-queue.mjs";
import { classifySourceFamily, evaluateCoverage, segmentSource, stableOpportunityKey } from "./research-strategy.mjs";
import { AI_JOB_TYPES, isProviderPressure } from "./job-policy.mjs";

function conflictError(message) { const error = new Error(message); error.statusCode = 409; return error; }

export class Repository {
  constructor(db, contentConfig = {}) {
    this.db = db;
    this.contentConfig = {
      staleAfterDays: 365, volatileStaleAfterDays: 90, searchConsoleMinimumImpressions: 10,
      contentStrategy: CONTENT_STRATEGY, ...contentConfig,
    };
    this.workerId = String(contentConfig.workerId || id("worker"));
    this.jobLeaseMs = Math.max(30_000, Number(contentConfig.jobLeaseMs || 10 * 60_000));
    this.clock = contentConfig.clock || (() => new Date());
    this.providerBackoffInitialMs = Math.max(1_000, Number(contentConfig.providerBackoffInitialMs || 5_000));
    this.providerBackoffMaxMs = Math.max(this.providerBackoffInitialMs, Number(contentConfig.providerBackoffMaxMs || 300_000));
    this.providerRecoverySuccesses = Math.max(1, Number(contentConfig.providerRecoverySuccesses || 5));
    this.providerPressureStreak = 0;
    this.providerSuccessStreak = 0;
    this.providerBackoffUntil = 0;
  }

  jobTimestamp() { return this.clock().toISOString(); }

  jobLeaseExpiry() { return new Date(this.clock().getTime() + this.jobLeaseMs).toISOString(); }

  recoverExpiredJobs() {
    const timestamp = this.jobTimestamp();
    return this.db.prepare(`
      UPDATE jobs SET status='queued', locked_at=NULL, locked_by=NULL, lease_expires_at=NULL,
        heartbeat_at=NULL, available_at=?, updated_at=?
      WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
    `).run(timestamp, timestamp, timestamp).changes;
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
        checksum, publish_package_schema_source, publish_package_version, diff_json, status, synced_at, accepted_at
      FROM frontend_contract_snapshots ORDER BY synced_at DESC LIMIT ?
    `).all(limit).map((row) => ({ ...row, diff: json(row.diff_json, {}) }));
  }

  saveFrontendContractSnapshot(snapshot) {
    const timestamp = now();
    return transaction(this.db, () => {
      let row = this.db.prepare("SELECT * FROM frontend_contract_snapshots WHERE artifact_checksum=?").get(snapshot.artifactChecksum);
      if (!row) {
        const snapshotId = id("fcontract");
        this.db.prepare(`
          INSERT INTO frontend_contract_snapshots(id, source_repository, registry_source, page_schema_source, frontend_commit_sha,
            contract_version, schema_version, checksum, registry_json, page_schema_json, diff_json, status, synced_at, accepted_at,
            publish_package_schema_source, publish_package_version, publish_package_schema_json, artifact_checksum)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(snapshotId, snapshot.sourceRepository, snapshot.registrySource, snapshot.pageSchemaSource, snapshot.frontendCommitSha,
          snapshot.contractVersion, snapshot.schemaVersion, snapshot.checksum, JSON.stringify(snapshot.registry), JSON.stringify(snapshot.pageSchema),
          JSON.stringify(snapshot.diff || {}), snapshot.activate ? "active" : "major_mismatch", timestamp, snapshot.activate ? timestamp : null,
          snapshot.publishPackageSchemaSource || "", snapshot.publishPackageVersion || "", JSON.stringify(snapshot.publishPackageSchema || {}), snapshot.artifactChecksum);
        row = this.db.prepare("SELECT * FROM frontend_contract_snapshots WHERE id=?").get(snapshotId);
      } else {
        this.db.prepare(`UPDATE frontend_contract_snapshots SET source_repository=?, registry_source=?, page_schema_source=?,
          frontend_commit_sha=?, contract_version=?, schema_version=?, registry_json=?, page_schema_json=?, diff_json=?,
          publish_package_schema_source=?, publish_package_version=?, publish_package_schema_json=?, artifact_checksum=?, synced_at=? WHERE id=?`)
          .run(snapshot.sourceRepository, snapshot.registrySource, snapshot.pageSchemaSource, snapshot.frontendCommitSha,
            snapshot.contractVersion, snapshot.schemaVersion, JSON.stringify(snapshot.registry), JSON.stringify(snapshot.pageSchema),
            JSON.stringify(snapshot.diff || {}), snapshot.publishPackageSchemaSource || "", snapshot.publishPackageVersion || "",
            JSON.stringify(snapshot.publishPackageSchema || {}), snapshot.artifactChecksum, timestamp, row.id);
        row = this.db.prepare("SELECT * FROM frontend_contract_snapshots WHERE id=?").get(row.id);
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

  saveFrontendPageComposition(draftId, planId, snapshot, payload, validation, model = null, expectedVersion = null) {
    const timestamp = now();
    const draft = this.db.prepare("SELECT revision, content_hash FROM article_drafts WHERE id=?").get(draftId);
    if (!draft) throw new Error(`Article draft ${draftId} not found.`);
    if (expectedVersion && (draft.revision !== expectedVersion.revision || draft.content_hash !== expectedVersion.contentHash)) {
      throw Object.assign(new Error("STALE_DRAFT_VERSION: page composition input changed before it could be saved."), { retryable: false });
    }
    const existing = this.db.prepare("SELECT id FROM frontend_page_compositions WHERE draft_id=?").get(draftId);
    const draftRow = this.db.prepare("SELECT evidence_ledger_json FROM article_drafts WHERE id=?").get(draftId);
    const validationRecord = { ...validation, blockProvenance: buildBlockProvenance(payload, json(draftRow?.evidence_ledger_json, [])) };
    const compositionId = existing?.id || id("fpage");
    this.db.prepare(`
      INSERT INTO frontend_page_compositions(id, draft_id, plan_id, snapshot_id, contract_version, schema_version,
        contract_checksum, payload_json, validation_json, status, model, generated_at, updated_at,
        draft_revision, draft_content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(draft_id) DO UPDATE SET plan_id=excluded.plan_id, snapshot_id=excluded.snapshot_id,
        contract_version=excluded.contract_version, schema_version=excluded.schema_version, contract_checksum=excluded.contract_checksum,
        payload_json=excluded.payload_json, validation_json=excluded.validation_json, status=excluded.status, model=excluded.model,
        generated_at=excluded.generated_at, updated_at=excluded.updated_at,
        draft_revision=excluded.draft_revision, draft_content_hash=excluded.draft_content_hash
    `).run(compositionId, draftId, planId || null, snapshot.id, snapshot.contractVersion, snapshot.schemaVersion,
      snapshot.checksum, JSON.stringify(payload), JSON.stringify(validationRecord), validation.valid ? "valid" : "invalid", model, timestamp, timestamp,
      draft.revision, draft.content_hash);
    return this.getFrontendPageComposition(draftId);
  }

  getFrontendPageComposition(draftId) {
    const row = this.db.prepare("SELECT * FROM frontend_page_compositions WHERE draft_id=?").get(draftId);
    if (!row) return null;
    const draft = this.db.prepare("SELECT revision, content_hash FROM article_drafts WHERE id=?").get(draftId);
    return { ...row, payload: json(row.payload_json, {}), validation: json(row.validation_json, {}),
      current: Boolean(draft && row.draft_revision === draft.revision && row.draft_content_hash === draft.content_hash) };
  }

  markFrontendPageCompositionStale(draftId) {
    this.db.prepare("UPDATE frontend_page_compositions SET status='stale_contract', updated_at=? WHERE draft_id=?")
      .run(now(), draftId);
  }

  saveFrontendPublishComposition(draftId, snapshot, publishPackage, validation, commercialStrategyVersion = "") {
    const timestamp = now();
    const draft = this.db.prepare("SELECT revision, content_hash FROM article_drafts WHERE id=?").get(draftId);
    if (!draft) throw new Error(`Article draft ${draftId} not found.`);
    const frontendPage = this.db.prepare("SELECT id FROM frontend_page_compositions WHERE draft_id=?").get(draftId);
    const commercial = this.db.prepare("SELECT id FROM commercial_compositions WHERE draft_id=?").get(draftId);
    if (!frontendPage || !commercial) throw new Error("Editorial and Commercial compositions are required before Publish Composition.");
    const existing = this.db.prepare("SELECT id FROM frontend_publish_compositions WHERE draft_id=?").get(draftId);
    const compositionId = existing?.id || id("fpublish");
    this.db.prepare(`
      INSERT INTO frontend_publish_compositions(id, draft_id, frontend_page_composition_id, commercial_composition_id,
        snapshot_id, publish_package_version, contract_version, page_schema_version, contract_checksum,
        commercial_strategy_version, publish_package_json, validation_json, status, generated_at, updated_at,
        draft_revision, draft_content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(draft_id) DO UPDATE SET frontend_page_composition_id=excluded.frontend_page_composition_id,
        commercial_composition_id=excluded.commercial_composition_id, snapshot_id=excluded.snapshot_id,
        publish_package_version=excluded.publish_package_version, contract_version=excluded.contract_version,
        page_schema_version=excluded.page_schema_version, contract_checksum=excluded.contract_checksum,
        commercial_strategy_version=excluded.commercial_strategy_version, publish_package_json=excluded.publish_package_json,
        validation_json=excluded.validation_json, status=excluded.status, wordpress_post_id=NULL,
        generated_at=excluded.generated_at, updated_at=excluded.updated_at,
        draft_revision=excluded.draft_revision, draft_content_hash=excluded.draft_content_hash
    `).run(compositionId, draftId, frontendPage.id, commercial.id, snapshot.id, snapshot.publishPackageVersion || "1.0.0",
      publishPackage.contract.componentContractVersion, publishPackage.contract.pageSchemaVersion,
      publishPackage.contract.contractChecksum, commercialStrategyVersion || "", JSON.stringify(publishPackage),
      JSON.stringify(validation), validation.valid ? "valid" : "invalid", timestamp, timestamp,
      draft.revision, draft.content_hash);
    return this.getFrontendPublishComposition(draftId);
  }

  getFrontendPublishComposition(draftId) {
    const row = this.db.prepare("SELECT * FROM frontend_publish_compositions WHERE draft_id=?").get(draftId);
    if (!row) return null;
    const draft = this.db.prepare("SELECT revision, content_hash FROM article_drafts WHERE id=?").get(draftId);
    return { ...row, publish_package: json(row.publish_package_json, {}), validation: json(row.validation_json, {}),
      current: Boolean(draft && row.draft_revision === draft.revision && row.draft_content_hash === draft.content_hash) };
  }

  markFrontendPublishComposition(draftId, status, postId = null) {
    this.db.prepare("UPDATE frontend_publish_compositions SET status=?, wordpress_post_id=?, updated_at=? WHERE draft_id=?")
      .run(status, postId, now(), draftId);
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
    const contentHash = captureContentHash(capture);
    const sourceKind = capture.sourceKind || (capture.adapter === "xiaohongshu" ? "xiaohongshu_note" : "manual_source");
    const submittedUrl = capture.submittedUrl || capture.canonicalUrl;
    const submissionMetadata = capture.submissionMetadata || {};
    const completeness = capture.completeness || { overall: "complete" };
    const completenessStatus = ["complete", "partial_retryable", "partial_needs_attention"].includes(completeness.overall)
      ? completeness.overall : "complete";
    const acquisitionOrigin = capture.acquisitionOrigin || capture.client?.acquisitionOrigin || (capture.adapter === "xiaohongshu" ? "xhs_manual_extension" : "manual_upload");
    const syncScopeKey = capture.syncScopeKey || capture.client?.syncScopeKey || "";
    const extensionVersion = capture.client?.extensionVersion || "";
    const rights = capture.rights || {};

    return transaction(this.db, () => {
      // A note ID remains stable when Xiaohongshu changes a share URL or adds
      // transient tokens. Canonical URL remains the fallback for old captures.
      const existingByExternalId = capture.externalId
        ? this.db.prepare("SELECT id, content_hash, capture_version, completeness_status FROM sources WHERE adapter = ? AND external_id = ? LIMIT 1").get(capture.adapter, capture.externalId)
        : null;
      const existing = existingByExternalId
        || this.db.prepare("SELECT id, content_hash, capture_version, completeness_status FROM sources WHERE canonical_url = ?").get(capture.canonicalUrl);
      let sourceId;
      let duplicate = false;
      let captureVersion = 1;
      const completenessUpgrade = existing?.completeness_status !== "complete" && completenessStatus === "complete";
      if (existing && existing.content_hash === contentHash && !completenessUpgrade) {
        sourceId = existing.id;
        duplicate = true;
        captureVersion = existing.capture_version;
        this.db.prepare("UPDATE sources SET captured_at = ?, updated_at = ? WHERE id = ?").run(capture.capturedAt, timestamp, sourceId);
      } else if (existing) {
        sourceId = existing.id;
        captureVersion = existing.capture_version + 1;
        this.db.prepare(`
          UPDATE sources SET adapter = ?, external_id = ?, canonical_url = ?, submitted_url = ?, source_kind = ?, submission_metadata_json = ?,
            title = ?, author_name = ?, author_url = ?, published_at = ?,
            captured_at = ?, raw_text = ?, raw_html = ?, raw_payload_json = ?, content_hash = ?,
            capture_version = capture_version + 1, status = ?, last_error = NULL, acquisition_origin=?, sync_scope_key=?,
            extension_version=?, completeness_status=?, completeness_json=?, authorization_status=?, commercial_use_allowed=?,
            editing_allowed=?, redistribution_allowed=?, publishable=?, authorization_origin=?, license_scope_json=?, updated_at = ?
          WHERE id = ?
        `).run(
          capture.adapter, capture.externalId, capture.canonicalUrl, submittedUrl, sourceKind, JSON.stringify(submissionMetadata),
          capture.title, capture.authorName, capture.authorUrl, capture.publishedAt,
          capture.capturedAt, capture.rawText, capture.rawHtml, JSON.stringify(capture), contentHash,
          completenessStatus === "complete" ? "captured" : "partial", acquisitionOrigin, syncScopeKey, extensionVersion,
          completenessStatus, JSON.stringify(completeness), rights.authorizationStatus || "legacy",
          rights.commercialUseAllowed ? 1 : 0, rights.editingAllowed ? 1 : 0, rights.redistributionAllowed ? 1 : 0,
          rights.publishable ? 1 : 0, rights.authorizationOrigin || acquisitionOrigin, JSON.stringify(rights.licenseScope || []),
          timestamp, sourceId,
        );
        this.db.prepare("DELETE FROM source_assets WHERE source_id = ?").run(sourceId);
        this.db.prepare("DELETE FROM source_files WHERE source_id = ?").run(sourceId);
        this.db.prepare(`DELETE FROM jobs WHERE status IN ('queued','failed') AND (
          entity_id=? OR entity_id IN (SELECT id FROM source_segments WHERE source_id=?)
        )`).run(sourceId, sourceId);
      } else {
        sourceId = id("src");
        this.db.prepare(`
          INSERT INTO sources(id, adapter, external_id, canonical_url, submitted_url, source_kind, submission_metadata_json,
            title, author_name, author_url, published_at, captured_at, raw_text, raw_html, raw_payload_json, content_hash,
            status,acquisition_origin,sync_scope_key,extension_version,completeness_status,completeness_json,authorization_status,
            commercial_use_allowed,editing_allowed,redistribution_allowed,publishable,authorization_origin,license_scope_json,created_at,updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          sourceId, capture.adapter, capture.externalId, capture.canonicalUrl, submittedUrl, sourceKind, JSON.stringify(submissionMetadata), capture.title, capture.authorName,
          capture.authorUrl, capture.publishedAt, capture.capturedAt, capture.rawText, capture.rawHtml,
          JSON.stringify(capture), contentHash, completenessStatus === "complete" ? "captured" : "partial",
          acquisitionOrigin, syncScopeKey, extensionVersion, completenessStatus, JSON.stringify(completeness),
          rights.authorizationStatus || "legacy", rights.commercialUseAllowed ? 1 : 0, rights.editingAllowed ? 1 : 0,
          rights.redistributionAllowed ? 1 : 0, rights.publishable ? 1 : 0, rights.authorizationOrigin || acquisitionOrigin,
          JSON.stringify(rights.licenseScope || []), timestamp, timestamp,
        );
      }

      if (!duplicate) {
        const insertAsset = this.db.prepare(`
          INSERT OR IGNORE INTO source_assets(id, source_id, kind, remote_url, alt_text, position, local_path, mime_type, original_filename,
            media_identity,width,height,duration,original_sha256,ai_derivative_data_url,ai_derivative_sha256,authorization_status,
            commercial_use_allowed,editing_allowed,redistribution_allowed,publishable,authorization_origin,provenance_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const asset of capture.assets) {
          insertAsset.run(id("asset"), sourceId, asset.kind, asset.url, asset.alt, asset.position,
            asset.localPath || "", asset.mimeType || "", asset.originalFilename || "", asset.mediaIdentity || asset.url,
            asset.width ?? null, asset.height ?? null, asset.duration ?? null, asset.originalSha256 || "",
            asset.aiDerivativeDataUrl || "", asset.aiDerivativeSha256 || "", rights.authorizationStatus || "legacy",
            rights.commercialUseAllowed ? 1 : 0, rights.editingAllowed ? 1 : 0, rights.redistributionAllowed ? 1 : 0,
            rights.publishable ? 1 : 0, rights.authorizationOrigin || acquisitionOrigin,
            JSON.stringify({ sourceId, externalId: capture.externalId || null, canonicalUrl: capture.canonicalUrl,
              capturedAt: capture.capturedAt, captureVersion, acquisitionOrigin, syncScopeKey, extensionVersion,
              mediaSourceUrl: asset.url, ...asset.provenance }),
          );
        }
        const insertFile = this.db.prepare(`
          INSERT INTO source_files(id, source_id, file_kind, original_filename, mime_type, storage_path, size_bytes, sha256, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const file of capture.files || []) {
          insertFile.run(file.id || id("source_file"), sourceId, file.fileKind, file.originalFilename,
            file.mimeType, file.storagePath, file.sizeBytes, file.sha256, timestamp);
        }
        this.db.prepare(`INSERT INTO capture_versions(id,source_id,capture_version,captured_at,raw_text,raw_html,raw_payload_json,
          assets_json,content_hash,completeness_status,completeness_json,acquisition_origin,sync_scope_key,extension_version,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(id("capture_version"), sourceId, captureVersion, capture.capturedAt, capture.rawText, capture.rawHtml,
            JSON.stringify(capture), JSON.stringify(capture.assets || []), contentHash, completenessStatus,
            JSON.stringify(completeness), acquisitionOrigin, syncScopeKey, extensionVersion, timestamp);
        if (completenessStatus === "complete") {
          this.enqueue("extract_source", sourceId, { dedupeKey: `extract_source:${sourceId}:${captureVersion}` });
        }
      }

      const queueDepth = this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('queued','running')").get().count;

      return {
        id: sourceId,
        accepted: true,
        duplicate,
        queued: !duplicate && completenessStatus === "complete",
        captureVersion,
        completenessStatus,
        queueDepth,
        advice: queueDepth >= 500 ? "slow_down" : "continue",
        identity: {
          adapter: capture.adapter,
          externalId: capture.externalId || null,
          contentFingerprint: contentHash.slice(0, 12),
        },
      };
    });
  }

  checkCaptureIdentities(items = []) {
    const normalized = items.slice(0, 100).map((item) => {
      const externalId = String(item?.externalId || "").trim().slice(0, 300);
      let canonicalUrl = "";
      try { canonicalUrl = canonicalizeUrl(String(item?.url || "")); } catch { /* malformed items stay unknown */ }
      return { externalId, canonicalUrl };
    });
    const externalIds = [...new Set(normalized.map((item) => item.externalId).filter(Boolean))];
    const urls = [...new Set(normalized.map((item) => item.canonicalUrl).filter(Boolean))];
    const clauses = [];
    const parameters = [];
    if (externalIds.length) { clauses.push(`(adapter='xiaohongshu' AND external_id IN (${externalIds.map(() => "?").join(",")}))`); parameters.push(...externalIds); }
    if (urls.length) { clauses.push(`(adapter='xiaohongshu' AND canonical_url IN (${urls.map(() => "?").join(",")}))`); parameters.push(...urls); }
    const rows = clauses.length ? this.db.prepare(`SELECT id,external_id,canonical_url,capture_version,captured_at,content_hash,completeness_status,source_availability
      FROM sources WHERE ${clauses.join(" OR ")}`).all(...parameters) : [];
    const byExternalId = new Map(rows.filter((row) => row.external_id).map((row) => [row.external_id, row]));
    const byUrl = new Map(rows.map((row) => [row.canonical_url, row]));
    return normalized.map((item) => {
      const row = (item.externalId && byExternalId.get(item.externalId)) || (item.canonicalUrl && byUrl.get(item.canonicalUrl));
      const complete = row?.completeness_status === "complete" && row?.source_availability === "available";
      return row ? { externalId: item.externalId || row.external_id, known: complete, needsRecapture: !complete, sourceId: row.id,
        captureVersion: row.capture_version, lastCapturedAt: row.captured_at, canonicalUrl: row.canonical_url,
        contentFingerprint: row.content_hash.slice(0, 12) }
        : { externalId: item.externalId || null, known: false, sourceId: null, captureVersion: null,
          lastCapturedAt: null, canonicalUrl: item.canonicalUrl || null, contentFingerprint: null };
    });
  }

  recordFavoritesSyncRun(input = {}) {
    const sessionId = String(input.sessionId || "").trim();
    if (!/^[A-Za-z0-9-]{8,80}$/.test(sessionId)) throw Object.assign(new Error("A valid Favorites Sync session ID is required."), { statusCode: 400 });
    const mode = input.mode === "full" ? "full" : "incremental";
    const startedAt = safeIsoDate(input.startedAt) || now();
    const completedAt = safeIsoDate(input.completedAt);
    const timestamp = now();
    const durationMs = completedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)) : null;
    const suppliedStats = input.stats && typeof input.stats === "object" ? input.stats : {};
    const stats = {
      ...suppliedStats,
      favorites_scanned: Number(suppliedStats.discovered ?? suppliedStats.scanned ?? 0),
      favorites_known: Number(suppliedStats.known || 0),
      favorites_new: Number(suppliedStats.new || 0),
      favorites_capture_success: Number(suppliedStats.captured || 0),
      favorites_capture_duplicate: Number(suppliedStats.duplicate || 0),
      favorites_capture_failed: Number(suppliedStats.failed || 0),
      favorites_sync_paused: String(input.status || "").startsWith("paused_") ? 1 : 0,
      favorites_sync_duration: durationMs,
    };
    this.db.prepare(`INSERT INTO favorites_sync_runs(session_id,scope_key,scope_url,scope_label,mode,status,stats_json,
      started_at,completed_at,duration_ms,extension_version,last_error_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET scope_key=excluded.scope_key,scope_url=excluded.scope_url,
        scope_label=excluded.scope_label,mode=excluded.mode,status=excluded.status,stats_json=excluded.stats_json,
        started_at=excluded.started_at,completed_at=excluded.completed_at,duration_ms=excluded.duration_ms,
        extension_version=excluded.extension_version,last_error_json=excluded.last_error_json,updated_at=excluded.updated_at`)
      .run(sessionId, String(input.scopeKey || "").slice(0, 2_000), String(input.scopeUrl || "").slice(0, 4_000),
        String(input.scopeLabel || "").slice(0, 500), mode, String(input.status || "unknown").slice(0, 100),
        JSON.stringify(stats), startedAt, completedAt,
        durationMs, String(input.extensionVersion || "").slice(0, 50),
        JSON.stringify(input.lastError && typeof input.lastError === "object" ? input.lastError : {}), timestamp, timestamp);
    const row = this.db.prepare("SELECT * FROM favorites_sync_runs WHERE session_id=?").get(sessionId);
    return { ...row, stats: json(row.stats_json, {}), lastError: json(row.last_error_json, {}) };
  }

  listFavoritesSyncRuns(limit = 20) {
    return this.db.prepare("SELECT * FROM favorites_sync_runs ORDER BY updated_at DESC LIMIT ?").all(Math.max(1, Math.min(100, Number(limit) || 20)))
      .map((row) => ({ ...row, stats: json(row.stats_json, {}), lastError: json(row.last_error_json, {}) }));
  }

  enqueue(type, entityId, { dedupeKey = `${type}:${entityId}` } = {}) {
    const timestamp = this.jobTimestamp();
    const active = this.db.prepare(`
      SELECT id FROM jobs WHERE dedupe_key = ? AND status IN ('queued', 'running') LIMIT 1
    `).get(dedupeKey);
    if (active) return active.id;
    const jobId = id("job");
    try {
      this.db.prepare(`
        INSERT INTO jobs(id, type, entity_id, available_at, created_at, updated_at, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(jobId, type, entityId, timestamp, timestamp, timestamp, dedupeKey);
      return jobId;
    } catch (error) {
      const raced = this.db.prepare("SELECT id FROM jobs WHERE dedupe_key=? AND status IN ('queued','running') LIMIT 1").get(dedupeKey);
      if (raced) return raced.id;
      throw error;
    }
  }

  recoverPreparingVertexBatches() {
    const runs = this.db.prepare("SELECT id FROM vertex_batch_runs WHERE status='preparing'").all();
    if (!runs.length) return 0;
    const timestamp = this.jobTimestamp();
    transaction(this.db, () => {
      for (const run of runs) {
        this.db.prepare(`UPDATE vertex_batch_items SET status='failed',last_error='Batch preparation was interrupted; returned to the realtime queue.',completed_at=?
          WHERE run_id=? AND status='preparing'`).run(timestamp, run.id);
        this.db.prepare(`UPDATE vertex_batch_runs SET status='failed',last_error='Batch preparation was interrupted during process restart.',
          failed_count=(SELECT COUNT(*) FROM vertex_batch_items WHERE run_id=?),completed_at=?,updated_at=? WHERE id=?`)
          .run(run.id, timestamp, timestamp, run.id);
      }
    });
    return runs.length;
  }

  countVertexBatchEligibleJobs(type = "extract_segment_claims") {
    if (!["extract_segment_claims", "audit_segment_coverage"].includes(type)) return 0;
    return Number(this.db.prepare(`SELECT COUNT(*) AS count FROM jobs j
      JOIN source_segments ss ON ss.id=j.entity_id
      WHERE j.type=? AND j.status='queued' AND j.available_at<=?
        AND ((j.type='extract_segment_claims' AND ss.segment_type<>'video_chapter')
          OR (j.type='audit_segment_coverage' AND ss.asset_id IS NULL))
        AND NOT EXISTS (
          SELECT 1 FROM vertex_batch_items vbi JOIN vertex_batch_runs vbr ON vbr.id=vbi.run_id
          WHERE vbi.job_id=j.id AND vbr.status IN ('preparing','submitted')
        )`).get(type, this.jobTimestamp())?.count || 0);
  }

  reserveVertexBatchJobs({ minimum = 20, maximum = 1_000, model = '', location = 'global' } = {}) {
    return transaction(this.db, () => {
      if (this.db.prepare("SELECT 1 FROM vertex_batch_runs WHERE status IN ('preparing','submitted') LIMIT 1").get()) return null;
      const timestamp = this.jobTimestamp();
      const minimumCount = Math.max(1, Number(minimum || 20));
      const jobType = ["extract_segment_claims", "audit_segment_coverage"]
        .find((type) => this.countVertexBatchEligibleJobs(type) >= minimumCount);
      if (!jobType) return null;
      const rows = this.db.prepare(`SELECT j.* FROM jobs j
        JOIN source_segments ss ON ss.id=j.entity_id
        WHERE j.type=? AND j.status='queued' AND j.available_at<=?
          AND ((j.type='extract_segment_claims' AND ss.segment_type<>'video_chapter')
            OR (j.type='audit_segment_coverage' AND ss.asset_id IS NULL))
          AND NOT EXISTS (
            SELECT 1 FROM vertex_batch_items vbi JOIN vertex_batch_runs vbr ON vbr.id=vbi.run_id
            WHERE vbi.job_id=j.id AND vbr.status IN ('preparing','submitted')
          )
        ORDER BY j.created_at ASC LIMIT ?`).all(jobType, timestamp, Math.max(1, Number(maximum || 1_000)));
      if (rows.length < minimumCount) return null;
      const runId = id("vertex_batch");
      this.db.prepare(`INSERT INTO vertex_batch_runs(id,model,location,status,next_poll_at,created_at,updated_at)
        VALUES (?,?,?,'preparing',?,?,?)`).run(runId, model, location, timestamp, timestamp, timestamp);
      const addItem = this.db.prepare(`INSERT INTO vertex_batch_items(run_id,job_id,segment_id,batch_item_id,status)
        VALUES (?,?,?,?, 'preparing')`);
      for (const row of rows) {
        const batchItemId = `batch_item_${sha256(`${runId}:${row.id}`).slice(0, 24)}`;
        addItem.run(runId, row.id, row.entity_id, batchItemId);
      }
      return { id: runId, model, location, status: 'preparing', jobType, items: rows.map((row) => ({
        ...row, segment_id: row.entity_id,
        batch_item_id: `batch_item_${sha256(`${runId}:${row.id}`).slice(0, 24)}`,
      })) };
    });
  }

  activateVertexBatch(runId, batch) {
    const timestamp = this.jobTimestamp();
    return transaction(this.db, () => {
      const submittedIds = new Set(batch.itemIds || []);
      const items = this.db.prepare("SELECT * FROM vertex_batch_items WHERE run_id=? AND status='preparing'").all(runId);
      for (const item of items) {
        if (submittedIds.has(item.batch_item_id)) {
          this.db.prepare("UPDATE vertex_batch_items SET status='submitted',last_error='' WHERE run_id=? AND job_id=?")
            .run(runId, item.job_id);
          this.db.prepare(`UPDATE jobs SET attempts=attempts+1,started_at=COALESCE(started_at,?),
            queue_latency_ms=COALESCE(queue_latency_ms,?),updated_at=? WHERE id=? AND status='queued'`)
            .run(timestamp, Math.max(0, Date.parse(timestamp) - Date.parse(this.db.prepare("SELECT created_at FROM jobs WHERE id=?").get(item.job_id)?.created_at || timestamp)), timestamp, item.job_id);
        } else {
          this.db.prepare("UPDATE vertex_batch_items SET status='failed',last_error=?,completed_at=? WHERE run_id=? AND job_id=?")
            .run("This item could not be prepared for Vertex Batch; returned to the realtime queue.", timestamp, runId, item.job_id);
        }
      }
      this.db.prepare(`UPDATE vertex_batch_runs SET provider_job_name=?,input_uri=?,output_uri_prefix=?,status='submitted',
        provider_state=?,submitted_count=?,next_poll_at=?,updated_at=? WHERE id=? AND status='preparing'`)
        .run(batch.name, batch.inputUri, batch.outputUriPrefix, batch.state || 'JOB_STATE_PENDING', submittedIds.size,
          new Date(this.clock().getTime() + Number(batch.pollMs || 60_000)).toISOString(), timestamp, runId);
    });
  }

  dueVertexBatch() {
    const run = this.db.prepare(`SELECT * FROM vertex_batch_runs WHERE status='submitted' AND next_poll_at<=?
      ORDER BY created_at LIMIT 1`).get(this.jobTimestamp());
    if (!run) return null;
    return { ...run, items: this.db.prepare(`SELECT vbi.*,j.type AS job_type FROM vertex_batch_items vbi
      JOIN jobs j ON j.id=vbi.job_id WHERE vbi.run_id=? AND vbi.status='submitted' ORDER BY vbi.rowid`).all(run.id) };
  }

  deferVertexBatchPoll(runId, providerState, delayMs = 60_000) {
    const timestamp = this.jobTimestamp();
    this.db.prepare("UPDATE vertex_batch_runs SET provider_state=?,next_poll_at=?,updated_at=? WHERE id=? AND status='submitted'")
      .run(providerState || '', new Date(this.clock().getTime() + delayMs).toISOString(), timestamp, runId);
  }

  completeVertexBatchItem(run, item, extraction) {
    const timestamp = this.jobTimestamp();
    if (!this.saveSegmentExtraction(item.segment_id, extraction)) return this.releaseVertexBatchItem(run.id, item.job_id, "Source changed while the batch was running; returned for fresh extraction.");
    this.enqueue("audit_segment_coverage", item.segment_id);
    const job = this.db.prepare("SELECT started_at FROM jobs WHERE id=?").get(item.job_id);
    const durationMs = job?.started_at ? Math.max(0, Date.parse(timestamp) - Date.parse(job.started_at)) : null;
    transaction(this.db, () => {
      this.db.prepare("UPDATE vertex_batch_items SET status='succeeded',last_error='',completed_at=? WHERE run_id=? AND job_id=?")
        .run(timestamp, run.id, item.job_id);
      this.db.prepare(`UPDATE jobs SET status='succeeded',completed_at=?,duration_ms=?,last_error=NULL,updated_at=?
        WHERE id=? AND status='queued'`).run(timestamp, durationMs, timestamp, item.job_id);
    });
    return true;
  }

  completeVertexBatchCoverageItem(run, item, assessment) {
    const timestamp = this.jobTimestamp();
    const audit = this.auditSegmentCoverage(item.segment_id, assessment?.output || assessment);
    if (audit.status === "retry_required") this.enqueue("retry_segment_extraction", item.segment_id);
    else if (audit.status !== "stale" && this.sourceCoverageReady(audit.sourceId)) {
      this.enqueue("finalize_source_extraction", audit.sourceId);
    }
    const job = this.db.prepare("SELECT started_at FROM jobs WHERE id=?").get(item.job_id);
    const durationMs = job?.started_at ? Math.max(0, Date.parse(timestamp) - Date.parse(job.started_at)) : null;
    transaction(this.db, () => {
      this.db.prepare("UPDATE vertex_batch_items SET status='succeeded',last_error='',completed_at=? WHERE run_id=? AND job_id=?")
        .run(timestamp, run.id, item.job_id);
      this.db.prepare(`UPDATE jobs SET status='succeeded',completed_at=?,duration_ms=?,last_error=NULL,updated_at=?
        WHERE id=? AND status='queued'`).run(timestamp, durationMs, timestamp, item.job_id);
    });
    return audit;
  }

  releaseVertexBatchItem(runId, jobId, error) {
    const timestamp = this.jobTimestamp();
    const message = String(error?.message || error || "Vertex Batch item failed").slice(0, 4_000);
    transaction(this.db, () => {
      this.db.prepare("UPDATE vertex_batch_items SET status='failed',last_error=?,completed_at=? WHERE run_id=? AND job_id=?")
        .run(message, timestamp, runId, jobId);
      const job = this.db.prepare("SELECT attempts,max_attempts FROM jobs WHERE id=?").get(jobId);
      const retry = Number(job?.attempts || 0) < Number(job?.max_attempts || 3);
      this.db.prepare(`UPDATE jobs SET status=?,available_at=?,last_error=?,completed_at=?,updated_at=? WHERE id=? AND status='queued'`)
        .run(retry ? 'queued' : 'failed', timestamp, message, retry ? null : timestamp, timestamp, jobId);
    });
  }

  finishVertexBatch(runId, status, providerState = '', error = '') {
    const timestamp = this.jobTimestamp();
    const counts = this.db.prepare(`SELECT SUM(status='succeeded') AS succeeded,SUM(status='failed') AS failed
      FROM vertex_batch_items WHERE run_id=?`).get(runId);
    this.db.prepare(`UPDATE vertex_batch_runs SET status=?,provider_state=?,succeeded_count=?,failed_count=?,last_error=?,
      completed_at=?,updated_at=? WHERE id=?`).run(status, providerState, Number(counts?.succeeded || 0), Number(counts?.failed || 0),
      String(error || '').slice(0, 4_000), timestamp, timestamp, runId);
  }

  activeVertexBatchCount() {
    return Number(this.db.prepare("SELECT COUNT(*) AS count FROM vertex_batch_runs WHERE status IN ('preparing','submitted')").get()?.count || 0);
  }

  claimJob({ deferBatchExtraction = false, deferBatchCoverage = false } = {}) {
    return transaction(this.db, () => {
      const timestamp = this.jobTimestamp();
      const providerReady = this.clock().getTime() >= this.providerBackoffUntil;
      this.db.prepare(`
        UPDATE jobs SET status='queued', locked_at=NULL, locked_by=NULL, lease_expires_at=NULL,
          heartbeat_at=NULL, available_at=?, updated_at=?
        WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
      `).run(timestamp, timestamp, timestamp);
      const job = this.db.prepare(`
        SELECT * FROM jobs
        WHERE status = 'queued' AND available_at <= ?
          AND (? = 0 OR type <> 'extract_segment_claims')
          AND (? = 0 OR type <> 'audit_segment_coverage')
          AND NOT EXISTS (
            SELECT 1 FROM vertex_batch_items vbi JOIN vertex_batch_runs vbr ON vbr.id=vbi.run_id
            WHERE vbi.job_id=jobs.id AND vbr.status IN ('preparing','submitted')
          )
          AND (? = 1 OR type NOT IN (${[...AI_JOB_TYPES].map(() => "?").join(",")}))
        ORDER BY
          CASE type
            WHEN 'finalize_source_extraction' THEN 0
            WHEN 'rebuild_knowledge' THEN 1
            WHEN 'analyze_source_diagnostic' THEN 2
            WHEN 'plan_content' THEN 3
            WHEN 'compose_frontend_page_plan' THEN 3
            WHEN 'generate_draft' THEN 3
            WHEN 'generate_visuals' THEN 3
            WHEN 'review_draft' THEN 3
            WHEN 'revise_draft' THEN 3
            WHEN 'compose_frontend_page' THEN 3
            WHEN 'compose_publish_page' THEN 3
            WHEN 'compose_commercial' THEN 3
            WHEN 'push_wordpress_draft' THEN 3
            WHEN 'retry_segment_extraction' THEN 4
            WHEN 'audit_segment_coverage' THEN 5
            WHEN 'analyze_source_family' THEN 6
            WHEN 'analyze_source_blueprint' THEN 7
            WHEN 'resolve_entities' THEN 8
            WHEN 'extract_segment_claims' THEN 9
            WHEN 'segment_source' THEN 10
            WHEN 'preflight_source' THEN 11
            WHEN 'extract_source' THEN 12
            ELSE 9
          END,
          created_at ASC
        LIMIT 1
      `).get(timestamp, deferBatchExtraction ? 1 : 0, deferBatchCoverage ? 1 : 0,
        providerReady ? 1 : 0, ...AI_JOB_TYPES);
      if (!job) return null;
      const queueLatencyMs = Math.max(0, Date.parse(timestamp) - Date.parse(job.created_at));
      const claimed = this.db.prepare(`
        UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_at = ?,
          locked_by = ?, lease_expires_at = ?, heartbeat_at = ?, started_at = COALESCE(started_at, ?),
          queue_latency_ms = COALESCE(queue_latency_ms, ?), updated_at = ?
        WHERE id = ? AND status='queued'
      `).run(timestamp, this.workerId, this.jobLeaseExpiry(), timestamp, timestamp, queueLatencyMs, timestamp, job.id);
      if (claimed.changes !== 1) return null;
      if (job.type === "extract_source") {
        this.db.prepare("UPDATE sources SET status = 'processing', updated_at = ? WHERE id = ?").run(timestamp, job.entity_id);
      }
      return { ...job, attempts: job.attempts + 1, locked_at: timestamp, locked_by: this.workerId,
        lease_expires_at: this.jobLeaseExpiry(), heartbeat_at: timestamp,
        started_at: job.started_at || timestamp, queue_latency_ms: job.queue_latency_ms ?? queueLatencyMs };
    });
  }

  heartbeatJob(jobId, ownerId = this.workerId) {
    const timestamp = this.jobTimestamp();
    return this.db.prepare(`UPDATE jobs SET heartbeat_at=?, lease_expires_at=?, updated_at=?
      WHERE id=? AND status='running' AND locked_by=?`)
      .run(timestamp, this.jobLeaseExpiry(), timestamp, jobId, ownerId).changes === 1;
  }

  ownsJob(jobId, ownerId = this.workerId) {
    return Boolean(this.db.prepare("SELECT 1 FROM jobs WHERE id=? AND status='running' AND locked_by=? AND lease_expires_at>?")
      .get(jobId, ownerId, this.jobTimestamp()));
  }

  completeJob(jobId, ownerId = this.workerId) {
    const timestamp = this.jobTimestamp();
    const job = this.db.prepare("SELECT started_at FROM jobs WHERE id=?").get(jobId);
    const durationMs = job?.started_at ? Math.max(0, Date.parse(timestamp) - Date.parse(job.started_at)) : null;
    return this.db.prepare(`
      UPDATE jobs SET status='succeeded', completed_at=?, duration_ms=?, locked_by=NULL,
        lease_expires_at=NULL, heartbeat_at=NULL, updated_at=?
      WHERE id=? AND status='running' AND locked_by=?
    `).run(timestamp, durationMs, timestamp, jobId, ownerId).changes === 1;
  }

  failJob(job, error) {
    const providerPressure = isProviderPressure(error);
    const retry = error?.retryable !== false && (providerPressure || job.attempts < job.max_attempts);
    if (providerPressure) {
      this.providerPressureStreak += 1;
      this.providerSuccessStreak = 0;
    }
    const baseDelayMs = providerPressure
      ? Math.min(this.providerBackoffMaxMs, this.providerBackoffInitialMs * 2 ** Math.min(10, Math.max(0, this.providerPressureStreak - 1)))
      : Math.min(300_000, 10_000 * 2 ** Math.max(0, job.attempts - 1));
    const delayMs = Math.max(Number(error?.retryAfterMs || 0), Math.round(baseDelayMs * (0.8 + Math.random() * 0.4)));
    const availableAt = new Date(this.clock().getTime() + delayMs).toISOString();
    if (providerPressure) this.providerBackoffUntil = Math.max(this.providerBackoffUntil, Date.parse(availableAt));
    const timestamp = this.jobTimestamp();
    const durationMs = job.started_at ? Math.max(0, Date.parse(timestamp) - Date.parse(job.started_at)) : null;
    this.db.prepare(`
      UPDATE jobs SET status=?, available_at=?, last_error=?, completed_at=?, duration_ms=?,
        locked_by=NULL, lease_expires_at=NULL, heartbeat_at=NULL, updated_at=?
      WHERE id=? AND status='running' AND locked_by=?
    `).run(retry ? "queued" : "failed", availableAt, String(error?.message || error).slice(0, 4_000),
      retry ? null : timestamp, retry ? null : durationMs, timestamp, job.id, job.locked_by || this.workerId);
    const message = String(error?.message || error).slice(0, 4_000);
    if (job.type === "extract_source") {
      this.db.prepare("UPDATE sources SET status = 'exception', last_error = ?, updated_at = ? WHERE id = ?").run(message, now(), job.entity_id);
    } else if (!retry && job.type === "plan_content") {
      this.db.prepare("UPDATE topic_candidates SET status='candidate', updated_at=? WHERE id=?").run(now(), job.entity_id);
    } else if (!retry && ["generate_draft", "compose_frontend_page_plan"].includes(job.type)) {
      this.db.prepare("UPDATE content_briefs SET status='exception', last_error=?, updated_at=? WHERE id=?").run(message, now(), job.entity_id);
    } else if (!retry && ["review_draft", "revise_draft", "compose_frontend_page", "compose_publish_page", "push_wordpress_draft"].includes(job.type)) {
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
    const captureVersions = this.db.prepare(`SELECT id,capture_version,captured_at,content_hash,completeness_status,
      acquisition_origin,sync_scope_key,extension_version,created_at FROM capture_versions WHERE source_id=? ORDER BY capture_version DESC`).all(sourceId);
    const segments = this.db.prepare("SELECT * FROM source_segments WHERE source_id=? ORDER BY sequence").all(sourceId);
    const coverage = this.db.prepare("SELECT * FROM extraction_coverage WHERE source_id=? ORDER BY segment_id").all(sourceId);
    const family = this.db.prepare(`SELECT sf.*, sfm.relation_type, sfm.overlap_score, sfm.incremental_claim_count, sfm.analysis_json
      FROM source_family_memberships sfm JOIN source_families sf ON sf.id=sfm.family_id WHERE sfm.source_id=?`).get(sourceId) || null;
    return hydrateSource({ source, assets, files, structured, claims, extractionRuns, claimHistory, blueprint, analysis, recommendation, segments, coverage, family, captureVersions });
  }

  getSourceAssetPreview(assetId) {
    return this.db.prepare(`SELECT id,source_id,kind,remote_url,alt_text,position,local_path,mime_type,
      ai_derivative_data_url FROM source_assets WHERE id=?`).get(assetId) || null;
  }

  claimReviewEvidence(sourceId, evidenceSpanIdsJson, sourceQuote = "") {
    if (!sourceId) return { available: false, reason: "该信息主张没有关联到可追溯来源。" };
    const source = this.db.prepare(`SELECT id,title,author_name,canonical_url,captured_at,raw_text
      FROM sources WHERE id=?`).get(sourceId);
    if (!source) return { available: false, reason: "关联来源已不存在，无法核对原文或图片。" };
    const requestedSpanIds = new Set(json(evidenceSpanIdsJson, []).map(String));
    const allSpans = this.db.prepare(`SELECT es.id,es.locator_type,es.page,es.image_index,es.quote,es.asset_id,
      ss.segment_type,ss.sequence,ss.title AS segment_title,ss.raw_text AS segment_text
      FROM evidence_spans es LEFT JOIN source_segments ss ON ss.id=es.segment_id
      WHERE es.source_id=? ORDER BY ss.sequence,es.id`).all(sourceId);
    const spans = (requestedSpanIds.size ? allSpans.filter((span) => requestedSpanIds.has(span.id)) : [])
      .map((span) => ({ id: span.id, locatorType: span.locator_type, page: span.page, imageIndex: span.image_index,
        quote: span.quote, segmentType: span.segment_type, segmentTitle: span.segment_title,
        segmentText: String(span.segment_text || "").slice(0, 2_000), assetId: span.asset_id }));
    const assetIds = new Set(spans.map((span) => span.assetId).filter(Boolean));
    const placeholderQuote = /^\s*\[(?:image|video)\]\s*$/iu.test(String(sourceQuote || ""));
    let assets = this.db.prepare(`SELECT id,kind,remote_url,alt_text,position,mime_type,
      CASE WHEN ai_derivative_data_url<>'' THEN 1 ELSE 0 END AS preview_stored
      FROM source_assets WHERE source_id=? ORDER BY position,id`).all(sourceId)
      .filter((asset) => assetIds.has(asset.id));
    if (!assets.length && placeholderQuote) {
      assets = this.db.prepare(`SELECT id,kind,remote_url,alt_text,position,mime_type,
        CASE WHEN ai_derivative_data_url<>'' THEN 1 ELSE 0 END AS preview_stored
        FROM source_assets WHERE source_id=? ORDER BY position,id LIMIT 3`).all(sourceId);
    }
    assets = assets.map((asset) => ({ id: asset.id, kind: asset.kind, position: asset.position,
      altText: asset.alt_text, mimeType: asset.mime_type, previewUrl: `/api/source-assets/${encodeURIComponent(asset.id)}/preview`,
      originalUrl: asset.remote_url, previewStored: Boolean(asset.preview_stored), matched: assetIds.has(asset.id) }));
    const exactQuote = placeholderQuote ? "" : String(sourceQuote || "").trim();
    const textExcerpt = sourceExcerpt(source.raw_text, exactQuote);
    const available = Boolean(exactQuote || spans.some((span) => span.quote || span.segmentText) || assets.length);
    return {
      available,
      reason: available ? "" : "当前记录没有保存可核验的原文片段或关联图片，请重新提取来源后再判断。",
      source: { id: source.id, title: source.title, authorName: source.author_name,
        canonicalUrl: source.canonical_url, capturedAt: source.captured_at },
      exactQuote, textExcerpt, spans, assets,
    };
  }

  prepareSourceSegments(sourceId) {
    const source = this.getSource(sourceId);
    if (!source) throw new Error(`Source ${sourceId} no longer exists.`);
    if (source.completeness_status !== "complete") throw Object.assign(
      new Error(`Source ${sourceId} is ${source.completeness_status}; complete capture evidence is required before extraction.`),
      { code: "SOURCE_CAPTURE_PARTIAL", retryable: false },
    );
    const stored = this.db.prepare("SELECT * FROM source_segments WHERE source_id=? AND capture_version=? ORDER BY sequence")
      .all(sourceId, source.capture_version);
    if (stored.length) return stored.filter((item) => !["complete", "extracted"].includes(item.status));
    const values = segmentSource(source, { maxChars: this.contentConfig.sourceTextSegmentMaxChars });
    const timestamp = now();
    transaction(this.db, () => {
      this.db.prepare("DELETE FROM source_segments WHERE source_id=?").run(sourceId);
      const insert = this.db.prepare(`INSERT INTO source_segments(id,source_id,segment_type,sequence,title,raw_text,page_start,page_end,asset_id,image_index,destination_scopes_json,topic_scopes_json,content_hash,semantic_hash,status,created_at,updated_at,capture_version)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending',?,?,?)`);
      for (const item of values) insert.run(item.id, sourceId, item.segmentType, item.sequence, item.title, item.rawText,
        item.pageStart, item.pageEnd, item.assetId, item.imageIndex, JSON.stringify(item.destinationScopes), JSON.stringify(item.topicScopes),
        item.contentHash, item.semanticHash, timestamp, timestamp, source.capture_version);
      this.db.prepare("UPDATE source_assets SET extraction_status='pending', extraction_error=NULL, processed_at=NULL WHERE source_id=?").run(sourceId);
      this.db.prepare("UPDATE sources SET status='processing', diagnostic_json=?, updated_at=? WHERE id=?")
        .run(JSON.stringify({ strategy_version: this.strategyVersion, stage: "segmented", segment_count: values.length, asset_count: source.assets.length }), timestamp, sourceId);
    });
    return values;
  }

  splitSourceSegmentForRetry(segmentId) {
    const segment = this.db.prepare("SELECT * FROM source_segments WHERE id=?").get(segmentId);
    if (!segment || segment.asset_id || String(segment.raw_text || "").length < 800) return [];
    const text = String(segment.raw_text);
    let midpoint = Math.floor(text.length / 2);
    const boundary = Math.max(text.lastIndexOf("。", midpoint), text.lastIndexOf(". ", midpoint), text.lastIndexOf("\n", midpoint));
    if (boundary > text.length * 0.25) midpoint = boundary + 1;
    const parts = [text.slice(0, midpoint).trim(), text.slice(midpoint).trim()].filter(Boolean);
    if (parts.length !== 2) return [];
    const timestamp = now();
    return transaction(this.db, () => {
      const maximum = this.db.prepare("SELECT COALESCE(MAX(sequence),-1) AS value FROM source_segments WHERE source_id=?").get(segment.source_id).value;
      this.db.prepare("DELETE FROM source_segments WHERE id=?").run(segmentId);
      const shift = maximum + 2;
      this.db.prepare("UPDATE source_segments SET sequence=sequence+? WHERE source_id=? AND sequence>?")
        .run(shift, segment.source_id, segment.sequence);
      this.db.prepare("UPDATE source_segments SET sequence=sequence-?+1 WHERE source_id=? AND sequence>?")
        .run(shift, segment.source_id, segment.sequence + shift);
      const insert = this.db.prepare(`INSERT INTO source_segments(id,source_id,segment_type,sequence,title,raw_text,page_start,page_end,
        asset_id,image_index,destination_scopes_json,topic_scopes_json,content_hash,semantic_hash,status,created_at,updated_at,capture_version)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending',?,?,?)`);
      return parts.map((rawText, index) => {
        const childSequence = segment.sequence + index;
        const childId = `segment_${sha256(`${segment.source_id}:${segment.capture_version}:${childSequence}:${rawText}`).slice(0, 24)}`;
        insert.run(childId, segment.source_id, segment.segment_type, childSequence,
          `${segment.title || `Segment ${segment.sequence + 1}`} · part ${index + 1}`, rawText, segment.page_start, segment.page_end,
          null, null, segment.destination_scopes_json, segment.topic_scopes_json, sha256(rawText),
          sha256(rawText.toLowerCase().replace(/\s+/g, " ").trim()), timestamp, timestamp, segment.capture_version);
        return { id: childId, sourceId: segment.source_id };
      });
    });
  }

  getSegmentExtractionPackage(segmentId) {
    const segment = this.db.prepare("SELECT * FROM source_segments WHERE id=?").get(segmentId);
    if (!segment) return null;
    const source = this.getSource(segment.source_id);
    if (segment.capture_version !== source?.capture_version) return { sourceId: segment.source_id, segment, staleCaptureVersion: true };
    const asset = segment.asset_id ? source.assets.find((item) => item.id === segment.asset_id) : null;
    return {
      sourceId: source.id, segment,
      source: { ...source, raw_text: segment.raw_text, assets: asset ? [asset] : [], title: segment.title || source.title,
        submission_metadata: { ...source.submission_metadata, segment_id: segment.id, segment_sequence: segment.sequence } },
    };
  }

  saveSegmentExtraction(segmentId, extraction, { retry = false } = {}) {
    const segment = this.db.prepare("SELECT * FROM source_segments WHERE id=?").get(segmentId);
    if (!segment) throw new Error(`Source segment ${segmentId} no longer exists.`);
    const sourceVersion = this.db.prepare("SELECT capture_version FROM sources WHERE id=?").get(segment.source_id)?.capture_version;
    if (segment.capture_version !== sourceVersion) return false;
    const timestamp = now();
    const attempt = retry ? 2 : 1;
    transaction(this.db, () => {
      this.db.prepare(`INSERT INTO segment_extractions(segment_id,source_id,result_json,method,model,attempt,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(segment_id) DO UPDATE SET result_json=excluded.result_json,method=excluded.method,
        model=excluded.model,attempt=excluded.attempt,updated_at=excluded.updated_at`)
        .run(segmentId, segment.source_id, JSON.stringify(extraction.result), extraction.method, extraction.model, attempt, timestamp, timestamp);
      this.db.prepare("UPDATE source_segments SET status='extracted',updated_at=? WHERE id=?").run(timestamp, segmentId);
      if (segment.asset_id) this.db.prepare("UPDATE source_assets SET extraction_status='processed',extraction_error=NULL,processed_at=? WHERE id=?")
        .run(timestamp, segment.asset_id);
    });
    return true;
  }

  getSegmentCoveragePackage(segmentId) {
    const row = this.db.prepare(`SELECT ss.*,se.result_json,se.method,se.model,se.attempt FROM source_segments ss
      JOIN segment_extractions se ON se.segment_id=ss.id WHERE ss.id=?`).get(segmentId);
    if (!row) return null;
    const coverage = this.db.prepare("SELECT * FROM extraction_coverage WHERE segment_id=?").get(segmentId);
    const source = this.getSource(row.source_id);
    if (row.capture_version !== source?.capture_version) return { segment: row, staleCaptureVersion: true };
    const asset = row.asset_id ? source?.assets.find((item) => item.id === row.asset_id) : null;
    return {
      segment: row, extraction: json(row.result_json, {}),
      source: source ? { ...source, raw_text: row.raw_text, assets: asset ? [asset] : [] } : null,
      expectedModality: row.asset_id ? (asset?.kind === "video" ? "video" : "image") : "text",
      coverage: coverage ? { ...coverage, uncovered_spans: json(coverage.uncovered_spans_json, []), audit: json(coverage.audit_json, {}) } : null,
    };
  }

  auditSegmentCoverage(segmentId, assessment = null) {
    const row = this.db.prepare(`SELECT s.*,se.result_json,se.method,se.model,se.attempt FROM source_segments s
      JOIN segment_extractions se ON se.segment_id=s.id WHERE s.id=?`).get(segmentId);
    if (!row) throw new Error(`Segment ${segmentId} has no extraction result.`);
    const sourceVersion = this.db.prepare("SELECT capture_version FROM sources WHERE id=?").get(row.source_id)?.capture_version;
    if (row.capture_version !== sourceVersion) return { status: "stale", sourceId: row.source_id };
    const result = json(row.result_json, {});
    const claims = Array.isArray(result.claims) ? result.claims : [];
    const expectedModality = row.asset_id ? (row.segment_type === "video_chapter" ? "video" : "image") : "text";
    const receivedModality = assessment?.modality?.received || (String(row.method || "").includes("video") ? "video"
      : String(row.method || "").includes("multimodal") ? "image" : "text");
    const supportedClaims = row.asset_id ? claims : claims.filter((claim) => locateEvidenceQuote(row.raw_text, claim.source_quote).status !== "unsupported");
    const material = String(row.raw_text || "").trim().length >= 40 || row.asset_id;
    const assessedUncovered = Array.isArray(assessment?.uncovered_spans) ? assessment.uncovered_spans
      .map((item) => ({ locator: String(item.quote || item.locator || row.title || `segment ${row.sequence + 1}`).slice(0, 800),
        importance: String(item.importance || "material"), reason: String(item.reason || "Material travel evidence is not covered by a Claim.").slice(0, 1000) }))
      .filter((item) => !unsupportedClaimAuditFalsePositive(item)) : null;
    const noSupportedClaimGap = !row.asset_id && material && supportedClaims.length === 0 && row.method !== "heuristic"
      ? [{ locator: row.title || `segment ${row.sequence + 1}`, importance: "material", reason: "Material segment produced no traceable Claim." }] : [];
    const modalityGap = row.asset_id && receivedModality !== expectedModality
      ? [{ locator: row.title || `segment ${row.sequence + 1}`, importance: "material", reason: `Expected ${expectedModality} evidence was not received by the model.` }] : [];
    const uncovered = [...(assessedUncovered || []), ...noSupportedClaimGap, ...modalityGap];
    const importantUncovered = uncovered.filter((item) => ["material", "important"].includes(item.importance)).length;
    const retryCount = Math.max(0, Number(row.attempt || 1) - 1);
    const bestEffortAccepted = importantUncovered > 0 && retryCount >= 1 && supportedClaims.length > 0 && modalityGap.length === 0;
    const status = importantUncovered ? bestEffortAccepted ? "passed" : retryCount < 1 ? "retry_required" : "manual_review" : "passed";
    const timestamp = now();
    const coverageId = `coverage_${sha256(segmentId).slice(0, 24)}`;
    const audit = { expectedModality, receivedModality, assetId: row.asset_id || null,
      attempted: Number(assessment?.modality?.attempted || 0), unsupportedClaimCount: claims.length - supportedClaims.length,
      bestEffortAccepted };
    this.db.prepare(`INSERT INTO extraction_coverage(id,source_id,segment_id,extraction_run_id,status,candidate_evidence_count,claim_count,uncovered_spans_json,important_uncovered_count,model,audited_at,retry_count,audit_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,
      candidate_evidence_count=excluded.candidate_evidence_count,claim_count=excluded.claim_count,uncovered_spans_json=excluded.uncovered_spans_json,
      important_uncovered_count=excluded.important_uncovered_count,model=excluded.model,audited_at=excluded.audited_at,retry_count=excluded.retry_count,audit_json=excluded.audit_json`)
      .run(coverageId, row.source_id, segmentId, null, status, supportedClaims.length + uncovered.length, supportedClaims.length, JSON.stringify(uncovered), importantUncovered, row.model, timestamp, retryCount, JSON.stringify(audit));
    this.db.prepare("UPDATE source_segments SET status=?,updated_at=? WHERE id=?")
      .run(status === "passed" ? "complete" : status === "manual_review" ? "failed" : status, timestamp, segmentId);
    if (row.asset_id && status !== "passed") this.db.prepare("UPDATE source_assets SET extraction_status=?,extraction_error=? WHERE id=?")
      .run(status === "retry_required" ? "retry_required" : "failed", uncovered[0]?.reason || null, row.asset_id);
    const sourceState = this.reconcileSourceCoverageState(row.source_id);
    return { sourceId: row.source_id, segmentId, status, retryCount, claimCount: supportedClaims.length, uncovered, sourceState, ...audit };
  }

  sourceCoverageReady(sourceId) {
    return this.reconcileSourceCoverageState(sourceId).ready;
  }

  reconcileSourceCoverageState(sourceId) {
    const counts = this.db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN ec.status='passed' THEN 1 ELSE 0 END) AS passed,
      SUM(CASE WHEN ec.status='manual_review' THEN 1 ELSE 0 END) AS manual_review,
      SUM(CASE WHEN ec.status IN ('passed','manual_review') THEN 1 ELSE 0 END) AS terminal
      FROM source_segments ss LEFT JOIN extraction_coverage ec ON ec.segment_id=ss.id WHERE ss.source_id=?`).get(sourceId);
    const total = Number(counts.total || 0);
    const passed = Number(counts.passed || 0);
    const manualReview = Number(counts.manual_review || 0);
    const terminal = Number(counts.terminal || 0);
    const ready = total > 0 && passed === total;
    const settled = total > 0 && terminal === total;
    const timestamp = now();
    if (settled && manualReview > 0) {
      const message = `覆盖审计在一次定向重试后仍发现未形成信息主张的重要证据，共 ${manualReview} 个分段需要人工检查。`;
      this.db.prepare("UPDATE sources SET status='exception',last_error=?,updated_at=? WHERE id=?")
        .run(message, timestamp, sourceId);
    } else {
      this.db.prepare(`UPDATE sources SET status='processing',last_error=NULL,updated_at=? WHERE id=?
        AND status='exception' AND (last_error LIKE 'Coverage audit still found material evidence without Claims%'
          OR last_error LIKE '覆盖审计在一次定向重试后仍发现未形成信息主张的重要证据%')`)
        .run(timestamp, sourceId);
    }
    return { total, passed, manualReview, terminal, ready, settled };
  }

  reviewSegmentCoverage(sourceId, segmentId, { decision, note = "", operator = "administrator" } = {}) {
    if (!["retry", "not_material"].includes(decision)) throw new Error("Coverage review decision must be retry or not_material.");
    const row = this.db.prepare(`SELECT ss.*,ec.id AS coverage_id,ec.status AS coverage_status,ec.audit_json
      FROM source_segments ss JOIN extraction_coverage ec ON ec.segment_id=ss.id
      WHERE ss.id=? AND ss.source_id=?`).get(segmentId, sourceId);
    if (!row) return null;
    if (row.coverage_status !== "manual_review") {
      const error = new Error("Only a segment awaiting manual coverage review can receive this decision.");
      error.statusCode = 409;
      throw error;
    }
    const timestamp = now();
    const audit = { ...json(row.audit_json, {}), manualReview: {
      decision, note: String(note || "").trim().slice(0, 1_000), operator: String(operator || "administrator").slice(0, 200), reviewedAt: timestamp,
    } };
    transaction(this.db, () => {
      if (decision === "not_material") {
        this.db.prepare(`UPDATE extraction_coverage SET status='passed',important_uncovered_count=0,
          uncovered_spans_json='[]',audit_json=?,audited_at=? WHERE id=?`).run(JSON.stringify(audit), timestamp, row.coverage_id);
        this.db.prepare("UPDATE source_segments SET status='complete',updated_at=? WHERE id=?").run(timestamp, segmentId);
        if (row.asset_id) this.db.prepare("UPDATE source_assets SET extraction_status='processed',extraction_error=NULL,processed_at=? WHERE id=?")
          .run(timestamp, row.asset_id);
      } else {
        this.db.prepare("UPDATE extraction_coverage SET status='retry_required',audit_json=?,audited_at=? WHERE id=?")
          .run(JSON.stringify(audit), timestamp, row.coverage_id);
        this.db.prepare("UPDATE source_segments SET status='retry_required',updated_at=? WHERE id=?").run(timestamp, segmentId);
        if (row.asset_id) this.db.prepare("UPDATE source_assets SET extraction_status='retry_required',extraction_error=NULL WHERE id=?")
          .run(row.asset_id);
        this.enqueue("retry_segment_extraction", segmentId);
      }
    });
    const sourceState = this.reconcileSourceCoverageState(sourceId);
    if (decision === "not_material" && sourceState.ready) this.enqueue("finalize_source_extraction", sourceId);
    return { sourceId, segmentId, decision, sourceState };
  }

  finalizeSegmentedExtraction(sourceId) {
    if (!this.sourceCoverageReady(sourceId)) throw new Error(`Source ${sourceId} still has unaudited segments.`);
    const sourceVersion = this.db.prepare("SELECT capture_version FROM sources WHERE id=?").get(sourceId)?.capture_version;
    const rows = this.db.prepare(`SELECT ss.*,se.result_json,se.method,se.model FROM source_segments ss
      JOIN segment_extractions se ON se.segment_id=ss.id WHERE ss.source_id=? ORDER BY ss.sequence`).all(sourceId);
    if (!rows.length || rows.some((row) => row.capture_version !== sourceVersion)) {
      throw Object.assign(new Error(`Source ${sourceId} extraction belongs to a stale capture version.`), { code: "STALE_CAPTURE_VERSION", retryable: false });
    }
    const results = rows.map((row) => ({ row, result: json(row.result_json, {}) }));
    const primary = results.map((item) => item.result.source).filter(Boolean).sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))[0]
      || { language: "unknown", summary: "", destination_name: "Unknown", destination_slug: "unknown", traveler_fit: [], practical_tips: [], warnings: [], confidence: 0 };
    const claims = results.flatMap((item) => (item.result.claims || [])
      .filter((claim) => item.row.asset_id || locateEvidenceQuote(item.row.raw_text, claim.source_quote).status !== "unsupported")
      .map((claim) => ({ ...claim, _segment_id: item.row.id, _asset_id: item.row.asset_id })));
    const blueprint = mergeBlueprints(results.map((item) => item.result.blueprint).filter(Boolean));
    const method = [...new Set(rows.map((row) => row.method))].join("+");
    const model = [...new Set(rows.map((row) => row.model).filter(Boolean))].join(", ") || null;
    this.saveExtraction(sourceId, { source: primary, claims, blueprint }, method, model, { deferDownstream: true });
    const savedClaims = this.db.prepare("SELECT id,normalized_key,value_text,source_quote,source_quote_start,source_quote_end FROM claims WHERE source_id=?").all(sourceId);
    const savedByEvidence = Map.groupBy(savedClaims, (claim) => `${claim.normalized_key}\u0000${claim.value_text}\u0000${claim.source_quote}`);
    for (const input of claims) {
      const lookup = `${normalizeClaimKey(input.key)}\u0000${input.value}\u0000${input.source_quote}`;
      const claim = savedByEvidence.get(lookup)?.shift();
      if (!claim) continue;
      const spanId = `span_${sha256(`${claim.id}:${input._segment_id}`).slice(0, 24)}`;
      const segment = rows.find((item) => item.id === input._segment_id);
      this.db.prepare(`INSERT OR IGNORE INTO evidence_spans(id,source_id,segment_id,asset_id,locator_type,page,image_index,quote,region_json,created_at,start_offset,end_offset)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(spanId, sourceId, input._segment_id, input._asset_id || null,
        input._asset_id ? "asset" : segment?.page_start ? "page" : "text", segment?.page_start || null, segment?.image_index || null,
        claim.source_quote || "", "{}", now(), claim.source_quote_start, claim.source_quote_end);
      this.db.prepare("UPDATE claims SET evidence_span_ids_json=?,destination_scopes_json=?,topic_scopes_json=?,source_authority_level=(SELECT authority_level FROM sources WHERE id=?) WHERE id=?")
        .run(JSON.stringify([spanId]), JSON.stringify([primary.destination_slug].filter(Boolean)), JSON.stringify([]), sourceId, claim.id);
    }
    this.db.prepare("UPDATE sources SET destination_scopes_json=?,diagnostic_json=?,updated_at=? WHERE id=?")
      .run(JSON.stringify([primary.destination_slug].filter(Boolean)), JSON.stringify({ strategy_version: this.strategyVersion, stage: "finalized", segment_count: rows.length, claim_count: claims.length,
        coverage: this.db.prepare("SELECT status,COUNT(*) count FROM extraction_coverage WHERE source_id=? GROUP BY status").all(sourceId) }), now(), sourceId);
    return { destinationSlug: primary.destination_slug, claimCount: claims.length };
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
        authorization_status: source.authorization_status,
        editing_allowed: source.editing_allowed,
        redistribution_allowed: source.redistribution_allowed,
        publishable: source.publishable,
        editorial_blueprint: source.blueprint ? {
          format: source.blueprint.format, hook: source.blueprint.hook, angle: source.blueprint.angle,
          sections: source.blueprint.sections, strengths: source.blueprint.strengths, gaps: source.blueprint.gaps,
        } : null,
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
          updated_at=excluded.updated_at
      `).run(recommendationId, analysisId, sourceId, this.strategyVersion, normalized.classification,
        normalized.recommended_action, normalized.suggested_content_type || null, normalized.suggested_article_title || null,
        normalized.reasoning_summary, timestamp, timestamp);
    });
    const recommendation = this.db.prepare("SELECT * FROM content_recommendations WHERE analysis_id=?").get(analysisId);
    this.db.prepare(`DELETE FROM content_opportunities WHERE recommendation_id=? AND strategy_version<>?
      AND status IN ('recommended','knowledge_only','cluster','research_required','ignored')`).run(recommendation.id, this.strategyVersion);
    this.upsertContentOpportunity(source.destination_slug, sourceId, recommendation, normalized);
    for (const path of normalized.production_paths || []) {
      const sameAsPrimary = path.title === normalized.suggested_article_title
        && normalizePublicationMode(path.mode) === normalizePublicationMode(normalized.production_mode)
        && normalizeContentType(path.content_type) === normalizeContentType(normalized.suggested_content_type);
      if (sameAsPrimary) continue;
      this.upsertContentOpportunity(source.destination_slug, sourceId, recommendation, {
        ...normalized,
        primary_topic: path.title,
        suggested_article_title: path.title,
        suggested_content_type: path.content_type || normalized.suggested_content_type,
        production_mode: path.mode,
      }, { linkRecommendation: false });
    }
    return this.getSource(sourceId).analysis;
  }

  listContentRecommendations(limit = 100) {
    const rows = this.db.prepare(`
      SELECT r.*, a.confidence, a.primary_topic, a.article_potential, a.information_density, a.topic_completeness,
        a.duplicate_likelihood, a.analysis_json, s.title AS source_title, ss.destination_name, ss.destination_slug
      FROM content_recommendations r
      JOIN content_intake_analyses a ON a.id=r.analysis_id
      JOIN sources s ON s.id=r.source_id
      LEFT JOIN structured_sources ss ON ss.source_id=r.source_id
      ORDER BY CASE r.decision WHEN 'pending' THEN 0 ELSE 1 END, r.updated_at DESC LIMIT ?
    `).all(limit);
    const listOpportunities = this.db.prepare(`SELECT id,title,status,readiness_json,coverage_json,candidate_id
      FROM content_opportunities WHERE recommendation_id=? ORDER BY created_at,id`);
    return rows.map((row) => hydrateRecommendation(row, listOpportunities.all(row.id)));
  }

  listContentOpportunities(limit = 100) {
    return this.db.prepare(`
      SELECT o.*, tc.coverage_score AS candidate_coverage_score, tc.status AS candidate_status
      FROM content_opportunities o LEFT JOIN topic_candidates tc ON tc.id=o.candidate_id
      ORDER BY CASE o.status WHEN 'recommended' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, o.readiness_score DESC, o.updated_at DESC
      LIMIT ?
    `).all(limit).map((row) => ({
      ...row,
      coverage: json(row.coverage_json, {}),
      readiness: json(row.readiness_json, {}),
      publicationImpact: json(row.publication_impact_json, {}),
    }));
  }

  setOpportunityLifecycle(opportunityId, action, { targetPostId = null, note = "", operator = "administrator" } = {}) {
    const allowed = new Set(["create", "update", "merge", "retire"]);
    if (!allowed.has(action)) throw new Error("Unsupported opportunity lifecycle action.");
    const opportunity = this.db.prepare("SELECT * FROM content_opportunities WHERE id=?").get(opportunityId);
    if (!opportunity) return null;
    let target = null;
    if (action !== "create") {
      const numericPostId = Number(targetPostId);
      if (!Number.isInteger(numericPostId) || numericPostId <= 0) throw new Error("A published WordPress target is required for this lifecycle action.");
      target = this.db.prepare("SELECT * FROM wordpress_content_inventory WHERE post_id=? AND status='publish' ORDER BY synced_at DESC LIMIT 1").get(numericPostId);
      if (!target) throw new Error("The lifecycle target is not present as a published WordPress inventory item.");
    }
    const impact = {
      existingUrl: target?.post_url || null,
      existingTitle: target?.title || null,
      requiresEditorialApproval: action !== "create",
      operator: String(operator || "administrator").slice(0, 120),
      note: String(note || "").slice(0, 1_000),
      decidedAt: now(),
    };
    this.db.prepare(`UPDATE content_opportunities
      SET lifecycle_action=?,target_post_id=?,publication_impact_json=?,updated_at=? WHERE id=?`)
      .run(action, target?.post_id || null, JSON.stringify(impact), impact.decidedAt, opportunityId);
    return {
      id: opportunityId,
      lifecycleAction: action,
      targetPostId: target?.post_id || null,
      publicationImpact: impact,
    };
  }

  decideRecommendation(recommendationId, decision, note = "", { opportunityId = null } = {}) {
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
    const timestamp = now();
    let opportunity = opportunityId && decision === "approved_article"
      ? this.db.prepare("SELECT * FROM content_opportunities WHERE id=? AND recommendation_id=?").get(opportunityId, recommendationId)
      : recommendation.opportunity_id
        ? this.db.prepare("SELECT * FROM content_opportunities WHERE id=? AND recommendation_id=?").get(recommendation.opportunity_id, recommendationId)
        : this.db.prepare("SELECT * FROM content_opportunities WHERE recommendation_id=? ORDER BY created_at,id LIMIT 1").get(recommendationId);
    if (opportunityId && decision === "approved_article" && !opportunity) throw new Error("The selected production path does not belong to this recommendation.");
    if (!opportunity) {
      this.upsertContentOpportunity(recommendation.destination_slug, recommendation.source_id, recommendation, analysis);
      opportunity = this.db.prepare("SELECT * FROM content_opportunities WHERE recommendation_id=?").get(recommendationId);
    }
    const readiness = json(opportunity?.readiness_json || opportunity?.coverage_json, {});
    const ready = Boolean(readiness.ready);
    const opportunityStatus = decision === "approved_article" ? ready ? "approved_ready" : "approved_waiting_for_evidence"
      : decision === "knowledge_only" ? "knowledge_only" : decision === "cluster" ? "cluster"
        : decision === "research_first" ? "research_required" : "ignored";
    this.db.prepare(`
      UPDATE content_recommendations SET decision=?, decision_note=?, approved_candidate_id=NULL, opportunity_id=?, decided_at=?, updated_at=? WHERE id=?
    `).run(decision, String(note || "").slice(0, 1_000), opportunity.id, timestamp, timestamp, recommendationId);
    this.db.prepare("UPDATE content_opportunities SET status=?,approved_at=?,updated_at=? WHERE id=?")
      .run(opportunityStatus, decision === "approved_article" ? timestamp : null, timestamp, opportunity.id);
    const reconciled = decision === "approved_article" && ready ? this.reconcileApprovedOpportunity(opportunity.id) : { candidateId: null, queued: false };
    return {
      recommendationId, opportunityId: opportunity.id, decision, status: opportunityStatus,
      queued: Boolean(reconciled.queued), candidateId: reconciled.candidateId || null,
      needsEvidence: decision === "approved_article" && !ready, readiness,
    };
  }

  upsertContentOpportunity(destinationSlug, sourceId, recommendation, analysis, overrides = {}) {
    const topic = analysis.primary_topic || analysis.suggested_article_title || recommendation.suggested_article_title || "travel topic";
    const contentType = normalizeContentType(analysis.suggested_content_type || recommendation.suggested_content_type);
    const sourceRights = this.db.prepare("SELECT authorization_status,editing_allowed FROM sources WHERE id=?").get(sourceId);
    const requestedMode = normalizePublicationMode(analysis.production_mode
      || (analysis.classification === "ARTICLE_CANDIDATE" ? "TOPIC_FEATURE" : "MULTI_SOURCE_SYNTHESIS"));
    const publicationMode = requestedMode === "source_adaptation" && !Boolean(sourceRights?.editing_allowed)
      ? "topic_feature" : requestedMode;
    const title = analysis.suggested_article_title || recommendation.suggested_article_title || `${topic} guide`;
    const baseTopicKey = stableOpportunityKey(destinationSlug, title, contentType);
    // Intake suggestions remain independently actionable even when another author proposes
    // the same broad topic. Cross-source synthesis still reads destination-wide facts, but
    // choosing it must not consume or overwrite this source's adaptation or feature routes.
    const topicKey = `${baseTopicKey}:source:${sha256(sourceId).slice(0, 12)}`;
    const opportunityId = `opportunity_${sha256(topicKey).slice(0, 24)}`;
    const allFacts = this.knowledgeForDestination(destinationSlug);
    const sourceFacts = factsForSource(allFacts, sourceId);
    const facts = ["source_adaptation", "topic_feature"].includes(publicationMode) && sourceFacts.length
      ? sourceFacts : scopeFactsForOpportunity(allFacts, { destinationSlug, topic, title });
    const familyCount = this.independentSourceFamilyCountForFacts(facts);
    const matrix = evaluateCoverage({ topicKey, contentType, facts, sourceFamilyCount: familyCount, publicationMode });
    const coverage = { ...matrix, publicationMode, selectedFactKeys: facts.map((fact) => fact.normalized_key),
      selectedSourceIds: [...new Set(facts.flatMap((fact) => (fact.evidence || []).map((item) => item.source_id)).filter(Boolean))],
      legacy_signals: opportunityCoverage(destinationSlug, facts, analysis) };
    const status = overrides.status || classificationOpportunityStatus(analysis.classification);
    const candidateId = overrides.candidateId || recommendation.approved_candidate_id || null;
    const lifecycle = this.classifyPublicationLifecycle(title);
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO content_opportunities(id,destination_slug,destination_scopes_json,topic_key,strategy_version,source_id,source_ids_json,recommendation_id,
        candidate_id,title,content_type,readiness_score,readiness_json,coverage_json,status,created_at,updated_at,
        lifecycle_action,target_post_id,publication_impact_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(topic_key) DO UPDATE SET recommendation_id=excluded.recommendation_id, candidate_id=excluded.candidate_id,
        title=excluded.title, content_type=excluded.content_type, readiness_score=excluded.readiness_score,
        readiness_json=excluded.readiness_json,coverage_json=excluded.coverage_json,
        status=CASE WHEN content_opportunities.status IN ('approved_waiting_for_evidence','approved_ready','producing','drafted','qa_failed','ready_for_wordpress','wordpress_draft','suppressed') THEN content_opportunities.status ELSE excluded.status END,
        source_ids_json=CASE WHEN instr(content_opportunities.source_ids_json, excluded.source_id)>0 THEN content_opportunities.source_ids_json ELSE json_insert(content_opportunities.source_ids_json,'$[#]',excluded.source_id) END,
        lifecycle_action=excluded.lifecycle_action,target_post_id=excluded.target_post_id,
        publication_impact_json=excluded.publication_impact_json,updated_at=excluded.updated_at
    `).run(opportunityId,destinationSlug,JSON.stringify([destinationSlug]),topicKey,this.strategyVersion,sourceId,JSON.stringify([sourceId]),recommendation.id,candidateId,
      title,contentType,matrix.readiness.score,JSON.stringify(matrix.readiness),JSON.stringify(coverage),status,timestamp,timestamp,
      lifecycle.action,lifecycle.targetPostId,JSON.stringify(lifecycle.impact));
    if (overrides.linkRecommendation !== false) {
      this.db.prepare("UPDATE content_recommendations SET opportunity_id=? WHERE id=?").run(opportunityId, recommendation.id);
    }
    this.saveCoverageMatrix(matrix, destinationSlug);
    return opportunityId;
  }

  analyzeSourceFamily(sourceId) {
    const source = this.getSource(sourceId);
    if (!source?.structured) return null;
    const peers = this.db.prepare(`SELECT s.* FROM sources s JOIN structured_sources ss ON ss.source_id=s.id
      WHERE ss.destination_slug=? AND s.id<>? ORDER BY s.captured_at DESC`).all(source.structured.destination_slug, sourceId);
    let best = null;
    for (const peer of peers) {
      const relation = classifySourceFamily(source, peer);
      if (!best || relation.overlapScore > best.overlapScore) best = { ...relation, peer };
    }
    const shareFamily = best && ["EXACT_DUPLICATE", "NEAR_DUPLICATE", "DERIVED_FROM"].includes(best.relation);
    const peerMembership = shareFamily ? this.db.prepare("SELECT family_id FROM source_family_memberships WHERE source_id=?").get(best.peer.id) : null;
    const familyKey = peerMembership?.family_id || `family_${sha256(shareFamily ? best.peer.id : sourceId).slice(0, 24)}`;
    const timestamp = now();
    const peerKeys = shareFamily ? new Set(this.db.prepare("SELECT normalized_key FROM claims WHERE source_id=?").all(best.peer.id).map((row) => row.normalized_key)) : new Set();
    const sourceKeys = this.db.prepare("SELECT normalized_key FROM claims WHERE source_id=?").all(sourceId).map((row) => row.normalized_key);
    const incremental = sourceKeys.filter((key) => !peerKeys.has(key)).length;
    this.db.prepare(`INSERT INTO source_families(id,family_key,canonical_source_id,created_at,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(family_key) DO UPDATE SET updated_at=excluded.updated_at`).run(familyKey, familyKey, shareFamily ? best.peer.id : sourceId, timestamp, timestamp);
    this.db.prepare(`INSERT INTO source_family_memberships(family_id,source_id,relation_type,overlap_score,incremental_claim_count,related_source_id,analysis_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET family_id=excluded.family_id,relation_type=excluded.relation_type,
      overlap_score=excluded.overlap_score,incremental_claim_count=excluded.incremental_claim_count,related_source_id=excluded.related_source_id,
      analysis_json=excluded.analysis_json,updated_at=excluded.updated_at`)
      .run(familyKey, sourceId, best?.relation || "INDEPENDENT", best?.overlapScore || 0, incremental, best?.peer.id || null, JSON.stringify(best || {}), timestamp, timestamp);
    return { familyId: familyKey, relation: best?.relation || "INDEPENDENT", incrementalClaimCount: incremental };
  }

  independentSourceFamilyCount(destinationSlug) {
    return Number(this.db.prepare(`SELECT COUNT(DISTINCT sfm.family_id) AS count FROM source_family_memberships sfm
      JOIN structured_sources ss ON ss.source_id=sfm.source_id WHERE ss.destination_slug=?`).get(destinationSlug)?.count || 0);
  }

  independentSourceFamilyCountForFacts(facts) {
    const sourceIds = [...new Set((facts || []).flatMap((fact) => (fact.evidence || []).map((item) => item.source_id)).filter(Boolean))];
    if (!sourceIds.length) return 0;
    const placeholders = sourceIds.map(() => "?").join(",");
    return Number(this.db.prepare(`SELECT COUNT(DISTINCT family_id) AS count FROM source_family_memberships WHERE source_id IN (${placeholders})`)
      .get(...sourceIds)?.count || 0);
  }

  rebuildTopicClusters(destinationSlug) {
    const facts = this.knowledgeForDestination(destinationSlug);
    const grouped = Map.groupBy(facts, (fact) => slugify(fact.subject || "general") || "general");
    const timestamp = now();
    for (const [subject, values] of grouped) {
      const topicKey = `${destinationSlug}:cluster:${subject}`;
      this.db.prepare(`INSERT INTO topic_clusters(id,destination_slug,topic_key,title,claim_keys_json,source_family_ids_json,updated_at)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(topic_key) DO UPDATE SET title=excluded.title,claim_keys_json=excluded.claim_keys_json,
        source_family_ids_json=excluded.source_family_ids_json,updated_at=excluded.updated_at`)
        .run(`cluster_${sha256(topicKey).slice(0, 24)}`, destinationSlug, topicKey, values[0]?.subject || subject,
          JSON.stringify(values.map((item) => item.normalized_key)), JSON.stringify([]), timestamp);
    }
    return grouped.size;
  }

  rebuildCoverageMatrices(destinationSlug) {
    const allFacts = this.knowledgeForDestination(destinationSlug);
    const opportunities = this.db.prepare("SELECT * FROM content_opportunities WHERE destination_slug=?").all(destinationSlug);
    for (const opportunity of opportunities) {
      const previousCoverage = json(opportunity.coverage_json, {});
      const publicationMode = normalizePublicationMode(previousCoverage.publicationMode);
      const sourceFacts = factsForSource(allFacts, opportunity.source_id);
      const facts = ["source_adaptation", "topic_feature"].includes(publicationMode) && sourceFacts.length
        ? sourceFacts : scopeFactsForOpportunity(allFacts, { destinationSlug, topic: opportunity.topic_key, title: opportunity.title });
      const familyCount = this.independentSourceFamilyCountForFacts(facts);
      const matrix = evaluateCoverage({ topicKey: opportunity.topic_key, contentType: opportunity.content_type, facts, sourceFamilyCount: familyCount, publicationMode });
      const coverage = { ...matrix, publicationMode, selectedFactKeys: facts.map((fact) => fact.normalized_key),
        selectedSourceIds: [...new Set(facts.flatMap((fact) => (fact.evidence || []).map((item) => item.source_id)).filter(Boolean))] };
      this.saveCoverageMatrix(matrix, destinationSlug);
      const current = opportunity.status;
      const next = current === "approved_waiting_for_evidence" && matrix.readiness.ready ? "approved_ready" : current;
      this.db.prepare("UPDATE content_opportunities SET readiness_score=?,readiness_json=?,coverage_json=?,status=?,updated_at=? WHERE id=?")
        .run(matrix.readiness.score, JSON.stringify(matrix.readiness), JSON.stringify(coverage), next, now(), opportunity.id);
    }
    return opportunities.length;
  }

  saveCoverageMatrix(matrix, destinationSlug) {
    const timestamp = now();
    this.db.prepare(`INSERT INTO coverage_matrices(id,topic_key,destination_slug,content_type,requirements_json,readiness_json,strategy_version,generated_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(topic_key) DO UPDATE SET requirements_json=excluded.requirements_json,
      readiness_json=excluded.readiness_json,strategy_version=excluded.strategy_version,generated_at=excluded.generated_at,updated_at=excluded.updated_at`)
      .run(`matrix_${sha256(matrix.topicKey).slice(0, 24)}`, matrix.topicKey, destinationSlug, matrix.contentType,
        JSON.stringify(matrix.requirements), JSON.stringify(matrix.readiness), this.strategyVersion, timestamp, timestamp);
  }

  reconcileApprovedOpportunity(opportunityId) {
    const opportunity = this.db.prepare("SELECT * FROM content_opportunities WHERE id=?").get(opportunityId);
    if (!opportunity || !["approved_ready", "producing"].includes(opportunity.status)) return { candidateId: opportunity?.candidate_id || null, queued: false };
    const readiness = json(opportunity.readiness_json, {});
    if (!readiness.ready) {
      this.db.prepare("UPDATE content_opportunities SET status='approved_waiting_for_evidence',updated_at=? WHERE id=?").run(now(), opportunityId);
      return { candidateId: null, queued: false };
    }
    const collision = this.findWordPressCollision(opportunity.title) || this.findSearchConsoleCollision(opportunity.title);
    if (collision) {
      const reason = collision.post_id ? `wordpress:${collision.post_id}:${collision.title || collision.slug}` : `search_console:${collision.id}:${collision.query}`;
      this.db.prepare("UPDATE content_opportunities SET status='suppressed',suppression_reason=?,updated_at=? WHERE id=?").run(reason, now(), opportunityId);
      return { candidateId: null, queued: false, suppressed: true };
    }
    const candidateId = opportunity.candidate_id || `topic_${sha256(opportunity.topic_key).slice(0, 24)}`;
    const timestamp = now();
    this.db.prepare(`INSERT INTO topic_candidates(id,destination_slug,topic_key,proposed_title,rationale,coverage_score,evidence_count,conflict_count,stale_fact_count,verification_fact_count,strategy_version,created_at,updated_at,opportunity_id,recommendation_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(topic_key) DO UPDATE SET opportunity_id=excluded.opportunity_id,
      recommendation_id=excluded.recommendation_id,coverage_score=excluded.coverage_score,updated_at=excluded.updated_at`)
      .run(candidateId, opportunity.destination_slug, opportunity.topic_key, opportunity.title,
        `Approved Strategy 1.4 opportunity with ${readiness.factCount || 0} facts from ${readiness.sourceFamilyCount || 0} independent source families.`,
        readiness.score || 0, readiness.sourceFamilyCount || 0, readiness.conflictedCount || 0, readiness.staleCount || 0,
        readiness.requiresOfficialCount || 0, this.strategyVersion, timestamp, timestamp, opportunityId, opportunity.recommendation_id);
    this.db.prepare("UPDATE content_opportunities SET candidate_id=?,status='producing',updated_at=? WHERE id=?").run(candidateId, timestamp, opportunityId);
    this.db.prepare("UPDATE content_recommendations SET approved_candidate_id=?,opportunity_id=?,updated_at=? WHERE id=?")
      .run(candidateId, opportunityId, timestamp, opportunity.recommendation_id);
    return { candidateId, queued: this.queueCandidate(candidateId) };
  }

  reconcileApprovedOpportunities(destinationSlug = null) {
    const rows = destinationSlug
      ? this.db.prepare("SELECT id FROM content_opportunities WHERE destination_slug=? AND status IN ('approved_waiting_for_evidence','approved_ready')").all(destinationSlug)
      : this.db.prepare("SELECT id FROM content_opportunities WHERE status IN ('approved_waiting_for_evidence','approved_ready')").all();
    const results = [];
    for (const row of rows) {
      const opportunity = this.db.prepare("SELECT * FROM content_opportunities WHERE id=?").get(row.id);
      if (opportunity.status === "approved_waiting_for_evidence") {
        this.rebuildCoverageMatrices(opportunity.destination_slug);
      }
      results.push(this.reconcileApprovedOpportunity(row.id));
    }
    return results;
  }

  listSources(limit = 100) {
    const sources = this.db.prepare(`
      SELECT s.id, s.adapter, s.external_id, s.title, s.author_name, s.canonical_url, s.submitted_url, s.source_kind,
        s.status, s.last_error, s.captured_at, s.capture_version, s.authority_level, s.verified_at,
        ss.destination_name, ss.summary, ss.extraction_method,
        (SELECT COUNT(*) FROM claims c WHERE c.source_id = s.id) AS claim_count,
        (SELECT COUNT(*) FROM source_files sf WHERE sf.source_id = s.id) AS file_count,
        (SELECT COUNT(*) FROM source_segments sg WHERE sg.source_id = s.id) AS segment_count,
        (SELECT COUNT(*) FROM segment_extractions se WHERE se.source_id = s.id) AS extracted_segment_count,
        (SELECT COUNT(*) FROM extraction_coverage ec WHERE ec.source_id = s.id AND ec.audited_at IS NOT NULL) AS audited_segment_count
      FROM sources s LEFT JOIN structured_sources ss ON ss.source_id = s.id
      ORDER BY s.captured_at DESC, s.id DESC LIMIT ?
    `).all(limit);
    const queueJobs = this.db.prepare(`
      SELECT j.id,j.type,j.entity_id,j.status,j.attempts,j.max_attempts,j.available_at,j.created_at,j.started_at,j.updated_at,j.last_error,
        COALESCE(sg.source_id,j.entity_id) AS source_id
      FROM jobs j LEFT JOIN source_segments sg ON sg.id=j.entity_id
      WHERE j.type IN ('extract_source','preflight_source','segment_source','extract_segment_claims',
        'audit_segment_coverage','retry_segment_extraction','finalize_source_extraction')
        AND j.status IN ('queued','running','failed')
        AND (sg.source_id IS NOT NULL OR EXISTS (SELECT 1 FROM sources direct_source WHERE direct_source.id=j.entity_id))
    `).all();
    const queueStates = sourceQueueStates(queueJobs);
    return sources.map((source, index) => {
      const queue = queueStates.get(source.id) || null;
      return { ...source, list_number: index + 1, authority_suggestion: suggestAuthority(source.canonical_url),
        queue: source.status === "processed" && queue?.state === "failed" ? null : queue };
    });
  }

  reviewSourceEvidence(sourceId, { decision, authorityLevel = 4, verifiedAt = null, note = "", operator = "administrator" } = {}) {
    if (!["verified", "unverified", "rejected"].includes(decision)) throw new Error("Evidence decision must be verified, unverified, or rejected.");
    const source = this.db.prepare("SELECT * FROM sources WHERE id=?").get(sourceId);
    if (!source) return null;
    const level = decision === "rejected" ? 4 : Math.max(1, Math.min(4, Number(authorityLevel) || 4));
    const verified = decision === "verified" ? (verifiedAt && !Number.isNaN(Date.parse(verifiedAt)) ? new Date(verifiedAt).toISOString() : now()) : null;
    const timestamp = now();
    transaction(this.db, () => {
      this.db.prepare(`INSERT INTO source_evidence_reviews(id,source_id,previous_authority_level,authority_level,
        previous_verified_at,verified_at,decision,note,operator,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(id("evidence_review"), sourceId, source.authority_level, level, source.verified_at, verified, decision,
          String(note).slice(0, 2_000), String(operator).slice(0, 200), timestamp);
      this.db.prepare("UPDATE sources SET authority_level=?,verified_at=?,updated_at=? WHERE id=?").run(level, verified, timestamp, sourceId);
      this.db.prepare("UPDATE claims SET source_authority_level=?,verified_at=? WHERE source_id=?").run(level, verified, sourceId);
    });
    const destination = this.db.prepare("SELECT destination_slug FROM structured_sources WHERE source_id=?").get(sourceId)?.destination_slug;
    if (destination) this.enqueue("rebuild_knowledge", destination);
    return { sourceId, decision, authorityLevel: level, verifiedAt: verified, authoritySuggestion: suggestAuthority(source.canonical_url) };
  }

  listSourceEvidenceReviews(sourceId) {
    return this.db.prepare("SELECT * FROM source_evidence_reviews WHERE source_id=? ORDER BY created_at DESC").all(sourceId);
  }

  saveExtraction(sourceId, result, method, model = null, { deferDownstream = false } = {}) {
    const timestamp = now();
    const sourceEvidence = this.db.prepare("SELECT raw_text,published_at FROM sources WHERE id=?").get(sourceId) || { raw_text: "", published_at: null };
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
          extraction_run_id, extraction_revision, claim_role, knowledge_eligible,
          source_quote_start, source_quote_end, source_quote_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const claim of result.claims) {
        const normalizedKey = normalizeClaimKey(claim.key);
        const inferredEntity = inferEntityIdentity(normalizedKey, claim.subject, claim.predicate);
        const entityMetadata = inferEntityMetadata(claim.subject, inferredEntity.entityKey);
        const structured = structureClaim({ predicate: claim.predicate, value: claim.value, qualifiers: claim.qualifiers, sourceQuote: claim.source_quote });
        const claimRole = normalizeClaimRole(claim.claim_role, claim.subject, claim.predicate);
        let locatedQuote = claim._asset_id ? { quote: String(claim.source_quote || "").slice(0, 800), start: null, end: null, status: "visual" }
          : locateEvidenceQuote(sourceEvidence.raw_text, claim.source_quote);
        // Direct saveExtraction remains a compatibility boundary for pre-segmentation
        // imports. The production segmented path sets deferDownstream and is strict.
        if (!deferDownstream && locatedQuote.status === "unsupported") locatedQuote = {
          quote: String(claim.source_quote || "").slice(0, 800), start: null, end: null, status: "legacy",
        };
        const knowledgeEligible = locatedQuote.status !== "unsupported" && (claim.knowledge_eligible === true
          || (claim.knowledge_eligible == null && !["personal_experience", "editorial_metadata", "promotional_observation"].includes(claimRole)));
        insertClaim.run(
          id("claim"), sourceId, normalizedKey, claim.subject, claim.predicate, claim.value,
          JSON.stringify(claim.qualifiers), locatedQuote.quote, claim.confidence, timestamp, normalizedKey,
          inferredEntity.entityKey, inferredEntity.canonicalSubject, JSON.stringify(inferredEntity.aliases), inferredEntity.status,
          entityMetadata.entityType, entityMetadata.granularity, JSON.stringify(entityMetadata.location),
          JSON.stringify(structured), JSON.stringify(structured.scope), structured.claim_kind, structured.cardinality,
          extractionRunId, extractionRevision,
          claimRole, knowledgeEligible ? 1 : 0, locatedQuote.start, locatedQuote.end, locatedQuote.status,
        );
      }
      this.db.prepare(`UPDATE sources SET observed_at=COALESCE(observed_at,published_at) WHERE id=?`).run(sourceId);
      this.db.prepare(`UPDATE claims SET observed_at=(SELECT COALESCE(observed_at,published_at) FROM sources WHERE id=?),
        temporal_confidence=CASE WHEN (SELECT published_at FROM sources WHERE id=?) IS NULL THEN 'unknown' ELSE 'medium' END,
        source_authority_level=(SELECT authority_level FROM sources WHERE id=?) WHERE source_id=?`)
        .run(sourceId, sourceId, sourceId, sourceId);
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
      if (!deferDownstream) {
        this.enqueue("resolve_entities", result.source.destination_slug);
        this.enqueue("rebuild_editorial", "global");
      }
    });
  }

  saveSourceBlueprint(sourceId, blueprint) {
    const value = blueprint || {};
    const timestamp = now();
    this.db.prepare(`INSERT INTO source_blueprints(source_id,format,hook,angle,sections_json,strengths_json,gaps_json,extracted_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET format=excluded.format,hook=excluded.hook,
      angle=excluded.angle,sections_json=excluded.sections_json,strengths_json=excluded.strengths_json,
      gaps_json=excluded.gaps_json,extracted_at=excluded.extracted_at`)
      .run(sourceId, String(value.format || "unclassified").slice(0, 200), String(value.hook || "").slice(0, 500),
        String(value.angle || "").slice(0, 500), JSON.stringify(value.sections || []), JSON.stringify(value.strengths || []),
        JSON.stringify(value.gaps || []), timestamp);
    return this.db.prepare("SELECT * FROM source_blueprints WHERE source_id=?").get(sourceId);
  }

  getEntityResolutionPackage(destinationSlug, limit = 300) {
    const rows = this.db.prepare(`
      SELECT c.id, c.normalized_key, c.original_normalized_key, c.subject, c.predicate, c.value_text,
        c.source_quote, c.confidence, c.entity_key, c.canonical_subject, c.entity_aliases_json,
        c.entity_type, c.granularity, c.entity_location_json,
        s.captured_at, s.title AS source_title
      FROM claims c JOIN structured_sources ss ON ss.source_id=c.source_id
      JOIN sources s ON s.id=c.source_id
      WHERE ss.destination_slug=? AND c.knowledge_eligible=1 AND c.lifecycle_status='active'
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
      SELECT c.* FROM claims c JOIN structured_sources ss ON ss.source_id=c.source_id
      WHERE ss.destination_slug=? AND c.lifecycle_status='active'
    `).all(destinationSlug);
    const aliasesByNormalized = new Map(this.db.prepare(
      "SELECT * FROM entity_aliases WHERE destination_slug=?",
    ).all(destinationSlug).map((row) => [row.alias_normalized, row]));
    const timestamp = now();
    transaction(this.db, () => {
      const updateClaimIdentity = this.db.prepare(`
        UPDATE claims SET original_normalized_key=CASE WHEN original_normalized_key='' THEN ? ELSE original_normalized_key END,
          entity_key=?, canonical_subject=?, entity_aliases_json=?, entity_resolution_status=?, entity_type=?, granularity=?,
          entity_location_json=? WHERE id=?
      `);
      for (const row of rows) {
        const originalKey = row.original_normalized_key || row.normalized_key;
        const inferred = inferEntityIdentity(originalKey, row.subject, row.predicate);
        const inferredMetadata = inferEntityMetadata(row.subject, inferred.entityKey, { entityType: row.entity_type, granularity: row.granularity, location: json(row.entity_location_json, {}) });
        const alias = normalizeEntityAlias(row.subject);
        const mapped = alias ? aliasesByNormalized.get(alias) : null;
        const identity = mapped ? {
          entityKey: mapped.entity_key,
          canonicalSubject: mapped.canonical_subject,
          aliases: json(mapped.aliases_json, []),
          status: mapped.resolution_source === "manual" || mapped.resolution_source === "model" ? "resolved" : "derived",
          entityType: mapped.entity_type, granularity: mapped.granularity, location: json(mapped.location_json, {}),
        } : { ...inferred, ...inferredMetadata };
        const nextIdentity = {
          original_normalized_key: row.original_normalized_key || originalKey,
          entity_key: identity.entityKey,
          canonical_subject: identity.canonicalSubject,
          entity_aliases_json: JSON.stringify(identity.aliases),
          entity_resolution_status: identity.status,
          entity_type: identity.entityType || "other",
          granularity: identity.granularity || "general_topic",
          entity_location_json: JSON.stringify(identity.location || {}),
        };
        if (!storedColumnsMatch(row, nextIdentity)) updateClaimIdentity.run(
          originalKey, nextIdentity.entity_key, nextIdentity.canonical_subject, nextIdentity.entity_aliases_json,
          nextIdentity.entity_resolution_status, nextIdentity.entity_type, nextIdentity.granularity,
          nextIdentity.entity_location_json, row.id,
        );
        if (!mapped && identity.entityKey && alias) {
          this.upsertEntityAlias(destinationSlug, alias, identity, "derived", 0.55, timestamp);
          aliasesByNormalized.set(alias, {
            entity_key: identity.entityKey, canonical_subject: identity.canonicalSubject,
            aliases_json: JSON.stringify(identity.aliases || []), resolution_source: "derived",
            entity_type: identity.entityType, granularity: identity.granularity,
            location_json: JSON.stringify(identity.location || {}),
          });
        }
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
        const suggestedRelation = ENTITY_RELATION_TYPES.has(item?.suggested_relation)
          ? item.suggested_relation : assessment.suggestedRelation;
        const relationInsteadOfIdentity = suggestedRelation
          && !["same_as", "alias_of"].includes(suggestedRelation)
          && String(item?.recommendation || "UNCERTAIN").toUpperCase() !== "MERGE";
        if (assessment.decision === "DO_NOT_MERGE" || relationInsteadOfIdentity) {
          const candidateEntityKey = normalizeEntityKey(item?.candidate_entity_key);
          if (candidateEntityKey && suggestedRelation) this.upsertEntityRelation(destinationSlug, candidateEntityKey,
            suggestedRelation, entityKey, "model", confidence,
            String(item?.rationale || assessment.reasons.join("; ")).slice(0, 1_000));
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
          String(item?.recommendation || "UNCERTAIN").toUpperCase(), suggestedRelation);
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
    const destinationId = `dst_${sha256(destinationSlug).slice(0, 20)}`;
    const existingFactsById = new Map(this.db.prepare(
      "SELECT * FROM knowledge_facts WHERE destination_id=?",
    ).all(destinationId).map((row) => [row.id, row]));
    const allSourceRows = this.db.prepare(`
      SELECT c.*, ss.destination_name, ss.destination_slug, s.captured_at, s.published_at,
        s.canonical_url AS source_url, s.title AS source_title, s.authority_level AS source_authority_level,
        s.observed_at AS source_observed_at, s.verified_at AS source_verified_at,
        s.effective_from AS source_effective_from, s.effective_to AS source_effective_to
      FROM claims c JOIN structured_sources ss ON ss.source_id = c.source_id
      JOIN sources s ON s.id = c.source_id
      WHERE ss.destination_slug = ? AND c.lifecycle_status='active'
    `).all(destinationSlug);
    const timestamp = now();
    for (const row of allSourceRows) {
      row.structured_value = structureClaim({ predicate: row.predicate, value: row.value_text, qualifiers: json(row.qualifiers_json, []), sourceQuote: row.source_quote });
      row.scope = row.structured_value.scope;
    }
    const sourceRows = allSourceRows.filter((row) => row.knowledge_eligible !== 0);
    const claimsBySource = Map.groupBy(sourceRows, (row) => row.source_id);
    const previousReviewDecisions = new Map(this.db.prepare(`
      SELECT id, review_type, status FROM claim_review_cases
      WHERE destination_slug=? AND status IN ('resolved','dismissed')
    `).all(destinationSlug).map((row) => [row.id, row]));
    transaction(this.db, () => {
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
      const updateStructuredClaim = this.db.prepare(`UPDATE claims SET structured_value_json=?, scope_json=?, claim_kind=?, cardinality=? WHERE id=?`);
      const insertClaimReview = this.db.prepare(`INSERT INTO claim_review_cases(id, destination_slug, claim_a_id, claim_b_id,
        review_type, reason, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertClaimRelation = this.db.prepare(`INSERT OR IGNORE INTO claim_relations(id, destination_slug, claim_a_id, claim_b_id,
        relation_type, can_coexist, reason, scope_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const selectVisibility = this.db.prepare(
        "SELECT * FROM knowledge_visibility_overrides WHERE destination_slug=? AND normalized_key=?",
      );
      const upsertKnowledgeFact = this.db.prepare(`
        INSERT INTO knowledge_facts(id, destination_id, normalized_key, subject, predicate, consensus_status,
          preferred_value, support_count, contradiction_count, evidence_json, updated_at,
          freshness_state, latest_evidence_at, verification_priority, entity_key, canonical_subject,
          entity_aliases_json, entity_resolution_status, entity_type, granularity, entity_location_json,
          claim_relations_json, visibility_status, visibility_reason, visibility_updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(destination_id, normalized_key) DO UPDATE SET subject=excluded.subject,
          predicate=excluded.predicate, consensus_status=excluded.consensus_status,
          preferred_value=excluded.preferred_value, support_count=excluded.support_count,
          contradiction_count=excluded.contradiction_count, evidence_json=excluded.evidence_json,
          updated_at=excluded.updated_at, freshness_state=excluded.freshness_state,
          latest_evidence_at=excluded.latest_evidence_at, verification_priority=excluded.verification_priority,
          entity_key=excluded.entity_key, canonical_subject=excluded.canonical_subject,
          entity_aliases_json=excluded.entity_aliases_json, entity_resolution_status=excluded.entity_resolution_status,
          entity_type=excluded.entity_type, granularity=excluded.granularity,
          entity_location_json=excluded.entity_location_json, claim_relations_json=excluded.claim_relations_json,
          visibility_status=excluded.visibility_status, visibility_reason=excluded.visibility_reason,
          visibility_updated_at=excluded.visibility_updated_at
      `);
      const deleteKnowledgeFact = this.db.prepare("DELETE FROM knowledge_facts WHERE id=?");
      const activeFactIds = new Set();
      const reviewedExtractionQuotes = new Set();
      for (const row of sourceRows) {
        const nextStructured = {
          structured_value_json: JSON.stringify(row.structured_value),
          scope_json: JSON.stringify(row.scope),
          claim_kind: row.structured_value.claim_kind,
          cardinality: row.structured_value.cardinality,
        };
        if (!storedColumnsMatch(row, nextStructured)) updateStructuredClaim.run(
          nextStructured.structured_value_json, nextStructured.scope_json,
          nextStructured.claim_kind, nextStructured.cardinality, row.id,
        );
        const siblingClaims = claimsBySource.get(row.source_id) || [];
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
          insertClaimReview.run(reviewId, destinationSlug, row.id, null, extractionIssue,
              "The original source contains negation or a limiting qualifier that is absent from the normalized Claim.", status, timestamp, timestamp);
        }
      }
      // A broad Claim can generalize a specific Claim only when they express
      // the same canonical fact. Group by predicate and canonical value so a
      // generic "metro access" Claim is never linked to every specific Claim
      // with that predicate, and large destinations avoid a broad x specific
      // cross product.
      const generalizationGroups = Map.groupBy(sourceRows, (row) => {
        const predicate = row.structured_value.canonical_predicate || normalizeValue(row.predicate);
        const value = row.structured_value.typed_value != null
          ? JSON.stringify(row.structured_value.typed_value)
          : normalizeValue(row.value_text);
        return `${predicate}:${value}`;
      });
      for (const predicateRows of generalizationGroups.values()) {
        const broadRows = predicateRows.filter((row) => ["collection", "category", "general_topic"].includes(row.granularity));
        const specificRows = predicateRows.filter((row) => row.granularity === "specific_entity");
        for (const broad of broadRows) for (const specific of specificRows) {
          if (broad.normalized_key === specific.normalized_key) continue;
          const claimA = [broad.id, specific.id].sort()[0];
          const claimB = [broad.id, specific.id].sort()[1];
          const relationId = `claim_relation_${sha256(`${claimA}:${claimB}`).slice(0, 24)}`;
          insertClaimRelation.run(relationId, destinationSlug, claimA, claimB, "GENERALIZATION", 1,
            "A specific Claim may support a broader collection/category Claim, but the two are not merged.", "{}", timestamp, timestamp);
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
        const ranked = [...variants.entries()].sort((a, b) => b[1].length - a[1].length
          || knowledgeValueSpecificity(b[1][0].value_text) - knowledgeValueSpecificity(a[1][0].value_text));
        const relations = [];
        for (let left = 0; left < rows.length; left += 1) {
          for (let right = left + 1; right < rows.length; right += 1) {
            const comparison = classifyClaimPair(rows[left], rows[right]);
            const reviewId = comparison.reviewType && !comparison.reviewType.includes("EXTRACTION_ERROR")
              ? `claim_review_${sha256(`${rows[left].id}:${rows[right].id}:${comparison.reviewType}`).slice(0, 24)}`
              : null;
            const reviewStatus = reviewId ? previousReviewDecisions.get(reviewId)?.status || "pending" : null;
            if (reviewId) {
              insertClaimReview.run(reviewId, destinationSlug, rows[left].id, rows[right].id,
                comparison.reviewType, comparison.reason, reviewStatus, timestamp, timestamp);
            }
            const effectiveComparison = reviewStatus === "dismissed"
              ? { ...comparison, relation: "COMPATIBLE", canCoexist: true,
                reason: `${comparison.reason} Operator dismissed this comparison as a false positive.` }
              : comparison;
            relations.push({ claim_a_id: rows[left].id, claim_b_id: rows[right].id, ...effectiveComparison });
            const relationId = `claim_relation_${sha256(`${rows[left].id}:${rows[right].id}`).slice(0, 24)}`;
            insertClaimRelation.run(relationId, destinationSlug, rows[left].id, rows[right].id, effectiveComparison.relation,
                effectiveComparison.canCoexist ? 1 : 0, effectiveComparison.reason, JSON.stringify(effectiveComparison.scope), timestamp, timestamp);
          }
        }
        const conflicts = relations.filter((relation) => !relation.canCoexist);
        const status = conflicts.length ? "conflicted" : rows.length > 1 ? "corroborated" : "single_source";
        const preferredValue = typedFact
          ? String(ranked[0][1][0].structured_value.typed_value)
          : ranked[0][1][0].value_text;
        const freshness = classifyFreshness(rows, this.contentConfig);
        const hasCurrentOfficialEvidence = rows.some((row) => Number(row.source_authority_level || 4) === 1)
          && freshness.state !== "stale";
        const verificationPriority = status === "conflicted" || (freshness.volatile && !hasCurrentOfficialEvidence)
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
          source_title: row.source_title,
          canonical_url: row.source_url,
          authority_level: row.source_authority_level,
          published_at: row.published_at,
          captured_at: row.captured_at,
          observed_at: row.observed_at || row.source_observed_at || null,
          verified_at: row.verified_at || row.source_verified_at || null,
          effective_from: row.effective_from || row.source_effective_from || null,
          effective_to: row.effective_to || row.source_effective_to || null,
          timestamp_basis: row.verified_at || row.source_verified_at ? "verified_at"
            : row.observed_at || row.source_observed_at || row.published_at ? "observed_at" : "captured_at_legacy",
        }));
        const visibility = selectVisibility.get(destinationSlug, key);
        const factId = `fact_${sha256(`${destinationId}:${key}`).slice(0, 24)}`;
        const nextFact = {
          subject: entity.canonicalSubject || rows[0].subject,
          predicate: canonicalPredicate || rows[0].predicate,
          consensus_status: status,
          preferred_value: preferredValue,
          support_count: status === "conflicted" ? ranked[0][1].length : rows.length,
          contradiction_count: conflicts.length,
          evidence_json: JSON.stringify(evidence),
          freshness_state: freshness.state,
          latest_evidence_at: freshness.latestEvidenceAt,
          verification_priority: verificationPriority,
          entity_key: entity.entityKey,
          canonical_subject: entity.canonicalSubject,
          entity_aliases_json: JSON.stringify(entity.aliases),
          entity_resolution_status: entity.status,
          entity_type: entity.entityType,
          granularity: entity.granularity,
          entity_location_json: JSON.stringify(entity.location || {}),
          claim_relations_json: JSON.stringify(relations),
          visibility_status: visibility?.visibility_status || "visible",
          visibility_reason: visibility?.reason || null,
          visibility_updated_at: visibility?.updated_at || null,
        };
        activeFactIds.add(factId);
        if (!storedColumnsMatch(existingFactsById.get(factId), nextFact)) upsertKnowledgeFact.run(
          factId, destinationId, key, nextFact.subject, nextFact.predicate, nextFact.consensus_status,
          nextFact.preferred_value, nextFact.support_count, nextFact.contradiction_count, nextFact.evidence_json, timestamp,
          nextFact.freshness_state, nextFact.latest_evidence_at, nextFact.verification_priority, nextFact.entity_key,
          nextFact.canonical_subject, nextFact.entity_aliases_json, nextFact.entity_resolution_status, nextFact.entity_type,
          nextFact.granularity, nextFact.entity_location_json, nextFact.claim_relations_json,
          nextFact.visibility_status, nextFact.visibility_reason, nextFact.visibility_updated_at,
        );
      }
      for (const factId of existingFactsById.keys()) if (!activeFactIds.has(factId)) deleteKnowledgeFact.run(factId);
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
      .filter((proposal) => {
        const existing = this.db.prepare("SELECT status FROM topic_candidates WHERE topic_key=?").get(proposal.topicKey);
        return !existing || ["candidate", "dismissed"].includes(existing.status);
      })
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
        WHERE candidate_id=? AND strategy_version=? AND status='producing'
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
    const opportunity = this.db.prepare("SELECT * FROM content_opportunities WHERE candidate_id=? ORDER BY updated_at DESC LIMIT 1").get(candidateId);
    const coverage = json(opportunity?.coverage_json, {});
    const publicationMode = normalizePublicationMode(coverage.publicationMode);
    const selectedKeys = new Set(coverage.selectedFactKeys || []);
    const destinationFacts = this.knowledgeForDestination(candidate.destination_slug);
    const scopedFacts = selectedKeys.size
      ? destinationFacts.filter((fact) => selectedKeys.has(fact.normalized_key))
      : scopeFactsForOpportunity(destinationFacts, { title: candidate.proposed_title, topic_key: candidate.topic_key });
    const source = publicationMode === "source_adaptation" && opportunity?.source_id ? this.getSource(opportunity.source_id) : null;
    return {
      candidate,
      facts: scopedFacts,
      production_mode: publicationMode,
      source_reference: source ? {
        id: source.id, title: source.title, summary: source.structured?.summary || "",
        authorization_status: source.authorization_status, editing_allowed: source.editing_allowed,
        blueprint: source.blueprint ? { format: source.blueprint.format, hook: source.blueprint.hook,
          angle: source.blueprint.angle, sections: source.blueprint.sections, strengths: source.blueprint.strengths } : null,
      } : null,
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
    this.db.prepare("UPDATE content_opportunities SET status='producing',updated_at=? WHERE candidate_id=?").run(timestamp, candidateId);
    if (!deferDraft) this.enqueue("generate_draft", briefId);
    return briefId;
  }

  getBriefPackage(briefId) {
    const brief = this.db.prepare("SELECT * FROM content_briefs WHERE id = ?").get(briefId);
    if (!brief) return null;
    const topicPackage = this.getTopicPackage(brief.candidate_id);
    const contentPolicy = contentPolicyFor(brief, topicPackage?.facts || []);
    return {
      brief: {
        ...brief, plan: json(brief.plan_json, {}), canonical: json(brief.canonical_json, {}),
        evidence_ledger: json(brief.evidence_ledger_json, []),
      },
      frontend_page_plan: this.getFrontendPagePlan(briefId),
      content_policy: contentPolicy,
      reader_sources: readerSources(topicPackage?.facts || []),
      internal_link_inventory: this.listWordPressInventory().filter((item) => item.status === "publish")
        .slice(0, 100).map((item) => ({ title: item.title, url: item.post_url, slug: item.slug })),
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
    const policy = contentPolicyFor(brief, this.getTopicPackage(brief.candidate_id)?.facts || []);
    const metadata = draftMetadata(draft, brief, this.contentConfig, authorizedSourceAssets, policy);
    const contentHash = draftContentHash(draft, metadata, brief);
    if (existing) {
      this.db.prepare(`
        UPDATE article_drafts SET title=?, slug=?, body_markdown=?, meta_description=?, evidence_ledger_json=?,
          unresolved_conflicts_json=?, verification_notes_json=?, model=?, revision=revision+1,
          seo_json=?, schema_jsonld=?, content_blocks_json=?, strategy_version=?, content_hash=?,
          quality_report_json='{}', status='qa_queued', updated_at=?
        WHERE id=?
      `).run(draft.title, draft.slug, draft.body_markdown, draft.meta_description, JSON.stringify(draft.evidence_ledger),
        JSON.stringify(draft.unresolved_conflicts), JSON.stringify(draft.verification_notes || []), model,
        JSON.stringify(metadata.seo), JSON.stringify(metadata.schema), JSON.stringify(metadata.blocks), brief.strategy_version || this.strategyVersion,
        contentHash, timestamp, draftId);
    } else {
      this.db.prepare(`
        INSERT INTO article_drafts(id, brief_id, title, slug, body_markdown, quality_report_json, status,
          created_at, updated_at, meta_description, evidence_ledger_json, unresolved_conflicts_json,
          verification_notes_json, model, seo_json, schema_jsonld, content_blocks_json, strategy_version, content_hash)
        VALUES (?, ?, ?, ?, ?, '{}', 'qa_queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(draftId, briefId, draft.title, draft.slug, draft.body_markdown, timestamp, timestamp,
        draft.meta_description, JSON.stringify(draft.evidence_ledger), JSON.stringify(draft.unresolved_conflicts),
        JSON.stringify(draft.verification_notes || []), model, JSON.stringify(metadata.seo), JSON.stringify(metadata.schema),
        JSON.stringify(metadata.blocks), brief.strategy_version || this.strategyVersion, contentHash);
    }
    this.invalidateDraftDependents(draftId, timestamp);
    this.replaceDraftVisuals(draftId, metadata.visuals, brief.strategy_version || this.strategyVersion);
    this.db.prepare("UPDATE topic_candidates SET status='drafted', updated_at=? WHERE id=?").run(timestamp, brief.candidate_id);
    this.db.prepare("UPDATE content_briefs SET status='drafted', updated_at=? WHERE id=?").run(timestamp, briefId);
    this.db.prepare("UPDATE content_opportunities SET status='drafted',updated_at=? WHERE candidate_id=?").run(timestamp, brief.candidate_id);
    if (!deferReview) this.enqueue("review_draft", draftId);
    return draftId;
  }

  getDraftPackage(draftId) {
    const draft = this.db.prepare("SELECT * FROM article_drafts WHERE id = ?").get(draftId);
    if (!draft) return null;
    const briefPackage = this.getBriefPackage(draft.brief_id);
    const currentEvidenceHash = evidenceHashForFacts(briefPackage?.facts || []);
    const review = this.db.prepare(`SELECT * FROM quality_reviews
      WHERE draft_id=? AND draft_revision=? AND draft_content_hash=? AND evidence_hash=? ORDER BY created_at DESC LIMIT 1`)
      .get(draftId, draft.revision, draft.content_hash, currentEvidenceHash) || null;
    const publication = this.db.prepare("SELECT * FROM wordpress_publications WHERE draft_id = ?").get(draftId) || null;
    const compositionRow = this.db.prepare(`SELECT * FROM commercial_compositions
      WHERE draft_id=? AND draft_revision=? AND draft_content_hash=?`).get(draftId, draft.revision, draft.content_hash) || null;
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
      publish_composition: this.getFrontendPublishComposition(draftId),
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

  invalidateDraftDependents(draftId, timestamp = now()) {
    this.db.prepare("UPDATE frontend_page_compositions SET status='stale_contract', updated_at=? WHERE draft_id=?")
      .run(timestamp, draftId);
    this.db.prepare("UPDATE frontend_publish_compositions SET status='stale_contract', wordpress_post_id=NULL, updated_at=? WHERE draft_id=?")
      .run(timestamp, draftId);
    this.db.prepare(`DELETE FROM jobs WHERE entity_id=? AND status='queued'
      AND type IN ('review_draft','compose_commercial','compose_publish_page','push_wordpress_draft')`).run(draftId);
  }

  listDraftVisuals(draftId) {
    return this.db.prepare("SELECT * FROM article_visuals WHERE draft_id=? ORDER BY slot").all(draftId);
  }

  replaceDraftVisuals(draftId, visuals, strategyVersion) {
    const timestamp = now();
    transaction(this.db, () => {
      const existing = new Map(this.db.prepare("SELECT * FROM article_visuals WHERE draft_id=?").all(draftId)
        .map((row) => [row.slot, row]));
      const upsert = this.db.prepare(`
        INSERT INTO article_visuals(id, draft_id, slot, placement, purpose, alt_text, caption, generation_prompt, aspect_ratio,
          strategy_version, image_type, image_role, image_subject, acquisition_strategy, factual_image_required,
          source_asset_id, source_remote_url, status, media_url, provider, model, created_at, updated_at, asset_fingerprint)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(draft_id, slot) DO UPDATE SET placement=excluded.placement, purpose=excluded.purpose,
          alt_text=excluded.alt_text, caption=excluded.caption, generation_prompt=excluded.generation_prompt,
          aspect_ratio=excluded.aspect_ratio, strategy_version=excluded.strategy_version, image_type=excluded.image_type,
          image_role=excluded.image_role, image_subject=excluded.image_subject,
          acquisition_strategy=excluded.acquisition_strategy, factual_image_required=excluded.factual_image_required,
          source_asset_id=excluded.source_asset_id, source_remote_url=excluded.source_remote_url,
          status=CASE WHEN article_visuals.asset_fingerprint=excluded.asset_fingerprint THEN article_visuals.status ELSE excluded.status END,
          media_path=CASE WHEN article_visuals.asset_fingerprint=excluded.asset_fingerprint THEN article_visuals.media_path ELSE NULL END,
          media_url=CASE WHEN article_visuals.asset_fingerprint=excluded.asset_fingerprint THEN article_visuals.media_url ELSE excluded.media_url END,
          wordpress_media_id=CASE WHEN article_visuals.asset_fingerprint=excluded.asset_fingerprint THEN article_visuals.wordpress_media_id ELSE NULL END,
          wordpress_media_url=CASE WHEN article_visuals.asset_fingerprint=excluded.asset_fingerprint THEN article_visuals.wordpress_media_url ELSE NULL END,
          provider=CASE WHEN article_visuals.asset_fingerprint=excluded.asset_fingerprint THEN article_visuals.provider ELSE excluded.provider END,
          model=CASE WHEN article_visuals.asset_fingerprint=excluded.asset_fingerprint THEN article_visuals.model ELSE excluded.model END,
          last_error=CASE WHEN article_visuals.asset_fingerprint=excluded.asset_fingerprint THEN article_visuals.last_error ELSE NULL END,
          attempt_count=CASE WHEN article_visuals.asset_fingerprint=excluded.asset_fingerprint THEN article_visuals.attempt_count ELSE 0 END,
          retry_at=CASE WHEN article_visuals.asset_fingerprint=excluded.asset_fingerprint THEN article_visuals.retry_at ELSE NULL END,
          asset_fingerprint=excluded.asset_fingerprint, updated_at=excluded.updated_at
      `);
      visuals.forEach((visual, index) => {
        const fingerprint = visualFingerprint(visual);
        upsert.run(existing.get(index + 1)?.id || id("visual"), draftId, index + 1, visual.placement, visual.purpose,
        visual.alt_text, visual.caption, visual.generation_prompt, visual.aspect_ratio, strategyVersion, visual.image_type,
        visual.image_role, visual.image_subject, visual.acquisition_strategy, visual.factual_image_required ? 1 : 0,
        visual.source_asset_id || null, visual.source_remote_url || null, visual.status || "planned", visual.media_url || null,
        visual.provider || null, visual.model || null, timestamp, timestamp, fingerprint);
      });
      this.db.prepare("DELETE FROM article_visuals WHERE draft_id=? AND slot>?").run(draftId, visuals.length);
    });
  }

  plannedVisuals(draftId) {
    return this.db.prepare(`
      SELECT * FROM article_visuals WHERE draft_id=? AND status='planned' AND acquisition_strategy='generate_illustration'
        AND (retry_at IS NULL OR retry_at<=?)
      ORDER BY slot
    `).all(draftId, now());
  }

  saveGeneratedVisual(visualId, result) {
    this.db.prepare(`
      UPDATE article_visuals SET status='generated', media_path=?, media_url=?, provider=?, model=?,
        last_error=NULL, retry_at=NULL, updated_at=?
      WHERE id=?
    `).run(result.mediaPath, result.mediaUrl, result.provider, result.model, now(), visualId);
    const visual = this.db.prepare("SELECT draft_id FROM article_visuals WHERE id=?").get(visualId);
    if (visual) this.refreshDraftSchema(visual.draft_id);
  }

  failVisual(visualId, error) {
    const row = this.db.prepare("SELECT attempt_count FROM article_visuals WHERE id=?").get(visualId);
    const attempts = (row?.attempt_count || 0) + 1;
    const retryable = error?.retryable !== false && attempts < 3;
    const retryAt = retryable ? new Date(Date.now() + Math.min(60_000, 1_000 * (2 ** attempts))).toISOString() : null;
    this.db.prepare("UPDATE article_visuals SET status=?, attempt_count=?, retry_at=?, last_error=?, updated_at=? WHERE id=?")
      .run(retryable ? "planned" : "failed", attempts, retryAt, String(error?.message || error).slice(0, 4_000), now(), visualId);
    return { retryable, status: retryable ? "planned" : "failed" };
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

  saveReview(draftId, review, reviewer, expectedVersion = null) {
    const timestamp = now();
    const draft = this.db.prepare("SELECT revision, content_hash, strategy_version, brief_id FROM article_drafts WHERE id=?").get(draftId);
    if (!draft) throw new Error(`Article draft ${draftId} not found.`);
    if (expectedVersion && (draft.revision !== expectedVersion.revision || draft.content_hash !== expectedVersion.contentHash)) {
      throw Object.assign(new Error("STALE_DRAFT_VERSION: QA input changed before the review could be saved."), { retryable: false });
    }
    const facts = this.getBriefPackage(draft.brief_id)?.facts || [];
    const evidenceHash = evidenceHashForFacts(facts);
    this.db.prepare(`
      INSERT INTO quality_reviews(id, draft_id, passed, score, checks_json, issues_json,
        unsupported_claims_json, reviewer, strategy_version, created_at, draft_revision, draft_content_hash, evidence_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id("review"), draftId, review.passed ? 1 : 0, review.score, JSON.stringify(review.checks), JSON.stringify(review.issues),
      JSON.stringify(review.unsupported_claims), reviewer, draft.strategy_version || this.strategyVersion, timestamp,
      draft.revision, draft.content_hash, evidenceHash);
    this.db.prepare("UPDATE article_drafts SET quality_report_json=?, status=?, updated_at=? WHERE id=?")
      .run(JSON.stringify(review), review.passed ? "ready_for_wordpress" : "qa_failed", timestamp, draftId);
    this.db.prepare(`UPDATE content_opportunities SET status=?,updated_at=? WHERE candidate_id=(
      SELECT cb.candidate_id FROM article_drafts ad JOIN content_briefs cb ON cb.id=ad.brief_id WHERE ad.id=?)`)
      .run(review.passed ? "ready_for_wordpress" : "qa_failed", timestamp, draftId);
    return this.db.prepare("SELECT revision FROM article_drafts WHERE id = ?").get(draftId)?.revision || 1;
  }

  prepareWordPressPublication(draftId, siteUrl, deliveryMode = "legacy") {
    const timestamp = now();
    const existing = this.db.prepare("SELECT * FROM wordpress_publications WHERE draft_id = ?").get(draftId);
    if (existing) {
      this.db.prepare("UPDATE wordpress_publications SET status='queued', last_error=NULL, error_code=NULL, delivery_mode=?, updated_at=? WHERE draft_id=?")
        .run(deliveryMode, timestamp, draftId);
      return this.db.prepare("SELECT * FROM wordpress_publications WHERE draft_id=?").get(draftId);
    }
    const publication = { id: id("wp"), draft_id: draftId, site_url: siteUrl, post_id: null };
    this.db.prepare(`
      INSERT INTO wordpress_publications(id, draft_id, site_url, status, strategy_version, created_at, updated_at, delivery_mode)
      VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)
    `).run(publication.id, draftId, siteUrl, this.db.prepare("SELECT strategy_version FROM article_drafts WHERE id=?").get(draftId)?.strategy_version || this.strategyVersion, timestamp, timestamp, deliveryMode);
    return publication;
  }

  completeWordPressPublication(draftId, result) {
    this.db.prepare(`
      UPDATE wordpress_publications SET post_id=?, post_url=?, preview_url=?, edit_url=?, response_json=?, status='synced',
        last_error=NULL, error_code=NULL, updated_at=? WHERE draft_id=?
    `).run(result.postId, result.postUrl, result.previewUrl || result.postUrl || null, result.editUrl || null,
      JSON.stringify(result), now(), draftId);
    for (const visual of result.visuals || []) this.saveWordPressVisual(visual.visualId, visual);
    this.markFrontendPublishComposition(draftId, "delivered", result.postId);
    this.db.prepare("UPDATE article_drafts SET status='wordpress_draft', updated_at=? WHERE id=?").run(now(), draftId);
    this.db.prepare(`UPDATE content_opportunities SET status='wordpress_draft',updated_at=? WHERE candidate_id=(
      SELECT cb.candidate_id FROM article_drafts ad JOIN content_briefs cb ON cb.id=ad.brief_id WHERE ad.id=?)`).run(now(), draftId);
  }

  failWordPressPublication(draftId, error) {
    this.db.prepare("UPDATE wordpress_publications SET status='failed', last_error=?, error_code=?, updated_at=? WHERE draft_id=?")
      .run(String(error?.message || error).slice(0, 4000), String(error?.code || "WORDPRESS_DELIVERY_FAILED").slice(0, 120), now(), draftId);
    if (this.getFrontendPublishComposition(draftId)) this.markFrontendPublishComposition(draftId, "delivery_failed");
  }

  listContent() {
    return this.db.prepare(`
      SELECT tc.*, cb.id AS brief_id, cb.status AS brief_status, ad.id AS draft_id, ad.status AS draft_status,
        ad.title AS draft_title, ad.revision, qr.passed AS qa_passed, qr.score AS qa_score,
        wp.post_id AS wordpress_post_id, wp.post_url AS wordpress_post_url, wp.status AS wordpress_status,
        cc.status AS commercial_status, json_array_length(COALESCE(cc.offer_ids_json, '[]')) AS commercial_offer_count,
        pc.status AS publish_composition_status
      FROM topic_candidates tc
      LEFT JOIN content_briefs cb ON cb.candidate_id = tc.id
      LEFT JOIN article_drafts ad ON ad.brief_id = cb.id
      LEFT JOIN quality_reviews qr ON qr.id = (
        SELECT id FROM quality_reviews WHERE draft_id = ad.id ORDER BY created_at DESC LIMIT 1
      )
      LEFT JOIN wordpress_publications wp ON wp.draft_id = ad.id
      LEFT JOIN commercial_compositions cc ON cc.draft_id = ad.id
      LEFT JOIN frontend_publish_compositions pc ON pc.draft_id = ad.id
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
      valid_until, source_updated_at, legacy_offer_id, created_at, updated_at, image_url, alt_text, price_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET provider_account_id=excluded.provider_account_id, provider=excluded.provider,
        asset_type=excluded.asset_type, product_category=excluded.product_category, scope_type=excluded.scope_type,
        scope_key=excluded.scope_key, destination_slug=excluded.destination_slug, area_key=excluded.area_key,
        route_key=excluded.route_key, entity_key=excluded.entity_key, entity_name=excluded.entity_name,
        provider_entity_id=excluded.provider_entity_id, title=excluded.title, description=excluded.description,
        cta_label=excluded.cta_label, target_url=excluded.target_url, embed_config_json=excluded.embed_config_json,
        image_url=excluded.image_url, alt_text=excluded.alt_text, price_text=excluded.price_text,
        language=excluded.language, priority=excluded.priority, active=excluded.active, valid_from=excluded.valid_from,
        valid_until=excluded.valid_until, source_updated_at=excluded.source_updated_at, updated_at=excluded.updated_at`)
      .run(asset.id, asset.providerAccountId, asset.provider, asset.assetType, asset.productCategory, asset.scopeType,
        asset.scopeKey, asset.destinationSlug, asset.areaKey, asset.routeKey, asset.entityKey, asset.entityName,
        asset.providerEntityId, asset.title, asset.description, asset.ctaLabel, asset.targetUrl,
        JSON.stringify(asset.embedConfig || {}), asset.language, asset.priority, asset.active ? 1 : 0, asset.validFrom,
        asset.validUntil, asset.sourceUpdatedAt, asset.legacyOfferId, timestamp, timestamp,
        asset.imageUrl || "", asset.altText || "", asset.priceText || "");
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

  ensureTripManualProvider() {
    const existing = this.db.prepare(`SELECT * FROM affiliate_provider_accounts
      WHERE provider_key IN ('trip','trip-com') OR lower(display_name) IN ('trip','trip.com')
      ORDER BY CASE WHEN connection_mode='MANUAL' THEN 0 ELSE 1 END LIMIT 1`).get();
    if (existing) return existing;
    return this.upsertAffiliateProviderAccount({
      id: `provider_${sha256("trip-com").slice(0, 24)}`, providerKey: "trip-com", displayName: "Trip.com",
      connectionMode: "MANUAL", siteName: "SoloToChina", defaultLanguage: "en",
      defaultDisclosure: "SoloToChina may earn a commission from eligible bookings, at no extra cost to you.", status: "CONFIGURED",
    });
  }

  getAffiliateQueueTask(taskId) {
    const row = this.db.prepare("SELECT * FROM affiliate_asset_queue_tasks WHERE id=?").get(taskId);
    return row ? { ...row, embed_config: json(row.embed_config_json, {}) } : null;
  }

  listAffiliateQueueTasks({ status = "", productCategory = "", scopeType = "", provider = "" } = {}) {
    const clauses = []; const values = [];
    if (status) { clauses.push("status=?"); values.push(String(status).toUpperCase()); }
    if (productCategory) { clauses.push("product_category=?"); values.push(String(productCategory).toUpperCase()); }
    if (scopeType) { clauses.push("scope_type=?"); values.push(String(scopeType).toUpperCase()); }
    if (provider) { clauses.push("lower(provider)=lower(?)"); values.push(provider); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db.prepare(`SELECT * FROM affiliate_asset_queue_tasks ${where}
      ORDER BY CASE status WHEN 'READY_FOR_MANUAL' THEN 0 WHEN 'PENDING' THEN 1 WHEN 'INVALID' THEN 2 WHEN 'COMPLETED' THEN 3 ELSE 4 END,
      priority DESC, score DESC, created_at ASC`).all(...values).map((row) => ({ ...row, embed_config: json(row.embed_config_json, {}) }));
  }

  createAffiliateQueueTask(input, options = {}) {
    const provider = input.providerAccountId || input.provider_account_id
      ? this.getAffiliateProviderAccount(input.providerAccountId || input.provider_account_id) : this.ensureTripManualProvider();
    if (!provider) throw new Error("Affiliate queue provider account does not exist.");
    if (provider.connection_mode !== "MANUAL") throw conflictError("V1 Affiliate Asset Queue requires a MANUAL Trip.com provider account.");
    const task = normalizeAffiliateQueueTask({ ...input, providerAccountId: provider.id, provider: provider.display_name }, options);
    const existing = this.db.prepare("SELECT * FROM affiliate_asset_queue_tasks WHERE task_key=?").get(task.taskKey);
    if (existing) return { created: false, reason: "task_exists", task: this.getAffiliateQueueTask(existing.id) };
    if (this.hasActiveAffiliateAssetForTask(task)) return { created: false, reason: "active_asset_exists", task: null };
    task.tripSub1 = this.allocateAffiliateQueueSub1(task.tripSub1, task.taskKey);
    const timestamp = now();
    this.db.prepare(`INSERT INTO affiliate_asset_queue_tasks(
      id,task_key,provider_account_id,provider,status,product_category,asset_type,scope_type,scope_key,
      destination_slug,area_key,route_key,entity_key,entity_name,trip_tool_type,trip_destination,trip_property,
      trip_departure,trip_arrival,trip_pickup_location,source_trip_url,trip_sub1,suggested_title,suggested_description,suggested_cta_label,
      priority,opportunity_id,reason,score,intent_strength,precision_uplift,source_type,affiliate_url,embed_config_json,
      valid_from,valid_until,invalid_reason,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(task.id, task.taskKey, task.providerAccountId, task.provider, task.status, task.productCategory, task.assetType,
        task.scopeType, task.scopeKey, task.destinationSlug, task.areaKey, task.routeKey, task.entityKey, task.entityName,
        task.tripToolType, task.tripDestination, task.tripProperty, task.tripDeparture, task.tripArrival, task.tripPickupLocation,
        task.sourceTripUrl, task.tripSub1, task.suggestedTitle, task.suggestedDescription, task.suggestedCtaLabel, task.priority,
        task.opportunityId, task.reason, task.score, task.intentStrength, task.precisionUplift, task.sourceType,
        task.affiliateUrl, JSON.stringify(task.embedConfig || {}), task.validFrom, task.validUntil, "", timestamp, timestamp);
    return { created: true, reason: "created", task: this.getAffiliateQueueTask(task.id) };
  }

  allocateAffiliateQueueSub1(base, taskKey) {
    const existing = this.db.prepare("SELECT task_key FROM affiliate_asset_queue_tasks WHERE trip_sub1=?").get(base);
    if (!existing || existing.task_key === taskKey) return base;
    const digest = sha256(taskKey);
    for (const length of [8, 12, 16, 24, 32]) {
      const candidate = `${base.slice(0, 99 - length)}_${digest.slice(0, length)}`;
      if (!this.db.prepare("SELECT 1 FROM affiliate_asset_queue_tasks WHERE trip_sub1=?").get(candidate)) return candidate;
    }
    throw new Error("Unable to allocate a unique deterministic trip_sub1.");
  }

  hasActiveAffiliateAssetForTask(task) {
    const timestamp = now();
    const rows = this.db.prepare(`SELECT * FROM affiliate_assets WHERE active=1 AND product_category=?
      AND (valid_from IS NULL OR valid_from<=?) AND (valid_until IS NULL OR valid_until>?)`).all(task.productCategory, timestamp, timestamp);
    return rows.some((asset) => {
      if (asset.scope_type !== task.scopeType) return false;
      const assetKey = asset.scope_key || asset.entity_key || asset.route_key || asset.area_key || asset.destination_slug || asset.product_category;
      return assetKey === task.scopeKey;
    });
  }

  seedAffiliateQueue(filename) {
    const results = loadAffiliateQueueSeeds(filename).map((seed) => {
      const result = this.createAffiliateQueueTask(seed, { sourceType: "SEED" });
      if (result.reason !== "task_exists" || result.task?.source_type !== "SEED" || ["COMPLETED", "SKIPPED"].includes(result.task?.status)) return result;
      const fields = [
        ["asset_type", seed.assetType], ["destination_slug", seed.destinationSlug], ["area_key", seed.areaKey],
        ["route_key", seed.routeKey], ["entity_key", seed.entityKey], ["entity_name", seed.entityName],
        ["trip_tool_type", seed.tripToolType], ["trip_destination", seed.tripDestination], ["trip_property", seed.tripProperty],
        ["trip_departure", seed.tripDeparture], ["trip_arrival", seed.tripArrival], ["trip_pickup_location", seed.tripPickupLocation],
        ["source_trip_url", seed.sourceTripUrl], ["suggested_title", seed.suggestedTitle],
        ["suggested_description", seed.suggestedDescription], ["suggested_cta_label", seed.suggestedCtaLabel],
        ["priority", seed.priority], ["reason", seed.reason],
      ];
      if (!fields.some(([column, value]) => String(result.task[column] ?? "") !== String(value ?? ""))) return result;
      const timestamp = now();
      this.db.prepare(`UPDATE affiliate_asset_queue_tasks SET asset_type=?,destination_slug=?,area_key=?,route_key=?,
        entity_key=?,entity_name=?,trip_tool_type=?,trip_destination=?,trip_property=?,trip_departure=?,trip_arrival=?,
        trip_pickup_location=?,source_trip_url=?,suggested_title=?,suggested_description=?,suggested_cta_label=?,
        priority=?,reason=?,updated_at=? WHERE id=?`).run(...fields.map(([, value]) => value ?? ""), timestamp, result.task.id);

      return { created: false, reason: "task_updated", task: this.getAffiliateQueueTask(result.task.id) };
    });
    return {
      created: results.filter((item) => item.created).length,
      updated: results.filter((item) => item.reason === "task_updated").length,
      existing: results.filter((item) => item.reason === "task_exists").length,
      suppressedByAsset: results.filter((item) => item.reason === "active_asset_exists").length,
      items: results.map((item) => item.task).filter(Boolean),
    };
  }

  completeAffiliateQueueTask(taskId, completion = {}) {
    const task = this.getAffiliateQueueTask(taskId);
    if (!task) return null;
    if (task.status === "COMPLETED") return { task, asset: this.getAffiliateAsset(task.affiliate_asset_id), created: false, idempotent: true };
    if (task.status === "SKIPPED") throw conflictError("A skipped affiliate queue task cannot be completed.");
    const provider = this.getAffiliateProviderAccount(task.provider_account_id);
    if (!provider) throw new Error("Affiliate queue provider account does not exist.");
    const asset = affiliateAssetFromQueueTask(task, completion, provider);
    const timestamp = now();
    let saved;
    transaction(this.db, () => {
      saved = this.upsertAffiliateAsset(asset);
      this.db.prepare(`UPDATE affiliate_asset_queue_tasks SET status='COMPLETED',affiliate_url=?,embed_config_json=?,
        affiliate_asset_id=?,invalid_reason='',completed_at=?,updated_at=? WHERE id=? AND status<>'COMPLETED'`)
        .run(asset.targetUrl, JSON.stringify(asset.embedConfig || {}), saved.id, timestamp, timestamp, taskId);
      if (task.opportunity_id) this.db.prepare("UPDATE affiliate_opportunities SET status='addressed',updated_at=? WHERE id=?").run(timestamp, task.opportunity_id);
    });
    return { task: this.getAffiliateQueueTask(taskId), asset: saved, created: true, idempotent: false };
  }

  skipAffiliateQueueTask(taskId) {
    const task = this.getAffiliateQueueTask(taskId);
    if (!task) return null;
    if (task.status === "COMPLETED") throw conflictError("A completed affiliate queue task cannot be skipped.");
    if (task.status === "SKIPPED") return task;
    const timestamp = now();
    this.db.prepare("UPDATE affiliate_asset_queue_tasks SET status='SKIPPED',skipped_at=?,updated_at=? WHERE id=?")
      .run(timestamp, timestamp, taskId);
    return this.getAffiliateQueueTask(taskId);
  }

  invalidateAffiliateQueueTask(taskId, reason) {
    const task = this.getAffiliateQueueTask(taskId);
    if (!task || ["COMPLETED", "SKIPPED"].includes(task.status)) return task;
    this.db.prepare("UPDATE affiliate_asset_queue_tasks SET status='INVALID',invalid_reason=?,updated_at=? WHERE id=?")
      .run(String(reason || "Invalid queue completion.").slice(0, 2_000), now(), taskId);
    return this.getAffiliateQueueTask(taskId);
  }

  exportAffiliateQueue({ format = "json", ...filters } = {}) {
    return exportAffiliateQueue(this.listAffiliateQueueTasks(filters), format);
  }

  importAffiliateQueue(payload, { format = "json", dryRun = false } = {}) {
    const rows = parseAffiliateQueueImport(payload, format);
    const seen = new Set(); const results = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index] || {}; const taskId = String(row.task_id || row.id || "").trim(); const taskKey = String(row.task_key || "").trim();
      const identity = `${taskId}\u0000${taskKey}`;
      if (seen.has(identity)) { results.push({ row: index + 1, taskId, taskKey, status: "error", error: "Duplicate task_id + task_key row in import." }); continue; }
      seen.add(identity);
      const task = taskId ? this.getAffiliateQueueTask(taskId) : null;
      if (!task || !taskKey || task.task_key !== taskKey) { results.push({ row: index + 1, taskId, taskKey, status: "error", error: "task_id and task_key do not identify the same queue task." }); continue; }
      if (task.status === "COMPLETED") { results.push({ row: index + 1, taskId, taskKey, status: "protected", error: "Completed task is protected from import changes." }); continue; }
      const affiliateUrl = String(row.affiliate_url || "").trim();
      if (!affiliateUrl) { results.push({ row: index + 1, taskId, taskKey, status: "unchanged" }); continue; }
      try {
        const provider = this.getAffiliateProviderAccount(task.provider_account_id);
        const asset = affiliateAssetFromQueueTask(task, { affiliateUrl }, provider);
        if (dryRun) results.push({ row: index + 1, taskId, taskKey, status: "valid", assetId: asset.id });
        else {
          const completed = this.completeAffiliateQueueTask(taskId, { affiliateUrl });
          results.push({ row: index + 1, taskId, taskKey, status: "completed", assetId: completed.asset.id });
        }
      } catch (error) {
        if (!dryRun) this.invalidateAffiliateQueueTask(taskId, error.message);
        results.push({ row: index + 1, taskId, taskKey, status: "error", error: error.message });
      }
    }
    return {
      dryRun: Boolean(dryRun), total: rows.length,
      valid: results.filter((item) => ["valid", "completed"].includes(item.status)).length,
      completed: results.filter((item) => item.status === "completed").length,
      unchanged: results.filter((item) => item.status === "unchanged").length,
      protected: results.filter((item) => item.status === "protected").length,
      failed: results.filter((item) => item.status === "error").length,
      results,
    };
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
    const draft = this.db.prepare("SELECT revision, content_hash FROM article_drafts WHERE id=?").get(draftId);
    if (!draft) throw new Error(`Article draft ${draftId} not found.`);
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
        content_blocks_json, strategy_version, draft_revision, draft_content_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(draft_id) DO UPDATE SET publishable_body_markdown=excluded.publishable_body_markdown,
          slots_json=excluded.slots_json, offer_ids_json=excluded.offer_ids_json, disclosure_text=excluded.disclosure_text,
          status=excluded.status, updated_at=excluded.updated_at, asset_ids_json=excluded.asset_ids_json,
          commercial_blocks_json=excluded.commercial_blocks_json, content_blocks_json=excluded.content_blocks_json,
          strategy_version=excluded.strategy_version, draft_revision=excluded.draft_revision,
          draft_content_hash=excluded.draft_content_hash`)
        .run(compositionId, draftId, composition.publishableBodyMarkdown, JSON.stringify(composition.slots),
          JSON.stringify(composition.offerIds), composition.disclosureText, composition.status, timestamp, timestamp,
          JSON.stringify(composition.assetIds || []), JSON.stringify(composition.commercialBlocks || []),
          JSON.stringify(composition.contentBlocks || []), this.strategyVersion, draft.revision, draft.content_hash);
      this.db.prepare("UPDATE article_drafts SET status='commercial_ready', updated_at=? WHERE id=?").run(timestamp, draftId);
    });
    this.enqueueAffiliateQueueFromComposition(composition);
  }

  enqueueAffiliateQueueFromComposition(composition) {
    const opportunities = composition.opportunities || [];
    if (!opportunities.length) return { created: 0, suppressed: 0, errors: [] };
    let provider;
    try { provider = this.ensureTripManualProvider(); }
    catch (error) { return { created: 0, suppressed: opportunities.length, errors: [error.message] }; }
    const threshold = Number(this.contentConfig.affiliateOpportunityThreshold || 70);
    let created = 0; let suppressed = 0; const errors = [];
    for (const opportunity of opportunities) {
      try {
        const intent = (composition.intents || []).find((item) => item.id === opportunity.intentId);
        const task = queueTaskFromOpportunity(opportunity, intent, { threshold, providerAccountId: provider.id });
        if (!task) { suppressed += 1; continue; }
        const result = this.createAffiliateQueueTask(task, { sourceType: "OPPORTUNITY" });
        if (result.created) created += 1; else suppressed += 1;
      } catch (error) { suppressed += 1; errors.push(`${opportunity.id || "unknown"}: ${error.message}`); }
    }
    return { created, suppressed, errors };
  }

  retryContent(candidateId, { contractAware = false } = {}) {
    const row = this.db.prepare(`
      SELECT tc.id, tc.status AS candidate_status, cb.id AS brief_id, cb.status AS brief_status,
        ad.id AS draft_id, ad.status AS draft_status, ad.revision, qr.passed AS qa_passed,
        wp.status AS wordpress_status, cc.status AS commercial_status, pc.status AS publish_composition_status,
        fp.status AS frontend_page_status
      FROM topic_candidates tc
      LEFT JOIN content_briefs cb ON cb.candidate_id=tc.id
      LEFT JOIN article_drafts ad ON ad.brief_id=cb.id
      LEFT JOIN quality_reviews qr ON qr.id=(SELECT id FROM quality_reviews WHERE draft_id=ad.id ORDER BY created_at DESC LIMIT 1)
      LEFT JOIN wordpress_publications wp ON wp.draft_id=ad.id
      LEFT JOIN commercial_compositions cc ON cc.draft_id=ad.id
      LEFT JOIN frontend_publish_compositions pc ON pc.draft_id=ad.id
      LEFT JOIN frontend_page_compositions fp ON fp.draft_id=ad.id
      WHERE tc.id=?
    `).get(candidateId);
    if (!row) return null;
    if (!row.brief_id) return this.queueCandidate(candidateId) ? "plan_content" : null;
    if (!row.draft_id) {
      this.db.prepare("UPDATE content_briefs SET status='ready', last_error=NULL, updated_at=? WHERE id=?").run(now(), row.brief_id);
      this.enqueue("generate_draft", row.brief_id);
      return "generate_draft";
    }
    if (contractAware && (row.frontend_page_status === "stale_contract" || row.publish_composition_status === "stale_contract")) {
      this.enqueue("compose_frontend_page", row.draft_id);
      return "compose_frontend_page";
    }
    if (row.qa_passed && !row.commercial_status) {
      this.enqueue("compose_commercial", row.draft_id);
      return "compose_commercial";
    }
    if (row.qa_passed && row.commercial_status && !row.publish_composition_status) {
      const jobType = contractAware ? "compose_publish_page" : "push_wordpress_draft";
      this.enqueue(jobType, row.draft_id);
      return jobType;
    }
    if (row.qa_passed && row.wordpress_status === "failed") {
      const jobType = contractAware && row.publish_composition_status === "stale_contract" ? "compose_publish_page" : "push_wordpress_draft";
      this.enqueue(jobType, row.draft_id);
      return jobType;
    }
    if (!row.qa_passed) {
      this.enqueue("revise_draft", row.draft_id);
      return "revise_draft";
    }
    return null;
  }

  enqueueStartupReconciliation({ wordpressEnabled = false, contractAware = false } = {}) {
    this.reconcileCoverageAuditFalsePositives();
    this.reconcileEntityRelationshipCandidates();
    const researchSlugs = new Set(this.db.prepare("SELECT DISTINCT destination_slug FROM structured_sources").all().map((row) => row.destination_slug));
    const staleKnowledgeSlugs = this.db.prepare(`
      WITH claim_state AS (
        SELECT ss.destination_slug AS slug, MAX(c.created_at) AS latest_claim_at
        FROM structured_sources ss JOIN claims c ON c.source_id=ss.source_id
        WHERE c.lifecycle_status='active' AND c.knowledge_eligible=1
        GROUP BY ss.destination_slug
      ), fact_state AS (
        SELECT d.slug AS slug, MAX(k.updated_at) AS latest_fact_at
        FROM destinations d JOIN knowledge_facts k ON k.destination_id=d.id
        GROUP BY d.slug
      )
      SELECT claim_state.slug FROM claim_state LEFT JOIN fact_state USING(slug)
      WHERE fact_state.latest_fact_at IS NULL OR claim_state.latest_claim_at > fact_state.latest_fact_at
    `).all().map((row) => row.slug);
    for (const slug of staleKnowledgeSlugs) this.enqueue("rebuild_knowledge", slug);
    for (const row of this.db.prepare(`SELECT s.id FROM sources s
      JOIN structured_sources ss ON ss.source_id=s.id
      LEFT JOIN content_intake_analyses cia ON cia.source_id=s.id
      WHERE s.status='processed' AND (cia.id IS NULL OR cia.strategy_version<>?)
      ORDER BY s.captured_at ASC`).all(this.strategyVersion)) this.enqueue("analyze_source_diagnostic", row.id);
    for (const row of this.db.prepare("SELECT slug FROM destinations").all()) {
      if (!researchSlugs.has(row.slug)) this.enqueue("rebuild_topics", row.slug);
    }
    this.reconcileApprovedOpportunities();
    if (wordpressEnabled) {
      for (const row of this.db.prepare(`SELECT ad.id, cc.id AS commercial_id, pc.id AS publish_id,
          fp.id AS frontend_page_id, fp.status AS frontend_page_status
        FROM article_drafts ad LEFT JOIN commercial_compositions cc ON cc.draft_id=ad.id
        LEFT JOIN frontend_publish_compositions pc ON pc.draft_id=ad.id
        LEFT JOIN frontend_page_compositions fp ON fp.draft_id=ad.id
        WHERE ad.status IN ('ready_for_wordpress','commercial_ready')`).all()) {
        let jobType = !row.commercial_id ? "compose_commercial" : "push_wordpress_draft";
        if (contractAware && row.commercial_id) {
          if (!row.frontend_page_id || row.frontend_page_status === "stale_contract") jobType = "compose_frontend_page";
          else if (!row.publish_id) jobType = "compose_publish_page";
        }
        this.enqueue(jobType, row.id);
      }
    }
  }

  reconcileCoverageAuditFalsePositives() {
    const rows = this.db.prepare("SELECT * FROM extraction_coverage WHERE status='manual_review' AND claim_count>0").all();
    const acceptedSourceIds = new Set();
    const timestamp = now();
    transaction(this.db, () => {
      for (const row of rows) {
        const uncovered = json(row.uncovered_spans_json, []);
        if (!uncovered.length || !uncovered.every(unsupportedClaimAuditFalsePositive)) continue;
        const audit = json(row.audit_json, {});
        this.db.prepare(`UPDATE extraction_coverage SET status='passed',important_uncovered_count=0,uncovered_spans_json='[]',
          audit_json=?,audited_at=? WHERE id=?`).run(JSON.stringify({ ...audit, autoAccepted: true,
          autoAcceptedReason: "unsupported_extracted_claims_are_excluded_not_source_gaps", dismissedGaps: uncovered }), timestamp, row.id);
        this.db.prepare("UPDATE source_segments SET status='complete',updated_at=? WHERE id=?").run(timestamp, row.segment_id);
        acceptedSourceIds.add(row.source_id);
      }
      for (const sourceId of acceptedSourceIds) {
        const state = this.reconcileSourceCoverageState(sourceId);
        if (state.ready) {
          this.db.prepare("UPDATE sources SET status='processing',last_error=NULL,updated_at=? WHERE id=?").run(timestamp, sourceId);
          this.enqueue("finalize_source_extraction", sourceId);
        }
      }
    });
    return acceptedSourceIds.size;
  }

  reconcileEntityRelationshipCandidates() {
    const rows = this.db.prepare(`SELECT * FROM entity_merge_candidates
      WHERE status='pending' AND suggested_relation IS NOT NULL
        AND suggested_relation NOT IN ('same_as','alias_of')`).all();
    let resolved = 0;
    for (const row of rows) {
      const subjectKey = row.candidate_entity_key
        || `other.candidate_${sha256(`${row.destination_slug}:${row.alias_normalized}`).slice(0, 16)}`;
      const relation = this.upsertEntityRelation(row.destination_slug, subjectKey, row.suggested_relation,
        row.proposed_entity_key, "model", Number(row.confidence || 0),
        String(row.rationale || "模型判断两个名称有关联，但没有足够证据把它们合并成同一实体。").slice(0, 1_000));
      if (!relation) continue;
      const timestamp = now();
      this.db.prepare(`UPDATE entity_merge_candidates SET status='rejected',
        decision_reason='Automatically retained as a non-identity entity relation; no merge was performed.',
        decided_at=?,updated_at=? WHERE id=? AND status='pending'`).run(timestamp, timestamp, row.id);
      resolved += 1;
    }
    return resolved;
  }

  resetDerivedResearchAndRequeue() {
    const timestamp = now();
    const sourceIds = this.db.prepare("SELECT id FROM sources ORDER BY created_at").all().map((row) => row.id);
    transaction(this.db, () => {
      // Opportunity, Recommendation, and Candidate records intentionally retain
      // bidirectional links. Defer their foreign-key checks until every derived
      // projection has been removed in this same atomic transaction.
      this.db.exec("PRAGMA defer_foreign_keys = ON");
      for (const table of [
        "frontend_publish_compositions", "wordpress_publications", "commercial_compositions", "affiliate_opportunities", "commercial_events",
        "commercial_slots", "commercial_intents",
        "quality_reviews", "article_visuals", "frontend_page_compositions", "frontend_page_plans", "frontend_capability_requests",
        "article_drafts", "content_briefs", "topic_candidates", "content_opportunities", "content_recommendations", "content_intake_analyses",
        "coverage_matrices", "topic_clusters", "knowledge_resolutions", "knowledge_visibility_overrides", "knowledge_facts", "claim_review_cases", "claim_relations",
        "entity_merge_candidates", "entity_merge_history", "entity_relations", "entity_aliases", "editorial_blueprints", "source_blueprints",
        "claim_history", "claims", "evidence_spans", "extraction_coverage", "segment_extractions", "source_segments",
        "source_family_memberships", "source_families", "extraction_runs", "structured_sources", "jobs",
      ]) this.db.prepare(`DELETE FROM ${table}`).run();
      this.db.prepare("UPDATE source_assets SET extraction_status='pending',extraction_error=NULL,processed_at=NULL").run();
      this.db.prepare("UPDATE sources SET status='captured',last_error=NULL,diagnostic_json='{}',destination_scopes_json='[]',topic_scopes_json='[]',updated_at=?").run(timestamp);
      for (const sourceId of sourceIds) this.enqueue("extract_source", sourceId);
    });
    return { preservedSources: sourceIds.length, requeuedSources: sourceIds.length, resetAt: timestamp };
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

  listWordPressPublicationStates() {
    return this.db.prepare(`
      SELECT ad.id AS draft_id, ad.title, ad.status AS draft_status, ad.updated_at,
        qr.passed AS qa_passed, cc.status AS commercial_status, pc.status AS publish_composition_status,
        wp.status AS wordpress_status, wp.post_id, wp.post_url, wp.preview_url, wp.edit_url,
        wp.last_error, wp.error_code, wp.delivery_mode,
        CASE
          WHEN wp.status='synced' AND wp.post_id IS NOT NULL THEN 'wordpress_draft'
          WHEN wp.status='failed' THEN 'delivery_failed'
          WHEN wp.status='queued' THEN 'queued'
          WHEN pc.status='delivered' THEN 'delivered'
          WHEN pc.status='valid' THEN 'ready_to_deliver'
          ELSE 'not_ready'
        END AS delivery_state
      FROM article_drafts ad
      LEFT JOIN quality_reviews qr ON qr.id=(SELECT id FROM quality_reviews WHERE draft_id=ad.id ORDER BY created_at DESC LIMIT 1)
      LEFT JOIN commercial_compositions cc ON cc.draft_id=ad.id
      LEFT JOIN frontend_publish_compositions pc ON pc.draft_id=ad.id
      LEFT JOIN wordpress_publications wp ON wp.draft_id=ad.id
      ORDER BY ad.updated_at DESC
    `).all();
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

  classifyPublicationLifecycle(title) {
    const titleSlug = slugify(title);
    const normalizedTitle = normalizeTitle(title);
    const titleTokens = topicTokens(title);
    for (const row of this.db.prepare("SELECT * FROM wordpress_content_inventory WHERE status='publish'").all()) {
      if (row.slug === titleSlug || normalizeTitle(row.title) === normalizedTitle) {
        return { action: "update", targetPostId: row.post_id, impact: { existingUrl: row.post_url, existingTitle: row.title, requiresEditorialApproval: true } };
      }
      const rowTokens = topicTokens(row.title);
      const union = new Set([...titleTokens, ...rowTokens]);
      const intersection = [...titleTokens].filter((token) => rowTokens.has(token)).length;
      if (union.size && intersection / union.size >= 0.78) {
        return { action: "merge", targetPostId: row.post_id, impact: { existingUrl: row.post_url, existingTitle: row.title, requiresEditorialApproval: true } };
      }
    }
    return { action: "create", targetPostId: null, impact: { requiresEditorialApproval: false } };
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
      WHERE d.slug=? AND k.visibility_status='visible' ORDER BY k.consensus_status='conflicted' DESC, k.support_count DESC, k.normalized_key
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

  setClaimLifecycle(claimId, action, reason = "", actor = "admin") {
    if (!["exclude", "restore"].includes(action)) throw new Error("Claim action must be exclude or restore.");
    const claim = this.db.prepare(`SELECT c.*,ss.destination_slug FROM claims c JOIN structured_sources ss ON ss.source_id=c.source_id WHERE c.id=?`).get(claimId);
    if (!claim) return null;
    const excluded = action === "exclude";
    this.db.prepare("UPDATE claims SET lifecycle_status=?,exclusion_reason=?,excluded_at=?,excluded_by=? WHERE id=?")
      .run(excluded ? "excluded" : "active", excluded ? String(reason || "Excluded by administrator").slice(0, 1000) : null,
        excluded ? now() : null, excluded ? actor : null, claimId);
    this.enqueue("rebuild_knowledge", claim.destination_slug);
    return { claimId, action, status: excluded ? "excluded" : "active", destinationSlug: claim.destination_slug };
  }

  setKnowledgeVisibility(factId, action, reason = "", actor = "admin") {
    if (!["hide", "restore"].includes(action)) throw new Error("Knowledge action must be hide or restore.");
    const fact = this.db.prepare(`SELECT k.*,d.slug AS destination_slug FROM knowledge_facts k JOIN destinations d ON d.id=k.destination_id WHERE k.id=?`).get(factId);
    if (!fact) return null;
    const hidden = action === "hide";
    const timestamp = now();
    const visibilityReason = hidden ? String(reason || "Hidden by administrator").slice(0, 1000) : null;
    this.db.prepare(`INSERT INTO knowledge_visibility_overrides(destination_slug,normalized_key,visibility_status,reason,updated_by,updated_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(destination_slug,normalized_key) DO UPDATE SET visibility_status=excluded.visibility_status,
      reason=excluded.reason,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
      .run(fact.destination_slug, fact.normalized_key, hidden ? "hidden" : "visible", visibilityReason,
        String(actor || "admin").slice(0, 200), timestamp);
    this.db.prepare("UPDATE knowledge_facts SET visibility_status=?,visibility_reason=?,visibility_updated_at=? WHERE id=?")
      .run(hidden ? "hidden" : "visible", visibilityReason, timestamp, factId);
    return { factId, action, status: hidden ? "hidden" : "visible", destinationSlug: fact.destination_slug };
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
      SELECT sa.id, sa.source_id, sa.remote_url, sa.alt_text, sa.position, s.title AS source_title,
        COALESCE((SELECT group_concat(canonical_subject || ' ' || subject || ' ' || predicate || ' ' || value_text, ' ')
          FROM claims c WHERE c.source_id=sa.source_id AND EXISTS (
            SELECT 1 FROM json_each(c.evidence_span_ids_json) ids
            JOIN evidence_spans es ON es.id=ids.value WHERE es.asset_id=sa.id
          )), '') AS evidence_text
      FROM source_assets sa JOIN sources s ON s.id=sa.source_id
      WHERE sa.kind='image' AND s.adapter='xiaohongshu'
        AND s.authorization_status='owner_confirmed' AND s.publishable=1
        AND sa.authorization_status='owner_confirmed' AND sa.publishable=1
        AND sa.source_id IN (${placeholders})
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
        stale ? "知识事实已过期，需要更新来源" : "知识事实存在冲突，需要判断",
        `${row.subject} · ${row.predicate}`, stale ? `最近一条证据时间：${row.latest_evidence_at || "未知"}`
          : "系统发现同一事实下存在不能自动合并的不同取值，暂时不会把它用于内容生产。",
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
      a.evidence_span_ids_json AS evidence_span_ids_a,
      b.source_id AS source_id_b, b.subject AS subject_b, b.predicate AS predicate_b, b.value_text AS value_b,
      b.source_quote AS source_quote_b, b.structured_value_json AS structured_b,
      b.evidence_span_ids_json AS evidence_span_ids_b
      FROM claim_review_cases r JOIN claims a ON a.id=r.claim_a_id
      LEFT JOIN claims b ON b.id=r.claim_b_id WHERE r.status='pending' ORDER BY r.updated_at DESC`).all()) {
      const kind = ({ CLAIM_CONFLICT: "claim_conflict", SOURCE_CONFLICT: "source_conflict", TEMPORAL_CONFLICT: "temporal_conflict",
        GRANULARITY_CONFLICT: "granularity_conflict", NEGATION_EXTRACTION_ERROR: "extraction_error",
        QUALIFIER_EXTRACTION_ERROR: "extraction_error" })[row.review_type] || "claim_conflict";
      const presentation = claimReviewPresentation(row.review_type);
      const item = exceptionItem(kind, row.id, "warning", presentation.title, `${row.subject_a} · ${row.predicate_a}`, presentation.detail, false, row.updated_at);
      item.claim_review = {
        id: row.id, reviewType: row.review_type, destinationSlug: row.destination_slug,
        explanation: presentation.explanation,
        claimA: { id: row.claim_a_id, sourceId: row.source_id_a, originalSentence: row.source_quote_a,
          evidence: this.claimReviewEvidence(row.source_id_a, row.evidence_span_ids_a, row.source_quote_a),
          normalized: { subject: row.subject_a, predicate: row.predicate_a, value: row.value_a, structured: json(row.structured_a, {}) } },
        claimB: row.claim_b_id ? { id: row.claim_b_id, sourceId: row.source_id_b, originalSentence: row.source_quote_b,
          evidence: this.claimReviewEvidence(row.source_id_b, row.evidence_span_ids_b, row.source_quote_b),
          normalized: { subject: row.subject_b, predicate: row.predicate_b, value: row.value_b, structured: json(row.structured_b, {}) } } : null,
      };
      items.push(item);
    }
    for (const row of this.listEntityMergeCandidates("pending")) {
      const item = exceptionItem("entity_identity", row.id, "warning", "两个名称可能指同一对象，需要确认",
        `${row.alias} → ${row.proposed_canonical_subject}`,
        row.rationale || "系统发现两个名称可能是同一地点或商家，但现有证据不足以安全合并。确认前，两边的信息都会原样保留，不会丢失或互相覆盖。",
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

  retryOperationalException(exceptionKey, { contractAware = false } = {}) {
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
      return Boolean(row && this.retryContent(row.candidate_id, { contractAware }));
    }
    if (["draft", "wordpress"].includes(kind)) {
      const row = this.db.prepare(`
        SELECT cb.candidate_id FROM article_drafts ad JOIN content_briefs cb ON cb.id=ad.brief_id WHERE ad.id=?
      `).get(entityId);
      return Boolean(row && this.retryContent(row.candidate_id, { contractAware }));
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
    const pendingRecommendations = this.db.prepare("SELECT COUNT(*) AS count FROM content_recommendations WHERE decision='pending'").get().count;
    const contentNeedsAttention = exceptionCount("brief") + exceptionCount("draft");
    const contentPipelineItems = this.db.prepare(`
      SELECT COUNT(DISTINCT candidate_id) AS count FROM content_opportunities
      WHERE candidate_id IS NOT NULL AND status IN ('producing','drafted','qa_failed','ready_for_wordpress','wordpress_draft')
    `).get().count;
    return {
      sources: Object.fromEntries(statuses.map((row) => [row.status, row.count])),
      actionCounts: {
        sources: exceptionCount("source"),
        recommendations: pendingRecommendations,
        knowledge: 0,
        blueprints: 0,
        content: contentNeedsAttention,
        wordpress: exceptionCount("wordpress") + operationalExceptions.filter((item) => item.kind === "sync" && String(item.subject || "").startsWith("wordpress_inventory:")).length,
        commercial: this.db.prepare(`SELECT
          (SELECT COUNT(*) FROM affiliate_asset_queue_tasks WHERE status IN ('PENDING','READY_FOR_MANUAL','INVALID')) +
          (SELECT COUNT(*) FROM affiliate_opportunities o WHERE o.status='open' AND NOT EXISTS (
            SELECT 1 FROM affiliate_asset_queue_tasks q WHERE q.product_category=o.product_category
              AND q.scope_type=o.scope_type AND q.scope_key=o.scope_key
          )) AS count`).get().count,
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
        pendingRecommendations,
        contentPipelineItems,
        contentNeedsAttention,
        draftsReady: this.db.prepare("SELECT COUNT(*) AS count FROM article_drafts WHERE status IN ('ready_for_wordpress','commercial_ready','wordpress_draft')").get().count,
        activeOffers: this.db.prepare("SELECT COUNT(*) AS count FROM affiliate_assets WHERE active=1").get().count,
        affiliateQueueTasks: this.db.prepare("SELECT COUNT(*) AS count FROM affiliate_asset_queue_tasks WHERE status IN ('PENDING','READY_FOR_MANUAL','INVALID')").get().count,
        wordpressInventory: this.db.prepare("SELECT COUNT(*) AS count FROM wordpress_content_inventory").get().count,
        searchQueries: this.db.prepare("SELECT COUNT(*) AS count FROM search_console_inventory").get().count,
      },
      jobs: this.db.prepare("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status").all(),
      modelUsage: this.db.prepare(`SELECT stage, provider, model, COUNT(*) AS calls,
        SUM(COALESCE(input_tokens,0)) AS input_tokens, SUM(COALESCE(output_tokens,0)) AS output_tokens,
        SUM(COALESCE(cached_tokens,0)) AS cached_tokens, ROUND(AVG(latency_ms),1) AS average_latency_ms,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failures, SUM(cost_usd) AS known_cost_usd
        FROM model_call_metrics GROUP BY stage, provider, model ORDER BY calls DESC`).all(),
    };
  }

  recordModelCall(metric) {
    this.db.prepare(`INSERT INTO model_call_metrics(id,stage,provider,model,prompt_hash,schema_hash,input_hash,
      input_tokens,output_tokens,cached_tokens,latency_ms,attempts,status,error_code,cost_usd,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id("modelcall"), metric.stage || "unknown", metric.provider || "unknown", metric.model || "unknown",
      metric.promptHash || "", metric.schemaHash || "", metric.inputHash || "", metric.inputTokens ?? null,
      metric.outputTokens ?? null, metric.cachedTokens ?? null, metric.latencyMs ?? 0, metric.attempts ?? 1,
      metric.status || "succeeded", metric.errorCode || null, metric.costUsd ?? null, now(),
    );
    if (metric.status === "succeeded" && Number(metric.attempts ?? 1) > 0 && this.providerPressureStreak) {
      this.providerSuccessStreak += 1;
      if (this.providerSuccessStreak >= this.providerRecoverySuccesses) {
        this.providerPressureStreak = 0;
        this.providerSuccessStreak = 0;
        this.providerBackoffUntil = 0;
      }
    }
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

function hydrateSource({ source, assets, files = [], structured, claims, extractionRuns = [], claimHistory = [], blueprint, analysis = null, recommendation = null, segments = [], coverage = [], family = null, captureVersions = [] }) {
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
  source.completeness = json(source.completeness_json, {});
  source.license_scope = json(source.license_scope_json, []);
  source.commercial_use_allowed = Boolean(source.commercial_use_allowed);
  source.editing_allowed = Boolean(source.editing_allowed);
  source.redistribution_allowed = Boolean(source.redistribution_allowed);
  source.publishable = Boolean(source.publishable);
  for (const asset of assets) {
    asset.provenance = json(asset.provenance_json, {});
    asset.commercial_use_allowed = Boolean(asset.commercial_use_allowed);
    asset.editing_allowed = Boolean(asset.editing_allowed);
    asset.redistribution_allowed = Boolean(asset.redistribution_allowed);
    asset.publishable = Boolean(asset.publishable);
  }
  delete source.raw_payload_json;
  delete source.submission_metadata_json;
  delete source.completeness_json;
  delete source.license_scope_json;
  return {
    ...source, assets, files, structured, claims, extraction_runs: extractionRuns,
    capture_versions: captureVersions,
    claim_history: claimHistory.map((row) => ({ ...row, snapshot: json(row.snapshot_json, {}) })), blueprint,
    analysis: analysis ? { ...analysis, data: json(analysis.analysis_json, {}) } : null,
    recommendation: recommendation ? hydrateRecommendation(recommendation) : null,
    segments: segments.map((row) => ({ ...row, destination_scopes: json(row.destination_scopes_json, []), topic_scopes: json(row.topic_scopes_json, []) })),
    extraction_coverage: coverage.map((row) => ({ ...row, uncovered_spans: json(row.uncovered_spans_json, []) })),
    source_family: family ? { ...family, analysis: json(family.analysis_json, {}) } : null,
  };
}

function sourceExcerpt(rawText, exactQuote, maxChars = 2_400) {
  const text = String(rawText || "").trim();
  if (!text) return "";
  const quote = String(exactQuote || "").trim();
  const quoteIndex = quote ? text.indexOf(quote) : -1;
  if (quoteIndex < 0) return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  const padding = Math.max(300, Math.floor((maxChars - quote.length) / 2));
  const start = Math.max(0, quoteIndex - padding);
  const end = Math.min(text.length, quoteIndex + quote.length + padding);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function captureContentHash(capture) {
  const media = (capture.assets || []).map((asset) => ({
    kind: asset.kind,
    identity: asset.mediaIdentity || asset.url,
    url: asset.url,
    position: asset.position,
    originalSha256: asset.originalSha256 || "",
  }));
  const files = (capture.files || []).map((file) => ({ kind: file.fileKind, sha256: file.sha256, sizeBytes: file.sizeBytes }));
  return sha256(JSON.stringify({
    rawText: String(capture.rawText || ""),
    rawHtml: String(capture.rawHtml || ""),
    title: String(capture.title || ""),
    authorName: String(capture.authorName || ""),
    publishedAt: capture.publishedAt || null,
    media,
    files,
  }));
}

function safeIsoDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function draftMetadata(draft, brief, config, authorizedSourceAssets = [], policy = contentPolicyFor(brief)) {
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
    faqs: policy.faq?.allowed
      ? (draft.faqs || []).slice(0, policy.faq.maximum || 4).map((item) => ({ question: truncateText(item.question, 220), answer: truncateText(item.answer, 700) }))
      : [],
  };
  const visuals = normalizeVisuals(draft.visuals, draft, brief, authorizedSourceAssets, policy);
  const firstGenerated = visuals.find((visual) => visual.status === "generated" && visual.media_url);
  if (firstGenerated) seo.og_image = firstGenerated.media_url;
  const blocks = markdownToContentBlocks(draft.body_markdown);
  return {
    seo, visuals, blocks,
    schema: buildArticleSchema({ ...draft, seo, destination_slug: brief.destination_slug, canonical }, visuals, config),
  };
}

export function contentPolicyFor(brief, facts = []) {
  const canonical = json(brief?.canonical_json, brief?.canonical || {});
  const type = canonical.content_type || "first_time_guide";
  const substantialEvidence = facts.filter((fact) => fact.freshness_state !== "stale").length;
  const profiles = {
    city_guide: [1000, 2400, 3], first_time_guide: [1000, 2400, 3], itinerary: [900, 2200, 3],
    comparison: [700, 1700, 2], listicle: [700, 1800, 2], food_guide: [800, 2000, 3],
    neighborhood_guide: [700, 1700, 2], hotel_area_guide: [700, 1700, 2], shopping_guide: [700, 1700, 2],
    attraction_guide: [600, 1600, 2], transport_guide: [600, 1500, 2], practical_guide: [500, 1400, 2], how_to: [500, 1400, 2],
  };
  const [baseMinimum, maximumWords, baseVisuals] = profiles[type] || profiles.first_time_guide;
  const minimumWords = Math.min(baseMinimum, Math.max(350, substantialEvidence * 120));
  const questionIntent = /\b(?:how|what|when|where|which|can|should|is|are|faq|questions?)\b/i
    .test(`${brief?.topic || ""} ${brief?.search_intent || ""} ${canonical.primary_query || ""}`);
  const faqSupported = questionIntent && substantialEvidence >= 3;
  return {
    version: "content-policy-1.0",
    content_type: type,
    minimum_words: minimumWords,
    target_words: Math.min(maximumWords, Math.max(minimumWords, substantialEvidence * 180)),
    maximum_words: maximumWords,
    required_visible_sections: ["key_takeaways"],
    faq: { required: false, allowed: faqSupported, minimum: 0, maximum: faqSupported ? 4 : 0 },
    visuals: { minimum: substantialEvidence >= 2 ? Math.min(baseVisuals, 2) : 1, target: Math.min(baseVisuals, Math.max(1, Math.ceil(substantialEvidence / 4))), maximum: baseVisuals + 1 },
  };
}

function readerSources(facts) {
  const unique = new Map();
  for (const evidence of facts.flatMap((fact) => fact.evidence || [])) {
    const url = String(evidence.canonical_url || evidence.url || "").trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const key = url.toLowerCase();
    if (!unique.has(key)) unique.set(key, {
      label: truncateText(evidence.source_title || evidence.title || safeHostname(url), 180),
      url,
      published_at: evidence.published_at || evidence.observed_at || null,
      verified_at: evidence.verified_at || null,
      authority_level: evidence.authority_level || null,
    });
  }
  return [...unique.values()].slice(0, 20);
}

function safeHostname(value) {
  try { return new URL(value).hostname; } catch { return "Source"; }
}

function draftContentHash(draft, metadata, brief) {
  return sha256(JSON.stringify({
    title: draft.title,
    slug: draft.slug,
    body_markdown: draft.body_markdown,
    meta_description: draft.meta_description,
    evidence_ledger: draft.evidence_ledger || [],
    unresolved_conflicts: draft.unresolved_conflicts || [],
    verification_notes: draft.verification_notes || [],
    seo: metadata.seo,
    content_blocks: metadata.blocks,
    strategy_version: brief.strategy_version,
  }));
}

function evidenceHashForFacts(facts) {
  return sha256(JSON.stringify((facts || []).map((fact) => ({
    key: fact.normalized_key,
    value: fact.preferred_value,
    status: fact.consensus_status,
    freshness: fact.freshness_state,
    updatedAt: fact.updated_at,
  }))));
}

function buildBlockProvenance(payload, ledger) {
  const occurrences = new Map();
  return (payload?.blocks || []).map((block, index) => {
    const semantic = JSON.stringify(block?.data || {});
    const base = sha256(`${block?.type || "unknown"}:${semantic}`).slice(0, 20);
    const occurrence = (occurrences.get(base) || 0) + 1;
    occurrences.set(base, occurrence);
    const evidence = ledger[index] || {};
    return {
      blockId: `block_${base}_${occurrence}`,
      type: block?.type || "unknown",
      semanticRole: evidence.section || block?.type || "content",
      claimKeys: evidence.claim_keys || [],
      sourceIds: evidence.source_ids || [],
    };
  });
}

function normalizeVisuals(values, draft, brief, authorizedSourceAssets = [], policy = {}) {
  const minimum = policy.visuals?.minimum ?? 1;
  const maximum = policy.visuals?.maximum ?? 5;
  const requestedTarget = policy.visuals?.target ?? visualCountForWords(wordCount(draft.body_markdown));
  const target = Math.max(minimum, Math.min(maximum, Array.isArray(values) && values.length ? values.length : requestedTarget));
  const allowedPlacements = ["hero", "after_intro", "mid_article", "before_faq", "closing"];
  const allowedRatios = ["16:9", "4:3", "1:1", "3:2", "9:16"];
  const supplied = Array.isArray(values) ? values : [];
  const visuals = supplied.slice(0, target).map((item, index) => normalizeVisual(item, index, draft, brief, allowedPlacements, allowedRatios));
  while (visuals.length < target) {
    const index = visuals.length;
    visuals.push(normalizeVisual({}, index, draft, brief, allowedPlacements, allowedRatios));
  }
  if (!authorizedSourceAssets.length) return visuals;

  const unusedAssets = new Map(authorizedSourceAssets.map((asset) => [asset.id, asset]));
  return visuals.map((visual) => {
    if (visual.image_type !== "real_world_photo") return visual;
    const ranked = [...unusedAssets.values()].map((asset) => ({ asset, score: visualAssetMatchScore(visual, asset) }))
      .sort((left, right) => right.score - left.score);
    const match = ranked[0];
    // Asset ownership is insufficient: a factual photo is reusable only when its
    // own alt/evidence metadata matches the planned subject.
    if (!match || match.score < 0.34) return visual;
    const asset = match.asset;
    unusedAssets.delete(asset.id);
    return {
      ...visual,
      purpose: truncateText(visual.purpose || `Evidence-linked view for ${draft.title}`, 300),
      alt_text: truncateText(asset.alt_text || visual.alt_text || visual.image_subject, 220),
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

function visualAssetMatchScore(visual, asset) {
  const requested = topicTokens(`${visual.image_subject || ""} ${visual.purpose || ""}`);
  const described = topicTokens(`${asset.alt_text || ""} ${asset.source_title || ""} ${asset.evidence_text || ""}`);
  if (!requested.size || !described.size) return 0;
  const overlap = [...requested].filter((token) => described.has(token)).length;
  return overlap / Math.max(1, Math.min(requested.size, described.size));
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

function visualFingerprint(visual) {
  return sha256(JSON.stringify({
    image_type: visual.image_type,
    image_subject: visual.image_subject,
    acquisition_strategy: visual.acquisition_strategy,
    generation_prompt: visual.generation_prompt,
    aspect_ratio: visual.aspect_ratio,
    source_asset_id: visual.source_asset_id || null,
    source_remote_url: visual.source_remote_url || null,
  }));
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
  const productionMode = normalizeProductionMode(value?.production_mode, classification);
  const productionModes = [...new Set([productionMode, ...(Array.isArray(value?.production_modes) ? value.production_modes : [])
    .map((item) => normalizeProductionMode(item, classification))])].slice(0, 3);
  const productionPaths = (Array.isArray(value?.production_paths) ? value.production_paths : []).slice(0, 8).map((item) => ({
    mode: normalizeProductionMode(item?.mode, classification),
    content_type: normalizeContentType(item?.content_type || value?.suggested_content_type),
    title: truncateText(item?.title || value?.suggested_article_title || value?.primary_topic || "Content opportunity", 180),
    reader_promise: truncateText(item?.reader_promise || "", 600),
    why_it_works: truncateText(item?.why_it_works || "", 1_000),
    evidence_boundary: truncateText(item?.evidence_boundary || "", 1_000),
  })).filter((item) => item.title && item.reader_promise);
  if (!productionPaths.length) productionPaths.push({
    mode: productionMode,
    content_type: normalizeContentType(value?.suggested_content_type),
    title: truncateText(value?.suggested_article_title || value?.primary_topic || "Content opportunity", 180),
    reader_promise: truncateText(value?.primary_topic || "A bounded, evidence-backed travel answer", 600),
    why_it_works: "现有来源已能支持一个边界清楚的内容主题。",
    evidence_boundary: "只使用当前来源和已经结构化的证据；未被证据覆盖的细节不写入。",
  });
  return {
    strategy_version: strategyVersion,
    classification,
    production_mode: productionMode,
    production_modes: productionModes,
    production_paths: productionPaths,
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
    reasoning_summary: truncateText(value?.reasoning_summary || "请先核对证据，再决定下一步内容动作。", 2_000),
  };
}

function normalizeProductionMode(value, classification = "UNSURE") {
  const supplied = String(value || "").trim().toUpperCase();
  if (["SOURCE_ADAPTATION", "TOPIC_FEATURE", "MULTI_SOURCE_SYNTHESIS"].includes(supplied)) return supplied;
  return classification === "ARTICLE_CANDIDATE" ? "TOPIC_FEATURE" : "MULTI_SOURCE_SYNTHESIS";
}

function unsupportedClaimAuditFalsePositive(item) {
  const reason = String(item?.reason || "").toLowerCase();
  return /extracted claims?.*(?:do not|does not|without|missing).*(?:quote|traceable|source span)|(?:quote|traceable).*(?:extracted claims?)/i.test(reason);
}

function normalizePublicationMode(value) {
  const supplied = String(value || "").trim().toLowerCase();
  if (["source_adaptation", "topic_feature", "multi_source_synthesis"].includes(supplied)) return supplied;
  return "multi_source_synthesis";
}

function hydrateRecommendation(row, opportunityRows = []) {
  const analysis = row.analysis_json ? json(row.analysis_json, {}) : null;
  const opportunities = opportunityRows.map((item) => ({
    id: item.id,
    title: item.title,
    status: item.status,
    candidate_id: item.candidate_id,
    readiness: json(item.readiness_json, {}),
    coverage: json(item.coverage_json, {}),
  }));
  const productionPaths = (analysis?.production_paths || []).map((path) => {
    const opportunity = opportunities.find((item) => item.title === path.title
      && String(item.coverage?.publicationMode || "").toUpperCase() === String(path.mode || "").toUpperCase());
    return { ...path, opportunity_id: opportunity?.id || null, opportunity_status: opportunity?.status || null,
      readiness: opportunity?.readiness || null, candidate_id: opportunity?.candidate_id || null };
  });
  return { ...row, analysis, missing_information: analysis?.missing_information || [], possible_cluster_topics: analysis?.possible_cluster_topics || [],
    production_modes: analysis?.production_modes || [analysis?.production_mode].filter(Boolean), production_paths: productionPaths,
    opportunities };
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

function normalizeContentType(value) {
  const normalized = slugify(value || "").replaceAll("-", "_");
  return ["city_guide","itinerary","attraction_guide","food_guide","transport_guide","neighborhood_guide","hotel_area_guide","shopping_guide","practical_guide","first_time_guide","comparison","listicle","how_to"].includes(normalized)
    ? normalized : "practical_guide";
}

function mergeBlueprints(values) {
  const blueprints = Array.isArray(values) ? values : [];
  const first = blueprints[0] || {};
  const unique = (items) => [...new Set(items.filter(Boolean))];
  return {
    format: first.format || "multi-segment evidence container",
    hook: first.hook || "",
    angle: first.angle || "evidence-led travel guidance",
    sections: unique(blueprints.flatMap((item) => (item.sections || []).map((section) => JSON.stringify(section)))).map((item) => JSON.parse(item)),
    strengths: unique(blueprints.flatMap((item) => item.strengths || [])),
    gaps: unique(blueprints.flatMap((item) => item.gaps || [])),
  };
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

function storedColumnsMatch(current, expected) {
  if (!current) return false;
  return Object.entries(expected).every(([column, value]) => (current[column] ?? null) === (value ?? null));
}

function sourceQueueStates(rows) {
  const groups = Map.groupBy(rows || [], (row) => row.source_id);
  const states = [];
  const nowMs = Date.now();
  for (const [sourceId, jobs] of groups) {
    const active = jobs.filter((job) => ["queued", "running"].includes(job.status));
    const running = active.filter((job) => job.status === "running").sort(compareRunningJobs);
    const queued = active.filter((job) => job.status === "queued");
    const eligible = queued.filter((job) => Date.parse(job.available_at) <= nowMs).sort(compareEligibleJobs);
    const cooling = queued.filter((job) => Date.parse(job.available_at) > nowMs).sort(compareCoolingJobs);
    const failed = jobs.filter((job) => job.status === "failed").sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    const state = running.length ? "running" : eligible.length ? "queued" : cooling.length ? "cooldown" : failed.length ? "failed" : null;
    if (!state) continue;
    const next = running[0] || eligible[0] || cooling[0] || failed[0];
    states.push({ sourceId, state, stage: next.type, running_job_count: running.length,
      queued_job_count: queued.length, job_count: active.length || failed.length,
      available_at: next.available_at || null, started_at: next.started_at || null,
      attempts: Number(next.attempts || 0), max_attempts: Number(next.max_attempts || 0),
      last_error: next.last_error || null, updated_at: next.updated_at,
      queue_position: null, queue_ahead: null, _next: next });
  }
  const runningCount = states.filter((item) => item.state === "running").length;
  const waiting = states.filter((item) => ["queued", "cooldown"].includes(item.state)).sort((a, b) => {
    if (a.state !== b.state) return a.state === "queued" ? -1 : 1;
    return a.state === "queued" ? compareEligibleJobs(a._next, b._next) : compareCoolingJobs(a._next, b._next);
  });
  waiting.forEach((item, index) => {
    item.queue_position = index + 1;
    item.queue_ahead = runningCount + index;
  });
  return new Map(states.map(({ _next, ...item }) => [item.sourceId, item]));
}

function extractionJobPriority(type) {
  if (type === "finalize_source_extraction") return 0;
  if (type === "retry_segment_extraction") return 4;
  if (type === "audit_segment_coverage") return 5;
  if (type === "extract_segment_claims") return 9;
  if (type === "segment_source") return 10;
  if (type === "preflight_source") return 11;
  if (type === "extract_source") return 12;
  return 9;
}

function compareEligibleJobs(a, b) {
  return extractionJobPriority(a.type) - extractionJobPriority(b.type)
    || String(a.created_at).localeCompare(String(b.created_at))
    || String(a.id).localeCompare(String(b.id));
}

function compareCoolingJobs(a, b) {
  return String(a.available_at).localeCompare(String(b.available_at)) || compareEligibleJobs(a, b);
}

function compareRunningJobs(a, b) {
  return String(a.started_at || a.created_at).localeCompare(String(b.started_at || b.created_at))
    || compareEligibleJobs(a, b);
}

function knowledgeValueSpecificity(value) {
  const normalized = normalizeValue(value);
  if (/^(?:true|false|yes|no|present|absent|available|unavailable|有|无|是|否)$/.test(normalized)) return 0;
  return normalized.length;
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
  const evidenceTimestamp = (row) => row.verified_at || row.source_verified_at || row.effective_from
    || row.source_effective_from || row.observed_at || row.source_observed_at || row.published_at || row.captured_at;
  const latestMillis = Math.max(...rows.map((row) => Date.parse(evidenceTimestamp(row)) || 0));
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

function claimReviewPresentation(reviewType) {
  if (reviewType === "NEGATION_EXTRACTION_ERROR") return {
    title: "原文中的否定语义可能没有被完整提取",
    detail: "系统在原文中看到了“不、无需、不能”等否定含义，但在整理后的信息中没有找到明确对应。",
    explanation: "请核对整理后的信息是否仍表达了原文的否定含义。例如“0 打扰”被整理成 contactless，语义已经保留，可以关闭误报；如果意思真的丢了，就重新提取。",
  };
  if (reviewType === "QUALIFIER_EXTRACTION_ERROR") return {
    title: "原文中的条件或限制可能没有被完整提取",
    detail: "系统在原文中看到了“只、至少、最多、除非”等限制表达，但在整理后的信息中没有找到明确对应。",
    explanation: "请看限制条件是否会改变事实本身。如果整理后的信息已经完整表达原意，关闭误报；如果遗漏了适用条件或范围，重新提取。",
  };
  if (reviewType === "TEMPORAL_CONFLICT") return {
    title: "同一事实在时间信息上可能冲突",
    detail: "两条信息描述同一对象，但日期、季节、营业时间或有效期不同，系统无法自动判断哪条当前有效。",
    explanation: "如果两条分别适用于不同时间，可以同时成立并关闭误报；如果它们说的是同一时段且不能同时为真，请选择正确的最终事实。",
  };
  if (reviewType === "GRANULARITY_CONFLICT") return {
    title: "两条信息描述的对象范围可能不同",
    detail: "系统无法确定两条信息是在说同一个对象，还是景区、建筑、房型等不同层级。",
    explanation: "如果两条说的是不同对象或范围，可以同时成立并关闭误报；如果确实在争夺同一事实，请进入最终事实判断。",
  };
  if (reviewType === "SOURCE_CONFLICT") return {
    title: "两条来源信息可能冲突，需要判断",
    detail: "系统把两条信息归到了同一个事实，但它们的表述不同，因此暂时没有自动采用其中任何一条。",
    explanation: "先判断两句话能否同时为真。只是译法、概括或详细程度不同，应选择“可以同时成立”；只有同一对象、同一时间、同一条件下互相否定时，才选择最终事实。",
  };
  return {
    title: "两条信息主张可能冲突，需要判断",
    detail: "系统认为两条信息可能在描述同一个事实，但暂时无法确认它们能否同时成立。",
    explanation: "先判断两句话能否同时为真。能同时成立就关闭误报；不能同时成立时，再选择应采用的最终事实。",
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
  const stopWords = new Set(["a", "an", "and", "for", "in", "of", "the", "to", "travel", "guide", "how", "visit", "independently", "first", "time", "solo", "practical"]);
  const normalized = normalizeTitle(value);
  const words = normalized.split(" ").filter((token) => token && !stopWords.has(token));
  const hanRuns = normalized.match(/[\p{Script=Han}]+/gu) || [];
  const ngrams = hanRuns.flatMap((run) => {
    const values = [];
    for (const size of [2, 3]) for (let index = 0; index <= run.length - size; index += 1) values.push(run.slice(index, index + size));
    return values;
  });
  return new Set([...words, ...ngrams]);
}

export function scopeFactsForOpportunity(facts, { destinationSlug, topic, title }) {
  const destinationTerms = topicTokens(destinationSlug);
  const terms = topicTokens(`${topic || ""} ${title || ""}`);
  for (const term of destinationTerms) terms.delete(term);
  // Generic destination guides intentionally use the destination-wide evidence set.
  if (!terms.size) return facts;
  return facts.filter((fact) => {
    const factTerms = topicTokens(`${fact.normalized_key || ""} ${fact.subject || ""} ${fact.predicate || ""}`);
    return [...terms].some((term) => factTerms.has(term));
  });
}

function factsForSource(facts, sourceId) {
  return (facts || []).filter((fact) => (fact.evidence || []).some((item) => item.source_id === sourceId));
}

function locateEvidenceQuote(rawText, quote) {
  const text = String(rawText || "");
  const candidate = String(quote || "").trim();
  if (!candidate) return { quote: "", start: null, end: null, status: "unsupported" };
  const exact = text.indexOf(candidate);
  if (exact >= 0) return { quote: candidate.slice(0, 800), start: exact, end: exact + candidate.length, status: "exact" };
  const normalizeWithMap = (value) => {
    let normalized = ""; const map = []; let inWhitespace = false;
    for (let index = 0; index < value.length; index += 1) {
      if (/\s/u.test(value[index])) {
        if (!inWhitespace) { normalized += " "; map.push(index); }
        inWhitespace = true;
      } else { normalized += value[index]; map.push(index); inWhitespace = false; }
    }
    return { normalized, map };
  };
  const source = normalizeWithMap(text);
  const needle = candidate.replace(/\s+/gu, " ").trim();
  const offset = source.normalized.indexOf(needle);
  if (offset < 0) return { quote: "", start: null, end: null, status: "unsupported" };
  const start = source.map[offset];
  const end = source.map[Math.min(source.map.length - 1, offset + needle.length - 1)] + 1;
  return { quote: text.slice(start, end).slice(0, 800), start, end, status: "normalized_exact" };
}

function suggestAuthority(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    if (host === "gov.cn" || host.endsWith(".gov.cn") || host.endsWith(".gov")) {
      return { authorityLevel: 1, reason: "Government-domain candidate", requiresHumanReview: true };
    }
  } catch { /* no URL-based suggestion */ }
  return { authorityLevel: 4, reason: "No trusted-domain signal", requiresHumanReview: true };
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
