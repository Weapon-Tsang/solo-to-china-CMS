import { canonicalizeUrl, id, json, now, sha256, slugify } from "./utils.mjs";
import { transaction } from "./db.mjs";
import { AI_MODELS, VISUAL_MODELS } from "./config.mjs";
import { CONTENT_STRATEGY } from "./content-strategy.mjs";
import { buildContentAst, contentBlockSummary, markdownToContentBlocks } from "./content-blocks.mjs";
import { CLAIM_RESOLUTION_VERSION, classifyClaimPair, detectClaimExtractionIssue, repairClaimLocally,
  stableCanonicalSerialize, structureClaim } from "./claim-resolution.mjs";
import { evidenceResolutionMode, evidenceTemporalState, resolveEvidenceConsensus } from "./evidence-consensus.mjs";
import { KNOWLEDGE_RESOLUTION_VERSION, decideKnowledgeResolution, summarizeResolutionDecisions } from "./knowledge-resolution.mjs";
import { assessEntityIdentity, inferEntityMetadata, normalizeEntityType, normalizeGranularity, ENTITY_RELATION_TYPES } from "./entity-resolution.mjs";
import { legacyOfferToAsset } from "./commercial.mjs";
import {
  affiliateAssetFromQueueTask, exportAffiliateQueue, loadAffiliateQueueSeeds,
  normalizeAffiliateQueueTask, parseAffiliateQueueImport, queueTaskFromOpportunity,
} from "./affiliate-queue.mjs";
import { classifySourceFamily, evaluateCoverage, segmentSource, stableOpportunityKey } from "./research-strategy.mjs";
import { AI_JOB_TYPES, DATABASE_HEAVY_JOB_TYPES, classifyBatchFailure, isOperationalFailureRetryable, isProviderPressure,
  inheritJobContext,laneBackoffMs,workloadClassForJob } from "./job-policy.mjs";
import { pageBlockSignature, selectedFactEvidence, selectedFactSnapshot } from "./evidence-validator.mjs";
import { estimateSourceProcessing } from "./source-preflight.mjs";
import { sourceProcessingProfile } from "./source-processing-profile.mjs";
import { summarizeModelCostLedger } from "./ai/stage-policy.mjs";
import {
  affectedInternalLinkBlocks, buildSeoPreview, duplicateContentRisks, inventoryTargetChanges,
  inventoryVersion, resolveCanonicalUrl, selectInternalLinks,
} from "./seo-geo.mjs";
export { pageBlockSignature } from "./evidence-validator.mjs";
import { buildContentTaskCard, normalizeWorkspaceQuery, paginateWorkspace } from "./services/operations-workspace.mjs";
import { freezeProposal, proposalFingerprint, proposalForOpportunity } from "./services/editorial-proposal.mjs";
import { explainOperationalFailure, qualityRepairStage } from "./services/content-recovery-policy.mjs";
import { insertCommercialEvent, listCommercialPerformance } from "./repositories/commercial-events.mjs";
import { persistCaptureAssets } from "./source-media-store.mjs";
import { dependencyHash, semanticMaterial, PIPELINE_CONTRACT_VERSION } from './pipeline-contract.mjs';
import { stepIdentity, readStepReceipt, saveStepReceipt } from './repositories/pipeline-step-receipts.mjs';

function conflictError(message) { const error = new Error(message); error.statusCode = 409; return error; }

const REUSABLE_PIPELINE_STAGES = new Set([
  "extract_segment_claims", "extract_media_batch", "audit_segment_coverage", "retry_segment_extraction", "analyze_source_blueprint", "analyze_source_diagnostic", "extract_source_experience",
  "analyze_intake", "resolve_entities", "assemble_editorial", "plan_content", "plan_narrative", "assemble_writing_packet", "compose_frontend_page_plan", "generate_draft",
  "compose_frontend_page", "review_draft", "revise_draft",
]);
const PRODUCTION_JOB_TYPES = new Set(["assemble_editorial","plan_content","plan_narrative","assemble_writing_packet",
  "compose_frontend_page_plan","generate_draft","generate_visuals","compose_frontend_page","review_draft","revise_draft",
  "compose_commercial","compose_publish_page","push_wordpress_draft"]);
const TRACKED_DELIVERY_STAGES = new Set(['compose_commercial','compose_publish_page','push_wordpress_draft']);
// Intake schema and decision instructions have been stable since Strategy 3.0.
// A later strategy label alone must not purchase the same diagnostic again.
// Future strategy releases must opt in here after reviewing that contract.
const COMPATIBLE_DIAGNOSTIC_STRATEGIES = new Map([
  ["3.3", new Set(["3.0", "3.1", "3.2", "3.3"])],
]);

function isReusableDiagnosticStrategy(previous, current) {
  return Boolean(String(previous || "") && COMPATIBLE_DIAGNOSTIC_STRATEGIES.get(current)?.has(String(previous)));
}

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
    this.activeProvider = "";
    this.batchMaxAttempts = Math.max(1, Number(contentConfig.batchMaxAttempts || 2));
    this.batchBackoffInitialMs = Math.max(1_000, Number(contentConfig.batchBackoffInitialMs || 5_000));
    this.batchBackoffMaxMs = Math.max(this.batchBackoffInitialMs, Number(contentConfig.batchBackoffMaxMs || 300_000));
    this.random = contentConfig.random || Math.random;
  }

  jobTimestamp() { return this.clock().toISOString(); }

  jobLeaseExpiry() { return new Date(this.clock().getTime() + this.jobLeaseMs).toISOString(); }

  pipelineStepIdentity(job, artifact, key, input, configHash) {
    return stepIdentity(job, artifact, key, input, configHash);
  }

  readPipelineStep(identity) { return readStepReceipt(this.db, identity); }

  savePipelineStep(job, artifact, identity, value) {
    return transaction(this.db, () => {
      if (!this.ownsJob(job.id, job.locked_by, job.lease_generation)) throw Object.assign(new Error('JOB_LEASE_LOST'), {code:'JOB_LEASE_LOST',retryable:false});
      this.assertPipelineInput(artifact, job);
      return saveStepReceipt(this.db, identity, value, job, this.jobTimestamp());
    });
  }

  preparePipelineArtifact(job, configHash = "") {
    if (!REUSABLE_PIPELINE_STAGES.has(job?.type) && !TRACKED_DELIVERY_STAGES.has(job?.type)) return null;
    const inputHash = dependencyHash({ version: PIPELINE_CONTRACT_VERSION, inputs: this.pipelineDependencyMaterial(job) });
    const existing = this.db.prepare(`SELECT * FROM pipeline_artifacts
      WHERE stage=? AND entity_id=? AND input_hash=? AND config_hash=?`).get(job.type, job.entity_id, inputHash, configHash);
    if (REUSABLE_PIPELINE_STAGES.has(job.type) && existing?.status === "succeeded" && existing.output_hash
      && existing.output_hash === this.pipelineOutputHash(job)) return { ...existing, reused: true };
    const timestamp = this.jobTimestamp();
    const artifactId = existing?.id || id("artifact");
    this.db.prepare(`INSERT INTO pipeline_artifacts(id,stage,entity_id,input_hash,output_hash,config_hash,status,error_class,
      started_at,completed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,'started',NULL,?,NULL,?,?)
      ON CONFLICT(stage,entity_id,input_hash,config_hash) DO UPDATE SET status='started',output_hash=NULL,error_class=NULL,
        started_at=excluded.started_at,completed_at=NULL,updated_at=excluded.updated_at`)
      .run(artifactId, job.type, job.entity_id, inputHash, null, configHash, timestamp, timestamp, timestamp);
    return { id: artifactId, stage: job.type, entity_id: job.entity_id, input_hash: inputHash, config_hash: configHash, reused: false };
  }

  completePipelineArtifact(artifact, job) {
    if (!artifact || artifact.reused) return;
    const timestamp = this.jobTimestamp();
    this.db.prepare(`UPDATE pipeline_artifacts SET output_hash=?,status='succeeded',completed_at=?,updated_at=? WHERE id=?`)
      .run(this.pipelineOutputHash(job), timestamp, timestamp, artifact.id);
  }

  assertPipelineInput(artifact, job) {
    if (artifact && artifact.input_hash !== dependencyHash({ version: PIPELINE_CONTRACT_VERSION, inputs: this.pipelineDependencyMaterial(job) })) {
      throw Object.assign(new Error('阶段输入已变化，旧结果未保存。'), { code: 'STALE_PIPELINE_INPUT', retryable: true });
    }
  }

  finishPipelineJob(job, artifact) {
    return transaction(this.db, () => {
      if (!this.completeJob(job.id, job.locked_by, job.lease_generation)) return false;
      this.completePipelineArtifact(artifact, job);
      return true;
    });
  }

  commitPipelineStage(job, artifact, work, { acceptResult = () => true } = {}) {
    return transaction(this.db, () => {
      if (!this.ownsJob(job.id, job.locked_by, job.lease_generation)) throw Object.assign(new Error('JOB_LEASE_LOST'), {code:'JOB_LEASE_LOST',retryable:false});
      this.assertPipelineInput(artifact, job);
      const result = work();
      if (result?.then) throw new Error('Pipeline commit must contain only synchronous database work.');
      if (!acceptResult(result)) return result; // Retain invalid output for diagnosis; the caller fails the job.
      if (!this.finishPipelineJob(job, artifact)) throw Object.assign(new Error('JOB_LEASE_LOST'), {code:'JOB_LEASE_LOST',retryable:false});
      return result;
    });
  }

  failPipelineArtifact(artifact, error) {
    if (!artifact || artifact.reused) return;
    const timestamp = this.jobTimestamp();
    this.db.prepare(`UPDATE pipeline_artifacts SET status='failed',error_class=?,completed_at=?,updated_at=? WHERE id=?`)
      .run(String(error?.failureClass || error?.code || "execution").slice(0, 120), timestamp, timestamp, artifact.id);
  }

  pipelineDependencyMaterial(job) {
    const entityId = job.entity_id;
    if (["extract_segment_claims", "audit_segment_coverage", "retry_segment_extraction"].includes(job.type)) {
      return {
        currentCapture: this.db.prepare('SELECT s.capture_version FROM sources s JOIN source_segments ss ON ss.source_id=s.id WHERE ss.id=?').get(entityId),
        segment: this.db.prepare(`SELECT id,source_id,content_hash,capture_version,segment_type,raw_text,asset_id,
          title,sequence,page_start,page_end,image_index,destination_scopes_json,topic_scopes_json FROM source_segments WHERE id=?`).get(entityId),
        media: this.db.prepare(`SELECT a.id,a.media_identity,a.original_sha256,a.stored_sha256,a.durability_status,a.ai_derivative_sha256
          FROM source_assets a JOIN source_segments s ON s.source_id=a.source_id AND s.capture_version=a.capture_version WHERE s.id=? ORDER BY a.id`).all(entityId),
        extraction: job.type !== "extract_segment_claims"
          ? this.db.prepare("SELECT result_json,input_manifest_json,attempt FROM segment_extractions WHERE segment_id=?").get(entityId) : null,
        coverage: job.type === 'retry_segment_extraction' ? this.db.prepare('SELECT * FROM extraction_coverage WHERE segment_id=?').get(entityId) : null,
      };
    }
    if (job.type === "extract_media_batch") return {
      batch: this.db.prepare("SELECT * FROM media_extraction_batches WHERE id=?").get(entityId),
      segments: this.db.prepare(`SELECT s.id,s.content_hash,s.asset_id,s.capture_version,a.stored_sha256,a.ai_derivative_sha256,a.durability_status
        FROM source_segments s LEFT JOIN source_assets a ON a.id=s.asset_id
        WHERE s.id IN (SELECT value FROM json_each((SELECT segment_ids_json FROM media_extraction_batches WHERE id=?))) ORDER BY s.sequence`).all(entityId),
    };
    if (["analyze_source_blueprint", "analyze_source_diagnostic", "analyze_intake", "extract_source_experience"].includes(job.type)) {
      const source=this.db.prepare("SELECT id,content_hash,capture_version FROM sources WHERE id=?").get(entityId);
      const claims = this.db.prepare(`SELECT *
        FROM claims WHERE source_id=? AND lifecycle_status='active' ORDER BY id`).all(entityId);
      if (job.type !== "extract_source_experience") return { source, claims,
        experience: this.db.prepare('SELECT id,input_hash,status FROM experience_extraction_runs WHERE source_id=? ORDER BY id').all(entityId) };
      const media=this.db.prepare(`SELECT id,durability_status,stored_sha256,recovered_at
        FROM current_source_assets WHERE source_id=? ORDER BY position,id`).all(entityId);
      return {source,media,claims};
    }
    if (job.type === "resolve_entities") return {
      claims:this.db.prepare(`SELECT c.id,COALESCE(NULLIF(c.original_normalized_key,''),c.normalized_key) AS source_key,
        c.subject,c.value_text,c.source_quote,c.entity_type,c.granularity,c.entity_location_json
        FROM claims c JOIN structured_sources ss ON ss.source_id=c.source_id
        WHERE ss.destination_slug=? AND c.lifecycle_status='active' ORDER BY c.id`).all(entityId),
      aliases:this.listEntityAliases(entityId),
    };
    if (["assemble_editorial", "plan_content"].includes(job.type)) {
      const candidate = this.db.prepare("SELECT * FROM topic_candidates WHERE id=?").get(entityId);
      const facts = candidate ? this.db.prepare(`SELECT k.normalized_key,k.preferred_value,k.consensus_status,k.updated_at
        FROM knowledge_facts k JOIN destinations d ON d.id=k.destination_id WHERE d.slug=? ORDER BY k.normalized_key`).all(candidate.destination_slug) : [];
      return { candidate, facts, assembly: job.type === 'plan_content' ? this.getEditorialAssembly(entityId) : null,
        selection: this.getEditorialAssemblyPackage(entityId) };
    }
    if (["plan_narrative", "assemble_writing_packet", "compose_frontend_page_plan", "generate_draft"].includes(job.type)) {
      const brief = this.db.prepare(`SELECT id,plan_json,canonical_json,evidence_ledger_json,strategy_version,updated_at
        FROM content_briefs WHERE id=?`).get(entityId);
      const facts = brief ? this.getBriefPackage(entityId)?.facts || [] : [];
      const pack = brief ? this.getBriefPackage(entityId) : null;
      return { brief, facts: semanticMaterial(facts), assembly: pack?.editorial_assembly,
        experiences: pack?.experiences, contentPolicy: pack?.content_policy,
        narrative: job.type === 'plan_narrative' ? null : this.getNarrativePlan(entityId),
        packet: ['generate_draft','compose_frontend_page_plan'].includes(job.type) ? this.getWritingPacket(entityId) : null };
    }
    const draft = this.db.prepare(`SELECT id,brief_id,content_hash,revision,seo_json,strategy_version,updated_at
      FROM article_drafts WHERE id=?`).get(entityId);
    if (draft && (job.type === 'compose_frontend_page' || TRACKED_DELIVERY_STAGES.has(job.type))) {
      // Localization writes the derived OG URL itself. Its source asset identity
      // is tracked below; this URL must not invalidate that same upload operation.
      const {og_image,...editorialSeo}=json(draft.seo_json,{});
      draft.seo_json=JSON.stringify(editorialSeo);
    }
    if (TRACKED_DELIVERY_STAGES.has(job.type)) return {
      draft,
      evidence: draft ? semanticMaterial(this.getBriefPackage(draft.brief_id)?.facts || []) : [],
      content: draft ? this.db.prepare('SELECT title,slug,meta_description,body_markdown,content_blocks_json FROM article_drafts WHERE id=?').get(entityId) : null,
      review: this.db.prepare('SELECT passed,draft_content_hash,evidence_hash,checks_json FROM quality_reviews WHERE draft_id=? ORDER BY created_at DESC,id DESC LIMIT 1').get(entityId),
      commercial: job.type === 'compose_commercial'
        ? this.activeOffersForDestination(this.db.prepare('SELECT destination_slug FROM content_briefs WHERE id=?').get(draft?.brief_id || '')?.destination_slug || '')
        : this.db.prepare('SELECT * FROM commercial_compositions WHERE draft_id=?').get(entityId),
      page: this.db.prepare('SELECT payload_json,validation_json,contract_checksum,draft_content_hash FROM frontend_page_compositions WHERE draft_id=?').get(entityId),
      publish: job.type === 'push_wordpress_draft' ? this.db.prepare('SELECT publish_package_json,contract_checksum FROM frontend_publish_compositions WHERE draft_id=?').get(entityId) : null,
      media: this.db.prepare(`SELECT v.id,v.status,v.asset_fingerprint,v.source_asset_id,v.media_path,a.stored_sha256,a.authorization_status,a.publishable
        FROM article_visuals v LEFT JOIN source_assets a ON a.id=v.source_asset_id WHERE v.draft_id=? ORDER BY v.id`).all(entityId),
    };
    if (job.type === "revise_draft") {
      const review = this.db.prepare(`SELECT issues_json,draft_content_hash,evidence_hash FROM quality_reviews
        WHERE draft_id=? ORDER BY created_at DESC LIMIT 1`).get(entityId);
      return { draft, review };
    }
    const facts = draft ? this.getBriefPackage(draft.brief_id)?.facts || [] : [];
    return { draft, facts: semanticMaterial(facts),
      media: job.type === 'compose_frontend_page' ? this.db.prepare('SELECT id,status,source_asset_id,media_path FROM article_visuals WHERE draft_id=? ORDER BY id').all(entityId) : null };
  }

  pipelineOutputHash(job) {
    let value = null;
    if (job.type === "extract_segment_claims") value = this.db.prepare("SELECT result_json,input_manifest_json FROM segment_extractions WHERE segment_id=?").get(job.entity_id);
    else if (job.type === "extract_media_batch") value = {
      batch:this.db.prepare("SELECT status,updated_at FROM media_extraction_batches WHERE id=?").get(job.entity_id),
      extractions:this.db.prepare(`SELECT se.segment_id,se.result_json,se.input_manifest_json FROM segment_extractions se
        WHERE se.segment_id IN (SELECT value FROM json_each((SELECT segment_ids_json FROM media_extraction_batches WHERE id=?))) ORDER BY se.segment_id`).all(job.entity_id),
    };
    else if (job.type === 'retry_segment_extraction') value = {
      extraction:this.db.prepare('SELECT result_json,input_manifest_json,attempt FROM segment_extractions WHERE segment_id=?').get(job.entity_id),
      coverage:this.db.prepare('SELECT * FROM extraction_coverage WHERE segment_id=?').get(job.entity_id),
    };
    else if (job.type === "audit_segment_coverage") value = this.db.prepare("SELECT * FROM extraction_coverage WHERE segment_id=?").get(job.entity_id);
    else if (job.type === "analyze_source_blueprint") value = this.db.prepare("SELECT * FROM source_blueprints WHERE source_id=?").get(job.entity_id);
    else if (job.type === "extract_source_experience") value = {
      run:this.db.prepare("SELECT id,input_hash,status FROM experience_extraction_runs WHERE source_id=? AND status='succeeded' ORDER BY updated_at DESC LIMIT 1").get(job.entity_id),
      blocks:this.db.prepare('SELECT * FROM experience_blocks WHERE source_id=? ORDER BY id').all(job.entity_id) };
    else if (["analyze_source_diagnostic", "analyze_intake"].includes(job.type)) value = this.db.prepare("SELECT * FROM content_intake_analyses WHERE source_id=?").get(job.entity_id);
    else if (job.type === "resolve_entities") value = this.db.prepare(`SELECT group_concat(id || ':' || entity_key || ':' || entity_resolution_status, '|') AS value
      FROM (SELECT c.id,c.entity_key,c.entity_resolution_status FROM claims c JOIN structured_sources ss ON ss.source_id=c.source_id
        WHERE ss.destination_slug=? ORDER BY c.id)`).get(job.entity_id);
    else if (job.type === "assemble_editorial") value = this.db.prepare("SELECT id,input_hash,selected_fact_keys_json,selected_experience_block_ids_json FROM editorial_assemblies WHERE candidate_id=?").get(job.entity_id);
    else if (job.type === "plan_content") value = this.db.prepare("SELECT id,plan_json,canonical_json FROM content_briefs WHERE candidate_id=?").get(job.entity_id);
    else if (job.type === "plan_narrative") value = this.db.prepare("SELECT * FROM narrative_plans WHERE brief_id=?").get(job.entity_id);
    else if (job.type === "assemble_writing_packet") value = this.db.prepare("SELECT packet_text,evidence_ledger_json,selected_fact_keys_json,selected_experience_block_ids_json,context_json FROM writing_packets WHERE brief_id=?").get(job.entity_id);
    else if (job.type === "compose_frontend_page_plan") value = this.db.prepare("SELECT plan_json,validation_json,contract_checksum FROM frontend_page_plans WHERE brief_id=?").get(job.entity_id);
    else if (job.type === "generate_draft") value = this.db.prepare("SELECT id,content_hash,revision FROM article_drafts WHERE brief_id=?").get(job.entity_id);
    else if (job.type === "compose_frontend_page") value = this.db.prepare("SELECT payload_json,validation_json,draft_content_hash FROM frontend_page_compositions WHERE draft_id=?").get(job.entity_id);
    else if (job.type === "review_draft") value = this.db.prepare("SELECT draft_content_hash,evidence_hash,passed,checks_json,issues_json FROM quality_reviews WHERE draft_id=? ORDER BY created_at DESC LIMIT 1").get(job.entity_id);
    else if (job.type === "revise_draft") value = this.db.prepare("SELECT content_hash,revision FROM article_drafts WHERE id=?").get(job.entity_id);
    else if (job.type === 'compose_commercial') value = this.db.prepare('SELECT * FROM commercial_compositions WHERE draft_id=?').get(job.entity_id);
    else if (job.type === 'compose_publish_page') value = this.db.prepare('SELECT * FROM frontend_publish_compositions WHERE draft_id=?').get(job.entity_id);
    else if (job.type === 'push_wordpress_draft') value = this.db.prepare('SELECT * FROM wordpress_publications WHERE draft_id=?').get(job.entity_id);
    return value ? dependencyHash(value) : "";
  }

  recoverExpiredJobs() {
    const timestamp = this.jobTimestamp();
    return this.db.prepare(`
      UPDATE jobs SET status='queued', locked_at=NULL, locked_by=NULL, lease_expires_at=NULL,
        heartbeat_at=NULL, available_at=?, next_eligible_at=?, updated_at=?
      WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
    `).run(timestamp, timestamp, timestamp, timestamp).changes;
  }

  releaseOwnedJobs() {
    const timestamp = this.jobTimestamp();
    return this.db.prepare(`
      UPDATE jobs SET status='queued', locked_at=NULL, locked_by=NULL, lease_expires_at=NULL,
        heartbeat_at=NULL, available_at=?, next_eligible_at=?, updated_at=?
      WHERE status='running' AND locked_by=?
    `).run(timestamp, timestamp, timestamp, this.workerId).changes;
  }

  get strategyVersion() {
    return this.contentConfig.contentStrategy?.version || CONTENT_STRATEGY.version;
  }

  getAiSettings(defaultModel) {
    const saved = this.db.prepare("SELECT value_json FROM runtime_settings WHERE setting_key='ai'").get();
    const model = json(saved?.value_json, {}).model;
    const selected = AI_MODELS.some((item) => item.id === model) ? model : defaultModel;
    const active = AI_MODELS.find((item) => item.id === selected) || AI_MODELS[0];
    this.activeProvider = active.provider;
    const persistedProviderState=this.db.prepare("SELECT backoff_until FROM provider_runtime_state WHERE provider=?").get(active.provider);
    this.providerBackoffUntil=Math.max(0,Date.parse(persistedProviderState?.backoff_until||"")||0);
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
    plan = normalizePagePlan(plan);
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

  saveFrontendPageComposition(draftId, planId, snapshot, payload, validation, model = null, expectedVersion = null, explicitProvenance = null) {
    const timestamp = now();
    const draft = this.db.prepare("SELECT revision, content_hash FROM article_drafts WHERE id=?").get(draftId);
    if (!draft) throw new Error(`Article draft ${draftId} not found.`);
    if (expectedVersion && (draft.revision !== expectedVersion.revision || draft.content_hash !== expectedVersion.contentHash)) {
      throw Object.assign(new Error("STALE_DRAFT_VERSION: page composition input changed before it could be saved."), { retryable: false });
    }
    const existing = this.db.prepare("SELECT id FROM frontend_page_compositions WHERE draft_id=?").get(draftId);
    const draftRow = this.db.prepare(`SELECT ad.evidence_ledger_json,ad.brief_id,cb.destination_slug FROM article_drafts ad
      JOIN content_briefs cb ON cb.id=ad.brief_id WHERE ad.id=?`).get(draftId);
    const packet = this.getWritingPacket(draftRow?.brief_id);
    const frozenFacts = packet?.evidence_ledger?.map(entry => entry.fact_snapshot);
    const hasFrozenPacket = frozenFacts?.length > 0 && frozenFacts.every(Boolean);
    const sourceRows = hasFrozenPacket ? frozenFacts.flatMap(fact => fact.evidence.map(evidence => ({
      ...evidence, id:evidence.claim_id || evidence.id, normalized_key:fact.normalized_key,
      evidence_span_ids_json:JSON.stringify(evidence.evidence_span_ids || []) }))) : this.db.prepare(`SELECT c.id,c.normalized_key,c.source_id,c.evidence_span_ids_json FROM claims c
      JOIN structured_sources ss ON ss.source_id=c.source_id
      WHERE ss.destination_slug=? AND c.lifecycle_status='active' AND c.knowledge_eligible=1`).all(draftRow?.destination_slug || "");
    const sourceIdsByClaim = new Map();
    const claimTracesByKey = new Map();
    for (const row of sourceRows) sourceIdsByClaim.set(row.normalized_key,
      [...new Set([...(sourceIdsByClaim.get(row.normalized_key) || []), row.source_id])].sort());
    for (const row of sourceRows) claimTracesByKey.set(row.normalized_key,
      [...(claimTracesByKey.get(row.normalized_key) || []), { claimId: row.id, sourceId: row.source_id,
        evidenceSpanIds: json(row.evidence_span_ids_json, []), ...(hasFrozenPacket ? {
          evidenceRole:row.evidence_role || 'current', value:row.value, qualifiers:row.qualifiers,
          validFrom:row.valid_from,validTo:row.valid_to,revision:row.extraction_revision } : {}) }]);
    const provenance = buildBlockProvenance(payload, json(draftRow?.evidence_ledger_json, []), explicitProvenance,
      sourceIdsByClaim, claimTracesByKey, hasFrozenPacket ? new Map(frozenFacts.map(fact => [fact.normalized_key,fact])) : new Map());
    const validationRecord = { ...validation, valid: Boolean(validation.valid && provenance.valid),
      errors: [...(validation.errors || []), ...provenance.errors], blockProvenance: provenance.blocks,
      provenanceVersion: provenance.version };
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
      snapshot.checksum, JSON.stringify(payload), JSON.stringify(validationRecord), validationRecord.valid ? "valid" : "invalid", model, timestamp, timestamp,
      draft.revision, draft.content_hash);
    return this.getFrontendPageComposition(draftId);
  }

  getFrontendPageComposition(draftId) {
    const row = this.db.prepare("SELECT * FROM frontend_page_compositions WHERE draft_id=?").get(draftId);
    if (!row) return null;
    const draft = this.db.prepare("SELECT revision, content_hash FROM article_drafts WHERE id=?").get(draftId);
    const payload = json(row.payload_json, {});
    const validation = json(row.validation_json, {});
    if (!Array.isArray(validation.blockProvenance)) {
      validation.blockProvenance = legacyBlockProvenance(payload);
      validation.provenanceVersion = "legacy_unknown";
    }
    return { ...row, payload, validation,
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
    const pageContentHash = sha256(JSON.stringify(publishPackage.page || {}));
    const seoArtifactHash = sha256(JSON.stringify({ seo: publishPackage.seo || {}, schema: publishPackage.schema_jsonld || {},
      metadata: publishPackage.page?.metadata || {} }));
    this.db.prepare(`
      INSERT INTO frontend_publish_compositions(id, draft_id, frontend_page_composition_id, commercial_composition_id,
        snapshot_id, publish_package_version, contract_version, page_schema_version, contract_checksum,
        commercial_strategy_version, publish_package_json, validation_json, status, generated_at, updated_at,
        draft_revision, draft_content_hash, page_content_hash, seo_artifact_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(draft_id) DO UPDATE SET frontend_page_composition_id=excluded.frontend_page_composition_id,
        commercial_composition_id=excluded.commercial_composition_id, snapshot_id=excluded.snapshot_id,
        publish_package_version=excluded.publish_package_version, contract_version=excluded.contract_version,
        page_schema_version=excluded.page_schema_version, contract_checksum=excluded.contract_checksum,
        commercial_strategy_version=excluded.commercial_strategy_version, publish_package_json=excluded.publish_package_json,
        validation_json=excluded.validation_json, status=excluded.status, wordpress_post_id=NULL,
        generated_at=excluded.generated_at, updated_at=excluded.updated_at,
        draft_revision=excluded.draft_revision, draft_content_hash=excluded.draft_content_hash,
        page_content_hash=excluded.page_content_hash, seo_artifact_hash=excluded.seo_artifact_hash
    `).run(compositionId, draftId, frontendPage.id, commercial.id, snapshot.id, snapshot.publishPackageVersion || "1.0.0",
      publishPackage.contract.componentContractVersion, publishPackage.contract.pageSchemaVersion,
      publishPackage.contract.contractChecksum, commercialStrategyVersion || "", JSON.stringify(publishPackage),
      JSON.stringify(validation), validation.valid ? "valid" : "invalid", timestamp, timestamp,
      draft.revision, draft.content_hash, pageContentHash, seoArtifactHash);
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
    capture = persistCaptureAssets(capture, this.contentConfig.sourceUploadsDir);
    const timestamp = now();
    const contentHash = captureContentHash(capture);
    const storageSnapshot=captureStorageSnapshot(capture);
    const sourceKind = capture.sourceKind || (capture.adapter === "xiaohongshu" ? "xiaohongshu_note" : "manual_source");
    const submittedUrl = capture.submittedUrl || capture.canonicalUrl;
    const submissionMetadata = { ...(capture.submissionMetadata || {}) };
    submissionMetadata.processingEstimate ||= estimateSourceProcessing(capture, {
      imageBatchSize: this.contentConfig.mediaImageBatchSize,
      textSegmentMaxChars: this.contentConfig.sourceTextSegmentMaxChars,
    });
    const hardLimitBlocked = submissionMetadata.processingEstimate?.processingClass === "blocked_hard_limit";
    const completeness = capture.completeness || { overall: "complete" };
    const completenessStatus = ["complete", "partial_retryable", "partial_needs_attention"].includes(completeness.overall)
      ? completeness.overall : "complete";
    const acquisitionOrigin = capture.acquisitionOrigin || capture.client?.acquisitionOrigin || (capture.adapter === "xiaohongshu" ? "xhs_manual_extension" : "manual_upload");
    const syncScopeKey = capture.syncScopeKey || capture.client?.syncScopeKey || "";
    const extensionVersion = capture.client?.extensionVersion || "";
    const rights = capture.rights || {};
    const sourceIdentity = capture.sourceIdentity || defaultSourceIdentity(capture);
    const sourceVersionIdentity = capture.sourceVersionIdentity || contentHash;

    return transaction(this.db, () => {
      const restoredAssetIds = [];
      // A note ID remains stable when Xiaohongshu changes a share URL or adds
      // transient tokens. Canonical URL remains the fallback for old captures.
      const existingByExternalId = capture.externalId
        ? this.db.prepare("SELECT id, content_hash, capture_version, completeness_status FROM sources WHERE adapter = ? AND external_id = ? LIMIT 1").get(capture.adapter, capture.externalId)
        : null;
      const existingByIdentity = sourceIdentity
        ? this.db.prepare("SELECT id, content_hash, capture_version, completeness_status FROM sources WHERE source_identity=? ORDER BY created_at LIMIT 1").get(sourceIdentity)
        : null;
      const existing = existingByIdentity || existingByExternalId
        || this.db.prepare("SELECT id, content_hash, capture_version, completeness_status FROM sources WHERE canonical_url = ?").get(capture.canonicalUrl);
      let sourceId;
      let duplicate = false;
      let captureVersion = 1;
      if (existing?.completeness_status === 'complete'
        && !this.db.prepare("SELECT 1 FROM current_source_assets WHERE source_id=? AND durability_status<>'ORIGINAL_STORED' LIMIT 1").get(existing.id)
        && (completenessStatus !== 'complete'
        || (capture.adapter === 'xiaohongshu' && capture.assets.some(asset => asset.durabilityStatus !== 'ORIGINAL_STORED')))) {
        const prior = this.db.prepare('SELECT capture_version FROM capture_versions WHERE source_id=? AND content_hash=? AND completeness_status=?')
          .get(existing.id, contentHash, completenessStatus);
        if (!prior) {
          const revision = this.db.prepare('SELECT COALESCE(MAX(capture_version),0)+1 AS next FROM capture_versions WHERE source_id=?').get(existing.id).next;
          this.db.prepare(`INSERT INTO capture_versions(id,source_id,capture_version,captured_at,raw_text,raw_html,raw_payload_json,
            assets_json,content_hash,completeness_status,completeness_json,acquisition_origin,sync_scope_key,extension_version,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id('capture_version'), existing.id, revision, capture.capturedAt,
              capture.rawText, capture.rawHtml, JSON.stringify(storageSnapshot), JSON.stringify(storageSnapshot.assets), contentHash,
              completenessStatus, JSON.stringify(completeness), acquisitionOrigin, syncScopeKey, extensionVersion, timestamp);
        }
        return { id: existing.id, accepted: true, duplicate: Boolean(prior), captureVersion: existing.capture_version,
          completenessStatus: 'partial_retryable', mediaDurabilityComplete: false, extractionQueued: false, preservedCompleteVersion: true };
      }
      const completenessUpgrade = existing?.completeness_status !== "complete" && completenessStatus === "complete";
      if (existing && existing.content_hash === contentHash && !completenessUpgrade) {
        sourceId = existing.id;
        duplicate = true;
        captureVersion = existing.capture_version;
        this.db.prepare(`UPDATE sources SET captured_at=?,published_at=COALESCE(?,published_at),submission_metadata_json=?,
          raw_payload_json=?,extension_version=?,updated_at=? WHERE id=?`).run(capture.capturedAt,capture.publishedAt,
           JSON.stringify(submissionMetadata),JSON.stringify(storageSnapshot),extensionVersion,timestamp,sourceId);
        const findRefreshAsset = this.db.prepare(`SELECT id,ai_derivative_data_url FROM current_source_assets
          WHERE source_id=? AND kind=? AND (media_identity=? OR position=?) LIMIT 1`);
        const refreshAsset = this.db.prepare(`UPDATE source_assets SET remote_url=?,local_path=CASE WHEN ?<>'' THEN ? ELSE local_path END,
          mime_type=CASE WHEN ?<>'' THEN ? ELSE mime_type END,storage_status=?,original_bytes_status=?,
          stored_sha256=CASE WHEN ?<>'' THEN ? ELSE stored_sha256 END,stored_size_bytes=COALESCE(?,stored_size_bytes),
          original_sha256=CASE WHEN ?<>'' THEN ? ELSE original_sha256 END,
          ai_derivative_data_url=CASE WHEN ?<>'' THEN ? ELSE ai_derivative_data_url END,
          ai_derivative_sha256=CASE WHEN ?<>'' THEN ? ELSE ai_derivative_sha256 END,
          durability_status=?,ai_readability_status=?,repair_status=?,storage_error='',
          recovered_at=CASE WHEN ?='ORIGINAL_STORED' THEN ? ELSE recovered_at END,
          provenance_json=? WHERE source_id=? AND kind=? AND (media_identity=? OR position=?)
          AND capture_version=(SELECT capture_version FROM sources WHERE sources.id=source_assets.source_id)`);
        for (const asset of capture.assets || []) {
          if (!asset.derivativeStorageRef && !asset.originalSha256) continue;
          const storedAsset = findRefreshAsset.get(sourceId, asset.kind, asset.mediaIdentity || asset.url, asset.position);
          refreshAsset.run(asset.url,asset.localPath || '',asset.localPath || '',asset.mimeType || '',asset.mimeType || '',asset.storageStatus || 'discovered',asset.originalBytesStatus || 'missing',
            asset.storedSha256 || '',asset.storedSha256 || '',asset.storedSizeBytes ?? null,asset.originalSha256 || '',asset.originalSha256 || '',
            asset.aiDerivativeDataUrl || '',asset.aiDerivativeDataUrl || '',asset.aiDerivativeSha256 || '',asset.aiDerivativeSha256 || '',
            asset.durabilityStatus || 'REMOTE_ONLY',asset.aiReadabilityStatus || 'temporarily_unavailable',
            asset.repairStatus || 'server_recovery_pending',asset.durabilityStatus || 'REMOTE_ONLY',timestamp,
            JSON.stringify({ sourceId,externalId:capture.externalId || null,canonicalUrl:capture.canonicalUrl,capturedAt:capture.capturedAt,
              captureVersion,acquisitionOrigin,syncScopeKey,extensionVersion,mediaSourceUrl:asset.url,mediaRefreshedAt:timestamp,...asset.provenance }),
            sourceId,asset.kind,asset.mediaIdentity || asset.url,asset.position);
          if (storedAsset && asset.durabilityStatus === "ORIGINAL_STORED") {
            this.db.prepare(`DELETE FROM jobs WHERE entity_id=? AND type IN ('repair_media_asset','backfill_media_asset') AND status='queued'`)
              .run(storedAsset.id);
          }
          if (storedAsset && asset.derivativeStorageRef) this.saveSourceAssetStorageRef(storedAsset.id,asset);
          if (storedAsset && !storedAsset.ai_derivative_data_url && (asset.aiDerivativeDataUrl || asset.derivativeStorageRef)) restoredAssetIds.push(storedAsset.id);
        }
      } else if (existing) {
        sourceId = existing.id;
        captureVersion = this.db.prepare('SELECT COALESCE(MAX(capture_version),0)+1 AS next FROM capture_versions WHERE source_id=?').get(sourceId).next;
        this.db.prepare(`
          UPDATE sources SET adapter = ?, external_id = ?, canonical_url = ?, submitted_url = ?, source_kind = ?, submission_metadata_json = ?,
            title = ?, author_name = ?, author_url = ?, published_at = ?,
            captured_at = ?, raw_text = ?, raw_html = ?, raw_payload_json = ?, content_hash = ?,
            capture_version = ?, status = ?, last_error = NULL, acquisition_origin=?, sync_scope_key=?,
            extension_version=?, completeness_status=?, completeness_json=?, authorization_status=?, commercial_use_allowed=?,
            editing_allowed=?, redistribution_allowed=?, publishable=?, authorization_origin=?, license_scope_json=?, updated_at = ?
          WHERE id = ?
        `).run(
          capture.adapter, capture.externalId, capture.canonicalUrl, submittedUrl, sourceKind, JSON.stringify(submissionMetadata),
          capture.title, capture.authorName, capture.authorUrl, capture.publishedAt,
          capture.capturedAt, capture.rawText, capture.rawHtml, JSON.stringify(storageSnapshot), contentHash,
          captureVersion, completenessStatus === "complete" ? "captured" : "partial", acquisitionOrigin, syncScopeKey, extensionVersion,
          completenessStatus, JSON.stringify(completeness), rights.authorizationStatus || "legacy",
          rights.commercialUseAllowed ? 1 : 0, rights.editingAllowed ? 1 : 0, rights.redistributionAllowed ? 1 : 0,
          rights.publishable ? 1 : 0, rights.authorizationOrigin || acquisitionOrigin, JSON.stringify(rights.licenseScope || []),
          timestamp, sourceId,
        );
        // Keep prior asset IDs, file paths and evidence relationships intact.
        // Current readers select only sources.capture_version through views.
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
          JSON.stringify(storageSnapshot), contentHash, completenessStatus === "complete" ? "captured" : "partial",
          acquisitionOrigin, syncScopeKey, extensionVersion, completenessStatus, JSON.stringify(completeness),
          rights.authorizationStatus || "legacy", rights.commercialUseAllowed ? 1 : 0, rights.editingAllowed ? 1 : 0,
          rights.redistributionAllowed ? 1 : 0, rights.publishable ? 1 : 0, rights.authorizationOrigin || acquisitionOrigin,
          JSON.stringify(rights.licenseScope || []), timestamp, timestamp,
        );
      }

      this.db.prepare(`UPDATE sources SET submitted_by=?,source_publisher=?,source_identity=?,source_version_identity=?,
        original_url=?,final_url=? WHERE id=?`).run(
        capture.submittedBy || "", capture.sourcePublisher || "", sourceIdentity, sourceVersionIdentity,
        capture.originalUrl || submittedUrl || "", capture.finalUrl || submittedUrl || "", sourceId,
      );

      if (!duplicate) {
        const insertAsset = this.db.prepare(`
          INSERT OR IGNORE INTO source_assets(id, source_id, kind, remote_url, alt_text, position, local_path, mime_type, original_filename,
            media_identity,width,height,duration,original_sha256,ai_derivative_data_url,ai_derivative_sha256,authorization_status,
            commercial_use_allowed,editing_allowed,redistribution_allowed,publishable,authorization_origin,provenance_json,
            storage_status,original_bytes_status,stored_sha256,stored_size_bytes,language_status,nearby_text,caption_text,dom_order,
            durability_status,ai_readability_status,repair_status,storage_error,recovered_at,capture_version)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)
        `);
        for (const asset of capture.assets) {
          const originalBytesStored = Boolean(asset.localPath && (asset.originalBytesStatus === "saved_original"
            || (capture.adapter !== "xiaohongshu" && asset.originalBytesStatus === "saved_unknown")));
          const assetId=id("asset");
          insertAsset.run(assetId, sourceId, asset.kind, asset.url, asset.alt, asset.position,
            asset.localPath || "", asset.mimeType || "", asset.originalFilename || "", asset.mediaIdentity || asset.url,
            asset.width ?? null, asset.height ?? null, asset.duration ?? null, asset.originalSha256 || "",
            asset.aiDerivativeDataUrl || "", asset.aiDerivativeSha256 || "", rights.authorizationStatus || "legacy",
            rights.commercialUseAllowed ? 1 : 0, rights.editingAllowed ? 1 : 0, rights.redistributionAllowed ? 1 : 0,
            rights.publishable ? 1 : 0, rights.authorizationOrigin || acquisitionOrigin,
            JSON.stringify({ sourceId, externalId: capture.externalId || null, canonicalUrl: capture.canonicalUrl,
              capturedAt: capture.capturedAt, captureVersion, acquisitionOrigin, syncScopeKey, extensionVersion,
              mediaSourceUrl: asset.url, ...asset.provenance }),
            asset.storageStatus || (asset.localPath ? "saved" : "discovered"), asset.originalBytesStatus || (asset.localPath ? "saved_unknown" : "missing"),
            asset.storedSha256 || "", asset.storedSizeBytes ?? null, asset.languageStatus || "unknown",
            asset.nearbyText || asset.provenance?.nearbyText || "", asset.captionText || asset.provenance?.captionText || "",
            asset.domOrder ?? asset.provenance?.domOrder ?? asset.position,
            asset.durabilityStatus || (originalBytesStored ? "ORIGINAL_STORED"
              : asset.localPath || asset.derivativeStorageRef ? "DERIVATIVE_ONLY" : asset.url ? "REMOTE_ONLY" : "UNAVAILABLE"),
            asset.aiReadabilityStatus || (asset.localPath || asset.derivativeStorageRef ? "processable" : asset.url ? "temporarily_unavailable" : "unsupported"),
            asset.repairStatus || (originalBytesStored ? "not_needed"
              : asset.url ? "server_recovery_pending" : "unavailable"),
            originalBytesStored ? timestamp : null, captureVersion,
          );
          this.saveSourceAssetStorageRef(assetId,asset);
        }
        const insertFile = this.db.prepare(`
          INSERT INTO source_files(id, source_id, file_kind, original_filename, mime_type, storage_path, size_bytes, sha256, created_at,capture_version)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const file of capture.files || []) {
          const fileId=file.id && !this.db.prepare('SELECT 1 FROM source_files WHERE id=?').get(file.id) ? file.id : id('source_file');
          insertFile.run(fileId, sourceId, file.fileKind, file.originalFilename,
            file.mimeType, file.storagePath, file.sizeBytes, file.sha256, timestamp, captureVersion);
        }
        this.db.prepare(`INSERT INTO capture_versions(id,source_id,capture_version,captured_at,raw_text,raw_html,raw_payload_json,
          assets_json,content_hash,completeness_status,completeness_json,acquisition_origin,sync_scope_key,extension_version,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(id("capture_version"), sourceId, captureVersion, capture.capturedAt, capture.rawText, capture.rawHtml,
            JSON.stringify(storageSnapshot), JSON.stringify(storageSnapshot.assets || []), contentHash, completenessStatus,
            JSON.stringify(completeness), acquisitionOrigin, syncScopeKey, extensionVersion, timestamp);
      }

      // A same-content re-capture may restore bytes that an expired CDN URL could
      // no longer provide. Resume only drafts that already reference those exact
      // assets and are still blocked; do not rerun extraction or upstream writing.
      const resumedDraftIds = [];
      if (restoredAssetIds.length) {
        const placeholders = restoredAssetIds.map(() => "?").join(",");
        const drafts = this.db.prepare(`SELECT DISTINCT ad.id,ad.revision FROM article_visuals av
          JOIN article_drafts ad ON ad.id=av.draft_id
          WHERE av.source_asset_id IN (${placeholders}) AND ad.status IN ('exception','qa_failed')`).all(...restoredAssetIds);
        for (const draft of drafts) {
          const dedupeKey = `media-restored:compose_frontend_page:${draft.id}:r${draft.revision}`;
          if (this.db.prepare("SELECT id FROM jobs WHERE dedupe_key=? LIMIT 1").get(dedupeKey)) continue;
          if (this.db.prepare("SELECT id FROM jobs WHERE entity_id=? AND status IN ('queued','running') LIMIT 1").get(draft.id)) continue;
          this.enqueue("compose_frontend_page", draft.id, { dedupeKey });
          resumedDraftIds.push(draft.id);
        }
      }

      const mediaDurability = this.mediaRepairManifest(sourceId);
      let extractionQueued = false;
      let mediaRepairQueued = 0;
      if (completenessStatus === "complete" && !hardLimitBlocked) {
        if (mediaDurability.mediaDurability.complete) {
          if (duplicate) extractionQueued = this.resumeSourceAfterMediaRecovery(sourceId);
          else {
            this.enqueue("extract_source", sourceId, { dedupeKey: `extract_source:${sourceId}:${captureVersion}`,
              workloadClass:"interactive",interactive:true,priority:10 });
            extractionQueued = true;
          }
        } else {
          mediaRepairQueued = this.enqueueSourceMediaRepairs(sourceId, "repair_media_asset");
        }
      }
      const queueDepth = this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('queued','running')").get().count;

      return {
        id: sourceId,
        accepted: true,
        duplicate,
        queued: extractionQueued || mediaRepairQueued > 0,
        extractionQueued,
        mediaRepairQueued,
        requiresManualStart: false,
        processingClass: submissionMetadata.processingEstimate?.processingClass || "normal",
        hardLimitBlocked: completenessStatus === "complete" && hardLimitBlocked,
        processingEstimate: submissionMetadata.processingEstimate,
        captureVersion,
        completenessStatus,
        mediaDurabilityStatus: mediaDurability.mediaDurability.status,
        mediaDurabilityComplete: mediaDurability.mediaDurability.complete,
        mediaDurability,
        restoredAssets: restoredAssetIds.length,
        resumedDraftIds,
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
    const rows = clauses.length ? this.db.prepare(`SELECT id,external_id,canonical_url,capture_version,captured_at,content_hash,completeness_status,source_availability,status,raw_text,raw_html
      FROM sources WHERE ${clauses.join(" OR ")}`).all(...parameters) : [];
    const byExternalId = new Map(rows.filter((row) => row.external_id).map((row) => [row.external_id, row]));
    const byUrl = new Map(rows.map((row) => [row.canonical_url, row]));
    return normalized.map((item) => {
      const row = (item.externalId && byExternalId.get(item.externalId)) || (item.canonicalUrl && byUrl.get(item.canonicalUrl));
      const complete = row?.completeness_status === "complete" && row?.source_availability === "available";
      if (row) {
        const manifest = this.mediaRepairManifest(row.id);
        const requiredActions = [];
        if (!complete || !row.raw_text || !row.raw_html) requiredActions.push("RECAPTURE_TEXT_DOM");
        if (manifest.mediaDurability.serverRecoverable > 0) requiredActions.push("SERVER_MEDIA_RECOVERY");
        if (manifest.mediaDurability.browserRepairRequired > 0) requiredActions.push("BROWSER_MEDIA_REPAIR");
        if (!manifest.mediaDurability.complete && !requiredActions.includes("BROWSER_MEDIA_REPAIR")) requiredActions.push("VERIFY_MEDIA_ORIGINALS");
        if (!manifest.experience.complete) requiredActions.push("EXTRACT_EXPERIENCE");
        return { externalId: item.externalId || row.external_id, known: complete, needsRecapture: !complete,
          sourceExists: true, sourceId: row.id, captureVersion: row.capture_version, lastCapturedAt: row.captured_at,
          canonicalUrl: row.canonical_url, contentFingerprint: row.content_hash.slice(0, 12), ...manifest, requiredActions };
      }
      return { externalId: item.externalId || null, known: false, sourceExists: false, sourceId: null, captureVersion: null,
          lastCapturedAt: null, canonicalUrl: item.canonicalUrl || null, contentFingerprint: null,
          capture: { text: "missing", dom: "missing", status: "missing" },
          mediaDiscovery: { images: { expected: null, discovered: 0 }, videos: { expected: null, discovered: 0 } },
          mediaDurability: { status: "missing", complete: false, originalsStored: 0, discovered: 0, remoteOnly: 0,
            derivativeOnly: 0, unavailable: 0, serverRecoverable: 0, browserRepairRequired: 0 },
          repairMedia: { missingOriginals: [] },
          extractionStatus: "missing", experience: { status: "missing", complete: false }, requiredActions: ["CAPTURE_NEW"] };
    });
  }

  mediaRepairManifest(sourceId) {
    const source = this.db.prepare(`SELECT id,status,capture_version,completeness_status,completeness_json,raw_text,raw_html
      FROM sources WHERE id=?`).get(sourceId);
    if (!source) return null;
    const assets = this.db.prepare(`SELECT kind,media_identity,durability_status,repair_status,ai_readability_status
      FROM current_source_assets WHERE source_id=?`).all(sourceId);
    const completeness = json(source.completeness_json, {});
    const summarize = (kind) => {
      const rows = assets.filter((asset) => asset.kind === kind);
      return { expected: completeness[kind === "image" ? "images" : "videos"]?.expected ?? null, discovered: rows.length,
        originalsStored: rows.filter((asset) => asset.durability_status === "ORIGINAL_STORED").length };
    };
    const originalsStored = assets.filter((asset) => asset.durability_status === "ORIGINAL_STORED").length;
    const durability = {
      status: assets.length === originalsStored ? "ORIGINAL_STORED" : assets.some((asset) => asset.durability_status === "UNAVAILABLE") ? "UNAVAILABLE"
        : assets.some((asset) => asset.durability_status === "REMOTE_ONLY") ? "REMOTE_ONLY" : "DERIVATIVE_ONLY",
      complete: assets.length === originalsStored,
      discovered: assets.length,
      originalsStored,
      derivativeOnly: assets.filter((asset) => asset.durability_status === "DERIVATIVE_ONLY").length,
      remoteOnly: assets.filter((asset) => asset.durability_status === "REMOTE_ONLY").length,
      unavailable: assets.filter((asset) => asset.durability_status === "UNAVAILABLE").length,
      serverRecoverable: assets.filter((asset) => asset.repair_status === "server_recovery_pending").length,
      browserRepairRequired: assets.filter((asset) => asset.repair_status === "browser_repair_required").length,
    };
    const experience = this.db.prepare(`SELECT status,degraded,updated_at FROM experience_extraction_runs
      WHERE source_id=? AND capture_version=? ORDER BY updated_at DESC,created_at DESC LIMIT 1`).get(sourceId,source.capture_version);
    return {
      capture: { text: source.raw_text ? "complete" : "missing", dom: source.raw_html ? "complete" : "missing", status: source.completeness_status },
      mediaDiscovery: { images: summarize("image"), videos: summarize("video") },
      mediaDurability: durability,
      repairMedia: {
        missingOriginals: assets.filter((asset) => asset.durability_status !== "ORIGINAL_STORED").map((asset) => ({
          mediaIdentity: asset.media_identity, kind: asset.kind, repairStatus: asset.repair_status,
        })),
      },
      aiReadability: { processable: assets.filter((asset) => asset.ai_readability_status === "processable").length,
        temporarilyUnavailable: assets.filter((asset) => asset.ai_readability_status === "temporarily_unavailable").length,
        unsupported: assets.filter((asset) => asset.ai_readability_status === "unsupported").length },
      extractionStatus: source.status,
      experience: { status: experience?.status || "pending", complete: experience?.status === "succeeded", degraded: Boolean(experience?.degraded) },
    };
  }

  getMediaRecoveryAsset(assetId) {
    return this.db.prepare(`SELECT sa.*,s.adapter,s.canonical_url,s.external_id,sa.capture_version=s.capture_version AS is_current FROM source_assets sa
      JOIN sources s ON s.id=sa.source_id WHERE sa.id=?`).get(assetId) || null;
  }

  saveSourceAssetStorageRef(assetId,asset={}) {
    if(!asset.originalStorageRef&&!asset.derivativeStorageRef)return false;
    const timestamp=now();
    this.db.prepare(`INSERT INTO source_asset_storage_refs(asset_id,original_storage_ref,derivative_storage_ref,derivative_cache_key,transform_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(asset_id) DO UPDATE SET original_storage_ref=excluded.original_storage_ref,
        derivative_storage_ref=excluded.derivative_storage_ref,derivative_cache_key=excluded.derivative_cache_key,
        transform_json=excluded.transform_json,updated_at=excluded.updated_at`).run(assetId,asset.originalStorageRef||"",asset.derivativeStorageRef||"",
          asset.aiDerivativeSha256||asset.storedSha256||"",JSON.stringify(asset.derivativeTransform||{}),timestamp,timestamp);
    return true;
  }

  startMediaRecovery(assetId) {
    return this.db.prepare(`UPDATE source_assets SET repair_status='server_recovery_running',repair_attempts=repair_attempts+1,
      storage_error='' WHERE id=? AND durability_status<>'ORIGINAL_STORED'`).run(assetId).changes === 1;
  }

  saveRecoveredMedia(assetId, stored) {
    const timestamp = now();
    this.db.prepare(`UPDATE source_assets SET local_path=?,mime_type=?,original_sha256=?,stored_sha256=?,stored_size_bytes=?,
      storage_status='saved',original_bytes_status='saved_original',durability_status='ORIGINAL_STORED',
      ai_readability_status='processable',repair_status='not_needed',storage_error='',recovered_at=? WHERE id=?`)
      .run(stored.localPath, stored.mimeType, stored.sha256, stored.sha256, stored.sizeBytes, timestamp, assetId);
    const asset = this.getMediaRecoveryAsset(assetId);
    if (asset?.is_current) this.resumeSourceAfterMediaRecovery(asset.source_id);
    this.refreshMediaBackfillRuns();
    return asset;
  }

  failMediaRecovery(assetId, error, { browserRequired = false } = {}) {
    const status = browserRequired ? "browser_repair_required" : "server_recovery_pending";
    this.db.prepare(`UPDATE source_assets SET repair_status=?,storage_error=?,
      durability_status=CASE WHEN remote_url<>'' THEN durability_status ELSE 'UNAVAILABLE' END,
      ai_readability_status=CASE WHEN ai_readability_status='processable' THEN ai_readability_status ELSE 'temporarily_unavailable' END
      WHERE id=?`).run(status, String(error?.message || error || "Media recovery failed").slice(0, 2_000), assetId);
    this.refreshMediaBackfillRuns();
  }

  enqueueSourceMediaRepairs(sourceId, type = "repair_media_asset") {
    const assets = this.db.prepare(`SELECT id FROM current_source_assets WHERE source_id=?
      AND durability_status<>'ORIGINAL_STORED' AND remote_url<>''
      AND repair_status NOT IN ('unavailable','browser_repair_required') ORDER BY position,id`).all(sourceId);
    for (const asset of assets) this.enqueue(type, asset.id, { dedupeKey: `${type}:${asset.id}`, priority: 10 });
    return assets.length;
  }

  resumeSourceAfterMediaRecovery(sourceId) {
    const source = this.db.prepare(`SELECT id,status,capture_version,completeness_status,submission_metadata_json
      FROM sources WHERE id=?`).get(sourceId);
    if (!source || source.completeness_status !== "complete") return false;
    if (json(source.submission_metadata_json, {}).processingEstimate?.processingClass === "blocked_hard_limit") return false;
    const manifest = this.mediaRepairManifest(sourceId);
    if (!manifest?.mediaDurability.complete) return false;
    if (["processing","processed","needs_ai"].includes(source.status)) {
      if (source.status === "processing") return false;
      const mediaRevision=this.db.prepare(`SELECT group_concat(id || ':' || durability_status || ':' || COALESCE(stored_sha256,''), '|') value
        FROM (SELECT id,durability_status,stored_sha256 FROM current_source_assets WHERE source_id=? ORDER BY position,id)`).get(sourceId)?.value || "no-media";
      const timestamp=now();
      transaction(this.db,() => {
        this.db.prepare(`UPDATE sources SET recommendation_reconciled_version='',recommendation_reconciled_at=NULL,updated_at=? WHERE id=?`)
          .run(timestamp,sourceId);
        this.db.prepare(`UPDATE content_opportunities SET processing_state='PROCESSING_GAP',inbox_state='INTERNAL',
          processing_detail_json=?,recommendation_reconciled_version='',recommendation_reconciled_at=NULL,updated_at=?
          WHERE source_id=? OR EXISTS (SELECT 1 FROM json_each(content_opportunities.source_ids_json) WHERE value=?)`)
          .run(JSON.stringify({gaps:[{sourceId,gaps:["media_repair_recalculation"]}],nextOwner:"system"}),timestamp,sourceId,sourceId);
        this.enqueue("extract_source_experience",sourceId,{
          dedupeKey:`media-refresh-experience:${sourceId}:${source.capture_version}:${sha256(mediaRevision).slice(0,16)}`,
          priority:15,
        });
      });
      return true;
    }
    const dedupeKey=`extract_source:${sourceId}:${source.capture_version}`;
    if (this.db.prepare("SELECT id FROM jobs WHERE dedupe_key=? AND status IN ('queued','running') LIMIT 1").get(dedupeKey)) return false;
    this.db.prepare("UPDATE sources SET status='captured',last_error=NULL,updated_at=? WHERE id=?").run(now(),sourceId);
    this.enqueue("extract_source",sourceId,{dedupeKey});
    return true;
  }

  refreshMediaBackfillRuns() {
    const runs = this.db.prepare("SELECT id,report_json FROM source_media_backfill_runs WHERE status='queued'").all();
    if (!runs.length) return 0;
    const timestamp = now();
    for (const run of runs) {
      const previous=json(run.report_json,{}); const assetIds=uniqueStrings(previous.assetIds,100_000);
      const states=[];
      for (let offset=0;offset<assetIds.length;offset+=500) {
        const page=assetIds.slice(offset,offset+500);
        states.push(...this.db.prepare(`SELECT durability_status,repair_status FROM source_assets
          WHERE id IN (${page.map(() => "?").join(",")})`).all(...page));
      }
      const report = { ...previous,originalStored:states.filter((row) => row.durability_status==="ORIGINAL_STORED").length,
        browserRepairRequired:states.filter((row) => row.repair_status==="browser_repair_required").length,
        unavailable:states.filter((row) => row.durability_status==="UNAVAILABLE" || row.repair_status==="unavailable").length,
        pending:states.filter((row) => row.durability_status!=="ORIGINAL_STORED" && ["server_recovery_pending","server_recovery_running"].includes(row.repair_status)).length };
      const complete = report.pending === 0;
      this.db.prepare(`UPDATE source_media_backfill_runs SET status=?,original_stored_count=?,browser_repair_count=?,
        unavailable_count=?,report_json=?,completed_at=CASE WHEN ? THEN ? ELSE completed_at END,updated_at=? WHERE id=?`)
        .run(complete ? "completed" : "queued",report.originalStored,report.browserRepairRequired,report.unavailable,
          JSON.stringify(report),complete ? 1 : 0,timestamp,timestamp,run.id);
    }
    return runs.length;
  }

  enqueueMediaDurabilityBackfill({ dryRun = false } = {}) {
    const rows = this.db.prepare(`SELECT id,durability_status,repair_status,remote_url FROM current_source_assets
      WHERE durability_status<>'ORIGINAL_STORED' ORDER BY source_id,position,id`).all();
    const report = {
      scanned: rows.length,
      originalStored: 0,
      recoveryEligible: rows.filter((row) => row.remote_url && !["unavailable","browser_repair_required"].includes(row.repair_status)).length,
      browserRepairRequired: rows.filter((row) => row.repair_status === "browser_repair_required").length,
      unavailable: rows.filter((row) => row.durability_status === "UNAVAILABLE").length,
      assetIds:rows.map((row) => row.id),
    };
    const timestamp = now();
    const runId = id("media_backfill");
    const immediatelyComplete=!dryRun && report.recoveryEligible===0;
    this.db.prepare(`INSERT INTO source_media_backfill_runs(id,status,scanned_count,original_stored_count,recovery_queued_count,
      browser_repair_count,unavailable_count,report_json,started_at,completed_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(runId, dryRun ? "dry_run" : immediatelyComplete ? "completed" : "queued", report.scanned, 0,
      dryRun ? 0 : report.recoveryEligible, report.browserRepairRequired, report.unavailable, JSON.stringify(report),
      timestamp, dryRun || immediatelyComplete ? timestamp : null, timestamp, timestamp);
    if (!dryRun) for (const row of rows) {
      if (!row.remote_url || ["unavailable","browser_repair_required"].includes(row.repair_status)) continue;
      this.enqueue("backfill_media_asset", row.id, { dedupeKey: `backfill_media_asset:${row.id}`, priority: 70 });
    }
    const {assetIds: _assetIds,...publicReport}=report;
    return { id: runId, dryRun, ...publicReport, queued: dryRun ? 0 : report.recoveryEligible };
  }

  runExperienceBackfill({ dryRun = true } = {}) {
    const rows = this.db.prepare(`SELECT s.id,s.title,s.capture_version FROM sources s
      WHERE s.completeness_status='complete' AND s.status IN ('processed','needs_ai')
        AND NOT EXISTS (SELECT 1 FROM current_source_assets sa WHERE sa.source_id=s.id AND sa.durability_status<>'ORIGINAL_STORED')
        AND NOT EXISTS (SELECT 1 FROM experience_extraction_runs er WHERE er.source_id=s.id AND er.status='succeeded'
          AND er.capture_version=s.capture_version AND er.degraded=0)
      ORDER BY s.captured_at,s.id`).all();
    const blockedByMedia=Number(this.db.prepare(`SELECT COUNT(*) n FROM sources s
      WHERE s.completeness_status='complete' AND s.status IN ('processed','needs_ai')
        AND EXISTS (SELECT 1 FROM current_source_assets sa WHERE sa.source_id=s.id AND sa.durability_status<>'ORIGINAL_STORED')`).get()?.n || 0);
    const report = {eligible:rows.length,blockedByMedia,queued:0,sourceIds:rows.map((row) => row.id)};
    if (!dryRun) for (const row of rows) {
      // Share the canonical key with startup/source-completion scheduling so a
      // historical backfill cannot purchase the same model call twice.
      this.enqueue("extract_source_experience",row.id,{
        dedupeKey:`experience-current:${row.id}:${row.capture_version}:${this.strategyVersion}`,priority:70,
      });
      report.queued += 1;
    }
    return this.saveSystemBackfillRun("experience",dryRun,report);
  }

  coalesceQueuedExperienceJobs() {
    const timestamp=now(); let superseded=0;
    const entities=this.db.prepare(`SELECT entity_id FROM jobs WHERE type='extract_source_experience'
      AND status IN ('queued','running') GROUP BY entity_id HAVING COUNT(*)>1`).all();
    for (const {entity_id} of entities) {
      const rows=this.db.prepare(`SELECT id,status FROM jobs WHERE type='extract_source_experience' AND entity_id=?
        AND status IN ('queued','running') ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END,priority,created_at,id`).all(entity_id);
      const keep=rows[0]?.id;
      for (const row of rows.slice(1)) {
        if (row.status!=="queued") continue;
        superseded += this.db.prepare(`UPDATE jobs SET status='failed',completed_at=?,duration_ms=0,
          failure_class='',last_failure_code='DUPLICATE_EXPERIENCE_JOB',
          last_error='Superseded duplicate Experience backfill job; no model call was made.',
          next_eligible_at=NULL,updated_at=? WHERE id=? AND status='queued' AND id<>?`)
          .run(timestamp,timestamp,row.id,keep).changes;
      }
    }
    if (superseded) this.refreshExperienceBackfillRuns();
    return superseded;
  }

  refreshExperienceBackfillRuns() {
    const runs=this.db.prepare(`SELECT id,report_json FROM system_backfill_runs
      WHERE backfill_type='experience' AND status='queued'`).all();
    const timestamp=now();
    for (const run of runs) {
      const report=json(run.report_json,{}); const sourceIds=uniqueStrings(report.sourceIds,100_000);
      let succeeded=0; let active=0;
      for (let offset=0;offset<sourceIds.length;offset+=500) {
        const page=sourceIds.slice(offset,offset+500); const placeholders=page.map(() => "?").join(",");
        succeeded += Number(this.db.prepare(`SELECT COUNT(DISTINCT er.source_id) n FROM experience_extraction_runs er
          JOIN sources s ON s.id=er.source_id WHERE er.status='succeeded' AND er.capture_version=s.capture_version
          AND er.degraded=0 AND er.source_id IN (${placeholders})`).get(...page)?.n || 0);
        active += Number(this.db.prepare(`SELECT COUNT(*) n FROM jobs WHERE type='extract_source_experience'
          AND status IN ('queued','running') AND entity_id IN (${placeholders})`).get(...page)?.n || 0);
      }
      const failureCodes=[];
      for (let offset=0;offset<sourceIds.length;offset+=500) {
        const page=sourceIds.slice(offset,offset+500); const placeholders=page.map(() => "?").join(",");
        for (const row of this.db.prepare(`SELECT COALESCE(NULLIF(last_failure_code,''),'UNKNOWN') code,COUNT(*) count
          FROM jobs WHERE type='extract_source_experience' AND status='failed' AND entity_id IN (${placeholders})
          GROUP BY COALESCE(NULLIF(last_failure_code,''),'UNKNOWN')`).all(...page)) {
          const existing=failureCodes.find((item)=>item.code===row.code);
          if (existing) existing.count+=Number(row.count || 0);
          else failureCodes.push({code:row.code,count:Number(row.count || 0)});
        }
      }
      failureCodes.sort((a,b)=>b.count-a.count || a.code.localeCompare(b.code));
      const pending=Math.max(0,sourceIds.length-succeeded); const status=pending===0 ? "completed" : active===0 ? "failed" : "queued";
      this.db.prepare(`UPDATE system_backfill_runs SET status=?,report_json=?,completed_at=CASE WHEN ?<>'queued' THEN ? ELSE NULL END,updated_at=? WHERE id=?`)
        .run(status,JSON.stringify({...report,succeeded,pending,failed:status==="failed" ? pending : 0,failureCodes}),status,timestamp,timestamp,run.id);
    }
    return runs.length;
  }

  runRecommendationReconciliationBackfill({ dryRun = true, approvedFromRunId = null } = {}) {
    const destinations = this.db.prepare(`SELECT DISTINCT destination_slug FROM structured_sources
      WHERE destination_slug<>'' AND destination_slug<>'unknown' ORDER BY destination_slug`).all().map((row) => row.destination_slug);
    const diagnosticSources=this.db.prepare(`SELECT s.id,s.capture_version,
        (SELECT strategy_version FROM content_intake_analyses ai WHERE ai.source_id=s.id ORDER BY ai.updated_at DESC LIMIT 1) AS diagnostic_strategy
      FROM sources s WHERE s.completeness_status='complete' AND s.status IN ('processed','needs_ai')
        AND NOT EXISTS (SELECT 1 FROM current_source_assets a WHERE a.source_id=s.id AND a.durability_status<>'ORIGINAL_STORED')
        AND EXISTS (SELECT 1 FROM experience_extraction_runs er WHERE er.source_id=s.id AND er.status='succeeded'
          AND er.capture_version=s.capture_version AND er.degraded=0)
      ORDER BY s.captured_at,s.id`).all();
    const currentDiagnostics=diagnosticSources.filter((row)=>row.diagnostic_strategy===this.strategyVersion);
    const reusableDiagnostics=diagnosticSources.filter((row)=>row.diagnostic_strategy!==this.strategyVersion
      && isReusableDiagnosticStrategy(row.diagnostic_strategy,this.strategyVersion));
    const staleDiagnostics=diagnosticSources.filter((row)=>row.diagnostic_strategy!==this.strategyVersion
      && !isReusableDiagnosticStrategy(row.diagnostic_strategy,this.strategyVersion));
    const fingerprint=sha256(JSON.stringify({strategyVersion:this.strategyVersion,
      current:currentDiagnostics.map((row)=>[row.id,Number(row.capture_version||0)]),
      reusable:reusableDiagnostics.map((row)=>[row.id,Number(row.capture_version||0),row.diagnostic_strategy]),
      stale:staleDiagnostics.map((row)=>[row.id,Number(row.capture_version||0),row.diagnostic_strategy||""])}));
    const before = Number(this.db.prepare("SELECT COUNT(*) n FROM content_opportunities").get().n || 0);
    const sourceTotal=Number(this.db.prepare("SELECT COUNT(*) n FROM sources").get().n||0);
    const report = {destinations,diagnostics:Number(this.db.prepare("SELECT COUNT(*) n FROM content_intake_analyses").get().n || 0),
      currentDiagnosticSources:currentDiagnostics.length,reusableDiagnosticSources:reusableDiagnostics.length,
      staleDiagnosticSources:staleDiagnostics.length,modelCallsAvoided:dryRun ? reusableDiagnostics.length : 0,
      blockedDiagnosticSources:Math.max(0,sourceTotal-diagnosticSources.length),sourceIds:staleDiagnostics.map((row)=>row.id),
      reusableSourceIds:reusableDiagnostics.map((row)=>row.id),fingerprint,opportunitiesBefore:before,
      createdOrRefreshed:0,approvedReconciled:0,reused:0,queued:0};
    if (!dryRun) {
      const approval=this.db.prepare(`SELECT report_json FROM system_backfill_runs WHERE id=?
        AND backfill_type='recommendation_reconciliation' AND status='dry_run' AND dry_run=1`).get(approvedFromRunId);
      if (!approval) throw conflictError("Recommendation refresh requires the ID of a completed dry-run report.");
      const approved=json(approval.report_json,{});
      if (approved.fingerprint!==fingerprint) throw conflictError("Recommendation refresh inputs changed after dry-run; review a new dry-run report.");
      for (const row of reusableDiagnostics) {
        if (this.promoteCompatibleIntakeAnalysis(row.id,row.diagnostic_strategy)) {
          report.reused += 1;
          report.modelCallsAvoided += 1;
        }
      }
      for (const row of staleDiagnostics) {
        const jobId=this.enqueue("analyze_source_diagnostic",row.id,{
          dedupeKey:`recommendation-diagnostic:${row.id}:${row.capture_version}:${this.strategyVersion}`,
          workloadClass:"historical_recovery",priority:70,recoveryRunId:approvedFromRunId,
        });
        if (jobId) report.queued += 1;
      }
    }
    if (!dryRun) for (const destination of destinations) {
      this.rebuildTopicClusters(destination);
      const rebuilt = this.rebuildKnowledgeOpportunities(destination);
      report.createdOrRefreshed += rebuilt.created + rebuilt.refreshed;
      this.rebuildCoverageMatrices(destination);
      report.approvedReconciled += this.reconcileApprovedOpportunities(destination).filter((item) => item.queued).length;
    }
    report.opportunitiesAfter = dryRun ? before : Number(this.db.prepare("SELECT COUNT(*) n FROM content_opportunities").get().n || 0);
    return this.saveSystemBackfillRun("recommendation_reconciliation",dryRun,report,approvedFromRunId);
  }

  refreshRecommendationBackfillRuns() {
    const runs=this.db.prepare(`SELECT id,report_json FROM system_backfill_runs
      WHERE backfill_type='recommendation_reconciliation' AND status='queued'`).all();
    const timestamp=now();
    for (const run of runs) {
      const report=json(run.report_json,{}); const sourceIds=uniqueStrings(report.sourceIds,100_000);
      let current=0; let active=0; let failed=0;
      for (let offset=0;offset<sourceIds.length;offset+=500) {
        const page=sourceIds.slice(offset,offset+500); const placeholders=page.map(()=>"?").join(",");
        current += Number(this.db.prepare(`SELECT COUNT(*) n FROM content_intake_analyses
          WHERE strategy_version=? AND source_id IN (${placeholders})`).get(this.strategyVersion,...page)?.n||0);
        active += Number(this.db.prepare(`SELECT COUNT(*) n FROM jobs WHERE type='analyze_source_diagnostic'
          AND status IN ('queued','running') AND entity_id IN (${placeholders})`).get(...page)?.n||0);
        failed += Number(this.db.prepare(`SELECT COUNT(*) n FROM jobs WHERE type='analyze_source_diagnostic'
          AND status='failed' AND entity_id IN (${placeholders})`).get(...page)?.n||0);
      }
      const pending=Math.max(0,sourceIds.length-current);
      const status=pending===0 ? "completed" : active===0 ? "failed" : "queued";
      this.db.prepare(`UPDATE system_backfill_runs SET status=?,report_json=?,
        completed_at=CASE WHEN ?<>'queued' THEN ? ELSE NULL END,updated_at=? WHERE id=?`)
        .run(status,JSON.stringify({...report,current,pending,failed:status==="failed"?pending:0,failedJobCount:failed}),
          status,timestamp,timestamp,run.id);
    }
    return runs.length;
  }

  runFailedProductionCleanupBackfill({ dryRun = true, approvedFromRunId = null } = {}) {
    if (!dryRun) {
      const approval = this.db.prepare(`SELECT id,report_json FROM system_backfill_runs
        WHERE id=? AND backfill_type='failed_production_cleanup' AND status='dry_run'`).get(approvedFromRunId);
      if (!approval) throw conflictError("Failed-production cleanup requires the ID of a completed dry-run report.");
    }
    const rows = this.db.prepare(`SELECT ad.id AS draft_id,ad.status AS draft_status,ad.title,cb.id AS brief_id,tc.id AS candidate_id,
        o.id AS opportunity_id,o.status AS opportunity_status,o.lifecycle_state,
        wp.post_id AS wordpress_post_id,wp.status AS wordpress_status
      FROM article_drafts ad JOIN content_briefs cb ON cb.id=ad.brief_id JOIN topic_candidates tc ON tc.id=cb.candidate_id
      LEFT JOIN content_opportunities o ON o.id=tc.opportunity_id
      LEFT JOIN wordpress_publications wp ON wp.draft_id=ad.id
      WHERE ad.status IN ('exception','qa_failed') ORDER BY ad.updated_at,ad.id`).all();
    const items = rows.map((row) => ({...row,safe:Boolean(row.opportunity_id && !row.wordpress_post_id),
      disposition:row.wordpress_post_id ? "migration_review_published_record" : !row.opportunity_id ? "migration_review_missing_opportunity" : "rollback_to_recommended_again"}));
    const report = {scanned:items.length,safeToRollback:items.filter((item) => item.safe).length,
      migrationReview:items.filter((item) => !item.safe).length,rolledBack:0,items};
    if (!dryRun) for (const item of items.filter((entry) => entry.safe)) {
      const result = this.handleTerminalProductionFailure({id:`migration:${item.draft_id}`,type:"review_draft",entity_id:item.draft_id},
        Object.assign(new Error(`Historical ${item.draft_status} production artifact migrated after reviewed dry run.`),
          {code:"HISTORICAL_PRODUCTION_FAILURE",retryable:false}));
      if (result?.rolledBack) report.rolledBack += 1;
    }
    return this.saveSystemBackfillRun("failed_production_cleanup",dryRun,report,approvedFromRunId);
  }

  runKnowledgeResolutionBackfill({dryRun=true,approvedFromRunId=null}={}) {
    if(!dryRun){
      const approval=this.db.prepare(`SELECT report_json FROM system_backfill_runs
        WHERE id=? AND backfill_type='knowledge_resolution' AND status='dry_run' AND dry_run=1`).get(approvedFromRunId);
      if(!approval)throw conflictError("Knowledge resolution recompute requires the ID of a completed dry-run report.");
    }
    const reviewCases=this.db.prepare(`SELECT * FROM claim_review_cases WHERE status='pending' ORDER BY created_at,id`).all();
    const claimQuery=this.db.prepare(`SELECT c.*,s.authority_level AS source_authority_level,s.adapter AS source_adapter,
        s.source_identity,s.source_publisher,s.author_name AS source_author_name,s.captured_at,s.published_at,
        s.observed_at AS source_observed_at,s.verified_at AS source_verified_at,
        s.valid_from AS source_valid_from,s.valid_to AS source_valid_to,s.date_kind AS source_date_kind,
        s.date_confidence AS source_date_confidence,s.completeness_status AS source_completeness_status,
        ss.destination_slug
      FROM claims c JOIN sources s ON s.id=c.source_id LEFT JOIN structured_sources ss ON ss.source_id=c.source_id
      WHERE c.id=?`);
    const decisions=[];
    for(const review of reviewCases){
      const left=claimQuery.get(review.claim_a_id);
      const right=review.claim_b_id?claimQuery.get(review.claim_b_id):null;
      if(!left)continue;
      left.structured_value=structureClaim({predicate:left.predicate,value:left.value_text,
        qualifiers:json(left.qualifiers_json,[]),sourceQuote:left.source_quote});
      let resolution;
      if(!right){
        resolution={state:"REPAIR_REQUIRED",autoResolved:true,humanRequired:false,verificationRequired:false,repairRequired:true,
          reason:"The extraction issue is routed to a bounded Claim repair job instead of human conflict review."};
      }else{
        right.structured_value=structureClaim({predicate:right.predicate,value:right.value_text,
          qualifiers:json(right.qualifiers_json,[]),sourceQuote:right.source_quote});
        const comparison=classifyClaimPair(left,right);
        const consensus=resolveEvidenceConsensus([left,right],{variantKey:(row)=>canonicalKnowledgeVariant(row),
          nowMs:this.clock().getTime(),staleAfterDays:this.contentConfig.volatileStaleAfterDays});
        resolution=decideKnowledgeResolution({comparison,left,right,consensus,nowMs:this.clock().getTime()});
      }
      decisions.push({reviewId:review.id,destinationSlug:review.destination_slug,normalizedKey:left.normalized_key,
        claimAId:left.id,claimBId:right?.id||null,previousReviewType:review.review_type,...resolution});
    }
    const summary=summarizeResolutionDecisions(decisions);
    const report={engineVersion:KNOWLEDGE_RESOLUTION_VERSION,beforeManualReviewCount:reviewCases.length,
      evaluatedCount:decisions.length,...summary,
      autoEquivalent:summary.counts.AUTO_EQUIVALENT+summary.counts.AUTO_CONSENSUS,
      autoScopeSplit:summary.counts.AUTO_SCOPE_SPLIT,autoTemporal:summary.counts.AUTO_TEMPORAL,
      extractionRepair:summary.counts.AUTO_REPAIRED+summary.counts.REPAIR_REQUIRED,
      verificationNeeded:summary.counts.VERIFICATION_REQUIRED,humanRequired:summary.counts.HUMAN_REQUIRED,
      projectedManualReviewCount:summary.counts.HUMAN_REQUIRED,items:decisions};
    if(!dryRun){
      const destinations=[...new Set(reviewCases.map((row)=>row.destination_slug).filter(Boolean))];
      for(const destination of destinations)this.rebuildKnowledge(destination);
      report.recomputedDestinations=destinations.length;
    }
    return this.saveSystemBackfillRun("knowledge_resolution",dryRun,report,approvedFromRunId);
  }

  runSourceProcessingGapRecovery({dryRun=true,approvedFromRunId=null}={}) {
    const sources=this.db.prepare(`SELECT s.id,s.status,s.capture_version,s.title,s.completeness_status,
        json_extract(s.submission_metadata_json,'$.processingEstimate.requiresManualStart') AS legacy_manual_start,
        json_extract(s.submission_metadata_json,'$.processingEstimate.processingClass') AS processing_class,
        json_extract(s.submission_metadata_json,'$.processingEstimate.blockReasons') AS hard_limit_reasons,
        (SELECT COUNT(*) FROM current_source_assets a WHERE a.source_id=s.id) AS media_count,
        (SELECT COUNT(*) FROM current_source_assets a WHERE a.source_id=s.id AND a.durability_status='ORIGINAL_STORED') AS stored_media_count,
        (SELECT COUNT(*) FROM current_source_segments sg WHERE sg.source_id=s.id) AS segment_count,
        (SELECT COUNT(*) FROM segment_extractions se JOIN current_source_segments sg ON sg.id=se.segment_id WHERE sg.source_id=s.id) AS extraction_count,
        (SELECT COUNT(*) FROM current_extraction_coverage ec WHERE ec.source_id=s.id AND ec.audited_at IS NOT NULL) AS coverage_count,
        EXISTS(SELECT 1 FROM structured_sources ss WHERE ss.source_id=s.id) AS has_structured
      FROM sources s
      ORDER BY s.captured_at,s.id`).all();
    const items=[];
    for(const source of sources){
      const segments=this.db.prepare("SELECT id FROM current_source_segments WHERE source_id=? ORDER BY sequence").all(source.id);
      const missingExtractions=segments.filter((segment)=>!this.db.prepare("SELECT 1 FROM segment_extractions WHERE segment_id=?").get(segment.id));
      const missingCoverage=segments.filter((segment)=>!missingExtractions.some((item)=>item.id===segment.id)
        &&!this.db.prepare("SELECT 1 FROM current_extraction_coverage WHERE segment_id=? AND audited_at IS NOT NULL").get(segment.id));
      const currentExperience=this.db.prepare("SELECT 1 FROM experience_extraction_runs WHERE source_id=? AND capture_version=? AND status='succeeded'")
        .get(source.id,source.capture_version);
      const actions=[];
      let category="COMPLETE";
      const hardBlocked=source.processing_class==="blocked_hard_limit";
      const activeJobs=this.db.prepare(`SELECT j.id,j.type,j.status,j.workload_class FROM jobs j
        LEFT JOIN current_source_segments sg ON sg.id=j.entity_id LEFT JOIN media_extraction_batches mb ON mb.id=j.entity_id
        WHERE (j.entity_id=? OR sg.source_id=? OR mb.source_id=?) AND j.status IN ('queued','running') ORDER BY j.created_at`).all(source.id,source.id,source.id);
      if(source.completeness_status!=="complete")category="CAPTURE_INCOMPLETE";
      else if(hardBlocked)category="BLOCKED_HARD_LIMIT";
      else if(Number(source.stored_media_count)<Number(source.media_count))category="MEDIA_NOT_DURABLE";
      else if(activeJobs.length)category="ACTIVE_PIPELINE";
      else if(!segments.length){actions.push({stage:"preflight_source",entityId:source.id});category=source.legacy_manual_start?"NO_JOB_LEGACY_GATE":"MISSING_SEGMENTS";}
      else if(missingExtractions.length)actions.push(...missingExtractions.map((segment)=>({stage:"extract_segment_claims",entityId:segment.id})));
      else if(missingCoverage.length)actions.push(...missingCoverage.map((segment)=>({stage:"audit_segment_coverage",entityId:segment.id})));
      else if(source.status==="processing")actions.push({stage:"finalize_source_extraction",entityId:source.id});
      else if(!currentExperience&&source.has_structured)actions.push({stage:"extract_source_experience",entityId:source.id});
      if(category==="COMPLETE"&&actions.length)category=missingExtractions.length?"MISSING_EXTRACTION"
        :missingCoverage.length?"MISSING_COVERAGE":source.status==="processing"?"MISSING_FINALIZATION":"MISSING_EXPERIENCE";
      if(category!=="COMPLETE")items.push({sourceId:source.id,captureVersion:source.capture_version,title:source.title,category,
        legacyManualStart:Boolean(source.legacy_manual_start),processingClass:source.processing_class||"legacy_unknown",
        hardLimitReasons:json(source.hard_limit_reasons,[]),media:{discovered:Number(source.media_count),stored:Number(source.stored_media_count)},
        segments:{total:Number(source.segment_count),extracted:Number(source.extraction_count),audited:Number(source.coverage_count)},
        experienceCurrent:Boolean(currentExperience),activeJobs,actions});
    }
    const fingerprint=sha256(JSON.stringify(items.map((item)=>({sourceId:item.sourceId,captureVersion:item.captureVersion,actions:item.actions}))));
    const timestamp=now(),runId=id("processing_gap_run");
    const actionableCount=items.reduce((sum,item)=>sum+item.actions.length,0);
    if(!dryRun){
      const approval=this.db.prepare("SELECT report_json FROM source_processing_gap_runs WHERE id=? AND status='dry_run' AND dry_run=1").get(approvedFromRunId);
      if(!approval)throw conflictError("Processing-gap recovery requires the ID of a completed dry-run report.");
      if(json(approval.report_json,{}).fingerprint!==fingerprint)throw conflictError("Processing-gap candidates changed after the dry run; generate and review a new report.");
      for(const item of items)for(const action of item.actions)this.enqueue(action.stage,action.entityId,{
        dedupeKey:`processing-gap:${item.captureVersion}:${action.stage}:${action.entityId}`,
        priority:70,executionRoute:action.stage==="extract_segment_claims"?"batch":"auto",
        workloadClass:"historical_recovery",recoveryRunId:runId});
    }
    const report={fingerprint,scannedSourceCount:sources.length,sourceCount:items.filter((item)=>item.actions.length).length,
      gapCount:items.length,actionCount:actionableCount,
      legacyManualStartCount:items.filter((item)=>item.category==="NO_JOB_LEGACY_GATE").length,
      noActiveJobCount:items.filter((item)=>!item.activeJobs.length&&item.actions.length).length,
      hardLimitBlockedCount:items.filter((item)=>item.category==="BLOCKED_HARD_LIMIT").length,
      categoryCounts:Object.fromEntries([...Map.groupBy(items,(item)=>item.category)].map(([category,rows])=>[category,rows.length])),items};
    this.db.prepare(`INSERT INTO source_processing_gap_runs(id,status,dry_run,approved_from_run_id,report_json,started_at,completed_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(runId,dryRun?"dry_run":actionableCount?"queued":"completed",dryRun?1:0,approvedFromRunId,
        JSON.stringify(report),timestamp,dryRun||!actionableCount?timestamp:null,timestamp,timestamp);
    return {id:runId,dryRun,queued:!dryRun&&actionableCount>0,...report};
  }

  createLegacySourceRecoveryManifest({execute=false}={}){
    const existing=this.db.prepare(`SELECT * FROM source_recovery_manifests
      WHERE reason='legacy_manual_start_gate' ORDER BY created_at ASC LIMIT 1`).get();
    if(existing){
      const stored=json(existing.report_json,{});
      if(!execute||existing.status!=="dry_run")return {id:existing.id,dryRun:existing.status==="dry_run",
        sourceCount:Number(stored.sourceCount||0),fingerprint:stored.fingerprint||null,processingGapRunId:stored.processingGapRunId||null};
      const recovery=this.runSourceProcessingGapRecovery({dryRun:false,approvedFromRunId:stored.processingGapRunId});
      this.db.prepare("UPDATE source_recovery_manifests SET status=?,executed_at=? WHERE id=?")
        .run(recovery.queued?"queued":"completed",now(),existing.id);
      return {id:existing.id,dryRun:false,sourceCount:Number(stored.sourceCount||0),fingerprint:stored.fingerprint||null,
        processingGapRunId:stored.processingGapRunId||null,recoveryRunId:recovery.id};
    }
    const report=this.runSourceProcessingGapRecovery({dryRun:true});
    const legacyItems=report.items.filter((item)=>item.category==="NO_JOB_LEGACY_GATE");
    const manifestId=`source_recovery_manifest_${sha256(`v1:${report.fingerprint}`).slice(0,24)}`;
    const timestamp=now();
    this.db.prepare(`INSERT OR IGNORE INTO source_recovery_manifests(id,reason,status,report_json,created_at,executed_at)
      VALUES (?,'legacy_manual_start_gate',?,?,?,?)`).run(manifestId,execute?'queued':'dry_run',JSON.stringify({
        processingGapRunId:report.id,fingerprint:report.fingerprint,sourceCount:legacyItems.length,items:legacyItems}),timestamp,execute?timestamp:null);
    if(execute&&legacyItems.length)this.runSourceProcessingGapRecovery({dryRun:false,approvedFromRunId:report.id});
    return {id:manifestId,dryRun:!execute,sourceCount:legacyItems.length,fingerprint:report.fingerprint};
  }

  runMediaStorageMigrationEstimate({dryRun=true}={}) {
    if(!dryRun)throw conflictError("Media storage migration execution is intentionally disabled in the online process; review the dry run and use the documented offline verified-copy procedure.");
    const fields=[
      ["sources","raw_payload_json"],["capture_versions","raw_payload_json"],["capture_versions","assets_json"],
      ["source_assets","ai_derivative_data_url"],
    ].map(([table,column])=>({table,column,...this.db.prepare(
      `SELECT COUNT(*) AS rows_with_base64,COALESCE(SUM(length(${column})),0) AS encoded_chars FROM ${table} WHERE ${column} LIKE '%;base64,%'`
    ).get()}));
    const assetSummary=this.db.prepare(`SELECT COUNT(*) AS asset_rows,COUNT(DISTINCT NULLIF(stored_sha256,'')) AS stored_hashes,
        COUNT(DISTINCT NULLIF(local_path,'')) AS local_paths,
        SUM(CASE WHEN ai_derivative_data_url LIKE '%;base64,%' THEN 1 ELSE 0 END) AS derivative_base64_rows
      FROM source_assets`).get();
    const storageRefs=this.db.prepare("SELECT COUNT(*) AS count FROM source_asset_storage_refs").get().count;
    const report={fields,assetSummary,storageRefs:Number(storageRefs||0),
      encodedChars:fields.reduce((sum,item)=>sum+Number(item.encoded_chars||0),0)};
    report.estimatedDecodedBytes=Math.floor(report.encodedChars*0.75);
    report.policy={mode:"dry_run_only",copyOrder:["write content-addressed file","fsync and hash verify","write side-table reference","verify reader","remove one legacy field in a later approved transaction"],
      automaticDeletion:false};
    const timestamp=now(),runId=id("media_storage_run");
    this.db.prepare("INSERT INTO media_storage_migration_runs(id,status,dry_run,approved_from_run_id,report_json,created_at,completed_at) VALUES (?,'dry_run',1,NULL,?,?,?)")
      .run(runId,JSON.stringify(report),timestamp,timestamp);
    return {id:runId,dryRun:true,...report};
  }

  saveSystemBackfillRun(backfillType,dryRun,report,approvedFromRunId = null) {
    const timestamp=now(); const runId=id("backfill");
    const queued=!dryRun && ["experience","recommendation_reconciliation"].includes(backfillType)
      && Number(report.queued || 0)>0;
    this.db.prepare(`INSERT INTO system_backfill_runs(id,backfill_type,status,dry_run,approved_from_run_id,report_json,
      started_at,completed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(runId,backfillType,dryRun ? "dry_run" : queued ? "queued" : "completed",dryRun ? 1 : 0,approvedFromRunId,
        JSON.stringify(report),timestamp,queued ? null : timestamp,timestamp,timestamp);
    return {id:runId,type:backfillType,dryRun,...report};
  }

  listSystemBackfillRuns(limit = 50) {
    return this.db.prepare("SELECT * FROM system_backfill_runs ORDER BY created_at DESC LIMIT ?")
      .all(Math.max(1,Math.min(200,Number(limit)||50))).map((row) => ({...row,dryRun:Boolean(row.dry_run),report:json(row.report_json,{})}));
  }

  getExperienceExtractionPackage(sourceId) {
    const source = this.getSource(sourceId);
    if (!source?.structured || !["processed","needs_ai"].includes(source.status)) return null;
    const activeExtraction = this.db.prepare(`SELECT id FROM extraction_runs WHERE source_id=? AND status='active'
      ORDER BY revision DESC LIMIT 1`).get(sourceId);
    const packageValue = {
      source: { id: source.id, title: source.title,
        capture_version: source.capture_version, destination: source.structured.destination_name,
        summary: source.structured.summary },
      segments: source.segments.map((segment) => ({ id: segment.id, sequence: segment.sequence, type: segment.segment_type,
        title: segment.title, text_excerpt: String(segment.raw_text || "").slice(0, 600), asset_id: segment.asset_id })),
      claims: source.claims.map((claim) => ({ id: claim.id, subject: claim.subject, predicate: claim.predicate,
        value: claim.value_text, qualifiers: claim.qualifiers, role: claim.claim_role,
        source_quote: claim.source_quote, evidence_span_ids: claim.evidence_span_ids })),
      evidence_spans: this.db.prepare(`SELECT id,segment_id,asset_id,locator_type,quote,start_offset,end_offset
        FROM current_evidence_spans WHERE source_id=? ORDER BY id`).all(sourceId),
      media: source.assets.map((asset) => ({ id: asset.id,kind:asset.kind,position:asset.position,
        durability_status:asset.durability_status,ai_readability_status:asset.ai_readability_status,
        alt_text:asset.alt_text,nearby_text:asset.nearby_text,caption_text:asset.caption_text })),
      blueprint: source.blueprint || null,
    };
    return { ...packageValue, extraction_run_id: activeExtraction?.id || null,
      input_hash: sha256(JSON.stringify(packageValue)), degraded: source.assets.some((asset) => asset.durability_status !== "ORIGINAL_STORED") };
  }

  saveExperienceExtraction(sourceId, extraction, model = null, packageValue = null) {
    const input = packageValue || this.getExperienceExtractionPackage(sourceId);
    if (!input) throw new Error(`Source ${sourceId} is not ready for Experience extraction.`);
    const existing = this.db.prepare(`SELECT * FROM experience_extraction_runs WHERE source_id=? AND input_hash=?`).get(sourceId, input.input_hash);
    if (existing?.status === "succeeded") {
      this.refreshExperienceBackfillRuns();
      return { runId: existing.id, reused: true, blocks: this.listExperienceBlocks(sourceId) };
    }
    const timestamp = now();
    const runId = existing?.id || id("experience_run");
    const validSegments = new Set(input.segments.map((item) => item.id));
    const validClaims = new Set(input.claims.map((item) => item.id));
    const validSpans = new Set(input.evidence_spans.map((item) => item.id));
    const blocks = (Array.isArray(extraction?.blocks) ? extraction.blocks : []).map((block) => ({
      type: normalizeExperienceType(block?.type), title: String(block?.title || "Travel experience").slice(0, 300),
      traveler_goal: String(block?.traveler_goal || "").slice(0, 500),
      segment_ids: uniqueStrings(block?.segment_ids).filter((value) => validSegments.has(value)),
      sequence: cleanExperienceItems(block?.sequence), decision_logic: cleanExperienceItems(block?.decision_logic),
      conditions: cleanExperienceItems(block?.conditions), tradeoffs: cleanExperienceItems(block?.tradeoffs),
      warnings: cleanExperienceItems(block?.warnings), alternatives: cleanExperienceItems(block?.alternatives),
      supporting_claim_ids: uniqueStrings(block?.supporting_claim_ids).filter((value) => validClaims.has(value)),
      evidence_span_ids: uniqueStrings(block?.evidence_span_ids).filter((value) => validSpans.has(value)),
      confidence: Math.max(0, Math.min(1, Number(block?.confidence || 0))),
    })).filter((block) => block.segment_ids.length && (block.supporting_claim_ids.length || block.evidence_span_ids.length)).slice(0,20);
    transaction(this.db, () => {
      this.db.prepare(`UPDATE experience_extraction_runs SET status='superseded',updated_at=?
        WHERE source_id=? AND status='succeeded' AND input_hash<>?`).run(timestamp, sourceId, input.input_hash);
      this.db.prepare(`INSERT INTO experience_extraction_runs(id,source_id,extraction_run_id,capture_version,input_hash,status,degraded,model,error,created_at,updated_at)
        VALUES (?,?,?,?,?,'succeeded',?,?,NULL,?,?) ON CONFLICT(source_id,input_hash) DO UPDATE SET status='succeeded',
        degraded=excluded.degraded,model=excluded.model,error=NULL,updated_at=excluded.updated_at`)
        .run(runId,sourceId,input.extraction_run_id,input.source.capture_version,input.input_hash,input.degraded?1:0,model,timestamp,timestamp);
      this.db.prepare("DELETE FROM experience_blocks WHERE extraction_run_id=?").run(runId);
      const insert = this.db.prepare(`INSERT INTO experience_blocks(id,source_id,extraction_run_id,segment_ids_json,type,title,traveler_goal,
        sequence_json,decision_logic_json,conditions_json,tradeoffs_json,warnings_json,alternatives_json,supporting_claim_ids_json,
        evidence_span_ids_json,confidence,grounding_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const block of blocks) insert.run(id("experience"),sourceId,runId,JSON.stringify(block.segment_ids),block.type,block.title,
        block.traveler_goal,JSON.stringify(block.sequence),JSON.stringify(block.decision_logic),JSON.stringify(block.conditions),
        JSON.stringify(block.tradeoffs),JSON.stringify(block.warnings),JSON.stringify(block.alternatives),
        JSON.stringify(block.supporting_claim_ids),JSON.stringify(block.evidence_span_ids),block.confidence,
        input.degraded ? "degraded" : "grounded",timestamp,timestamp);
    });
    this.refreshExperienceBackfillRuns();
    return { runId, reused: false, blocks: this.listExperienceBlocks(sourceId) };
  }

  listExperienceBlocks(sourceId = null) {
    const rows = sourceId ? this.db.prepare(`SELECT eb.* FROM experience_blocks eb JOIN experience_extraction_runs er ON er.id=eb.extraction_run_id
      WHERE eb.source_id=? AND er.status='succeeded' ORDER BY eb.created_at,eb.id`).all(sourceId)
      : this.db.prepare(`SELECT eb.* FROM experience_blocks eb JOIN experience_extraction_runs er ON er.id=eb.extraction_run_id
        WHERE er.status='succeeded' ORDER BY eb.updated_at DESC`).all();
    return rows.map(hydrateExperienceBlock);
  }

  recordFavoritesSyncRun(input = {}) {
    const sessionId = String(input.sessionId || "").trim();
    if (!/^[A-Za-z0-9-]{8,80}$/.test(sessionId)) throw Object.assign(new Error("A valid Favorites Sync session ID is required."), { statusCode: 400 });
    const requestedMode = ["incremental","repair","full"].includes(input.mode) ? input.mode : "incremental";
    const mode = requestedMode === "repair" ? "full" : requestedMode;
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
      started_at,completed_at,duration_ms,extension_version,last_error_json,created_at,updated_at,sync_mode_v2)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET scope_key=excluded.scope_key,scope_url=excluded.scope_url,
        scope_label=excluded.scope_label,mode=excluded.mode,status=excluded.status,stats_json=excluded.stats_json,
        started_at=excluded.started_at,completed_at=excluded.completed_at,duration_ms=excluded.duration_ms,
        extension_version=excluded.extension_version,last_error_json=excluded.last_error_json,updated_at=excluded.updated_at,
        sync_mode_v2=excluded.sync_mode_v2`)
      .run(sessionId, String(input.scopeKey || "").slice(0, 2_000), String(input.scopeUrl || "").slice(0, 4_000),
        String(input.scopeLabel || "").slice(0, 500), mode, String(input.status || "unknown").slice(0, 100),
        JSON.stringify(stats), startedAt, completedAt,
        durationMs, String(input.extensionVersion || "").slice(0, 50),
        JSON.stringify(input.lastError && typeof input.lastError === "object" ? input.lastError : {}), timestamp, timestamp, requestedMode);
    const row = this.db.prepare("SELECT * FROM favorites_sync_runs WHERE session_id=?").get(sessionId);
    return { ...row, mode:row.sync_mode_v2 || row.mode, stats: json(row.stats_json, {}), lastError: json(row.last_error_json, {}) };
  }

  listFavoritesSyncRuns(limit = 20) {
    return this.db.prepare("SELECT * FROM favorites_sync_runs ORDER BY updated_at DESC LIMIT ?").all(Math.max(1, Math.min(100, Number(limit) || 20)))
      .map((row) => ({ ...row, mode:row.sync_mode_v2 || row.mode, stats: json(row.stats_json, {}), lastError: json(row.last_error_json, {}) }));
  }

  enqueue(type, entityId, { dedupeKey = `${type}:${entityId}`, priority = jobPriority(type), productionAttemptId = null,
    executionRoute = 'auto', workloadClass = "", parentJobId = null, recoveryRunId = null, interactive = false } = {}) {
    const timestamp = this.jobTimestamp();
    const resolvedWorkloadClass = workloadClassForJob(type, workloadClass);
    const active = this.db.prepare(`
      SELECT id,status FROM jobs WHERE dedupe_key = ? AND status IN ('queued', 'running') LIMIT 1
    `).get(dedupeKey);
    if (active) {
      if (active.status === 'running' && ['resolve_entities','rebuild_knowledge','rebuild_topic_clusters','build_coverage_matrix',
        'rebuild_content_opportunities','reconcile_approved_opportunities','rebuild_editorial'].includes(type)) {
        this.db.prepare('UPDATE jobs SET dirty_revision=dirty_revision+1 WHERE id=?').run(active.id);
      }
      return active.id;
    }
    const jobId = id("job");
    try {
      this.db.prepare(`
        INSERT INTO jobs(id, type, entity_id, available_at, created_at, updated_at, dedupe_key,priority,production_attempt_id,execution_route,
          workload_class,parent_job_id,recovery_run_id,interactive)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(jobId, type, entityId, timestamp, timestamp, timestamp, dedupeKey, priority, productionAttemptId, executionRoute,
        resolvedWorkloadClass,parentJobId,recoveryRunId,interactive ? 1 : 0);
      return jobId;
    } catch (error) {
      const raced = this.db.prepare("SELECT id FROM jobs WHERE dedupe_key=? AND status IN ('queued','running') LIMIT 1").get(dedupeKey);
      if (raced) return raced.id;
      throw error;
    }
  }

  recoverPreparingVertexBatches() {
    const runs = this.db.prepare(`SELECT id FROM vertex_batch_runs WHERE status='preparing'
      AND preparation_lease_expires_at IS NOT NULL AND preparation_lease_expires_at<=?`).all(this.jobTimestamp());
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
    if (type === "audit_segment_coverage" && this.contentConfig.coverageAiRoutingEnabled !== true) return 0;
    return Number(this.db.prepare(`SELECT COUNT(*) AS count FROM jobs j
      JOIN source_segments ss ON ss.id=j.entity_id
      WHERE j.type=? AND j.status='queued' AND j.available_at<=? AND COALESCE(j.next_eligible_at,j.available_at)<=?
        AND j.execution_route IN ('auto','batch')
        AND ((j.type='extract_segment_claims' AND ss.segment_type<>'video_chapter')
          OR (j.type='audit_segment_coverage' AND ss.asset_id IS NULL))
        AND NOT EXISTS (
          SELECT 1 FROM vertex_batch_items vbi JOIN vertex_batch_runs vbr ON vbr.id=vbi.run_id
          WHERE vbi.job_id=j.id AND vbr.status IN ('preparing','submitted')
        )`).get(type, this.jobTimestamp(), this.jobTimestamp())?.count || 0);
  }

  nextVertexBatchJobType(minimum = 20) {
    const candidates = ["extract_segment_claims", "audit_segment_coverage"]
      .filter((type) => this.countVertexBatchEligibleJobs(type) >= Math.max(1, Number(minimum || 20)))
      .map((type) => ({ type, oldest: this.db.prepare(`SELECT MIN(j.created_at) AS oldest FROM jobs j
        JOIN source_segments ss ON ss.id=j.entity_id WHERE j.type=? AND j.status='queued'
          AND j.available_at<=? AND COALESCE(j.next_eligible_at,j.available_at)<=? AND j.execution_route IN ('auto','batch')
          AND ((j.type='extract_segment_claims' AND ss.segment_type<>'video_chapter')
            OR (j.type='audit_segment_coverage' AND ss.asset_id IS NULL))`).get(type, this.jobTimestamp(), this.jobTimestamp())?.oldest || "" }));
    candidates.sort((a, b) => String(a.oldest).localeCompare(String(b.oldest))
      || (a.type === "audit_segment_coverage" ? -1 : 1));
    return candidates[0]?.type || null;
  }

  reserveVertexBatchJobs({ minimum = 20, maximum = 1_000, type = '', provider = 'vertex', model = '', location = 'global',
    projectId = '', schemaHash = '', promptHash = '', configVersion = 'legacy', configDigest = '' } = {}) {
    return transaction(this.db, () => {
      if (this.db.prepare("SELECT 1 FROM vertex_batch_runs WHERE status IN ('preparing','submitted') LIMIT 1").get()) return null;
      const timestamp = this.jobTimestamp();
      const minimumCount = Math.max(1, Number(minimum || 20));
      const requestedTypes = ["extract_segment_claims", "audit_segment_coverage"].includes(type)
        ? [type] : ["extract_segment_claims", "audit_segment_coverage"];
      const jobType = requestedTypes
        .find((value) => this.countVertexBatchEligibleJobs(value) >= minimumCount);
      if (!jobType) return null;
      const rows = this.db.prepare(`SELECT j.* FROM jobs j
        JOIN source_segments ss ON ss.id=j.entity_id
        WHERE j.type=? AND j.status='queued' AND j.available_at<=? AND COALESCE(j.next_eligible_at,j.available_at)<=?
          AND j.execution_route IN ('auto','batch')
          AND ((j.type='extract_segment_claims' AND ss.segment_type<>'video_chapter')
            OR (j.type='audit_segment_coverage' AND ss.asset_id IS NULL))
          AND NOT EXISTS (
            SELECT 1 FROM vertex_batch_items vbi JOIN vertex_batch_runs vbr ON vbr.id=vbi.run_id
            WHERE vbi.job_id=j.id AND vbr.status IN ('preparing','submitted')
          )
        ORDER BY j.created_at ASC LIMIT ?`).all(jobType, timestamp, timestamp, Math.max(1, Number(maximum || 1_000)));
      if (rows.length < minimumCount) return null;
      const runId = id("vertex_batch");
      this.db.prepare(`INSERT INTO vertex_batch_runs(id,provider,model,location,project_id,schema_hash,prompt_hash,config_version,config_digest,
        status,next_poll_at,preparation_owner,preparation_generation,preparation_lease_expires_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,'preparing',?,?,1,?,?,?)`)
        .run(runId, provider, model, location, projectId, schemaHash, promptHash, configVersion, configDigest,
          timestamp, this.workerId, this.jobLeaseExpiry(), timestamp, timestamp);
      const addItem = this.db.prepare(`INSERT INTO vertex_batch_items(run_id,job_id,segment_id,batch_item_id,transport_key,status)
        VALUES (?,?,?,?,?, 'preparing')`);
      for (const row of rows) {
        const batchItemId = `batch_item_${sha256(`${runId}:${row.id}`).slice(0, 24)}`;
        addItem.run(runId, row.id, row.entity_id, batchItemId, batchItemId);
      }
      return { id: runId, provider, model, location, project_id: projectId, schema_hash: schemaHash, prompt_hash: promptHash,
        config_version: configVersion, config_digest: configDigest, preparation_owner: this.workerId,
        preparation_generation: 1, preparation_lease_expires_at: this.jobLeaseExpiry(), status: 'preparing', jobType, items: rows.map((row) => ({
        ...row, segment_id: row.entity_id,
        batch_item_id: `batch_item_${sha256(`${runId}:${row.id}`).slice(0, 24)}`,
      })) };
    });
  }

  recordVertexBatchItemInput(runId, jobId, manifest, preparedRequest = null) {
    const normalized = normalizeExtractionInputManifest(manifest);
    const transportKey = String(preparedRequest?.transportKey || preparedRequest?.id || "").slice(0, 200);
    const requestFingerprint = preparedRequest?.request ? sha256(JSON.stringify(preparedRequest.request)) : "";
    if (!normalized.version && !transportKey && !requestFingerprint) return false;
    return this.db.prepare(`UPDATE vertex_batch_items SET input_modality=?,input_manifest_json=?,transport_key=?,request_fingerprint=?
      WHERE run_id=? AND job_id=? AND status='preparing'`)
      .run(normalized.receivedModality, JSON.stringify(normalized), transportKey, requestFingerprint, runId, jobId).changes === 1;
  }

  activateVertexBatch(runId, batch, lease = null) {
    const timestamp = this.jobTimestamp();
    return transaction(this.db, () => {
      const owner = lease?.preparation_owner || lease?.preparationOwner || this.workerId;
      const generation = Number(lease?.preparation_generation || lease?.preparationGeneration || 1);
      const live = this.db.prepare(`SELECT 1 FROM vertex_batch_runs WHERE id=? AND status='preparing'
        AND preparation_owner=? AND preparation_generation=? AND preparation_lease_expires_at>?`)
        .get(runId, owner, generation, timestamp);
      if (!live) return false;
      const submittedIds = new Set(batch.itemIds || []);
      const items = this.db.prepare("SELECT * FROM vertex_batch_items WHERE run_id=? AND status='preparing'").all(runId);
      for (const item of items) {
        if (submittedIds.has(item.batch_item_id)) {
          this.db.prepare("UPDATE vertex_batch_items SET status='submitted',last_error='' WHERE run_id=? AND job_id=?")
            .run(runId, item.job_id);
          this.db.prepare(`UPDATE jobs SET attempts=attempts+1,batch_attempts=batch_attempts+1,
            failure_class='',last_failure_code='',next_eligible_at=NULL,started_at=COALESCE(started_at,?),
            queue_latency_ms=COALESCE(queue_latency_ms,?),updated_at=? WHERE id=? AND status='queued'`)
            .run(timestamp, Math.max(0, Date.parse(timestamp) - Date.parse(this.db.prepare("SELECT created_at FROM jobs WHERE id=?").get(item.job_id)?.created_at || timestamp)), timestamp, item.job_id);
        } else {
          this.db.prepare("UPDATE vertex_batch_items SET status='failed',last_error=?,completed_at=? WHERE run_id=? AND job_id=?")
            .run("This item could not be prepared for Vertex Batch; returned to the realtime queue.", timestamp, runId, item.job_id);
          this.db.prepare(`UPDATE jobs SET execution_route='realtime',failure_class='batch_incompatible',
            last_failure_code='VERTEX_BATCH_ITEM_NOT_SUBMITTED',available_at=?,next_eligible_at=?,last_error=?,updated_at=?
            WHERE id=? AND status='queued'`).run(timestamp, timestamp,
              "Vertex accepted the Batch job without this item; it will run through the realtime route.", timestamp, item.job_id);
        }
      }
      this.db.prepare(`UPDATE vertex_batch_runs SET provider_job_name=?,input_uri=?,output_uri_prefix=?,status='submitted',
        provider_state=?,submitted_count=?,next_poll_at=?,preparation_lease_expires_at=NULL,updated_at=?
        WHERE id=? AND status='preparing' AND preparation_owner=? AND preparation_generation=?`)
        .run(batch.name, batch.inputUri, batch.outputUriPrefix, batch.state || 'JOB_STATE_PENDING', submittedIds.size,
          new Date(this.clock().getTime() + Number(batch.pollMs || 60_000)).toISOString(), timestamp, runId, owner, generation);
      return true;
    });
  }

  heartbeatVertexBatchPreparation(run) {
    const timestamp = this.jobTimestamp();
    return this.db.prepare(`UPDATE vertex_batch_runs SET preparation_lease_expires_at=?,updated_at=?
      WHERE id=? AND status='preparing' AND preparation_owner=? AND preparation_generation=?`)
      .run(this.jobLeaseExpiry(), timestamp, run.id, run.preparation_owner || this.workerId,
        Number(run.preparation_generation || 1)).changes === 1;
  }

  dueVertexBatch() {
    const cleanup = this.db.prepare(`SELECT * FROM vertex_batch_runs WHERE status='succeeded' AND result_state='ready_cleanup'
      AND cleanup_eligible_at IS NOT NULL AND cleanup_eligible_at<=? ORDER BY completed_at LIMIT 1`).get(this.jobTimestamp());
    if (cleanup) return { ...cleanup, cleanupOnly: true, items: [] };
    const run = this.db.prepare(`SELECT * FROM vertex_batch_runs WHERE status='submitted' AND next_poll_at<=?
      ORDER BY created_at LIMIT 1`).get(this.jobTimestamp());
    if (!run) return null;
    return { ...run, items: this.db.prepare(`SELECT vbi.*,j.type AS job_type FROM vertex_batch_items vbi
      JOIN jobs j ON j.id=vbi.job_id WHERE vbi.run_id=? AND vbi.status='submitted' ORDER BY vbi.rowid`).all(run.id) };
  }

  deferVertexBatchPoll(runId, providerState, delayMs = 60_000, error = null) {
    const timestamp = this.jobTimestamp();
    const message = String(error?.message || error || '').slice(0, 4_000);
    this.db.prepare(`UPDATE vertex_batch_runs SET provider_state=?,next_poll_at=?,
      last_error=CASE WHEN ?<>'' THEN ? ELSE last_error END,updated_at=? WHERE id=? AND status='submitted'`)
      .run(providerState || '', new Date(this.clock().getTime() + delayMs).toISOString(), message, message, timestamp, runId);
  }

  deferVertexBatchOutputRead(runId, providerState, error, delayMs = 60_000, attemptIncrement = 1) {
    const timestamp = this.jobTimestamp();
    this.db.prepare(`UPDATE vertex_batch_runs SET provider_state=?,result_state='reading',
      output_read_attempts=output_read_attempts+?,last_output_error=?,next_poll_at=?,updated_at=?
      WHERE id=? AND status='submitted'`)
      .run(providerState || "OUTPUT_READ_FAILED", Math.max(0, Number(attemptIncrement || 0)),
        String(error?.message || error || "Batch output read failed").slice(0, 4_000),
        new Date(this.clock().getTime() + delayMs).toISOString(), timestamp, runId);
    return this.db.prepare("SELECT * FROM vertex_batch_runs WHERE id=?").get(runId);
  }

  beginVertexBatchIngestion(runId, providerState, outputChecksum = "") {
    const timestamp = this.jobTimestamp();
    this.db.prepare(`UPDATE vertex_batch_runs SET provider_state=?,result_state='ingesting',
      output_read_attempts=output_read_attempts+1,output_checksum=?,last_output_error='',updated_at=?
      WHERE id=? AND status='submitted'`)
      .run(providerState || "", String(outputChecksum || "").slice(0, 200), timestamp, runId);
    return this.db.prepare("SELECT * FROM vertex_batch_runs WHERE id=?").get(runId);
  }

  completeVertexBatchItem(run, item, extraction, transport = {}) {
    const timestamp = this.jobTimestamp();
    let saved = false;
    transaction(this.db, () => {
      saved = this.saveSegmentExtraction(item.segment_id, extraction, { withinTransaction: true });
      if (!saved) return;
      const job = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(item.job_id);
      this.enqueue("audit_segment_coverage", item.segment_id, inheritJobContext(job,{type:"audit_segment_coverage"}));
      const durationMs = job?.started_at ? Math.max(0, Date.parse(timestamp) - Date.parse(job.started_at)) : null;
      this.db.prepare(`UPDATE vertex_batch_items SET status='succeeded',last_error='',completed_at=?,ingested_at=?,
        output_object=?,output_line=?,output_checksum=? WHERE run_id=? AND job_id=? AND status='submitted'`)
        .run(timestamp, timestamp, String(transport.objectName || "").slice(0, 1_000), Number.isInteger(transport.lineNumber) ? transport.lineNumber : null,
          String(transport.checksum || "").slice(0, 200), run.id, item.job_id);
      this.db.prepare(`UPDATE jobs SET status='succeeded',completed_at=?,duration_ms=?,last_error=NULL,
        failure_class='',last_failure_code='',next_eligible_at=NULL,updated_at=?
        WHERE id=? AND status='queued'`).run(timestamp, durationMs, timestamp, item.job_id);
    });
    if (!saved) return this.releaseVertexBatchItem(run.id, item.job_id, "Source changed while the batch was running; returned for fresh extraction.");
    return true;
  }

  completeVertexBatchCoverageItem(run, item, assessment, transport = {}) {
    const timestamp = this.jobTimestamp();
    let audit;
    transaction(this.db, () => {
      audit = this.auditSegmentCoverage(item.segment_id, assessment?.output || assessment);
      const job = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(item.job_id);
      if (audit.status === "retry_required") this.enqueue("retry_segment_extraction", item.segment_id,
        inheritJobContext(job,{type:"retry_segment_extraction"}));
      else if (audit.status !== "stale" && this.sourceCoverageReady(audit.sourceId)) {
        this.enqueue("finalize_source_extraction", audit.sourceId,inheritJobContext(job,{type:"finalize_source_extraction"}));
      }
      const durationMs = job?.started_at ? Math.max(0, Date.parse(timestamp) - Date.parse(job.started_at)) : null;
      this.db.prepare(`UPDATE vertex_batch_items SET status='succeeded',last_error='',completed_at=?,ingested_at=?,
        output_object=?,output_line=?,output_checksum=? WHERE run_id=? AND job_id=? AND status='submitted'`)
        .run(timestamp, timestamp, String(transport.objectName || "").slice(0, 1_000), Number.isInteger(transport.lineNumber) ? transport.lineNumber : null,
          String(transport.checksum || "").slice(0, 200), run.id, item.job_id);
      this.db.prepare(`UPDATE jobs SET status='succeeded',completed_at=?,duration_ms=?,last_error=NULL,
        failure_class='',last_failure_code='',next_eligible_at=NULL,updated_at=?
        WHERE id=? AND status='queued'`).run(timestamp, durationMs, timestamp, item.job_id);
    });
    return audit;
  }

  releaseVertexBatchItem(runId, jobId, error, { phase = "result" } = {}) {
    const timestamp = this.jobTimestamp();
    const message = String(error?.message || error || "Vertex Batch item failed").slice(0, 4_000);
    transaction(this.db, () => {
      this.db.prepare("UPDATE vertex_batch_items SET status='failed',last_error=?,completed_at=? WHERE run_id=? AND job_id=?")
        .run(message, timestamp, runId, jobId);
      const job = this.db.prepare("SELECT attempts,max_attempts,batch_attempts,execution_route FROM jobs WHERE id=?").get(jobId);
      if (!job) return;
      const failureClass = classifyBatchFailure(error, { phase });
      const submissionAttempt = phase === "submission" && failureClass !== "capacity" ? 1 : 0;
      const batchAttempts = Number(job.batch_attempts || 0) + submissionAttempt;
      const code = String(error?.code || failureClass.toUpperCase()).slice(0, 120);
      let status = "queued";
      let route = job.execution_route || "auto";
      let eligibleAt = timestamp;
      if (failureClass === "permanent_input") {
        status = "failed";
      } else if (["input_too_large", "batch_incompatible"].includes(failureClass)) {
        route = "realtime";
      } else if (failureClass === "retryable_provider") {
        route = batchAttempts >= this.batchMaxAttempts ? "realtime" : "batch";
        eligibleAt = route === "realtime" ? timestamp : this.batchRetryAt(batchAttempts, error?.retryAfterMs);
      } else if (failureClass === "capacity") {
        route = route === "realtime" ? "realtime" : "batch";
        eligibleAt = this.batchRetryAt(Math.max(1, batchAttempts), error?.retryAfterMs);
      }
      this.db.prepare(`UPDATE jobs SET status=?,execution_route=?,failure_class=?,batch_attempts=?,last_failure_code=?,
        available_at=?,next_eligible_at=?,last_error=?,completed_at=?,updated_at=? WHERE id=? AND status='queued'`)
        .run(status, route, failureClass, batchAttempts, code, eligibleAt, eligibleAt, message,
          status === "failed" ? timestamp : null, timestamp, jobId);
    });
  }

  batchRetryAt(attempt, retryAfterMs = 0) {
    const base = Math.min(this.batchBackoffMaxMs, this.batchBackoffInitialMs * 2 ** Math.max(0, Number(attempt || 1) - 1));
    const jittered = Math.round(base * (0.8 + this.random() * 0.4));
    const delayMs = Math.min(this.batchBackoffMaxMs, Math.max(Number(retryAfterMs || 0), jittered));
    return new Date(this.clock().getTime() + delayMs).toISOString();
  }

  recordVertexBatchOutputAnomaly(runId, output, reason) {
    const transport = output?.transport || {};
    const checksum = String(transport.checksum || sha256(JSON.stringify(output || {}))).slice(0, 200);
    this.db.prepare(`INSERT OR IGNORE INTO vertex_batch_output_anomalies(id,run_id,transport_key,request_fingerprint,
      output_object,output_line,output_checksum,reason,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id("batch_anomaly"), runId, String(output?.id || "").slice(0, 200), String(output?.requestFingerprint || "").slice(0, 200),
        String(transport.objectName || "").slice(0, 1_000), Number.isInteger(transport.lineNumber) ? transport.lineNumber : null,
        checksum, String(reason || "Uncorrelated Batch output").slice(0, 2_000), this.jobTimestamp());
  }

  recordVertexBatchCorrelationWarning(runId, jobId, warning) {
    return this.db.prepare(`UPDATE vertex_batch_items SET correlation_warning=? WHERE run_id=? AND job_id=?`)
      .run(String(warning || "").slice(0, 2_000), runId, jobId).changes === 1;
  }

  finishVertexBatch(runId, status, providerState = '', error = '', resultState = null) {
    const timestamp = this.jobTimestamp();
    const counts = this.db.prepare(`SELECT SUM(status='succeeded') AS succeeded,SUM(status='failed') AS failed
      FROM vertex_batch_items WHERE run_id=?`).get(runId);
    const resolvedResultState = resultState || (status === "succeeded" ? "ready_cleanup" : "quarantined");
    this.db.prepare(`UPDATE vertex_batch_runs SET status=?,provider_state=?,result_state=?,succeeded_count=?,failed_count=?,last_error=?,
      cleanup_eligible_at=CASE WHEN ?='ready_cleanup' THEN ? ELSE cleanup_eligible_at END,
      completed_at=?,updated_at=? WHERE id=?`).run(status, providerState, resolvedResultState,
      Number(counts?.succeeded || 0), Number(counts?.failed || 0), String(error || '').slice(0, 4_000),
      resolvedResultState, timestamp, timestamp, timestamp, runId);
  }

  markVertexBatchCleaned(runId) {
    const timestamp = this.jobTimestamp();
    return this.db.prepare(`UPDATE vertex_batch_runs SET result_state='cleaned',cleaned_at=?,updated_at=?
      WHERE id=? AND status='succeeded' AND result_state='ready_cleanup'`).run(timestamp, timestamp, runId).changes === 1;
  }

  deferVertexBatchCleanup(runId, error, delayMs = 60_000) {
    const timestamp = this.jobTimestamp();
    return this.db.prepare(`UPDATE vertex_batch_runs SET cleanup_eligible_at=?,last_output_error=?,updated_at=?
      WHERE id=? AND status='succeeded' AND result_state='ready_cleanup'`)
      .run(new Date(this.clock().getTime() + delayMs).toISOString(), String(error?.message || error || "Batch cleanup failed").slice(0, 4_000),
        timestamp, runId).changes === 1;
  }

  vertexBatchItemCounts(runId) {
    const row = this.db.prepare(`SELECT COUNT(*) AS total,SUM(status='submitted') AS submitted,
      SUM(status='succeeded') AS succeeded,SUM(status='failed') AS failed FROM vertex_batch_items WHERE run_id=?`).get(runId);
    return Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [key, Number(value || 0)]));
  }

  activeVertexBatchCount() {
    return Number(this.db.prepare("SELECT COUNT(*) AS count FROM vertex_batch_runs WHERE status IN ('preparing','submitted')").get()?.count || 0);
  }

  claimJob({ deferBatchExtraction = false, deferBatchCoverage = false } = {}) {
    return transaction(this.db, () => {
      const timestamp = this.jobTimestamp();
      const providerReady = this.clock().getTime() >= this.providerBackoffUntil;
      const databaseHeavyTypes = [...DATABASE_HEAVY_JOB_TYPES];
      this.db.prepare(`
        UPDATE jobs SET status='queued', locked_at=NULL, locked_by=NULL, lease_expires_at=NULL,
          heartbeat_at=NULL, available_at=?, next_eligible_at=?, updated_at=?
        WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
      `).run(timestamp, timestamp, timestamp, timestamp);
      const job = this.db.prepare(`
        SELECT * FROM jobs
        WHERE status = 'queued' AND available_at <= ? AND COALESCE(next_eligible_at,available_at)<=?
          AND (? = 0 OR type <> 'extract_segment_claims' OR execution_route='realtime')
          AND (? = 0 OR type <> 'audit_segment_coverage' OR execution_route='realtime')
          AND NOT EXISTS (
            SELECT 1 FROM vertex_batch_items vbi JOIN vertex_batch_runs vbr ON vbr.id=vbi.run_id
            WHERE vbi.job_id=jobs.id AND vbr.status IN ('preparing','submitted')
          )
          AND (? = 1 OR type='generate_visuals' OR type NOT IN (${[...AI_JOB_TYPES].map(() => "?").join(",")}))
          AND (type<>'generate_visuals' OR ?=1)
          AND NOT EXISTS (SELECT 1 FROM jobs database_writer WHERE database_writer.status='running'
            AND database_writer.type IN (${databaseHeavyTypes.map(()=>"?").join(",")}))
          AND (jobs.type NOT IN (${databaseHeavyTypes.map(()=>"?").join(",")})
            OR NOT EXISTS (SELECT 1 FROM jobs active_pipeline_job WHERE active_pipeline_job.status='running'))
          AND (SELECT COUNT(*) FROM jobs running_lane WHERE running_lane.status='running'
            AND running_lane.workload_class=jobs.workload_class) < CASE jobs.workload_class
              WHEN 'interactive' THEN 2 WHEN 'normal_ingest' THEN 2 ELSE 1 END
        ORDER BY
          CASE workload_class WHEN 'interactive' THEN 0 WHEN 'historical_recovery' THEN 2
            WHEN 'maintenance' THEN 3 ELSE 1 END,
          CASE WHEN datetime(created_at)<=datetime(?,'-15 minutes') THEN 0 ELSE 1 END,
          priority ASC,
          CASE execution_route WHEN 'realtime' THEN 0 WHEN 'auto' THEN 1 ELSE 2 END,
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
      `).get(timestamp, timestamp, deferBatchExtraction ? 1 : 0, deferBatchCoverage ? 1 : 0,
        providerReady ? 1 : 0, ...AI_JOB_TYPES, this.clock().getTime() >= (this.visualBackoffUntil || 0) ? 1 : 0,
        ...databaseHeavyTypes, ...databaseHeavyTypes, timestamp);
      if (!job) return null;
      const queueLatencyMs = Math.max(0, Date.parse(timestamp) - Date.parse(job.created_at));
      const claimed = this.db.prepare(`
        UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_generation=lease_generation+1, claimed_revision=dirty_revision, locked_at = ?,
          locked_by = ?, lease_expires_at = ?, heartbeat_at = ?, started_at = COALESCE(started_at, ?),
          queue_latency_ms = COALESCE(queue_latency_ms, ?), updated_at = ?
        WHERE id = ? AND status='queued'
      `).run(timestamp, this.workerId, this.jobLeaseExpiry(), timestamp, timestamp, queueLatencyMs, timestamp, job.id);
      if (claimed.changes !== 1) return null;
      if (job.type === "extract_source") {
        this.db.prepare("UPDATE sources SET status = 'processing', updated_at = ? WHERE id = ?").run(timestamp, job.entity_id);
      }
      return { ...job, attempts: job.attempts + 1, lease_generation: Number(job.lease_generation || 0) + 1, locked_at: timestamp, locked_by: this.workerId,
        lease_expires_at: this.jobLeaseExpiry(), heartbeat_at: timestamp,
        started_at: job.started_at || timestamp, queue_latency_ms: job.queue_latency_ms ?? queueLatencyMs };
    });
  }

  heartbeatJob(jobId, ownerId = this.workerId, generation = null) {
    const timestamp = this.jobTimestamp();
    return this.db.prepare(`UPDATE jobs SET heartbeat_at=?, lease_expires_at=?, updated_at=?
      WHERE id=? AND status='running' AND locked_by=? AND (? IS NULL OR lease_generation=?)`)
      .run(timestamp, this.jobLeaseExpiry(), timestamp, jobId, ownerId, generation, generation).changes === 1;
  }

  ownsJob(jobId, ownerId = this.workerId, generation = null) {
    return Boolean(this.db.prepare(`SELECT 1 FROM jobs WHERE id=? AND status='running' AND locked_by=?
      AND lease_expires_at>? AND (? IS NULL OR lease_generation=?)`)
      .get(jobId, ownerId, this.jobTimestamp(), generation, generation));
  }

  completeJob(jobId, ownerId = this.workerId, generation = null) {
    const timestamp = this.jobTimestamp();
    const job = this.db.prepare("SELECT started_at FROM jobs WHERE id=?").get(jobId);
    const durationMs = job?.started_at ? Math.max(0, Date.parse(timestamp) - Date.parse(job.started_at)) : null;
    return this.db.prepare(`
      UPDATE jobs SET status=CASE WHEN dirty_revision>claimed_revision THEN 'queued' ELSE 'succeeded' END,
        completed_at=CASE WHEN dirty_revision>claimed_revision THEN NULL ELSE ? END, duration_ms=?, locked_by=NULL,
        lease_expires_at=NULL, heartbeat_at=NULL, failure_class='',last_failure_code='',last_error=NULL,next_eligible_at=NULL,updated_at=?
      WHERE id=? AND status='running' AND locked_by=? AND (? IS NULL OR lease_generation=?)
    `).run(timestamp, durationMs, timestamp, jobId, ownerId, generation, generation).changes === 1;
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
    const delayMs = Math.max(Number(error?.retryAfterMs || 0),laneBackoffMs(job.workload_class,
      Math.round(baseDelayMs * (0.8 + Math.random() * 0.4))));
    const availableAt = new Date(this.clock().getTime() + delayMs).toISOString();
    if (providerPressure) {
      if (job.type === 'generate_visuals') this.visualBackoffUntil = Math.max(this.visualBackoffUntil || 0, Date.parse(availableAt));
      else this.providerBackoffUntil = Math.max(this.providerBackoffUntil, Date.parse(availableAt));
    }
    const timestamp = this.jobTimestamp();
    if(providerPressure)this.db.prepare(`UPDATE model_call_metrics SET retry_after_ms=COALESCE(?,retry_after_ms),backoff_until=?
      WHERE id=(SELECT id FROM model_call_metrics WHERE run_id=? ORDER BY created_at DESC,id DESC LIMIT 1)`)
      .run(error?.retryAfterMs??null,availableAt,job.id);
    const pressuredProvider=String(error?.provider||this.activeProvider||"");
    if(providerPressure&&job.type!=="generate_visuals"&&pressuredProvider)this.db.prepare(`UPDATE provider_runtime_state SET backoff_until=?,updated_at=?
      WHERE provider=?`).run(availableAt,timestamp,pressuredProvider);
    const durationMs = job.started_at ? Math.max(0, Date.parse(timestamp) - Date.parse(job.started_at)) : null;
    const failureClass = terminalFailureClass(error, retry, providerPressure);
    const failureCode = String(error?.code || error?.status || "").slice(0, 120);
    const changed = this.db.prepare(`
      UPDATE jobs SET status=?, available_at=?, next_eligible_at=?,last_error=?, completed_at=?, duration_ms=?,
        failure_class=?,last_failure_code=?,locked_by=NULL, lease_expires_at=NULL, heartbeat_at=NULL, updated_at=?
      WHERE id=? AND status='running' AND locked_by=? AND lease_generation=?
    `).run(retry ? "queued" : "failed", availableAt, retry ? availableAt : null, String(error?.message || error).slice(0, 4_000),
      retry ? null : timestamp, retry ? null : durationMs, failureClass, failureCode, timestamp, job.id, job.locked_by || this.workerId,
      Number(job.lease_generation || 0)).changes;
    if (changed !== 1) return false;
    const message = String(error?.message || error).slice(0, 4_000);
    if (job.type === "extract_source") {
      this.db.prepare("UPDATE sources SET status = 'exception', last_error = ?, updated_at = ? WHERE id = ?").run(message, now(), job.entity_id);
    } else if (!retry && ["extract_source", "preflight_source", "segment_source"].includes(job.type)) {
      this.db.prepare("UPDATE sources SET status = 'exception', last_error = ?, updated_at = ? WHERE id = ?").run(message, now(), job.entity_id);
    } else if (!retry && job.type === "plan_content") {
      this.db.prepare("UPDATE topic_candidates SET status='candidate', updated_at=? WHERE id=?").run(now(), job.entity_id);
    } else if (!retry && ["generate_draft", "compose_frontend_page_plan"].includes(job.type)) {
      this.db.prepare("UPDATE content_briefs SET status='exception', last_error=?, updated_at=? WHERE id=?").run(message, now(), job.entity_id);
    } else if (!retry && ["review_draft", "revise_draft", "compose_frontend_page", "compose_publish_page", "push_wordpress_draft"].includes(job.type)) {
      this.db.prepare("UPDATE article_drafts SET status='exception', updated_at=? WHERE id=?").run(now(), job.entity_id);
    }
    if (!retry && PRODUCTION_JOB_TYPES.has(job.type)) this.handleTerminalProductionFailure(job, error);
    if (!retry && job.type === "extract_source_experience") this.refreshExperienceBackfillRuns();
    if (!retry && job.type === "analyze_source_diagnostic") this.refreshRecommendationBackfillRuns();
    return true;
  }

  handleTerminalProductionFailure(job, error) {
    const code = String(error?.code || error?.status || "PRODUCTION_FAILED").slice(0,120);
    const message = String(error?.message || error || "Production failed").slice(0,4_000);
    if (isSystemLevelFailure(code, message)) return { rolledBack:false,systemLevel:true };
    const context = this.productionContext(job);
    if (!context?.opportunity_id) return { rolledBack:false,reason:"no_opportunity" };
    if (isMediaRecoveryFailure(code, message)) {
      const assets = context.draft_id ? this.db.prepare(`SELECT DISTINCT sa.id FROM article_visuals av JOIN source_assets sa ON sa.id=av.source_asset_id
        WHERE av.draft_id=? AND sa.durability_status<>'ORIGINAL_STORED'`).all(context.draft_id) : [];
      for (const asset of assets) this.enqueue("repair_media_asset",asset.id,{priority:10});
      if (context.draft_id) this.db.prepare("UPDATE article_drafts SET status='media_pending',updated_at=? WHERE id=?").run(now(),context.draft_id);
      return { rolledBack:false,mediaPending:true,queuedRepairs:assets.length };
    }
    const timestamp = now();
    const lessonId = id("failure_lesson");
    const category = productionFailureCategory(code,message);
    const previousInput = { jobType:job.type,entityId:job.entity_id,candidateId:context.candidate_id,
      briefId:context.brief_id,draftId:context.draft_id,opportunityStatus:context.opportunity_status };
    const remediation = failureRemediation(category);
    return transaction(this.db, () => {
      const snapshot = this.productionAttemptSnapshot(context);
      this.db.prepare(`INSERT OR IGNORE INTO production_attempt_archives(id,opportunity_id,failing_job_id,failing_stage,
        snapshot_json,failure_code,created_at) VALUES (?,?,?,?,?,?,?)`).run(id('attempt_archive'),context.opportunity_id,
          job.id || `${job.type}:${job.entity_id}`,job.type,JSON.stringify(snapshot),code,timestamp);
      this.db.prepare(`INSERT INTO failure_lessons(id,scope,failure_code,category,normalized_reason,source_id,opportunity_id,
        failing_stage,previous_input_json,remediation_rule,retry_safe,status,created_at,updated_at)
        VALUES (?,'OPPORTUNITY',?,?,?,?,?,?,?, ?,?,'active',?,?)`)
        .run(lessonId,code || "PRODUCTION_FAILED",category,normalizeFailureReason(message),context.source_id || null,
          context.opportunity_id,job.type,JSON.stringify(previousInput),remediation,productionFailureRetrySafe(category) ? 1 : 0,timestamp,timestamp);
      const scopeInvalid = ['APPROVED_SCOPE_INVALID','EVIDENCE_SCOPE_INVALID'].includes(code);
      if (!scopeInvalid) {
        // Keep the approval and every successful artifact. Existing bounded
        // recovery selects the failed body/page/delivery stage on this revision.
        if (context.draft_id) this.db.prepare("UPDATE article_drafts SET status=?,updated_at=? WHERE id=?")
          .run(['review_draft','revise_draft'].includes(job.type) ? 'qa_failed' : 'exception',timestamp,context.draft_id);
        return { rolledBack:false, archived:true, lessonId, retainedApproval:true, repairStage:job.type };
      }
      const entityIds = [context.candidate_id,context.brief_id,context.draft_id].filter(Boolean);
      let cancelledJobs = 0;
      if (entityIds.length) {
        const placeholders = entityIds.map(() => "?").join(",");
        cancelledJobs = this.db.prepare(`UPDATE jobs SET status='failed',last_failure_code='ATTEMPT_SCOPE_INVALID',
          last_error='已批准范围失效；产物与任务历史保留。',locked_by=NULL,lease_expires_at=NULL
          WHERE status IN ('queued','running') AND id<>? AND entity_id IN (${placeholders})`).run(job.id,...entityIds).changes;
      }
      const removed = {
        drafts:0, briefs:0, cancelledJobs,
      };
      if (context.candidate_id) this.db.prepare("UPDATE topic_candidates SET status='candidate',suppression_reason=NULL,updated_at=? WHERE id=?")
        .run(timestamp,context.candidate_id);
      this.db.prepare(`UPDATE content_opportunities SET status='recommended',lifecycle_state='recommended_again',approved_at=NULL,
        last_failure_lesson_id=?,previous_failure_json=?,inbox_state='INTERNAL',recommendation_reconciled_version='',updated_at=? WHERE id=?`)
        .run(lessonId,JSON.stringify({ code,category,reason:normalizeFailureReason(message),stage:job.type,failedAt:timestamp,
          previousInput,remediation }),timestamp,context.opportunity_id);
      this.db.prepare(`INSERT INTO production_rollbacks(id,opportunity_id,failure_lesson_id,failing_stage,removed_artifacts_json,
        preserved_assets_json,previous_status,result_status,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(id("rollback"),context.opportunity_id,lessonId,job.type,JSON.stringify(removed),
          JSON.stringify({ sources:true,claims:true,knowledge:true,experiences:true,editorialLessons:true, productionArtifacts:true, wordpressAssociations:true }),
          context.opportunity_status,"recommended_again",timestamp);
      return { rolledBack:true,lessonId,opportunityId:context.opportunity_id,removed };
    });
  }

  productionAttemptSnapshot(context) {
    const one = (table, field, value) => value ? this.db.prepare(`SELECT * FROM ${table} WHERE ${field}=?`).all(value) : [];
    return { version:1, context,
      assembly:one('editorial_assemblies','candidate_id',context.candidate_id),
      brief:one('content_briefs','id',context.brief_id), narrative:one('narrative_plans','brief_id',context.brief_id),
      packet:one('writing_packets','brief_id',context.brief_id), draft:one('article_drafts','id',context.draft_id),
      revisions:one('draft_revisions','draft_id',context.draft_id), reviews:one('quality_reviews','draft_id',context.draft_id),
      visuals:one('article_visuals','draft_id',context.draft_id), page:one('frontend_page_compositions','draft_id',context.draft_id),
      wordpress:one('wordpress_publications','draft_id',context.draft_id) };
  }

  productionContext(job) {
    const type = String(job.type || "");
    let candidateId = ["assemble_editorial","plan_content"].includes(type) ? job.entity_id : null;
    let briefId = ["plan_narrative","assemble_writing_packet","compose_frontend_page_plan","generate_draft"].includes(type) ? job.entity_id : null;
    let draftId = ["generate_visuals","compose_frontend_page","review_draft","revise_draft","compose_commercial","compose_publish_page","push_wordpress_draft"].includes(type) ? job.entity_id : null;
    if (draftId && !briefId) briefId = this.db.prepare("SELECT brief_id FROM article_drafts WHERE id=?").get(draftId)?.brief_id || null;
    if (briefId && !candidateId) candidateId = this.db.prepare("SELECT candidate_id FROM content_briefs WHERE id=?").get(briefId)?.candidate_id || null;
    const opportunity = candidateId ? this.db.prepare("SELECT * FROM content_opportunities WHERE candidate_id=? ORDER BY updated_at DESC LIMIT 1").get(candidateId) : null;
    return opportunity ? { candidate_id:candidateId,brief_id:briefId,draft_id:draftId,opportunity_id:opportunity.id,
      opportunity_status:opportunity.status,source_id:opportunity.source_id } : null;
  }

  listFailureLessons(limit = 100) {
    return this.db.prepare("SELECT * FROM failure_lessons ORDER BY created_at DESC LIMIT ?").all(Math.max(1,Math.min(500,Number(limit)||100)))
      .map((row) => ({ ...row,previousInput:json(row.previous_input_json,{}) }));
  }

  recordEditorialFeedback(draftId, feedback, principle = "") {
    const allowed = new Set(["满意","AI味重","太啰嗦","信息太平","像数据库","结构不好","很好"]);
    if (!allowed.has(feedback)) throw new Error("Unsupported editorial feedback.");
    if (!this.db.prepare("SELECT id FROM article_drafts WHERE id=?").get(draftId)) return null;
    const timestamp=now(); const lessonId=id("editorial_lesson");
    this.db.prepare("INSERT INTO editorial_lessons(id,draft_id,feedback,principle,active,created_at,updated_at) VALUES (?,?,?,?,1,?,?)")
      .run(lessonId,draftId,feedback,String(principle || editorialPrinciple(feedback)).slice(0,2000),timestamp,timestamp);
    return this.db.prepare("SELECT * FROM editorial_lessons WHERE id=?").get(lessonId);
  }

  markGoldenArticle(draftId, principles = []) {
    const draft=this.db.prepare("SELECT id,title,body_markdown,content_hash,revision FROM article_drafts WHERE id=?").get(draftId);
    if (!draft) return null;
    const timestamp=now(); const goldenId=`golden_${sha256(draftId).slice(0,24)}`;
    this.db.prepare(`INSERT INTO golden_articles(id,draft_id,title,snapshot_json,principles_json,active,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)
      ON CONFLICT(draft_id) DO UPDATE SET title=excluded.title,snapshot_json=excluded.snapshot_json,
        principles_json=excluded.principles_json,active=1,updated_at=excluded.updated_at`)
      .run(goldenId,draftId,draft.title,JSON.stringify({title:draft.title,bodyMarkdown:draft.body_markdown,
        contentHash:draft.content_hash,revision:draft.revision}),JSON.stringify(uniqueStrings(principles).slice(0,20)),timestamp,timestamp);
    return this.db.prepare("SELECT * FROM golden_articles WHERE draft_id=?").get(draftId);
  }

  getSource(sourceId) {
    const source = this.db.prepare("SELECT * FROM sources WHERE id = ?").get(sourceId);
    if (!source) return null;
    const assets = this.db.prepare("SELECT * FROM current_source_assets WHERE source_id = ? ORDER BY position").all(sourceId);
    const files = this.db.prepare("SELECT id, file_kind, original_filename, mime_type, storage_path, size_bytes, sha256, created_at FROM current_source_files WHERE source_id = ? ORDER BY created_at, id").all(sourceId);
    const structured = this.db.prepare("SELECT * FROM structured_sources WHERE source_id = ?").get(sourceId) || null;
    const claims = this.db.prepare("SELECT * FROM claims WHERE source_id = ? ORDER BY normalized_key").all(sourceId);
    const extractionRuns = this.db.prepare("SELECT * FROM extraction_runs WHERE source_id=? ORDER BY revision DESC").all(sourceId);
    const claimHistory = this.db.prepare("SELECT * FROM claim_history WHERE source_id=? ORDER BY extraction_revision DESC, claim_id").all(sourceId);
    const blueprint = this.db.prepare("SELECT * FROM source_blueprints WHERE source_id = ?").get(sourceId) || null;
    const analysis = this.db.prepare("SELECT * FROM content_intake_analyses WHERE source_id = ?").get(sourceId) || null;
    const recommendation = this.db.prepare("SELECT * FROM content_recommendations WHERE source_id = ? ORDER BY updated_at DESC LIMIT 1").get(sourceId) || null;
    const captureVersions = this.db.prepare(`SELECT id,capture_version,captured_at,content_hash,completeness_status,
      acquisition_origin,sync_scope_key,extension_version,created_at FROM capture_versions WHERE source_id=? ORDER BY capture_version DESC`).all(sourceId);
    const segments = this.db.prepare("SELECT * FROM current_source_segments WHERE source_id=? ORDER BY sequence").all(sourceId);
    const coverage = this.db.prepare("SELECT * FROM current_extraction_coverage WHERE source_id=? ORDER BY segment_id").all(sourceId);
    const family = this.db.prepare(`SELECT sf.*, sfm.relation_type, sfm.overlap_score, sfm.incremental_claim_count, sfm.analysis_json
      FROM source_family_memberships sfm JOIN source_families sf ON sf.id=sfm.family_id WHERE sfm.source_id=?`).get(sourceId) || null;
    const experienceBlocks = this.listExperienceBlocks(sourceId);
    const mediaManifest = this.mediaRepairManifest(sourceId);
    return hydrateSource({ source, assets, files, structured, claims, extractionRuns, claimHistory, blueprint, analysis, recommendation, segments, coverage, family, captureVersions,
      experienceBlocks, mediaManifest });
  }

  getSourceCaptureVersion(sourceId, captureVersion) {
    const version=this.db.prepare('SELECT * FROM capture_versions WHERE source_id=? AND capture_version=?').get(sourceId,Number(captureVersion));
    if(!version)return null;
    const assets=this.db.prepare('SELECT * FROM source_assets WHERE source_id=? AND capture_version=? ORDER BY position,id').all(sourceId,version.capture_version);
    return {...version,assets,assetSnapshots:json(version.assets_json,[]),
      files:this.db.prepare('SELECT * FROM source_files WHERE source_id=? AND capture_version=? ORDER BY id').all(sourceId,version.capture_version),
      segments:this.db.prepare('SELECT * FROM source_segments WHERE source_id=? AND capture_version=? ORDER BY sequence').all(sourceId,version.capture_version),
      assetLinkage:assets.length?'retained':'snapshot_only'};
  }

  recordSourcePreflight(sourceId, result) {
    const row = this.db.prepare("SELECT diagnostic_json FROM sources WHERE id=?").get(sourceId);
    if (!row) return false;
    const diagnostic = { ...json(row.diagnostic_json, {}), preflight: result };
    this.db.prepare("UPDATE sources SET diagnostic_json=?,updated_at=? WHERE id=?")
      .run(JSON.stringify(diagnostic), now(), sourceId);
    return true;
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
        FROM current_source_assets WHERE source_id=? ORDER BY position,id LIMIT 3`).all(sourceId);
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
    const values = segmentSource(source, { maxChars: this.contentConfig.sourceTextSegmentMaxChars })
      .map(item=>source.capture_version>1?{...item,id:`segment_${sha256(`${item.id}:v${source.capture_version}`).slice(0,24)}`}:item);
    const timestamp = now();
    transaction(this.db, () => {
      const insert = this.db.prepare(`INSERT INTO source_segments(id,source_id,segment_type,sequence,title,raw_text,page_start,page_end,asset_id,image_index,destination_scopes_json,topic_scopes_json,content_hash,semantic_hash,status,created_at,updated_at,capture_version)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending',?,?,?)`);
      for (const item of values) insert.run(item.id, sourceId, item.segmentType, item.sequence, item.title, item.rawText,
        item.pageStart, item.pageEnd, item.assetId, item.imageIndex, JSON.stringify(item.destinationScopes), JSON.stringify(item.topicScopes),
        item.contentHash, item.semanticHash, timestamp, timestamp, source.capture_version);
      this.db.prepare("UPDATE source_assets SET extraction_status='pending', extraction_error=NULL, processed_at=NULL WHERE source_id=? AND capture_version=?").run(sourceId,source.capture_version);
      this.db.prepare("UPDATE sources SET status='processing', diagnostic_json=?, updated_at=? WHERE id=?")
        .run(JSON.stringify({ ...json(source.diagnostic_json, {}), strategy_version: this.strategyVersion,
          stage: "segmented", processing_profile:sourceProcessingProfile(source),
          segment_count: values.length, asset_count: source.assets.length }), timestamp, sourceId);
    });
    return values;
  }

  prepareMediaExtractionBatches(sourceId) {
    if(this.contentConfig.mediaBatchingEnabled===false)return [];
    const source=this.db.prepare("SELECT id,capture_version FROM sources WHERE id=?").get(sourceId);
    if(!source)return [];
    const existing=this.db.prepare(`SELECT * FROM media_extraction_batches WHERE source_id=? AND capture_version=? ORDER BY sequence`)
      .all(sourceId,source.capture_version);
    if(existing.length)return existing.filter((row)=>!["complete","extracted"].includes(row.status)).map(hydrateMediaBatch);
    const rows=this.db.prepare(`SELECT s.id AS segment_id,s.segment_type,s.sequence,s.title,s.raw_text,s.asset_id,
        a.kind,a.width,a.height,a.alt_text,a.nearby_text,a.caption_text
      FROM source_segments s JOIN source_assets a ON a.id=s.asset_id
      WHERE s.source_id=? AND s.capture_version=? AND a.kind='image' ORDER BY s.sequence`).all(sourceId,source.capture_version);
    const ordinary=rows.filter((row)=>!sensitiveMediaRow(row));
    const groups=balancedMediaGroups(ordinary,Math.min(8,Math.max(4,Number(this.contentConfig.mediaImageBatchSize || 6))));
    const timestamp=now();
    transaction(this.db,()=>{
      const insert=this.db.prepare(`INSERT INTO media_extraction_batches(id,source_id,capture_version,sequence,segment_ids_json,asset_ids_json,classification,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,'pending',?,?)`);
      groups.forEach((group,index)=>{
        const batchId=`media_batch_${sha256(`${sourceId}:${source.capture_version}:${group.map((row)=>row.asset_id).join(":")}`).slice(0,24)}`;
        insert.run(batchId,sourceId,source.capture_version,index,JSON.stringify(group.map((row)=>row.segment_id)),
          JSON.stringify(group.map((row)=>row.asset_id)),"ordinary_image",timestamp,timestamp);
      });
    });
    return this.db.prepare(`SELECT * FROM media_extraction_batches WHERE source_id=? AND capture_version=? ORDER BY sequence`)
      .all(sourceId,source.capture_version).map(hydrateMediaBatch);
  }

  getMediaBatchExtractionPackage(batchId) {
    const row=this.db.prepare("SELECT * FROM media_extraction_batches WHERE id=?").get(batchId);
    if(!row)return null;
    const batch=hydrateMediaBatch(row);
    const source=this.getSource(row.source_id);
    if(!source||source.capture_version!==row.capture_version)return {batch,staleCaptureVersion:true};
    const segments=this.db.prepare(`SELECT * FROM source_segments WHERE id IN (${batch.segmentIds.map(()=>"?").join(",")}) ORDER BY sequence`).all(...batch.segmentIds);
    const segmentByAsset=Object.fromEntries(segments.map((segment)=>[segment.asset_id,segment.id]));
    const assets=source.assets.filter((asset)=>batch.assetIds.includes(asset.id)).map((asset)=>({...asset,segment_id:segmentByAsset[asset.id]}));
    return {batch,segments,source:{...source,raw_text:"",assets,title:`${source.title} · media batch ${row.sequence+1}`,
      submission_metadata:{...source.submission_metadata,media_batch_id:row.id,asset_segment_ids:segmentByAsset}}};
  }

  saveMediaBatchExtraction(batchId,extraction) {
    const pack=this.getMediaBatchExtractionPackage(batchId);
    if(!pack||pack.staleCaptureVersion)return [];
    const claims=Array.isArray(extraction?.result?.claims)?extraction.result.claims:[];
    return transaction(this.db,()=>{
      const saved=[];
      for(const segment of pack.segments){
        const scopedClaims=claims.filter((claim)=>claim.segment_id===segment.id||claim.asset_id===segment.asset_id
          || (pack.segments.length===1&&!claim.segment_id&&!claim.asset_id));
        const scoped={...extraction,result:{...(extraction.result||{}),claims:scopedClaims}};
        if(this.saveSegmentExtraction(segment.id,scoped,{withinTransaction:true}))saved.push(segment.id);
      }
      this.db.prepare("UPDATE media_extraction_batches SET status='extracted',updated_at=? WHERE id=?").run(now(),batchId);
      return saved;
    });
  }

  splitSourceSegmentForRetry(segmentId) {
    const segment = this.db.prepare("SELECT * FROM source_segments WHERE id=?").get(segmentId);
    if (!segment || segment.asset_id || String(segment.raw_text || "").length < 800) return [];
    // Automatic output-limit splitting is for an unprocessed current segment.
    // A forced re-extraction must never cascade-delete previously cited evidence.
    if (segment.capture_version !== this.db.prepare('SELECT capture_version FROM sources WHERE id=?').get(segment.source_id)?.capture_version
      || this.db.prepare('SELECT 1 FROM segment_extractions WHERE segment_id=?').get(segmentId)
      || this.db.prepare('SELECT 1 FROM evidence_spans WHERE segment_id=? LIMIT 1').get(segmentId)) return [];
    const text = String(segment.raw_text);
    let midpoint = Math.floor(text.length / 2);
    const boundary = Math.max(text.lastIndexOf("。", midpoint), text.lastIndexOf(". ", midpoint), text.lastIndexOf("\n", midpoint));
    if (boundary > text.length * 0.25) midpoint = boundary + 1;
    const parts = [text.slice(0, midpoint).trim(), text.slice(midpoint).trim()].filter(Boolean);
    if (parts.length !== 2) return [];
    const timestamp = now();
    return transaction(this.db, () => {
      const maximum = this.db.prepare("SELECT COALESCE(MAX(sequence),-1) AS value FROM source_segments WHERE source_id=? AND capture_version=?").get(segment.source_id,segment.capture_version).value;
      this.db.prepare("DELETE FROM source_segments WHERE id=?").run(segmentId);
      const shift = maximum + 2;
      this.db.prepare("UPDATE source_segments SET sequence=sequence+? WHERE source_id=? AND sequence>? AND capture_version=?")
        .run(shift, segment.source_id, segment.sequence,segment.capture_version);
      this.db.prepare("UPDATE source_segments SET sequence=sequence-?+1 WHERE source_id=? AND sequence>? AND capture_version=?")
        .run(shift, segment.source_id, segment.sequence + shift,segment.capture_version);
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

  saveSegmentExtraction(segmentId, extraction, { retry = false, withinTransaction = false } = {}) {
    const segment = this.db.prepare("SELECT * FROM source_segments WHERE id=?").get(segmentId);
    if (!segment) throw new Error(`Source segment ${segmentId} no longer exists.`);
    const sourceVersion = this.db.prepare("SELECT capture_version FROM sources WHERE id=?").get(segment.source_id)?.capture_version;
    if (segment.capture_version !== sourceVersion) return false;
    const timestamp = now();
    const attempt = retry ? 2 : 1;
    const inputManifest = extractionInputManifest(segment, extraction);
    const inputModality = inputManifest.receivedModality;
    const write = () => {
      this.db.prepare(`INSERT INTO segment_extractions(segment_id,source_id,result_json,method,model,attempt,created_at,updated_at,input_modality,input_manifest_json)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(segment_id) DO UPDATE SET result_json=excluded.result_json,method=excluded.method,
        model=excluded.model,attempt=excluded.attempt,updated_at=excluded.updated_at,input_modality=excluded.input_modality,
        input_manifest_json=excluded.input_manifest_json`)
        .run(segmentId, segment.source_id, JSON.stringify(extraction.result), extraction.method, extraction.model, attempt, timestamp, timestamp,
          inputModality, JSON.stringify(inputManifest));
      this.db.prepare("UPDATE source_segments SET status='extracted',updated_at=? WHERE id=?").run(timestamp, segmentId);
      if (segment.asset_id) {
        const languageStatus = detectedAssetLanguage(extraction?.result);
        this.db.prepare(`UPDATE source_assets SET extraction_status='processed',extraction_error=NULL,processed_at=?,
          language_status=CASE WHEN ?='unknown' THEN language_status ELSE ? END WHERE id=?`)
          .run(timestamp, languageStatus, languageStatus, segment.asset_id);
      }
      return true;
    };
    return withinTransaction ? write() : transaction(this.db, write);
  }

  getSegmentCoveragePackage(segmentId, { extraction = null, retry = false } = {}) {
    const row = this.db.prepare(`SELECT ss.*,se.result_json,se.method,se.model,se.attempt,se.input_modality,se.input_manifest_json FROM source_segments ss
      JOIN segment_extractions se ON se.segment_id=ss.id WHERE ss.id=?`).get(segmentId);
    if (!row) return null;
    if (extraction) {
      const manifest = extractionInputManifest(row, extraction);
      Object.assign(row, { result_json: JSON.stringify(extraction.result), method: extraction.method, model: extraction.model,
        attempt: retry ? 2 : 1, input_modality: manifest.receivedModality, input_manifest_json: JSON.stringify(manifest), status: 'extracted' });
    }
    const coverage = this.db.prepare("SELECT * FROM extraction_coverage WHERE segment_id=?").get(segmentId);
    const source = this.getSource(row.source_id);
    if (row.capture_version !== source?.capture_version) return { segment: row, staleCaptureVersion: true };
    const asset = row.asset_id ? source?.assets.find((item) => item.id === row.asset_id) : null;
    return {
      segment: row, extraction: json(row.result_json, {}), inputManifest: normalizeExtractionInputManifest(json(row.input_manifest_json, {})),
      source: source ? { ...source, raw_text: row.raw_text, assets: asset ? [asset] : [] } : null,
      expectedModality: row.asset_id ? (asset?.kind === "video" ? "video" : "image") : "text",
      coverage: coverage ? { ...coverage, uncovered_spans: json(coverage.uncovered_spans_json, []), audit: json(coverage.audit_json, {}) } : null,
    };
  }

  shouldRunAiCoverage(segmentId) {
    if(this.contentConfig.coverageAiRoutingEnabled!==true)return false;
    const row=this.db.prepare(`SELECT s.raw_text,s.asset_id,se.result_json,se.method FROM source_segments s
      JOIN segment_extractions se ON se.segment_id=s.id WHERE s.id=?`).get(segmentId);
    if(!row||row.asset_id)return false;
    const claims=json(row.result_json,{}).claims||[];
    const text=String(row.raw_text||"");
    return row.method==="heuristic"||claims.length===0||text.length>2000
      ||/(?:price|ticket|hours?|open|closed|reservation|safety|warning|must|only|except|票价|价格|营业|开放|关闭|预约|安全|必须|仅限|除外)/iu.test(text);
  }

  auditSegmentCoverage(segmentId, assessment = null) {
    const row = this.db.prepare(`SELECT s.*,se.result_json,se.method,se.model,se.attempt,se.input_modality,se.input_manifest_json FROM source_segments s
      JOIN segment_extractions se ON se.segment_id=s.id WHERE s.id=?`).get(segmentId);
    if (!row) throw new Error(`Segment ${segmentId} has no extraction result.`);
    const sourceVersion = this.db.prepare("SELECT capture_version FROM sources WHERE id=?").get(row.source_id)?.capture_version;
    if (row.capture_version !== sourceVersion) return { status: "stale", sourceId: row.source_id };
    const result = json(row.result_json, {});
    const claims = Array.isArray(result.claims) ? result.claims : [];
    const expectedModality = row.asset_id ? (row.segment_type === "video_chapter" ? "video" : "image") : "text";
    const storedManifest = normalizeExtractionInputManifest(json(row.input_manifest_json, {}));
    const hasStoredManifest = storedManifest.version > 0;
    const assessmentModality = normalizeInputModality(assessment?.modality?.received);
    const receivedModality = hasStoredManifest ? storedManifest.receivedModality
      : assessmentModality !== "unknown" ? assessmentModality
        : expectedModality === "text" && row.input_modality === "text" ? "text" : "unknown";
    const matchingAsset = row.asset_id ? storedManifest.assets.find((item) => item.assetId === row.asset_id) : null;
    const receivedExpectedInput = expectedModality === "text"
      ? receivedModality === "text" || receivedModality === "mixed"
      : matchingAsset ? matchingAsset.status === "submitted"
        : receivedModality === expectedModality || receivedModality === "mixed";
    const supportedClaims = row.asset_id ? claims : claims.filter((claim) => locateEvidenceQuote(row.raw_text, claim.source_quote).status !== "unsupported");
    const materiality = assessSegmentMateriality(row, assessment);
    const assessedUncovered = Array.isArray(assessment?.uncovered_spans) ? assessment.uncovered_spans
      .map((item) => ({ locator: String(item.quote || item.locator || row.title || `segment ${row.sequence + 1}`).slice(0, 800),
        importance: String(item.importance || "material"), reason: String(item.reason || "Material travel evidence is not covered by a Claim.").slice(0, 1000) }))
      .filter((item) => !unsupportedClaimAuditFalsePositive(item)) : null;
    const noSupportedClaimGap = !row.asset_id && materiality === "material" && supportedClaims.length === 0 && row.method !== "heuristic"
      ? [{ locator: row.title || `segment ${row.sequence + 1}`, importance: "material", reason: "Material segment produced no traceable Claim." }] : [];
    const mediaZeroClaimGap = row.asset_id && receivedExpectedInput && supportedClaims.length === 0 && materiality !== "non_material"
      ? [{ locator: row.title || `segment ${row.sequence + 1}`, importance: "material",
        reason: "Received media produced no Claim and was not classified as decorative by the local materiality rules." }] : [];
    const failedAssetReason = matchingAsset?.failureReason ? ` ${matchingAsset.failureReason}` : "";
    const modalityGap = row.asset_id && !receivedExpectedInput
      ? [{ locator: row.title || `segment ${row.sequence + 1}`, importance: "material", reason: `Expected ${expectedModality} evidence was not received by the model.${failedAssetReason}`.trim() }] : [];
    const uncovered = [...(assessedUncovered || []), ...noSupportedClaimGap, ...mediaZeroClaimGap, ...modalityGap];
    const importantUncovered = uncovered.filter((item) => ["material", "important"].includes(item.importance)).length;
    const retryCount = Math.max(0, Number(row.attempt || 1) - 1);
    const transportStatus = receivedExpectedInput ? "succeeded" : "failed";
    const evidenceCoverage = materiality === "non_material" ? "not_applicable"
      : importantUncovered === 0 ? "complete" : supportedClaims.length > 0 ? "partial" : "none";
    const terminalUsability = materiality === "non_material" ? "non_material"
      : evidenceCoverage === "complete" ? "usable"
        : evidenceCoverage === "partial" && transportStatus === "succeeded" ? "partial_usable" : "review_needed";
    const status = importantUncovered > 0 && retryCount < 1 ? "retry_required" : terminalUsability;
    const legacyStatus = status === "retry_required" ? "retry_required"
      : status === "review_needed" ? "manual_review" : "passed";
    const timestamp = now();
    const coverageId = `coverage_${sha256(segmentId).slice(0, 24)}`;
    const audit = { expectedModality, receivedModality, assetId: row.asset_id || null,
      attempted: hasStoredManifest ? storedManifest.assets.length : Number(assessment?.modality?.attempted || 0),
      inputManifestVersion: storedManifest.version || 0, legacyInputManifest: !hasStoredManifest,
      inputFailures: storedManifest.assets.filter((item) => item.status === "failed"),
      unsupportedClaimCount: claims.length - supportedClaims.length,
      transportStatus, evidenceCoverage, publicationUsability: status === "retry_required" ? "review_needed" : terminalUsability,
      materiality, materialityBasis: segmentMaterialityBasis(row, assessment) };
    this.db.prepare(`INSERT INTO extraction_coverage(id,source_id,segment_id,extraction_run_id,status,candidate_evidence_count,claim_count,uncovered_spans_json,important_uncovered_count,model,audited_at,retry_count,audit_json,transport_status,evidence_coverage,publication_usability,materiality)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,
      candidate_evidence_count=excluded.candidate_evidence_count,claim_count=excluded.claim_count,uncovered_spans_json=excluded.uncovered_spans_json,
      important_uncovered_count=excluded.important_uncovered_count,model=excluded.model,audited_at=excluded.audited_at,retry_count=excluded.retry_count,audit_json=excluded.audit_json,
      transport_status=excluded.transport_status,evidence_coverage=excluded.evidence_coverage,
      publication_usability=excluded.publication_usability,materiality=excluded.materiality`)
      .run(coverageId, row.source_id, segmentId, null, legacyStatus, supportedClaims.length + uncovered.length, supportedClaims.length,
        JSON.stringify(uncovered), importantUncovered, row.model, timestamp, retryCount, JSON.stringify(audit), transportStatus,
        evidenceCoverage, status === "retry_required" ? "review_needed" : terminalUsability, materiality);
    this.db.prepare("UPDATE source_segments SET status=?,updated_at=? WHERE id=?")
      .run(["usable", "partial_usable", "non_material"].includes(status) ? "complete" : status === "review_needed" ? "failed" : status, timestamp, segmentId);
    if (row.asset_id && !["usable", "partial_usable", "non_material"].includes(status)) this.db.prepare("UPDATE source_assets SET extraction_status=?,extraction_error=? WHERE id=?")
      .run(status === "retry_required" ? "retry_required" : "failed", uncovered[0]?.reason || null, row.asset_id);
    const sourceState = this.reconcileSourceCoverageState(row.source_id);
    return { sourceId: row.source_id, segmentId, status, retryCount, claimCount: supportedClaims.length, uncovered, sourceState, ...audit };
  }

  sourceCoverageReady(sourceId) {
    return this.reconcileSourceCoverageState(sourceId).ready;
  }

  reconcileSourceCoverageState(sourceId) {
    const counts = this.db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN ec.publication_usability='usable' THEN 1 ELSE 0 END) AS usable,
      SUM(CASE WHEN ec.publication_usability='partial_usable' THEN 1 ELSE 0 END) AS partial_usable,
      SUM(CASE WHEN ec.publication_usability='non_material' THEN 1 ELSE 0 END) AS non_material,
      SUM(CASE WHEN ec.publication_usability='review_needed' AND ec.status='manual_review' THEN 1 ELSE 0 END) AS review_needed,
      SUM(CASE WHEN ec.publication_usability IN ('usable','partial_usable','non_material') OR ec.status='manual_review' THEN 1 ELSE 0 END) AS terminal
      FROM current_source_segments ss LEFT JOIN extraction_coverage ec ON ec.segment_id=ss.id WHERE ss.source_id=?`).get(sourceId);
    const total = Number(counts.total || 0);
    const usable = Number(counts.usable || 0);
    const partialUsable = Number(counts.partial_usable || 0);
    const nonMaterial = Number(counts.non_material || 0);
    const reviewNeeded = Number(counts.review_needed || 0);
    const manualReview = reviewNeeded; // Compatibility for the legacy localized exception message below.
    const terminal = Number(counts.terminal || 0);
    const ready = total > 0 && usable + partialUsable + nonMaterial === total;
    const complete = ready && partialUsable === 0;
    const settled = total > 0 && terminal === total;
    const timestamp = now();
    if (settled && reviewNeeded > 0) {
      const message = `覆盖审计在一次定向重试后仍发现未形成信息主张的重要证据，共 ${manualReview} 个分段需要人工检查。`;
      this.db.prepare("UPDATE sources SET status='exception',last_error=?,updated_at=? WHERE id=?")
        .run(message, timestamp, sourceId);
    } else {
      this.db.prepare(`UPDATE sources SET status='processing',last_error=NULL,updated_at=? WHERE id=?
        AND status='exception' AND (last_error LIKE 'Coverage audit still found material evidence without Claims%'
          OR last_error LIKE '覆盖审计在一次定向重试后仍发现未形成信息主张的重要证据%')`)
        .run(timestamp, sourceId);
    }
    return { total, usable, partialUsable, nonMaterial, reviewNeeded, terminal, ready, complete, settled };
  }

  reviewSegmentCoverage(sourceId, segmentId, { decision, note = "", operator = "administrator" } = {}) {
    if (!["retry", "not_material"].includes(decision)) throw new Error("Coverage review decision must be retry or not_material.");
    const row = this.db.prepare(`SELECT ss.*,ec.id AS coverage_id,ec.status AS coverage_status,ec.audit_json
      FROM current_source_segments ss JOIN extraction_coverage ec ON ec.segment_id=ss.id
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
          uncovered_spans_json='[]',audit_json=?,audited_at=?,evidence_coverage='not_applicable',
          publication_usability='non_material',materiality='non_material' WHERE id=?`).run(JSON.stringify(audit), timestamp, row.coverage_id);
        this.db.prepare("UPDATE source_segments SET status='complete',updated_at=? WHERE id=?").run(timestamp, segmentId);
        if (row.asset_id) this.db.prepare("UPDATE source_assets SET extraction_status='processed',extraction_error=NULL,processed_at=? WHERE id=?")
          .run(timestamp, row.asset_id);
      } else {
        this.db.prepare("UPDATE extraction_coverage SET status='retry_required',publication_usability='review_needed',audit_json=?,audited_at=? WHERE id=?")
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
    const rows = this.db.prepare(`SELECT ss.*,se.result_json,se.method,se.model FROM current_source_segments ss
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
        coverage: this.db.prepare("SELECT status,COUNT(*) count FROM current_extraction_coverage WHERE source_id=? GROUP BY status").all(sourceId) }), now(), sourceId);
    return { destinationSlug: primary.destination_slug, claimCount: claims.length };
  }

  getIntakePackage(sourceId) {
    const source = this.getSource(sourceId);
    if (!source?.structured) return null;
    const existingKnowledge=this.knowledgeForDestination(source.structured.destination_slug).slice(0,80).map((fact)=>({
      key:fact.normalized_key,subject:fact.subject,predicate:fact.predicate,preferred_value:fact.preferred_value,
      consensus_status:fact.consensus_status,confidence:fact.consensus_confidence,freshness:fact.freshness_state,
      evidence:(fact.evidence||[]).slice(0,2).map((item)=>({source_id:item.source_id,quote:String(item.quote||"").slice(0,200),
        confidence:item.confidence,observed_at:item.observed_at||item.published_at||null})),
    }));
    const result={
      strategy_version: this.strategyVersion,
      source: {
        id: source.id, title: source.title, captured_at: source.captured_at,
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
        source_quote: String(claim.source_quote || "").slice(0, 300),
      })),
      existing_knowledge:existingKnowledge,
    };
    const inputBytes=Buffer.byteLength(JSON.stringify(result));
    return {...result,input_telemetry:{projection:"compact_claim_evidence_v1",bytes:inputBytes,estimated_tokens:Math.ceil(inputBytes/3)}};
  }

  saveIntakeAnalysis(sourceId, analysis, model, { deferReconciliation = false } = {}) {
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
    // Diagnostics remain durable for every source. The Inbox receives only concrete,
    // actionable article proposals; knowledge-only and low-value classifications do not
    // masquerade as production work.
    if (normalized.classification === "ARTICLE_CANDIDATE" && normalized.recommended_action === "CREATE_CONTENT_PLAN") {
      this.upsertContentOpportunity(source.destination_slug, sourceId, recommendation, normalized, { status: "recommended" });
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
          reader_promise: path.reader_promise, evidence_boundary: path.evidence_boundary,
        }, { linkRecommendation: false, status: "recommended" });
      }
    }
    if (!deferReconciliation) {
      this.reconcileRecommendationInbox(source.destination_slug);
      this.refreshRecommendationBackfillRuns();
    }
    return this.getSource(sourceId).analysis;
  }

  promoteCompatibleIntakeAnalysis(sourceId, expectedStrategy) {
    const existing=this.db.prepare("SELECT strategy_version,analysis_json,model FROM content_intake_analyses WHERE source_id=?").get(sourceId);
    if (!existing || existing.strategy_version!==expectedStrategy
      || !isReusableDiagnosticStrategy(existing.strategy_version,this.strategyVersion)) return false;
    this.saveIntakeAnalysis(sourceId,json(existing.analysis_json,{}),
      existing.model || "reused-compatible-diagnostic",{deferReconciliation:true});
    return true;
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
    const listOpportunities = this.db.prepare(`SELECT id,title,status,readiness_json,coverage_json,candidate_id,destination_slug,content_type,source_id
      FROM content_opportunities WHERE recommendation_id=? ORDER BY created_at,id`);
    return rows.map((row) => hydrateRecommendation(row, listOpportunities.all(row.id)));
  }

  listContentOpportunities(limit = 100) {
    return this.db.prepare(`
      SELECT o.*, tc.coverage_score AS candidate_coverage_score, tc.status AS candidate_status
      FROM content_opportunities o LEFT JOIN topic_candidates tc ON tc.id=o.candidate_id
      WHERE o.recommendation_id IS NULL OR o.approved_at IS NOT NULL OR o.candidate_id IS NOT NULL
        OR o.status IN ('approved_waiting_for_evidence','approved_ready','producing','drafted','qa_failed','ready_for_wordpress','wordpress_draft','suppressed')
      ORDER BY CASE o.status WHEN 'recommended' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, o.readiness_score DESC, o.updated_at DESC
      LIMIT ?
    `).all(limit).map((row) => ({
      ...row,
      coverage: json(row.coverage_json, {}),
      readiness: json(row.readiness_json, {}),
      publicationImpact: json(row.publication_impact_json, {}),
    }));
  }

  listApprovedContentOpportunities(limit = 100) {
    return this.db.prepare(`
      SELECT o.id,o.candidate_id,o.destination_slug,o.content_type,o.title,o.status,o.lifecycle_state,
        o.approved_at,o.suppression_reason,o.readiness_score,o.readiness_json,o.coverage_json,o.updated_at,
        tc.coverage_score AS candidate_coverage_score,tc.status AS candidate_status
      FROM content_opportunities o LEFT JOIN topic_candidates tc ON tc.id=o.candidate_id
      WHERE o.approved_at IS NOT NULL
      ORDER BY o.updated_at DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(500, Number(limit) || 100))).map(({ coverage_json, readiness_json, ...row }) => ({
      ...row,
      coverage: json(coverage_json, {}),
      readiness: json(readiness_json, {}),
    }));
  }

  listProductionContentOpportunities(limit = 100) {
    return this.db.prepare(`
      SELECT o.id,o.candidate_id,o.destination_slug,o.content_type,o.title,o.status,o.lifecycle_state,
        o.approved_at,o.suppression_reason,o.readiness_score,o.readiness_json,o.coverage_json,o.updated_at,
        tc.coverage_score AS candidate_coverage_score,tc.status AS candidate_status
      FROM content_opportunities o JOIN topic_candidates tc ON tc.id=o.candidate_id
      WHERE o.lifecycle_state IN ('producing','finished')
        AND (EXISTS (SELECT 1 FROM jobs j WHERE j.entity_id=o.candidate_id AND j.type='plan_content')
          OR EXISTS (SELECT 1 FROM content_briefs cb WHERE cb.candidate_id=o.candidate_id)
          OR tc.status='brief_queued')
      ORDER BY o.updated_at DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(500, Number(limit) || 100))).map(({ coverage_json, readiness_json, ...row }) => ({
      ...row,
      coverage: json(coverage_json, {}),
      readiness: json(readiness_json, {}),
    }));
  }

  sourceProcessingState(sourceId,{requireDiagnostic=true}={}) {
    const source = this.db.prepare(`SELECT s.id,s.status,s.capture_version,s.completeness_status,
        s.recommendation_reconciled_version,s.recommendation_reconciled_at,
        (SELECT COUNT(*) FROM current_source_assets sa WHERE sa.source_id=s.id) AS media_count,
        (SELECT COUNT(*) FROM current_source_assets sa WHERE sa.source_id=s.id AND sa.durability_status='ORIGINAL_STORED') AS original_count,
        (SELECT status FROM experience_extraction_runs er WHERE er.source_id=s.id ORDER BY CASE er.status WHEN 'succeeded' THEN 0 ELSE 1 END,er.updated_at DESC,er.created_at DESC LIMIT 1) AS experience_status,
        (SELECT capture_version FROM experience_extraction_runs er WHERE er.source_id=s.id ORDER BY CASE er.status WHEN 'succeeded' THEN 0 ELSE 1 END,er.updated_at DESC,er.created_at DESC LIMIT 1) AS experience_capture_version,
        (SELECT degraded FROM experience_extraction_runs er WHERE er.source_id=s.id ORDER BY CASE er.status WHEN 'succeeded' THEN 0 ELSE 1 END,er.updated_at DESC,er.created_at DESC LIMIT 1) AS experience_degraded,
        (SELECT strategy_version FROM content_intake_analyses a WHERE a.source_id=s.id ORDER BY a.updated_at DESC LIMIT 1) AS analysis_strategy_version
      FROM sources s WHERE s.id=?`).get(sourceId);
    if (!source) return { state:"PROCESSING_GAP",gaps:["source_missing"],nextOwner:"system" };
    const gaps=[];
    if (source.completeness_status !== "complete") gaps.push("capture_incomplete");
    if (!['processed','needs_ai'].includes(source.status)) gaps.push("extraction_not_current");
    if (Number(source.media_count || 0) !== Number(source.original_count || 0)) gaps.push("media_originals_missing");
    if (source.experience_status !== "succeeded" || Number(source.experience_capture_version || 0) !== Number(source.capture_version || 0)
      || Boolean(source.experience_degraded)) gaps.push("experience_not_current");
    if (requireDiagnostic && source.analysis_strategy_version !== this.strategyVersion) gaps.push("diagnostic_not_current");
    return {
      state:gaps.length ? "PROCESSING_GAP" : "CURRENT",gaps,nextOwner:"system",
      captureVersion:Number(source.capture_version || 0),strategyVersion:this.strategyVersion,
      reconciledVersion:source.recommendation_reconciled_version || "",reconciledAt:source.recommendation_reconciled_at || null,
    };
  }

  reconcileRecommendationInbox(destinationSlug = null) {
    const clauses=["o.lifecycle_state IN ('recommended','recommended_again','deferred')"];
    const values=[];
    if (destinationSlug) { clauses.push("o.destination_slug=?"); values.push(destinationSlug); }
    const rows=this.db.prepare(`SELECT o.*,r.reasoning_summary,r.strategy_version AS recommendation_strategy_version
      FROM content_opportunities o LEFT JOIN content_recommendations r ON r.id=o.recommendation_id
      WHERE ${clauses.join(" AND ")} ORDER BY o.updated_at DESC,o.id`).all(...values);
    const sourceStateCache=new Map();
    const cachedSourceState=(sourceId,requireDiagnostic) => {
      const key=`${sourceId}:${requireDiagnostic ? "diagnostic" : "base"}`;
      if (!sourceStateCache.has(key)) sourceStateCache.set(key,this.sourceProcessingState(sourceId,{requireDiagnostic}));
      return sourceStateCache.get(key);
    };
    const evaluated=rows.map((row) => {
      const sourceIds=uniqueStrings([
        row.source_id,...json(row.source_ids_json,[]),...(json(row.coverage_json,{}).selectedSourceIds || []),
      ],10_000);
      const requireDiagnostic=Boolean(row.recommendation_id);
      const sourceStates=sourceIds.map((sourceId) => ({sourceId,...cachedSourceState(sourceId,requireDiagnostic)}));
      const versionCurrent=row.strategy_version===this.strategyVersion
        && (!row.recommendation_strategy_version || row.recommendation_strategy_version===this.strategyVersion);
      const processingGaps=sourceStates.filter((item) => item.state==="PROCESSING_GAP");
      const readiness=json(row.readiness_json,{});
      const processingState=!versionCurrent || processingGaps.length ? "PROCESSING_GAP" : readiness.ready ? "CURRENT" : "EVIDENCE_GAP";
      const lesson=row.lifecycle_state==="recommended_again" && row.last_failure_lesson_id
        ? this.db.prepare("SELECT retry_safe,status,remediation_rule,category FROM failure_lessons WHERE id=?").get(row.last_failure_lesson_id) : null;
      const retryEligible=row.lifecycle_state!=="recommended_again"
        || Boolean(lesson?.retry_safe && lesson?.status==="active" && String(lesson?.remediation_rule || "").trim());
      const eligible=versionCurrent && processingState!=="PROCESSING_GAP" && retryEligible
        && row.seo_action!=="SKIP" && !['knowledge_only','cluster','research_required','ignored','suppressed'].includes(row.status);
      return {row,sourceIds,sourceStates,processingState,processingGaps,versionCurrent,retryEligible,eligible,
        canonicalIntentKey:canonicalIntentKeyForOpportunity(row),lesson};
    });
    const groups=new Map();
    for (const item of evaluated.filter((entry) => entry.eligible)) {
      const list=groups.get(item.canonicalIntentKey) || [];
      list.push(item); groups.set(item.canonicalIntentKey,list);
    }
    const primaries=new Map();
    for (const [key,items] of groups) {
      items.sort((a,b) => recommendationInboxRank(b)-recommendationInboxRank(a)
        || String(b.row.updated_at).localeCompare(String(a.row.updated_at)) || a.row.id.localeCompare(b.row.id));
      primaries.set(key,items[0].row.id);
    }
    const timestamp=now();
    const updateOpportunity=this.db.prepare(`UPDATE content_opportunities SET processing_state=?,processing_detail_json=?,canonical_intent_key=?,
      inbox_state=?,primary_opportunity_id=?,recommendation_reconciled_version=?,recommendation_reconciled_at=? WHERE id=?`);
    const updateSource=this.db.prepare(`UPDATE sources SET recommendation_reconciled_version=?,recommendation_reconciled_at=? WHERE id=?`);
    transaction(this.db,() => {
      for (const item of evaluated) {
        const primaryId=primaries.get(item.canonicalIntentKey) || null;
        const inboxState=!item.versionCurrent || !item.retryEligible || item.row.seo_action==="SKIP" ? "SUPERSEDED"
          : !item.eligible ? "INTERNAL" : primaryId===item.row.id ? "ACTIONABLE" : "MERGED";
        const detail={versionCurrent:item.versionCurrent,gaps:item.processingGaps.map((entry) => ({sourceId:entry.sourceId,gaps:entry.gaps})),
          nextOwner:item.processingState==="PROCESSING_GAP" ? "system" : item.processingState==="EVIDENCE_GAP" ? "editor" : "editor",
          retryEligible:item.retryEligible};
        const detailJson=JSON.stringify(detail); const mergedPrimary=inboxState==="MERGED" ? primaryId : null;
        const changed=item.row.processing_state!==item.processingState || item.row.processing_detail_json!==detailJson
          || item.row.canonical_intent_key!==item.canonicalIntentKey || item.row.inbox_state!==inboxState
          || (item.row.primary_opportunity_id || null)!==mergedPrimary
          || item.row.recommendation_reconciled_version!==this.strategyVersion;
        if (changed) updateOpportunity.run(item.processingState,detailJson,item.canonicalIntentKey,inboxState,
          mergedPrimary,this.strategyVersion,timestamp,item.row.id);
      }
      const currentSources=new Map(evaluated.flatMap((item) => item.sourceStates.filter((state) => state.state==="CURRENT")
        .map((state) => [state.sourceId,state])));
      for (const [sourceId,state] of currentSources) if (state.reconciledVersion!==this.strategyVersion) {
        updateSource.run(this.strategyVersion,timestamp,sourceId);
      }
    });
    const activeEvaluated=evaluated.filter((item)=>item.versionCurrent);
    const stateCounts=(state) => activeEvaluated.filter((item) => item.processingState===state).length;
    return {
      internalOpportunities:activeEvaluated.length,
      actionableInbox:[...primaries.values()].length,
      processingGap:stateCounts("PROCESSING_GAP"),evidenceGap:stateCounts("EVIDENCE_GAP"),current:stateCounts("CURRENT"),
      merged:evaluated.filter((item) => item.eligible && primaries.get(item.canonicalIntentKey)!==item.row.id).length,
      superseded:evaluated.filter((item) => !item.versionCurrent || !item.retryEligible || item.row.seo_action==="SKIP").length,
    };
  }

  listRecommendationInbox(limit = 100,{reconcile=true,cursor=0}={}) {
    if (reconcile) this.reconcileRecommendationInbox();
    return this.db.prepare(`SELECT o.*,r.classification,r.recommended_action,r.reasoning_summary,
        s.title AS source_title,ss.destination_name
      FROM content_opportunities o
      LEFT JOIN content_recommendations r ON r.id=o.recommendation_id
      LEFT JOIN sources s ON s.id=o.source_id
      LEFT JOIN structured_sources ss ON ss.source_id=o.source_id
      WHERE o.inbox_state='ACTIONABLE'
      ORDER BY CASE o.lifecycle_state WHEN 'recommended_again' THEN 0 WHEN 'recommended' THEN 1 ELSE 2 END,
        o.readiness_score DESC,o.updated_at DESC LIMIT ? OFFSET ?`).all(Math.max(1,Math.min(500,Number(limit)||100)),Math.max(0,Number(cursor)||0))
      .map((row) => {
        const readiness=json(row.readiness_json,{}); const previousFailure=json(row.previous_failure_json,{});
        return { ...row,readiness,coverage:json(row.coverage_json,{}),publicationImpact:json(row.publication_impact_json,{}),
          processingDetail:json(row.processing_detail_json,{}),previousFailure,
          displayStatus:row.lifecycle_state==="recommended_again" ? "建议重新生产" : row.processing_state==="EVIDENCE_GAP" ? "等待关键证据" : "素材就绪",
          productionTypeLabel:recommendationProductionTypeLabel(row),
          recommendationReason:recommendationPlainReason(row,readiness),
          previousFailureSummary:previousFailure.category ? productionFailureChineseSummary(previousFailure) : null };
      });
  }

  retireRecommendationIntentVariants(opportunityId, timestamp = now()) {
    const selected=this.db.prepare("SELECT canonical_intent_key FROM content_opportunities WHERE id=?").get(opportunityId);
    if (!selected?.canonical_intent_key) return 0;
    return this.db.prepare(`UPDATE content_opportunities SET lifecycle_state='ignored',status='ignored',inbox_state='MERGED',
      primary_opportunity_id=?,suppression_reason='Merged with the decided canonical intent.',updated_at=?
      WHERE id<>? AND canonical_intent_key=? AND lifecycle_state IN ('recommended','recommended_again','deferred')`)
      .run(opportunityId,timestamp,opportunityId,selected.canonical_intent_key).changes;
  }

  decideOpportunity(opportunityId, decision, note = "") {
    if (!["approve","defer","ignore"].includes(decision)) throw new Error("Opportunity decision must be approve, defer, or ignore.");
    this.reconcileRecommendationInbox();
    const opportunity = this.db.prepare("SELECT * FROM content_opportunities WHERE id=?").get(opportunityId);
    if (!opportunity) return null;
    if (!["recommended","recommended_again","deferred"].includes(opportunity.lifecycle_state)) {
      return { opportunityId, decision, status:"skipped", queued:false, candidateId:opportunity.candidate_id || null };
    }
    if (opportunity.inbox_state !== "ACTIONABLE" || opportunity.processing_state === "PROCESSING_GAP") {
      throw conflictError("This opportunity is still being recalculated by the system and cannot receive an editorial decision yet.");
    }
    const timestamp = now();
    if (decision !== "approve") {
      const lifecycleState = decision === "defer" ? "deferred" : "ignored";
      const status = decision === "defer" ? "recommended" : "ignored";
      this.db.prepare("UPDATE content_opportunities SET lifecycle_state=?,status=?,suppression_reason=?,approved_at=NULL,updated_at=? WHERE id=?")
        .run(lifecycleState,status,String(note || "").slice(0,1000),timestamp,opportunityId);
      if (decision === "ignore") this.retireRecommendationIntentVariants(opportunityId,timestamp);
      return { opportunityId,decision,status:lifecycleState,queued:false,candidateId:null };
    }
    const readiness = json(opportunity.readiness_json,{});
    const ready = Boolean(readiness.ready);
    this.db.prepare("UPDATE content_opportunities SET lifecycle_state='approved',status=?,suppression_reason=NULL,approved_at=?,updated_at=? WHERE id=?")
      .run(ready ? "approved_ready" : "approved_waiting_for_evidence",timestamp,timestamp,opportunityId);
    this.retireRecommendationIntentVariants(opportunityId,timestamp);
    this.freezeOpportunityApproval(opportunityId);
    const reconciled = ready ? this.reconcileApprovedOpportunity(opportunityId) : { candidateId:null,queued:false };
    return { opportunityId,decision,status:ready ? "approved" : "approved_waiting_for_evidence",queued:Boolean(reconciled.queued),
      candidateId:reconciled.candidateId || null,needsEvidence:!ready,readiness };
  }

  dismissEditorialTopic(opportunityId) {
    const opportunity = this.db.prepare("SELECT * FROM content_opportunities WHERE id=?").get(opportunityId);
    if (!opportunity) return null;
    const timestamp = now();
    let productionContinues = false;
    if (opportunity.candidate_id) {
      const brief = this.db.prepare("SELECT id FROM content_briefs WHERE candidate_id=?").get(opportunity.candidate_id);
      const runningPlan = this.db.prepare("SELECT id FROM jobs WHERE type='plan_content' AND entity_id=? AND status='running'")
        .get(opportunity.candidate_id);
      if (brief || runningPlan) {
        productionContinues = true;
      } else {
        this.db.prepare("DELETE FROM jobs WHERE type='plan_content' AND entity_id=? AND status='queued'")
          .run(opportunity.candidate_id);
        this.db.prepare("UPDATE topic_candidates SET status='dismissed',suppression_reason='operator_removed_from_topic_list',updated_at=? WHERE id=?")
          .run(timestamp, opportunity.candidate_id);
      }
    }
    this.db.prepare("UPDATE content_opportunities SET status=?,suppression_reason='operator_removed_from_topic_list',updated_at=? WHERE id=?")
      .run(productionContinues ? "suppressed" : "ignored", timestamp, opportunityId);
    return {
      id: opportunityId,
      removed: true,
      productionContinues,
      message: productionContinues
        ? "选题已从清单归档；已经开始生成的写作准备记录或草稿继续保留，避免误删成果。"
        : "选题已从清单移除，尚未开始的文章创建任务已撤销。",
    };
  }

  setOpportunityLifecycle(opportunityId, action, { targetPostId = null, note = "", operator = "administrator" } = {}) {
    const allowed = new Set(["create", "update", "expand", "merge", "retire"]);
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
    const storedAction=action === "expand" ? "update" : action;
    const seoAction={create:"NEW",update:"UPDATE",expand:"EXPAND",merge:"MERGE",retire:"SKIP"}[action];
    this.db.prepare(`UPDATE content_opportunities
      SET lifecycle_action=?,seo_action=?,target_post_id=?,publication_impact_json=?,updated_at=? WHERE id=?`)
      .run(storedAction,seoAction,target?.post_id || null,JSON.stringify(impact),impact.decidedAt,opportunityId);
    return {
      id: opportunityId,
      lifecycleAction: action,
      seoAction,
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
    this.reconcileRecommendationInbox(recommendation.destination_slug);
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
    const lifecycleState = decision === "approved_article" ? "approved"
      : decision === "ignored" ? "ignored" : "deferred";
    this.db.prepare("UPDATE content_opportunities SET status=?,lifecycle_state=?,approved_at=?,updated_at=? WHERE id=?")
      .run(opportunityStatus,lifecycleState,decision === "approved_article" ? timestamp : null,timestamp,opportunity.id);
    if (decision === "approved_article" || decision === "ignored") this.retireRecommendationIntentVariants(opportunity.id,timestamp);
    if (decision === "approved_article") this.freezeOpportunityApproval(opportunity.id);
    const reconciled = decision === "approved_article" && ready ? this.reconcileApprovedOpportunity(opportunity.id) : { candidateId: null, queued: false };
    return {
      recommendationId, opportunityId: opportunity.id, decision, status: opportunityStatus,
      queued: Boolean(reconciled.queued), candidateId: reconciled.candidateId || null,
      needsEvidence: decision === "approved_article" && !ready, readiness,
    };
  }

  freezeOpportunityApproval(opportunityId) {
    const row = this.db.prepare("SELECT * FROM content_opportunities WHERE id=?").get(opportunityId);
    if (!row) throw conflictError("创作方向不存在。");
    const coverage = json(row.coverage_json, {});
    if (!coverage.approval) coverage.approval = freezeProposal(row);
    this.db.prepare("UPDATE content_opportunities SET coverage_json=? WHERE id=?").run(JSON.stringify(coverage), opportunityId);
    return coverage.approval;
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
    const topicKey = `${baseTopicKey}:mode:${publicationMode}:source:${sha256(sourceId).slice(0, 12)}`;
    const opportunityId = `opportunity_${sha256(topicKey).slice(0, 24)}`;
    const existingApproved = this.db.prepare("SELECT id FROM content_opportunities WHERE id=? AND approved_at IS NOT NULL").get(opportunityId);
    if (existingApproved) return existingApproved.id;
    const allFacts = this.knowledgeForDestination(destinationSlug);
    const sourceFacts = factsForSource(allFacts, sourceId);
    const facts = ["source_adaptation", "topic_feature"].includes(publicationMode) && sourceFacts.length
      ? sourceFacts : scopeFactsForOpportunity(allFacts, { destinationSlug, topic, title });
    const familyCount = this.independentSourceFamilyCountForFacts(facts);
    const matrix = evaluateCoverage({ topicKey, contentType, facts, sourceFamilyCount: familyCount, publicationMode });
    const matchingPath = (analysis.production_paths || []).find(path => path.title === title && normalizePublicationMode(path.mode) === publicationMode);
    const coverage = { ...matrix, publicationMode, editorialProposalOnly: !overrides.candidateId,
      proposal: { readerPromise: analysis.reader_promise || matchingPath?.reader_promise || title,
      evidenceBoundary: analysis.evidence_boundary || matchingPath?.evidence_boundary || "", targetEntities: [] }, selectedFactKeys: facts.map((fact) => fact.normalized_key),
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
        strategy_version=excluded.strategy_version,source_id=excluded.source_id,
        title=excluded.title, content_type=excluded.content_type, readiness_score=excluded.readiness_score,
        readiness_json=excluded.readiness_json,coverage_json=excluded.coverage_json,
        status=CASE WHEN content_opportunities.status IN ('approved_waiting_for_evidence','approved_ready','producing','drafted','qa_failed','ready_for_wordpress','wordpress_draft','suppressed') THEN content_opportunities.status ELSE excluded.status END,
        source_ids_json=CASE WHEN instr(content_opportunities.source_ids_json, excluded.source_id)>0 THEN content_opportunities.source_ids_json ELSE json_insert(content_opportunities.source_ids_json,'$[#]',excluded.source_id) END,
        lifecycle_action=excluded.lifecycle_action,target_post_id=excluded.target_post_id,
        publication_impact_json=excluded.publication_impact_json,updated_at=excluded.updated_at
    `).run(opportunityId,destinationSlug,JSON.stringify([destinationSlug]),topicKey,this.strategyVersion,sourceId,JSON.stringify([sourceId]),recommendation.id,candidateId,
      title,contentType,matrix.readiness.score,JSON.stringify(matrix.readiness),JSON.stringify(coverage),status,timestamp,timestamp,
      lifecycle.action,lifecycle.targetPostId,JSON.stringify(lifecycle.impact));
    this.db.prepare("UPDATE content_opportunities SET seo_action=? WHERE id=?")
      .run(lifecycle.seoAction,opportunityId);
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
    return new Set((facts || []).flatMap(independentEvidenceKeysForFact)).size;
  }

  completedOpportunityFacts(facts) {
    const completed=new Set(this.db.prepare(`SELECT s.id FROM sources s
      WHERE s.completeness_status='complete' AND s.status IN ('processed','needs_ai')
        AND NOT EXISTS (SELECT 1 FROM current_source_assets a WHERE a.source_id=s.id AND a.durability_status<>'ORIGINAL_STORED')
        AND EXISTS (SELECT 1 FROM experience_extraction_runs er WHERE er.source_id=s.id AND er.capture_version=s.capture_version
          AND er.status='succeeded' AND er.degraded=0)`).all().map((row)=>row.id));
    return (facts || []).map((fact)=>({...fact,consensus_detail:{},
      evidence:(fact.evidence || []).filter((item)=>completed.has(item.source_id))}))
      .filter((fact)=>fact.evidence.length>0);
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
          JSON.stringify(values.map((item) => item.normalized_key)),
          JSON.stringify([...new Set(values.flatMap(independentEvidenceKeysForFact))]), timestamp);
    }
    return grouped.size;
  }

  rebuildKnowledgeOpportunities(destinationSlug) {
    const factsByKey = new Map(this.completedOpportunityFacts(this.knowledgeForDestination(destinationSlug))
      .map((fact) => [fact.normalized_key,fact]));
    const clusters = this.db.prepare(`SELECT * FROM topic_clusters WHERE destination_slug=? ORDER BY topic_key`).all(destinationSlug);
    const timestamp = now();
    let created = 0;
    let refreshed = 0;
    let retired = 0;
    for (const cluster of clusters) {
      const facts = json(cluster.claim_keys_json,[]).map((key) => factsByKey.get(key)).filter(Boolean);
      const sourceFamilyIds = [...new Set(facts.flatMap(independentEvidenceKeysForFact))];
      const sourceIds = [...new Set(facts.flatMap((fact) => (fact.evidence || []).map((item) => item.source_id)).filter(Boolean))];
      const usableFacts = facts.filter((fact) => fact.consensus_status !== "conflicted"
        && ["current","unknown"].includes(fact.validity_state || "unknown"));
      const actionability = usableFacts.length >= 2 && sourceFamilyIds.length >= 2;
      const topicKey = `${destinationSlug}:knowledge:${slugify(cluster.title || cluster.topic_key) || sha256(cluster.topic_key).slice(0,12)}`;
      const opportunityId = `opportunity_${sha256(topicKey).slice(0,24)}`;
      const existing = this.db.prepare("SELECT id,lifecycle_state,status FROM content_opportunities WHERE topic_key=?").get(topicKey);
      if (!actionability) {
        if (existing && ["recommended","deferred"].includes(existing.lifecycle_state)) {
          this.db.prepare(`UPDATE content_opportunities SET status='suppressed',suppression_reason='knowledge_cluster_no_longer_actionable',updated_at=? WHERE id=?`)
            .run(timestamp,existing.id);
          retired += 1;
        }
        continue;
      }
      const contentType = inferKnowledgeOpportunityType(cluster.title,facts);
      const title = `${cluster.title}: a practical guide for independent travelers`;
      const matrix = evaluateCoverage({topicKey,contentType,facts:usableFacts,sourceFamilyCount:sourceFamilyIds.length,
        publicationMode:"multi_source_synthesis"});
      const coverage = { ...matrix,publicationMode:"multi_source_synthesis",knowledgeEventGenerated:true,
        proposal:{readerPromise:`Help an independent traveler make a confident decision about ${cluster.title}.`,
          evidenceBoundary:`Use only the ${usableFacts.length} current, traceable facts in this knowledge cluster.`,targetEntities:[cluster.title]},
        selectedFactKeys:usableFacts.map((fact) => fact.normalized_key),selectedSourceIds:sourceIds };
      const lifecycle = this.classifyPublicationLifecycle(title);
      this.db.prepare(`INSERT INTO content_opportunities(id,destination_slug,destination_scopes_json,topic_key,strategy_version,
        source_id,source_ids_json,recommendation_id,candidate_id,title,content_type,readiness_score,readiness_json,coverage_json,status,
        approved_at,created_at,updated_at,lifecycle_action,target_post_id,publication_impact_json)
        VALUES (?,?,?,?,?,NULL,?,NULL,NULL,?,?,?,?,?,'recommended',NULL,?,?,?,?,?)
        ON CONFLICT(topic_key) DO UPDATE SET strategy_version=excluded.strategy_version,
          source_ids_json=excluded.source_ids_json,title=excluded.title,content_type=excluded.content_type,
          readiness_score=excluded.readiness_score,readiness_json=excluded.readiness_json,coverage_json=excluded.coverage_json,
          suppression_reason=CASE WHEN content_opportunities.suppression_reason='knowledge_cluster_no_longer_actionable' THEN NULL ELSE content_opportunities.suppression_reason END,
          status=CASE WHEN content_opportunities.status='suppressed' AND content_opportunities.suppression_reason='knowledge_cluster_no_longer_actionable'
            THEN 'recommended' ELSE content_opportunities.status END,updated_at=excluded.updated_at`)
        .run(opportunityId,destinationSlug,JSON.stringify([destinationSlug]),topicKey,this.strategyVersion,JSON.stringify(sourceIds),
          title,contentType,matrix.readiness.score,JSON.stringify(matrix.readiness),JSON.stringify(coverage),timestamp,timestamp,
          lifecycle.action,lifecycle.targetPostId,JSON.stringify(lifecycle.impact));
      this.db.prepare("UPDATE content_opportunities SET seo_action=? WHERE id=?")
        .run(lifecycle.seoAction,opportunityId);
      this.saveCoverageMatrix(matrix,destinationSlug);
      if (existing) refreshed += 1; else created += 1;
    }
    this.reconcileRecommendationInbox(destinationSlug);
    return {clusters:clusters.length,created,refreshed,retired};
  }

  rebuildCoverageMatrices(destinationSlug,{changedFactKeys=null}={}) {
    const startedAt=Date.now();
    const allFacts = this.knowledgeForDestination(destinationSlug);
    const completedFacts = this.completedOpportunityFacts(allFacts);
    const allOpportunities = this.db.prepare("SELECT * FROM content_opportunities WHERE destination_slug=?").all(destinationSlug);
    const changed=new Set((changedFactKeys||[]).filter(Boolean));
    const changedFacts=changed.size?allFacts.filter((fact)=>changed.has(fact.normalized_key)):[];
    const opportunities=!changed.size?allOpportunities:allOpportunities.filter((opportunity)=>{
      if(String(opportunity.topic_key||"").includes(":knowledge:"))return changedFacts.some((fact)=>{
        const subject=slugify(fact.subject||fact.canonical_subject||"");
        return subject&&(`${opportunity.topic_key} ${opportunity.title||""}`.toLowerCase().replace(/_/gu,"-").includes(subject));
      });
      const previous=json(opportunity.coverage_json,{});
      if((previous.selectedFactKeys||[]).some((key)=>changed.has(key)))return true;
      return changedFacts.some((fact)=>factCouldAffectOpportunity(fact,opportunity,destinationSlug));
    });
    for (const opportunity of opportunities) {
      const previousCoverage = json(opportunity.coverage_json, {});
      const publicationMode = normalizePublicationMode(previousCoverage.publicationMode);
      if (previousCoverage.manualAssignmentId) continue; // Manual scope is rebuilt only by its own evaluator.
      const sourceFacts = factsForSource(allFacts, opportunity.source_id);
      const facts = ["source_adaptation", "topic_feature"].includes(publicationMode) && sourceFacts.length
        ? sourceFacts : scopeFactsForOpportunity(completedFacts, { destinationSlug, topic: opportunity.topic_key, title: opportunity.title });
      const familyCount = this.independentSourceFamilyCountForFacts(facts);
      const matrix = evaluateCoverage({ topicKey: opportunity.topic_key, contentType: opportunity.content_type, facts, sourceFamilyCount: familyCount, publicationMode });
      const coverage = { ...previousCoverage, ...matrix, publicationMode, selectedFactKeys: facts.map((fact) => fact.normalized_key),
        selectedSourceIds: [...new Set(facts.flatMap((fact) => (fact.evidence || []).map((item) => item.source_id)).filter(Boolean))] };
      this.saveCoverageMatrix(matrix, destinationSlug);
      const current = opportunity.status;
      const next = current === "approved_waiting_for_evidence" && matrix.readiness.ready ? "approved_ready" : current;
      this.db.prepare("UPDATE content_opportunities SET readiness_score=?,readiness_json=?,coverage_json=?,status=?,updated_at=? WHERE id=?")
        .run(matrix.readiness.score, JSON.stringify(matrix.readiness), JSON.stringify(coverage), next, now(), opportunity.id);
    }
    this.reconcileRecommendationInbox(destinationSlug);
    this.lastCoverageRebuildTelemetry={destinationSlug,mode:changed.size?'incremental':'full',changedFactCount:changed.size,
      scannedOpportunityCount:allOpportunities.length,updatedOpportunityCount:opportunities.length,durationMs:Date.now()-startedAt};
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
    // Published-content overlap is represented as an explicit SEO action on the
    // opportunity. It never silently suppresses an approved editorial decision.
    const candidateId = opportunity.candidate_id || `topic_${sha256(opportunity.topic_key).slice(0, 24)}`;
    const timestamp = now();
    this.db.prepare(`INSERT INTO topic_candidates(id,destination_slug,topic_key,proposed_title,rationale,coverage_score,evidence_count,conflict_count,stale_fact_count,verification_fact_count,strategy_version,created_at,updated_at,opportunity_id,recommendation_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(topic_key) DO UPDATE SET opportunity_id=excluded.opportunity_id,
      recommendation_id=excluded.recommendation_id,coverage_score=excluded.coverage_score,updated_at=excluded.updated_at`)
      .run(candidateId, opportunity.destination_slug, opportunity.topic_key, opportunity.title,
        `Approved Strategy 1.4 opportunity with ${readiness.factCount || 0} facts from ${readiness.sourceFamilyCount || 0} independent source families.`,
        readiness.score || 0, readiness.sourceFamilyCount || 0, readiness.conflictedCount || 0, readiness.staleCount || 0,
        readiness.requiresOfficialCount || 0, this.strategyVersion, timestamp, timestamp, opportunityId, opportunity.recommendation_id);
    this.db.prepare("UPDATE content_opportunities SET candidate_id=?,status='producing',lifecycle_state='producing',updated_at=? WHERE id=?").run(candidateId, timestamp, opportunityId);
    this.db.prepare("UPDATE content_recommendations SET approved_candidate_id=?,opportunity_id=?,updated_at=? WHERE id=?")
      .run(candidateId, opportunityId, timestamp, opportunity.recommendation_id);
    return { candidateId, queued: this.queueCandidate(candidateId) };
  }

  reconcileApprovedOpportunities(destinationSlug = null) {
    const rows = destinationSlug
      ? this.db.prepare("SELECT id,destination_slug,status FROM content_opportunities WHERE destination_slug=? AND status IN ('approved_waiting_for_evidence','approved_ready')").all(destinationSlug)
      : this.db.prepare("SELECT id,destination_slug,status FROM content_opportunities WHERE status IN ('approved_waiting_for_evidence','approved_ready')").all();
    // A coverage rebuild already updates every opportunity in the destination. Repeating
    // that full scan for each waiting opportunity makes startup quadratic and can delay
    // the HTTP listener for minutes on a mature destination knowledge base.
    const destinationsToRebuild = new Set(rows
      .filter((row) => row.status === "approved_waiting_for_evidence")
      .map((row) => row.destination_slug));
    for (const slug of destinationsToRebuild) this.rebuildCoverageMatrices(slug);
    const results = [];
    for (const row of rows) results.push(this.reconcileApprovedOpportunity(row.id));
    return results;
  }

  listSources(limit = 100) {
    const sources = this.db.prepare(`
      SELECT s.id, s.adapter, s.external_id, s.title, s.author_name, s.canonical_url, s.submitted_url, s.source_kind,
        s.status, s.last_error, s.captured_at, s.updated_at, s.capture_version, s.authority_level, s.verified_at,
        s.completeness_status,s.completeness_json,
        ss.destination_name, ss.summary, ss.extraction_method,
        (SELECT COUNT(*) FROM claims c WHERE c.source_id = s.id) AS claim_count,
        (SELECT COUNT(*) FROM current_source_files sf WHERE sf.source_id = s.id) AS file_count,
        (SELECT COUNT(*) FROM current_source_segments sg WHERE sg.source_id = s.id) AS segment_count,
        (SELECT COUNT(*) FROM segment_extractions se JOIN current_source_segments csg ON csg.id=se.segment_id WHERE se.source_id = s.id) AS extracted_segment_count,
        (SELECT COUNT(*) FROM current_extraction_coverage ec WHERE ec.source_id = s.id AND ec.audited_at IS NOT NULL) AS audited_segment_count
        ,(SELECT COUNT(*) FROM current_source_assets sa WHERE sa.source_id=s.id) AS discovered_media_count
        ,(SELECT COUNT(*) FROM current_source_assets sa WHERE sa.source_id=s.id AND sa.durability_status='ORIGINAL_STORED') AS stored_original_count
        ,(SELECT COUNT(*) FROM current_source_assets sa WHERE sa.source_id=s.id AND sa.repair_status='browser_repair_required') AS browser_repair_count
        ,(SELECT COUNT(*) FROM current_source_assets sa WHERE sa.source_id=s.id AND sa.repair_status IN ('server_recovery_pending','server_recovery_running')) AS server_repair_count
        ,(SELECT status FROM experience_extraction_runs er WHERE er.source_id=s.id AND er.capture_version=s.capture_version ORDER BY er.updated_at DESC,er.created_at DESC LIMIT 1) AS experience_status
        ,(SELECT degraded FROM experience_extraction_runs er WHERE er.source_id=s.id AND er.capture_version=s.capture_version ORDER BY er.updated_at DESC,er.created_at DESC LIMIT 1) AS experience_degraded
      FROM sources s LEFT JOIN structured_sources ss ON ss.source_id = s.id
      ORDER BY s.captured_at DESC, s.id DESC LIMIT ?
    `).all(limit);
    const queueJobs = this.db.prepare(`
      SELECT j.id,j.type,j.entity_id,j.status,j.attempts,j.max_attempts,j.available_at,j.next_eligible_at,j.created_at,j.started_at,j.updated_at,j.last_error,
        j.execution_route,j.failure_class,j.batch_attempts,j.last_failure_code,
        COALESCE(sg.source_id,mb.source_id,j.entity_id) AS source_id
      FROM jobs j LEFT JOIN source_segments sg ON sg.id=j.entity_id
      LEFT JOIN media_extraction_batches mb ON mb.id=j.entity_id
      WHERE j.type IN ('extract_source','preflight_source','segment_source','extract_segment_claims',
        'extract_media_batch','audit_segment_coverage','retry_segment_extraction','finalize_source_extraction')
        AND j.status IN ('queued','running','failed')
        AND (sg.source_id IS NOT NULL OR mb.source_id IS NOT NULL OR EXISTS (SELECT 1 FROM sources direct_source WHERE direct_source.id=j.entity_id))
    `).all();
    const queueStates = sourceQueueStates(queueJobs);
    return sources.map((source, index) => {
      const queue = queueStates.get(source.id) || null;
      const completeness = json(source.completeness_json, {});
      return { ...source, list_number: index + 1, authority_suggestion: suggestAuthority(source.canonical_url),
        discovery_summary: { text: Boolean(completeness.text?.complete), dom: Boolean(completeness.dom?.complete),
          images: completeness.images || {}, videos: completeness.videos || {} },
        media_durability_status: Number(source.discovered_media_count) === Number(source.stored_original_count) ? "ORIGINAL_STORED"
          : Number(source.browser_repair_count) ? "BROWSER_REPAIR_REQUIRED" : "INCOMPLETE",
        queue: source.status === "processed" && queue?.state === "failed" ? null : queue };
    });
  }

  listSourceStatusProjection({limit=100,ids=[]}={}) {
    const sourceIds=[...new Set((ids||[]).map(String).filter(Boolean))].slice(0,200);
    const where=sourceIds.length?`WHERE s.id IN (${sourceIds.map(()=>"?").join(",")})`:"";
    const rows=this.db.prepare(`SELECT s.id,s.status,s.last_error,s.capture_version,s.updated_at,s.captured_at,
        s.extension_version,s.completeness_status,
        COALESCE(json_extract(s.submission_metadata_json,'$.processingEstimate.processingClass'),
          CASE WHEN json_extract(s.submission_metadata_json,'$.processingEstimate.requiresManualStart')=1 THEN 'heavy' ELSE 'normal' END) AS processing_class,
        (SELECT COUNT(*) FROM current_source_assets a WHERE a.source_id=s.id) AS media_count,
        (SELECT COUNT(*) FROM current_source_assets a WHERE a.source_id=s.id AND a.durability_status='ORIGINAL_STORED') AS media_ready_count,
        (SELECT COUNT(*) FROM current_source_segments sg WHERE sg.source_id=s.id) AS segment_count,
        (SELECT COUNT(*) FROM segment_extractions se JOIN current_source_segments sg ON sg.id=se.segment_id WHERE sg.source_id=s.id) AS extracted_segment_count,
        (SELECT COUNT(*) FROM current_extraction_coverage ec WHERE ec.source_id=s.id AND ec.audited_at IS NOT NULL) AS audited_segment_count,
        (SELECT status FROM experience_extraction_runs er WHERE er.source_id=s.id AND er.capture_version=s.capture_version ORDER BY er.updated_at DESC LIMIT 1) AS experience_status,
        (SELECT degraded FROM experience_extraction_runs er WHERE er.source_id=s.id AND er.capture_version=s.capture_version ORDER BY er.updated_at DESC LIMIT 1) AS experience_degraded,
        EXISTS(SELECT 1 FROM experience_extraction_runs er WHERE er.source_id=s.id AND er.status='succeeded' AND er.capture_version<>s.capture_version) AS stale_experience
      FROM sources s ${where} ORDER BY s.updated_at DESC,s.id LIMIT ?`).all(...sourceIds,Math.max(1,Math.min(500,Number(limit)||100)));
    if(!rows.length)return [];
    const wanted=new Set(rows.map((row)=>row.id));
    const jobs=this.db.prepare(`SELECT j.id,j.type,j.status,j.attempts,j.max_attempts,j.available_at,j.started_at,j.updated_at,j.last_error,
        j.execution_route,j.workload_class,j.recovery_run_id,j.last_failure_code,COALESCE(sg.source_id,mb.source_id,direct.id) AS source_id
      FROM jobs j
      LEFT JOIN source_segments sg ON sg.id=j.entity_id
      LEFT JOIN media_extraction_batches mb ON mb.id=j.entity_id
      LEFT JOIN sources direct ON direct.id=j.entity_id
      WHERE j.status IN ('queued','running','failed')
        AND j.type IN ('extract_source','preflight_source','segment_source','extract_segment_claims','extract_media_batch',
          'audit_segment_coverage','retry_segment_extraction','finalize_source_extraction') ORDER BY j.updated_at DESC`).all()
      .filter((job)=>wanted.has(job.source_id));
    const states=sourceQueueStates(jobs);
    return rows.map((row)=>{
      const queue=states.get(row.id)||null;
      const currentQueue=row.status==="processed"&&queue?.state==="failed"?null:queue;
      return {...row,experience_degraded:Boolean(row.experience_degraded),stale_experience:Boolean(row.stale_experience),
        queue:currentQueue,current_stage:currentQueue?.stage||sourceStageFromProjection(row)};
    });
  }

  sourceTimeline(sourceId,limit=100) {
    if(!this.db.prepare("SELECT 1 FROM sources WHERE id=?").get(sourceId))return [];
    const captures=this.db.prepare(`SELECT 'capture' AS kind,'capture_saved' AS stage,'succeeded' AS status,
        captured_at AS occurred_at,capture_version AS version,NULL AS detail FROM capture_versions WHERE source_id=?`).all(sourceId);
    const jobs=this.db.prepare(`SELECT 'job' AS kind,j.type AS stage,j.status,j.updated_at AS occurred_at,
        NULL AS version,COALESCE(j.last_failure_code,j.last_error) AS detail
      FROM jobs j LEFT JOIN source_segments sg ON sg.id=j.entity_id LEFT JOIN media_extraction_batches mb ON mb.id=j.entity_id
      WHERE j.entity_id=? OR sg.source_id=? OR mb.source_id=?`).all(sourceId,sourceId,sourceId);
    return [...captures,...jobs].sort((a,b)=>String(b.occurred_at).localeCompare(String(a.occurred_at)))
      .slice(0,Math.max(1,Math.min(500,Number(limit)||100)));
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
          source_quote_start, source_quote_end, source_quote_status,
          observed_at, valid_from, valid_to, date_kind, date_confidence)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        const claimObservedAt = validEvidenceDate(claim.observed_at);
        const claimValidFrom = validEvidenceDate(claim.valid_from);
        const claimValidTo = validEvidenceDate(claim.valid_to);
        const claimDateKind = claimValidFrom ? "valid_from" : claimObservedAt ? "observed_at" : "unknown";
        const claimDateConfidence = claimDateKind === "unknown" ? "unknown" : normalizeDateConfidence(claim.date_confidence);
        insertClaim.run(
          id("claim"), sourceId, normalizedKey, claim.subject, claim.predicate, claim.value,
          JSON.stringify(claim.qualifiers), locatedQuote.quote, claim.confidence, timestamp, normalizedKey,
          inferredEntity.entityKey, inferredEntity.canonicalSubject, JSON.stringify(inferredEntity.aliases), inferredEntity.status,
          entityMetadata.entityType, entityMetadata.granularity, JSON.stringify(entityMetadata.location),
          JSON.stringify(structured), JSON.stringify(structured.scope), structured.claim_kind, structured.cardinality,
          extractionRunId, extractionRevision,
          claimRole, knowledgeEligible ? 1 : 0, locatedQuote.start, locatedQuote.end, locatedQuote.status,
          claimObservedAt, claimValidFrom, claimValidTo, claimDateKind, claimDateConfidence,
        );
      }
      this.db.prepare(`UPDATE sources SET date_kind=CASE WHEN published_at IS NOT NULL THEN 'published_at' ELSE date_kind END,
        date_confidence=CASE WHEN published_at IS NOT NULL THEN 'medium' ELSE date_confidence END WHERE id=?`).run(sourceId);
      this.db.prepare(`UPDATE claims SET observed_at=COALESCE(claims.observed_at,(SELECT observed_at FROM sources WHERE id=?)),
        temporal_confidence=CASE WHEN claims.observed_at IS NOT NULL THEN claims.date_confidence WHEN (SELECT published_at FROM sources WHERE id=?) IS NULL THEN 'unknown' ELSE 'medium' END,
        date_kind=CASE WHEN claims.date_kind<>'unknown' THEN claims.date_kind WHEN (SELECT published_at FROM sources WHERE id=?) IS NULL THEN 'unknown' ELSE 'published_at' END,
        date_confidence=CASE WHEN claims.date_confidence<>'unknown' THEN claims.date_confidence WHEN (SELECT published_at FROM sources WHERE id=?) IS NULL THEN 'unknown' ELSE 'medium' END,
        source_authority_level=(SELECT authority_level FROM sources WHERE id=?) WHERE source_id=?`)
        .run(sourceId, sourceId, sourceId, sourceId, sourceId, sourceId);
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

  getEntityResolutionPackage(destinationSlug, limit = 300, cursor = null) {
    const pageSize = Math.max(1, Math.min(1_000, Number(limit || 300)));
    const rows = this.db.prepare(`
      SELECT c.id, c.normalized_key, c.original_normalized_key, c.subject, c.predicate, c.value_text,
        c.source_quote, c.confidence, c.entity_key, c.canonical_subject, c.entity_aliases_json,
        c.entity_type, c.granularity, c.entity_location_json,
        s.captured_at, s.title AS source_title
      FROM claims c JOIN structured_sources ss ON ss.source_id=c.source_id
      JOIN sources s ON s.id=c.source_id
      WHERE ss.destination_slug=? AND c.knowledge_eligible=1 AND c.lifecycle_status='active'
        AND (? IS NULL OR c.id>?)
      ORDER BY c.id LIMIT ?
    `).all(destinationSlug, cursor, cursor, pageSize + 1);
    const page = rows.slice(0, pageSize);
    const destination = this.db.prepare("SELECT name FROM destinations WHERE slug=?").get(destinationSlug);
    return {
      destination: { slug: destinationSlug, name: destination?.name || destinationSlug },
      claims: page.map((row) => ({
        id: row.id, key: row.normalized_key, original_key: row.original_normalized_key || row.normalized_key,
        subject: row.subject, predicate: row.predicate, value: row.value_text, source_quote: row.source_quote,
        confidence: row.confidence, current_entity_key: row.entity_key || null,
        current_canonical_subject: row.canonical_subject || null, current_aliases: json(row.entity_aliases_json, []),
        entity_type: row.entity_type, granularity: row.granularity, location: json(row.entity_location_json, {}),
        captured_at: row.captured_at, source_title: row.source_title,
      })),
      known_aliases: this.listEntityAliases(destinationSlug),
      nextCursor: rows.length > pageSize ? page.at(-1)?.id || null : null,
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
      // Model-proposed aliases are candidates until a source-grounded Claim
      // update proves the identity. Do not populate the alias registry here.
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
          proposed_granularity: metadata.granularity, candidateLocation: json(row.entity_location_json, {}),
          proposedLocation: metadata.location, confidence: item.confidence,
          identityEvidence: this.hasSourceAliasEvidence(row, canonicalSubject),
        });
        if (assessment.decision !== "MERGE") {
          if (row.entity_key && row.entity_key !== entityKey) this.upsertEntityRelation(destinationSlug, row.entity_key, assessment.suggestedRelation || 'related_to', entityKey, "model", Number(item.confidence), assessment.reasons.join("; "));
          continue;
        }
        const identity = entities.get(entityKey) || { entityKey, canonicalSubject, aliases: uniqueEntityAliases([canonicalSubject, row.subject]), status: "resolved", ...metadata };
        identity.aliases = uniqueEntityAliases([canonicalSubject, row.subject]);
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

  hasSourceAliasEvidence(claim, canonicalSubject) {
    const existing = this.db.prepare("SELECT 1 FROM entity_aliases WHERE alias_normalized=? AND canonical_subject=? AND resolution_source='manual'")
      .get(normalizeEntityAlias(claim.subject),canonicalSubject);
    if (existing) return true;
    const source = this.db.prepare('SELECT raw_text FROM sources WHERE id=?').get(claim.source_id);
    const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const alias = escape(claim.subject), canonical = escape(canonicalSubject);
    return new RegExp(`${alias}\\s*[（(]\\s*${canonical}\\s*[）)]|${canonical}\\s*[（(]\\s*${alias}\\s*[）)]`, 'iu').test(source?.raw_text || '');
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
        s.adapter AS source_adapter, s.author_name AS source_author_name, s.author_url AS source_author_url,
        s.original_url AS source_original_url, s.final_url AS source_final_url,
        s.source_identity, s.source_publisher, s.submitted_by,
        s.completeness_status AS source_completeness_status,
        (SELECT group_concat(sfm.family_id, '|') FROM source_family_memberships sfm
          WHERE sfm.source_id=s.id AND sfm.relation_type IN ('EXACT_DUPLICATE','NEAR_DUPLICATE','DERIVED_FROM')) AS source_family_ids,
        s.observed_at AS source_observed_at, s.verified_at AS source_verified_at,
        s.effective_from AS source_effective_from, s.effective_to AS source_effective_to,
        s.valid_from AS source_valid_from, s.valid_to AS source_valid_to,
        s.date_kind AS source_date_kind, s.date_confidence AS source_date_confidence,
        (SELECT ec.publication_usability FROM json_each(c.evidence_span_ids_json) ids
          JOIN evidence_spans es ON es.id=ids.value JOIN extraction_coverage ec ON ec.segment_id=es.segment_id
          ORDER BY CASE ec.publication_usability WHEN 'review_needed' THEN 3 WHEN 'partial_usable' THEN 2 ELSE 1 END DESC LIMIT 1)
          AS segment_publication_usability,
        (SELECT ec.evidence_coverage FROM json_each(c.evidence_span_ids_json) ids
          JOIN evidence_spans es ON es.id=ids.value JOIN extraction_coverage ec ON ec.segment_id=es.segment_id
          ORDER BY CASE ec.evidence_coverage WHEN 'none' THEN 3 WHEN 'partial' THEN 2 ELSE 1 END DESC LIMIT 1)
          AS segment_evidence_coverage,
        (SELECT ec.uncovered_spans_json FROM json_each(c.evidence_span_ids_json) ids
          JOIN evidence_spans es ON es.id=ids.value JOIN extraction_coverage ec ON ec.segment_id=es.segment_id
          ORDER BY CASE ec.publication_usability WHEN 'review_needed' THEN 3 WHEN 'partial_usable' THEN 2 ELSE 1 END DESC LIMIT 1)
          AS segment_uncovered_spans_json
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
      const insertResolutionEvent = this.db.prepare(`INSERT OR IGNORE INTO knowledge_resolution_events(id,destination_slug,
        normalized_key,claim_a_id,claim_b_id,resolution_state,reason,detail_json,engine_version,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);
      const upsertVerificationJob = this.db.prepare(`INSERT INTO knowledge_verification_jobs(id,destination_slug,normalized_key,status,
        source_priority_json,evidence_json,result_json,created_at,updated_at)
        VALUES (?,?,?,'queued',?,?,'{}',?,?) ON CONFLICT(destination_slug,normalized_key) DO UPDATE SET
          status=CASE WHEN knowledge_verification_jobs.status='completed' THEN 'completed' ELSE 'queued' END,
          source_priority_json=excluded.source_priority_json,evidence_json=excluded.evidence_json,updated_at=excluded.updated_at`);
      const completeVerificationJob=this.db.prepare(`UPDATE knowledge_verification_jobs SET status='completed',result_json=?,
        completed_at=?,updated_at=? WHERE destination_slug=? AND normalized_key=? AND status<>'completed'`);
      const upsertRepairJob = this.db.prepare(`INSERT INTO claim_repair_jobs(id,claim_id,status,repair_type,input_json,result_json,created_at,updated_at)
        VALUES (?,?,'queued',?,?,'{}',?,?) ON CONFLICT(claim_id,repair_type) DO UPDATE SET
          status=CASE WHEN claim_repair_jobs.status='completed' THEN 'completed' ELSE 'queued' END,
          input_json=excluded.input_json,updated_at=excluded.updated_at`);
      const selectVisibility = this.db.prepare(
        "SELECT * FROM knowledge_visibility_overrides WHERE destination_slug=? AND normalized_key=?",
      );
      const upsertKnowledgeFact = this.db.prepare(`
        INSERT INTO knowledge_facts(id, destination_id, normalized_key, subject, predicate, consensus_status,
          preferred_value, support_count, contradiction_count, evidence_json, updated_at,
          freshness_state, latest_evidence_at, verification_priority, entity_key, canonical_subject,
          entity_aliases_json, entity_resolution_status, entity_type, granularity, entity_location_json,
          claim_relations_json, visibility_status, visibility_reason, visibility_updated_at,
          consensus_method, consensus_confidence, consensus_detail_json, validity_state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          visibility_updated_at=excluded.visibility_updated_at, consensus_method=excluded.consensus_method,
          consensus_confidence=excluded.consensus_confidence, consensus_detail_json=excluded.consensus_detail_json,
          validity_state=excluded.validity_state
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
          const repairId=`claim_repair_${sha256(`${row.id}:${extractionIssue}`).slice(0,24)}`;
          upsertRepairJob.run(repairId,row.id,extractionIssue,JSON.stringify({claimId:row.id,predicate:row.predicate,
            value:row.value_text,sourceQuote:row.source_quote,qualifiers:json(row.qualifiers_json,[])}),timestamp,timestamp);
          insertResolutionEvent.run(`knowledge_resolution_${sha256(`${row.id}:${extractionIssue}:${KNOWLEDGE_RESOLUTION_VERSION}`).slice(0,24)}`,
            destinationSlug,row.normalized_key,row.id,null,"REPAIR_REQUIRED",
            "The extraction issue is queued for bounded Claim repair rather than human conflict review.",
            JSON.stringify({repairType:extractionIssue}),KNOWLEDGE_RESOLUTION_VERSION,timestamp);
        }
        const mismatch=row.structured_value.compatibility;
        if(mismatch?.code==="PREDICATE_VALUE_MISMATCH"){
          const state=mismatch.repairedPredicate?"AUTO_REPAIRED":"REPAIR_REQUIRED";
          if(!mismatch.repairedPredicate)upsertRepairJob.run(
            `claim_repair_${sha256(`${row.id}:${mismatch.code}`).slice(0,24)}`,row.id,mismatch.code,
            JSON.stringify({claimId:row.id,predicate:row.predicate,value:row.value_text,sourceQuote:row.source_quote,
              proposedPredicate:mismatch.repairedPredicate||null}),timestamp,timestamp);
          insertResolutionEvent.run(`knowledge_resolution_${sha256(`${row.id}:${state}:${KNOWLEDGE_RESOLUTION_VERSION}`).slice(0,24)}`,
            destinationSlug,row.normalized_key,row.id,null,state,mismatch.repair||"Predicate/value compatibility was evaluated locally.",
            JSON.stringify(mismatch),KNOWLEDGE_RESOLUTION_VERSION,timestamp);
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
          ? stableCanonicalSerialize(row.structured_value.typed_value)
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
        const variantKey = (row) => typedFact ? canonicalKnowledgeVariant(row) : normalizeValue(row.value_text);
        const applicableRows = rows.filter((row) => ["current", "unknown"].includes(evidenceTemporalState(row, Date.parse(timestamp)).validityState));
        const variants = Map.groupBy(applicableRows, variantKey);
        const resolutionMode = evidenceResolutionMode(rows);
        const evidenceConsensus = resolveEvidenceConsensus(rows, {
          variantKey,
          nowMs: Date.parse(timestamp),
          staleAfterDays: this.contentConfig.volatileStaleAfterDays,
        });
        const ranked = [...variants.entries()].sort((a, b) => b[1].length - a[1].length
          || knowledgeValueSpecificity(b[1][0].value_text) - knowledgeValueSpecificity(a[1][0].value_text));
        const relations = [];
        const resolutionStates=[];
        for(const row of rows){
          const issue=detectClaimExtractionIssue(row,claimsBySource.get(row.source_id)||[]);
          const mismatch=row.structured_value.compatibility;
          if(issue||mismatch?.code==="PREDICATE_VALUE_MISMATCH"&&!mismatch.repairedPredicate)resolutionStates.push("REPAIR_REQUIRED");
          else if(mismatch?.repairedPredicate)resolutionStates.push("AUTO_REPAIRED");
        }
        for (let left = 0; left < rows.length; left += 1) {
          for (let right = left + 1; right < rows.length; right += 1) {
            const comparison = classifyClaimPair(rows[left], rows[right]);
            const resolution=decideKnowledgeResolution({comparison,left:rows[left],right:rows[right],
              consensus:evidenceConsensus,nowMs:Date.parse(timestamp)});
            resolutionStates.push(resolution.state);
            const reviewId = resolution.humanRequired
              ? `claim_review_${sha256(`${rows[left].id}:${rows[right].id}:${comparison.reviewType}`).slice(0, 24)}`
              : null;
            const reviewStatus = reviewId ? previousReviewDecisions.get(reviewId)?.status || "pending" : null;
            if (reviewId) {
              insertClaimReview.run(reviewId, destinationSlug, rows[left].id, rows[right].id,
                comparison.reviewType||"HARD_FACT_CONFLICT", resolution.reason, reviewStatus, timestamp, timestamp);
            }
            if(resolution.verificationRequired)upsertVerificationJob.run(
              `knowledge_verification_${sha256(`${destinationSlug}:${key}`).slice(0,24)}`,destinationSlug,key,
              JSON.stringify(verificationSourcePriority(rows)),JSON.stringify(rows.map((row)=>({claimId:row.id,sourceId:row.source_id,
                value:row.value_text,quote:row.source_quote}))),timestamp,timestamp);
            if(resolution.repairRequired){
              for(const row of [rows[left],rows[right]].filter((item)=>item.structured_value.compatibility?.code==="PREDICATE_VALUE_MISMATCH")){
                const repair=row.structured_value.compatibility;
                upsertRepairJob.run(`claim_repair_${sha256(`${row.id}:${repair.code}`).slice(0,24)}`,row.id,repair.code,
                  JSON.stringify({claimId:row.id,predicate:row.predicate,value:row.value_text,sourceQuote:row.source_quote}),timestamp,timestamp);
              }
            }
            insertResolutionEvent.run(`knowledge_resolution_${sha256(`${rows[left].id}:${rows[right].id}:${resolution.state}:${KNOWLEDGE_RESOLUTION_VERSION}`).slice(0,24)}`,
              destinationSlug,key,rows[left].id,rows[right].id,resolution.state,resolution.reason,
              JSON.stringify({comparison,consensusMethod:evidenceConsensus.method}),KNOWLEDGE_RESOLUTION_VERSION,timestamp);
            const automaticallyResolved = resolution.autoResolved || resolution.verificationRequired || resolution.repairRequired;
            const effectiveComparison = automaticallyResolved && !comparison.canCoexist
              ? { ...comparison, relation: "COMPATIBLE", canCoexist: true, reviewType: null,
                reason: `${comparison.reason} Resolution: ${resolution.state}. ${resolution.reason}` }
              : reviewStatus === "dismissed"
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
        if(!resolutionStates.includes("VERIFICATION_REQUIRED"))completeVerificationJob.run(
          JSON.stringify({resolution:"evidence_recomputed",states:resolutionStates}),timestamp,timestamp,destinationSlug,key);
        const status = resolutionStates.includes("HUMAN_REQUIRED") ? "conflicted"
          : resolutionStates.includes("VERIFICATION_REQUIRED")
            ? evidenceConsensus.supportCount > 1 ? "corroborated" : "single_source"
            : rows.length > 1 ? "corroborated" : "single_source";
        const consensusWinner = applicableRows.find((row) => variantKey(row) === evidenceConsensus.preferredVariantKey)
          || ranked[0]?.[1]?.[0] || null;
        const preferredValue = !consensusWinner ? "" : typedFact
          ? displayTypedKnowledgeValue(consensusWinner.structured_value.typed_value)
          : evidenceConsensus.autoResolved ? evidenceConsensus.preferredValue : ranked[0][1][0].value_text;
        const legacyFreshness = classifyFreshness(rows, this.contentConfig);
        const trustedDailyFact = resolutionMode === "TRUSTED_SOURCE_POLICY";
        const freshness = trustedDailyFact
          ? { state: "current", latestEvidenceAt: evidenceConsensus.latestEvidenceAt, volatile: true }
          : evidenceConsensus.autoResolved
          ? { state: evidenceConsensus.freshnessState, latestEvidenceAt: evidenceConsensus.latestEvidenceAt, volatile: true }
          : legacyFreshness;
        const verificationPriority = resolutionStates.includes("HUMAN_REQUIRED") ? "review"
          : resolutionStates.includes("VERIFICATION_REQUIRED") || resolutionStates.includes("REPAIR_REQUIRED") ? "review"
          : trustedDailyFact
          ? status === "conflicted" ? "review" : "normal"
          : evidenceConsensus.autoResolved
          ? freshness.state === "stale" || evidenceConsensus.method === "LATEST_WEIGHTED_PROVISIONAL"
            || evidenceConsensus.method === "SINGLE_SOURCE_LATEST" ? "review" : "normal"
          : status === "conflicted" ? "review"
            : status === "single_source" || freshness.state === "stale" ? "review" : "normal";
        const entity = aggregateEntityIdentity(rows);
        const evidence = rows.map((row) => ({
          claim_id: row.id,
          extraction_revision: row.extraction_revision,
          evidence_span_ids: json(row.evidence_span_ids_json, []),
          entity_key: row.entity_key,
          predicate: row.predicate,
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
          original_url: row.source_original_url || null,
          final_url: row.source_final_url || null,
          source_identity: row.source_identity || null,
          source_publisher: row.source_publisher || null,
          source_author_name: row.source_author_name || null,
          source_author_url: row.source_author_url || null,
          source_adapter: row.source_adapter || null,
          source_family_ids: row.source_family_ids || null,
          publication_usability: row.segment_publication_usability || "legacy_unknown",
          evidence_coverage: row.segment_evidence_coverage || "unknown",
          coverage_limitations: ["partial_usable", "review_needed"].includes(row.segment_publication_usability)
            ? json(row.segment_uncovered_spans_json, []) : [],
          authority_level: row.source_authority_level,
          published_at: row.published_at,
          captured_at: row.captured_at,
          observed_at: row.observed_at || row.source_observed_at || null,
          verified_at: row.verified_at || row.source_verified_at || null,
          effective_from: row.effective_from || row.source_effective_from || null,
          effective_to: row.effective_to || row.source_effective_to || null,
          valid_from: row.valid_from || row.source_valid_from || row.effective_from || row.source_effective_from || null,
          valid_to: row.valid_to || row.source_valid_to || row.effective_to || row.source_effective_to || null,
          date_kind: row.date_kind !== "unknown" ? row.date_kind : row.source_date_kind || "unknown",
          date_confidence: row.date_confidence !== "unknown" ? row.date_confidence : row.source_date_confidence || "unknown",
          timestamp_basis: row.verified_at || row.source_verified_at ? "verified_at"
            : row.observed_at || row.source_observed_at ? "observed_at"
              : row.published_at ? "published_at" : "captured_at_archive_only",
        }));
        const visibility = selectVisibility.get(destinationSlug, key);
        const factId = `fact_${sha256(`${destinationId}:${key}`).slice(0, 24)}`;
        const nextFact = {
          subject: entity.canonicalSubject || rows[0].subject,
          predicate: canonicalPredicate || rows[0].predicate,
          consensus_status: status,
          preferred_value: preferredValue,
          support_count: evidenceConsensus.autoResolved ? evidenceConsensus.supportCount
            : status === "conflicted" ? ranked[0][1].length : rows.length,
          contradiction_count: resolutionStates.includes("VERIFICATION_REQUIRED") || evidenceConsensus.autoResolved
            ? evidenceConsensus.contradictionCount : conflicts.length,
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
          consensus_method: trustedDailyFact && status !== "conflicted" ? "TRUSTED_SOURCE_POLICY"
            : evidenceConsensus.autoResolved ? evidenceConsensus.method
            : status === "conflicted" ? "STRICT_SEMANTIC_REVIEW" : "SEMANTIC_COMPATIBILITY",
          consensus_confidence: evidenceConsensus.autoResolved ? evidenceConsensus.confidence
            : status === "conflicted" ? 0 : Math.min(0.98, 0.55 + Math.min(rows.length, 5) * 0.08),
          consensus_detail_json: JSON.stringify(evidenceConsensus),
          validity_state: evidenceConsensus.validityState,
        };
        activeFactIds.add(factId);
        if (!storedColumnsMatch(existingFactsById.get(factId), nextFact)) upsertKnowledgeFact.run(
          factId, destinationId, key, nextFact.subject, nextFact.predicate, nextFact.consensus_status,
          nextFact.preferred_value, nextFact.support_count, nextFact.contradiction_count, nextFact.evidence_json, timestamp,
          nextFact.freshness_state, nextFact.latest_evidence_at, nextFact.verification_priority, nextFact.entity_key,
          nextFact.canonical_subject, nextFact.entity_aliases_json, nextFact.entity_resolution_status, nextFact.entity_type,
          nextFact.granularity, nextFact.entity_location_json, nextFact.claim_relations_json,
          nextFact.visibility_status, nextFact.visibility_reason, nextFact.visibility_updated_at,
          nextFact.consensus_method, nextFact.consensus_confidence, nextFact.consensus_detail_json,
          nextFact.validity_state,
        );
      }
      for (const factId of existingFactsById.keys()) if (!activeFactIds.has(factId)) deleteKnowledgeFact.run(factId);
    });
    const latestFacts = new Map(this.db.prepare("SELECT * FROM knowledge_facts WHERE destination_id=?").all(destinationId)
      .map((row) => [row.id, row]));
    const changedKeys = new Set();
    for (const [factId, row] of latestFacts) {
      const previous = existingFactsById.get(factId);
      if (!previous || knowledgeDependencyHash(previous) !== knowledgeDependencyHash(row)) changedKeys.add(row.normalized_key);
    }
    for (const [factId, row] of existingFactsById) if (!latestFacts.has(factId)) changedKeys.add(row.normalized_key);
    if (changedKeys.size) {
      this.invalidateFactDependents(destinationSlug, [...changedKeys], timestamp);
      this.markCoverageDirty(destinationSlug,[...changedKeys],timestamp);
    }
    return {destinationSlug,changedKeys:[...changedKeys],knowledgeResolutionVersion:KNOWLEDGE_RESOLUTION_VERSION};
  }

  markCoverageDirty(destinationSlug,changedFactKeys,timestamp=now()){
    const current=this.db.prepare("SELECT changed_fact_keys_json FROM coverage_dirty_scopes WHERE destination_slug=? AND topic_key=''").get(destinationSlug);
    const keys=[...new Set([...json(current?.changed_fact_keys_json,[]),...(changedFactKeys||[])].filter(Boolean))].sort();
    this.db.prepare(`INSERT INTO coverage_dirty_scopes(destination_slug,topic_key,changed_fact_keys_json,status,created_at,updated_at)
      VALUES (?,'',?,'dirty',?,?) ON CONFLICT(destination_slug,topic_key) DO UPDATE SET
        changed_fact_keys_json=excluded.changed_fact_keys_json,status='dirty',updated_at=excluded.updated_at`)
      .run(destinationSlug,JSON.stringify(keys),timestamp,timestamp);
    return keys;
  }

  takeCoverageDirty(destinationSlug){
    const row=this.db.prepare("SELECT * FROM coverage_dirty_scopes WHERE destination_slug=? AND topic_key='' AND status='dirty'").get(destinationSlug);
    if(!row)return null;
    this.db.prepare("UPDATE coverage_dirty_scopes SET status='processing',updated_at=? WHERE destination_slug=? AND topic_key='' AND status='dirty'")
      .run(now(),destinationSlug);
    return {destinationSlug,changedFactKeys:json(row.changed_fact_keys_json,[])};
  }

  completeCoverageDirty(destinationSlug,{failed=false}={}){
    this.db.prepare("UPDATE coverage_dirty_scopes SET status=?,updated_at=? WHERE destination_slug=? AND topic_key=''")
      .run(failed?'dirty':'complete',now(),destinationSlug);
  }

  getKnowledgeResolutionStatus(destinationSlug=null){
    const args=destinationSlug?[destinationSlug]:[];
    const where=destinationSlug?' WHERE destination_slug=?':'';
    const count=(table)=>this.db.prepare(`SELECT status,COUNT(*) AS count FROM ${table}${where} GROUP BY status`).all(...args);
    const human=this.db.prepare(`SELECT status,COUNT(*) AS count FROM claim_review_cases${where} GROUP BY status`).all(...args);
    const events=this.db.prepare(`SELECT resolution_state AS status,COUNT(*) AS count FROM knowledge_resolution_events${where} GROUP BY resolution_state`).all(...args);
    const repairs=destinationSlug
      ? this.db.prepare(`SELECT cr.status,COUNT(*) AS count FROM claim_repair_jobs cr JOIN claims c ON c.id=cr.claim_id
          JOIN structured_sources ss ON ss.source_id=c.source_id WHERE ss.destination_slug=? GROUP BY cr.status`).all(destinationSlug)
      : this.db.prepare("SELECT status,COUNT(*) AS count FROM claim_repair_jobs GROUP BY status").all();
    return {engineVersion:KNOWLEDGE_RESOLUTION_VERSION,automatic:events,verification:count('knowledge_verification_jobs'),
      repairs,humanReview:human};
  }

  listKnowledgeResolutionHistory({destinationSlug=null,limit=100}={}){
    const bounded=Math.max(1,Math.min(500,Number(limit)||100));
    const rows=destinationSlug
      ? this.db.prepare("SELECT * FROM knowledge_resolution_events WHERE destination_slug=? ORDER BY created_at DESC LIMIT ?").all(destinationSlug,bounded)
      : this.db.prepare("SELECT * FROM knowledge_resolution_events ORDER BY created_at DESC LIMIT ?").all(bounded);
    return rows.map((row)=>({...row,detail:json(row.detail_json,{})}));
  }

  listKnowledgeVerificationJobs({destinationSlug=null,status="",limit=100}={}){
    const clauses=[],values=[];
    if(destinationSlug){clauses.push("destination_slug=?");values.push(destinationSlug);}
    if(status){clauses.push("status=?");values.push(status);}
    values.push(Math.max(1,Math.min(500,Number(limit)||100)));
    return this.db.prepare(`SELECT * FROM knowledge_verification_jobs${clauses.length?` WHERE ${clauses.join(" AND ")}`:""}
      ORDER BY CASE status WHEN 'queued' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END,updated_at DESC LIMIT ?`).all(...values)
      .map((row)=>({...row,sourcePriorities:json(row.source_priority_json,[]),evidence:json(row.evidence_json,[]),result:json(row.result_json,{})}));
  }

  updateKnowledgeVerificationJob(jobId,{action,result={}}={}){
    const row=this.db.prepare("SELECT * FROM knowledge_verification_jobs WHERE id=?").get(jobId);
    if(!row)return null;
    const timestamp=now();
    if(action==="retry")this.db.prepare("UPDATE knowledge_verification_jobs SET status='queued',last_error=NULL,completed_at=NULL,updated_at=? WHERE id=?")
      .run(timestamp,jobId);
    else if(action==="complete")this.db.prepare("UPDATE knowledge_verification_jobs SET status='completed',result_json=?,last_error=NULL,completed_at=?,updated_at=? WHERE id=?")
      .run(JSON.stringify(result&&typeof result==='object'?result:{}),timestamp,timestamp,jobId);
    else throw conflictError("Verification action must be retry or complete.");
    return this.listKnowledgeVerificationJobs({destinationSlug:row.destination_slug,limit:500}).find((item)=>item.id===jobId)||null;
  }

  invalidateFactDependents(destinationSlug, normalizedKeys, timestamp = now()) {
    const keys = new Set((normalizedKeys || []).filter(Boolean));
    if (!keys.size) return { draftIds: [], factKeys: [] };
    const briefs = this.db.prepare("SELECT id,evidence_ledger_json FROM content_briefs WHERE destination_slug=?").all(destinationSlug)
      .filter((brief) => json(brief.evidence_ledger_json, []).some((key) => keys.has(key)));
    const draftIds = [];
    for (const brief of briefs) {
      const draft = this.db.prepare("SELECT id,status FROM article_drafts WHERE brief_id=?").get(brief.id);
      if (!draft) continue;
      draftIds.push(draft.id);
      const publication = this.db.prepare("SELECT * FROM wordpress_publications WHERE draft_id=? AND status='synced'").get(draft.id);
      if (publication) {
        const parent = this.db.prepare(`SELECT o.*,tc.proposed_title FROM topic_candidates tc
          JOIN content_opportunities o ON o.id=tc.opportunity_id WHERE tc.id=(SELECT candidate_id FROM content_briefs WHERE id=?)`).get(brief.id);
        const factKeys=[...keys].filter((key) => json(brief.evidence_ledger_json,[]).includes(key));
        const topicKey=`${parent?.topic_key || destinationSlug}:published-update:${sha256(`${draft.id}:${factKeys.sort().join("|")}`).slice(0,16)}`;
        const opportunityId=`opportunity_${sha256(topicKey).slice(0,24)}`;
        const impactId=`published_impact_${sha256(`${draft.id}:${factKeys.sort().join("|")}`).slice(0,24)}`;
        const readiness=json(parent?.readiness_json,{});
        const coverage={ ...json(parent?.coverage_json,{}),publishedUpdate:true,changedFactKeys:factKeys,
          targetPostId:publication.post_id,targetUrl:publication.post_url };
        this.db.prepare(`INSERT INTO content_opportunities(id,destination_slug,destination_scopes_json,topic_key,strategy_version,
          source_id,source_ids_json,recommendation_id,candidate_id,title,content_type,readiness_score,readiness_json,coverage_json,status,
          created_at,updated_at,lifecycle_action,target_post_id,publication_impact_json,lifecycle_state,seo_action)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'recommended',?,?,?,?,?,'recommended','UPDATE')
          ON CONFLICT(topic_key) DO UPDATE SET readiness_json=excluded.readiness_json,coverage_json=excluded.coverage_json,
            status='recommended',lifecycle_state='recommended',seo_action='UPDATE',updated_at=excluded.updated_at`)
          .run(opportunityId,destinationSlug,JSON.stringify([destinationSlug]),topicKey,this.strategyVersion,parent?.source_id || null,
            parent?.source_ids_json || "[]",parent?.recommendation_id || null,null,`Update: ${parent?.title || parent?.proposed_title || destinationSlug}`,
            parent?.content_type || "practical_guide",Number(readiness.score || parent?.readiness_score || 0),JSON.stringify(readiness),JSON.stringify(coverage),
            timestamp,timestamp,"update",publication.post_id,JSON.stringify({ existingUrl:publication.post_url,existingPostId:publication.post_id,changedFactKeys:factKeys }));
        this.db.prepare(`INSERT INTO published_content_impacts(id,draft_id,opportunity_id,changed_fact_keys_json,impact_reason,status,created_at,updated_at)
          VALUES (?,?,?,?,?,'recommended',?,?) ON CONFLICT(id) DO UPDATE SET changed_fact_keys_json=excluded.changed_fact_keys_json,
          impact_reason=excluded.impact_reason,status='recommended',updated_at=excluded.updated_at`)
          .run(impactId,draft.id,opportunityId,JSON.stringify(factKeys),"Published evidence changed; review an update without modifying the live article.",timestamp,timestamp);
        continue;
      }
      this.invalidateDraftDependents(draft.id, timestamp);
      this.db.prepare("UPDATE article_drafts SET status='qa_queued',quality_report_json='{}',updated_at=? WHERE id=?").run(timestamp, draft.id);
      this.enqueue("review_draft", draft.id);
    }
    return { draftIds, factKeys: [...keys] };
  }

  previewEvidenceIndependenceRebuild(destinationSlug) {
    const facts = this.knowledgeForDestination(destinationSlug);
    const sourceIds = [...new Set(facts.flatMap((fact) => (fact.evidence || []).map((item) => item.source_id)).filter(Boolean))];
    if (!sourceIds.length) return { dryRun: true, destinationSlug, affectedCount: 0, affectedFacts: [] };
    const placeholders = sourceIds.map(() => "?").join(",");
    const sources = new Map(this.db.prepare(`SELECT s.id,s.adapter,s.author_name,s.author_url,s.source_identity,
      (SELECT group_concat(sfm.family_id,'|') FROM source_family_memberships sfm
        WHERE sfm.source_id=s.id AND sfm.relation_type IN ('EXACT_DUPLICATE','NEAR_DUPLICATE','DERIVED_FROM')) AS family_ids
      FROM sources s WHERE s.id IN (${placeholders})`).all(...sourceIds).map((row) => [row.id, row]));
    const affectedFacts = [];
    for (const fact of facts) {
      const rows = (fact.evidence || []).map((item) => {
        const source = sources.get(item.source_id) || {};
        return { ...item, value_text: item.value, normalized_key: fact.normalized_key, predicate: fact.predicate,
          source_adapter: source.adapter, source_author_name: source.author_name, source_author_url: source.author_url,
          source_identity: source.source_identity, source_family_ids: source.family_ids };
      });
      const projected = resolveEvidenceConsensus(rows, { variantKey: (item) => normalizeValue(item.value_text),
        staleAfterDays: this.contentConfig.volatileStaleAfterDays });
      const previousKeys = [...new Set((fact.consensus_detail?.variants || []).flatMap((item) => item.independenceKeys || []))].sort();
      const projectedKeys = [...new Set(projected.variants.flatMap((item) => item.independenceKeys || []))].sort();
      if (Number(fact.consensus_detail?.independentSourceCount || fact.support_count) !== projected.independentSourceCount
        || JSON.stringify(previousKeys) !== JSON.stringify(projectedKeys)) {
        affectedFacts.push({ normalizedKey: fact.normalized_key,
          previousIndependentSourceCount: Number(fact.consensus_detail?.independentSourceCount || fact.support_count),
          projectedIndependentSourceCount: projected.independentSourceCount, previousKeys, projectedKeys });
      }
    }
    return { dryRun: true, destinationSlug, affectedCount: affectedFacts.length, affectedFacts };
  }

  rebuildEvidenceIndependence(destinationSlug, { dryRun = true } = {}) {
    const preview = this.previewEvidenceIndependenceRebuild(destinationSlug);
    if (dryRun) return preview;
    this.rebuildKnowledge(destinationSlug);
    return { ...preview, dryRun: false, rebuilt: true };
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
    // Dated evidence remains usable when its age and uncertainty are disclosed.
    // Recency changes its weight; it no longer erases otherwise useful research.
    const facts = currentPublicationFacts(allFacts);
    if (facts.length < minFacts || maxPerDestination < 1) return [];
    const destination = this.db.prepare("SELECT name FROM destinations WHERE slug = ?").get(destinationSlug);
    if (!destination) return [];
    const conflictCount = facts.filter((fact) => fact.consensus_status === "conflicted").length;
    const staleFactCount = allFacts.filter((fact) => fact.freshness_state === "stale").length;
    const verificationFactCount = facts.filter((fact) => fact.freshness_state === "stale"
      || fact.consensus_method === "LATEST_WEIGHTED_PROVISIONAL").length;
    const evidenceCount = this.independentSourceFamilyCountForFacts(facts);
    if (evidenceCount < 2) return [];
    const timestamp = now();
    const proposals = [{
      topicKey: `${destinationSlug}:first-time-solo-guide`,
      title: `First-Time ${destination.name} Solo Travel Guide`,
      rationale: `${facts.length} knowledge facts from ${evidenceCount} independent sources; ${conflictCount} strict conflicts, ${staleFactCount} dated facts, and ${verificationFactCount} provisional recency-weighted conclusions are disclosed to the writer.`,
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
      const subjectSources = this.independentSourceFamilyCountForFacts(subjectFacts);
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
        verificationFactCount: subjectFacts.filter((fact) => fact.freshness_state === "stale"
          || fact.consensus_method === "LATEST_WEIGHTED_PROVISIONAL").length,
        selectionPriority: 1,
      });
    }

    const itineraryFacts = facts.filter((fact) => /route|transport|duration|time|day|itinerary|station|metro|travel.?between|order|sequence|district|area/i
      .test(`${fact.normalized_key} ${fact.subject} ${fact.predicate}`));
    const itinerarySources = this.independentSourceFamilyCountForFacts(itineraryFacts);
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
        verificationFactCount: itineraryFacts.filter((fact) => fact.freshness_state === "stale"
          || fact.consensus_method === "LATEST_WEIGHTED_PROVISIONAL").length,
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
        // Legacy candidate generation remains visible for compatibility, but SEO
        // overlap must be expressed on an actionable Opportunity as NEW / UPDATE /
        // EXPAND / MERGE / SKIP. It never silently dismisses research here.
        this.db.prepare(`UPDATE topic_candidates SET status=CASE WHEN status='dismissed'
          AND (suppression_reason LIKE 'wordpress:%' OR suppression_reason LIKE 'search_console:%') THEN 'candidate' ELSE status END,
          suppression_reason=CASE WHEN suppression_reason LIKE 'wordpress:%' OR suppression_reason LIKE 'search_console:%' THEN NULL ELSE suppression_reason END,
          updated_at=? WHERE id=?`).run(timestamp,candidateId);
        return candidateId;
      });
    if (!selectedIds.length) return [];
    const placeholders = selectedIds.map(() => "?").join(",");
    return this.db.prepare(`SELECT * FROM topic_candidates WHERE id IN (${placeholders}) AND status='candidate' ORDER BY coverage_score DESC`).all(...selectedIds);
  }

  queueCandidate(candidateId) {
    const candidate = this.db.prepare("SELECT * FROM topic_candidates WHERE id = ?").get(candidateId);
    if (!candidate || !["candidate", "brief_queued"].includes(candidate.status)) return false;
    if (candidate.strategy_version) {
      const approved = this.db.prepare(`
        SELECT id FROM content_opportunities
        WHERE candidate_id=? AND strategy_version=? AND status='producing'
        LIMIT 1
      `).get(candidateId, candidate.strategy_version);
      if (!approved) return false;
    }
    this.db.prepare("UPDATE topic_candidates SET status = 'brief_queued', updated_at = ? WHERE id = ?").run(now(), candidateId);
    // `plan_content` is the durable production entrypoint. The Pipeline persists an
    // Editorial Assembly first inside that job, so legacy operators retain one clear
    // queue action while the new semantic boundary remains mandatory.
    this.enqueue("plan_content", candidateId);
    return true;
  }

  getEditorialAssemblyPackage(candidateId) {
    const topic = this.getTopicPackage(candidateId);
    if (!topic) return null;
    const sourceIds = new Set([topic.source_reference?.id, ...(topic.facts || []).flatMap((fact) =>
      (fact.evidence || []).map((item) => item.source_id))].filter(Boolean));
    const experiences = [...sourceIds].flatMap((sourceId) => this.listExperienceBlocks(sourceId));
    const failureLessons = this.db.prepare(`SELECT scope,failure_code,category,normalized_reason,remediation_rule,failing_stage
      FROM failure_lessons WHERE status='active' AND retry_safe=1 AND opportunity_id IN
        (SELECT id FROM content_opportunities WHERE candidate_id=?) ORDER BY created_at DESC LIMIT 30`).all(candidateId);
    const editorialLessons = this.db.prepare(`SELECT feedback,principle,created_at FROM editorial_lessons
      WHERE active=1 ORDER BY created_at DESC LIMIT 30`).all();
    const goldenArticles = this.db.prepare(`SELECT ga.id,ga.draft_id,ga.principles_json,ga.title
      FROM golden_articles ga WHERE ga.active=1 ORDER BY ga.created_at DESC LIMIT 10`).all()
      .map((row) => ({ ...row, principles: json(row.principles_json, []) }));
    return {
      ...topic,
      available_experiences: experiences,
      source_families: this.db.prepare(`SELECT sfm.source_id,sfm.family_id,sfm.relation_type,sfm.overlap_score
        FROM source_family_memberships sfm WHERE sfm.source_id IN (${[...sourceIds].map(() => "?").join(",") || "NULL"})`)
        .all(...sourceIds),
      failure_lessons: failureLessons,
      editorial_lessons: editorialLessons,
      golden_articles: goldenArticles,
    };
  }

  saveEditorialAssembly(candidateId, output, model = null, packageValue = null) {
    const input = packageValue || this.getEditorialAssemblyPackage(candidateId);
    if (!input) throw new Error(`Topic candidate ${candidateId} no longer exists.`);
    const validFacts = new Set((input.facts || []).map((item) => item.normalized_key));
    const validExperiences = new Set((input.available_experiences || []).map((item) => item.id));
    const validSources = new Set([input.source_reference?.id, ...(input.facts || []).flatMap((fact) =>
      (fact.evidence || []).map((item) => item.source_id))].filter(Boolean));
    const selectedFacts = uniqueStrings(output?.selected_fact_keys).filter((value) => validFacts.has(value)).slice(0, 48);
    const selectedExperiences = uniqueStrings(output?.selected_experience_block_ids).filter((value) => validExperiences.has(value)).slice(0, 24);
    const selectedSources = uniqueStrings(output?.selected_source_ids).filter((value) => validSources.has(value));
    if (!selectedSources.length) selectedSources.push(...validSources);
    if (!selectedFacts.length) selectedFacts.push(...[...validFacts].slice(0, 48));
    const timestamp = now();
    const assemblyId = `assembly_${sha256(candidateId).slice(0, 24)}`;
    const opportunity = this.db.prepare("SELECT id FROM content_opportunities WHERE candidate_id=? ORDER BY updated_at DESC LIMIT 1").get(candidateId);
    this.db.prepare(`INSERT INTO editorial_assemblies(id,candidate_id,opportunity_id,input_hash,selected_fact_keys_json,
      selected_experience_block_ids_json,selected_source_ids_json,selected_blueprint_source_ids_json,exclusions_json,rationale,status,model,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'ready',?,?,?) ON CONFLICT(candidate_id) DO UPDATE SET opportunity_id=excluded.opportunity_id,
      input_hash=excluded.input_hash,selected_fact_keys_json=excluded.selected_fact_keys_json,
      selected_experience_block_ids_json=excluded.selected_experience_block_ids_json,selected_source_ids_json=excluded.selected_source_ids_json,
      selected_blueprint_source_ids_json=excluded.selected_blueprint_source_ids_json,exclusions_json=excluded.exclusions_json,
      rationale=excluded.rationale,status='ready',model=excluded.model,updated_at=excluded.updated_at`)
      .run(assemblyId,candidateId,opportunity?.id || null,sha256(JSON.stringify(input)),JSON.stringify(selectedFacts),
        JSON.stringify(selectedExperiences),JSON.stringify(selectedSources),JSON.stringify(uniqueStrings(output?.selected_blueprint_source_ids).filter((value) => validSources.has(value)).slice(0, 8)),
        JSON.stringify(uniqueStrings(output?.exclusions).slice(0, 32)),String(output?.rationale || "").slice(0, 4_000),model,timestamp,timestamp);
    return this.getEditorialAssembly(candidateId);
  }

  getEditorialAssembly(candidateId) {
    const row = this.db.prepare("SELECT * FROM editorial_assemblies WHERE candidate_id=?").get(candidateId);
    return row ? { ...row, selected_fact_keys:json(row.selected_fact_keys_json,[]),
      selected_experience_block_ids:json(row.selected_experience_block_ids_json,[]), selected_source_ids:json(row.selected_source_ids_json,[]),
      selected_blueprint_source_ids:json(row.selected_blueprint_source_ids_json,[]), exclusions:json(row.exclusions_json,[]) } : null;
  }

  getTopicPackage(candidateId) {
    const candidate = this.db.prepare("SELECT * FROM topic_candidates WHERE id = ?").get(candidateId);
    if (!candidate) return null;
    const opportunity = this.db.prepare("SELECT * FROM content_opportunities WHERE candidate_id=? ORDER BY updated_at DESC LIMIT 1").get(candidateId);
    const coverage = json(opportunity?.coverage_json, {});
    const publicationMode = normalizePublicationMode(coverage.publicationMode);
    const assembly = this.getEditorialAssembly(candidateId);
    const selectedKeys = new Set(assembly?.selected_fact_keys?.length ? assembly.selected_fact_keys : coverage.selectedFactKeys || []);
    const destinationFacts = currentPublicationFacts(this.knowledgeForDestination(candidate.destination_slug));
    const scopedFacts = selectedKeys.size
      ? withScopedCoverageLimitations(destinationFacts.filter((fact) => selectedKeys.has(fact.normalized_key)),
        topicTokens(`${candidate.topic_key || ""} ${candidate.proposed_title || ""}`))
      : scopeFactsForOpportunity(destinationFacts,
        { destinationSlug: candidate.destination_slug, title: candidate.proposed_title, topic_key: candidate.topic_key });
    const source = publicationMode === "source_adaptation" && opportunity?.source_id ? this.getSource(opportunity.source_id) : null;
    return {
      candidate,
      approved_proposal: {
        ...(coverage.approval?.proposal || proposalForOpportunity(opportunity || candidate)),
        ...(coverage.editorialBrief ? { readerPromise: coverage.editorialBrief } : {}),
        ...(coverage.targetEntities?.length ? { targetEntities: coverage.targetEntities } : {}),
        ...(coverage.visualBrief ? { visualBrief: coverage.visualBrief } : {}),
      },
      facts: scopedFacts,
      production_mode: publicationMode,
      source_reference: source ? {
        id: source.id, title: source.title, summary: source.structured?.summary || "",
        authorization_status: source.authorization_status, editing_allowed: source.editing_allowed,
        blueprint: source.blueprint ? { format: source.blueprint.format, hook: source.blueprint.hook,
          angle: source.blueprint.angle, sections: source.blueprint.sections, strengths: source.blueprint.strengths } : null,
      } : null,
      editorial_assembly: assembly,
      experiences: assembly ? assembly.selected_experience_block_ids.map((experienceId) => {
        const row = this.db.prepare("SELECT * FROM experience_blocks WHERE id=?").get(experienceId);
        return row ? hydrateExperienceBlock(row) : null;
      }).filter(Boolean) : [],
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
    plan = normalizeBriefPlan(plan);
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
    this.db.prepare("UPDATE content_opportunities SET status='producing',lifecycle_state='producing',updated_at=? WHERE candidate_id=?").run(timestamp, candidateId);
    if (!deferDraft) this.enqueue("generate_draft", briefId);
    return briefId;
  }

  getBriefPackage(briefId) {
    const brief = this.db.prepare("SELECT * FROM content_briefs WHERE id = ?").get(briefId);
    if (!brief) return null;
    const topicPackage = this.getTopicPackage(brief.candidate_id);
    const contentPolicy = contentPolicyFor(brief, topicPackage?.facts || []);
    const publishedInventory = this.listWordPressInventory();
    const syncState = publishedInventory[0]?.site_url ? this.getWordPressSyncState(publishedInventory[0].site_url) : null;
    const linkInventory = selectInternalLinks(publishedInventory, {
      siteUrl: this.contentConfig.publicSiteUrl,
      topic: brief.topic,
      entities: [brief.destination_slug, ...(topicPackage?.approved_proposal?.targetEntities || [])],
    });
    return {
      brief: {
        ...brief, plan: json(brief.plan_json, {}), canonical: json(brief.canonical_json, {}),
        evidence_ledger: json(brief.evidence_ledger_json, []),
      },
      frontend_page_plan: this.getFrontendPagePlan(briefId),
      narrative_plan: this.getNarrativePlan(briefId),
      writing_packet: this.getWritingPacket(briefId),
      content_policy: contentPolicy,
      reader_sources: readerSources(topicPackage?.facts || []),
      authorized_source_assets: this.authorizedSourceAssetsForBrief(brief).map((asset) => ({
        id: asset.id, source_id: asset.source_id, alt_text: asset.alt_text,
        nearby_text: asset.nearby_text, caption_text: asset.caption_text,
        evidence_text: asset.evidence_text, language_status: asset.language_status,
        mime_type: asset.mime_type, preview_url: `/api/source-assets/${asset.id}/preview`,
      })),
      internal_link_inventory: linkInventory,
      internal_link_inventory_version: inventoryVersion(publishedInventory, syncState?.last_succeeded_at),
      duplicate_content_risks: duplicateContentRisks(publishedInventory, {
        title: brief.topic, entities: [brief.destination_slug],
      }),
      ...topicPackage,
    };
  }

  saveNarrativePlan(briefId, plan, model = null) {
    const contentPackage = this.getBriefPackage(briefId);
    if (!contentPackage) throw new Error(`Content brief ${briefId} no longer exists.`);
    const validFacts = new Set((contentPackage.facts || []).map((item) => item.normalized_key));
    const validExperiences = new Set((contentPackage.experiences || []).map((item) => item.id));
    const evidenceSelections = (Array.isArray(plan?.evidence_selections) ? plan.evidence_selections : []).slice(0,96);
    for (const selection of evidenceSelections) {
      const fact = (contentPackage.facts || []).find(fact => fact.normalized_key === selection.claim_key);
      if (!['current','historical','conditional'].includes(selection.role) || !fact?.evidence.some(evidence => evidence.claim_id === selection.claim_id && evidence.source_id === selection.source_id)) {
        throw Object.assign(new Error('叙事计划引用了未知或错配的证据陈述。'),{code:'NARRATIVE_EVIDENCE_INVALID',retryable:false});
      }
    }
    const timestamp = now();
    const narrativeId = `narrative_${sha256(briefId).slice(0, 24)}`;
    const placements = (Array.isArray(plan?.experience_placements) ? plan.experience_placements : [])
      .filter((item) => validExperiences.has(item?.experience_block_id)).slice(0, 24)
      .map((item) => ({ experience_block_id:item.experience_block_id,section_id:String(item.section_id || "").slice(0,200),purpose:String(item.purpose || "").slice(0,500) }));
    this.db.prepare(`INSERT INTO narrative_plans(id,brief_id,opening_job,throughline,route_sequence_json,experience_placements_json,
      supporting_fact_keys_json,conditional_branches_json,tradeoffs_json,exclusions_json,closing_decision,model,created_at,updated_at,evidence_selections_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(brief_id) DO UPDATE SET opening_job=excluded.opening_job,
      throughline=excluded.throughline,route_sequence_json=excluded.route_sequence_json,experience_placements_json=excluded.experience_placements_json,
      supporting_fact_keys_json=excluded.supporting_fact_keys_json,conditional_branches_json=excluded.conditional_branches_json,
      tradeoffs_json=excluded.tradeoffs_json,exclusions_json=excluded.exclusions_json,closing_decision=excluded.closing_decision,
      model=excluded.model,updated_at=excluded.updated_at,evidence_selections_json=excluded.evidence_selections_json`)
      .run(narrativeId,briefId,String(plan?.opening_job || "").slice(0,1000),String(plan?.throughline || "").slice(0,2000),
        JSON.stringify(uniqueStrings(plan?.route_sequence).slice(0,24)),JSON.stringify(placements),
        JSON.stringify(uniqueStrings(plan?.supporting_fact_keys).filter((value) => validFacts.has(value)).slice(0,48)),
        JSON.stringify(uniqueStrings(plan?.conditional_branches).slice(0,24)),JSON.stringify(uniqueStrings(plan?.tradeoffs).slice(0,24)),
        JSON.stringify(uniqueStrings(plan?.exclusions).slice(0,24)),String(plan?.closing_decision || "").slice(0,1000),model,timestamp,timestamp,JSON.stringify(evidenceSelections));
    return this.getNarrativePlan(briefId);
  }

  getNarrativePlan(briefId) {
    const row = this.db.prepare("SELECT * FROM narrative_plans WHERE brief_id=?").get(briefId);
    return row ? { ...row, evidence_selections:json(row.evidence_selections_json,[]), route_sequence:json(row.route_sequence_json,[]), experience_placements:json(row.experience_placements_json,[]),
      supporting_fact_keys:json(row.supporting_fact_keys_json,[]), conditional_branches:json(row.conditional_branches_json,[]),
      tradeoffs:json(row.tradeoffs_json,[]), exclusions:json(row.exclusions_json,[]) } : null;
  }

  assembleWritingPacket(briefId) {
    const contentPackage = this.getBriefPackage(briefId);
    const narrative = contentPackage?.narrative_plan;
    if (!contentPackage || !narrative) throw new Error(`Content brief ${briefId} has no Narrative Plan.`);
    const factKeys = uniqueStrings([...(narrative.supporting_fact_keys || []), ...(contentPackage.brief.evidence_ledger || [])]).slice(0,48);
    const facts = (contentPackage.facts || []).filter((fact) => factKeys.includes(fact.normalized_key)).map(fact => {
      const snapshot = selectedFactSnapshot(fact);
      const selections = (narrative.evidence_selections || []).filter(item => item.claim_key === fact.normalized_key);
      if (selections.length) {
        snapshot.evidence = selectedFactEvidence(fact,selections.map(item=>({claimId:item.claim_id,sourceId:item.source_id,evidenceRole:item.role})))
          .map(evidence=>({...evidence,evidence_role:selections.find(item=>item.claim_id===evidence.claim_id && item.source_id===evidence.source_id).role}));
        if (snapshot.evidence.length !== selections.length) throw Object.assign(new Error('所选叙事证据已变化，请重新规划该叙事。'),{code:'NARRATIVE_EVIDENCE_STALE',retryable:false});
        snapshot.selection_frozen = true;
        if (snapshot.evidence.length === 1) snapshot.preferred_value = snapshot.evidence[0].value;
      }
      snapshot.evidence = snapshot.evidence.flatMap(evidence => {
        if (evidence.claim_id) return [evidence];
        const claim = this.db.prepare(`SELECT id,extraction_revision,evidence_span_ids_json FROM claims
          WHERE source_id=? AND normalized_key=? AND value_text=? AND source_quote=? ORDER BY extraction_revision DESC LIMIT 1`)
          .get(evidence.source_id,fact.normalized_key,evidence.value || fact.preferred_value,evidence.quote || '');
        if (!claim) throw Object.assign(new Error('写作证据无法对应精确陈述，请重建该来源的知识后重试。'),{code:'WRITING_PACKET_EVIDENCE_UNRESOLVED',retryable:false});
        return [{...evidence,claim_id:claim.id,extraction_revision:claim.extraction_revision,evidence_span_ids:json(claim.evidence_span_ids_json,[])}];
      });
      return snapshot;
    });
    const experiences = contentPackage.experiences || [];
    const evidenceLedger = facts.map((fact) => ({ version:2, key:fact.normalized_key,subject:fact.subject,predicate:fact.predicate,
      value:fact.preferred_value,status:fact.consensus_status,
      fact_snapshot:semanticMaterial(selectedFactSnapshot(fact)),
      sources:selectedFactEvidence(fact).map((item) => ({ claim_id:item.claim_id || item.id,source_id:item.source_id,
        quote:item.quote,url:item.canonical_url,qualifiers:item.qualifiers,valid_from:item.valid_from,valid_to:item.valid_to })) }));
    const lines = [
      "ARTICLE GOAL", contentPackage.brief.plan?.reader_promise || contentPackage.brief.topic || "", "",
      "NARRATIVE", `Opening job: ${narrative.opening_job}`, `Throughline: ${narrative.throughline}`,
      ...(narrative.route_sequence || []).map((item,index) => `${index+1}. ${item}`), "",
      "WHY THIS WORKS", contentPackage.editorial_assembly?.rationale || contentPackage.approved_proposal?.whyItWorks || "The selected material directly supports the approved reader promise.", "",
      'SCOPE AND EXCLUSIONS', ...(narrative.exclusions || []).map(value => `- ${value}`),
      'CONDITIONAL BRANCHES', ...(narrative.conditional_branches || []).map(value => `- ${value}`),
      'TRADE-OFFS', ...(narrative.tradeoffs || []).map(value => `- ${value}`),
      'MEDIA CANDIDATES', ...(contentPackage.authorized_source_assets || []).map(asset =>
        `- ${asset.id || asset.source_asset_id}: ${asset.alt_text || asset.caption_text || 'Use only if relevant to the selected scene'}; ${asset.nearby_text || ''}`), '',
      "REAL TRAVELER EXPERIENCES", ...(experiences.length ? experiences.flatMap((item) => [
        `- ${item.title} [${item.id}]`, ...item.sequence.map((value) => `  Sequence: ${value}`),
        ...item.decision_logic.map((value) => `  Decision: ${value}`), ...item.conditions.map((value) => `  Condition: ${value}`),
        ...item.tradeoffs.map((value) => `  Trade-off: ${value}`), ...item.warnings.map((value) => `  Warning: ${value}`),
        ...item.alternatives.map((value) => `  Alternative: ${value}`),
      ]) : ["- No grounded first-hand experience block is available; do not invent one."]), "",
      "SELECTED PRACTICAL FACTS", ...facts.flatMap(fact => fact.evidence.map(evidence =>
        `- ${fact.subject} — ${fact.predicate}: ${evidence.value || fact.preferred_value} [${fact.normalized_key}; ${evidence.claim_id}; ${evidence.evidence_role || 'current'}]\n  Conditions: ${(evidence.qualifiers || []).join('; ') || 'No additional stated conditions'}; valid from ${evidence.valid_from || 'unspecified'} to ${evidence.valid_to || 'unspecified'}`)), "",
      "WRITING PATTERN", ...(contentPackage.editorial_patterns || []).slice(0,3).map((item) => `- ${item.format}: ${item.angle || "useful evidence-led structure"}`),
      "- Use third-person, evidence-backed traveler situations. Avoid generic introductions, database dumps, repeated section templates and filler.",
    ];
    const packetText = lines.join("\n").trim();
    const context = semanticMaterial({ version:2, narrative_plan:narrative,
      content_policy:contentPackage.content_policy, reader_sources:contentPackage.reader_sources,
      authorized_source_assets:contentPackage.authorized_source_assets, internal_link_inventory:contentPackage.internal_link_inventory,
      experiences });
    const timestamp = now();
    const packetId = `packet_${sha256(briefId).slice(0,24)}`;
    this.db.prepare(`INSERT INTO writing_packets(id,brief_id,narrative_plan_id,packet_text,evidence_ledger_json,
      selected_fact_keys_json,selected_experience_block_ids_json,input_hash,created_at,updated_at,context_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(brief_id) DO UPDATE SET narrative_plan_id=excluded.narrative_plan_id,
      packet_text=excluded.packet_text,evidence_ledger_json=excluded.evidence_ledger_json,selected_fact_keys_json=excluded.selected_fact_keys_json,
      selected_experience_block_ids_json=excluded.selected_experience_block_ids_json,input_hash=excluded.input_hash,updated_at=excluded.updated_at,context_json=excluded.context_json`)
      .run(packetId,briefId,narrative.id,packetText,JSON.stringify(evidenceLedger),JSON.stringify(factKeys),
        JSON.stringify(experiences.map((item) => item.id)),dependencyHash({ narrative, packetText, evidenceLedger, context }),timestamp,timestamp,JSON.stringify(context));
    return this.getWritingPacket(briefId);
  }

  getWritingPacket(briefId) {
    const row = this.db.prepare("SELECT * FROM writing_packets WHERE brief_id=?").get(briefId);
    return row ? { ...row, context:json(row.context_json,{}), evidence_ledger:json(row.evidence_ledger_json,[]),selected_fact_keys:json(row.selected_fact_keys_json,[]),
      selected_experience_block_ids:json(row.selected_experience_block_ids_json,[]) } : null;
  }

  saveDraft(briefId, draft, model, { deferReview = false } = {}) {
    const brief = this.db.prepare("SELECT * FROM content_briefs WHERE id = ?").get(briefId);
    if (!brief) throw new Error(`Content brief ${briefId} not found.`);
    draft.evidence_ledger = normalizeDraftLedger(draft.evidence_ledger, json(brief.plan_json, {}));
    const existing = this.db.prepare("SELECT id, revision FROM article_drafts WHERE brief_id = ?").get(briefId);
    const draftId = existing?.id || id("draft");
    const timestamp = now();
    const packet = this.getWritingPacket(briefId);
    const authorizedSourceAssets = this.authorizedSourceAssetsForBrief(brief, { packet });
    const policy = packet?.context?.version === 2 ? packet.context.content_policy
      : contentPolicyFor(brief, this.getTopicPackage(brief.candidate_id)?.facts || []);
    const metadata = draftMetadata(draft, brief, this.contentConfig, authorizedSourceAssets, policy);
    const contentHash = draftContentHash(draft, metadata, brief);
    if (existing) {
      this.db.prepare(`
        UPDATE article_drafts SET title=?, slug=?, body_markdown=?, meta_description=?, evidence_ledger_json=?,
          unresolved_conflicts_json=?, verification_notes_json=?, model=?, revision=revision+1,
          seo_json=?, schema_jsonld=?, content_blocks_json=?, content_ast_json=?, strategy_version=?, content_hash=?,
          quality_report_json='{}', status='qa_queued', updated_at=?
        WHERE id=?
      `).run(draft.title, draft.slug, draft.body_markdown, draft.meta_description, JSON.stringify(draft.evidence_ledger),
        JSON.stringify(draft.unresolved_conflicts), JSON.stringify(draft.verification_notes || []), model,
        JSON.stringify(metadata.seo), JSON.stringify(metadata.schema), JSON.stringify(metadata.blocks), JSON.stringify(metadata.contentAst), brief.strategy_version || this.strategyVersion,
        contentHash, timestamp, draftId);
    } else {
      this.db.prepare(`
        INSERT INTO article_drafts(id, brief_id, title, slug, body_markdown, quality_report_json, status,
          created_at, updated_at, meta_description, evidence_ledger_json, unresolved_conflicts_json,
          verification_notes_json, model, seo_json, schema_jsonld, content_blocks_json, content_ast_json, strategy_version, content_hash)
        VALUES (?, ?, ?, ?, ?, '{}', 'qa_queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(draftId, briefId, draft.title, draft.slug, draft.body_markdown, timestamp, timestamp,
        draft.meta_description, JSON.stringify(draft.evidence_ledger), JSON.stringify(draft.unresolved_conflicts),
        JSON.stringify(draft.verification_notes || []), model, JSON.stringify(metadata.seo), JSON.stringify(metadata.schema),
        JSON.stringify(metadata.blocks), JSON.stringify(metadata.contentAst), brief.strategy_version || this.strategyVersion, contentHash);
    }
    this.invalidateDraftDependents(draftId, timestamp);
    this.replaceDraftVisuals(draftId, metadata.visuals, brief.strategy_version || this.strategyVersion);
    this.recordDraftRevision(draftId, model || "unknown");
    this.db.prepare("UPDATE topic_candidates SET status='drafted', updated_at=? WHERE id=?").run(timestamp, brief.candidate_id);
    this.db.prepare("UPDATE content_briefs SET status='drafted', updated_at=? WHERE id=?").run(timestamp, briefId);
    this.db.prepare("UPDATE content_opportunities SET status='drafted',lifecycle_state='producing',updated_at=? WHERE candidate_id=?").run(timestamp, brief.candidate_id);
    if (!deferReview) this.enqueue("review_draft", draftId);
    return draftId;
  }

  updateDraftMetadata(draftId, { title = null, metaDescription = null } = {}) {
    const contentPackage = this.getDraftPackage(draftId);
    if (!contentPackage) throw new Error(`Article draft ${draftId} not found.`);
    const draft = contentPackage.draft;
    const nextTitle = title == null ? draft.title : String(title).trim();
    if (!nextTitle) throw new Error("Draft title cannot be empty.");
    const next = {
      ...draft,
      title: nextTitle,
      meta_description: metaDescription == null ? draft.meta_description : String(metaDescription).trim(),
      seo: { ...(draft.seo || {}), meta_title: nextTitle },
      faqs: draft.seo?.faqs || [],
    };
    const savedId = this.saveDraft(draft.brief_id, next, "manual_metadata_edit", { deferReview: true });
    this.enqueue("review_draft", savedId);
    return this.getDraftPackage(savedId).draft;
  }

  recordDraftRevision(draftId, changedBy = "unknown") {
    const draft = this.db.prepare(`SELECT id,revision,content_hash,title,slug,body_markdown,meta_description,
      evidence_ledger_json,unresolved_conflicts_json,verification_notes_json,seo_json,schema_jsonld,
      content_blocks_json,content_ast_json,strategy_version,model,updated_at FROM article_drafts WHERE id=?`).get(draftId);
    if (!draft) return null;
    const snapshot = { ...draft };
    this.db.prepare(`INSERT OR IGNORE INTO draft_revisions(id,draft_id,revision,content_hash,snapshot_json,changed_by,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(`draft_revision_${sha256(`${draftId}:${draft.revision}:${draft.content_hash}`).slice(0, 24)}`,
      draftId, draft.revision, draft.content_hash, JSON.stringify(snapshot), String(changedBy).slice(0, 200), draft.updated_at || now());
    return { draftId, revision: draft.revision, contentHash: draft.content_hash };
  }

  listDraftRevisions(draftId) {
    return this.db.prepare(`SELECT id,draft_id,revision,content_hash,changed_by,created_at
      FROM draft_revisions WHERE draft_id=? ORDER BY revision DESC`).all(draftId);
  }

  compareDraftRevisions(draftId, fromRevision, toRevision) {
    const rows = this.db.prepare(`SELECT revision,content_hash,snapshot_json,changed_by,created_at
      FROM draft_revisions WHERE draft_id=? AND revision IN (?,?) ORDER BY revision`).all(draftId, fromRevision, toRevision);
    if (rows.length !== 2) return null;
    const [from, to] = rows.map((row) => ({ ...row, snapshot: json(row.snapshot_json, {}) }));
    const fields = ["title", "slug", "body_markdown", "meta_description", "evidence_ledger_json", "seo_json", "schema_jsonld", "content_ast_json"];
    return {
      draftId, from: { revision: from.revision, contentHash: from.content_hash, changedBy: from.changed_by, createdAt: from.created_at },
      to: { revision: to.revision, contentHash: to.content_hash, changedBy: to.changed_by, createdAt: to.created_at },
      changedFields: fields.filter((field) => String(from.snapshot[field] ?? "") !== String(to.snapshot[field] ?? "")),
      snapshots: { from: from.snapshot, to: to.snapshot },
    };
  }

  previewContentAction(candidateId, action, actor = "administrator") {
    if (!["continue", "retry_failed_stage", "cancel"].includes(action)) throw new Error("Unsupported content action preview.");
    const item = this.listContent().find((row) => row.id === candidateId);
    if (!item) return null;
    const queuedJobs = this.db.prepare("SELECT id,type,status FROM jobs WHERE entity_id IN (?,?,?) AND status IN ('queued','running') ORDER BY created_at")
      .all(candidateId, item.brief_id || "", item.draft_id || "");
    const preview = {
      candidateId, action, currentStatus: item.draft_status || item.brief_status || item.status,
      affectedJobs: queuedJobs, preserves: ["sources", "claims", "knowledge", "draft_revisions", "commercial_events"],
      nextStage: action === "cancel" ? null : item.operation?.retry?.stage || this.retryContentStage(candidateId),
      additionalCalls: action === "cancel" ? { status: "none_expected", stages: [] }
        : item.operation?.estimatedAdditionalCalls || { status: "bounded_to_named_stage", stages: [] },
    };
    const previewId = id("content_action_preview");
    this.db.prepare(`INSERT INTO content_operation_history(id,candidate_id,action,status,preview_json,result_json,actor,created_at)
      VALUES (?,?,?,'previewed',?,'{}',?,?)`).run(previewId, candidateId, action, JSON.stringify(preview), String(actor).slice(0, 200), now());
    return { id: previewId, ...preview };
  }

  retryContentStage(candidateId) {
    const candidate = this.db.prepare("SELECT id FROM topic_candidates WHERE id=?").get(candidateId);
    if (!candidate) return null;
    if (!this.getEditorialAssembly(candidateId)) return "assemble_editorial";
    const brief = this.db.prepare("SELECT id FROM content_briefs WHERE candidate_id=?").get(candidateId);
    if (!brief) return "plan_content";
    if (!this.getNarrativePlan(brief.id)) return "plan_narrative";
    if (!this.getWritingPacket(brief.id)) return "assemble_writing_packet";
    const draft = this.db.prepare("SELECT id FROM article_drafts WHERE brief_id=?").get(brief.id);
    if (!draft) return "generate_draft";
    const pkg = this.getDraftPackage(draft.id);
    if (pkg.frontend_page_plan && !pkg.frontend_page?.current) return "compose_frontend_page";
    if (!pkg.review) return "review_draft";
    if (!pkg.review.passed) return qualityRepairStage(pkg.review.issues);
    if (!pkg.commercial_composition) return "compose_commercial";
    if (pkg.frontend_page && !this.db.prepare("SELECT id FROM frontend_publish_compositions WHERE draft_id=?").get(draft.id)) return "compose_publish_page";
    return null;
  }

  cancelContent(candidateId, previewId, actor = "administrator") {
    const history = this.db.prepare(`SELECT * FROM content_operation_history
      WHERE id=? AND candidate_id=? AND action='cancel' AND status='previewed'`).get(previewId, candidateId);
    if (!history) throw conflictError("A current cancel preview is required.");
    const timestamp = now();
    const result = transaction(this.db, () => {
      const item = this.db.prepare("SELECT id,status FROM topic_candidates WHERE id=?").get(candidateId);
      if (!item) return null;
      const related = this.db.prepare(`SELECT cb.id AS brief_id,ad.id AS draft_id FROM content_briefs cb
        LEFT JOIN article_drafts ad ON ad.brief_id=cb.id WHERE cb.candidate_id=?`).get(candidateId) || {};
      const cancelledJobs = this.db.prepare(`DELETE FROM jobs WHERE status='queued' AND entity_id IN (?,?,?)`)
        .run(candidateId, related.brief_id || "", related.draft_id || "").changes;
      this.db.prepare("UPDATE topic_candidates SET status='dismissed',suppression_reason='operator_cancelled',updated_at=? WHERE id=?").run(timestamp, candidateId);
      this.db.prepare("UPDATE content_opportunities SET status='suppressed',suppression_reason='operator_cancelled',updated_at=? WHERE candidate_id=?").run(timestamp, candidateId);
      return { candidateId, status: "cancelled", cancelledJobs, preservedDraftId: related.draft_id || null };
    });
    this.db.prepare("UPDATE content_operation_history SET status=?,result_json=?,actor=? WHERE id=?")
      .run(result ? "completed" : "rejected", JSON.stringify(result || {}), String(actor).slice(0, 200), previewId);
    return result;
  }

  listContentOperationHistory(candidateId) {
    return this.db.prepare(`SELECT id,candidate_id,action,status,preview_json,result_json,actor,created_at
      FROM content_operation_history WHERE candidate_id=? ORDER BY created_at DESC`).all(candidateId)
      .map((row) => ({ ...row, preview: json(row.preview_json, {}), result: json(row.result_json, {}) }));
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
    const operation = this.listContent({
      candidateId: briefPackage.candidate.id,
      evidenceHashes: new Map([[draftId, currentEvidenceHash]]),
    }).find((item) => item.draft_id === draftId)?.operation || null;
    return {
      ...briefPackage,
      evidence_hash: currentEvidenceHash,
      operation,
      draft: {
        ...draft,
        evidence_ledger: json(draft.evidence_ledger_json, []),
        unresolved_conflicts: json(draft.unresolved_conflicts_json, []),
        verification_notes: json(draft.verification_notes_json, []),
        seo: json(draft.seo_json, {}),
        schema_jsonld: json(draft.schema_jsonld, {}),
        content_blocks: json(draft.content_blocks_json, []),
        content_ast: json(draft.content_ast_json, {}),
        visuals: this.listDraftVisuals(draftId),
        seo_preview: buildSeoPreview({ ...draft, seo: json(draft.seo_json, {}) }),
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
    return this.db.prepare("SELECT * FROM article_visuals WHERE draft_id=? ORDER BY slot").all(draftId)
      .map((row) => ({ ...row, media_metadata: json(row.media_metadata_json, {}) }));
  }

  listDraftVisualsForDelivery(draftId) {
    if (!draftId) return [];
    return this.db.prepare(`
      SELECT av.*, sa.local_path AS source_asset_local_path,
        sa.ai_derivative_data_url AS source_asset_data_url
      FROM article_visuals av LEFT JOIN source_assets sa ON sa.id=av.source_asset_id
      WHERE av.draft_id=? ORDER BY av.slot
    `).all(draftId).map((row) => ({
      ...row,
      media_path: row.media_path || row.source_asset_local_path || "",
      media_metadata: json(row.media_metadata_json, {}),
    }));
  }

  replaceDraftVisuals(draftId, visuals, strategyVersion) {
    const timestamp = now();
    transaction(this.db, () => {
      const existing = new Map(this.db.prepare("SELECT * FROM article_visuals WHERE draft_id=?").all(draftId)
        .map((row) => [row.slot, row]));
      const upsert = this.db.prepare(`
        INSERT INTO article_visuals(id, draft_id, slot, placement, purpose, alt_text, caption, generation_prompt, aspect_ratio,
          strategy_version, image_type, image_role, image_subject, acquisition_strategy, factual_image_required,
          source_asset_id, source_remote_url, status, media_url, provider, model, created_at, updated_at, asset_fingerprint, media_metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          media_metadata_json=CASE WHEN article_visuals.asset_fingerprint=excluded.asset_fingerprint THEN article_visuals.media_metadata_json ELSE '{}' END,
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
        visual.provider || null, visual.model || null, timestamp, timestamp, fingerprint, JSON.stringify(visual.media_metadata || {}));
      });
      this.db.prepare("DELETE FROM article_visuals WHERE draft_id=? AND slot>?").run(draftId, visuals.length);
    });
  }

  plannedVisuals(draftId) {
    return this.db.prepare(`
      SELECT av.*,sa.local_path AS source_asset_local_path,sa.ai_derivative_data_url AS source_asset_data_url,
        sa.mime_type AS source_asset_mime_type,sa.language_status AS source_asset_language_status
      FROM article_visuals av LEFT JOIN source_assets sa ON sa.id=av.source_asset_id
      WHERE av.draft_id=? AND av.status='planned'
        AND av.acquisition_strategy IN ('generate_illustration','localize_source_image')
        AND (retry_at IS NULL OR retry_at<=?)
      ORDER BY av.slot
    `).all(draftId, now());
  }

  saveGeneratedVisual(visualId, result) {
    const current = this.db.prepare(`SELECT draft_id,acquisition_strategy,source_asset_id,media_metadata_json
      FROM article_visuals WHERE id=?`).get(visualId);
    const metadata = {
      ...json(current?.media_metadata_json, {}),
      ...(result.metadata || {}),
      ...(current?.acquisition_strategy === "localize_source_image" ? {
        localized_file: Boolean(result.mediaPath),
        localized_from_source_asset_id: current.source_asset_id || null,
      } : {}),
    };
    this.db.prepare(`
      UPDATE article_visuals SET status='generated', media_path=?, media_url=?, provider=?, model=?,
        media_metadata_json=?,last_error=NULL, retry_at=NULL, updated_at=?
      WHERE id=?
    `).run(result.mediaPath, result.mediaUrl, result.provider, result.model, JSON.stringify(metadata), now(), visualId);
    if (current) this.refreshDraftSchema(current.draft_id);
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
      SELECT av.draft_id, av.media_url AS previous_media_url,av.source_asset_id,av.media_metadata_json,ad.seo_json
      FROM article_visuals av JOIN article_drafts ad ON ad.id=av.draft_id WHERE av.id=?
    `).get(visualId);
    const metadata = { ...json(before?.media_metadata_json, {}), ...(media.metadata || {}),
      wordpress_uploaded: Boolean(media.id && media.url), wordpress_media_id: media.id || null };
    this.db.prepare("UPDATE article_visuals SET wordpress_media_id=?, wordpress_media_url=?, media_url=?, media_metadata_json=?, updated_at=? WHERE id=?")
      .run(media.id, media.url, media.url, JSON.stringify(metadata), now(), visualId);
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
    const visuals = this.listDraftVisuals(draftId);
    const hydratedDraft = { ...row, seo: json(row.seo_json, {}), canonical: json(row.canonical_json, {}),
      evidence_ledger: json(row.evidence_ledger_json, []), faqs: json(row.seo_json, {}).faqs || [] };
    const schema = buildArticleSchema(hydratedDraft, visuals, this.contentConfig);
    const contentAst = buildContentAst({ draft: hydratedDraft,
      brief: { id: row.brief_id, destination_slug: row.destination_slug, canonical: hydratedDraft.canonical }, visuals });
    this.db.prepare("UPDATE article_drafts SET schema_jsonld=?,content_ast_json=?, updated_at=? WHERE id=?")
      .run(JSON.stringify(schema), JSON.stringify(contentAst), now(), draftId);
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
    if (expectedVersion?.evidenceHash && expectedVersion.evidenceHash !== evidenceHash) throw Object.assign(new Error("STALE_EVIDENCE_VERSION: evidence changed during quality review."), {retryable:false});
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
    this.db.prepare(`UPDATE content_opportunities SET status='wordpress_draft',lifecycle_state='finished',updated_at=? WHERE candidate_id=(
      SELECT cb.candidate_id FROM article_drafts ad JOIN content_briefs cb ON cb.id=ad.brief_id WHERE ad.id=?)`).run(now(), draftId);
  }

  failWordPressPublication(draftId, error) {
    const timestamp=now();
    this.db.prepare("UPDATE wordpress_publications SET status='failed', last_error=?, error_code=?, updated_at=? WHERE draft_id=?")
      .run(String(error?.message || error).slice(0, 4000), String(error?.code || "WORDPRESS_DELIVERY_FAILED").slice(0, 120), timestamp, draftId);
    this.db.prepare(`UPDATE content_opportunities SET status='ready_for_wordpress',lifecycle_state='producing',updated_at=? WHERE candidate_id=(
      SELECT cb.candidate_id FROM article_drafts ad JOIN content_briefs cb ON cb.id=ad.brief_id WHERE ad.id=?)`).run(timestamp,draftId);
    if (this.getFrontendPublishComposition(draftId)) this.markFrontendPublishComposition(draftId, "delivery_failed");
  }

  listContent({ candidateId = null, approvedOnly = false, productionOnly = false, evidenceHashes = new Map() } = {}) {
    const rows = this.db.prepare(`
      SELECT tc.*, cb.id AS brief_id, cb.status AS brief_status, ad.id AS draft_id, ad.status AS draft_status,
        ad.title AS draft_title, ad.revision, qr.passed AS qa_passed, qr.score AS qa_score,
        wp.post_id AS wordpress_post_id, wp.post_url AS wordpress_post_url, wp.status AS wordpress_status,
        cc.status AS commercial_status, json_array_length(COALESCE(cc.offer_ids_json, '[]')) AS commercial_offer_count,
        pc.status AS publish_composition_status
      FROM topic_candidates tc
      LEFT JOIN content_briefs cb ON cb.candidate_id = tc.id
      LEFT JOIN article_drafts ad ON ad.brief_id = cb.id
      LEFT JOIN quality_reviews qr ON qr.id = (
        SELECT id FROM quality_reviews WHERE draft_id = ad.id AND draft_revision=ad.revision
          AND draft_content_hash=ad.content_hash ORDER BY created_at DESC LIMIT 1
      )
      LEFT JOIN wordpress_publications wp ON wp.draft_id = ad.id
      LEFT JOIN commercial_compositions cc ON cc.draft_id = ad.id
      LEFT JOIN frontend_publish_compositions pc ON pc.draft_id = ad.id
      WHERE (? IS NULL OR tc.id=?)
        AND (?=0 OR EXISTS (SELECT 1 FROM content_opportunities approved
          WHERE approved.candidate_id=tc.id AND approved.approved_at IS NOT NULL))
        AND (?=0 OR EXISTS (SELECT 1 FROM content_opportunities production
          WHERE production.candidate_id=tc.id AND production.lifecycle_state IN ('producing','finished')
            AND (EXISTS (SELECT 1 FROM jobs entry_job WHERE entry_job.entity_id=tc.id AND entry_job.type='plan_content')
              OR EXISTS (SELECT 1 FROM content_briefs entry_brief WHERE entry_brief.candidate_id=tc.id)
              OR tc.status='brief_queued')))
      ORDER BY tc.coverage_score DESC, tc.updated_at DESC
    `).all(candidateId, candidateId, approvedOnly ? 1 : 0, productionOnly ? 1 : 0);
    const draftIds = rows.map((row) => row.draft_id).filter(Boolean);
    if (!draftIds.length) return rows;
    const placeholders = draftIds.map(() => "?").join(",");
    const operationRows = this.db.prepare(`SELECT ad.id AS draft_id, tc.id, cb.id AS brief_id,
      CASE WHEN qr.id IS NOT NULL THEN ad.quality_report_json ELSE '{}' END AS quality_report_json,
      ad.seo_json, ad.schema_jsonld, ad.content_ast_json,
      ad.strategy_version AS draft_strategy_version, qr.passed AS qa_passed, qr.score AS qa_score,
      wp.status AS wordpress_status, cc.status AS commercial_status, pc.status AS publish_composition_status,
      failed.type AS failed_job_type, failed.last_error AS failed_job_error,
      failed.failure_class AS failed_job_failure_class, failed.last_failure_code AS failed_job_code,
      COALESCE(metrics.model_call_count, 0) AS model_call_count,
      COALESCE(metrics.unknown_cost_count, 0) AS unknown_cost_count, metrics.known_cost_usd
      FROM article_drafts ad JOIN content_briefs cb ON cb.id=ad.brief_id JOIN topic_candidates tc ON tc.id=cb.candidate_id
      LEFT JOIN quality_reviews qr ON qr.id=(SELECT id FROM quality_reviews WHERE draft_id=ad.id
        AND draft_revision=ad.revision AND draft_content_hash=ad.content_hash ORDER BY created_at DESC LIMIT 1)
      LEFT JOIN wordpress_publications wp ON wp.draft_id=ad.id
      LEFT JOIN commercial_compositions cc ON cc.draft_id=ad.id
      LEFT JOIN frontend_publish_compositions pc ON pc.draft_id=ad.id
      LEFT JOIN jobs failed ON failed.id=(SELECT failed_job.id FROM jobs failed_job
        WHERE failed_job.entity_id=ad.id AND failed_job.status='failed'
          AND NOT EXISTS (SELECT 1 FROM jobs recovered_job
            WHERE recovered_job.entity_id=failed_job.entity_id AND recovered_job.type=failed_job.type
              AND recovered_job.status='succeeded' AND recovered_job.updated_at>=failed_job.updated_at)
        ORDER BY failed_job.updated_at DESC LIMIT 1)
      LEFT JOIN (SELECT entity_id, COUNT(*) AS model_call_count,
        SUM(CASE WHEN cost_status='known' AND cost_usd IS NOT NULL THEN 0 ELSE 1 END) AS unknown_cost_count,
        SUM(CASE WHEN cost_status='known' THEN cost_usd ELSE 0 END) AS known_cost_usd
        FROM model_call_metrics WHERE entity_id IN (${placeholders}) GROUP BY entity_id) metrics ON metrics.entity_id=ad.id
      WHERE ad.id IN (${placeholders})`).all(...draftIds, ...draftIds);
    const staleReviews = new Set();
    const operations = new Map(operationRows.map((row) => {
      const review = this.db.prepare('SELECT evidence_hash FROM quality_reviews WHERE draft_id=? ORDER BY created_at DESC LIMIT 1').get(row.draft_id);
      const currentHash = review ? (evidenceHashes.get(row.draft_id)
        ?? evidenceHashForFacts(this.getBriefPackage(row.brief_id)?.facts || [])) : null;
      if (review && review.evidence_hash !== currentHash) {
        row.qa_passed=null;row.qa_score=null;row.quality_report_json='{}';staleReviews.add(row.draft_id);
      }
      const operation = buildContentTaskCard(row);
      const reviewIssues = json(row.quality_report_json, {}).issues || [];
      operation.automaticRepair = this.automaticQualityRepairState(row.draft_id, reviewIssues, { enqueue: false });
      if (row.failed_job_type) operation.automaticRepair = {
        ...operation.automaticRepair,
        eligible: false,
        queued: false,
        reason: "operation_must_be_resolved_first",
      };
      return [row.draft_id, operation];
    }));
    const active = this.db.prepare("SELECT entity_id,type,status FROM jobs WHERE status IN ('queued','running') ORDER BY created_at").all();
    return rows.map((row) => {
      const job = active.find((j) => [row.id,row.brief_id,row.draft_id].includes(j.entity_id));
      if (staleReviews.has(row.draft_id)) { row.qa_score=null;row.qa_passed=null; }
      return { ...row, workflow_status: job ? `${job.type}_${job.status}`
        : row.draft_status === "qa_queued" ? "awaiting_review" : row.draft_status || row.brief_status || row.status,
        ...(row.draft_id ? { operation: operations.get(row.draft_id) || null } : {}) };
    });
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
      WHERE a.provider_account_id=p.id AND a.active=1 AND a.lifecycle_state='operational') AS active_asset_count
      FROM affiliate_provider_accounts p WHERE p.id=?`).get(providerId) || null;
  }

  listAffiliateProviderAccounts() {
    return this.db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM affiliate_assets a
      WHERE a.provider_account_id=p.id AND a.active=1 AND a.lifecycle_state='operational') AS active_asset_count
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
    if (activeOnly) { clauses.push("active=1 AND lifecycle_state='operational' AND (valid_from IS NULL OR valid_from<=?) AND (valid_until IS NULL OR valid_until>?)"); values.push(now(), now()); }
    if (providerAccountId) { clauses.push("provider_account_id=?"); values.push(providerAccountId); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db.prepare(`SELECT * FROM affiliate_assets ${where} ORDER BY provider, active DESC, priority DESC, product_category, title`)
      .all(...values).map((row) => ({ ...row, embed_config: json(row.embed_config_json, {}) }));
  }

  listAffiliateAssetMappings({ activeOnly = false } = {}) {
    return this.db.prepare(`SELECT m.*, a.title, a.provider, a.product_category, a.asset_type
      FROM affiliate_asset_mappings m JOIN affiliate_assets a ON a.id=m.affiliate_asset_id
      ${activeOnly ? "WHERE m.active=1 AND a.active=1 AND a.lifecycle_state='operational'" : ""}
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
    if (String(status).toUpperCase() === "ACTIVE") clauses.push("status IN ('PENDING','READY_FOR_MANUAL','INVALID')");
    else if (status) { clauses.push("status=?"); values.push(String(status).toUpperCase()); }
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
    let attributionStatus = "unknown";
    if (event.draftId) {
      const state = this.db.prepare(`SELECT ad.revision, cc.overlay_version,
        EXISTS(SELECT 1 FROM commercial_slots cs WHERE cs.draft_id=ad.id AND cs.affiliate_asset_id=?) AS asset_matches
        FROM article_drafts ad LEFT JOIN commercial_compositions cc ON cc.draft_id=ad.id WHERE ad.id=?`)
        .get(event.affiliateAssetId, event.draftId);
      if (!state) throw conflictError("Commercial event draft does not exist.");
      if (event.articleRevision != null && event.articleRevision !== state.revision) throw conflictError("Commercial event articleRevision does not match the current draft revision.");
      if (event.overlayVersion && event.overlayVersion !== state.overlay_version) throw conflictError("Commercial event overlayVersion does not match the current commercial overlay.");
      if (event.affiliateAssetId && !state.asset_matches) throw conflictError("Commercial event affiliateAssetId is not present in this draft overlay.");
      attributionStatus = event.articleRevision != null && event.overlayVersion && event.affiliateAssetId && event.eventSource !== "unknown"
        ? "traceable" : "unknown";
    }
    insertCommercialEvent(this.db, event, now());
    return { id: event.id, eventType: event.eventType, occurredAt: event.occurredAt,
      articleRevision: event.articleRevision, overlayVersion: event.overlayVersion,
      affiliateAssetId: event.affiliateAssetId, eventSource: event.eventSource,
      conversionDataStatus: event.conversionDataStatus, attributionStatus,
      valueAmount: event.eventType === "commission" ? event.valueAmount : null };
  }

  commercialPerformance() {
    return listCommercialPerformance(this.db);
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
    const overlayVersion = `overlay_${sha256(`${draftId}:${draft.revision}:${draft.content_hash}:${this.strategyVersion}`).slice(0, 24)}`;
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
        content_blocks_json, strategy_version, draft_revision, draft_content_hash, overlay_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(draft_id) DO UPDATE SET publishable_body_markdown=excluded.publishable_body_markdown,
          slots_json=excluded.slots_json, offer_ids_json=excluded.offer_ids_json, disclosure_text=excluded.disclosure_text,
          status=excluded.status, updated_at=excluded.updated_at, asset_ids_json=excluded.asset_ids_json,
          commercial_blocks_json=excluded.commercial_blocks_json, content_blocks_json=excluded.content_blocks_json,
          strategy_version=excluded.strategy_version, draft_revision=excluded.draft_revision,
          draft_content_hash=excluded.draft_content_hash, overlay_version=excluded.overlay_version`)
        .run(compositionId, draftId, composition.publishableBodyMarkdown, JSON.stringify(composition.slots),
          JSON.stringify(composition.offerIds), composition.disclosureText, composition.status, timestamp, timestamp,
          JSON.stringify(composition.assetIds || []), JSON.stringify(composition.commercialBlocks || []),
          JSON.stringify(composition.contentBlocks || []), this.strategyVersion, draft.revision, draft.content_hash, overlayVersion);
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
    const opportunity = this.db.prepare("SELECT lifecycle_state FROM content_opportunities WHERE candidate_id=? ORDER BY updated_at DESC LIMIT 1").get(candidateId);
    if (opportunity && !["approved","producing"].includes(opportunity.lifecycle_state)) return null;
    if (this.db.prepare("SELECT id FROM jobs WHERE entity_id IN (?,?,?) AND status IN ('queued','running') LIMIT 1")
      .get(candidateId,row.brief_id || '',row.draft_id || '')) return null;
    const failed = row.draft_id && this.db.prepare(`SELECT * FROM jobs WHERE entity_id=? AND status='failed'
      AND NOT EXISTS (SELECT 1 FROM jobs ok WHERE ok.entity_id=jobs.entity_id AND ok.type=jobs.type AND ok.status='succeeded' AND ok.updated_at>=jobs.updated_at)
      ORDER BY updated_at DESC LIMIT 1`).get(row.draft_id);
    if (failed) {
      if (!isOperationalFailureRetryable(failed)) return null;
      this.enqueue(failed.type,row.draft_id,{dedupeKey:`manual-stage:${failed.type}:${row.draft_id}`});
      return failed.type;
    }
    if (!row.brief_id) {
      const stage = this.retryContentStage(candidateId) || "assemble_editorial";
      this.enqueue(stage,candidateId,{dedupeKey:`manual-stage:${stage}:${candidateId}`});
      return stage;
    }
    if (!row.draft_id) {
      this.db.prepare("UPDATE content_briefs SET status='ready', last_error=NULL, updated_at=? WHERE id=?").run(now(), row.brief_id);
      const stage = this.retryContentStage(candidateId) || "generate_draft";
      this.enqueue(stage,row.brief_id,{dedupeKey:`manual-stage:${stage}:${row.brief_id}`});
      return stage;
    }
    if (contractAware && (!this.getFrontendPageComposition(row.draft_id)?.current || row.frontend_page_status === "stale_contract" || row.publish_composition_status === "stale_contract")) {
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
      const pkg = this.getDraftPackage(row.draft_id);
      const stage = !pkg.review ? "review_draft" : qualityRepairStage(pkg.review.issues);
      if (!stage) return null;
      this.enqueue(stage, row.draft_id, {dedupeKey:`manual-stage:${stage}:${row.draft_id}`});
      return stage;
    }
    return null;
  }

  automaticQualityRepairState(draftId, issues = [], { enqueue = false, maxAttempts = 2 } = {}) {
    const draft = this.db.prepare("SELECT id,revision FROM article_drafts WHERE id=?").get(draftId);
    if (!draft) return { eligible: false, queued: false, stage: null, attempts: 0, maxAttempts, reason: "draft_missing" };
    const stage = qualityRepairStage(issues);
    const attempts = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM jobs
      WHERE entity_id=? AND dedupe_key LIKE 'auto-quality-repair:%'`).get(draftId)?.count || 0);
    if (!stage) return { eligible: false, queued: false, stage: null, attempts, maxAttempts, reason: "manual_media_or_no_blocker" };
    if (attempts >= maxAttempts) return { eligible: false, queued: false, stage, attempts, maxAttempts, reason: "attempt_limit_reached" };
    const active = this.db.prepare("SELECT id,type,status FROM jobs WHERE entity_id=? AND status IN ('queued','running') LIMIT 1").get(draftId);
    if (active) return { eligible: true, queued: false, stage, attempts, maxAttempts, reason: "job_already_active", activeJob: active };
    const dedupeKey = `auto-quality-repair:${stage}:${draftId}:r${draft.revision}`;
    const attempted = this.db.prepare("SELECT id,status FROM jobs WHERE dedupe_key=? LIMIT 1").get(dedupeKey);
    if (attempted) return { eligible: false, queued: false, stage, attempts, maxAttempts, reason: "revision_already_attempted" };
    if (!enqueue) return { eligible: true, queued: false, stage, attempts, maxAttempts, reason: "ready_to_queue" };
    const jobId = this.enqueue(stage, draftId, { dedupeKey });
    return { eligible: true, queued: Boolean(jobId), stage, jobId, attempts: attempts + (jobId ? 1 : 0), maxAttempts,
      reason: jobId ? "queued" : "queue_rejected" };
  }

  enqueueStartupReconciliation({ wordpressEnabled = false, contractAware = false } = {}) {
    this.reconcileCoverageAuditFalsePositives();
    this.reconcileEntityRelationshipCandidates();
    const researchSlugs = new Set(this.db.prepare("SELECT DISTINCT destination_slug FROM structured_sources").all().map((row) => row.destination_slug));
    const classifierState = json(this.db.prepare(
      "SELECT value_json FROM runtime_settings WHERE setting_key='claim_resolution'",
    ).get()?.value_json, {});
    const pendingClaimReviews = this.db.prepare(
      "SELECT COUNT(*) AS count FROM claim_review_cases WHERE status='pending'",
    ).get().count;
    const classifierChanged = classifierState.version && classifierState.version !== CLAIM_RESOLUTION_VERSION;
    const firstClassifierStampNeedsReview = !classifierState.version && pendingClaimReviews > 0;
    const reclassifyAll = Boolean(classifierChanged || firstClassifierStampNeedsReview);
    const staleKnowledgeSlugs = reclassifyAll ? [...researchSlugs] : this.db.prepare(`
      WITH claim_state AS (
        SELECT ss.destination_slug AS slug, MAX(c.created_at) AS latest_claim_at
        FROM structured_sources ss JOIN claims c ON c.source_id=ss.source_id
        WHERE c.lifecycle_status='active' AND c.knowledge_eligible=1
        GROUP BY ss.destination_slug
      ), fact_state AS (
        SELECT d.slug AS slug, COUNT(k.id) AS fact_count
        FROM destinations d JOIN knowledge_facts k ON k.destination_id=d.id
        GROUP BY d.slug
      )
      SELECT claim_state.slug FROM claim_state
      LEFT JOIN destinations ON destinations.slug=claim_state.slug
      LEFT JOIN fact_state USING(slug)
      WHERE COALESCE(fact_state.fact_count, 0)=0 OR destinations.updated_at IS NULL
        OR claim_state.latest_claim_at > destinations.updated_at
    `).all().map((row) => row.slug);
    for (const slug of staleKnowledgeSlugs) this.enqueue("rebuild_knowledge", slug);
    this.db.prepare(`
      INSERT INTO runtime_settings(setting_key, value_json, updated_at) VALUES ('claim_resolution', ?, ?)
      ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at
    `).run(JSON.stringify({ version: CLAIM_RESOLUTION_VERSION }), now());
    for (const row of this.db.prepare(`SELECT s.id,
        EXISTS(SELECT 1 FROM experience_extraction_runs er WHERE er.source_id=s.id AND er.status='succeeded') AS has_experience,
        EXISTS(SELECT 1 FROM content_intake_analyses cia WHERE cia.source_id=s.id) AS has_diagnostic
      FROM sources s JOIN structured_sources ss ON ss.source_id=s.id WHERE s.status='processed'
      ORDER BY s.captured_at ASC`).all()) {
      if (!row.has_experience) this.enqueue("extract_source_experience", row.id);
      else if (!row.has_diagnostic) this.enqueue("analyze_source_diagnostic", row.id);
    }
    this.coalesceQueuedExperienceJobs();
    for (const row of this.db.prepare("SELECT slug FROM destinations").all()) {
      if (!researchSlugs.has(row.slug)) this.enqueue("rebuild_topics", row.slug);
    }
    this.reconcileApprovedOpportunities();
    // Strategy upgrades must re-check historical failures with the current rules before
    // spending a bounded repair attempt. Old reviews may contain false positives from a
    // superseded evidence-coverage policy, so they are never fed straight into revise_draft.
    for (const row of this.db.prepare(`SELECT ad.id,ad.revision,qr.issues_json,
        EXISTS(SELECT 1 FROM frontend_page_compositions fp
          WHERE fp.draft_id=ad.id AND fp.draft_revision=ad.revision AND fp.draft_content_hash=ad.content_hash) AS has_current_page
        ,EXISTS(SELECT 1 FROM article_visuals av JOIN source_assets sa ON sa.id=av.source_asset_id
          WHERE av.draft_id=ad.id AND COALESCE(sa.ai_derivative_data_url,'')='' AND COALESCE(sa.local_path,'')='') AS missing_source_bytes
      FROM article_drafts ad
      JOIN quality_reviews qr ON qr.id=(SELECT id FROM quality_reviews WHERE draft_id=ad.id ORDER BY created_at DESC LIMIT 1)
      WHERE qr.passed=0 AND ad.status IN ('qa_failed','exception')`).all()) {
      if (!qualityRepairStage(json(row.issues_json, [])) || row.missing_source_bytes) continue;
      const jobType = row.has_current_page ? "review_draft" : "compose_frontend_page";
      const dedupeKey = `strategy-quality-recheck:${CONTENT_STRATEGY.version}:${jobType}:${row.id}:r${row.revision}`;
      const alreadyAttempted = this.db.prepare("SELECT id FROM jobs WHERE dedupe_key=? LIMIT 1").get(dedupeKey);
      if (!alreadyAttempted) this.enqueue(jobType, row.id, { dedupeKey });
    }
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
          evidence_coverage='complete',publication_usability='usable',materiality='material',audit_json=?,audited_at=? WHERE id=?`).run(JSON.stringify({ ...audit, autoAccepted: true,
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
      const previous = this.db.prepare("SELECT * FROM wordpress_content_inventory").all();
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
      this.invalidateInventoryLinkedCompositions(inventoryTargetChanges(previous, items), timestamp);
      for (const row of this.db.prepare("SELECT slug FROM destinations").all()) this.enqueue("rebuild_topics", row.slug);
      return items.length;
    });
  }

  invalidateInventoryLinkedCompositions(changes, timestamp = now()) {
    if (!changes.length) return 0;
    let affectedCount = 0;
    const rows = this.db.prepare("SELECT draft_id,payload_json,validation_json FROM frontend_page_compositions").all();
    for (const row of rows) {
      const indexes = affectedInternalLinkBlocks(json(row.payload_json, {}), changes);
      if (!indexes.length) continue;
      const validation = json(row.validation_json, {});
      validation.valid = false;
      validation.errors = [...(validation.errors || []).filter((item) => item.code !== "INTERNAL_LINK_INVENTORY_CHANGED"), {
        code: "INTERNAL_LINK_INVENTORY_CHANGED", path: "$.blocks", blockIndexes: indexes,
        targets: changes.filter((item) => item.old_url).map((item) => item.old_url),
        message: "Only blocks referencing a changed public target require recomposition; research evidence remains current.",
      }];
      this.db.prepare("UPDATE frontend_page_compositions SET validation_json=?,status='stale_inventory',updated_at=? WHERE draft_id=?")
        .run(JSON.stringify(validation), timestamp, row.draft_id);
      this.db.prepare("UPDATE frontend_publish_compositions SET status='stale_inventory',wordpress_post_id=NULL,updated_at=? WHERE draft_id=?")
        .run(timestamp, row.draft_id);
      this.enqueue("compose_frontend_page", row.draft_id);
      affectedCount += 1;
    }
    return affectedCount;
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
        return { action: "update", seoAction: "UPDATE", targetPostId: row.post_id, impact: { existingUrl: row.post_url, existingTitle: row.title, requiresEditorialApproval: true } };
      }
      const rowTokens = topicTokens(row.title);
      const union = new Set([...titleTokens, ...rowTokens]);
      const intersection = [...titleTokens].filter((token) => rowTokens.has(token)).length;
      if (union.size && intersection / union.size >= 0.78) {
        return { action: "merge", seoAction: "MERGE", targetPostId: row.post_id, impact: { existingUrl: row.post_url, existingTitle: row.title, requiresEditorialApproval: true } };
      }
      if (union.size && intersection / union.size >= 0.45) {
        return { action: "update", seoAction: "EXPAND", targetPostId: row.post_id, impact: { existingUrl: row.post_url, existingTitle: row.title, requiresEditorialApproval: true } };
      }
    }
    return { action: "create", seoAction: "NEW", targetPostId: null, impact: { requiresEditorialApproval: false } };
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
      consensus_method: row.consensus_method || "legacy_count",
      consensus_confidence: Number(row.consensus_confidence || 0),
      consensus_detail: json(row.consensus_detail_json, {}),
      validity_state: row.validity_state || "unknown",
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

  authorizedSourceAssetsForBrief(brief, { packet = null } = {}) {
    const claimKeys = json(brief.evidence_ledger_json, []);
    const supportingFacts = this.knowledgeForDestination(brief.destination_slug)
      .filter((fact) => !claimKeys.length || claimKeys.includes(fact.normalized_key));
    const sourceIds = [...new Set(supportingFacts
      .flatMap((fact) => fact.evidence || [])
      .map((evidence) => evidence.source_id)
      .filter(Boolean))];
    const selectedAssetIds=packet?.context?.version===2
      ? uniqueStrings((packet.context.authorized_source_assets || []).map(asset=>asset.id || asset.source_asset_id),100) : null;
    const scope=selectedAssetIds ?? sourceIds;
    if (!scope.length) return [];
    const placeholders = scope.map(() => "?").join(",");
    return this.db.prepare(`
      SELECT sa.id, sa.source_id, sa.remote_url, sa.local_path, sa.mime_type, sa.alt_text, sa.position,
        sa.storage_status,sa.original_bytes_status,sa.durability_status,sa.language_status,sa.nearby_text,sa.caption_text,
        sa.authorization_status AS asset_authorization_status,sa.publishable AS asset_publishable,
        s.title AS source_title,s.authorization_status AS source_authorization_status,s.publishable AS source_publishable,
        COALESCE((SELECT group_concat(canonical_subject || ' ' || subject || ' ' || predicate || ' ' || value_text, ' ')
          FROM claims c WHERE c.source_id=sa.source_id AND EXISTS (
            SELECT 1 FROM json_each(c.evidence_span_ids_json) ids
            JOIN evidence_spans es ON es.id=ids.value WHERE es.asset_id=sa.id
          )), '') AS evidence_text
      FROM ${selectedAssetIds ? 'source_assets' : 'current_source_assets'} sa JOIN sources s ON s.id=sa.source_id
      WHERE sa.kind='image' AND s.adapter='xiaohongshu'
        AND s.authorization_status='owner_confirmed' AND s.publishable=1
        AND sa.authorization_status='owner_confirmed' AND sa.publishable=1
        AND sa.storage_status='saved' AND sa.local_path<>''
        AND sa.original_bytes_status='saved_original' AND sa.durability_status='ORIGINAL_STORED'
        AND ${selectedAssetIds ? 'sa.id' : 'sa.source_id'} IN (${placeholders})
      ORDER BY s.captured_at DESC, sa.position ASC
      LIMIT 12
    `).all(...scope);
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
      const failure = explainOperationalFailure({ ...row, type: "extract_source" });
      items.push(exceptionItem("source", row.id, "blocker", failure.headline, row.title || row.id, failureDetail(failure), true, row.updated_at));
    }
    for (const row of this.db.prepare(`
      SELECT jobs.id, jobs.type, jobs.entity_id, jobs.last_error, jobs.updated_at, jobs.failure_class,
        jobs.last_failure_code, jobs.attempts, jobs.max_attempts,
        media.durability_status AS media_durability_status, media.repair_status AS media_repair_status
      FROM jobs
      LEFT JOIN source_assets media ON media.id=jobs.entity_id
        AND jobs.type IN ('backfill_media_asset','repair_media_asset')
      WHERE jobs.status='failed' AND jobs.type NOT IN (
        'extract_source','sync_wordpress_inventory','sync_search_console','push_wordpress_draft'
      )
      AND NOT EXISTS (
        SELECT 1 FROM jobs recovered
        WHERE recovered.type=jobs.type AND recovered.entity_id=jobs.entity_id
          AND recovered.status='succeeded' AND recovered.updated_at>=jobs.updated_at
      )
    `).all()) {
      // A later browser capture can make an old recovery failure obsolete. Keep
      // browser-repair-required assets visible until those original bytes are
      // actually stored; the operator still needs to act on each repair item.
      if (['backfill_media_asset', 'repair_media_asset'].includes(row.type)
        && row.media_durability_status === 'ORIGINAL_STORED') continue;
      if (PRODUCTION_JOB_TYPES.has(row.type) && !isSystemLevelFailure(row.last_failure_code,row.last_error)) {
        const learned = this.db.prepare(`SELECT 1 FROM failure_lessons WHERE failing_stage=?
          AND json_extract(previous_input_json,'$.entityId')=? LIMIT 1`).get(row.type,row.entity_id);
        const mediaPending = this.db.prepare("SELECT 1 FROM article_drafts WHERE id=? AND status='media_pending'").get(row.entity_id);
        if (learned || mediaPending) continue;
      }
      const owner = this.db.prepare(`SELECT tc.id FROM topic_candidates tc
        LEFT JOIN content_briefs cb ON cb.candidate_id=tc.id LEFT JOIN article_drafts ad ON ad.brief_id=cb.id
        WHERE tc.id=? OR cb.id=? OR ad.id=? LIMIT 1`).get(row.entity_id,row.entity_id,row.entity_id);
      const failure = explainOperationalFailure(row);
      items.push({ ...exceptionItem("job", row.id, "blocker", failure.headline, row.entity_id, failureDetail(failure), isOperationalFailureRetryable(row), row.updated_at),candidateId:owner?.id || null });
    }
    for (const row of this.db.prepare(`
      SELECT k.*, d.slug AS destination_slug, kr.status AS resolution_status, kr.preferred_value AS resolved_value,
        kr.note AS resolution_note, kr.resolved_at AS resolution_resolved_at
      FROM knowledge_facts k JOIN destinations d ON d.id=k.destination_id
      LEFT JOIN knowledge_resolutions kr ON kr.destination_slug=d.slug AND kr.normalized_key=k.normalized_key
      WHERE k.consensus_status='conflicted' AND COALESCE(kr.status, '') <> 'resolved' AND NOT EXISTS (
        SELECT 1 FROM claim_review_cases crc JOIN claims ca ON ca.id=crc.claim_a_id
        WHERE crc.destination_slug=d.slug AND crc.status='pending' AND ca.normalized_key=k.normalized_key
      )
    `).all()) {
      const item = exceptionItem("knowledge", row.id, "warning",
        "知识事实存在严格冲突，需要判断", `${row.subject} · ${row.predicate}`,
        "系统只会把同一对象、同一时间和同一适用条件下不能同时成立的事实列入这里。票价、营业时间、预约和交通等日常信息会按你选择的来源保存；只有真实互斥时才需要一次人工决定。",
        false, row.updated_at);
      item.knowledge = {
        id: row.id,
        destinationSlug: row.destination_slug,
        normalizedKey: row.normalized_key,
        preferredValue: row.preferred_value,
        evidence: json(row.evidence_json, []),
      };
      items.push(item);
    }
    for (const row of this.db.prepare(`SELECT r.*, a.source_id AS source_id_a, a.subject AS subject_a, a.predicate AS predicate_a,
      a.normalized_key AS normalized_key_a, a.value_text AS value_a, a.source_quote AS source_quote_a, a.structured_value_json AS structured_a,
      a.evidence_span_ids_json AS evidence_span_ids_a,
      b.source_id AS source_id_b, b.subject AS subject_b, b.predicate AS predicate_b, b.value_text AS value_b,
      b.normalized_key AS normalized_key_b, b.source_quote AS source_quote_b, b.structured_value_json AS structured_b,
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
        factGroupKey: row.review_type.includes("EXTRACTION_ERROR") ? row.id
          : `${row.destination_slug}:${row.normalized_key_a || `${row.subject_a}:${row.predicate_a}`}:${row.review_type}`,
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
      const type = row.sync_key.startsWith("wordpress") ? "sync_wordpress_inventory" : row.sync_key.startsWith("search_console") ? "sync_search_console" : "integration_sync";
      const failure = explainOperationalFailure({ ...row, type });
      items.push(exceptionItem("sync", row.sync_key, "blocker", failure.headline, row.sync_key, failureDetail(failure), true, row.updated_at));
    }
    for (const row of this.db.prepare("SELECT task_key, last_error, updated_at FROM maintenance_runs WHERE status='failed'").all()) {
      const failure = explainOperationalFailure({ ...row, type: row.task_key || "maintenance" });
      items.push(exceptionItem("maintenance", row.task_key, "blocker", failure.headline, row.task_key, failureDetail(failure), false, row.updated_at));
    }
    for (const row of this.db.prepare("SELECT id, candidate_id, topic, last_error, updated_at FROM content_briefs WHERE status='exception'").all()) {
      const failure = explainOperationalFailure({ ...row, type: "generate_draft" });
      items.push({ ...exceptionItem("brief", row.id, "blocker", failure.headline, row.topic, failureDetail(failure), true, row.updated_at), candidateId: row.candidate_id });
    }
    for (const row of this.db.prepare(`
      SELECT ad.id, ad.title, ad.status, ad.updated_at, cb.candidate_id
      FROM article_drafts ad JOIN content_briefs cb ON cb.id=ad.brief_id
      WHERE ad.status='exception' OR (ad.status='qa_failed' AND ad.revision>=2)
    `).all()) {
      const failedJob = this.db.prepare(`SELECT type,failure_class,last_failure_code,last_error FROM jobs
        WHERE entity_id=? AND status='failed' AND NOT EXISTS (SELECT 1 FROM jobs ok
          WHERE ok.entity_id=jobs.entity_id AND ok.type=jobs.type AND ok.status='succeeded' AND ok.updated_at>=jobs.updated_at)
        ORDER BY updated_at DESC LIMIT 1`).get(row.id);
      const retryable = failedJob ? isOperationalFailureRetryable(failedJob) : true;
      const failure = explainOperationalFailure(failedJob || { type: "review_draft", last_error: row.status });
      items.push({ ...exceptionItem("draft", row.id, "blocker", failure.headline, row.title,
        failureDetail(failure), retryable, row.updated_at), candidateId: row.candidate_id });
    }
    for (const row of this.db.prepare(`
      SELECT wp.draft_id, wp.last_error, wp.updated_at, ad.title, cb.candidate_id
      FROM wordpress_publications wp JOIN article_drafts ad ON ad.id=wp.draft_id
      JOIN content_briefs cb ON cb.id=ad.brief_id WHERE wp.status='failed'
    `).all()) {
      const failure = explainOperationalFailure({ ...row, type: "push_wordpress_draft" });
      items.push({ ...exceptionItem("wordpress", row.draft_id, "blocker", failure.headline, row.title, failureDetail(failure), true, row.updated_at), candidateId: row.candidate_id });
    }
    const severityRank = { blocker: 0, warning: 1 };
    return items.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]
      || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  listOperationalExceptionWorkspace(input = {}) {
    const all = this.listOperationalExceptions();
    const page = paginateWorkspace(all, input, {
      searchable: (item) => `${item.key} ${item.title} ${item.subject} ${item.detail} ${item.kind}`,
      statusOf: (item) => item.severity,
    });
    return {
      ...page,
      summary: {
        blockers: all.filter((item) => item.severity === "blocker").length,
        warnings: all.filter((item) => item.severity === "warning").length,
      },
    };
  }

  listSystemHealthIssues(operationalItems = null) {
    return (operationalItems || this.listOperationalExceptions()).filter((item) => {
      if (["sync","wordpress"].includes(item.kind)) return true;
      if (item.kind === "source") {
        const row=this.db.prepare("SELECT last_error FROM sources WHERE id=?").get(item.entityId);
        return Boolean(row && isSystemLevelFailure("extract_source",row.last_error));
      }
      if (item.kind === "job") {
        const row=this.db.prepare("SELECT type,last_failure_code,last_error FROM jobs WHERE id=?").get(item.entityId);
        return Boolean(row && !["backfill_media_asset","repair_media_asset"].includes(row.type)
          && isSystemLevelFailure(row.last_failure_code,row.last_error));
      }
      if (["brief","draft"].includes(item.kind)) {
        const row=this.db.prepare(`SELECT type,last_failure_code,last_error FROM jobs
          WHERE entity_id=? AND status='failed' ORDER BY updated_at DESC LIMIT 1`).get(item.entityId);
        return Boolean(row && isSystemLevelFailure(row.last_failure_code,row.last_error));
      }
      return false;
    }).map((item) => ({...item,systemHealthIssue:true}));
  }

  listSystemHealthWorkspace(input = {}) {
    const all=this.listSystemHealthIssues();
    const page=paginateWorkspace(all,input,{
      searchable:(item) => `${item.key} ${item.title} ${item.subject} ${item.detail} ${item.kind}`,
      statusOf:(item) => item.severity,
    });
    return {...page,summary:{blockers:all.filter((item) => item.severity==="blocker").length,
      warnings:all.filter((item) => item.severity==="warning").length}};
  }

  maintenanceOverview({reconciliation=null}={}) {
    reconciliation ||= this.reconcileRecommendationInbox();
    const media=this.db.prepare(`SELECT COUNT(*) AS discovered,
      SUM(durability_status='ORIGINAL_STORED') AS stored,
      SUM(repair_status IN ('server_recovery_pending','server_recovery_running')) AS server_pending,
      SUM(repair_status='browser_repair_required') AS browser_pending,
      SUM(durability_status='UNAVAILABLE' OR repair_status='unavailable') AS unavailable FROM current_source_assets`).get();
    const experience=this.db.prepare(`SELECT COUNT(*) AS eligible,
      SUM(EXISTS (SELECT 1 FROM experience_extraction_runs er WHERE er.source_id=s.id AND er.status='succeeded'
        AND er.capture_version=s.capture_version AND er.degraded=0)) AS completed,
      SUM(NOT EXISTS (SELECT 1 FROM experience_extraction_runs er WHERE er.source_id=s.id AND er.status='succeeded'
        AND er.capture_version=s.capture_version AND er.degraded=0)
        AND NOT EXISTS (SELECT 1 FROM current_source_assets sa WHERE sa.source_id=s.id AND sa.durability_status<>'ORIGINAL_STORED')) AS pending,
      SUM(EXISTS (SELECT 1 FROM current_source_assets sa WHERE sa.source_id=s.id AND sa.durability_status<>'ORIGINAL_STORED')) AS blocked
      FROM sources s WHERE s.completeness_status='complete' AND s.status IN ('processed','needs_ai')`).get();
    const failure=this.db.prepare(`SELECT COUNT(*) AS total,
      SUM(status='active' AND retry_safe=1) AS retry_eligible FROM failure_lessons`).get();
    const cards=[
      {key:"media_original_backfill",title:"媒体原件修复",total:Number(media.discovered || 0),
        completed:Number(media.stored || 0),pending:Number(media.server_pending || 0)+Number(media.browser_pending || 0),
        blocked:Number(media.browser_pending || 0)+Number(media.unavailable || 0),nextOwner:Number(media.browser_pending || 0) ? "browser_extension" : "system"},
      {key:"experience_backfill",title:"体验信息补齐",total:Number(experience.eligible || 0),
        completed:Number(experience.completed || 0),pending:Number(experience.pending || 0),blocked:Number(experience.blocked || 0),
        nextOwner:Number(experience.blocked || 0) ? "browser_extension" : "system"},
      {key:"recommendation_reconciliation",title:"推荐收件箱校准",total:reconciliation.internalOpportunities,
        completed:reconciliation.actionableInbox,pending:reconciliation.processingGap,blocked:0,nextOwner:"system",
        detail:{actionable:reconciliation.actionableInbox,evidenceGap:reconciliation.evidenceGap,merged:reconciliation.merged,superseded:reconciliation.superseded}},
      {key:"historical_failure_migration",title:"历史失败治理",total:Number(failure.total || 0),
        completed:Number(failure.retry_eligible || 0),pending:0,blocked:Math.max(0,Number(failure.total || 0)-Number(failure.retry_eligible || 0)),nextOwner:"system"},
    ];
    return {cards,pendingTasks:cards.filter((card) => card.pending>0).length,updatedAt:now()};
  }

  retryOperationalException(exceptionKey, { contractAware = false } = {}) {
    const separator = exceptionKey.indexOf(":");
    const kind = exceptionKey.slice(0, separator);
    const entityId = exceptionKey.slice(separator + 1);
    if (!kind || !entityId) return false;
    const exception = this.listOperationalExceptions().find((item) => item.key === exceptionKey);
    if (!exception?.retryable) return false;
    if (kind === "source") return this.retrySource(entityId);
    if (kind === "job") {
      const job = this.db.prepare("SELECT * FROM jobs WHERE id=? AND status='failed'").get(entityId);
      if (!job || !isOperationalFailureRetryable(job)) return false;
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

  resolveKnowledgeConflict(factId, preferredValue, note = "", resolutionType = "preferred_value") {
    const fact = this.db.prepare(`
      SELECT k.id, k.normalized_key, k.consensus_status, d.slug AS destination_slug
      FROM knowledge_facts k JOIN destinations d ON d.id=k.destination_id WHERE k.id=?
    `).get(factId);
    if (!fact || fact.consensus_status !== "conflicted") return null;
    const value = String(preferredValue || "").trim().slice(0, 2_000);
    if (!value) throw new Error("A confirmed knowledge value is required to resolve a conflict.");
    if (!["preferred_value", "coexist_scope"].includes(resolutionType)) throw new Error("Unknown knowledge resolution type.");
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO knowledge_resolutions(id, destination_slug, normalized_key, status, preferred_value, note, resolved_at, created_at, updated_at,resolution_type)
      VALUES (?, ?, ?, 'resolved', ?, ?, ?, ?, ?,?)
      ON CONFLICT(destination_slug, normalized_key) DO UPDATE SET status='resolved', preferred_value=excluded.preferred_value,
        note=excluded.note, resolved_at=excluded.resolved_at, updated_at=excluded.updated_at,resolution_type=excluded.resolution_type
    `).run(`resolution_${sha256(`${fact.destination_slug}:${fact.normalized_key}`).slice(0, 24)}`,
      fact.destination_slug, fact.normalized_key, value, String(note || "").trim().slice(0, 1_000), timestamp, timestamp, timestamp,resolutionType);
    this.rebuildTopicCandidates(fact.destination_slug);
    return { factId, destinationSlug: fact.destination_slug, normalizedKey: fact.normalized_key, preferredValue: value,resolutionType };
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

  knowledgeSummary({ destination = "" } = {}) {
    const destinationClause = destination ? " AND d.slug=?" : "";
    const values = destination ? [destination] : [];
    const totals = this.db.prepare(`SELECT COUNT(*) AS facts,
      COUNT(DISTINCT CASE WHEN k.entity_key<>'' THEN 'entity:'||k.entity_key
        ELSE 'subject:'||lower(trim(COALESCE(NULLIF(k.canonical_subject,''),k.subject))) END) AS subjects,
      SUM(CASE WHEN k.consensus_status='corroborated' THEN 1 ELSE 0 END) AS corroborated,
      SUM(CASE WHEN k.consensus_status='single_source' THEN 1 ELSE 0 END) AS single_source,
      SUM(CASE WHEN k.consensus_status='conflicted' AND COALESCE(kr.status,'')<>'resolved' THEN 1 ELSE 0 END) AS strict_conflicts,
      SUM(CASE WHEN kr.status='resolved' THEN 1 ELSE 0 END) AS manually_resolved
      FROM knowledge_facts k JOIN destinations d ON d.id=k.destination_id
      LEFT JOIN knowledge_resolutions kr ON kr.destination_slug=d.slug AND kr.normalized_key=k.normalized_key
      WHERE k.visibility_status='visible'${destinationClause}`).get(...values);
    const destinations = this.db.prepare(`SELECT d.slug,d.name,COUNT(*) AS facts,
      COUNT(DISTINCT CASE WHEN k.entity_key<>'' THEN 'entity:'||k.entity_key
        ELSE 'subject:'||lower(trim(COALESCE(NULLIF(k.canonical_subject,''),k.subject))) END) AS subjects
      FROM knowledge_facts k JOIN destinations d ON d.id=k.destination_id
      WHERE k.visibility_status='visible' GROUP BY d.id,d.slug,d.name ORDER BY d.name`).all();
    const themes = this.db.prepare(`SELECT ${knowledgeThemeSql("k")} AS theme,COUNT(*) AS count
      FROM knowledge_facts k JOIN destinations d ON d.id=k.destination_id
      WHERE k.visibility_status='visible'${destinationClause} GROUP BY theme ORDER BY count DESC`).all(...values);
    const evidence = this.db.prepare(`SELECT COUNT(DISTINCT json_extract(e.value,'$.source_id')) AS sources
      FROM knowledge_facts k JOIN destinations d ON d.id=k.destination_id,json_each(k.evidence_json) e
      WHERE k.visibility_status='visible'${destinationClause}`).get(...values);
    const claimReviews = this.db.prepare(`SELECT COUNT(*) AS count FROM claim_review_cases
      WHERE status='pending'${destination ? " AND destination_slug=?" : ""}`).get(...values).count;
    const verificationJobs=this.db.prepare(`SELECT COUNT(*) AS count FROM knowledge_verification_jobs
      WHERE status<>'completed'${destination?" AND destination_slug=?":""}`).get(...values).count;
    const repairJobs=destination
      ? this.db.prepare(`SELECT COUNT(*) AS count FROM claim_repair_jobs cr JOIN claims c ON c.id=cr.claim_id
          JOIN structured_sources ss ON ss.source_id=c.source_id WHERE cr.status<>'completed' AND ss.destination_slug=?`).get(destination).count
      : this.db.prepare("SELECT COUNT(*) AS count FROM claim_repair_jobs WHERE status<>'completed'").get().count;
    const automatic=this.db.prepare(`SELECT COUNT(*) AS count FROM knowledge_resolution_events
      WHERE resolution_state LIKE 'AUTO_%'${destination?" AND destination_slug=?":""}`).get(...values).count;
    const entityReviews = this.listEntityMergeCandidates("pending")
      .filter((item) => !destination || item.destination_slug === destination).length;
    return {
      destination: destination || null,
      totals: {
        facts: Number(totals.facts || 0), subjects: Number(totals.subjects || 0),
        independentSources: Number(evidence.sources || 0), strictConflicts: Number(totals.strict_conflicts || 0),
        pendingClaimReviews: Number(claimReviews || 0), pendingEntityReviews: Number(entityReviews || 0),
        pendingManualReview:Number(claimReviews||0)+Number(entityReviews||0),
        automaticResolutions:Number(automatic||0),verificationNeeded:Number(verificationJobs||0),repairNeeded:Number(repairJobs||0),
      },
      consensus: { corroborated: Number(totals.corroborated || 0), singleSource: Number(totals.single_source || 0),
        manuallyResolved: Number(totals.manually_resolved || 0) },
      destinations, themes,
    };
  }

  listKnowledgeSubjects({ destination = "", search = "", limit = 50, cursor = "" } = {}) {
    const clauses = ["k.visibility_status='visible'"];
    const values = [];
    if (destination) { clauses.push("d.slug=?"); values.push(destination); }
    if (search) { clauses.push("lower(COALESCE(NULLIF(k.canonical_subject,''),k.subject)) LIKE ?"); values.push(`%${search.toLowerCase()}%`); }
    const pageSize = Math.max(1, Math.min(100, Number(limit) || 50));
    const offset = Math.max(0, Number.parseInt(cursor, 10) || 0);
    const rows = this.db.prepare(`SELECT d.slug AS destination_slug,d.name AS destination_name,
      CASE WHEN k.entity_key<>'' THEN 'entity:'||k.entity_key
        ELSE 'subject:'||lower(trim(COALESCE(NULLIF(k.canonical_subject,''),k.subject))) END AS subject_key,
      COALESCE(NULLIF(k.canonical_subject,''),k.subject) AS subject,k.entity_type,k.granularity,
      COUNT(*) AS fact_count,MAX(k.updated_at) AS updated_at,
      SUM(CASE WHEN k.consensus_status='conflicted' AND COALESCE(kr.status,'')<>'resolved' THEN 1 ELSE 0 END) AS conflict_count,
      SUM(CASE WHEN ${knowledgeThemeSql("k")}='planning' THEN 1 ELSE 0 END) AS planning_count,
      SUM(CASE WHEN ${knowledgeThemeSql("k")}='transport' THEN 1 ELSE 0 END) AS transport_count,
      SUM(CASE WHEN ${knowledgeThemeSql("k")}='cost' THEN 1 ELSE 0 END) AS cost_count,
      SUM(CASE WHEN ${knowledgeThemeSql("k")}='experience' THEN 1 ELSE 0 END) AS experience_count
      FROM knowledge_facts k JOIN destinations d ON d.id=k.destination_id
      LEFT JOIN knowledge_resolutions kr ON kr.destination_slug=d.slug AND kr.normalized_key=k.normalized_key
      WHERE ${clauses.join(" AND ")}
      GROUP BY d.id,subject_key ORDER BY conflict_count DESC,updated_at DESC,subject LIMIT ? OFFSET ?`)
      .all(...values, pageSize + 1, offset);
    const page = rows.slice(0, pageSize).map((row) => ({ ...row,
      themes: ["planning", "transport", "cost", "experience"].filter((theme) => Number(row[`${theme}_count`] || 0) > 0) }));
    return { items: page, nextCursor: rows.length > pageSize ? String(offset + pageSize) : null };
  }

  listKnowledgeFacts({ destination = "", subjectKey = "", theme = "", conflictOnly = false, limit = 50, cursor = "" } = {}) {
    const clauses = ["k.visibility_status='visible'"];
    const values = [];
    if (destination) { clauses.push("d.slug=?"); values.push(destination); }
    if (subjectKey.startsWith("entity:")) { clauses.push("k.entity_key=?"); values.push(subjectKey.slice(7)); }
    else if (subjectKey.startsWith("subject:")) {
      clauses.push("lower(trim(COALESCE(NULLIF(k.canonical_subject,''),k.subject)))=?"); values.push(subjectKey.slice(8));
    }
    if (theme) { clauses.push(`${knowledgeThemeSql("k")}=?`); values.push(theme); }
    if (conflictOnly) clauses.push("k.consensus_status='conflicted' AND COALESCE(kr.status,'')<>'resolved'");
    const pageSize = Math.max(1, Math.min(100, Number(limit) || 50));
    const offset = Math.max(0, Number.parseInt(cursor, 10) || 0);
    const rows = this.db.prepare(`SELECT k.*,d.slug AS destination_slug,d.name AS destination_name,
      kr.status AS resolution_status,kr.preferred_value AS resolved_value,kr.note AS resolution_note,
      kr.resolved_at AS resolution_resolved_at,kr.resolution_type
      FROM knowledge_facts k JOIN destinations d ON d.id=k.destination_id
      LEFT JOIN knowledge_resolutions kr ON kr.destination_slug=d.slug AND kr.normalized_key=k.normalized_key
      WHERE ${clauses.join(" AND ")} ORDER BY k.updated_at DESC,k.id LIMIT ? OFFSET ?`)
      .all(...values, pageSize + 1, offset);
    return { items: rows.slice(0, pageSize).map(hydrateKnowledgeFact), nextCursor: rows.length > pageSize ? String(offset + pageSize) : null };
  }

  listKnowledgeReviews({ destination = "", limit = 50, cursor = "" } = {}) {
    const values = destination ? [destination] : [];
    const destinationClause = destination ? " AND d.slug=?" : "";
    const strict = this.db.prepare(`SELECT k.*,d.slug AS destination_slug,d.name AS destination_name,
      kr.status AS resolution_status,kr.preferred_value AS resolved_value,kr.note AS resolution_note,
      kr.resolved_at AS resolution_resolved_at,kr.resolution_type
      FROM knowledge_facts k JOIN destinations d ON d.id=k.destination_id
      LEFT JOIN knowledge_resolutions kr ON kr.destination_slug=d.slug AND kr.normalized_key=k.normalized_key
      WHERE k.visibility_status='visible' AND k.consensus_status='conflicted' AND COALESCE(kr.status,'')<>'resolved'${destinationClause}
      ORDER BY k.updated_at DESC`).all(...values).map((row) => ({ kind: "strict_conflict", id: row.id,
        updated_at: row.updated_at, knowledge: hydrateKnowledgeFact(row) }));
    const claimValues = destination ? [destination] : [];
    const claimCases = this.db.prepare(`SELECT crc.*,ca.subject,ca.predicate,ca.value_text,ca.source_quote,ca.source_id,
      cb.value_text AS other_value,cb.source_quote AS other_source_quote,cb.source_id AS other_source_id,
      s.title AS source_title,s2.title AS other_source_title
      FROM claim_review_cases crc JOIN claims ca ON ca.id=crc.claim_a_id
      LEFT JOIN claims cb ON cb.id=crc.claim_b_id LEFT JOIN sources s ON s.id=ca.source_id LEFT JOIN sources s2 ON s2.id=cb.source_id
      WHERE crc.status='pending'${destination ? " AND crc.destination_slug=?" : ""} ORDER BY crc.updated_at DESC`).all(...claimValues)
      .map((row) => ({ ...row, kind: "claim_review" }));
    const entityCases = this.db.prepare(`SELECT * FROM entity_merge_candidates WHERE status='pending'${destination ? " AND destination_slug=?" : ""}
      ORDER BY confidence DESC,updated_at DESC`).all(...values).map((row) => ({ ...row, kind: "entity_review",assessment:assessEntityIdentity(row) }))
      .filter((row) => row.assessment.decision !== "DO_NOT_MERGE");
    const all = [...strict, ...claimCases, ...entityCases].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    const pageSize = Math.max(1, Math.min(100, Number(limit) || 50));
    const offset = Math.max(0, Number.parseInt(cursor, 10) || 0);
    return { items: all.slice(offset, offset + pageSize), nextCursor: all.length > offset + pageSize ? String(offset + pageSize) : null,
      total: all.length };
  }

  getKnowledge() {
    return this.db.prepare(`
      SELECT k.*, d.slug AS destination_slug, d.name AS destination_name,
        kr.status AS resolution_status, kr.preferred_value AS resolved_value, kr.note AS resolution_note,
        kr.resolved_at AS resolution_resolved_at,kr.resolution_type
      FROM knowledge_facts k JOIN destinations d ON d.id = k.destination_id
      LEFT JOIN knowledge_resolutions kr ON kr.destination_slug=d.slug AND kr.normalized_key=k.normalized_key
      ORDER BY d.name, k.normalized_key
    `).all().map(hydrateKnowledgeFact);
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

  modelRuntimeReport({ runId = null, since = null, until = null } = {}) {
    const clauses = [];
    const values = [];
    if (runId) { clauses.push("run_id=?"); values.push(runId); }
    if (since) { clauses.push("created_at>=?"); values.push(since); }
    if (until) { clauses.push("created_at<=?"); values.push(until); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM model_call_metrics ${where} ORDER BY created_at,id`).all(...values);
    const qualifiedDraftIds = this.db.prepare(`SELECT DISTINCT draft_id FROM quality_reviews WHERE passed=1
      ${since ? "AND created_at>=?" : ""} ${until ? "AND created_at<=?" : ""}`).all(...[since, until].filter(Boolean)).map((row) => row.draft_id);
    const firstPass = this.db.prepare(`SELECT COUNT(*) AS total,SUM(passed) AS passed FROM quality_reviews q
      WHERE created_at=(SELECT MIN(q2.created_at) FROM quality_reviews q2 WHERE q2.draft_id=q.draft_id)
      ${since ? "AND created_at>=?" : ""} ${until ? "AND created_at<=?" : ""}`).get(...[since, until].filter(Boolean));
    return {
      ...summarizeModelCostLedger(rows, { qualifiedDraftIds }),
      firstPassQa: { total: Number(firstPass?.total || 0), passed: Number(firstPass?.passed || 0),
        passRate: Number(firstPass?.total || 0) ? Number(firstPass.passed || 0) / Number(firstPass.total) : null },
    };
  }

  pipelinePerformanceReport({ since = null, until = null, concurrency = null } = {}) {
    const clauses = ["completed_at IS NOT NULL"];
    const values = [];
    if (since) { clauses.push("created_at>=?"); values.push(since); }
    if (until) { clauses.push("created_at<=?"); values.push(until); }
    const rows = this.db.prepare(`SELECT id,type,entity_id,status,duration_ms,queue_latency_ms,failure_class
      FROM jobs WHERE ${clauses.join(" AND ")} ORDER BY created_at,id`).all(...values);
    const durations = rows.map((row) => row.duration_ms).filter((value) => value != null).map(Number).sort((a, b) => a - b);
    const queue = rows.map((row) => row.queue_latency_ms).filter((value) => value != null).map(Number).sort((a, b) => a - b);
    return {
      environment: { node: process.version, platform: process.platform, architecture: process.arch,
        concurrency: concurrency == null ? null : Number(concurrency) },
      inputSetHash: sha256(JSON.stringify(rows.map((row) => [row.id, row.type, row.entity_id]))),
      counts: { total: rows.length, succeeded: rows.filter((row) => row.status === "succeeded").length,
        failed: rows.filter((row) => row.status === "failed").length,
        cancelled: rows.filter((row) => row.status === "cancelled").length },
      durationMs: performanceDistribution(durations), queueLatencyMs: performanceDistribution(queue),
      peakMemoryBytes: typeof process.resourceUsage === "function" ? process.resourceUsage().maxRSS * 1024 : null,
      databaseQueryCount: null,
      databaseQueryCountReason: "SQLite query instrumentation is not enabled; no estimate is reported.",
    };
  }

  dashboard() {
    const statuses = this.db.prepare("SELECT status, COUNT(*) AS count FROM sources GROUP BY status").all();
    const recommendationReconciliation=this.reconcileRecommendationInbox();
    const allOperationalExceptions=this.listOperationalExceptions();
    const operationalExceptions = this.listSystemHealthIssues(allOperationalExceptions);
    const maintenance=this.maintenanceOverview({reconciliation:recommendationReconciliation});
    const operationalExceptionGroups = new Set(operationalExceptions.map(operationalExceptionGroupKey)).size;
    const exceptionCount = (kind) => operationalExceptions.filter((item) => item.kind === kind).length;
    const pendingRecommendations = recommendationReconciliation.actionableInbox;
    const contentNeedsAttention = allOperationalExceptions.filter((item) => ["brief","draft"].includes(item.kind)).length;
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
        exceptions: operationalExceptionGroups,
        maintenance: maintenance.pendingTasks,
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
        exceptions: operationalExceptionGroups,
        exceptionRecords: operationalExceptions.length,
        topicCandidates: this.db.prepare("SELECT COUNT(*) AS count FROM topic_candidates").get().count,
        pendingRecommendations,
        internalOpportunities: recommendationReconciliation.internalOpportunities,
        processingGapOpportunities: recommendationReconciliation.processingGap,
        evidenceGapOpportunities: recommendationReconciliation.evidenceGap,
        mergedOpportunities: recommendationReconciliation.merged,
        supersededOpportunities: recommendationReconciliation.superseded,
        contentPipelineItems,
        contentNeedsAttention,
        draftsReady: this.db.prepare("SELECT COUNT(*) AS count FROM article_drafts WHERE status IN ('ready_for_wordpress','commercial_ready','wordpress_draft')").get().count,
        activeOffers: this.db.prepare("SELECT COUNT(*) AS count FROM affiliate_assets WHERE active=1").get().count,
        affiliateQueueTasks: this.db.prepare("SELECT COUNT(*) AS count FROM affiliate_asset_queue_tasks WHERE status IN ('PENDING','READY_FOR_MANUAL','INVALID')").get().count,
        wordpressInventory: this.db.prepare("SELECT COUNT(*) AS count FROM wordpress_content_inventory").get().count,
        searchQueries: this.db.prepare("SELECT COUNT(*) AS count FROM search_console_inventory").get().count,
      },
      jobs: this.db.prepare("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status").all(),
      modelRuntime: this.modelRuntimeReport(),
      pipelinePerformance: this.pipelinePerformanceReport(),
      modelUsage: this.db.prepare(`SELECT stage, provider, model, COUNT(*) AS calls,
        CASE WHEN COUNT(input_tokens)=COUNT(*) THEN SUM(input_tokens) ELSE NULL END AS input_tokens,
        CASE WHEN COUNT(output_tokens)=COUNT(*) THEN SUM(output_tokens) ELSE NULL END AS output_tokens,
        CASE WHEN COUNT(cached_tokens)=COUNT(*) THEN SUM(cached_tokens) ELSE NULL END AS cached_tokens,
        CASE WHEN COUNT(thinking_tokens)=COUNT(*) THEN SUM(thinking_tokens) ELSE NULL END AS thinking_tokens,
        ROUND(AVG(latency_ms),1) AS average_latency_ms,
        SUM(CASE WHEN attempt_status='failed' THEN 1 ELSE 0 END) AS failures,
        SUM(CASE WHEN attempt_status='cancelled' THEN 1 ELSE 0 END) AS cancellations,
        SUM(CASE WHEN request_kind='cache_hit' THEN 1 ELSE 0 END) AS cache_hits,
        CASE WHEN COUNT(cost_usd)=COUNT(*) THEN SUM(cost_usd) ELSE NULL END AS total_cost_usd,
        SUM(CASE WHEN cost_status='unknown' THEN 1 ELSE 0 END) AS unknown_cost_attempts
        FROM model_call_metrics GROUP BY stage, provider, model ORDER BY calls DESC`).all(),
    };
  }

  dashboardSummary() {
    const sources = this.db.prepare("SELECT status,COUNT(*) AS count FROM sources GROUP BY status").all();
    const jobs = this.db.prepare("SELECT status,COUNT(*) AS count FROM jobs GROUP BY status").all();
    const jobCounts = Object.fromEntries(jobs.map((row) => [row.status, Number(row.count || 0)]));
    const strictConflicts = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM knowledge_facts k
      JOIN destinations d ON d.id=k.destination_id
      LEFT JOIN knowledge_resolutions kr ON kr.destination_slug=d.slug AND kr.normalized_key=k.normalized_key
      WHERE k.visibility_status='visible' AND k.consensus_status='conflicted' AND COALESCE(kr.status,'')<>'resolved'`).get().count || 0);
    const claimReviews = Number(this.db.prepare("SELECT COUNT(*) AS count FROM claim_review_cases WHERE status='pending'").get().count || 0);
    const entityReviews = this.listEntityMergeCandidates("pending").length;
    const sourceExceptions = Number(this.db.prepare("SELECT COUNT(*) AS count FROM sources WHERE status='exception'").get().count || 0);
    const failedJobs = this.db.prepare(`SELECT j.type,j.last_failure_code,j.last_error FROM jobs j
      WHERE j.status='failed' AND NOT EXISTS (SELECT 1 FROM jobs recovered
        WHERE recovered.type=j.type AND recovered.entity_id=j.entity_id
          AND recovered.status='succeeded' AND recovered.updated_at>=j.updated_at)`)
      .all().filter((row) => isSystemLevelFailure(row.last_failure_code,row.last_error)).length;
    const pendingRecommendations = Number(this.db.prepare("SELECT COUNT(*) AS count FROM content_opportunities WHERE inbox_state='ACTIONABLE' AND lifecycle_state IN ('recommended','recommended_again','deferred')").get().count || 0);
    const contentPipelineItems = Number(this.db.prepare(`SELECT COUNT(DISTINCT candidate_id) AS count FROM content_opportunities
      WHERE candidate_id IS NOT NULL AND lifecycle_state IN ('producing','finished')
        AND status IN ('producing','drafted','qa_failed','ready_for_wordpress','wordpress_draft')`).get().count || 0);
    const commercialActions = Number(this.db.prepare(`SELECT
      (SELECT COUNT(*) FROM affiliate_asset_queue_tasks WHERE status IN ('PENDING','READY_FOR_MANUAL','INVALID'))+
      (SELECT COUNT(*) FROM affiliate_opportunities WHERE status='open' AND score>=0.75) AS count`).get().count || 0);
    const queueActive = Number(jobCounts.queued || 0) + Number(jobCounts.running || 0);
    return {
      generatedAt: now(), sources: Object.fromEntries(sources.map((row) => [row.status, Number(row.count || 0)])), jobs,
      queue: { active: queueActive, queued: Number(jobCounts.queued || 0), running: Number(jobCounts.running || 0) },
      health: { ok: sourceExceptions + failedJobs === 0, issues: sourceExceptions + failedJobs },
      actionCounts: {
        sources: sourceExceptions, recommendations: pendingRecommendations,
        knowledge: strictConflicts + claimReviews + entityReviews, blueprints: 0, content: 0, wordpress: 0,
        commercial: commercialActions, exceptions: sourceExceptions + failedJobs, maintenance: queueActive, settings: 0,
      },
      totals: {
        sources: Number(this.db.prepare("SELECT COUNT(*) AS count FROM sources").get().count || 0),
        claims: Number(this.db.prepare("SELECT COUNT(*) AS count FROM claims").get().count || 0),
        knowledgeFacts: Number(this.db.prepare("SELECT COUNT(*) AS count FROM knowledge_facts WHERE visibility_status='visible'").get().count || 0),
        conflicts: strictConflicts, exceptions: sourceExceptions + failedJobs, exceptionRecords: sourceExceptions + failedJobs,
        topicCandidates: Number(this.db.prepare("SELECT COUNT(*) AS count FROM topic_candidates").get().count || 0),
        pendingRecommendations, internalOpportunities: Number(this.db.prepare("SELECT COUNT(*) AS count FROM content_opportunities WHERE inbox_state='INTERNAL' AND lifecycle_state IN ('recommended','recommended_again','deferred')").get().count || 0),
        processingGapOpportunities: Number(this.db.prepare("SELECT COUNT(*) AS count FROM content_opportunities WHERE inbox_state='INTERNAL' AND processing_state='PROCESSING_GAP' AND lifecycle_state IN ('recommended','recommended_again','deferred')").get().count || 0),
        evidenceGapOpportunities: Number(this.db.prepare("SELECT COUNT(*) AS count FROM content_opportunities WHERE processing_state='EVIDENCE_GAP' AND lifecycle_state IN ('recommended','recommended_again','deferred')").get().count || 0),
        contentPipelineItems, contentNeedsAttention: 0,
        draftsReady: Number(this.db.prepare("SELECT COUNT(*) AS count FROM article_drafts WHERE status IN ('ready_for_wordpress','commercial_ready','wordpress_draft')").get().count || 0),
        activeOffers: Number(this.db.prepare("SELECT COUNT(*) AS count FROM affiliate_assets WHERE active=1 AND lifecycle_state='operational'").get().count || 0),
        affiliateQueueTasks: Number(this.db.prepare("SELECT COUNT(*) AS count FROM affiliate_asset_queue_tasks WHERE status IN ('PENDING','READY_FOR_MANUAL','INVALID')").get().count || 0),
        wordpressInventory: Number(this.db.prepare("SELECT COUNT(*) AS count FROM wordpress_content_inventory").get().count || 0),
      },
    };
  }

  providerRuntime({provider="",model="",configured=false}={}) {
    if(!configured)return {state:"not_configured",provider:null,model:null,lastSuccessAt:null,lastFailureAt:null};
    const key=String(provider||"unknown");
    const persisted=this.db.prepare("SELECT * FROM provider_runtime_state WHERE provider=?").get(key)||{};
    const latestSuccess=this.db.prepare("SELECT created_at,latency_ms FROM model_call_metrics WHERE provider=? AND status='succeeded' ORDER BY created_at DESC LIMIT 1").get(key);
    const latestFailure=this.db.prepare("SELECT created_at,error_code,latency_ms FROM model_call_metrics WHERE provider=? AND status='failed' ORDER BY created_at DESC LIMIT 1").get(key);
    const aggregate=(hours)=>this.db.prepare(`SELECT COUNT(*) AS attempts,
        SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS successes,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failures,
        SUM(CASE WHEN error_code LIKE '%429%' OR lower(error_code) LIKE '%rate%' THEN 1 ELSE 0 END) AS rate_limited,
        ROUND(AVG(provider_request_ms),1) AS average_provider_ms,ROUND(AVG(total_stage_ms),1) AS average_total_ms,
        ROUND(AVG(retry_wait_ms),1) AS average_retry_wait_ms
      FROM model_call_metrics WHERE provider=? AND created_at>=datetime('now',?)`).get(key,`-${hours} hours`);
    const oneHour=aggregate(1),twentyFourHours=aggregate(24);
    const backoffUntil=Math.max(this.providerBackoffUntil,Date.parse(persisted.backoff_until||"")||0);
    const lastSuccessAt=persisted.last_success_at||latestSuccess?.created_at||null,lastFailureAt=persisted.last_failure_at||latestFailure?.created_at||null;
    const state=backoffUntil>Date.now()?"backoff"
      : !lastSuccessAt&&!lastFailureAt?"configured_not_observed"
        : lastFailureAt&&(!lastSuccessAt||lastFailureAt>lastSuccessAt)?"degraded"
          : "available_recent_success";
    return {state,provider:key,model:model||persisted.model||null,lastSuccessAt,lastFailureAt,
      lastErrorCode:persisted.last_error_code||latestFailure?.error_code||null,consecutiveFailures:Number(persisted.consecutive_failures||0),
      backoffUntil:backoffUntil?new Date(backoffUntil).toISOString():null,lastLatencyMs:persisted.last_latency_ms??latestSuccess?.latency_ms??latestFailure?.latency_ms??null,
      windows:{oneHour,twentyFourHours},source:"persisted_model_call_telemetry"};
  }

  systemHealthIssueCount() {
    const sourceExceptions = Number(this.db.prepare("SELECT COUNT(*) AS count FROM sources WHERE status='exception'").get().count || 0);
    const failedJobs = this.db.prepare(`SELECT j.type,j.last_failure_code,j.last_error FROM jobs j
      WHERE j.status='failed' AND NOT EXISTS (SELECT 1 FROM jobs recovered
        WHERE recovered.type=j.type AND recovered.entity_id=j.entity_id
          AND recovered.status='succeeded' AND recovered.updated_at>=j.updated_at)`)
      .all().filter((row) => isSystemLevelFailure(row.last_failure_code,row.last_error)).length;
    return sourceExceptions + failedJobs;
  }

  recordModelCall(metric) {
    const metricId=id("modelcall");
    const recordedAt=now();
    this.db.prepare(`INSERT INTO model_call_metrics(id,stage,provider,model,prompt_hash,schema_hash,input_hash,
      input_tokens,output_tokens,cached_tokens,latency_ms,attempts,status,error_code,cost_usd,created_at,
      run_id,entity_id,attempt_number,request_kind,attempt_status,retry_reason,thinking_tokens,provider_usage_json,
      config_hash,policy_version,cost_status,price_version,price_source,price_as_of,request_started_at,request_completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      metricId, metric.stage || "unknown", metric.provider || "unknown", metric.model || "unknown",
      metric.promptHash || "", metric.schemaHash || "", metric.inputHash || "", metric.inputTokens ?? null,
      metric.outputTokens ?? null, metric.cachedTokens ?? null, metric.latencyMs ?? 0, metric.attempts ?? 1,
      metric.status === "succeeded" ? "succeeded" : "failed", metric.errorCode || null, metric.costUsd ?? null, now(),
      metric.runId || null, metric.entityId || null, metric.attemptNumber ?? metric.attempts ?? 1,
      metric.requestKind || "provider", metric.attemptStatus || metric.status || "succeeded", metric.retryReason || null,
      metric.thinkingTokens ?? null, metric.providerUsage ? JSON.stringify(metric.providerUsage) : null,
      metric.configHash || "", metric.policyVersion || "legacy", metric.costStatus || "unknown",
      metric.priceVersion || null, metric.priceSource || null, metric.priceAsOf || null,
      metric.requestStartedAt || null, metric.requestCompletedAt || null,
    );
    const providerRequestMs=metric.providerRequestMs??metric.latencyMs??0;
    const totalStageMs=metric.totalStageMs??((metric.queueWaitMs||0)+providerRequestMs+(metric.retryWaitMs||0));
    this.db.prepare(`UPDATE model_call_metrics SET queue_wait_ms=?,provider_request_ms=?,retry_wait_ms=?,total_stage_ms=?,
      retry_after_ms=?,backoff_until=?,cache_hit=?,execution_route=? WHERE id=?`).run(
      metric.queueWaitMs??null,providerRequestMs,metric.retryWaitMs??0,totalStageMs,metric.retryAfterMs??null,
      metric.backoffUntil||null,metric.cacheHit||metric.requestKind==="cache_hit"?1:0,metric.executionRoute||null,metricId);
    const provider=metric.provider||"unknown",succeeded=metric.status==="succeeded";
    this.db.prepare(`INSERT INTO provider_runtime_state(provider,model,last_success_at,last_failure_at,last_error_code,
        consecutive_failures,backoff_until,last_latency_ms,updated_at) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(provider) DO UPDATE SET model=excluded.model,
        last_success_at=CASE WHEN excluded.last_success_at IS NOT NULL THEN excluded.last_success_at ELSE provider_runtime_state.last_success_at END,
        last_failure_at=CASE WHEN excluded.last_failure_at IS NOT NULL THEN excluded.last_failure_at ELSE provider_runtime_state.last_failure_at END,
        last_error_code=CASE WHEN excluded.last_failure_at IS NOT NULL THEN excluded.last_error_code ELSE provider_runtime_state.last_error_code END,
        consecutive_failures=CASE WHEN excluded.last_success_at IS NOT NULL THEN 0 ELSE provider_runtime_state.consecutive_failures+1 END,
        backoff_until=COALESCE(excluded.backoff_until,provider_runtime_state.backoff_until),last_latency_ms=excluded.last_latency_ms,
        updated_at=excluded.updated_at`).run(provider,metric.model||"",succeeded?recordedAt:null,succeeded?null:recordedAt,
          succeeded?null:(metric.errorCode||"MODEL_CALL_FAILED"),succeeded?0:1,metric.backoffUntil||null,providerRequestMs,recordedAt);
    if (metric.status === "succeeded" && Number(metric.attempts ?? 1) > 0 && this.providerPressureStreak) {
      this.providerSuccessStreak += 1;
      if (this.providerSuccessStreak >= this.providerRecoverySuccesses) {
        this.providerPressureStreak = 0;
        this.providerSuccessStreak = 0;
        this.providerBackoffUntil = 0;
        this.db.prepare("UPDATE provider_runtime_state SET backoff_until=NULL,updated_at=? WHERE provider=?").run(now(),provider);
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

function hydrateSource({ source, assets, files = [], structured, claims, extractionRuns = [], claimHistory = [], blueprint, analysis = null, recommendation = null, segments = [], coverage = [], family = null, captureVersions = [], experienceBlocks = [], mediaManifest = null }) {
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
    claim.evidence_span_ids = json(claim.evidence_span_ids_json, []);
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
    experience_blocks: experienceBlocks,
    media_manifest: mediaManifest,
  };
}

function hydrateExperienceBlock(row) {
  return { ...row, segment_ids: json(row.segment_ids_json, []), sequence: json(row.sequence_json, []),
    decision_logic: json(row.decision_logic_json, []), conditions: json(row.conditions_json, []),
    tradeoffs: json(row.tradeoffs_json, []), warnings: json(row.warnings_json, []),
    alternatives: json(row.alternatives_json, []), supporting_claim_ids: json(row.supporting_claim_ids_json, []),
    evidence_span_ids: json(row.evidence_span_ids_json, []) };
}

function uniqueStrings(values, maximum = 100) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))].slice(0, maximum);
}

function cleanExperienceItems(values) {
  return uniqueStrings(values, 60).map((value) => value.slice(0, 1_000));
}

function normalizeExperienceType(value) {
  const allowed = new Set(["route_strategy","itinerary_sequence","timing_strategy","tradeoff","decision_rule","avoidance_strategy",
    "food_prioritization","transport_choice","booking_workflow","photo_strategy","solo_traveler_adaptation","experience_sequence"]);
  const normalized = String(value || "experience_sequence").toLowerCase().replace(/[^a-z0-9_]+/gu, "_");
  return allowed.has(normalized) ? normalized : "experience_sequence";
}

function inferKnowledgeOpportunityType(title, facts) {
  const text = `${title || ""} ${(facts || []).map((fact) => `${fact.subject || ""} ${fact.predicate || ""}`).join(" ")}`.toLowerCase();
  if (/(?:food|restaurant|dish|eat|餐|菜|美食|小吃)/u.test(text)) return "food_guide";
  if (/(?:transport|metro|rail|bus|station|route|交通|地铁|车站|路线)/u.test(text)) return "transport_guide";
  if (/(?:itinerary|day trip|行程|一日游)/u.test(text)) return "itinerary";
  if (/(?:hotel|stay|neighbou?rhood|住宿|酒店|区域)/u.test(text)) return "hotel_area_guide";
  if (/(?:attraction|ticket|reservation|visit|景点|门票|预约)/u.test(text)) return "attraction_guide";
  if (/(?:compare|versus|difference|比较|区别)/u.test(text)) return "comparison";
  return "practical_guide";
}

function jobPriority(type) {
  if (type==="repair_media_asset" || type==="extract_source") return 10;
  if (["finalize_source_extraction","rebuild_knowledge","audit_segment_coverage"].includes(type)) return 15;
  if (["preflight_source","segment_source","extract_segment_claims","retry_segment_extraction"].includes(type)) return 20;
  if (["extract_source_experience","analyze_source_diagnostic","resolve_entities","rebuild_topic_clusters","build_coverage_matrix","rebuild_content_opportunities","reconcile_approved_opportunities",
    "assemble_editorial","plan_content","plan_narrative","assemble_writing_packet","compose_frontend_page_plan","generate_draft","generate_visuals","review_draft","revise_draft","compose_frontend_page","compose_commercial","compose_publish_page","push_wordpress_draft"].includes(type)) return 30;
  if (type==="backfill_media_asset") return 70;
  return 60;
}

function isSystemLevelFailure(code, message) {
  return /(?:AUTH|CREDENTIAL|DATABASE_(?:CORRUPT|CORRUPTION|UNAVAILABLE|LOCKED|IOERR)|SQLITE_(?:CORRUPT|CANTOPEN|IOERR|FULL)|FRONTEND_CONTRACT|SCHEMA_MISMATCH|AI_PROVIDER|QUOTA|RATE_LIMIT|TIMEOUT|NETWORK|PIPELINE_SHUTDOWN|JOB_LEASE)/i
    .test(`${code} ${message}`);
}

function isMediaRecoveryFailure(code, message) {
  return /(?:MEDIA|IMAGE|VISUAL).*(?:403|404|UNAVAILABLE|MISSING|DOWNLOAD|BYTES)|(?:403|404).*(?:MEDIA|IMAGE|VISUAL)/i
    .test(`${code} ${message}`);
}

function productionFailureCategory(code, message) {
  const text=`${code} ${message}`;
  if (/EVIDENCE|UNSUPPORTED|FACT|CONFLICT/i.test(text)) return "EVIDENCE_SCOPE";
  if (/NARRATIVE|DATABASE_DUMP|GENERIC|STRUCTURE|READABILITY|REPET/i.test(text)) return "EDITORIAL_QUALITY";
  if (/SEO|TITLE|DUPLICATE|COLLISION/i.test(text)) return "SEO_SCOPE";
  if (/PAGE|COMPONENT|COMPOSITION/i.test(text)) return "PAGE_COMPOSITION";
  return "PRODUCTION_INPUT";
}

function normalizeFailureReason(message) {
  return String(message || "Production input failed")
    .replace(/[a-f0-9]{24,}/giu,"<id>").replace(/https?:\/\/\S+/giu,"<url>").replace(/\s+/gu," ").trim().slice(0,1200);
}

function failureRemediation(category) {
  return {
    EVIDENCE_SCOPE:"Narrow the reader promise and reassemble only supported Claims and Experience Blocks.",
    EDITORIAL_QUALITY:"Change the narrative logic before rewriting; avoid repeating the failed prose pattern.",
    SEO_SCOPE:"Recheck published-content overlap and choose NEW, UPDATE, EXPAND, MERGE, or SKIP before production.",
    PAGE_COMPOSITION:"Re-plan semantic components from the active Frontend Contract before drafting again.",
    PRODUCTION_INPUT:"Rebuild Editorial Assembly and Narrative Plan from the preserved research layers.",
  }[category];
}

function productionFailureRetrySafe(category) {
  return ["EVIDENCE_SCOPE","EDITORIAL_QUALITY","SEO_SCOPE","PAGE_COMPOSITION","PRODUCTION_INPUT"].includes(category);
}

function recommendationInboxRank(item) {
  const retryPriority=item.row.lifecycle_state==="recommended_again" ? 1_000_000 : 0;
  const readyPriority=item.processingState==="CURRENT" ? 100_000 : 0;
  return retryPriority+readyPriority+Number(item.row.readiness_score || 0)*100;
}

function canonicalIntentKeyForOpportunity(row) {
  const coverage=json(row.coverage_json,{});
  const duration=canonicalDuration(`${row.title || ""} ${row.topic_key || ""} ${coverage.proposal?.readerPromise || ""}`);
  const destination=slugify(row.destination_slug || "unknown") || "unknown";
  const mode=normalizePublicationMode(coverage.publicationMode);
  const generic=new Set([
    "a","an","and","for","in","of","the","to","travel","guide","how","visit","independently","independent",
    "traveler","travelers","first","time","solo","practical","help","make","confident","decision","about",
    "walking","walk","city","route","routes","itinerary","itineraries","day","days","hour","hours","hourly",
  ]);
  const text=`${row.title || ""} ${coverage.proposal?.readerPromise || ""}`
    .toLowerCase().replace(/\b(?:72\s*[- ]?hours?|3\s*[- ]?days?)\b/gu," ");
  const tokens=[...topicTokens(text)].filter((token) => !generic.has(token) && token!==destination && !/^\d+$/u.test(token)).sort();
  return [destination,normalizeContentType(row.content_type),mode,duration,tokens.slice(0,12).join("-") || "destination-core"].join(":");
}

function canonicalDuration(value) {
  const text=String(value || "").toLowerCase();
  const hours=text.match(/\b(\d{1,3})\s*[- ]?hours?\b/u);
  if (hours) return `${Math.max(1,Math.round(Number(hours[1])/24))}d`;
  const days=text.match(/\b(\d{1,2})\s*[- ]?days?\b/u);
  if (days) return `${Number(days[1])}d`;
  return "flex";
}

function recommendationProductionTypeLabel(row) {
  const mode=normalizePublicationMode(json(row.coverage_json,{}).publicationMode);
  return ({source_adaptation:"单来源改编",topic_feature:"单主题专题",multi_source_synthesis:"多来源综合"})[mode]
    || "内容专题";
}

function recommendationPlainReason(row, readiness) {
  const facts=Number(readiness.factCount || 0); const families=Number(readiness.sourceFamilyCount || 0);
  if (row.lifecycle_state==="recommended_again") return "上次生产留下了可执行的修复规则，研究证据仍然有效。系统会按新的修复方案重新组织内容，不复用失败稿件。";
  if (row.processing_state==="EVIDENCE_GAP") return `主题方向已经明确，目前有 ${facts} 条可追溯事实；批准后会保留决定，等关键证据补齐再自动进入生产。`;
  return `现有素材包含 ${facts} 条可追溯事实，来自 ${families} 个独立来源组，已达到当前内容类型的生产门槛。`;
}

function productionFailureChineseSummary(previousFailure) {
  const category={
    EVIDENCE_SCOPE:"上次内容超出了证据范围",
    EDITORIAL_QUALITY:"上次稿件的叙事或可读性未达标",
    SEO_SCOPE:"上次生产发现发布范围或页面重合",
    PAGE_COMPOSITION:"上次页面结构没有通过组件约束",
    PRODUCTION_INPUT:"上次生产输入不完整",
  }[previousFailure.category] || "上次生产没有达到发布条件";
  const remedy={
    EVIDENCE_SCOPE:"本次将缩小读者承诺，只使用有证据支持的信息。",
    EDITORIAL_QUALITY:"本次会先重做叙事逻辑，再生成新稿。",
    SEO_SCOPE:"本次会先重新核对已有页面并确定发布动作。",
    PAGE_COMPOSITION:"本次会按当前页面组件规范重新规划。",
    PRODUCTION_INPUT:"本次会从保留的研究层重新生成写作输入。",
  }[previousFailure.category] || "本次会从当前研究与处理版本重新开始。";
  return `${category}。${remedy}`;
}

function editorialPrinciple(feedback) {
  return {
    "AI味重":"Use concrete traveler decisions and grounded Experience Blocks; remove generic transitions and manufactured enthusiasm.",
    "太啰嗦":"Compress repeated explanations and keep only details that change a traveler decision.",
    "信息太平":"Build a stronger throughline from route, condition, trade-off and warning Experience Blocks.",
    "像数据库":"Synthesize facts into a narrative sequence instead of enumerating fields.",
    "结构不好":"Redesign the Narrative Plan before revising prose.",
    "满意":"Preserve the article's concise evidence-led structure as a positive pattern.",
    "很好":"Preserve the article's concise evidence-led structure as a positive pattern.",
  }[feedback] || "";
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

function captureStorageSnapshot(capture){
  const cleanAsset=(asset)=>{const {originalDataUrl:_original,aiDerivativeDataUrl:_derivative,...stored}=asset||{};return stored;};
  return {...capture,assets:(capture.assets||[]).map(cleanAsset)};
}

function safeIsoDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function draftMetadata(draft, brief, config, authorizedSourceAssets = [], policy = contentPolicyFor(brief)) {
  const canonical = json(brief.canonical_json, {});
  const canonicalResolution = resolveCanonicalUrl({ siteUrl: config.publicSiteUrl, slug: draft.slug });
  const canonicalUrl = canonicalResolution.url;
  const seo = {
    primary_keyword: truncateText(draft.seo?.primary_keyword || draft.seo?.focus_keyword || canonical.seo?.primary_keyword || brief.topic || draft.title, 160),
    secondary_keywords: (draft.seo?.secondary_keywords || canonical.secondary_queries || []).slice(0, 8).map((item) => truncateText(item, 160)),
    search_intent: truncateText(draft.seo?.search_intent || canonical.content_intent || brief.search_intent || "informational", 120),
    seo_title: truncateText(draft.seo?.seo_title || draft.seo?.meta_title || draft.title, 200),
    meta_title: truncateText(draft.seo?.seo_title || draft.seo?.meta_title || draft.title, 200),
    focus_keyword: truncateText(draft.seo?.primary_keyword || draft.seo?.focus_keyword || brief.topic || draft.title, 160),
    meta_description: truncateText(draft.meta_description, 500),
    slug: draft.slug,
    canonical_url: canonicalUrl,
    canonical_status: canonicalResolution.status,
    canonical_reason: canonicalResolution.reason,
    robots: "noindex,nofollow",
    og_title: truncateText(draft.seo?.og_title || draft.seo?.seo_title || draft.seo?.meta_title || draft.title, 200),
    og_description: truncateText(draft.seo?.og_description || draft.meta_description, 500),
    og_image: null,
    key_takeaways: (draft.seo?.key_takeaways || []).slice(0, 6).map((item) => truncateText(item, 240)),
    faqs: policy.faq?.allowed
      ? (draft.faqs || []).slice(0, policy.faq.maximum || 4).map((item) => ({ question: truncateText(item.question, 220), answer: truncateText(item.answer, 700) }))
      : [],
  };
  const visuals = normalizeVisuals(draft.visuals, draft, brief, authorizedSourceAssets, policy);
  const firstGenerated = visuals.find((visual) => visual.status === "generated" && visual.media_url);
  if (firstGenerated) seo.og_image = firstGenerated.media_url;
  const contentAst = buildContentAst({ draft: { ...draft, seo }, brief: { ...brief, canonical }, visuals });
  const blocks = contentAst.nodes.filter((node) => node.type !== "media").map((node) => node.type === "list"
    ? { type: "list", items: node.items } : node.type === "heading"
      ? { type: "heading", level: node.level, text: node.visible_text } : { type: "paragraph", text: node.visible_text });
  return {
    seo, visuals, blocks, contentAst,
    schema: buildArticleSchema({ ...draft, seo, content_ast: contentAst, destination_slug: brief.destination_slug, canonical }, visuals, config),
  };
}

export function contentPolicyFor(brief, facts = []) {
  const canonical = json(brief?.canonical_json, brief?.canonical || {});
  const type = canonical.content_type || "first_time_guide";
  const substantialEvidence = facts.filter((fact) => (fact.evidence || []).length > 0).length;
  const topic = `${brief?.topic || ""} ${canonical.primary_query || ""}`;
  const shortTips = /\b(?:quick tips?|checklist|what to pack|phrases?)\b/i.test(topic);
  const multiDay = /\b(?:[2-9]|two|three|four|five|six|seven)[ -]?day\b/i.test(topic);
  const profiles = {
    city_guide: [900, 1400, 3], first_time_guide: [900, 1400, 3], itinerary: multiDay ? [900, 1400, 3] : [600, 1000, 2],
    comparison: [600, 1000, 2], listicle: [600, 1000, 2], food_guide: [600, 1000, 2],
    neighborhood_guide: [600, 1000, 2], hotel_area_guide: [600, 1000, 2], shopping_guide: [600, 1000, 2],
    attraction_guide: [350, 700, 2], transport_guide: [350, 700, 2], practical_guide: shortTips ? [200, 400, 1] : [350, 700, 2],
    how_to: shortTips ? [200, 400, 1] : [350, 700, 2],
  };
  const [baseMinimum, maximumWords, baseVisuals] = profiles[type] || profiles.first_time_guide;
  const minimumWords = Math.min(baseMinimum, Math.max(350, substantialEvidence * 120));
  const questionIntent = /\b(?:how|what|when|where|which|can|should|is|are|faq|questions?)\b/i
    .test(`${brief?.topic || ""} ${brief?.search_intent || ""} ${canonical.primary_query || ""}`);
  const faqSupported = questionIntent && substantialEvidence >= 3;
  return {
    version: "content-policy-1.1",
    content_type: type,
    minimum_words: minimumWords,
    minimum_words_mode: "soft_editorial_guidance",
    target_words: Math.min(maximumWords, Math.max(minimumWords, substantialEvidence * 180)),
    maximum_words: maximumWords,
    required_visible_sections: [],
    seo: { title_suggested_max: 60, description_suggested_max: 160, length_mode: "soft_editorial_guidance" },
    faq: { required: false, allowed: faqSupported, minimum: 0, maximum: faqSupported ? 4 : 0 },
    visuals: { minimum: 0, target: substantialEvidence ? Math.min(baseVisuals, Math.max(1, Math.ceil(substantialEvidence / 4))) : 0,
      maximum: baseVisuals + 1, count_mode: "soft_editorial_guidance" },
  };
}

export function readerSources(facts) {
  const unique = new Map();
  for (const evidence of facts.flatMap((fact) => fact.evidence || [])) {
    const url = [evidence.final_url, evidence.canonical_url, evidence.original_url, evidence.url]
      .map((value) => String(value || "").trim()).find((value) => /^https?:\/\//i.test(value)) || "";
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

function defaultSourceIdentity(capture) {
  const publicUrl = [capture.finalUrl, capture.canonicalUrl, capture.submittedUrl]
    .map((value) => String(value || "").trim()).find((value) => /^https?:\/\//i.test(value));
  if (publicUrl) return `url:${canonicalizeUrl(publicUrl).toLowerCase()}`;
  const hashes = (capture.files || []).map((file) => file.sha256).filter(Boolean).sort();
  if (hashes.length) return `file:${sha256(hashes.join(":"))}`;
  return capture.adapter && capture.externalId ? `${capture.adapter}:${capture.externalId}` : "";
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
    content_ast: metadata.contentAst,
    strategy_version: brief.strategy_version,
  }));
}

function evidenceHashForFacts(facts) {
  return dependencyHash((facts || []).map(selectedFactSnapshot).sort((a,b)=>a.normalized_key.localeCompare(b.normalized_key)));
}

function normalizeBriefPlan(plan) {
  const normalized = structuredClone(plan || {});
  const selected = new Set();
  let requestedCount = 0;
  normalized.outline = (normalized.outline || []).map((section) => {
    const requested = [...new Set(section.claim_keys || [])].sort();
    requestedCount += requested.length;
    const claimKeys = requested.filter((key) => selected.has(key) || selected.size < 48).slice(0, 12);
    for (const key of claimKeys) selected.add(key);
    const sectionId = validSemanticId(section.section_id) || `section_${sha256(JSON.stringify({ heading: section.heading || "", claimKeys })).slice(0, 20)}`;
    return { ...section, section_id: sectionId, claim_keys: claimKeys };
  });
  normalized.evidence_selection = {
    requested_count: requestedCount,
    selected_count: selected.size,
    omitted_count: Math.max(0, requestedCount - normalized.outline.reduce((sum, section) => sum + section.claim_keys.length, 0)),
    max_total: 48,
    max_per_section: 12,
  };
  return normalized;
}

function normalizeDraftLedger(ledger, briefPlan) {
  const sections = briefPlan?.outline || [];
  return (ledger || []).map((entry) => {
    const claimKeys = [...new Set(entry.claim_keys || [])].sort();
    const matches = sections.filter((section) => {
      const planned = new Set(section.claim_keys || []);
      return claimKeys.length > 0 && claimKeys.every((key) => planned.has(key));
    });
    const sectionId = validSemanticId(entry.section_id) || (matches.length === 1 ? matches[0].section_id : null)
      || `section_${sha256(JSON.stringify({ claimKeys, label: entry.section || "" })).slice(0, 20)}`;
    const nodeIds = [...new Set((entry.content_node_ids || []).map(validSemanticId).filter(Boolean))];
    return { ...entry, section_id: sectionId,
      content_node_ids: nodeIds.length ? nodeIds : [`node_${sha256(`${sectionId}:${claimKeys.join("|")}`).slice(0, 20)}`],
      claim_keys: claimKeys, source_ids: [...new Set(entry.source_ids || [])].sort() };
  });
}

function normalizePagePlan(plan) {
  const normalized = structuredClone(plan || {});
  normalized.blocks = (normalized.blocks || []).map((block) => ({
    ...block,
    content_node_id: validSemanticId(block.content_node_id) || "",
    source_section_ids: [...new Set((block.source_section_ids || []).map(validSemanticId).filter(Boolean))],
    claim_keys: [...new Set(block.claim_keys || [])].sort(),
    factuality: block.factuality === "non_factual" ? "non_factual" : "factual",
  }));
  return normalized;
}

function validSemanticId(value) {
  const text = String(value || "").trim();
  return /^[a-z][a-z0-9_.:-]{2,127}$/i.test(text) ? text : "";
}

export function buildBlockProvenance(payload, ledger, explicit, sourceIdsByClaim = new Map(), claimTracesByKey = new Map(), factSnapshots = new Map()) {
  const ledgerBySection = new Map((ledger || []).map((entry) => [entry.section_id, entry]));
  const entriesBySignature = Map.groupBy(explicit?.entries || [], (entry) => entry.blockSignature);
  const errors = [...(explicit?.errors || [])];
  const blocks = (payload?.blocks || []).map((block) => {
    const signature = pageBlockSignature(block);
    const candidates = entriesBySignature.get(signature) || [];
    const entry = candidates.shift() || null;
    if (!entry) {
      errors.push({ code: "MISSING_BLOCK_PROVENANCE", blockSignature: signature });
      return legacyBlockRecord(block, signature);
    }
    const sectionEntries = (entry.sourceSectionIds || []).map((sectionId) => ledgerBySection.get(sectionId)).filter(Boolean);
    const allowedClaims = new Set(sectionEntries.flatMap((item) => item.claim_keys || []));
    const claimKeys = entry.factuality === "non_factual" ? [] : [...new Set(entry.claimKeys || [])].filter((key) => allowedClaims.has(key)).sort();
    const sourceIds = [...new Set(claimKeys.flatMap((key) => sourceIdsByClaim.get(key) || []))].sort();
    const claimTraces = claimKeys.flatMap((key) => (claimTracesByKey.get(key) || []).map((trace) => ({ claimKey: key, ...trace })));
    if ((entry.sourceSectionIds || []).some((sectionId) => !ledgerBySection.has(sectionId))) {
      errors.push({ code: "UNKNOWN_SOURCE_SECTION", contentNodeId: entry.contentNodeId });
    }
    if (entry.factuality === "factual" && (!claimKeys.length || !sourceIds.length)) {
      errors.push({ code: "UNTRACEABLE_FACTUAL_BLOCK", contentNodeId: entry.contentNodeId });
    }
    return {
      blockId: `block_${entry.contentNodeId}_${signature.slice(0, 12)}`,
      contentNodeId: entry.contentNodeId,
      type: block?.type || "unknown",
      semanticRole: entry.factuality === "non_factual" ? "non_factual" : "factual",
      factuality: entry.factuality,
      sourceSectionIds: entry.sourceSectionIds || [],
      claimKeys,
      sourceIds,
      claimTraces,
      evidenceSnapshots: claimKeys.map(key => factSnapshots.get(key)).filter(Boolean),
      mappingStatus: "explicit_v2",
      blockSignature: signature,
    };
  });
  return { version: "2", valid: explicit?.valid !== false && errors.length === 0, errors, blocks };
}

function legacyBlockProvenance(payload) {
  return (payload?.blocks || []).map((block) => legacyBlockRecord(block, pageBlockSignature(block)));
}

function legacyBlockRecord(block, signature) {
  return { blockId: `legacy_${signature.slice(0, 20)}`, contentNodeId: null, type: block?.type || "unknown",
    semanticRole: "legacy_unknown", factuality: "unknown", sourceSectionIds: [], claimKeys: [], sourceIds: [], claimTraces: [],
    mappingStatus: "legacy_unknown", blockSignature: signature };
}

export function normalizeVisuals(values, draft, brief, authorizedSourceAssets = [], policy = {}) {
  const maximum = policy.visuals?.maximum ?? 5;
  const allowedPlacements = ["hero", "after_intro", "mid_article", "before_faq", "closing"];
  const allowedRatios = ["16:9", "4:3", "1:1", "3:2", "9:16"];
  const supplied = Array.isArray(values) ? values : [];
  // Writer output is authoritative. The target is guidance, never a reason to
  // synthesize filler slots. Unsupported renderer types are absent from the
  // plan until a real renderer and validated data source are configured.
  const visuals = supplied.slice(0, maximum)
    .filter((item) => !["infographic", "map_or_route"].includes(item?.image_type))
    .map((item, index) => normalizeVisual(item, index, draft, brief, allowedPlacements, allowedRatios));
  const unusedAssets = new Map(authorizedSourceAssets.map((asset) => [asset.id, asset]));
  return visuals.map((visual) => {
    if (visual.image_type !== "real_world_photo") return visual;
    const ranked = [...unusedAssets.values()].map((asset) => ({ asset, score: visualAssetMatchScore(visual, asset) }))
      .sort((left, right) => right.score - left.score);
    const match = ranked[0];
    // Asset ownership is insufficient: a factual photo is reusable only when its
    // own alt/evidence metadata matches the planned subject.
    if (!match || match.score < 0.34) return null;
    const asset = match.asset;
    unusedAssets.delete(asset.id);
    const needsLocalization = ["chinese", "mixed"].includes(asset.language_status);
    return {
      ...visual,
      purpose: truncateText(visual.purpose || `Evidence-linked view for ${draft.title}`, 300),
      alt_text: truncateText(asset.alt_text || visual.alt_text || visual.image_subject, 220),
      caption: truncateText(asset.caption_text || visual.caption || "Photo retained from an authorized research source.", 300),
      generation_prompt: "",
      acquisition_strategy: needsLocalization ? "localize_source_image" : "use_authorized_source_image",
      factual_image_required: true,
      source_asset_id: asset.id,
      source_remote_url: asset.remote_url,
      status: needsLocalization ? "planned" : "generated",
      media_url: needsLocalization ? "" : `/api/source-assets/${asset.id}/preview`,
      provider: "authorized_xiaohongshu_source",
      model: "user-authorized-source-image",
      media_metadata: { source_mime_type: asset.mime_type, storage_status: asset.storage_status,
        original_bytes_status: asset.original_bytes_status, durability_status: asset.durability_status,
        language_status: asset.language_status, source_provenance: {
          source_asset_id: asset.id,
          original_stored: asset.durability_status === "ORIGINAL_STORED" && asset.original_bytes_status === "saved_original",
          source_owner_confirmed: asset.source_authorization_status === "owner_confirmed",
          source_publishable: Boolean(asset.source_publishable),
          asset_owner_confirmed: asset.asset_authorization_status === "owner_confirmed",
          asset_publishable: Boolean(asset.asset_publishable),
        } },
    };
  }).filter(Boolean);
}

function visualAssetMatchScore(visual, asset) {
  const requested = topicTokens(`${visual.image_subject || ""} ${visual.purpose || ""}`);
  const described = topicTokens(`${asset.alt_text || ""} ${asset.caption_text || ""} ${asset.nearby_text || ""} ${asset.evidence_text || ""}`);
  if (!requested.size || !described.size) return 0;
  const overlap = [...requested].filter((token) => described.has(token)).length;
  return overlap / Math.max(1, Math.min(requested.size, described.size));
}

function detectedAssetLanguage(result = {}) {
  const declared = String(result?.source?.language || result?.language || "").toLowerCase();
  const text = [result?.source?.summary, ...(result?.claims || []).flatMap((claim) => [claim?.source_quote, claim?.value])]
    .filter(Boolean).join(" ");
  const hasHan = /\p{Script=Han}/u.test(text) || /^(?:zh|chinese)/.test(declared);
  const hasLatin = /[A-Za-z]{3}/.test(text) || /^(?:en|english)/.test(declared);
  if (hasHan && hasLatin) return "mixed";
  if (hasHan) return "chinese";
  if (hasLatin) return "english";
  return declared === "none" ? "no_text" : "unknown";
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
  const canonicalUrl = resolveCanonicalUrl({ siteUrl: config.publicSiteUrl, slug: draft.slug }).url;
  const generatedImages = visuals.filter((item) => item.status === "generated")
    .map((item) => publicSchemaMediaUrl(item.wordpress_media_url || item.media_url)).filter(Boolean);
  const siteUrl = resolveCanonicalUrl({ siteUrl: config.publicSiteUrl, slug: "home" }).url?.replace(/home\/$/, "") || null;
  const organizationId = siteUrl ? `${siteUrl}#organization` : undefined;
  const organization = { "@type": "Organization", name: config.publisherName || "SoloToChina" };
  if (organizationId) organization["@id"] = organizationId;
  if (config.publisherLogoUrl) organization.logo = { "@type": "ImageObject", url: config.publisherLogoUrl };
  const article = {
    "@type": "Article",
    headline: draft.title,
    description: draft.meta_description,
    inLanguage: "en",
    publisher: organizationId ? { "@id": organizationId } : organization,
    keywords: draft.seo?.primary_keyword || draft.seo?.focus_keyword || "",
    about: draft.destination_slug || "China travel",
  };
  if (config.authorName) article.author = { "@type": "Person", name: config.authorName };
  if (config.editorName) article.editor = { "@type": "Person", name: config.editorName };
  const graph = [organization];
  if (canonicalUrl) {
    article["@id"] = `${canonicalUrl}#article`;
    article.url = canonicalUrl;
    graph.push({ "@type": "WebPage", "@id": canonicalUrl, url: canonicalUrl, name: draft.title, description: draft.meta_description, inLanguage: "en" });
    graph.push({
      "@type": "BreadcrumbList", "@id": `${canonicalUrl}#breadcrumb`,
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "China travel", item: siteUrl },
        { "@type": "ListItem", position: 2, name: draft.title, item: canonicalUrl },
      ],
    });
    article.mainEntityOfPage = { "@type": "WebPage", "@id": canonicalUrl };
  }
  if (generatedImages.length) article.image = generatedImages;
  graph.push(article);
  for (const image of generatedImages) graph.push({ "@type": "ImageObject", contentUrl: image, url: image });
  const faqs = draft.content_ast?.faq || draft.seo?.faqs || [];
  if (faqs.length) graph.push({
    "@type": "FAQPage",
    mainEntity: faqs.map((item) => ({ "@type": "Question", name: item.question, acceptedAnswer: { "@type": "Answer", text: item.answer } })),
  });
  return { "@context": "https://schema.org", "@graph": graph };
}

function publicSchemaMediaUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
      || /(?:token|signature|x-amz-|x-goog-)/i.test(url.search)) return null;
    return url.toString();
  } catch { return null; }
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
    proposal: proposalForOpportunity(item), proposalFingerprint: proposalFingerprint(item),
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

function performanceDistribution(sortedValues) {
  if (!sortedValues.length) return { samples: 0, median: null, p95: null, p95Reason: "No measured samples." };
  const percentile = (fraction) => sortedValues[Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * fraction) - 1)];
  return {
    samples: sortedValues.length,
    median: percentile(0.5),
    p95: sortedValues.length >= 20 ? percentile(0.95) : null,
    p95Reason: sortedValues.length >= 20 ? null : "At least 20 measured samples are required for p95.",
  };
}

function knowledgeDependencyHash(row) {
  return sha256(JSON.stringify({
    key: row?.normalized_key || "", value: row?.preferred_value || "", status: row?.consensus_status || "",
    evidence: row?.evidence_json || "[]", freshness: row?.freshness_state || "", validity: row?.validity_state || "",
    confidence: row?.consensus_confidence ?? null,
  }));
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
      available_at: next.available_at || null, next_eligible_at: next.next_eligible_at || next.available_at || null,
      execution_route: next.execution_route || "auto", failure_class: next.failure_class || "",
      batch_attempts: Number(next.batch_attempts || 0), last_failure_code: next.last_failure_code || "",
      started_at: next.started_at || null,
      queue_age_ms: Math.max(0, nowMs - Date.parse(next.created_at || next.updated_at)),
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
  if (["extract_segment_claims","extract_media_batch"].includes(type)) return 9;
  if (type === "segment_source") return 10;
  if (type === "preflight_source") return 11;
  if (type === "extract_source") return 12;
  return 9;
}

function sourceStageFromProjection(row){
  if(row.status==="exception")return "exception";
  if(row.media_ready_count<row.media_count)return "persisting_media";
  if(!row.segment_count)return "processing_gap";
  if(row.extracted_segment_count<row.segment_count)return "extracting_evidence";
  if(row.audited_segment_count<row.segment_count)return "auditing_coverage";
  if(row.experience_status!=="succeeded")return "extracting_experience";
  return row.status==="processed"?"core_complete":row.status;
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

function canonicalKnowledgeVariant(row){
  const structured=row?.structured_value||{};
  return `${structured.canonical_predicate||normalizeValue(row?.predicate)}:${structured.typed_value==null
    ? normalizeValue(row?.value_text):stableCanonicalSerialize(structured.typed_value)}`;
}

function verificationSourcePriority(rows=[]){
  const predicates=[...new Set(rows.map((row)=>row?.structured_value?.canonical_predicate||normalizeValue(row?.predicate)).filter(Boolean))];
  const official=predicates.some((value)=>/opening|price|reservation|schedule|address|transport|access/.test(value));
  return official
    ? ["official operator or venue","current on-site observation","independent recent source"]
    : ["independent recent source","primary source","current observation"];
}

function displayTypedKnowledgeValue(value) {
  if (value && typeof value === "object" && Number.isFinite(Number(value.amount))) {
    return `${value.currency || "CNY"} ${Number(value.amount)}`;
  }
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function independentEvidenceKeysForFact(fact) {
  const consensusKeys = (fact?.consensus_detail?.variants || [])
    .flatMap((variant) => variant.independenceKeys || [])
    .filter(Boolean);
  if (consensusKeys.length) return consensusKeys;
  return (fact?.evidence || []).map((item) => item.source_id ? `source:${item.source_id}` : null).filter(Boolean);
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
  const currentTemporal = rows.map((row) => evidenceTemporalState(row)).filter((item) => item.validityState === "current");
  const latestMillis = Math.max(0, ...currentTemporal.map((item) => item.evidenceTimestampMs || 0));
  const latestEvidenceAt = latestMillis ? new Date(latestMillis).toISOString() : null;
  const ageDays = latestMillis ? (Date.now() - latestMillis) / 86_400_000 : Number.POSITIVE_INFINITY;
  const staleAfterDays = volatile ? config.volatileStaleAfterDays : config.staleAfterDays;
  return {
    volatile,
    latestEvidenceAt,
    state: ageDays > staleAfterDays ? "stale" : volatile ? "time_sensitive" : "current",
  };
}

function validEvidenceDate(value) {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function normalizeDateConfidence(value) {
  return ["low", "medium", "high"].includes(value) ? value : "medium";
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

function hydrateKnowledgeFact(row) {
  return {
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
    consensus_method: row.consensus_method || "legacy_count",
    consensus_confidence: Number(row.consensus_confidence || 0),
    consensus_detail: json(row.consensus_detail_json, {}),
    manual_resolution: hydrateKnowledgeResolution(row),
    verification_priority: resolvedVerificationPriority(row),
  };
}

function knowledgeThemeSql(alias = "k") {
  return `CASE
    WHEN lower(${alias}.predicate||' '||${alias}.normalized_key) LIKE '%metro%'
      OR lower(${alias}.predicate||' '||${alias}.normalized_key) LIKE '%transport%'
      OR lower(${alias}.predicate||' '||${alias}.normalized_key) LIKE '%station%'
      OR lower(${alias}.predicate||' '||${alias}.normalized_key) LIKE '%route%' THEN 'transport'
    WHEN lower(${alias}.predicate||' '||${alias}.normalized_key) LIKE '%price%'
      OR lower(${alias}.predicate||' '||${alias}.normalized_key) LIKE '%cost%'
      OR lower(${alias}.predicate||' '||${alias}.normalized_key) LIKE '%ticket%' THEN 'cost'
    WHEN lower(${alias}.predicate||' '||${alias}.normalized_key) LIKE '%experience%'
      OR lower(${alias}.predicate||' '||${alias}.normalized_key) LIKE '%view%'
      OR lower(${alias}.predicate||' '||${alias}.normalized_key) LIKE '%photo%' THEN 'experience'
    ELSE 'planning' END`;
}

function hydrateKnowledgeResolution(row) {
  if (row.resolution_status !== "resolved") return null;
  return {
    status: row.resolution_status,
    preferred_value: row.resolved_value,
    note: row.resolution_note || "",
    resolved_at: row.resolution_resolved_at || null,
    resolution_type: row.resolution_type || "preferred_value",
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
    detail: detail || "系统没有记录更多说明。",
    retryable,
    updatedAt,
  };
}

function failureDetail(failure) {
  if (!failure) return "暂时无法确定具体原因，系统已保存错误记录。";
  const instruction = failure.action?.label ? `建议怎么处理：${failure.action.label}。${failure.action.why || ''}` : '';
  return `${failure.reason || '暂时无法确定具体原因，系统已保存错误记录。'}${instruction ? ` ${instruction}` : ''}`.trim();
}

function terminalFailureClass(error, retry, providerPressure) {
  if (retry) return providerPressure ? "retryable_provider" : "";
  const code = String(error?.code || "").toUpperCase();
  const status = Number(error?.status || 0);
  if (code === "MODEL_OUTPUT_LIMIT") return "input_too_large";
  if (providerPressure || error?.retryable === true) return "retryable_provider";
  if (error?.retryable === false || (status >= 400 && status < 500)) return "permanent_input";
  return "";
}

function operationalExceptionGroupKey(item) {
  return item?.claim_review?.factGroupKey ? `claim-review:${item.claim_review.factGroupKey}` : item.key;
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

export function scopeFactsForOpportunity(facts, { destinationSlug, topic, topic_key: topicKey, title }) {
  facts = currentPublicationFacts(facts);
  const destinationTerms = topicTokens(destinationSlug);
  const terms = topicTokens(`${topic || topicKey || ""} ${title || ""}`);
  for (const term of destinationTerms) terms.delete(term);
  // Generic destination guides intentionally use the destination-wide evidence set.
  const selected = !terms.size ? facts : facts.filter((fact) => {
    const factTerms = topicTokens(`${fact.normalized_key || ""} ${fact.subject || ""} ${fact.predicate || ""}`);
    return [...terms].some((term) => factTerms.has(term));
  });
  return withScopedCoverageLimitations(selected, terms);
}

function factCouldAffectOpportunity(fact,opportunity,destinationSlug){
  const terms=topicTokens(`${opportunity.topic_key||""} ${opportunity.title||""}`);
  for(const term of topicTokens(destinationSlug))terms.delete(term);
  if(!terms.size)return true;
  const factTerms=topicTokens(`${fact.normalized_key||""} ${fact.subject||""} ${fact.predicate||""}`);
  return [...terms].some((term)=>factTerms.has(term));
}

function withScopedCoverageLimitations(facts, terms) {
  return facts.map((fact) => ({
    ...fact,
    evidence: (fact.evidence || []).map((item) => ({
      ...item,
      coverage_limitations: topicRelevantCoverageGaps(item.coverage_limitations, terms),
    })),
  }));
}

function topicRelevantCoverageGaps(gaps, terms) {
  const rows = Array.isArray(gaps) ? gaps : [];
  if (!terms.size) return rows;
  return rows.filter((gap) => {
    const gapTerms = topicTokens(`${gap.locator || ""} ${gap.reason || ""}`);
    return [...terms].some((term) => gapTerms.has(term));
  });
}

function factsForSource(facts, sourceId) {
  return currentPublicationFacts(facts).filter((fact) => (fact.evidence || []).some((item) => item.source_id === sourceId));
}

function currentPublicationFacts(facts) {
  return (facts || []).filter((fact) => ["current", "unknown"].includes(fact.validity_state || "unknown")
    && (!("preferred_value" in fact) || String(fact.preferred_value || "").trim()));
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

function hydrateMediaBatch(row){return {...row,segmentIds:json(row.segment_ids_json,[]),assetIds:json(row.asset_ids_json,[])};}

function sensitiveMediaRow(row){
  if(["infographic","table","map"].includes(row.segment_type))return true;
  const descriptor=`${row.title||""} ${row.raw_text||""} ${row.alt_text||""} ${row.nearby_text||""} ${row.caption_text||""}`.normalize("NFKC").toLowerCase();
  return /(?:map|menu|table|schedule|timetable|price|ticket|route|diagram|screenshot|receipt|地图|菜单|表格|时刻|价格|票价|路线|截图|收据|长图|文字)/u.test(descriptor);
}

function balancedMediaGroups(rows,target=6){
  if(!rows.length)return [];
  if(rows.length<4)return [rows];
  const groupCount=Math.ceil(rows.length/Math.min(8,Math.max(4,target)));
  const base=Math.floor(rows.length/groupCount),extra=rows.length%groupCount,groups=[];
  let offset=0;
  for(let index=0;index<groupCount;index+=1){const size=base+(index<extra?1:0);groups.push(rows.slice(offset,offset+size));offset+=size;}
  return groups;
}

function normalizeInputModality(value) {
  const modality = String(value || "unknown").toLowerCase();
  return ["text", "image", "video", "mixed", "unknown"].includes(modality) ? modality : "unknown";
}

function segmentMaterialityBasis(row, assessment = null) {
  const reviewed = String(assessment?.materiality || "").toLowerCase();
  if (["material", "non_material"].includes(reviewed)) return `review:${reviewed}`;
  const text = `${row.title || ""} ${row.raw_text || ""}`.normalize("NFKC").trim().toLowerCase();
  if (!row.asset_id) return String(row.raw_text || "").trim().length >= 40 ? "text:length_material" : "text:short_non_material";
  if (/\b(decorative|decoration|ornament|background|divider|spacer|texture|avatar|profile photo|logo|watermark|emoji|sticker)\b/u.test(text)) {
    return "media:decorative_descriptor";
  }
  return text ? "media:meaningful_or_unknown_descriptor" : "media:no_descriptor";
}

function assessSegmentMateriality(row, assessment = null) {
  const basis = segmentMaterialityBasis(row, assessment);
  if (basis === "review:material") return "material";
  if (basis === "review:non_material" || basis.endsWith("non_material") || basis === "media:decorative_descriptor") return "non_material";
  return row.asset_id ? "material" : "material";
}

function normalizeExtractionInputManifest(value) {
  if (!value || typeof value !== "object" || Number(value.version || 0) < 1) {
    return { version: 0, expectedModality: "unknown", receivedModality: "unknown", provider: "", model: "", capabilities: {}, assets: [] };
  }
  return {
    version: 1,
    expectedModality: normalizeInputModality(value.expectedModality),
    receivedModality: normalizeInputModality(value.receivedModality),
    provider: String(value.provider || "").slice(0, 100),
    model: String(value.model || "").slice(0, 200),
    capabilities: value.capabilities && typeof value.capabilities === "object" ? {
      text: Boolean(value.capabilities.text), image: Boolean(value.capabilities.image),
      video: Boolean(value.capabilities.video), batch: Boolean(value.capabilities.batch),
    } : {},
    assets: Array.isArray(value.assets) ? value.assets.map((item) => ({
      assetId: item?.assetId ? String(item.assetId).slice(0, 200) : null,
      hash: item?.hash ? String(item.hash).slice(0, 200) : null,
      kind: normalizeInputModality(item?.kind),
      status: item?.status === "submitted" ? "submitted" : "failed",
      requestReference: item?.requestReference ? String(item.requestReference).slice(0, 100) : null,
      failureCode: item?.failureCode ? String(item.failureCode).slice(0, 200) : null,
      failureReason: item?.failureReason ? String(item.failureReason).slice(0, 1_000) : null,
    })) : [],
  };
}

function extractionInputManifest(segment, extraction) {
    const suppliedManifest = normalizeExtractionInputManifest(extraction?.inputManifest);
    // Text segments are passed to every extractor directly in `source.raw_text`, so
    // record that known transport fact even for older/custom extractor adapters.
    // Media must still provide a provider manifest; we never infer it from a method
    // name because that was the lossy behavior A01 removes.
    return suppliedManifest.version > 0 || segment.asset_id
      ? suppliedManifest
      : normalizeExtractionInputManifest({
        version: 1,
        expectedModality: "text",
        receivedModality: "text",
        provider: extraction?.provider || "adapter",
        model: extraction?.model || "",
        capabilities: { text: true, image: false, video: false, batch: false },
        assets: [],
      });
}
