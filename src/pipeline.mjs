import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { validatePlannedEvidence } from "./services/editorial-proposal.mjs";
import { buildContentAst, composePageFromAst, markdownToContentBlocks } from "./content-blocks.mjs";
import { validatePlanningDestination } from "./destination-consistency.mjs";
import { buildPublishPackage, mediaReferences, mergeCommercialOverlay, PublishCompositionError, reconcileCommercialDelivery, validateFinalPageArtifact } from "./publish-page.mjs";
import { validateMediaDelivery } from "./media-delivery.mjs";
import { assertPublicationEligibility, freezeRequiredMediaManifest, mediaManifestForDraft } from "./publication-eligibility.mjs";
import { inheritJobContext, isAiJobType, isProviderPressure } from "./job-policy.mjs";
import { evaluateSourcePreflight } from "./source-preflight.mjs";
import { recoverRemoteOriginal } from "./source-media-store.mjs";
import { auditSourcePhoto } from './local-photo-audit.mjs';
import { stageConfiguration } from './pipeline-contract.mjs';
import { sourceProcessingProfile } from './source-processing-profile.mjs';
import { runNodeJsonProcess } from './process-runner.mjs';
import { normalizeFrontendPageForDelivery } from "./content-taxonomy.mjs";
import { remapBlockProvenanceForDelivery } from "./evidence-validator.mjs";
import { deliveryRefreshContinuation, deliveryRefreshScopeForJob } from "./services/delivery-refresh.mjs";

const ISOLATED_REPOSITORY_TASK=fileURLToPath(new URL('../scripts/run-isolated-repository-task.mjs',import.meta.url));

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

export class Pipeline {
  constructor(repository, extractor, { pollMs = 750, maxConcurrent = null, heartbeatIntervalMs = null, recoveryIntervalMs = 60_000,
    extractionConfig = {}, contentEngine = null, sourceEngine = null, visualReviewer = null, visuals = null, wordpress = null, searchConsole = null, commercialComposer = null,
    frontendContracts = null, contentConfig = {}, logger = silentLogger,databasePath=null,processIsolationEnabled=false,
    isolatedTaskRunner=runNodeJsonProcess } = {}) {
    this.repository = repository;
    this.extractor = extractor;
    this.pollMs = pollMs;
    this.contentEngine = contentEngine;
    this.sourceEngine = sourceEngine || contentEngine || extractor;
    this.visualReviewer = visualReviewer || extractor;
    this.visuals = visuals;
    this.wordpress = wordpress;
    this.searchConsole = searchConsole;
    this.commercialComposer = commercialComposer;
    this.frontendContracts = frontendContracts;
    this.contentConfig = { minFacts: 5, maxPerDestination: 1, ...contentConfig };
    this.logger = logger;
    this.databasePath=databasePath;
    this.processIsolationEnabled=Boolean(processIsolationEnabled&&databasePath);
    this.isolatedTaskRunner=isolatedTaskRunner;
    this.timer = null;
    this.working = 0;
    this.concurrencyMode = extractionConfig.concurrencyMode || (maxConcurrent ? "fixed" : "auto");
    this.concurrencyCeiling = Math.max(1, Math.min(16, Number(extractionConfig.concurrencyMax || maxConcurrent || 8)));
    this.maxConcurrent = Math.max(1, Math.min(this.concurrencyCeiling, Number(maxConcurrent || extractionConfig.concurrencyInitial || 4)));
    this.concurrencySuccessWindow = Math.max(2, Number(extractionConfig.concurrencySuccessWindow || 12));
    this.extractionOutcomes = [];
    this.batchWorking = false;
    this.heartbeatIntervalMs = heartbeatIntervalMs == null ? null : Math.max(1, Number(heartbeatIntervalMs));
    this.recoveryIntervalMs = Math.max(1_000, Number(recoveryIntervalMs || 60_000));
    this.nextRecoveryAt = 0;
    this.activeAbortControllers = new Set();
  }

  start({ keepAlive = false } = {}) {
    if (this.timer) return;
    const recovered = this.repository.recoverExpiredJobs?.() || 0;
    if (recovered) this.logger.warn("pipeline.expired_jobs_recovered", { count: recovered });
    const recoveredBatches = this.repository.recoverPreparingVertexBatches?.() || 0;
    if (recoveredBatches) this.logger.warn("pipeline.vertex_batch_preparation_recovered", { count: recoveredBatches });
    this.nextRecoveryAt = Date.now() + this.recoveryIntervalMs;
    this.timer = setInterval(() => this.pump(), this.pollMs);
    if (!keepAlive) this.timer.unref();
    this.pump();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const controller of this.activeAbortControllers) {
      if (!controller.signal.aborted) controller.abort(Object.assign(new Error("PIPELINE_SHUTDOWN"), { code: "JOB_LEASE_LOST" }));
    }
    const released = this.repository.releaseOwnedJobs?.() || 0;
    if (released) this.logger.warn("pipeline.owned_jobs_released", { count: released });
  }

  pump() {
    if (Date.now() >= this.nextRecoveryAt) {
      this.nextRecoveryAt = Date.now() + this.recoveryIntervalMs;
      try {
        const recovered = this.repository.recoverExpiredJobs?.() || 0;
        if (recovered) this.logger.warn("pipeline.expired_jobs_recovered", { count: recovered });
        const recoveredBatches = this.repository.recoverPreparingVertexBatches?.() || 0;
        if (recoveredBatches) this.logger.warn("pipeline.vertex_batch_preparation_recovered", { count: recoveredBatches });
      } catch (error) {
        const event = isSqliteBusy(error)
          ? "pipeline.recovery_deferred_database_busy"
          : "pipeline.recovery_tick_failed";
        this.logger.warn(event, { error });
      }
    }
    void this.pumpVertexBatch().catch((error) => this.logger.error("pipeline.vertex_batch_tick_failed", { error }));
    const slots = Math.max(0, this.maxConcurrent - this.working);
    for (let index = 0; index < slots; index += 1) {
      void this.runOne().catch((error) => this.logger.error("pipeline.tick_failed", { error }));
    }
  }

  async pumpVertexBatch() {
    if (this.batchWorking) return false;
    this.batchWorking = true;
    try {
      const due = this.repository.dueVertexBatch?.();
      if (due?.cleanupOnly) return await this.cleanupVertexBatch(due);
      if (due) return await this.pollVertexBatch(due);
      if (!this.extractor?.batchEnabled) return false;
      if (this.repository.activeVertexBatchCount?.()) return false;
      const minimum = Math.max(1, Number(this.extractor.config?.batchMinimumRequests || 20));
      const maximum = Math.max(minimum, Number(this.extractor.config?.batchMaximumRequests || 1_000));
      const jobType = this.repository.nextVertexBatchJobType?.(minimum)
        || ["extract_segment_claims", "audit_segment_coverage"]
          .find((type) => this.repository.countVertexBatchEligibleJobs?.(type) >= minimum);
      if (!jobType) return false;
      const snapshot = this.extractor.batchConfigSnapshot?.(jobType) || {
        provider: this.extractor.config?.provider || "vertex", model: this.extractor.config?.model || "",
        location: this.extractor.config?.location || "global", projectId: this.extractor.config?.projectId || "",
        configVersion: "legacy", configDigest: "",
      };
      const run = this.repository.reserveVertexBatchJobs?.({ minimum, maximum, type: jobType, ...snapshot });
      if (!run) return false;
      const prepared = [];
      const maximumInputBytes = Math.max(1_048_576, Number(this.extractor.config?.batchMaxInputBytes || 128 * 1024 * 1024));
      let preparedBytes = 0;
      let inputFull = false;
      for (const item of run.items) {
        try {
          if (inputFull) throw Object.assign(new Error("Deferred to the next Vertex Batch because the current JSONL input reached its safe memory limit."),
            { code: "VERTEX_BATCH_CAPACITY", failureClass: "capacity", retryable: true });
          let request;
          if (item.type === "audit_segment_coverage") {
            const pack = this.repository.getSegmentCoveragePackage(item.segment_id);
            if (!pack || pack.staleCaptureVersion) throw Object.assign(new Error("Source segment changed before Vertex Batch coverage audit submission."), { code: "VERTEX_BATCH_PERMANENT_INPUT", retryable: false });
            if (pack.expectedModality !== "text") throw Object.assign(new Error("Image and video coverage checks remain on the local completion path."), { code: "VERTEX_BATCH_PERMANENT_INPUT", retryable: false });
            request = await this.extractor.prepareBatchCoverage(pack, item.batch_item_id, run);
          } else {
            const pack = this.repository.getSegmentExtractionPackage(item.segment_id);
            if (!pack || pack.staleCaptureVersion) throw Object.assign(new Error("Source segment changed before Vertex Batch submission."), { code: "VERTEX_BATCH_PERMANENT_INPUT", retryable: false });
            request = await this.extractor.prepareBatchExtraction(pack.source, item.batch_item_id, run);
          }
          if (typeof this.repository.heartbeatVertexBatchPreparation === "function"
            && !this.repository.heartbeatVertexBatchPreparation(run)) {
            throw Object.assign(new Error("VERTEX_BATCH_PREPARATION_LEASE_LOST"), { code: "JOB_LEASE_LOST", retryable: false });
          }
          const requestBytes = Buffer.byteLength(JSON.stringify({
            transport_key: request.transportKey || request.id,
            request: request.request,
          })) + 1;
          if (preparedBytes + requestBytes > maximumInputBytes) {
            if (prepared.length) inputFull = true;
            throw Object.assign(new Error(prepared.length
              ? "Deferred to the next Vertex Batch because the current JSONL input reached its safe memory limit."
              : "This segment is too large for the configured Vertex Batch input and was returned to the realtime queue."),
            prepared.length
              ? { code: "VERTEX_BATCH_CAPACITY", failureClass: "capacity", retryable: true }
              : { code: "VERTEX_BATCH_INPUT_TOO_LARGE", failureClass: "input_too_large", retryable: true });
          }
          this.repository.recordVertexBatchItemInput?.(run.id, item.id, request.inputManifest, request);
          prepared.push(request);
          preparedBytes += requestBytes;
        } catch (error) {
          if (isJobLeaseLost(error)) throw error;
          this.repository.releaseVertexBatchItem(run.id, item.id, error, { phase: "prepare" });
          this.logger.warn("pipeline.vertex_batch_item_prepare_failed", { runId: run.id, jobId: item.id, error });
        }
      }
      if (!prepared.length) {
        this.repository.finishVertexBatch(run.id, "failed", "PREPARATION_FAILED", "No extraction request could be prepared.");
        return false;
      }
      try {
        const batch = await this.extractor.createExtractionBatch(prepared, {
          operation: run.jobType || "extract_segment_claims", runConfig: run, idempotencyKey: run.id,
        });
        if (!this.repository.activateVertexBatch(run.id, batch, run)) {
          throw Object.assign(new Error("VERTEX_BATCH_PREPARATION_LEASE_LOST"), { code: "JOB_LEASE_LOST", retryable: false });
        }
        this.logger.info("pipeline.vertex_batch_submitted", { runId: run.id, jobType: run.jobType,
          providerJobName: batch.name, itemCount: prepared.length, inputBytes: preparedBytes });
        return true;
      } catch (error) {
        if (isJobLeaseLost(error)) throw error;
        for (const item of run.items) this.repository.releaseVertexBatchItem(run.id, item.id, error, { phase: "submission" });
        this.repository.finishVertexBatch(run.id, "failed", "SUBMISSION_FAILED", error?.message || error);
        throw error;
      }
    } finally {
      this.batchWorking = false;
    }
  }

  async pollVertexBatch(run) {
    let batch;
    try {
      batch = await this.extractor.getExtractionBatch(run.provider_job_name, run);
    } catch (error) {
      const providerState = error?.code === "BATCH_CREDENTIALS_UNAVAILABLE" ? "CREDENTIALS_UNAVAILABLE" : "POLL_FAILED";
      this.repository.deferVertexBatchPoll(run.id, providerState, Number(this.extractor.config?.batchPollMs || 60_000), error);
      if (providerState === "CREDENTIALS_UNAVAILABLE") {
        this.logger.warn("pipeline.vertex_batch_credentials_unavailable", { runId: run.id, provider: run.provider, error });
        return false;
      }
      throw error;
    }
    const state = String(batch.state || "JOB_STATE_UNSPECIFIED");
    const terminal = new Set(["JOB_STATE_SUCCEEDED", "JOB_STATE_FAILED", "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED", "JOB_STATE_PARTIALLY_SUCCEEDED"]);
    if (!terminal.has(state)) {
      this.repository.deferVertexBatchPoll(run.id, state, Number(this.extractor.config?.batchPollMs || 60_000));
      return false;
    }
    let outputs;
    try { outputs = await this.extractor.readExtractionBatch({ ...run, ...batch }); }
    catch (error) {
      this.repository.deferVertexBatchOutputRead(run.id, state, error, Number(this.extractor.config?.batchPollMs || 60_000));
      this.logger.error("pipeline.vertex_batch_output_read_failed", { runId: run.id, error });
      return false;
    }
    const outputChecksum = crypto.createHash("sha256").update(outputs.map((item) => item?.transport?.checksum || JSON.stringify(item)).join("\n")).digest("hex");
    const ingestingRun = this.repository.beginVertexBatchIngestion(run.id, state, outputChecksum) || run;
    const correlation = correlateBatchOutputs(run.items, outputs);
    for (const anomaly of correlation.anomalies) {
      this.repository.recordVertexBatchOutputAnomaly?.(run.id, anomaly.output, anomaly.reason);
    }
    const missing = [];
    for (const item of run.items) {
      if (correlation.duplicates.has(item.job_id)) {
        this.repository.releaseVertexBatchItem(run.id, item.job_id, Object.assign(
          new Error("Vertex Batch returned duplicate transport correlation for this item; outputs were quarantined."),
          { code: "VERTEX_BATCH_DUPLICATE_CORRELATION", retryable: false }));
        continue;
      }
      const output = correlation.byJobId.get(item.job_id);
      if (!output) { missing.push(item); continue; }
      if (output.modelReportedId && output.modelReportedId !== item.batch_item_id) {
        this.repository.recordVertexBatchCorrelationWarning?.(run.id, item.job_id,
          `Model-reported batch_item_id ${output.modelReportedId} did not match transport key ${item.batch_item_id}; the transport key remained authoritative.`);
      }
      try {
        if (item.job_type === "audit_segment_coverage") {
          const assessment = this.extractor.parseBatchCoverage(output, { runConfig: run,
            telemetryContext: { runId: run.id, entityId: item.segment_id } });
          this.repository.completeVertexBatchCoverageItem(run, item, assessment, output.transport);
        } else {
          const extraction = this.extractor.parseBatchExtraction(output, { inputManifest: parseStoredJson(item.input_manifest_json), runConfig: run,
            telemetryContext: { runId: run.id, entityId: item.segment_id } });
          this.repository.completeVertexBatchItem(run, item, extraction, output.transport);
        }
      } catch (error) {
        this.repository.releaseVertexBatchItem(run.id, item.job_id, error);
      }
    }
    if (missing.length) {
      const maximumReadAttempts = Math.max(1, Number(this.extractor.config?.batchOutputReadMaxAttempts || 5));
      if (Number(ingestingRun.output_read_attempts || 0) < maximumReadAttempts) {
        this.repository.deferVertexBatchOutputRead(run.id, state,
          `${missing.length} submitted Batch item(s) are not present in the downloaded output yet.`,
          Number(this.extractor.config?.batchPollMs || 60_000), 0);
        return false;
      }
      for (const item of missing) this.repository.releaseVertexBatchItem(run.id, item.job_id,
        Object.assign(new Error(`Vertex Batch ${state} returned no output for this segment after ${maximumReadAttempts} reads.`),
          { code: "VERTEX_BATCH_OUTPUT_MISSING", retryable: false }));
    }
    const counts = this.repository.vertexBatchItemCounts(run.id);
    const providerSucceeded = state === "JOB_STATE_SUCCEEDED" || state === "JOB_STATE_PARTIALLY_SUCCEEDED";
    if (!providerSucceeded || counts.failed > 0 || counts.succeeded !== counts.total) {
      const failedStatus = state === "JOB_STATE_CANCELLED" ? "cancelled" : state === "JOB_STATE_EXPIRED" ? "expired" : "failed";
      this.repository.finishVertexBatch(run.id, failedStatus, state,
        batch?.error?.message || `${counts.failed} of ${counts.total} Batch item(s) did not ingest reliably.`, "quarantined");
      this.logger.warn("pipeline.vertex_batch_quarantined", { runId: run.id, providerState: state, ...counts });
      return true;
    }
    this.repository.finishVertexBatch(run.id, "succeeded", state, "", "ready_cleanup");
    await this.cleanupVertexBatch({ ...run, ...batch, cleanupOnly: true });
    this.logger.info("pipeline.vertex_batch_completed", { runId: run.id, providerState: state, outputCount: outputs.length });
    return true;
  }

  async cleanupVertexBatch(run) {
    try {
      await this.extractor.cleanupExtractionBatch(run);
      this.repository.markVertexBatchCleaned(run.id);
      return true;
    } catch (error) {
      this.repository.deferVertexBatchCleanup(run.id, error, Number(this.extractor.config?.batchPollMs || 60_000));
      this.logger.warn("pipeline.vertex_batch_cleanup_failed", { runId: run.id, error });
      return false;
    }
  }

  async runOne() {
    if (this.working >= this.maxConcurrent) return false;
    this.working += 1;
    let job;
    let startedAt;
    let heartbeatTimer;
    let abortController;
    let pipelineArtifact;
    let assertLease = () => {};
    let guarded = async (operation) => operation();
    let stageCommitted = false;
    const commitStage = (work, { acceptResult = () => true } = {}) => {
      if (!this.repository.commitPipelineStage) return work();
      const result = this.repository.commitPipelineStage(job, pipelineArtifact, work, { acceptResult });
      stageCommitted = acceptResult(result);
      return result;
    };
    try {
      const minimum = Math.max(1, Number(this.extractor?.config?.batchMinimumRequests || 20));
      const deferBatchExtraction = Boolean(this.extractor?.batchEnabled
        && this.repository.countVertexBatchEligibleJobs?.() >= minimum);
      const deferBatchCoverage = Boolean(this.extractor?.batchEnabled
        && this.repository.countVertexBatchEligibleJobs?.("audit_segment_coverage") >= minimum);
      job = this.repository.claimJob({ deferBatchExtraction, deferBatchCoverage });
      if (!job) return false;
      startedAt = Date.now();
      abortController = new AbortController();
      this.activeAbortControllers.add(abortController);
      assertLease = () => {
        if (abortController.signal.aborted || (typeof this.repository.ownsJob === "function"
          && !this.repository.ownsJob(job.id, job.locked_by, job.lease_generation))) {
          throw Object.assign(new Error("JOB_LEASE_LOST"), { code: "JOB_LEASE_LOST", retryable: false });
        }
      };
      const assertInput = () => {
        assertLease();
        this.repository.assertPipelineInput?.(pipelineArtifact, job);
      };
      guarded = async (operation) => {
        assertLease();
        const result = await operation(abortController.signal);
        assertLease();
        this.repository.assertPipelineInput?.(pipelineArtifact, job);
        return result;
      };
      heartbeatTimer = setInterval(() => {
        try {
          if (!this.repository.heartbeatJob?.(job.id, job.locked_by, job.lease_generation)) {
            abortController.abort(Object.assign(new Error("JOB_LEASE_LOST"), { code: "JOB_LEASE_LOST" }));
            this.logger.error("pipeline.job_lease_lost", { jobId: job.id, workerId: job.locked_by });
          }
        } catch (error) {
          if (isSqliteBusy(error)) {
            this.logger.warn("pipeline.heartbeat_deferred_database_busy", {
              jobId: job.id, workerId: job.locked_by,
            });
          } else {
            abortController.abort(Object.assign(new Error("JOB_HEARTBEAT_FAILED"), {
              code: "JOB_LEASE_LOST", cause: error,
            }));
            this.logger.error("pipeline.job_heartbeat_failed", {
              jobId: job.id, workerId: job.locked_by, error,
            });
          }
        }
      }, this.heartbeatIntervalMs || Math.max(10_000, Math.floor((this.repository.jobLeaseMs || 60_000) / 3)));
      heartbeatTimer.unref();
      const telemetryIdentity=this.repository.modelTelemetryIdentity?.(job)||{};
      const telemetryContext = { runId: job.id, entityId: job.entity_id,
        role:job.model_role || "unknown",modelProfile:parseStoredJson(job.model_profile_json),
        sourceRunId:telemetryIdentity.sourceRunId||null,articleRevision:telemetryIdentity.articleRevision??null,
        jobAttempt:Number(job.attempts || 0),recoveryRunId:job.recovery_run_id || null,
        productionOwnerOpportunityId:job.production_owner_opportunity_id || null,
        queueWaitMs:Math.max(0,startedAt-Date.parse(job.created_at||job.available_at||new Date(startedAt).toISOString())),
        executionRoute:job.execution_route||"auto",
        // Model-call receipts survive durable Job reclaims. Resume the last
        // accepted Vertex structured-output transport instead of repeating a
        // known-invalid native Schema request on every worker attempt.
        structuredSchemaMode:this.repository.structuredSchemaModeForJob?.(job.id) || null };
      // Authorized-source visual seeding is deterministic prerequisite work for
      // visual processing. Page composition may seed an entirely empty legacy
      // Draft, but it must never re-normalize an existing plan: generated media
      // is bound to that plan's fingerprint and reseeding here can silently
      // replace a completed visual immediately before delivery.
      if (job.type === "generate_visuals") {
        this.repository.ensureAuthorizedSourceVisuals?.(job.entity_id);
      } else if (job.type === "compose_frontend_page"
          && !(this.repository.listDraftVisuals?.(job.entity_id) || []).length) {
        this.repository.ensureAuthorizedSourceVisuals?.(job.entity_id);
      }
      const artifactConfigHash = stageConfiguration(this, job.pipeline_version === 'article_bundle_v1'
        && job.type === 'plan_content' ? 'article_bundle_v1' : job.type);
      pipelineArtifact = this.repository.preparePipelineArtifact?.(job, artifactConfigHash) || null;
      const modelStep = async (key, input, operation, configurationStage = job.type) => {
        if (!this.repository.pipelineStepIdentity) return guarded(operation);
        assertLease();
        this.repository.assertPipelineInput?.(pipelineArtifact, job);
        const identity = this.repository.pipelineStepIdentity(job, pipelineArtifact, key, input, stageConfiguration(this, configurationStage));
        const receipt = this.repository.readPipelineStep(identity);
        if (receipt) {
          this.logger.info('pipeline.model_step_reused', {jobId:job.id, jobType:job.type, step:key, requestHash:identity.request_hash});
          return receipt.value;
        }
        const result = await guarded(operation);
        return this.repository.savePipelineStep(job, pipelineArtifact, identity, result);
      };
      this.logger.info("pipeline.job_started", { jobId: job.id, jobType: job.type, entityId: job.entity_id, attempt: job.attempts });
      if (pipelineArtifact?.reused) {
        commitStage(() => this.ensureReusedDownstream(job));
        if (!stageCommitted && !this.repository.completeJob(job.id, job.locked_by, job.lease_generation)) throw Object.assign(new Error("JOB_LEASE_LOST"), { code: "JOB_LEASE_LOST", retryable: false });
        this.logger.info("pipeline.job_reused", { jobId: job.id, jobType: job.type, entityId: job.entity_id,
          inputHash: pipelineArtifact.input_hash, outputHash: pipelineArtifact.output_hash });
        return true;
      }
      switch (job.type) {
        case 'audit_source_photo': {
          const asset = this.repository.sourceAssetDecisionDto(job.entity_id);
          if (!asset || asset.durability_status !== 'ORIGINAL_STORED'
            || asset.original_bytes_status !== 'saved_original') break;
          if (asset.local_photo_audit?.version === 'local-photo-audit-1'
            && asset.local_photo_audit.sha256 === asset.original_sha256
            && ['eligible','needs_review'].includes(asset.local_photo_audit.status)) break;
          const audit = await guarded(() => auditSourcePhoto(asset.local_path,
            { assetKind: asset.asset_kind || 'unknown' }));
          commitStage(() => this.repository.saveLocalPhotoAudit(asset.id, audit));
          break;
        }
        case "backfill_media_asset":
        case "repair_media_asset": {
          const asset = this.repository.getMediaRecoveryAsset(job.entity_id);
          if (!asset || asset.durability_status === "ORIGINAL_STORED") break;
          if (!this.repository.startMediaRecovery(asset.id)) break;
          try {
            const stored = await guarded((signal) => recoverRemoteOriginal(asset, this.extractor?.config?.sourceUploadsDir
              || this.repository.contentConfig?.sourceUploadsDir || "data/source-uploads", { signal }));
            commitStage(() => this.repository.saveRecoveredMedia(asset.id, stored));
          } catch (error) {
            if (isJobLeaseLost(error)) throw error;
            const browserRequired = error?.retryable === false || /(?:401|403|404|410|HASH_MISMATCH|INVALID|UNSUPPORTED)/i.test(String(error?.code || ""));
            this.repository.failMediaRecovery(asset.id, error, { browserRequired });
            throw error;
          }
          break;
        }
        case "sync_frontend_contract":
          if (!this.frontendContracts?.configured) throw new Error("FRONTEND_CONTRACT_UNCONFIGURED: Frontend Contract sources are not configured.");
          await guarded((signal) => this.frontendContracts.sync({ signal, idempotencyKey: job.id, assertLease }));
          break;
        case "sync_wordpress_inventory": {
          if (!this.wordpress?.enabled) throw new Error("WordPress inventory sync is not configured.");
          this.repository.startWordPressInventorySync(this.wordpress.config.siteUrl);
          try {
            const items = await guarded((signal) => this.wordpress.listContentInventory({ signal, idempotencyKey: job.id }));
            this.repository.replaceWordPressInventory(this.wordpress.config.siteUrl, items);
          } catch (error) {
            if (isJobLeaseLost(error)) throw error;
            this.repository.failWordPressInventorySync(this.wordpress.config.siteUrl, error);
            throw error;
          }
          break;
        }
        case "sync_search_console": {
          if (!this.searchConsole?.enabled) throw new Error("Search Console sync is not configured.");
          this.repository.startSearchConsoleSync(this.searchConsole.config.siteUrl);
          try {
            const inventory = await guarded((signal) => this.searchConsole.listQueryInventory({ signal, idempotencyKey: job.id }));
            this.repository.replaceSearchConsoleInventory(this.searchConsole.config.siteUrl, inventory);
          } catch (error) {
            if (isJobLeaseLost(error)) throw error;
            this.repository.failSearchConsoleSync(this.searchConsole.config.siteUrl, error);
            throw error;
          }
          break;
        }
        case "extract_source": {
          // Backward-compatible queue alias. Strategy 1.4 always expands a Source
          // evidence container into auditable segment jobs before extraction.
          this.enqueueChild(job,"preflight_source",job.entity_id);
          break;
        }
        case "preflight_source": {
          const source = this.repository.getSource(job.entity_id);
          if (!source) throw new Error(`Source ${job.entity_id} no longer exists.`);
          const extractionRuntime = this.extractor?.configFor?.({ telemetryContext }) || this.extractor?.config || {};
          const preflight = evaluateSourcePreflight(source, {
            provider: extractionRuntime.provider || "unknown",
            sourceUploadsDir: extractionRuntime.sourceUploadsDir,
            imageBatchSize: this.repository.contentConfig?.mediaImageBatchSize,
            textSegmentMaxChars: this.repository.contentConfig?.sourceTextSegmentMaxChars,
          });
          this.repository.recordSourcePreflight?.(source.id, preflight);
          if (!preflight.ready) {
            const error = new Error(`Source preflight blocked processing: ${preflight.issues.map((item) => `${item.code}: ${item.message}`).join("; ")}`);
            error.code = "SOURCE_PREFLIGHT_BLOCKED";
            error.retryable = false;
            throw error;
          }
          this.enqueueChild(job,"segment_source",source.id);
          break;
        }
        case "segment_source": {
          commitStage(() => {
            const segments = this.repository.prepareSourceSegments(job.entity_id);
            const mediaBatches = this.repository.prepareMediaExtractionBatches(job.entity_id);
            this.repository.enqueueSourcePhotoAudits(job.entity_id, { limit: 2000 });
            const batchedSegmentIds = new Set(mediaBatches.flatMap((batch) => batch.segmentIds));
            for (const batch of mediaBatches) this.enqueueChild(job,"extract_media_batch", batch.id,
              { executionRoute: 'realtime', priority: Number(job.priority || 5) });
            for (const segment of segments.filter((item) => !batchedSegmentIds.has(item.id))) {
              this.enqueueChild(job,"extract_segment_claims", segment.id,
                { executionRoute: Number(job.priority || 0) >= 50 ? 'batch' : 'realtime', priority: Number(job.priority || 5) });
            }
          });
          break;
        }
        case "extract_media_batch": {
          const pack=this.repository.getMediaBatchExtractionPackage(job.entity_id);
          if(!pack)throw new Error(`Media batch ${job.entity_id} no longer exists.`);
          if(pack.staleCaptureVersion)break;
          const extraction=await guarded((signal)=>this.extractor.extract(pack.source,{signal,telemetryContext}));
          commitStage(()=>{
            for(const segmentId of this.repository.saveMediaBatchExtraction(job.entity_id,extraction)) {
              this.enqueueChild(job,"audit_segment_coverage",segmentId,{executionRoute:'realtime'});
            }
          });
          break;
        }
        case "extract_segment_claims": {
          const pack = this.repository.getSegmentExtractionPackage(job.entity_id);
          if (!pack) throw new Error(`Source segment ${job.entity_id} no longer exists.`);
          if (pack.staleCaptureVersion) break;
          try {
            const extraction = await guarded((signal) => this.extractor.extract(pack.source, { signal, telemetryContext }));
            commitStage(() => {
              if (this.repository.saveSegmentExtraction(job.entity_id, extraction)) this.enqueueChild(job,"audit_segment_coverage", job.entity_id, { executionRoute: job.execution_route || 'realtime' });
            });
          } catch (error) {
            if (!isModelOutputLimit(error)) throw error;
            const children = commitStage(() => {
              const split = this.repository.splitSourceSegmentForRetry(job.entity_id);
              if (!split.length) throw error;
              for (const child of split) this.enqueueChild(job,"extract_segment_claims", child.id);
              return split;
            });
            this.logger.warn("pipeline.segment_resegmented_after_output_limit", { segmentId: job.entity_id, childCount: children.length });
          }
          break;
        }
        case "audit_segment_coverage": {
          const coveragePackage = this.repository.getSegmentCoveragePackage(job.entity_id);
          if (!coveragePackage) throw new Error(`Source segment ${job.entity_id} has no extraction result.`);
          if (coveragePackage.staleCaptureVersion) break;
          const assessment = coveragePackage.expectedModality === "text" && this.repository.shouldRunAiCoverage(job.entity_id) && typeof this.extractor.auditCoverage === "function"
            ? await guarded((signal) => this.extractor.auditCoverage(coveragePackage, { signal, telemetryContext }))
            : null;
          commitStage(() => {
          const audit = this.repository.auditSegmentCoverage(job.entity_id, assessment?.output || assessment);
          if (audit.status === "stale") return;
          if (audit.status === "retry_required") this.enqueueChild(job,"retry_segment_extraction",job.entity_id);
          else if (this.repository.sourceCoverageReady(audit.sourceId)) this.enqueueChild(job,"finalize_source_extraction",audit.sourceId);
          });
          break;
        }
        case "retry_segment_extraction": {
          const pack = this.repository.getSegmentExtractionPackage(job.entity_id);
          if (!pack) throw new Error(`Source segment ${job.entity_id} no longer exists.`);
          if (pack.staleCaptureVersion) break;
          const previous = this.repository.getSegmentCoveragePackage(job.entity_id);
          const targets = (previous?.coverage?.uncovered_spans || []).map((item, index) =>
            `${index + 1}. ${item.locator || item.quote || "Unlocated span"} — ${item.reason || "not covered"}`);
          pack.source.raw_text = `${pack.source.raw_text}\n\nTARGETED COVERAGE RETRY\nOnly add atomic Claims needed to cover these audited gaps. Preserve exact evidence quotes.\n${targets.join("\n")}`;
          const retryExtraction = await modelStep('targeted-extraction', pack.source,
            (signal) => this.extractor.extract(pack.source, { signal, telemetryContext }));
          const priorResult = previous?.extraction || {};
          const extraction = {
            ...retryExtraction,
            result: {
              ...priorResult,
              ...retryExtraction.result,
              source: retryExtraction.result?.source || priorResult.source,
              claims: mergeExtractionClaims(priorResult.claims, retryExtraction.result?.claims),
            },
          };
          // Preview the merged extraction without publishing a half-completed retry.
          const retriedPackage = this.repository.getSegmentCoveragePackage(job.entity_id, { extraction, retry: true });
          if (!retriedPackage || retriedPackage.staleCaptureVersion) break;
          const assessment = retriedPackage.expectedModality === "text" && this.repository.shouldRunAiCoverage(job.entity_id) && typeof this.extractor.auditCoverage === "function"
            ? await modelStep('targeted-coverage', retriedPackage,
              (signal) => this.extractor.auditCoverage(retriedPackage, { signal, telemetryContext }), 'audit_segment_coverage')
            : null;
          commitStage(() => {
            if (!this.repository.saveSegmentExtraction(job.entity_id, extraction, { retry: true })) return;
            const audit = this.repository.auditSegmentCoverage(job.entity_id, assessment?.output || assessment);
            if (audit.status !== 'stale' && this.repository.sourceCoverageReady(audit.sourceId)) this.enqueueChild(job,"finalize_source_extraction",audit.sourceId);
          });
          break;
        }
        case "finalize_source_extraction": {
          const finalized = commitStage(() => {
            const result = this.repository.finalizeSegmentedExtraction(job.entity_id);
            if ((this.sourceEngine?.enabledFor?.({ telemetryContext }) ?? this.sourceEngine?.enabled)
              && typeof this.sourceEngine?.analyzeExperience === "function") {
              this.enqueueChild(job,"extract_source_experience",job.entity_id);
            } else {
              this.repository.saveExperienceExtraction(job.entity_id, { blocks: [] }, "no_ai");
              this.enqueueSourceSemanticDownstream(job.entity_id,job);
            }
            return result;
          });
          this.logger.info("pipeline.source_finalized", { sourceId: job.entity_id, ...finalized });
          break;
        }
        case "extract_source_experience": {
          const experiencePackage = this.repository.getExperienceExtractionPackage(job.entity_id);
          if (!experiencePackage) throw new Error(`Source ${job.entity_id} is not ready for Experience extraction.`);
          const extracted = await guarded((signal) => this.sourceEngine.analyzeExperience(experiencePackage, { signal, telemetryContext }));
          commitStage(() => {
            this.repository.saveExperienceExtraction(job.entity_id, extracted.output, extracted.model, experiencePackage);
            this.enqueueSourceSemanticDownstream(job.entity_id,job);
          });
          break;
        }
        case "analyze_source_blueprint": {
          const source = this.repository.getSource(job.entity_id);
          if (!source?.structured) throw new Error(`Source ${job.entity_id} is not ready for editorial blueprint analysis.`);
          const analyzed = await guarded((signal) => this.extractor.analyzeBlueprint(source, { signal, telemetryContext }));
          commitStage(() => {
            this.repository.saveSourceBlueprint(job.entity_id, analyzed.output);
            this.enqueueChild(job,"rebuild_editorial","global",{workloadClass:"background_enrichment"});
          });
          break;
        }
        case "analyze_source_family": {
          const family = this.repository.analyzeSourceFamily(job.entity_id);
          const source = this.repository.getSource(job.entity_id);
          if (source?.structured?.destination_slug) this.enqueueChild(job,"resolve_entities",source.structured.destination_slug,{workloadClass:"semantic"});
          this.logger.info("pipeline.source_family_analyzed", { sourceId: job.entity_id, family });
          break;
        }
        case "analyze_source_diagnostic": {
          // Source diagnostics explain evidence value; they never create or queue
          // an article. The AI intake record remains the human-facing diagnostic.
          this.requireExtractionEngine(telemetryContext);
          const intakePackage = this.repository.getIntakePackage(job.entity_id);
          if (!intakePackage) throw new Error(`Source ${job.entity_id} is not ready for diagnostic analysis.`);
          const analyzed = await guarded((signal) => this.sourceEngine.analyzeIntake(intakePackage, { signal, telemetryContext }));
          commitStage(() => this.repository.saveIntakeAnalysis(job.entity_id, analyzed.output, analyzed.model));
          break;
        }
        case "resolve_entities": {
          let cursor = null;
          const resolutions = [];
          do {
            const entityPackage = this.repository.getEntityResolutionPackage(job.entity_id, 300, cursor);
            if ((this.sourceEngine?.enabledFor?.({ telemetryContext }) ?? this.sourceEngine?.enabled)
              && typeof this.sourceEngine?.resolveEntities === "function" && entityPackage.claims.length) {
              try {
                const resolved = await modelStep(`entities:${cursor || 'start'}`, entityPackage, (signal) => this.sourceEngine.resolveEntities(entityPackage, { signal,
                  telemetryContext: { ...telemetryContext, entityId: `${job.entity_id}:${cursor || "start"}` } }));
                // Keep every page on the same input revision. Applying page 1
                // would otherwise mutate aliases/metadata read by page 2 and
                // make our own output appear to be a concurrent input change.
                resolutions.push(resolved);
              } catch (error) {
                if (!isRecoverableStructuredOutputError(error)) throw error;
                this.logger.warn("pipeline.entity_resolution_model_output_invalid", {
                  jobId: job.id, entityId: job.entity_id, cursor, error,
                });
                cursor = null;
                break;
              }
            }
            cursor = entityPackage.nextCursor;
          } while (cursor);
          commitStage(() => {
            for (const resolved of resolutions) this.repository.applyEntityResolution(job.entity_id, resolved.output, resolved.model);
            this.repository.resolveEntitiesDeterministically(job.entity_id);
            this.enqueueChild(job,"rebuild_knowledge",job.entity_id,{workloadClass:"semantic"});
          });
          break;
        }
        case "rebuild_knowledge":
          await this.runRepositoryTask("rebuild_knowledge",job.entity_id);
          this.enqueueChild(job,"rebuild_topic_clusters",job.entity_id,{workloadClass:"background_enrichment"});
          break;
        case "rebuild_editorial":
          this.repository.rebuildEditorialLibrary();
          break;
        case "rebuild_topics": {
          // Legacy job name retained for old durable queues. Strategy 1.4
          // rebuilds topic clusters and coverage before reconciling approvals.
          this.enqueueChild(job,"rebuild_topic_clusters",job.entity_id,{workloadClass:"background_enrichment"});
          break;
        }
        case "rebuild_topic_clusters": {
          await this.runRepositoryTask("rebuild_topic_clusters",job.entity_id);
          this.enqueueChild(job,"build_coverage_matrix",job.entity_id,{workloadClass:"background_enrichment"});
          break;
        }
        case "build_coverage_matrix": {
          if(this.processIsolationEnabled)await this.runRepositoryTask("build_coverage_matrix",job.entity_id);
          else{
            const dirty=this.repository.takeCoverageDirty?.(job.entity_id)||null;
            try{
              this.repository.rebuildCoverageMatrices(job.entity_id,{changedFactKeys:dirty?.changedFactKeys||null});
              if(dirty)this.repository.completeCoverageDirty?.(job.entity_id);
            }catch(error){
              if(dirty)this.repository.completeCoverageDirty?.(job.entity_id,{failed:true});
              throw error;
            }
          }
          this.enqueueChild(job,"rebuild_content_opportunities",job.entity_id,{workloadClass:"background_enrichment"});
          break;
        }
        case "rebuild_content_opportunities": {
          await this.runRepositoryTask("rebuild_content_opportunities",job.entity_id);
          this.enqueueChild(job,"reconcile_approved_opportunities",job.entity_id,{workloadClass:"background_enrichment"});
          break;
        }
        case "reconcile_approved_opportunities": {
          this.repository.reconcileApprovedOpportunities(job.entity_id);
          break;
        }
        case "analyze_intake": {
          this.requireExtractionEngine(telemetryContext);
          const intakePackage = this.repository.getIntakePackage(job.entity_id);
          if (!intakePackage) throw new Error(`Source ${job.entity_id} is not ready for intake analysis.`);
          const analyzed = await guarded((signal) => this.sourceEngine.analyzeIntake(intakePackage, { signal, telemetryContext }));
          commitStage(() => this.repository.saveIntakeAnalysis(job.entity_id, analyzed.output, analyzed.model));
          break;
        }
        case "assemble_editorial": {
          this.requireContentEngine();
          const ownerId = job.production_owner_opportunity_id || null;
          const assemblyPackage = this.repository.getEditorialAssemblyPackage(job.entity_id, { opportunityId:ownerId });
          if (!assemblyPackage) throw new Error(`Topic candidate ${job.entity_id} no longer exists.`);
          const assembled = typeof this.contentEngine.assembleEditorial === "function"
            ? await guarded((signal) => this.contentEngine.assembleEditorial(assemblyPackage, { signal, telemetryContext }))
            : { output: { selected_fact_keys:(assemblyPackage.facts || []).map((item) => item.normalized_key),
              selected_experience_block_ids:(assemblyPackage.available_experiences || []).map((item) => item.id),
              selected_source_ids:[],selected_blueprint_source_ids:[],exclusions:[],rationale:"Deterministic compatibility assembly." }, model:"compatibility" };
          commitStage(() => {
            this.repository.saveEditorialAssembly(job.entity_id, assembled.output, assembled.model, assemblyPackage, { opportunityId:ownerId });
            this.enqueueChild(job,"plan_content",job.entity_id);
          });
          break;
        }
        case "plan_content": {
          this.requireContentEngine();
          const ownerId = job.production_owner_opportunity_id || null;
          if (job.pipeline_version === 'article_bundle_v1') {
            const contentPackage = this.repository.getPlanningPackage(job.entity_id, { opportunityId:ownerId });
            if (!contentPackage) throw new Error(`Topic candidate ${job.entity_id} no longer exists.`);
            const destinationValidation = validatePlanningDestination(contentPackage);
            if (!destinationValidation.valid) throw Object.assign(new Error(`${destinationValidation.code}: ${destinationValidation.message}`),
              { code:destinationValidation.code,retryable:false,details:destinationValidation });
            const bundle = await guarded((signal) => this.contentEngine.articleBundle(contentPackage,
              { signal, telemetryContext }));
            const plannedEvidence = validatePlannedEvidence(bundle.output.brief, contentPackage);
            if (!plannedEvidence.valid) throw Object.assign(new Error('ARTICLE_BUNDLE_EVIDENCE_INVALID'),
              { code:'ARTICLE_BUNDLE_EVIDENCE_INVALID',retryable:false,details:plannedEvidence });
            commitStage(() => {
              const briefId = this.repository.saveBrief(job.entity_id, bundle.output.brief, bundle.model,
                { deferDraft:true, opportunityId:ownerId });
              const draftId = this.repository.saveDraft(briefId, bundle.output.draft, bundle.model,
                { deferReview:this.canComposeFrontendPage, opportunityId:ownerId });
              if (this.visuals?.enabled) this.enqueueChild(job,'generate_visuals',draftId);
              else if (this.canComposeFrontendPage) this.enqueueChild(job,'compose_frontend_page',draftId);
            });
            break;
          }
          if (!this.repository.getEditorialAssembly(job.entity_id)) {
            const assemblyPackage = this.repository.getEditorialAssemblyPackage(job.entity_id, { opportunityId:ownerId });
            if (!assemblyPackage) throw new Error(`Topic candidate ${job.entity_id} no longer exists.`);
            const assembled = typeof this.contentEngine.assembleEditorial === "function"
              ? await guarded((signal) => this.contentEngine.assembleEditorial(assemblyPackage, { signal, telemetryContext }))
              : { output:{ selected_fact_keys:(assemblyPackage.facts || []).map((item) => item.normalized_key),
                selected_experience_block_ids:(assemblyPackage.available_experiences || []).map((item) => item.id),
                selected_source_ids:[],selected_blueprint_source_ids:[],exclusions:[],rationale:"Deterministic compatibility assembly." },model:"compatibility" };
            this.repository.saveEditorialAssembly(job.entity_id, assembled.output, assembled.model, assemblyPackage, { opportunityId:ownerId });
            // The compatibility entrypoint creates its own prerequisite. Freeze
            // the planner against that newly persisted assembly before calling it.
            pipelineArtifact = this.repository.preparePipelineArtifact?.(job, artifactConfigHash) || pipelineArtifact;
          }
          const contentPackage = this.repository.getPlanningPackage(job.entity_id, { opportunityId:ownerId });
          if (!contentPackage) throw new Error(`Topic candidate ${job.entity_id} no longer exists.`);
          const destinationValidation = validatePlanningDestination(contentPackage);
          if (!destinationValidation.valid) {
            throw Object.assign(new Error(`${destinationValidation.code}: ${destinationValidation.message}`), {
              code: destinationValidation.code, retryable: false, details: destinationValidation,
            });
          }
          const planned = await guarded((signal) => this.contentEngine.plan(contentPackage, { signal, telemetryContext }));
          const plannedEvidence = validatePlannedEvidence(planned.output, contentPackage);
          if (!plannedEvidence.valid) throw Object.assign(new Error(`PLAN_EVIDENCE_INVALID: ${plannedEvidence.errors.map(item=>`${item.section || ''} ${item.key || ''}: ${item.message}`).join('; ')}`), {retryable:false, code:'PLAN_EVIDENCE_INVALID', details:plannedEvidence});
          commitStage(() => {
            const briefId = this.repository.saveBrief(job.entity_id, planned.output, planned.model, { deferDraft: true, opportunityId:ownerId });
            this.enqueueChild(job,"plan_narrative",briefId);
          });
          break;
        }
        case "plan_narrative": {
          this.requireContentEngine();
          const contentPackage = this.repository.getNarrativePlanningPackage?.(job.entity_id)
            || this.repository.getBriefPackage(job.entity_id);
          if (!contentPackage) throw new Error(`Content brief ${job.entity_id} no longer exists.`);
          const planned = typeof this.contentEngine.planNarrative === "function"
            ? await guarded((signal) => this.contentEngine.planNarrative(contentPackage, { signal, telemetryContext }))
            : { model:"compatibility",output:{ opening_job:"State the practical answer immediately.",
              throughline:contentPackage.brief?.reader_promise || contentPackage.brief?.topic || "Help the traveler decide.",
              route_sequence:(contentPackage.brief?.canonical?.outline || []).map((section) => section.section_id).filter(Boolean),
              experience_placements:[],supporting_fact_keys:(contentPackage.facts || []).map((fact) => fact.normalized_key),
              conditional_branches:[],tradeoffs:[],exclusions:[],closing_decision:"End with the next concrete traveler decision." } };
          commitStage(() => {
            this.repository.saveNarrativePlan(job.entity_id, planned.output, planned.model);
            this.enqueueChild(job,"assemble_writing_packet",job.entity_id);
          });
          break;
        }
        case "assemble_writing_packet": {
          commitStage(() => {
          this.repository.assembleWritingPacket(job.entity_id);
          if (this.canComposeFrontendPage) this.enqueueChild(job,"compose_frontend_page_plan",job.entity_id);
          else this.enqueueChild(job,"generate_draft",job.entity_id);
          });
          break;
        }
        case "compose_frontend_page_plan": {
          this.requireContentEngine();
          const contract = this.requireFrontendContract();
          const contentPackage = this.repository.getBriefPackage(job.entity_id);
          if (!contentPackage) throw new Error(`Content brief ${job.entity_id} no longer exists.`);
          const capabilities = this.frontendContracts.resolveForArticle({ canonical: contentPackage.brief?.canonical || {} });
          if (!capabilities.components.length) {
            this.repository.createFrontendCapabilityRequest({ briefId: job.entity_id, semanticNeed: "article-page-composition", useCase: contentPackage.brief?.topic || "Content brief", reason: "The active Frontend Contract exposes no stable components for this page composition." });
            throw new Error("MISSING_FRONTEND_CAPABILITY: no stable Frontend component can express this page.");
          }
          const composed = await guarded((signal) => this.contentEngine.composePagePlan(contentPackage, capabilities, { signal, telemetryContext }));
          const validation = this.frontendContracts.validateCompositionPlan(composed.output);
          if (!validation.valid) {
            this.repository.saveFrontendPagePlan(job.entity_id, contract, composed.output, validation, composed.model);
            throw new Error(`Frontend page plan is invalid: ${validation.errors.map((item) => item.code).join(", ")}`);
          }
          commitStage(() => {
            this.repository.saveFrontendPagePlan(job.entity_id, contract, composed.output, validation, composed.model);
            this.enqueueChild(job,"generate_draft",job.entity_id);
          });
          break;
        }
        case "generate_draft": {
          this.requireContentEngine();
          const contentPackage = this.repository.getBriefPackage(job.entity_id);
          if (!contentPackage) throw new Error(`Content brief ${job.entity_id} no longer exists.`);
          // Manual recovery from a failed quality repair consumes the same
          // frozen-review feedback as automatic regeneration. First drafts
          // have no failed current review, so this remains null initially.
          const qualityFeedback = this.repository.qualityRegenerationFeedback(job.entity_id);
          const drafted = await guarded((signal) => this.contentEngine.draft(contentPackage, qualityFeedback, { signal, telemetryContext }));
          commitStage(() => {
          const contractAware = this.canComposeFrontendPage;
          const draftId = this.repository.saveDraft(job.entity_id, drafted.output, drafted.model,
            {deferReview:contractAware,opportunityId:job.production_owner_opportunity_id || null});
          if (this.visuals?.enabled) this.enqueueChild(job,"generate_visuals",draftId);
          else if (contractAware) this.enqueueChild(job,"compose_frontend_page",draftId);
          });
          break;
        }
        case "generate_visuals": {
          if (!this.visuals?.enabled) throw new Error("Visual generation is not configured.");
          this.repository.recoverLegacyVisualReceipts?.(job.entity_id);
          let contentPackage = this.repository.getDraftPackage(job.entity_id);
          if (!contentPackage) throw new Error(`Article draft ${job.entity_id} no longer exists.`);
          const analysisVisuals=this.repository.plannedVisuals(job.entity_id)
            .filter((item)=>item.acquisition_strategy === "analyze_source_image");
          for (const visual of analysisVisuals) {
            if (typeof this.visualReviewer?.analyzeMediaAsset !== "function") {
              throw Object.assign(new Error("Image analysis provider is not configured for this source asset."),{
                code:"MEDIA_ANALYSIS_NOT_CONFIGURED",retryable:false,
              });
            }
            const asset=this.repository.sourceAssetDecisionDto(visual.source_asset_id);
            const analyzed=await guarded((signal)=>this.visualReviewer.analyzeMediaAsset(asset,{signal,
              telemetryContext:{...telemetryContext,entityId:visual.source_asset_id,visualId:visual.id}}));
            // One source analysis is an intermediate checkpoint, not the
            // completion of the generate_visuals stage.  Completing the stage
            // here releases the Job lease after the first image and makes every
            // subsequent image fail with JOB_LEASE_LOST.  Keep each analysis
            // durable, then finish the stage only after every slot below has
            // been classified and processed.
            const saveAnalysis=()=>{
              if (!this.repository.saveSourceAssetAnalysis(visual.source_asset_id,analyzed.result,{
                provider:analyzed.method,model:analyzed.model,forVisualId:visual.id,
              })) throw Object.assign(new Error('Image analysis could not be bound to its current article visual.'),{
                code:'MEDIA_ANALYSIS_CHECKPOINT_REJECTED',retryable:false,
              });
            };
            if (typeof this.repository.checkpointPipelineStage === "function") {
              this.repository.checkpointPipelineStage(job,pipelineArtifact,saveAnalysis);
            } else saveAnalysis();
          }
          // The stage already normalized the plan before freezing its artifact
          // input. Re-run planning only when this attempt added new source
          // analysis; otherwise a second pass is redundant and historically
          // allowed an unstable plan to flip assets inside one Job attempt.
          if (analysisVisuals.length && !mediaManifestForDraft(this.repository.db, job.entity_id)) {
            this.repository.prepareMediaRepair(job.entity_id);
          }
          freezeRequiredMediaManifest(this.repository.db, job.entity_id);
          this.repository.recoverLegacyVisualReceipts?.(job.entity_id);
          contentPackage = this.repository.getDraftPackage(job.entity_id);
          const requiredGaps=this.repository.blockedRequiredVisuals?.(job.entity_id) || [];
          if (requiredGaps.length) throw Object.assign(new Error("Required factual visual has no relevant retained authorized source."),{
            code:"MEDIA_REQUIRED_MANIFEST_MISSING",retryable:false,
            details:{substage:"editorial_fit",required_visual_gaps:requiredGaps.map((gap)=>({
              visual_id:gap.id,slot:gap.slot,image_subject:gap.image_subject,reason:gap.gap?.reason || "missing_source"}))},
          });
          for (const visual of this.repository.plannedVisuals(job.entity_id)) {
            if (visual.acquisition_strategy === "analyze_source_image") continue;
            try {
              const method = ["localize_source_image","localize_photo_overlay","recompose_editorial_card","recompose_collage","recompose_map_or_route"]
                .includes(visual.acquisition_strategy) ? "localizeSourceImage" : "generate";
              const result = await guarded((signal) => this.visuals[method](visual, contentPackage.draft, { signal,
                idempotencyKey: `${job.id}:${visual.id}`,expectedFingerprint:visual.asset_fingerprint,
                telemetryContext:{...telemetryContext,entityId:visual.id,visualId:visual.id,sourceAssetId:visual.source_asset_id || null} }));
              this.repository.saveGeneratedVisual(visual.id, result,{expectedFingerprint:visual.asset_fingerprint});
            } catch (error) {
              if (isJobLeaseLost(error)) throw error;
              if (error?.code === 'MEDIA_RATE_WAIT') throw error;
              const failed = this.repository.failVisual(visual.id, error);
               if (failed.retryable || visual.factual_image_required || visual.required_in_article
                 || parseStoredJson(visual.media_metadata_json)?.required_visual_obligation?.required) throw error;
              this.logger.warn("pipeline.optional_visual_skipped", { visualId: visual.id, draftId: job.entity_id, error });
            }
          }
          if (this.canComposeFrontendPage) this.enqueueChild(job,"compose_frontend_page",job.entity_id);
          break;
        }
        case "compose_frontend_page": {
          this.requireContentEngine();
          const contract = this.requireFrontendContract();
          let contentPackage = this.repository.getDraftPackage(job.entity_id);
          if (!contentPackage) throw new Error(`Article draft ${job.entity_id} no longer exists.`);
          await guarded((signal) => this.uploadVisualMedia(contentPackage, { signal, idempotencyKey: job.id, assertLease: assertInput }));
          contentPackage = this.repository.getDraftPackage(job.entity_id);
          const capabilities = this.frontendContracts.resolveForArticle({ canonical: contentPackage.brief?.canonical || {},
            draft: contentPackage.draft || {},includeAllEditorial:job.pipeline_version === 'article_bundle_v1' });
          if (!capabilities.components.length) {
            this.repository.createFrontendCapabilityRequest({ draftId: job.entity_id, briefId: contentPackage.brief?.id || null, semanticNeed: "article-page-payload", useCase: contentPackage.draft?.title || "Article draft", reason: "The active Frontend Contract exposes no stable components for the final page payload." });
            throw new Error("MISSING_FRONTEND_CAPABILITY: no stable Frontend component can express this page.");
          }
          const currentAst = buildContentAst({ draft: contentPackage.draft, brief: contentPackage.brief,
            visuals: contentPackage.draft.visuals || [], facts: contentPackage.facts || [] });
          const existingPageId = contentPackage.frontend_page?.payload?.metadata?.pageId || null;
          const composed = composePageFromAst(currentAst, capabilities, contract.pageSchema.schema, contentPackage.frontend_page_plan?.plan, existingPageId)
            || (job.pipeline_version === 'article_bundle_v1'
              ? null : await guarded((signal) => this.contentEngine.composeFrontendPage(contentPackage, capabilities, contract.pageSchema.schema, { signal, telemetryContext })));
          if (!composed) throw Object.assign(new Error('Deterministic page composition requires supported Frontend Contract blocks.'),
            { code:'FRONTEND_CONTRACT_UNSUPPORTED',retryable:false,
              details:{contentType:currentAst?.content_type,nodeCount:currentAst?.nodes?.length || 0,
                components:capabilities.components.map((item)=>item.id)} });
          if (existingPageId && composed.output?.metadata) composed.output.metadata.pageId = existingPageId;
          const validation = this.frontendContracts.validatePagePayload(composed.output);
          const savedPage = commitStage(() => {
            const saved = this.repository.saveFrontendPageComposition(job.entity_id, contentPackage.frontend_page_plan?.id || null, contract, composed.output, validation, composed.model,
              { revision: contentPackage.draft.revision, contentHash: contentPackage.draft.content_hash }, composed.provenance);
            if (saved.validation.valid && !job.dedupe_key?.startsWith("manual-stage:")) {
              const nextStage = deliveryRefreshContinuation(this.repository,job,"compose_frontend_page") || "review_draft";
              this.enqueueChild(job,nextStage,job.entity_id);
            }
            return saved;
          }, { acceptResult: saved => saved.validation.valid });
          if (!savedPage.validation.valid) throw Object.assign(new Error(`Frontend page payload is invalid: ${savedPage.validation.errors.map((item) => `${item.code}:${item.path || ''}:${item.message || ''}`).join(", ")}`),
            {code:'FRONTEND_PAGE_INVALID',retryable:false,details:savedPage.validation.errors});
          break;
        }
        case "review_draft": {
          this.requireContentEngine();
          const contentPackage = this.repository.getDraftPackage(job.entity_id);
          if (!contentPackage) throw new Error(`Article draft ${job.entity_id} no longer exists.`);
          const reviewed = await guarded((signal) => this.contentEngine.review(contentPackage, { signal, telemetryContext }));
          commitStage(() => {
          const revision = this.repository.saveReview(job.entity_id, reviewed.output, reviewed.model,
            { revision: contentPackage.draft.revision, contentHash: contentPackage.draft.content_hash, evidenceHash:contentPackage.evidence_hash,
              productionOwnerOpportunityId:job.production_owner_opportunity_id || null });
          const pageReady = !this.canComposeFrontendPage || Boolean(contentPackage.frontend_page?.current);
          if (reviewed.output.passed && pageReady && !job.dedupe_key?.startsWith("manual-stage:")) this.enqueueChild(job,"compose_commercial",job.entity_id);
          if (!reviewed.output.passed && !job.dedupe_key?.startsWith("manual-stage:")) {
            this.repository.automaticQualityRepairState(job.entity_id, reviewed.output.issues, { enqueue: true,
              productionOwnerOpportunityId:job.production_owner_opportunity_id || null,ignoreActiveJobId:job.id,
              recoveryRunId:job.recovery_run_id || null });
          }
          });
          break;
        }
        case "revise_draft": {
          this.requireContentEngine();
          const contentPackage = this.repository.getDraftPackage(job.entity_id);
          if (!contentPackage) throw new Error(`Article draft ${job.entity_id} no longer exists.`);
          const drafted = await guarded((signal) => this.contentEngine.repairDraft(contentPackage, contentPackage.review?.issues || [], { signal, telemetryContext }));
          commitStage(() => {
          const contractAware = this.canComposeFrontendPage;
          const draftId = this.repository.saveDraft(contentPackage.draft.brief_id, drafted.output, drafted.model,
            { deferReview: job.dedupe_key?.startsWith("manual-stage:") || contractAware,
              opportunityId:job.production_owner_opportunity_id || null,preserveVisuals:true });
          if (!job.dedupe_key?.startsWith("manual-stage:")) {
            if (this.visuals?.enabled && this.repository.plannedVisuals(draftId).length) this.enqueueChild(job,"generate_visuals",draftId);
            else if (contractAware) this.enqueueChild(job,"compose_frontend_page",draftId);
          }
          });
          break;
        }
        case "compose_commercial": {
          if (!this.commercialComposer) throw new Error("Commercial Composer is not configured.");
          const contentPackage = this.repository.getDraftPackage(job.entity_id);
          if (!contentPackage?.review?.passed) throw new Error("Only a QA-passed Research Draft can enter the Commercial Layer.");
          const offers = this.repository.activeOffersForDestination(contentPackage.brief.destination_slug);
          const composition = this.commercialComposer.compose(contentPackage, offers);
          let missingComponents = [];
          if (this.frontendContracts?.configured) {
            const capabilities = this.frontendContracts.commercialCapabilities(composition.requiredComponents);
            missingComponents = capabilities.missing;
            for (const componentId of capabilities.missing) this.repository.createFrontendCapabilityRequest({
              draftId: job.entity_id, briefId: contentPackage.brief?.id || null,
              semanticNeed: componentId, useCase: `Commercial overlay for ${contentPackage.draft?.title || job.entity_id}`,
              reason: `The Commercial Composer selected '${componentId}', but the active Frontend Contract does not publish that component. Contract-aware delivery remains blocked until the capability is available.`,
            });
          }
          if (missingComponents.length) {
            composition.outcome = "blocked";
            composition.reasonCode = "SELECTED_COMPONENT_UNAVAILABLE";
            composition.diagnostics = { ...(composition.diagnostics || {}), outcome:"blocked",
              reason_code:composition.reasonCode, missing_components:missingComponents };
            this.repository.saveCommercialComposition(job.entity_id, composition);
            throw new PublishCompositionError("SELECTED_COMPONENT_UNAVAILABLE",
              `Selected commercial components are unavailable in the active Frontend Contract: ${missingComponents.join(", ")}.`,
              { missingComponents });
          }
          commitStage(() => {
            this.repository.saveCommercialComposition(job.entity_id, composition);
            if (this.wordpress?.enabled) this.enqueueChild(job,this.frontendContracts?.configured ? "compose_publish_page" : "push_wordpress_draft",job.entity_id);
          });
          break;
        }
        case "compose_publish_page": {
          if (!this.wordpress?.enabled) throw new PublishCompositionError("WORDPRESS_UNCONFIGURED", "WordPress delivery must be configured before Publish Composition.");
          const contract = this.requireFrontendContract();
          let contentPackage = this.repository.getDraftPackage(job.entity_id);
          if (!contentPackage?.review?.passed) throw new PublishCompositionError("QA_NOT_PASSED", "Only a QA-passed Research Draft can enter Publish Composition.");
          if (!contentPackage.commercial_composition) throw new PublishCompositionError("COMMERCIAL_NOT_COMPLETE", "Commercial composition must complete before Publish Composition.");
          if (!contentPackage.commercial_composition.current) throw new PublishCompositionError("COMMERCIAL_OVERLAY_STALE",
            "The commercial overlay no longer matches the current editorial page, asset inventory, layout strategy, or Frontend Contract.",
            { refreshReason:contentPackage.commercial_composition.refresh_reason || "dependency_changed" });
          const storedEditorialPage = contentPackage.frontend_page?.payload;
          const supportsContentType = Boolean(contract.pageSchema?.schema?.properties?.metadata?.properties?.contentType);
          const editorialPage = normalizeFrontendPageForDelivery(storedEditorialPage,
            supportsContentType ? contentPackage.brief?.canonical?.content_type : null);
          if (!editorialPage) throw new PublishCompositionError("NO_VALID_FRONTEND_PAGE_PAYLOAD", "The validated editorial Frontend Page Payload is missing.");
          if (contentPackage.frontend_page.snapshot_id !== contract.id || contentPackage.frontend_page.contract_checksum !== contract.checksum) {
            this.repository.markFrontendPublishComposition(job.entity_id, "stale_contract");
            this.repository.markFrontendPageCompositionStale(job.entity_id);
            this.repository.enqueue("sync_frontend_contract", "default");
            throw new PublishCompositionError("CONTRACT_VERSION_MISMATCH", "Editorial Page Payload provenance does not match the active Frontend Contract.");
          }
          const editorialValidation = this.frontendContracts.validatePagePayload(editorialPage);
          if (!editorialValidation.valid) throw invalidPublishPage("EDITORIAL_PAGE_INVALID", editorialValidation,
            publishFailureContext({job,contentPackage,contract,page:editorialPage,phase:"editorial_page"}));
          const finalPage = mergeCommercialOverlay(editorialPage, contentPackage.commercial_composition);
          const commercialReconciliation = reconcileCommercialDelivery(contentPackage.commercial_composition, { finalPage });
          if (!commercialReconciliation.valid) throw new PublishCompositionError("COMMERCIAL_DELIVERY_MISMATCH",
            `${commercialReconciliation.errors[0]?.message || "A selected commercial slot was lost while merging the Final Page Payload."} Slot receipt: ${JSON.stringify({slots:commercialReconciliation.slots,block_types:commercialReconciliation.block_types})}.`, commercialReconciliation);
          const finalPageValidation = this.frontendContracts.validatePagePayload(finalPage);
          if (!finalPageValidation.valid) throw invalidPublishPage("FINAL_PAGE_INVALID", finalPageValidation,
            publishFailureContext({job,contentPackage,contract,page:finalPage,phase:"final_page_after_commercial_merge"}));
          const deliveryContentPackage = { ...contentPackage, frontend_page:{ ...contentPackage.frontend_page,
            validation:remapBlockProvenanceForDelivery(storedEditorialPage, editorialPage, contentPackage.frontend_page?.validation) } };
          const finalArtifactValidation = validateFinalPageArtifact(finalPage, deliveryContentPackage);
          if (!finalArtifactValidation.valid) throw invalidPublishPage("FINAL_PAGE_QA_FAILED", finalArtifactValidation,
            publishFailureContext({job,contentPackage,contract,page:finalPage,phase:"final_page_qa"}));
          await guarded((signal) => this.uploadVisualMedia(contentPackage, { signal, idempotencyKey: job.id, assertLease: assertInput }));
          contentPackage = this.repository.getDraftPackage(job.entity_id);
          assertPublicationEligibility(this.repository.db, job.entity_id, { phase: 'delivery', pagePayload: finalPage });
          const mediaValidation = validateMediaDelivery(contentPackage.draft.visuals, { requireMetadata: true, pagePayload:finalPage });
          if (!mediaValidation.valid) throw invalidPublishPage("MEDIA_DELIVERY_INVALID", mediaValidation,
            publishFailureContext({job,contentPackage,contract,page:finalPage,phase:"media_delivery"}));
          if (!contentPackage.draft?.seo?.meta_title || !contentPackage.draft?.meta_description) {
            throw new PublishCompositionError("SEO_PACKAGE_MISSING", "A generated SEO title and meta description are required before delivery.");
          }
          const publishPackage = buildPublishPackage({
            pagePayload: finalPage,
            draft: contentPackage.draft,
            contract,
            publication: contentPackage.publication,
            media: mediaReferences(contentPackage.draft.visuals),
          });
          const packageReconciliation = reconcileCommercialDelivery(contentPackage.commercial_composition, { finalPage, publishPackage });
          if (!packageReconciliation.valid) throw new PublishCompositionError("COMMERCIAL_DELIVERY_MISMATCH",
            `${packageReconciliation.errors[0]?.message || "A selected commercial slot was lost while building the Publish Package."} Slot receipt: ${JSON.stringify({slots:packageReconciliation.slots,block_types:packageReconciliation.block_types})}.`, packageReconciliation);
          const validation = this.frontendContracts.validatePublishPackage(publishPackage);
          const savePublish = () => this.repository.saveFrontendPublishComposition(job.entity_id, contract, publishPackage, validation, contentPackage.commercial_composition.strategy_version);
          if (!validation.valid) {
            savePublish(); // Preserve invalid output for diagnosis without completing the job.
            throw invalidPublishPage("PUBLISH_PACKAGE_INVALID", validation,
              publishFailureContext({job,contentPackage,contract,page:finalPage,publishPackage,phase:"publish_package"}));
          }
          commitStage(() => {
            savePublish();
            this.enqueueChild(job,"push_wordpress_draft",job.entity_id);
          });
          break;
        }
        case "push_wordpress_draft": {
          if (!this.wordpress?.enabled) throw new Error("WordPress draft delivery is not configured.");
          const contentPackage = this.repository.getDraftPackage(job.entity_id);
          assertPublicationEligibility(this.repository.db, job.entity_id, { phase: 'delivery',
            pagePayload: contentPackage?.publish_composition?.publish_package?.page || null });
          if (!contentPackage?.review?.passed) throw new Error("Only a QA-passed draft can be sent to WordPress.");
          if (!contentPackage.commercial_composition) throw new Error("Commercial composition stage must complete before WordPress delivery.");
          // Once a Frontend Contract source is configured, a publishable article must carry
          // a currently valid renderer payload.  This deliberately keeps the legacy
          // WordPress-only path available only for installations that have not yet opted
          // into the Frontend Contract integration.
          if (this.frontendContracts?.configured) {
            const contract = this.requireFrontendContract();
            const composition = contentPackage.publish_composition;
            if (!composition?.publish_package || !["valid", "delivery_failed"].includes(composition.status)) {
              throw new PublishCompositionError("NO_VALID_PUBLISH_PACKAGE", "A validated Final Publish Package is required before delivery.");
            }
            if (composition.snapshot_id !== contract.id || composition.contract_checksum !== contract.checksum) throw new PublishCompositionError("CONTRACT_VERSION_MISMATCH", "Final Publish Package provenance does not match the active Frontend Contract.");
            const validation = this.frontendContracts.validatePublishPackage(composition.publish_package);
            if (!validation.valid) throw invalidPublishPage("PUBLISH_PACKAGE_INVALID", validation);
          }
          const publication = this.repository.prepareWordPressPublication(job.entity_id, this.wordpress.config.siteUrl,
            this.frontendContracts?.configured ? "contract" : "legacy");
          const publishedMediaRefresh = contentPackage.draft.status === 'published'
            && deliveryRefreshScopeForJob(this.repository, job) === 'media';
          try {
            let result;
            if (this.frontendContracts?.configured) {
              const publishPackage = structuredClone(contentPackage.publish_composition.publish_package);
              publishPackage.publication.existing_post_id = publication.post_id || publishPackage.publication.existing_post_id || null;
              if (publishedMediaRefresh) {
                if (!publication.post_id) throw new Error('Published media refresh has no WordPress post ID.');
                publishPackage.publication.status = 'publish';
                const pageHash = crypto.createHash('sha256').update(JSON.stringify(publishPackage.page)).digest('hex');
                const receipt = await guarded((signal) => this.wordpress.getCmsArticleReceipt(publication.post_id, { signal }));
                if (receipt.status !== 'publish' || receipt.cms_draft_id !== job.entity_id) {
                  throw Object.assign(new Error('Published WordPress identity or status changed.'),
                    {code:'WORDPRESS_MEDIA_REFRESH_IDENTITY_MISMATCH',retryable:false});
                }
                const prior = this.repository.wordPressMediaRefreshAttempt(job.entity_id);
                if (prior && prior.state !== 'completed') {
                  if (prior.page_hash !== pageHash || receipt.page_payload_hash !== pageHash) {
                    throw Object.assign(new Error('Published media refresh outcome is unknown; operator reconciliation is required.'),
                      {code:'WORDPRESS_MEDIA_REFRESH_OUTCOME_UNKNOWN',retryable:false});
                  }
                  result = {postId:publication.post_id,postUrl:publication.post_url,status:'publish',
                    deliveryManifest:{page_payload_hash:pageHash},visuals:[]};
                  this.repository.completeWordPressMediaRefresh(job.entity_id,pageHash);
                } else {
                  assertLease();
                  this.repository.beginWordPressMediaRefreshAttempt(job.entity_id,publication.post_id,job.id,pageHash);
                  try {
                    result = await guarded((signal) => this.wordpress.upsertContractDraft(publishPackage, { signal,
                      idempotencyKey:job.id,draftId:job.entity_id,pagePayload:publishPackage.page }));
                    this.repository.completeWordPressMediaRefresh(job.entity_id,pageHash);
                  } catch (error) {
                    const verified = await this.wordpress.getCmsArticleReceipt(publication.post_id).catch(() => null);
                    if (verified?.status === 'publish' && verified.cms_draft_id === job.entity_id
                      && verified.page_payload_hash === pageHash) {
                      result = {postId:publication.post_id,postUrl:publication.post_url,status:'publish',
                        deliveryManifest:{page_payload_hash:pageHash},visuals:[]};
                      this.repository.completeWordPressMediaRefresh(job.entity_id,pageHash);
                    } else {
                      this.repository.markWordPressMediaRefreshUnknown(job.entity_id);
                      throw Object.assign(error,{code:'WORDPRESS_MEDIA_REFRESH_OUTCOME_UNKNOWN',retryable:false});
                    }
                  }
                }
              } else result = await guarded((signal) => this.wordpress.upsertContractDraft(publishPackage, { signal, idempotencyKey: job.id,
                draftId: job.entity_id, pagePayload: publishPackage.page }));
            } else {
              const publishableDraft = {
                ...contentPackage.draft,
                visuals: this.repository.listDraftVisualsForDelivery?.(contentPackage.draft.id)
                  || contentPackage.draft.visuals || [],
                body_markdown: contentPackage.commercial_composition.publishable_body_markdown,
                content_blocks: contentPackage.commercial_composition.content_blocks?.length
                  ? contentPackage.commercial_composition.content_blocks
                  : markdownToContentBlocks(contentPackage.commercial_composition.publishable_body_markdown),
              };
              result = await guarded((signal) => this.wordpress.upsertDraft(publishableDraft, publication.post_id, { signal, idempotencyKey: job.id,
                draftId: job.entity_id }));
            }
            commitStage(() => this.repository.completeWordPressPublication(job.entity_id, result,{opportunityId:job.production_owner_opportunity_id || null}));
          } catch (error) {
            if (isJobLeaseLost(error)) throw error;
            this.repository.failWordPressPublication(job.entity_id, error,{opportunityId:job.production_owner_opportunity_id || null});
            if (["CONTRACT_MISMATCH", "CONTRACT_VERSION_MISMATCH"].includes(error?.code)) {
              this.repository.markFrontendPublishComposition(job.entity_id, "stale_contract");
              this.repository.markFrontendPageCompositionStale(job.entity_id);
              this.repository.enqueue("sync_frontend_contract", "default");
            }
            throw error;
          }
          break;
        }
        case "publish_wordpress_post": {
          if (!this.wordpress?.enabled) throw new Error('WordPress publishing is not configured.');
          const content = this.repository.getDraftPackage(job.entity_id);
          const postId = Number(content?.publication?.post_id);
          if (!postId || content.publication.status !== 'synced') throw new Error('No delivered WordPress draft exists.');
          const current = await guarded((signal) => this.wordpress.getPost(postId, { signal }));
          if (current.status === 'publish') {
            this.repository.completeWordPressPublish(job.entity_id, current);
            break;
          }
          if (current.status !== 'draft') throw new Error(`WordPress post is ${current.status}; publication requires a draft.`);
          if (!content.review?.passed || !content.commercial_composition?.current
            || content.publish_composition?.status !== 'delivered') {
            throw new Error('Current QA and final page delivery are required before publishing.');
          }
          assertPublicationEligibility(this.repository.db, job.entity_id, { phase: 'delivery',
            pagePayload: content.publish_composition?.publish_package?.page || null });
          this.repository.beginWordPressPublishAttempt(job.entity_id, postId, job.id);
          try {
            const published = await guarded((signal) => this.wordpress.publishPost(postId,
              { signal, idempotencyKey: job.id }));
            this.repository.completeWordPressPublish(job.entity_id, published);
          } catch (error) {
            // A timed out write may already have committed remotely. Read once;
            // never blindly send the same publish transition again.
            const verified = await this.wordpress.getPost(postId).catch(() => null);
            if (verified?.status === 'publish') this.repository.completeWordPressPublish(job.entity_id, verified);
            else {
              this.repository.markWordPressPublishUnknown(job.entity_id);
              throw Object.assign(error, { code: 'WORDPRESS_PUBLISH_OUTCOME_UNKNOWN', retryable: false });
            }
          }
          break;
        }
        default:
          throw new Error(`Unknown job type: ${job.type}`);
      }
      if (!stageCommitted) assertLease();
      const finished = stageCommitted || (this.repository.finishPipelineJob
        ? this.repository.finishPipelineJob(job, pipelineArtifact)
        : this.repository.completeJob(job.id, job.locked_by, job.lease_generation));
      if (!finished) throw Object.assign(new Error("JOB_LEASE_LOST"), { code: "JOB_LEASE_LOST", retryable: false });
      this.recordExtractionOutcome(job, { ok: true });
      this.logger.info("pipeline.job_succeeded", { jobId: job.id, jobType: job.type, durationMs: Date.now() - startedAt });
      return true;
    } catch (error) {
      if (job) {
        if (isJobLeaseLost(error)) {
          this.logger.warn("pipeline.job_lease_lost", { jobId: job.id, jobType: job.type, entityId: job.entity_id });
        } else if (error?.code === 'MEDIA_RATE_WAIT' && error.availableAt) {
          this.repository.deferJobWithoutAttempt(job, error.availableAt);
        } else {
          this.repository.failPipelineArtifact?.(pipelineArtifact, error);
          this.recordExtractionOutcome(job, { ok: false, error });
          this.repository.failJob(job, error);
          this.logger.error("pipeline.job_failed", {
            jobId: job.id, jobType: job.type, entityId: job.entity_id, attempt: job.attempts,
            durationMs: startedAt ? Date.now() - startedAt : null, error,
          });
        }
      } else if (isSqliteBusy(error)) this.logger.warn("pipeline.database_busy_deferred", { error });
      else this.logger.error("pipeline.unhandled_error", { error });
      return false;
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (abortController && !abortController.signal.aborted) abortController.abort();
      if (abortController) this.activeAbortControllers.delete(abortController);
      this.working -= 1;
    }
  }

  recordExtractionOutcome(job, outcome) {
    if (this.concurrencyMode !== "auto" || !isAiJobType(job?.type)) return;
    this.extractionOutcomes.push({ ...outcome, at: Date.now() });
    if (this.extractionOutcomes.length > this.concurrencySuccessWindow) this.extractionOutcomes.shift();
    if (!outcome.ok && (isProviderPressure(outcome.error) || outcome.error?.retryable || /timeout/i.test(String(outcome.error?.message || "")))) {
      this.maxConcurrent = Math.max(1, Math.floor(this.maxConcurrent / 2));
      this.logger.warn("pipeline.extraction_concurrency_reduced", { concurrency: this.maxConcurrent, reason: outcome.error?.code || outcome.error?.status || "transient_failure" });
      this.extractionOutcomes = [];
      return;
    }
    if (this.extractionOutcomes.length >= this.concurrencySuccessWindow && this.extractionOutcomes.every((item) => item.ok) && this.maxConcurrent < this.concurrencyCeiling) {
      this.maxConcurrent = Math.min(this.concurrencyCeiling, this.maxConcurrent + 1);
      this.logger.info("pipeline.extraction_concurrency_increased", { concurrency: this.maxConcurrent });
      this.extractionOutcomes = [];
    }
  }

  requireContentEngine() {
    if (!this.contentEngine?.enabled) throw new Error("Content production requires the fixed Vertex Gemini 3.8 Flash writing runtime.");
  }

  requireExtractionEngine(telemetryContext = {}) {
    if (!(this.sourceEngine?.enabledFor?.({ telemetryContext }) ?? this.sourceEngine?.enabled)) {
      throw new Error("Source semantic processing requires credentials for the extraction model frozen on this Job.");
    }
  }

  ensureReusedDownstream(job) {
    const repository = this.repository, entity = job.entity_id;
    const next = (type, id = entity,options={}) => this.enqueueChild(job,type,id,options);
    if (job.dedupe_key?.startsWith('manual-stage:')) return;
    switch (job.type) {
      case 'extract_segment_claims': next('audit_segment_coverage'); break;
      case 'audit_segment_coverage': {
        const pack = repository.getSegmentCoveragePackage(entity);
        if (pack && !pack.staleCaptureVersion) {
          if (pack.coverage?.status === 'retry_required') next('retry_segment_extraction');
          else if (repository.sourceCoverageReady(pack.source.id)) next('finalize_source_extraction', pack.source.id);
        }
        break;
      }
      case 'retry_segment_extraction': {
        const pack = repository.getSegmentCoveragePackage(entity);
        if (pack && !pack.staleCaptureVersion && repository.sourceCoverageReady(pack.source.id)) next('finalize_source_extraction', pack.source.id);
        break;
      }
      case 'extract_source_experience': this.enqueueSourceSemanticDownstream(entity,job); break;
      case 'analyze_source_blueprint': next('rebuild_editorial', 'global'); break;
      case 'resolve_entities': next('rebuild_knowledge'); break;
      case 'assemble_editorial': next('plan_content'); break;
      case 'plan_content': {
        const brief = repository.db.prepare('SELECT id FROM content_briefs WHERE candidate_id=?').get(entity);
        if (brief) {
          if (job.pipeline_version === 'article_bundle_v1') {
            const draft = repository.db.prepare('SELECT id FROM article_drafts WHERE brief_id=?').get(brief.id);
            if (draft) {
              if (this.visuals?.enabled) next('generate_visuals',draft.id);
              else if (this.canComposeFrontendPage) next('compose_frontend_page',draft.id);
              else next('review_draft',draft.id);
            }
          } else next('plan_narrative', brief.id);
        }
        break;
      }
      case 'plan_narrative': next('assemble_writing_packet'); break;
      case 'assemble_writing_packet': next(this.canComposeFrontendPage ? 'compose_frontend_page_plan' : 'generate_draft'); break;
      case 'compose_frontend_page_plan': next('generate_draft'); break;
      case 'generate_draft': {
        const draft = repository.db.prepare('SELECT id FROM article_drafts WHERE brief_id=?').get(entity);
        if (draft) { next('review_draft', draft.id); if (this.visuals?.enabled) next('generate_visuals', draft.id); else if (this.canComposeFrontendPage) next('compose_frontend_page', draft.id); }
        break;
      }
      case 'compose_frontend_page': next(deliveryRefreshContinuation(repository,job,'compose_frontend_page') || 'review_draft'); break;
      case 'review_draft': {
        const pack = repository.getDraftPackage(entity);
        if (pack?.review?.passed && (!this.canComposeFrontendPage || pack.frontend_page?.current)) next('compose_commercial');
        else if (pack?.review && !pack.review.passed) repository.automaticQualityRepairState(entity, pack.review.issues, { enqueue: true,
          productionOwnerOpportunityId:job.production_owner_opportunity_id || null,ignoreActiveJobId:job.id,
          recoveryRunId:job.recovery_run_id || null });
        break;
      }
      case 'revise_draft': next('review_draft'); if (this.canComposeFrontendPage) next('compose_frontend_page'); break;
    }
  }

  enqueueChild(parentJob,type,entityId,options={}){
    return this.repository.enqueue(type,entityId,{...options,...inheritJobContext(parentJob,{type,
      workloadClass:options.workloadClass,priority:options.priority,executionRoute:options.executionRoute,
      recoveryRunId:options.recoveryRunId,interactive:options.interactive})});
  }

  async runRepositoryTask(task,entityId){
    if(!this.processIsolationEnabled){
      if(task==="rebuild_knowledge")return this.repository.rebuildKnowledge(entityId);
      if(task==="rebuild_topic_clusters")return this.repository.rebuildTopicClusters(entityId);
      if(task==="rebuild_content_opportunities")return this.repository.rebuildKnowledgeOpportunities(entityId);
      throw new Error(`Unsupported local repository task: ${task}`);
    }
    const result=await this.isolatedTaskRunner(ISOLATED_REPOSITORY_TASK,[task,this.databasePath,entityId],{timeoutMs:45*60_000});
    this.logger.info("pipeline.isolated_task_completed",{task,entityId,result:result?.result});
    return result?.result;
  }

  enqueueSourceSemanticDownstream(sourceId,parentJob=null) {
    const source=this.repository.getSource(sourceId);
    const destination=source?.structured?.destination_slug;
    if(destination)this.enqueueChild(parentJob||{},"resolve_entities",destination,{workloadClass:"semantic"});
    this.enqueueChild(parentJob||{},"analyze_source_family",sourceId,{workloadClass:"background_enrichment",priority:40});
    if (this.repository.contentConfig?.sourceComplexityRouting === true) {
      const profile = sourceProcessingProfile(this.repository.getSource(sourceId));
      if (profile.route === 'fragment') {
        // Claims, coverage, Experience and Knowledge already ran/are queued.
        // A short fragment does not need a full-source writing blueprint or an
        // independent article proposal. It can still support a later synthesis.
        this.logger.info('pipeline.source_fragment_route', { sourceId, profile: profile.route, version: profile.version });
        return;
      }
    }
    if (typeof this.extractor?.analyzeBlueprint === "function") this.enqueueChild(parentJob||{},"analyze_source_blueprint",sourceId,{workloadClass:"background_enrichment",priority:40});
    else this.enqueueChild(parentJob||{},"rebuild_editorial","global",{workloadClass:"background_enrichment",priority:40});
    if (this.sourceEngine?.enabled) this.enqueueChild(parentJob||{},"analyze_source_diagnostic",sourceId,{workloadClass:"background_enrichment",priority:40});
  }

  get canComposeFrontendPage() {
    return Boolean(this.frontendContracts?.diagnostics().canCompose);
  }

  requireFrontendContract() {
    const contract = this.frontendContracts?.active;
    if (!contract || !this.canComposeFrontendPage) throw new Error("NO_VALID_FRONTEND_CONTRACT: component-aware page composition is blocked until a compatible Frontend Contract is synchronized.");
    return contract;
  }

  async uploadVisualMedia(contentPackage, options = {}) {
    if (!this.wordpress?.enabled || typeof this.wordpress.resolveVisualMedia !== "function") return [];
    freezeRequiredMediaManifest(this.repository.db, contentPackage.draft?.id);
    assertPublicationEligibility(this.repository.db, contentPackage.draft?.id, { phase: 'local' });
    const deliveryVisuals = this.repository.listDraftVisualsForDelivery?.(contentPackage.draft?.id)
      || contentPackage.draft?.visuals || [];
    const uploaded = await this.wordpress.resolveVisualMedia(deliveryVisuals, (visual) => {
      options.assertLease?.();
      this.repository.saveWordPressVisual(visual.visualId, visual);
    }, options);
    options.assertLease?.();
    for (const visual of uploaded) this.repository.saveWordPressVisual(visual.visualId, visual);
    return uploaded;
  }
}

function isSqliteBusy(error) {
  return error?.errcode === 5 || error?.code === "SQLITE_BUSY"
    || (error?.code === "ERR_SQLITE_ERROR" && /database is locked/i.test(String(error?.message || "")));
}

function parseStoredJson(value) {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}

function isJobLeaseLost(error) {
  return error?.code === "JOB_LEASE_LOST" || error?.message === "JOB_LEASE_LOST";
}

function correlateBatchOutputs(items, outputs) {
  const byTransportKey = new Map();
  const byRequestFingerprint = new Map();
  for (const item of items || []) {
    byTransportKey.set(item.transport_key || item.batch_item_id, item);
    if (item.request_fingerprint) byRequestFingerprint.set(item.request_fingerprint, item);
  }
  const candidates = new Map();
  const anomalies = [];
  for (const output of outputs || []) {
    const item = (output?.id && byTransportKey.get(output.id))
      || (output?.requestFingerprint && byRequestFingerprint.get(output.requestFingerprint));
    if (!item) {
      anomalies.push({ output, reason: output?.id
        ? `Unknown Vertex Batch transport key: ${output.id}`
        : "Vertex Batch output had neither a known transport key nor a matching request fingerprint." });
      continue;
    }
    const values = candidates.get(item.job_id) || [];
    values.push(output);
    candidates.set(item.job_id, values);
  }
  const byJobId = new Map();
  const duplicates = new Set();
  for (const [jobId, values] of candidates) {
    if (values.length === 1) byJobId.set(jobId, values[0]);
    else {
      duplicates.add(jobId);
      for (const output of values) anomalies.push({ output, reason: `Duplicate Vertex Batch transport correlation for job ${jobId}.` });
    }
  }
  return { byJobId, duplicates, anomalies };
}

function invalidPublishPage(code, validation, context = {}) {
  const errors=(validation.errors || []).map((item)=>({
    issue_id:item.issue_id || null,
    code:item.code || item.keyword || "VALIDATION_ERROR",
    subcode:item.subcode || item.keyword || null,
    cause:item.cause || null,
    origin:item.origin || null,
    check_name:item.check_name || null,
    resource_type:item.resource_type || null,
    path:item.path || item.instancePath || item.schemaPath || null,
    instance_path:item.instancePath || null,
    schema_path:item.schemaPath || null,
    keyword:item.keyword || null,
    expected:item.expected ?? item.params ?? null,
    actual_safe_excerpt:item.actual_safe_excerpt ?? safeValidationExcerpt(item.actual),
    message:item.message || null,
    slot_key:item.slot_key || null,
    affiliate_asset_id:item.affiliate_asset_id || item.asset_id || null,
    claim_key:item.claim_key || null,
    content_node_ids:item.content_node_ids || null,
    evidence_or_asset_snapshot_hash:item.evidence_or_asset_snapshot_hash || null,
    review_id:item.review_id || null,
    component:item.component || item.component_type || null,
  }));
  return new PublishCompositionError(code, errors.map((item) => `${item.code}@${item.path || "$"}`).join(", "), {
    ...context,
    validation:{ valid:false,validator:validation.validator || context.validator || "frontend_contract",errors },
  });
}

function publishFailureContext({job,contentPackage,contract,page,publishPackage=null,phase}) {
  const commercial=contentPackage?.commercial_composition || {};
  return {
    phase,
    execution_kind:"deterministic",
    draftRevision:contentPackage?.draft?.revision ?? null,
    inputHash:hashJson({
      editorial_page_hash:commercial.editorial_page_hash || contentPackage?.frontend_page?.payload_hash || null,
      overlay_version:commercial.overlay_version || null,
      asset_inventory_hash:commercial.asset_inventory_hash || null,
      contract_checksum:contract?.checksum || null,
    }),
    candidateHash:hashJson(publishPackage || page || {}),
    editorial_page_hash:commercial.editorial_page_hash || null,
    final_page_hash:page ? hashJson(page) : null,
    publish_package_hash:publishPackage ? hashJson(publishPackage) : null,
    overlay_version:commercial.overlay_version || null,
    asset_inventory_hash:commercial.asset_inventory_hash || null,
    asset_ids:commercial.asset_ids || [],
    slots:(commercial.slots || []).map((slot)=>({slot_key:slot.slot_key,affiliate_asset_id:slot.affiliate_asset_id,
      component_type:slot.component_type,placement:slot.placement})),
    contract_snapshot_id:contract?.id || null,
    contract_checksum:contract?.checksum || null,
    contract_schema_version:contract?.pageSchema?.version || null,
    code_revision:String(process.env.ENGINE_IMAGE || process.env.APP_REVISION || "unknown").slice(0,300),
    failed_at:new Date().toISOString(),
    job_id:job?.id || null,
    recovery_run_id:job?.recovery_run_id || null,
  };
}

function safeValidationExcerpt(value) {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  let text=typeof value === "string" ? value : JSON.stringify(value);
  text=text.replace(/https?:\/\/[^\s"']+/giu,(url)=>{try{const parsed=new URL(url);return `${parsed.origin}${parsed.pathname}?[redacted]`;}catch{return "[redacted-url]";}})
    .replace(/(?:Bearer\s+)[A-Za-z0-9._~+/=-]+/giu,"Bearer [redacted]")
    .replace(/[A-Za-z0-9+/]{160,}={0,2}/gu,"[redacted-binary]");
  return text.length>500 ? `${text.slice(0,500)}…[truncated]` : text;
}

function hashJson(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

function mergeExtractionClaims(previous = [], retried = []) {
  const merged = [];
  const seen = new Set();
  for (const claim of [...(previous || []), ...(retried || [])]) {
    if (!claim) continue;
    const key = [claim.key, claim.subject, claim.predicate, claim.value, claim.source_quote]
      .map((value) => String(value || "").trim().toLowerCase()).join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(claim);
  }
  return merged;
}

function isRecoverableStructuredOutputError(error) {
  return /(?:invalid JSON|no structured output|structured output reached its token limit)/i.test(String(error?.message || error));
}

function isModelOutputLimit(error) {
  return error?.code === "MODEL_OUTPUT_LIMIT" || /(?:output|structured output).*(?:token|length).*limit|MAX_TOKENS/i.test(String(error?.message || error));
}
