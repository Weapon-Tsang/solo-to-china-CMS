import { markdownToContentBlocks } from "./content-blocks.mjs";
import { buildPublishPackage, mediaReferences, mergeCommercialOverlay, PublishCompositionError, validateFinalPageArtifact } from "./publish-page.mjs";
import { isAiJobType, isProviderPressure } from "./job-policy.mjs";

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

export class Pipeline {
  constructor(repository, extractor, { pollMs = 750, maxConcurrent = null, extractionConfig = {}, contentEngine = null, visuals = null, wordpress = null, searchConsole = null, commercialComposer = null, frontendContracts = null, contentConfig = {}, logger = silentLogger } = {}) {
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
  }

  start() {
    if (this.timer) return;
    const recovered = this.repository.recoverExpiredJobs?.() || 0;
    if (recovered) this.logger.warn("pipeline.expired_jobs_recovered", { count: recovered });
    const recoveredBatches = this.repository.recoverPreparingVertexBatches?.() || 0;
    if (recoveredBatches) this.logger.warn("pipeline.vertex_batch_preparation_recovered", { count: recoveredBatches });
    this.timer = setInterval(() => this.pump(), this.pollMs);
    this.timer.unref();
    this.pump();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  pump() {
    void this.pumpVertexBatch().catch((error) => this.logger.error("pipeline.vertex_batch_tick_failed", { error }));
    const slots = Math.max(0, this.maxConcurrent - this.working);
    for (let index = 0; index < slots; index += 1) {
      void this.runOne().catch((error) => this.logger.error("pipeline.tick_failed", { error }));
    }
  }

  async pumpVertexBatch() {
    if (this.batchWorking || !this.extractor?.batchEnabled) return false;
    this.batchWorking = true;
    try {
      const due = this.repository.dueVertexBatch?.();
      if (due) return await this.pollVertexBatch(due);
      if (this.repository.activeVertexBatchCount?.()) return false;
      const minimum = Math.max(1, Number(this.extractor.config?.batchMinimumRequests || 20));
      const maximum = Math.max(minimum, Number(this.extractor.config?.batchMaximumRequests || 1_000));
      const run = this.repository.reserveVertexBatchJobs?.({ minimum, maximum, model: this.extractor.config?.model || "", location: this.extractor.config?.location || "global" });
      if (!run) return false;
      const prepared = [];
      const maximumInputBytes = Math.max(1_048_576, Number(this.extractor.config?.batchMaxInputBytes || 128 * 1024 * 1024));
      let preparedBytes = 0;
      let inputFull = false;
      for (const item of run.items) {
        try {
          if (inputFull) throw new Error("Deferred to the next Vertex Batch because the current JSONL input reached its safe memory limit.");
          let request;
          if (item.type === "audit_segment_coverage") {
            const pack = this.repository.getSegmentCoveragePackage(item.segment_id);
            if (!pack || pack.staleCaptureVersion) throw new Error("Source segment changed before Vertex Batch coverage audit submission.");
            if (pack.expectedModality !== "text") throw new Error("Image and video coverage checks remain on the local completion path.");
            request = await this.extractor.prepareBatchCoverage(pack, item.batch_item_id);
          } else {
            const pack = this.repository.getSegmentExtractionPackage(item.segment_id);
            if (!pack || pack.staleCaptureVersion) throw new Error("Source segment changed before Vertex Batch submission.");
            request = await this.extractor.prepareBatchExtraction(pack.source, item.batch_item_id);
          }
          const requestBytes = Buffer.byteLength(JSON.stringify({ request: request.request })) + 1;
          if (preparedBytes + requestBytes > maximumInputBytes) {
            if (prepared.length) inputFull = true;
            throw new Error(prepared.length
              ? "Deferred to the next Vertex Batch because the current JSONL input reached its safe memory limit."
              : "This segment is too large for the configured Vertex Batch input and was returned to the realtime queue.");
          }
          prepared.push(request);
          preparedBytes += requestBytes;
        } catch (error) {
          this.repository.releaseVertexBatchItem(run.id, item.id, error);
          this.logger.warn("pipeline.vertex_batch_item_prepare_failed", { runId: run.id, jobId: item.id, error });
        }
      }
      if (!prepared.length) {
        this.repository.finishVertexBatch(run.id, "failed", "PREPARATION_FAILED", "No extraction request could be prepared.");
        return false;
      }
      try {
        const batch = await this.extractor.createExtractionBatch(prepared, { operation: run.jobType || "extract_segment_claims" });
        this.repository.activateVertexBatch(run.id, batch);
        this.logger.info("pipeline.vertex_batch_submitted", { runId: run.id, jobType: run.jobType,
          providerJobName: batch.name, itemCount: prepared.length, inputBytes: preparedBytes });
        return true;
      } catch (error) {
        for (const item of run.items) this.repository.releaseVertexBatchItem(run.id, item.id, error);
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
      batch = await this.extractor.getExtractionBatch(run.provider_job_name);
    } catch (error) {
      this.repository.deferVertexBatchPoll(run.id, "POLL_FAILED", Number(this.extractor.config?.batchPollMs || 60_000));
      throw error;
    }
    const state = String(batch.state || "JOB_STATE_UNSPECIFIED");
    const terminal = new Set(["JOB_STATE_SUCCEEDED", "JOB_STATE_FAILED", "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED", "JOB_STATE_PARTIALLY_SUCCEEDED"]);
    if (!terminal.has(state)) {
      this.repository.deferVertexBatchPoll(run.id, state, Number(this.extractor.config?.batchPollMs || 60_000));
      return false;
    }
    let outputs = [];
    try { outputs = await this.extractor.readExtractionBatch({ ...run, ...batch }); }
    catch (error) { this.logger.error("pipeline.vertex_batch_output_read_failed", { runId: run.id, error }); }
    const byId = new Map(outputs.filter((item) => item.id).map((item) => [item.id, item]));
    for (const item of run.items) {
      const output = byId.get(item.batch_item_id);
      try {
        if (!output) throw new Error(`Vertex Batch ${state} returned no output for this segment.`);
        if (item.job_type === "audit_segment_coverage") {
          const assessment = this.extractor.parseBatchCoverage(output);
          this.repository.completeVertexBatchCoverageItem(run, item, assessment);
        } else {
          const extraction = this.extractor.parseBatchExtraction(output);
          this.repository.completeVertexBatchItem(run, item, extraction);
        }
      } catch (error) {
        this.repository.releaseVertexBatchItem(run.id, item.job_id, error);
      }
    }
    const finalStatus = state === "JOB_STATE_SUCCEEDED" || state === "JOB_STATE_PARTIALLY_SUCCEEDED" ? "succeeded"
      : state === "JOB_STATE_CANCELLED" ? "cancelled" : state === "JOB_STATE_EXPIRED" ? "expired" : "failed";
    this.repository.finishVertexBatch(run.id, finalStatus, state, batch?.error?.message || "");
    await this.extractor.cleanupExtractionBatch({ ...run, ...batch }).catch((error) => this.logger.warn("pipeline.vertex_batch_cleanup_failed", { runId: run.id, error }));
    this.logger.info("pipeline.vertex_batch_completed", { runId: run.id, providerState: state, outputCount: outputs.length });
    return true;
  }

  async runOne() {
    if (this.working >= this.maxConcurrent) return false;
    this.working += 1;
    let job;
    let startedAt;
    let heartbeatTimer;
    try {
      const minimum = Math.max(1, Number(this.extractor?.config?.batchMinimumRequests || 20));
      const deferBatchExtraction = Boolean(this.extractor?.batchEnabled
        && this.repository.countVertexBatchEligibleJobs?.() >= minimum);
      const deferBatchCoverage = Boolean(this.extractor?.batchEnabled
        && this.repository.countVertexBatchEligibleJobs?.("audit_segment_coverage") >= minimum);
      job = this.repository.claimJob({ deferBatchExtraction, deferBatchCoverage });
      if (!job) return false;
      startedAt = Date.now();
      heartbeatTimer = setInterval(() => {
        if (!this.repository.heartbeatJob?.(job.id, job.locked_by)) {
          this.logger.error("pipeline.job_lease_lost", { jobId: job.id, workerId: job.locked_by });
        }
      }, Math.max(10_000, Math.floor((this.repository.jobLeaseMs || 60_000) / 3)));
      heartbeatTimer.unref();
      this.logger.info("pipeline.job_started", { jobId: job.id, jobType: job.type, entityId: job.entity_id, attempt: job.attempts });
      switch (job.type) {
        case "sync_frontend_contract":
          if (!this.frontendContracts?.configured) throw new Error("FRONTEND_CONTRACT_UNCONFIGURED: Frontend Contract sources are not configured.");
          await this.frontendContracts.sync();
          break;
        case "sync_wordpress_inventory": {
          if (!this.wordpress?.enabled) throw new Error("WordPress inventory sync is not configured.");
          this.repository.startWordPressInventorySync(this.wordpress.config.siteUrl);
          try {
            const items = await this.wordpress.listContentInventory();
            this.repository.replaceWordPressInventory(this.wordpress.config.siteUrl, items);
          } catch (error) {
            this.repository.failWordPressInventorySync(this.wordpress.config.siteUrl, error);
            throw error;
          }
          break;
        }
        case "sync_search_console": {
          if (!this.searchConsole?.enabled) throw new Error("Search Console sync is not configured.");
          this.repository.startSearchConsoleSync(this.searchConsole.config.siteUrl);
          try {
            const inventory = await this.searchConsole.listQueryInventory();
            this.repository.replaceSearchConsoleInventory(this.searchConsole.config.siteUrl, inventory);
          } catch (error) {
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
            const extraction = await this.extractor.extract(pack.source);
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
            ? await this.extractor.auditCoverage(coveragePackage)
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
          const retryExtraction = await this.extractor.extract(pack.source);
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
            ? await this.extractor.auditCoverage(retriedPackage)
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
          const analyzed = await this.extractor.analyzeBlueprint(source);
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
          const analyzed = await this.contentEngine.analyzeIntake(intakePackage);
          this.repository.saveIntakeAnalysis(job.entity_id, analyzed.output, analyzed.model);
          break;
        }
        case "resolve_entities": {
          const entityPackage = this.repository.getEntityResolutionPackage(job.entity_id);
          if (this.contentEngine?.enabled && typeof this.contentEngine.resolveEntities === "function" && entityPackage.claims.length) {
            try {
              const resolved = await this.contentEngine.resolveEntities(entityPackage);
              this.repository.applyEntityResolution(job.entity_id, resolved.output, resolved.model);
            } catch (error) {
              if (!isRecoverableStructuredOutputError(error)) throw error;
              this.logger.warn("pipeline.entity_resolution_model_output_invalid", {
                jobId: job.id, entityId: job.entity_id, error,
              });
              this.repository.resolveEntitiesDeterministically(job.entity_id);
            }
          } else {
            this.repository.resolveEntitiesDeterministically(job.entity_id);
          }
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
          // this stage refreshes readiness without manufacturing candidates.
          this.repository.rebuildCoverageMatrices(job.entity_id);
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
          const analyzed = await this.contentEngine.analyzeIntake(intakePackage);
          this.repository.saveIntakeAnalysis(job.entity_id, analyzed.output, analyzed.model);
          break;
        }
        case "plan_content": {
          this.requireContentEngine();
          const contentPackage = this.repository.getTopicPackage(job.entity_id);
          if (!contentPackage) throw new Error(`Topic candidate ${job.entity_id} no longer exists.`);
          const planned = await this.contentEngine.plan(contentPackage);
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
          const composed = await this.contentEngine.composePagePlan(contentPackage, capabilities);
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
          const drafted = await this.contentEngine.draft(contentPackage);
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
              const result = await this.visuals.generate(visual, contentPackage.draft);
              this.repository.saveGeneratedVisual(visual.id, result);
            } catch (error) {
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
          await this.uploadVisualMedia(contentPackage);
          contentPackage = this.repository.getDraftPackage(job.entity_id);
          const capabilities = this.frontendContracts.resolveForArticle({ canonical: contentPackage.brief?.canonical || {}, draft: contentPackage.draft || {} });
          if (!capabilities.components.length) {
            this.repository.createFrontendCapabilityRequest({ draftId: job.entity_id, briefId: contentPackage.brief?.id || null, semanticNeed: "article-page-payload", useCase: contentPackage.draft?.title || "Article draft", reason: "The active Frontend Contract exposes no stable components for the final page payload." });
            throw new Error("MISSING_FRONTEND_CAPABILITY: no stable Frontend component can express this page.");
          }
          const composed = await this.contentEngine.composeFrontendPage(contentPackage, capabilities, contract.pageSchema.schema);
          const validation = this.frontendContracts.validatePagePayload(composed.output);
          this.repository.saveFrontendPageComposition(job.entity_id, contentPackage.frontend_page_plan?.id || null, contract, composed.output, validation, composed.model,
            { revision: contentPackage.draft.revision, contentHash: contentPackage.draft.content_hash });
          if (!validation.valid) throw new Error(`Frontend page payload is invalid: ${validation.errors.map((item) => item.code).join(", ")}`);
          this.repository.enqueue("review_draft", job.entity_id);
          break;
        }
        case "review_draft": {
          this.requireContentEngine();
          const contentPackage = this.repository.getDraftPackage(job.entity_id);
          if (!contentPackage) throw new Error(`Article draft ${job.entity_id} no longer exists.`);
          const reviewed = await this.contentEngine.review(contentPackage);
          const revision = this.repository.saveReview(job.entity_id, reviewed.output, reviewed.model,
            { revision: contentPackage.draft.revision, contentHash: contentPackage.draft.content_hash });
          if (reviewed.output.passed) this.repository.enqueue("compose_commercial", job.entity_id);
          if (!reviewed.output.passed && revision < 2) this.repository.enqueue("revise_draft", job.entity_id);
          break;
        }
        case "revise_draft": {
          this.requireContentEngine();
          const contentPackage = this.repository.getDraftPackage(job.entity_id);
          if (!contentPackage) throw new Error(`Article draft ${job.entity_id} no longer exists.`);
          const drafted = await this.contentEngine.draft(contentPackage, contentPackage.review?.issues || []);
          const contractAware = this.canComposeFrontendPage;
          const draftId = this.repository.saveDraft(contentPackage.draft.brief_id, drafted.output, drafted.model, { deferReview: contractAware });
          if (this.visuals?.enabled) this.repository.enqueue("generate_visuals", draftId);
          else if (contractAware) this.repository.enqueue("compose_frontend_page", draftId);
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
          await this.uploadVisualMedia(contentPackage);
          contentPackage = this.repository.getDraftPackage(job.entity_id);
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
              result = await this.wordpress.upsertContractDraft(publishPackage);
            } else {
              const publishableDraft = {
                ...contentPackage.draft,
                body_markdown: contentPackage.commercial_composition.publishable_body_markdown,
                content_blocks: contentPackage.commercial_composition.content_blocks?.length
                  ? contentPackage.commercial_composition.content_blocks
                  : markdownToContentBlocks(contentPackage.commercial_composition.publishable_body_markdown),
              };
              result = await this.wordpress.upsertDraft(publishableDraft, publication.post_id);
            }
            this.repository.completeWordPressPublication(job.entity_id, result);
          } catch (error) {
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
      if (!this.repository.completeJob(job.id, job.locked_by)) throw Object.assign(new Error("JOB_LEASE_LOST"), { retryable: false });
      this.recordExtractionOutcome(job, { ok: true });
      this.logger.info("pipeline.job_succeeded", { jobId: job.id, jobType: job.type, durationMs: Date.now() - startedAt });
      return true;
    } catch (error) {
      if (job) {
        this.recordExtractionOutcome(job, { ok: false, error });
        this.repository.failJob(job, error);
        this.logger.error("pipeline.job_failed", {
          jobId: job.id, jobType: job.type, entityId: job.entity_id, attempt: job.attempts,
          durationMs: startedAt ? Date.now() - startedAt : null, error,
        });
      } else this.logger.error("pipeline.unhandled_error", { error });
      return false;
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
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

  async uploadVisualMedia(contentPackage) {
    if (!this.wordpress?.enabled || typeof this.wordpress.resolveVisualMedia !== "function") return [];
    const persisted = new Set();
    const uploaded = await this.wordpress.resolveVisualMedia(contentPackage.draft?.visuals || [], (visual) => {
      this.repository.saveWordPressVisual(visual.visualId, visual);
      persisted.add(visual.visualId);
    });
    for (const visual of uploaded) {
      if (!persisted.has(visual.visualId)) this.repository.saveWordPressVisual(visual.visualId, visual);
    }
    return uploaded;
  }
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
