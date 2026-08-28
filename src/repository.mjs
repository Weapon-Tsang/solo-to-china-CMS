import { id, json, now, sha256, slugify } from "./utils.mjs";
import { transaction } from "./db.mjs";
import { KIMI_MODELS } from "./config.mjs";

export class Repository {
  constructor(db, contentConfig = {}) {
    this.db = db;
    this.contentConfig = { staleAfterDays: 365, volatileStaleAfterDays: 90, searchConsoleMinimumImpressions: 10, ...contentConfig };
    // A running job belongs to the Node process that claimed it. Creating a new
    // repository happens during process startup, so any existing lock was left by
    // an interrupted process and must be made retryable immediately.
    this.db.prepare(`
      UPDATE jobs SET status = 'queued', attempts = 0, locked_at = NULL, started_at = NULL,
        completed_at = NULL, duration_ms = NULL, queue_latency_ms = NULL, updated_at = ?
      WHERE status = 'running'
    `).run(now());
  }

  getAiSettings(defaultModel) {
    const saved = this.db.prepare("SELECT value_json FROM runtime_settings WHERE setting_key='ai'").get();
    const model = json(saved?.value_json, {}).model;
    const selected = KIMI_MODELS.includes(model) ? model : defaultModel;
    return {
      model: selected,
      source: KIMI_MODELS.includes(model) ? "dashboard" : "environment",
      models: KIMI_MODELS.map((id) => ({
        id,
        label: id === "kimi-k3" ? "Kimi K3" : "Kimi K2.7 Code",
        description: id === "kimi-k3" ? "Flagship multimodal model for research, writing, and QA." : "Instruction-focused model for tighter structured output and editorial workflows.",
        supportsImages: true,
      })),
    };
  }

  setAiModel(model, defaultModel) {
    if (!KIMI_MODELS.includes(model)) throw new Error("Unsupported Kimi model.");
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO runtime_settings(setting_key, value_json, updated_at) VALUES ('ai', ?, ?)
      ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at
    `).run(JSON.stringify({ model }), timestamp);
    return this.getAiSettings(defaultModel);
  }

  saveCapture(capture) {
    const timestamp = now();
    const contentHash = sha256(`${capture.rawText}\n${capture.assets.map((item) => item.url).join("\n")}`);
    const existing = this.db.prepare("SELECT id, content_hash, capture_version FROM sources WHERE canonical_url = ?").get(capture.canonicalUrl);

    return transaction(this.db, () => {
      let sourceId;
      let duplicate = false;
      if (existing && existing.content_hash === contentHash) {
        sourceId = existing.id;
        duplicate = true;
        this.db.prepare("UPDATE sources SET captured_at = ?, updated_at = ? WHERE id = ?").run(capture.capturedAt, timestamp, sourceId);
      } else if (existing) {
        sourceId = existing.id;
        this.db.prepare(`
          UPDATE sources SET external_id = ?, title = ?, author_name = ?, author_url = ?, published_at = ?,
            captured_at = ?, raw_text = ?, raw_html = ?, raw_payload_json = ?, content_hash = ?,
            capture_version = capture_version + 1, status = 'captured', last_error = NULL, updated_at = ?
          WHERE id = ?
        `).run(
          capture.externalId, capture.title, capture.authorName, capture.authorUrl, capture.publishedAt,
          capture.capturedAt, capture.rawText, capture.rawHtml, JSON.stringify(capture), contentHash, timestamp, sourceId,
        );
        this.db.prepare("DELETE FROM source_assets WHERE source_id = ?").run(sourceId);
        this.db.prepare("DELETE FROM jobs WHERE entity_id = ? AND status IN ('queued', 'failed')").run(sourceId);
      } else {
        sourceId = id("src");
        this.db.prepare(`
          INSERT INTO sources(id, adapter, external_id, canonical_url, title, author_name, author_url,
            published_at, captured_at, raw_text, raw_html, raw_payload_json, content_hash, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          sourceId, capture.adapter, capture.externalId, capture.canonicalUrl, capture.title, capture.authorName,
          capture.authorUrl, capture.publishedAt, capture.capturedAt, capture.rawText, capture.rawHtml,
          JSON.stringify(capture), contentHash, timestamp, timestamp,
        );
      }

      if (!duplicate) {
        const insertAsset = this.db.prepare(`
          INSERT OR IGNORE INTO source_assets(id, source_id, kind, remote_url, alt_text, position)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const asset of capture.assets) {
          insertAsset.run(id("asset"), sourceId, asset.kind, asset.url, asset.alt, asset.position);
        }
        this.enqueue("extract_source", sourceId);
      }

      return { id: sourceId, duplicate, queued: !duplicate };
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
    } else if (!retry && job.type === "generate_draft") {
      this.db.prepare("UPDATE content_briefs SET status='exception', last_error=?, updated_at=? WHERE id=?").run(message, now(), job.entity_id);
    } else if (!retry && ["review_draft", "revise_draft"].includes(job.type)) {
      this.db.prepare("UPDATE article_drafts SET status='exception', updated_at=? WHERE id=?").run(now(), job.entity_id);
    }
  }

  getSource(sourceId) {
    const source = this.db.prepare("SELECT * FROM sources WHERE id = ?").get(sourceId);
    if (!source) return null;
    const assets = this.db.prepare("SELECT * FROM source_assets WHERE source_id = ? ORDER BY position").all(sourceId);
    const structured = this.db.prepare("SELECT * FROM structured_sources WHERE source_id = ?").get(sourceId) || null;
    const claims = this.db.prepare("SELECT * FROM claims WHERE source_id = ? ORDER BY normalized_key").all(sourceId);
    const blueprint = this.db.prepare("SELECT * FROM source_blueprints WHERE source_id = ?").get(sourceId) || null;
    return hydrateSource({ source, assets, structured, claims, blueprint });
  }

  listSources(limit = 100) {
    return this.db.prepare(`
      SELECT s.id, s.title, s.author_name, s.canonical_url, s.status, s.captured_at, s.capture_version,
        ss.destination_name, ss.summary, ss.extraction_method,
        (SELECT COUNT(*) FROM claims c WHERE c.source_id = s.id) AS claim_count
      FROM sources s LEFT JOIN structured_sources ss ON ss.source_id = s.id
      ORDER BY s.captured_at DESC LIMIT ?
    `).all(limit);
  }

  saveExtraction(sourceId, result, method, model = null) {
    const timestamp = now();
    transaction(this.db, () => {
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
          qualifiers_json, source_quote, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const claim of result.claims) {
        insertClaim.run(
          id("claim"), sourceId, claim.key, claim.subject, claim.predicate, claim.value,
          JSON.stringify(claim.qualifiers), claim.source_quote, claim.confidence, timestamp,
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
      this.enqueue("rebuild_knowledge", result.source.destination_slug);
      this.enqueue("rebuild_editorial", "global");
    });
  }

  rebuildKnowledge(destinationSlug) {
    const sourceRows = this.db.prepare(`
      SELECT c.*, ss.destination_name, ss.destination_slug, s.captured_at
      FROM claims c JOIN structured_sources ss ON ss.source_id = c.source_id
      JOIN sources s ON s.id = c.source_id
      WHERE ss.destination_slug = ?
    `).all(destinationSlug);
    const timestamp = now();
    transaction(this.db, () => {
      const destinationId = `dst_${sha256(destinationSlug).slice(0, 20)}`;
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

      const groups = Map.groupBy(sourceRows, (row) => row.normalized_key);
      for (const [key, rows] of groups) {
        const variants = Map.groupBy(rows, (row) => normalizeValue(row.value_text));
        const ranked = [...variants.entries()].sort((a, b) => b[1].length - a[1].length);
        const status = variants.size > 1 ? "conflicted" : rows.length > 1 ? "corroborated" : "single_source";
        const freshness = classifyFreshness(rows, this.contentConfig);
        const verificationPriority = freshness.volatile || status === "conflicted"
          ? "requires_official" : status === "single_source" || freshness.state === "stale" ? "review" : "normal";
        const evidence = rows.map((row) => ({
          source_id: row.source_id,
          value: row.value_text,
          quote: row.source_quote,
          confidence: row.confidence,
          qualifiers: json(row.qualifiers_json, []),
          captured_at: row.captured_at,
        }));
        this.db.prepare(`
          INSERT INTO knowledge_facts(id, destination_id, normalized_key, subject, predicate, consensus_status,
            preferred_value, support_count, contradiction_count, evidence_json, updated_at,
            freshness_state, latest_evidence_at, verification_priority)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(destination_id, normalized_key) DO UPDATE SET subject=excluded.subject,
            predicate=excluded.predicate, consensus_status=excluded.consensus_status,
            preferred_value=excluded.preferred_value, support_count=excluded.support_count,
            contradiction_count=excluded.contradiction_count, evidence_json=excluded.evidence_json,
            updated_at=excluded.updated_at, freshness_state=excluded.freshness_state,
            latest_evidence_at=excluded.latest_evidence_at, verification_priority=excluded.verification_priority
        `).run(
          `fact_${sha256(`${destinationId}:${key}`).slice(0, 24)}`, destinationId, key, rows[0].subject,
          rows[0].predicate, status, ranked[0][1][0].value_text, ranked[0][1].length,
          Math.max(0, variants.size - 1), JSON.stringify(evidence), timestamp,
          freshness.state, freshness.latestEvidenceAt, verificationPriority,
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
        evidence_count, conflict_count, stale_fact_count, verification_fact_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          proposal.staleFactCount, proposal.verificationFactCount, timestamp, timestamp);
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

  saveBrief(candidateId, plan, model) {
    const candidate = this.db.prepare("SELECT * FROM topic_candidates WHERE id = ?").get(candidateId);
    if (!candidate) throw new Error(`Topic candidate ${candidateId} not found.`);
    const existing = this.db.prepare("SELECT id FROM content_briefs WHERE candidate_id = ?").get(candidateId);
    const briefId = existing?.id || id("brief");
    const timestamp = now();
    const ledger = [...new Set((plan.outline || []).flatMap((section) => section.claim_keys || []))];
    if (existing) {
      this.db.prepare(`
        UPDATE content_briefs SET destination_slug=?, topic=?, audience=?, search_intent=?, plan_json=?,
          evidence_ledger_json=?, model=?, status='ready', last_error=NULL, updated_at=? WHERE id=?
      `).run(candidate.destination_slug, plan.title, JSON.stringify(plan.audience), plan.search_intent, JSON.stringify(plan), JSON.stringify(ledger), model, timestamp, briefId);
    } else {
      this.db.prepare(`
        INSERT INTO content_briefs(id, destination_slug, topic, audience, search_intent, plan_json, status,
          created_at, updated_at, candidate_id, evidence_ledger_json, model)
        VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?)
      `).run(briefId, candidate.destination_slug, plan.title, JSON.stringify(plan.audience), plan.search_intent, JSON.stringify(plan), timestamp, timestamp, candidateId, JSON.stringify(ledger), model);
    }
    this.db.prepare("UPDATE topic_candidates SET status='brief_ready', updated_at=? WHERE id=?").run(timestamp, candidateId);
    this.enqueue("generate_draft", briefId);
    return briefId;
  }

  getBriefPackage(briefId) {
    const brief = this.db.prepare("SELECT * FROM content_briefs WHERE id = ?").get(briefId);
    if (!brief) return null;
    const topicPackage = this.getTopicPackage(brief.candidate_id);
    return {
      brief: { ...brief, plan: json(brief.plan_json, {}), evidence_ledger: json(brief.evidence_ledger_json, []) },
      ...topicPackage,
    };
  }

  saveDraft(briefId, draft, model) {
    const brief = this.db.prepare("SELECT * FROM content_briefs WHERE id = ?").get(briefId);
    if (!brief) throw new Error(`Content brief ${briefId} not found.`);
    const existing = this.db.prepare("SELECT id, revision FROM article_drafts WHERE brief_id = ?").get(briefId);
    const draftId = existing?.id || id("draft");
    const timestamp = now();
    const metadata = draftMetadata(draft, brief, this.contentConfig);
    if (existing) {
      this.db.prepare(`
        UPDATE article_drafts SET title=?, slug=?, body_markdown=?, meta_description=?, evidence_ledger_json=?,
          unresolved_conflicts_json=?, verification_notes_json=?, model=?, revision=revision+1,
          seo_json=?, schema_jsonld=?, quality_report_json='{}', status='qa_queued', updated_at=?
        WHERE id=?
      `).run(draft.title, draft.slug, draft.body_markdown, draft.meta_description, JSON.stringify(draft.evidence_ledger),
        JSON.stringify(draft.unresolved_conflicts), JSON.stringify(draft.verification_notes || []), model,
        JSON.stringify(metadata.seo), JSON.stringify(metadata.schema), timestamp, draftId);
    } else {
      this.db.prepare(`
        INSERT INTO article_drafts(id, brief_id, title, slug, body_markdown, quality_report_json, status,
          created_at, updated_at, meta_description, evidence_ledger_json, unresolved_conflicts_json,
          verification_notes_json, model, seo_json, schema_jsonld)
        VALUES (?, ?, ?, ?, ?, '{}', 'qa_queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(draftId, briefId, draft.title, draft.slug, draft.body_markdown, timestamp, timestamp,
        draft.meta_description, JSON.stringify(draft.evidence_ledger), JSON.stringify(draft.unresolved_conflicts),
        JSON.stringify(draft.verification_notes || []), model, JSON.stringify(metadata.seo), JSON.stringify(metadata.schema));
    }
    this.replaceDraftVisuals(draftId, metadata.visuals);
    this.db.prepare("UPDATE topic_candidates SET status='drafted', updated_at=? WHERE id=?").run(timestamp, brief.candidate_id);
    this.db.prepare("UPDATE content_briefs SET status='drafted', updated_at=? WHERE id=?").run(timestamp, briefId);
    this.enqueue("review_draft", draftId);
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
        visuals: this.listDraftVisuals(draftId),
      },
      review: review ? hydrateReview(review) : null,
      publication,
      commercial_composition: compositionRow ? {
        ...compositionRow,
        slots: json(compositionRow.slots_json, []),
        offer_ids: json(compositionRow.offer_ids_json, []),
      } : null,
    };
  }

  listDraftVisuals(draftId) {
    return this.db.prepare("SELECT * FROM article_visuals WHERE draft_id=? ORDER BY slot").all(draftId);
  }

  replaceDraftVisuals(draftId, visuals) {
    const timestamp = now();
    transaction(this.db, () => {
      this.db.prepare("DELETE FROM article_visuals WHERE draft_id=?").run(draftId);
      const insert = this.db.prepare(`
        INSERT INTO article_visuals(id, draft_id, slot, placement, purpose, alt_text, caption, generation_prompt, aspect_ratio, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      visuals.forEach((visual, index) => insert.run(id("visual"), draftId, index + 1, visual.placement, visual.purpose,
        visual.alt_text, visual.caption, visual.generation_prompt, visual.aspect_ratio, timestamp, timestamp));
    });
  }

  plannedVisuals(draftId) {
    return this.db.prepare("SELECT * FROM article_visuals WHERE draft_id=? AND status='planned' ORDER BY slot").all(draftId);
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
    this.db.prepare("UPDATE article_visuals SET wordpress_media_id=?, wordpress_media_url=?, updated_at=? WHERE id=?")
      .run(media.id, media.url, now(), visualId);
  }

  refreshDraftSchema(draftId) {
    const row = this.db.prepare(`
      SELECT ad.*, cb.destination_slug FROM article_drafts ad JOIN content_briefs cb ON cb.id=ad.brief_id WHERE ad.id=?
    `).get(draftId);
    if (!row) return;
    const schema = buildArticleSchema({ ...row, seo: json(row.seo_json, {}) }, this.listDraftVisuals(draftId), this.contentConfig);
    this.db.prepare("UPDATE article_drafts SET schema_jsonld=?, updated_at=? WHERE id=?").run(JSON.stringify(schema), now(), draftId);
  }

  saveReview(draftId, review, reviewer) {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO quality_reviews(id, draft_id, passed, score, checks_json, issues_json,
        unsupported_claims_json, reviewer, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id("review"), draftId, review.passed ? 1 : 0, review.score, JSON.stringify(review.checks), JSON.stringify(review.issues), JSON.stringify(review.unsupported_claims), reviewer, timestamp);
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
      INSERT INTO wordpress_publications(id, draft_id, site_url, status, created_at, updated_at)
      VALUES (?, ?, ?, 'queued', ?, ?)
    `).run(publication.id, draftId, siteUrl, timestamp, timestamp);
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
    return this.db.prepare("SELECT * FROM commercial_offers WHERE id=?").get(offerId);
  }

  listCommercialOffers({ activeOnly = false } = {}) {
    const where = activeOnly ? "WHERE active=1 AND (valid_until IS NULL OR valid_until > ?)" : "";
    return activeOnly
      ? this.db.prepare(`SELECT * FROM commercial_offers ${where} ORDER BY destination_slug, priority DESC, category`).all(now())
      : this.db.prepare("SELECT * FROM commercial_offers ORDER BY destination_slug, active DESC, priority DESC, category").all();
  }

  activeOffersForDestination(destinationSlug) {
    return this.db.prepare(`
      SELECT * FROM commercial_offers
      WHERE destination_slug=? AND active=1 AND target_url<>'' AND (valid_until IS NULL OR valid_until>?)
      ORDER BY priority DESC, category, title
    `).all(destinationSlug, now());
  }

  saveCommercialComposition(draftId, composition) {
    const timestamp = now();
    const compositionId = `composition_${sha256(draftId).slice(0, 24)}`;
    this.db.prepare(`
      INSERT INTO commercial_compositions(id, draft_id, publishable_body_markdown, slots_json, offer_ids_json,
        disclosure_text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(draft_id) DO UPDATE SET publishable_body_markdown=excluded.publishable_body_markdown,
        slots_json=excluded.slots_json, offer_ids_json=excluded.offer_ids_json,
        disclosure_text=excluded.disclosure_text, status=excluded.status, updated_at=excluded.updated_at
    `).run(
      compositionId, draftId, composition.publishableBodyMarkdown, JSON.stringify(composition.slots),
      JSON.stringify(composition.offerIds), composition.disclosureText, composition.status, timestamp, timestamp,
    );
    this.db.prepare("UPDATE article_drafts SET status='commercial_ready', updated_at=? WHERE id=?").run(timestamp, draftId);
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
    if (!row.brief_id) { this.queueCandidate(candidateId); return "plan_content"; }
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
      SELECT k.* FROM knowledge_facts k JOIN destinations d ON d.id=k.destination_id
      WHERE d.slug=? ORDER BY k.consensus_status='conflicted' DESC, k.support_count DESC, k.normalized_key
    `).all(destinationSlug).map((row) => ({
      normalized_key: row.normalized_key, subject: row.subject, predicate: row.predicate,
      consensus_status: row.consensus_status, preferred_value: row.preferred_value,
      support_count: row.support_count, contradiction_count: row.contradiction_count,
      evidence: json(row.evidence_json, []),
      freshness_state: row.freshness_state,
      latest_evidence_at: row.latest_evidence_at,
      verification_priority: row.verification_priority,
    }));
  }

  retrySource(sourceId) {
    const source = this.db.prepare("SELECT id FROM sources WHERE id = ?").get(sourceId);
    if (!source) return false;
    this.db.prepare("UPDATE sources SET status = 'captured', last_error = NULL, updated_at = ? WHERE id = ?").run(now(), sourceId);
    this.enqueue("extract_source", sourceId);
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
    `).all()) {
      items.push(exceptionItem("job", row.id, "blocker", `Job failed: ${row.type}`, row.entity_id, row.last_error, true, row.updated_at));
    }
    for (const row of this.db.prepare("SELECT * FROM knowledge_facts WHERE consensus_status='conflicted' OR freshness_state='stale'").all()) {
      const stale = row.freshness_state === "stale";
      items.push(exceptionItem("knowledge", row.id, stale ? "blocker" : "warning",
        stale ? "Knowledge fact is stale" : "Knowledge conflict needs judgment",
        `${row.subject} · ${row.predicate}`, stale ? `Latest evidence: ${row.latest_evidence_at || "unknown"}` : row.preferred_value,
        false, row.updated_at));
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

  getKnowledge() {
    return this.db.prepare(`
      SELECT k.*, d.slug AS destination_slug, d.name AS destination_name
      FROM knowledge_facts k JOIN destinations d ON d.id = k.destination_id
      ORDER BY d.name, k.normalized_key
    `).all().map((row) => ({ ...row, evidence: json(row.evidence_json, []) }));
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
    return {
      sources: Object.fromEntries(statuses.map((row) => [row.status, row.count])),
      totals: {
        sources: this.db.prepare("SELECT COUNT(*) AS count FROM sources").get().count,
        claims: this.db.prepare("SELECT COUNT(*) AS count FROM claims").get().count,
        knowledgeFacts: this.db.prepare("SELECT COUNT(*) AS count FROM knowledge_facts").get().count,
        conflicts: this.db.prepare("SELECT COUNT(*) AS count FROM knowledge_facts WHERE consensus_status = 'conflicted'").get().count,
        exceptions: operationalExceptions.length,
        topicCandidates: this.db.prepare("SELECT COUNT(*) AS count FROM topic_candidates").get().count,
        draftsReady: this.db.prepare("SELECT COUNT(*) AS count FROM article_drafts WHERE status IN ('ready_for_wordpress','commercial_ready','wordpress_draft')").get().count,
        activeOffers: this.db.prepare("SELECT COUNT(*) AS count FROM commercial_offers WHERE active=1 AND target_url<>''").get().count,
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

function hydrateSource({ source, assets, structured, claims, blueprint }) {
  if (structured) {
    structured.traveler_fit = json(structured.traveler_fit_json, []);
    structured.practical_tips = json(structured.practical_tips_json, []);
    structured.warnings = json(structured.warnings_json, []);
  }
  for (const claim of claims) claim.qualifiers = json(claim.qualifiers_json, []);
  if (blueprint) {
    blueprint.sections = json(blueprint.sections_json, []);
    blueprint.strengths = json(blueprint.strengths_json, []);
    blueprint.gaps = json(blueprint.gaps_json, []);
  }
  delete source.raw_payload_json;
  return { ...source, assets, structured, claims, blueprint };
}

function draftMetadata(draft, brief, config) {
  const seo = {
    meta_title: truncateText(draft.seo?.meta_title || draft.title, 60),
    focus_keyword: truncateText(draft.seo?.focus_keyword || brief.topic || draft.title, 160),
    key_takeaways: (draft.seo?.key_takeaways || []).slice(0, 6).map((item) => truncateText(item, 240)),
    faqs: (draft.faqs || []).slice(0, 5).map((item) => ({ question: truncateText(item.question, 220), answer: truncateText(item.answer, 700) })),
  };
  const visuals = normalizeVisuals(draft.visuals, draft, brief);
  return { seo, visuals, schema: buildArticleSchema({ ...draft, ...seo, seo, destination_slug: brief.destination_slug }, visuals, config) };
}

function normalizeVisuals(values, draft, brief) {
  const target = visualCountForWords(wordCount(draft.body_markdown));
  const allowedPlacements = ["hero", "after_intro", "mid_article", "before_faq", "closing"];
  const allowedRatios = ["16:9", "4:3", "1:1", "3:2", "9:16"];
  const supplied = Array.isArray(values) ? values : [];
  const visuals = supplied.slice(0, target).map((item, index) => ({
    placement: allowedPlacements.includes(item?.placement) ? item.placement : defaultPlacement(index),
    purpose: truncateText(item?.purpose || `Orient readers to ${draft.title}`, 300),
    alt_text: truncateText(item?.alt_text || `${draft.title} travel illustration`, 220),
    caption: truncateText(item?.caption || "Illustrative travel scene", 300),
    generation_prompt: truncateText(item?.generation_prompt || defaultVisualPrompt(draft.title, brief.destination_slug, index), 2_000),
    aspect_ratio: allowedRatios.includes(item?.aspect_ratio) ? item.aspect_ratio : index === 0 ? "16:9" : "3:2",
  }));
  while (visuals.length < target) {
    const index = visuals.length;
    visuals.push({
      placement: defaultPlacement(index), purpose: `Support a key section of ${draft.title}`,
      alt_text: `${draft.title} travel illustration`, caption: "Illustrative travel scene",
      generation_prompt: defaultVisualPrompt(draft.title, brief.destination_slug, index), aspect_ratio: index === 0 ? "16:9" : "3:2",
    });
  }
  return visuals;
}

function buildArticleSchema(draft, visuals, config) {
  const canonical = config.publicSiteUrl && draft.slug ? `${config.publicSiteUrl}/${draft.slug}/` : null;
  const generatedImages = visuals.filter((item) => item.status === "generated" && item.media_url).map((item) => item.media_url);
  const article = {
    "@type": "Article",
    headline: draft.title,
    description: draft.meta_description,
    inLanguage: "en",
    author: { "@type": "Organization", name: config.publisherName || "SoloToChina" },
    publisher: { "@type": "Organization", name: config.publisherName || "SoloToChina" },
    keywords: draft.seo?.focus_keyword || draft.focus_keyword || "",
    about: draft.destination_slug || "China travel",
  };
  if (canonical) article.mainEntityOfPage = { "@type": "WebPage", "@id": canonical };
  if (generatedImages.length) article.image = generatedImages;
  if (config.publisherLogoUrl) article.publisher.logo = { "@type": "ImageObject", url: config.publisherLogoUrl };
  const graph = [article];
  const faqs = draft.seo?.faqs || [];
  if (faqs.length) graph.push({
    "@type": "FAQPage",
    mainEntity: faqs.map((item) => ({ "@type": "Question", name: item.question, acceptedAnswer: { "@type": "Answer", text: item.answer } })),
  });
  return { "@context": "https://schema.org", "@graph": graph };
}

function defaultPlacement(index) {
  return ["hero", "after_intro", "mid_article", "before_faq", "closing"][index] || "mid_article";
}

function defaultVisualPrompt(title, destination, index) {
  return `Original editorial travel illustration for \"${title}\" in ${destination || "China"}, scene ${index + 1}; authentic architectural and streetscape atmosphere, no readable text, no logos, no watermark, no copied social-media imagery, natural light, high-detail magazine travel photography.`;
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
