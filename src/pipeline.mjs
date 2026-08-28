const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

export class Pipeline {
  constructor(repository, extractor, { pollMs = 750, contentEngine = null, visuals = null, wordpress = null, searchConsole = null, commercialComposer = null, contentConfig = {}, logger = silentLogger } = {}) {
    this.repository = repository;
    this.extractor = extractor;
    this.pollMs = pollMs;
    this.contentEngine = contentEngine;
    this.visuals = visuals;
    this.wordpress = wordpress;
    this.searchConsole = searchConsole;
    this.commercialComposer = commercialComposer;
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
          const candidates = this.repository.rebuildTopicCandidates(
            job.entity_id, this.contentConfig.minFacts, this.contentConfig.maxPerDestination,
          );
          if (this.contentEngine?.enabled) for (const candidate of candidates) this.repository.queueCandidate(candidate.id);
          break;
        }
        case "plan_content": {
          this.requireContentEngine();
          const contentPackage = this.repository.getTopicPackage(job.entity_id);
          if (!contentPackage) throw new Error(`Topic candidate ${job.entity_id} no longer exists.`);
          const planned = await this.contentEngine.plan(contentPackage);
          this.repository.saveBrief(job.entity_id, planned.output, planned.model);
          break;
        }
        case "generate_draft": {
          this.requireContentEngine();
          const contentPackage = this.repository.getBriefPackage(job.entity_id);
          if (!contentPackage) throw new Error(`Content brief ${job.entity_id} no longer exists.`);
          const drafted = await this.contentEngine.draft(contentPackage);
          const draftId = this.repository.saveDraft(job.entity_id, drafted.output, drafted.model);
          if (this.visuals?.enabled) this.repository.enqueue("generate_visuals", draftId);
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
          const draftId = this.repository.saveDraft(contentPackage.draft.brief_id, drafted.output, drafted.model);
          if (this.visuals?.enabled) this.repository.enqueue("generate_visuals", draftId);
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
          const publication = this.repository.prepareWordPressPublication(job.entity_id, this.wordpress.config.siteUrl);
          try {
            const publishableDraft = {
              ...contentPackage.draft,
              body_markdown: contentPackage.commercial_composition.publishable_body_markdown,
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
    if (!this.contentEngine?.enabled) throw new Error("Content production requires KIMI_API_KEY.");
  }
}
