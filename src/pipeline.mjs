import { markdownToContentBlocks } from "./content-blocks.mjs";

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

export class Pipeline {
  constructor(repository, extractor, { pollMs = 750, contentEngine = null, visuals = null, wordpress = null, searchConsole = null, commercialComposer = null, frontendContracts = null, contentConfig = {}, logger = silentLogger } = {}) {
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
    this.working = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.runOne().catch((error) => this.logger.error("pipeline.tick_failed", { error })), this.pollMs);
    this.timer.unref();
    void this.runOne();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOne() {
    if (this.working) return false;
    this.working = true;
    let job;
    let startedAt;
    try {
      job = this.repository.claimJob();
      if (!job) return false;
      startedAt = Date.now();
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
          const source = this.repository.getSource(job.entity_id);
          if (!source) throw new Error(`Source ${job.entity_id} no longer exists.`);
          const extraction = await this.extractor.extract(source);
          this.repository.saveExtraction(source.id, extraction.result, extraction.method, extraction.model);
          if (this.contentEngine?.enabled && extraction.method !== "heuristic") this.repository.enqueue("analyze_intake", source.id);
          break;
        }
        case "resolve_entities": {
          const entityPackage = this.repository.getEntityResolutionPackage(job.entity_id);
          if (this.contentEngine?.enabled && typeof this.contentEngine.resolveEntities === "function" && entityPackage.claims.length) {
            const resolved = await this.contentEngine.resolveEntities(entityPackage);
            this.repository.applyEntityResolution(job.entity_id, resolved.output, resolved.model);
          } else {
            this.repository.resolveEntitiesDeterministically(job.entity_id);
          }
          this.repository.enqueue("rebuild_knowledge", job.entity_id);
          break;
        }
        case "rebuild_knowledge":
          this.repository.rebuildKnowledge(job.entity_id);
          this.repository.enqueue("rebuild_topics", job.entity_id);
          break;
        case "rebuild_editorial":
          this.repository.rebuildEditorialLibrary();
          break;
        case "rebuild_topics": {
          this.repository.rebuildTopicCandidates(
            job.entity_id, this.contentConfig.minFacts, this.contentConfig.maxPerDestination,
          );
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
              this.repository.failVisual(visual.id, error);
              throw error;
            }
          }
          if (this.canComposeFrontendPage) this.repository.enqueue("compose_frontend_page", job.entity_id);
          break;
        }
        case "compose_frontend_page": {
          this.requireContentEngine();
          const contract = this.requireFrontendContract();
          const contentPackage = this.repository.getDraftPackage(job.entity_id);
          if (!contentPackage) throw new Error(`Article draft ${job.entity_id} no longer exists.`);
          const capabilities = this.frontendContracts.resolveForArticle({ canonical: contentPackage.brief?.canonical || {}, draft: contentPackage.draft || {} });
          if (!capabilities.components.length) {
            this.repository.createFrontendCapabilityRequest({ draftId: job.entity_id, briefId: contentPackage.brief?.id || null, semanticNeed: "article-page-payload", useCase: contentPackage.draft?.title || "Article draft", reason: "The active Frontend Contract exposes no stable components for the final page payload." });
            throw new Error("MISSING_FRONTEND_CAPABILITY: no stable Frontend component can express this page.");
          }
          const composed = await this.contentEngine.composeFrontendPage(contentPackage, capabilities, contract.pageSchema.schema);
          const validation = this.frontendContracts.validatePagePayload(composed.output);
          this.repository.saveFrontendPageComposition(job.entity_id, contentPackage.frontend_page_plan?.id || null, contract, composed.output, validation, composed.model);
          if (!validation.valid) throw new Error(`Frontend page payload is invalid: ${validation.errors.map((item) => item.code).join(", ")}`);
          this.repository.enqueue("review_draft", job.entity_id);
          break;
        }
        case "review_draft": {
          this.requireContentEngine();
          const contentPackage = this.repository.getDraftPackage(job.entity_id);
          if (!contentPackage) throw new Error(`Article draft ${job.entity_id} no longer exists.`);
          const reviewed = await this.contentEngine.review(contentPackage);
          const revision = this.repository.saveReview(job.entity_id, reviewed.output, reviewed.model);
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
          this.repository.saveCommercialComposition(job.entity_id, composition);
          if (this.wordpress?.enabled) this.repository.enqueue("push_wordpress_draft", job.entity_id);
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
            const page = contentPackage.frontend_page?.payload;
            if (!page) throw new Error("NO_VALID_FRONTEND_PAGE_PAYLOAD: configured Frontend Contract requires a validated page payload before publishing.");
            const validation = this.frontendContracts.validatePagePayload(page);
            if (!validation.valid) throw new Error(`FRONTEND_PAGE_VALIDATION_FAILED: ${validation.errors.map((item) => item.code).join(", ")}`);
            if (contentPackage.frontend_page?.contract_checksum !== contract.checksum) {
              throw new Error("FRONTEND_CONTRACT_PROVENANCE_MISMATCH: page payload was not generated from the active Frontend Contract.");
            }
          }
          const publication = this.repository.prepareWordPressPublication(job.entity_id, this.wordpress.config.siteUrl);
          try {
            const publishableDraft = {
              ...contentPackage.draft,
              body_markdown: contentPackage.commercial_composition.publishable_body_markdown,
              content_blocks: markdownToContentBlocks(contentPackage.commercial_composition.publishable_body_markdown),
            };
            const result = await this.wordpress.upsertDraft(publishableDraft, publication.post_id);
            this.repository.completeWordPressPublication(job.entity_id, result);
          } catch (error) {
            this.repository.failWordPressPublication(job.entity_id, error);
            throw error;
          }
          break;
        }
        default:
          throw new Error(`Unknown job type: ${job.type}`);
      }
      this.repository.completeJob(job.id);
      this.logger.info("pipeline.job_succeeded", { jobId: job.id, jobType: job.type, durationMs: Date.now() - startedAt });
      return true;
    } catch (error) {
      if (job) {
        this.repository.failJob(job, error);
        this.logger.error("pipeline.job_failed", {
          jobId: job.id, jobType: job.type, entityId: job.entity_id, attempt: job.attempts,
          durationMs: startedAt ? Date.now() - startedAt : null, error,
        });
      } else this.logger.error("pipeline.unhandled_error", { error });
      return false;
    } finally {
      this.working = false;
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
}
