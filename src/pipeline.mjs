import crypto from "node:crypto";
import { validatePlannedEvidence } from "./services/editorial-proposal.mjs";
import { composePageFromAst, markdownToContentBlocks } from "./content-blocks.mjs";
import { validatePlanningDestination } from "./destination-consistency.mjs";
import { buildPublishPackage, mediaReferences, mergeCommercialOverlay, PublishCompositionError, validateFinalPageArtifact } from "./publish-page.mjs";
import { validateMediaDelivery } from "./media-delivery.mjs";
import { isAiJobType, isProviderPressure } from "./job-policy.mjs";
import { evaluateSourcePreflight } from "./source-preflight.mjs";

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

export class Pipeline {
  constructor(repository, extractor, { pollMs = 750, maxConcurrent = null, heartbeatIntervalMs = null, recoveryIntervalMs = 60_000, extractionConfig = {}, contentEngine = null, visuals = null, wordpress = null, searchConsole = null, commercialComposer = null, frontendContracts = null, contentConfig = {}, logger = silentLogger } = {}) {
    this.repository = repository;
    this.extractor = extractor;
    this.pollMs = pollMs;
    this.contentEngine = contentEngine;
    this.visuals = visuals;
    this.wordpress = wordpress;
    this.searchConsole = searchConsole;
    this.commercialComposer = commercialComposer;
    this.frontendContracts = frontendContracts;
    this.contentConfig = { minFacts: 5, maxPerDestination: 1, ...contentConfig };
    this.logger = logger;
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

  start() {
    if (this.timer) return;
    const recovered = this.repository.recoverExpiredJobs?.() || 0;
    if (recovered) this.logger.warn("pipeline.expired_jobs_recovered", { count: recovered });
    const recoveredBatches = this.repository.recoverPreparingVertexBatches?.() || 0;
    if (recoveredBatches) this.logger.warn("pipeline.vertex_batch_preparation_recovered", { count: recoveredBatches });
    this.nextRecoveryAt = Date.now() + this.recoveryIntervalMs;
    this.timer = setInterval(() => this.pump(), this.pollMs);
    this.timer.unref();
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
      const recovered = this.repository.recoverExpiredJobs?.() || 0;
      if (recovered) this.logger.warn("pipeline.expired_jobs_recovered", { count: recovered });
      const recoveredBatches = this.repository.recoverPreparingVertexBatches?.() || 0;
      if (recoveredBatches) this.logger.warn("pipeline.vertex_batch_preparation_recovered", { count: recoveredBatches });
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
      guarded = async (operation) => {
        assertLease();
        const result = await operation(abortController.signal);
        assertLease();
        return result;
      };
      heartbeatTimer = setInterval(() => {
        if (!this.repository.heartbeatJob?.(job.id, job.locked_by, job.lease_generation)) {
          abortController.abort(Object.assign(new Error("JOB_LEASE_LOST"), { code: "JOB_LEASE_LOST" }));
          this.logger.error("pipeline.job_lease_lost", { jobId: job.id, workerId: job.locked_by });
        }
      }, this.heartbeatIntervalMs || Math.max(10_000, Math.floor((this.repository.jobLeaseMs || 60_000) / 3)));
      heartbeatTimer.unref();
      const telemetryContext = { runId: job.id, entityId: job.entity_id };
      const artifactConfigHash = crypto.createHash("sha256").update(JSON.stringify({
        provider: this.contentEngine?.config?.provider || this.extractor?.config?.provider || null,
        model: this.contentEngine?.config?.model || this.extractor?.config?.model || null,
        policy: this.contentEngine?.config?.stagePolicy?.version || this.extractor?.config?.stagePolicy?.version || "legacy",
        frontendContract: this.frontendContracts?.active?.checksum || null,
      })).digest("hex");
      pipelineArtifact = this.repository.preparePipelineArtifact?.(job, artifactConfigHash) || null;
      this.logger.info("pipeline.job_started", { jobId: job.id, jobType: job.type, entityId: job.entity_id, attempt: job.attempts });
      if (pipelineArtifact?.reused) {
        if (!this.repository.completeJob(job.id, job.locked_by, job.lease_generation)) throw Object.assign(new Error("JOB_LEASE_LOST"), { code: "JOB_LEASE_LOST", retryable: false });
        this.logger.info("pipeline.job_reused", { jobId: job.id, jobType: job.type, entityId: job.entity_id,
          inputHash: pipelineArtifact.input_hash, outputHash: pipelineArtifact.output_hash });
        return true;
      }
      switch (job.type) {
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
          this.repository.enqueue("preflight_source", job.entity_id);
          break;
        }
        case "preflight_source": {
          const source = this.repository.getSource(job.entity_id);
          if (!source) throw new Error(`Source ${job.entity_id} no longer exists.`);
          const preflight = evaluateSourcePreflight(source, {
            provider: this.extractor?.config?.provider || "kimi",
            sourceUploadsDir: this.extractor?.config?.sourceUploadsDir,
            imageBatchSize: this.extractor?.config?.imageBatchSize,
            textSegmentMaxChars: this.repository.contentConfig?.sourceTextSegmentMaxChars,
          });
          this.repository.recordSourcePreflight?.(source.id, preflight);
          if (!preflight.ready) {
            const error = new Error(`Source preflight blocked processing: ${preflight.issues.map((item) => `${item.code}: ${item.message}`).join("; ")}`);
            error.code = "SOURCE_PREFLIGHT_BLOCKED";
            error.retryable = false;
            throw error;
          }
          this.repository.enqueue("segment_source", source.id);
          break;
        }
        case "segment_source": {
          const segments = this.repository.prepareSourceSegments(job.entity_id);
          for (const segment of segments) this.repository.enqueue("extract_segment_claims", segment.id);
          break;
        }
        case "extract_segment_claims": {
          const pack = this.repository.getSegmentExtractionPackage(job.entity_id);
          if (!pack) throw new Error(`Source segment ${job.entity_id} no longer exists.`);
          if (pack.staleCaptureVersion) break;
          try {
            const extraction = await guarded((signal) => this.extractor.extract(pack.source, { signal, telemetryContext }));
            if (!this.repository.saveSegmentExtraction(job.entity_id, extraction)) break;
            this.repository.enqueue("audit_segment_coverage", job.entity_id);
          } catch (error) {
            if (!isModelOutputLimit(error)) throw error;
            const children = this.repository.splitSourceSegmentForRetry(job.entity_id);
            if (!children.length) throw error;
            for (const child of children) this.repository.enqueue("extract_segment_claims", child.id);
            this.logger.warn("pipeline.segment_resegmented_after_output_limit", { segmentId: job.entity_id, childCount: children.length });
          }
          break;
        }
        case "audit_segment_coverage": {
          const coveragePackage = this.repository.getSegmentCoveragePackage(job.entity_id);
          if (!coveragePackage) throw new Error(`Source segment ${job.entity_id} has no extraction result.`);
          if (coveragePackage.staleCaptureVersion) break;
          const assessment = coveragePackage.expectedModality === "text" && typeof this.extractor.auditCoverage === "function"
            ? await guarded((signal) => this.extractor.auditCoverage(coveragePackage, { signal, telemetryContext }))
            : null;
          const audit = this.repository.auditSegmentCoverage(job.entity_id, assessment?.output || assessment);
          if (audit.status === "stale") break;
          if (audit.status === "retry_required") this.repository.enqueue("retry_segment_extraction", job.entity_id);
          else if (this.repository.sourceCoverageReady(audit.sourceId)) this.repository.enqueue("finalize_source_extraction", audit.sourceId);
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
          const retryExtraction = await guarded((signal) => this.extractor.extract(pack.source, { signal, telemetryContext }));
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
          if (!this.repository.saveSegmentExtraction(job.entity_id, extraction, { retry: true })) break;
          const retriedPackage = this.repository.getSegmentCoveragePackage(job.entity_id);
          if (!retriedPackage || retriedPackage.staleCaptureVersion) break;
          const assessment = retriedPackage.expectedModality === "text" && typeof this.extractor.auditCoverage === "function"
            ? await guarded((signal) => this.extractor.auditCoverage(retriedPackage, { signal, telemetryContext }))
            : null;
          const audit = this.repository.auditSegmentCoverage(job.entity_id, assessment?.output || assessment);
          if (audit.status === "stale") break;
          if (this.repository.sourceCoverageReady(audit.sourceId)) this.repository.enqueue("finalize_source_extraction", audit.sourceId);
          break;
        }
        case "finalize_source_extraction": {
          const finalized = this.repository.finalizeSegmentedExtraction(job.entity_id);
          this.repository.enqueue("analyze_source_family", job.entity_id);
          if (typeof this.extractor.analyzeBlueprint === "function") this.repository.enqueue("analyze_source_blueprint", job.entity_id);
          else this.repository.enqueue("rebuild_editorial", "global");
          if (this.contentEngine?.enabled) this.repository.enqueue("analyze_source_diagnostic", job.entity_id);
          this.logger.info("pipeline.source_finalized", { sourceId: job.entity_id, ...finalized });
          break;
        }
        case "analyze_source_blueprint": {
          const source = this.repository.getSource(job.entity_id);
          if (!source?.structured) throw new Error(`Source ${job.entity_id} is not ready for editorial blueprint analysis.`);
          const analyzed = await guarded((signal) => this.extractor.analyzeBlueprint(source, { signal, telemetryContext }));
          this.repository.saveSourceBlueprint(job.entity_id, analyzed.output);
          this.repository.enqueue("rebuild_editorial", "global");
          break;
        }
        case "analyze_source_family": {
          const family = this.repository.analyzeSourceFamily(job.entity_id);
          const source = this.repository.getSource(job.entity_id);
          if (source?.structured?.destination_slug) this.repository.enqueue("resolve_entities", source.structured.destination_slug);
          this.logger.info("pipeline.source_family_analyzed", { sourceId: job.entity_id, family });
          break;
        }
        case "analyze_source_diagnostic": {
          // Source diagnostics explain evidence value; they never create or queue
          // an article. The AI intake record remains the human-facing diagnostic.
          this.requireContentEngine();
          const intakePackage = this.repository.getIntakePackage(job.entity_id);
          if (!intakePackage) throw new Error(`Source ${job.entity_id} is not ready for diagnostic analysis.`);
          const analyzed = await guarded((signal) => this.contentEngine.analyzeIntake(intakePackage, { signal, telemetryContext }));
          this.repository.saveIntakeAnalysis(job.entity_id, analyzed.output, analyzed.model);
          break;
        }
        case "resolve_entities": {
          let cursor = null;
          do {
            const entityPackage = this.repository.getEntityResolutionPackage(job.entity_id, 300, cursor);
            if (this.contentEngine?.enabled && typeof this.contentEngine.resolveEntities === "function" && entityPackage.claims.length) {
              try {
                const resolved = await guarded((signal) => this.contentEngine.resolveEntities(entityPackage, { signal,
                  telemetryContext: { ...telemetryContext, entityId: `${job.entity_id}:${cursor || "start"}` } }));
                this.repository.applyEntityResolution(job.entity_id, resolved.output, resolved.model);
              } catch (error) {
                if (!isRecoverableStructuredOutputError(error)) throw error;
                this.logger.warn("pipeline.entity_resolution_model_output_invalid", {
                  jobId: job.id, entityId: job.entity_id, cursor, error,
                });
                this.repository.resolveEntitiesDeterministically(job.entity_id);
                cursor = null;
                break;
              }
            } else if (!cursor) {
              this.repository.resolveEntitiesDeterministically(job.entity_id);
            }
            cursor = entityPackage.nextCursor;
          } while (cursor);
          this.repository.enqueue("rebuild_knowledge", job.entity_id);
          break;
        }
        case "rebuild_knowledge":
          this.repository.rebuildKnowledge(job.entity_id);
          this.repository.enqueue("rebuild_topic_clusters", job.entity_id);
          break;
        case "rebuild_editorial":
          this.repository.rebuildEditorialLibrary();
          break;
        case "rebuild_topics": {
          // Legacy job name retained for old durable queues. Strategy 1.4
          // rebuilds topic clusters and coverage before reconciling approvals.
          this.repository.enqueue("rebuild_topic_clusters", job.entity_id);
          break;
        }
        case "rebuild_topic_clusters": {
          this.repository.rebuildTopicClusters(job.entity_id);
          this.repository.enqueue("build_coverage_matrix", job.entity_id);
          break;
        }
        case "build_coverage_matrix": {
          this.repository.rebuildCoverageMatrices(job.entity_id);
          this.repository.enqueue("rebuild_content_opportunities", job.entity_id);
          break;
        }
        case "rebuild_content_opportunities": {
          // Opportunity identity is durable and created by Source diagnostics;
          // Coverage was refreshed by build_coverage_matrix. This compatibility
          // stage now only reconciles durable approvals and never repeats it.
          this.repository.enqueue("reconcile_approved_opportunities", job.entity_id);
          break;
        }
        case "reconcile_approved_opportunities": {
          this.repository.reconcileApprovedOpportunities(job.entity_id);
          break;
        }
        case "analyze_intake": {
          this.requireContentEngine();
          const intakePackage = this.repository.getIntakePackage(job.entity_id);
          if (!intakePackage) throw new Error(`Source ${job.entity_id} is not ready for intake analysis.`);
          const analyzed = await guarded((signal) => this.contentEngine.analyzeIntake(intakePackage, { signal, telemetryContext }));
          this.repository.saveIntakeAnalysis(job.entity_id, analyzed.output, analyzed.model);
          break;
        }
        case "plan_content": {
          this.requireContentEngine();
          const contentPackage = this.repository.getTopicPackage(job.entity_id);
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
          const contractAware = this.canComposeFrontendPage;
          const briefId = this.repository.saveBrief(job.entity_id, planned.output, planned.model, { deferDraft: contractAware });
          if (contractAware) this.repository.enqueue("compose_frontend_page_plan", briefId);
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
          this.repository.saveFrontendPagePlan(job.entity_id, contract, composed.output, validation, composed.model);
          if (!validation.valid) throw new Error(`Frontend page plan is invalid: ${validation.errors.map((item) => item.code).join(", ")}`);
          this.repository.enqueue("generate_draft", job.entity_id);
          break;
        }
        case "generate_draft": {
          this.requireContentEngine();
          const contentPackage = this.repository.getBriefPackage(job.entity_id);
          if (!contentPackage) throw new Error(`Content brief ${job.entity_id} no longer exists.`);
          const drafted = await guarded((signal) => this.contentEngine.draft(contentPackage, null, { signal, telemetryContext }));
          const contractAware = this.canComposeFrontendPage;
          const draftId = this.repository.saveDraft(job.entity_id, drafted.output, drafted.model, { deferReview: contractAware });
          if (this.visuals?.enabled) this.repository.enqueue("generate_visuals", draftId);
          else if (contractAware) this.repository.enqueue("compose_frontend_page", draftId);
          break;
        }
        case "generate_visuals": {
          if (!this.visuals?.enabled) throw new Error("Visual generation is not configured.");
          const contentPackage = this.repository.getDraftPackage(job.entity_id);
          if (!contentPackage) throw new Error(`Article draft ${job.entity_id} no longer exists.`);
          for (const visual of this.repository.plannedVisuals(job.entity_id)) {
            try {
              const result = await guarded((signal) => this.visuals.generate(visual, contentPackage.draft, { signal, idempotencyKey: `${job.id}:${visual.id}` }));
              this.repository.saveGeneratedVisual(visual.id, result);
            } catch (error) {
              if (isJobLeaseLost(error)) throw error;
              const failed = this.repository.failVisual(visual.id, error);
              if (failed.retryable || visual.factual_image_required) throw error;
              this.logger.warn("pipeline.optional_visual_skipped", { visualId: visual.id, draftId: job.entity_id, error });
            }
          }
          if (this.canComposeFrontendPage) this.repository.enqueue("compose_frontend_page", job.entity_id);
          break;
        }
        case "compose_frontend_page": {
          this.requireContentEngine();
          const contract = this.requireFrontendContract();
          let contentPackage = this.repository.getDraftPackage(job.entity_id);
          if (!contentPackage) throw new Error(`Article draft ${job.entity_id} no longer exists.`);
          await guarded((signal) => this.uploadVisualMedia(contentPackage, { signal, idempotencyKey: job.id, assertLease }));
          contentPackage = this.repository.getDraftPackage(job.entity_id);
          const capabilities = this.frontendContracts.resolveForArticle({ canonical: contentPackage.brief?.canonical || {}, draft: contentPackage.draft || {} });
          if (!capabilities.components.length) {
            this.repository.createFrontendCapabilityRequest({ draftId: job.entity_id, briefId: contentPackage.brief?.id || null, semanticNeed: "article-page-payload", useCase: contentPackage.draft?.title || "Article draft", reason: "The active Frontend Contract exposes no stable components for the final page payload." });
            throw new Error("MISSING_FRONTEND_CAPABILITY: no stable Frontend component can express this page.");
          }
          const composed = composePageFromAst(contentPackage.draft.content_ast, capabilities, contract.pageSchema.schema)
            || await guarded((signal) => this.contentEngine.composeFrontendPage(contentPackage, capabilities, contract.pageSchema.schema, { signal, telemetryContext }));
          const validation = this.frontendContracts.validatePagePayload(composed.output);
          const savedPage = this.repository.saveFrontendPageComposition(job.entity_id, contentPackage.frontend_page_plan?.id || null, contract, composed.output, validation, composed.model,
            { revision: contentPackage.draft.revision, contentHash: contentPackage.draft.content_hash }, composed.provenance);
          if (!savedPage.validation.valid) throw new Error(`Frontend page payload is invalid: ${savedPage.validation.errors.map((item) => item.code).join(", ")}`);
          if (!job.dedupe_key?.startsWith("manual-stage:")) this.repository.enqueue("review_draft", job.entity_id);
          break;
        }
        case "review_draft": {
          this.requireContentEngine();
          const contentPackage = this.repository.getDraftPackage(job.entity_id);
          if (!contentPackage) throw new Error(`Article draft ${job.entity_id} no longer exists.`);
          const reviewed = await guarded((signal) => this.contentEngine.review(contentPackage, { signal, telemetryContext }));
          const revision = this.repository.saveReview(job.entity_id, reviewed.output, reviewed.model,
            { revision: contentPackage.draft.revision, contentHash: contentPackage.draft.content_hash, evidenceHash:contentPackage.evidence_hash });
          if (reviewed.output.passed && !job.dedupe_key?.startsWith("manual-stage:")) this.repository.enqueue("compose_commercial", job.entity_id);
          if (!reviewed.output.passed && !job.dedupe_key?.startsWith("manual-stage:")) {
            this.repository.automaticQualityRepairState(job.entity_id, reviewed.output.issues, { enqueue: true });
          }
          break;
        }
        case "revise_draft": {
          this.requireContentEngine();
          const contentPackage = this.repository.getDraftPackage(job.entity_id);
          if (!contentPackage) throw new Error(`Article draft ${job.entity_id} no longer exists.`);
          const drafted = await guarded((signal) => this.contentEngine.repairDraft(contentPackage, contentPackage.review?.issues || [], { signal, telemetryContext }));
          const contractAware = this.canComposeFrontendPage;
          const draftId = this.repository.saveDraft(contentPackage.draft.brief_id, drafted.output, drafted.model, { deferReview: contractAware || job.dedupe_key?.startsWith("manual-stage:") });
          if (!job.dedupe_key?.startsWith("manual-stage:")) {
            if (this.visuals?.enabled) this.repository.enqueue("generate_visuals", draftId);
            else if (contractAware) this.repository.enqueue("compose_frontend_page", draftId);
          }
          break;
        }
        case "compose_commercial": {
          if (!this.commercialComposer) throw new Error("Commercial Composer is not configured.");
          const contentPackage = this.repository.getDraftPackage(job.entity_id);
          if (!contentPackage?.review?.passed) throw new Error("Only a QA-passed Research Draft can enter the Commercial Layer.");
          const offers = this.repository.activeOffersForDestination(contentPackage.brief.destination_slug);
          const composition = this.commercialComposer.compose(contentPackage, offers);
          if (this.frontendContracts?.configured) {
            const capabilities = this.frontendContracts.commercialCapabilities(composition.requiredComponents);
            for (const componentId of capabilities.missing) this.repository.createFrontendCapabilityRequest({
              draftId: job.entity_id, briefId: contentPackage.brief?.id || null,
              semanticNeed: componentId, useCase: `Commercial overlay for ${contentPackage.draft?.title || job.entity_id}`,
              reason: `The Commercial Composer selected '${componentId}', but the active Frontend Contract does not publish that component. Contract-aware delivery remains blocked until the capability is available.`,
            });
          }
          this.repository.saveCommercialComposition(job.entity_id, composition);
          if (this.wordpress?.enabled) this.repository.enqueue(this.frontendContracts?.configured ? "compose_publish_page" : "push_wordpress_draft", job.entity_id);
          break;
        }
        case "compose_publish_page": {
          if (!this.wordpress?.enabled) throw new PublishCompositionError("WORDPRESS_UNCONFIGURED", "WordPress delivery must be configured before Publish Composition.");
          const contract = this.requireFrontendContract();
          let contentPackage = this.repository.getDraftPackage(job.entity_id);
          if (!contentPackage?.review?.passed) throw new PublishCompositionError("QA_NOT_PASSED", "Only a QA-passed Research Draft can enter Publish Composition.");
          if (!contentPackage.commercial_composition) throw new PublishCompositionError("COMMERCIAL_NOT_COMPLETE", "Commercial composition must complete before Publish Composition.");
          const editorialPage = contentPackage.frontend_page?.payload;
          if (!editorialPage) throw new PublishCompositionError("NO_VALID_FRONTEND_PAGE_PAYLOAD", "The validated editorial Frontend Page Payload is missing.");
          if (contentPackage.frontend_page.snapshot_id !== contract.id || contentPackage.frontend_page.contract_checksum !== contract.checksum) {
            this.repository.markFrontendPublishComposition(job.entity_id, "stale_contract");
            this.repository.markFrontendPageCompositionStale(job.entity_id);
            this.repository.enqueue("sync_frontend_contract", "default");
            throw new PublishCompositionError("CONTRACT_VERSION_MISMATCH", "Editorial Page Payload provenance does not match the active Frontend Contract.");
          }
          const editorialValidation = this.frontendContracts.validatePagePayload(editorialPage);
          if (!editorialValidation.valid) throw invalidPublishPage("EDITORIAL_PAGE_INVALID", editorialValidation);
          const finalPage = mergeCommercialOverlay(editorialPage, contentPackage.commercial_composition);
          const finalPageValidation = this.frontendContracts.validatePagePayload(finalPage);
          if (!finalPageValidation.valid) throw invalidPublishPage("FINAL_PAGE_INVALID", finalPageValidation);
          const finalArtifactValidation = validateFinalPageArtifact(finalPage, contentPackage);
          if (!finalArtifactValidation.valid) throw invalidPublishPage("FINAL_PAGE_QA_FAILED", finalArtifactValidation);
          await guarded((signal) => this.uploadVisualMedia(contentPackage, { signal, idempotencyKey: job.id, assertLease }));
          contentPackage = this.repository.getDraftPackage(job.entity_id);
          const mediaValidation = validateMediaDelivery(contentPackage.draft.visuals, { requireMetadata: true });
          if (!mediaValidation.valid) throw invalidPublishPage("MEDIA_DELIVERY_INVALID", mediaValidation);
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
          const validation = this.frontendContracts.validatePublishPackage(publishPackage);
          this.repository.saveFrontendPublishComposition(job.entity_id, contract, publishPackage, validation, contentPackage.commercial_composition.strategy_version);
          if (!validation.valid) throw invalidPublishPage("PUBLISH_PACKAGE_INVALID", validation);
          this.repository.enqueue("push_wordpress_draft", job.entity_id);
          break;
        }
        case "push_wordpress_draft": {
          if (!this.wordpress?.enabled) throw new Error("WordPress draft delivery is not configured.");
          const contentPackage = this.repository.getDraftPackage(job.entity_id);
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
          try {
            let result;
            if (this.frontendContracts?.configured) {
              const publishPackage = structuredClone(contentPackage.publish_composition.publish_package);
              publishPackage.publication.existing_post_id = publication.post_id || publishPackage.publication.existing_post_id || null;
              result = await guarded((signal) => this.wordpress.upsertContractDraft(publishPackage, { signal, idempotencyKey: job.id }));
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
              result = await guarded((signal) => this.wordpress.upsertDraft(publishableDraft, publication.post_id, { signal, idempotencyKey: job.id }));
            }
            this.repository.completeWordPressPublication(job.entity_id, result);
          } catch (error) {
            if (isJobLeaseLost(error)) throw error;
            this.repository.failWordPressPublication(job.entity_id, error);
            if (["CONTRACT_MISMATCH", "CONTRACT_VERSION_MISMATCH"].includes(error?.code)) {
              this.repository.markFrontendPublishComposition(job.entity_id, "stale_contract");
              this.repository.markFrontendPageCompositionStale(job.entity_id);
              this.repository.enqueue("sync_frontend_contract", "default");
            }
            throw error;
          }
          break;
        }
        default:
          throw new Error(`Unknown job type: ${job.type}`);
      }
      assertLease();
      if (!this.repository.completeJob(job.id, job.locked_by, job.lease_generation)) throw Object.assign(new Error("JOB_LEASE_LOST"), { code: "JOB_LEASE_LOST", retryable: false });
      this.repository.completePipelineArtifact?.(pipelineArtifact, job);
      this.recordExtractionOutcome(job, { ok: true });
      this.logger.info("pipeline.job_succeeded", { jobId: job.id, jobType: job.type, durationMs: Date.now() - startedAt });
      return true;
    } catch (error) {
      if (job) {
        if (isJobLeaseLost(error)) {
          this.logger.warn("pipeline.job_lease_lost", { jobId: job.id, jobType: job.type, entityId: job.entity_id });
        } else {
          this.repository.failPipelineArtifact?.(pipelineArtifact, error);
          this.recordExtractionOutcome(job, { ok: false, error });
          this.repository.failJob(job, error);
          this.logger.error("pipeline.job_failed", {
            jobId: job.id, jobType: job.type, entityId: job.entity_id, attempt: job.attempts,
            durationMs: startedAt ? Date.now() - startedAt : null, error,
          });
        }
      } else this.logger.error("pipeline.unhandled_error", { error });
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
    if (!this.contentEngine?.enabled) throw new Error("Content production requires a configured Kimi key or Vertex AI project.");
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

function invalidPublishPage(code, validation) {
  return new PublishCompositionError(code, validation.errors.map((item) => `${item.code}@${item.path}`).join(", "), { validation });
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
