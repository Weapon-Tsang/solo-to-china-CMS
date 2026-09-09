import assert from "node:assert/strict";
import test from "node:test";
import { normalizeXiaohongshuCapture } from "../src/adapters/xiaohongshu.mjs";
import { Pipeline } from "../src/pipeline.mjs";
import { CONTENT_STRATEGY } from "../src/content-strategy.mjs";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";
import { CommercialComposer, normalizeCommercialOffer } from "../src/commercial.mjs";
import { FrontendContractConsumer } from "../src/frontend-contract.mjs";
import { defaultComponents, frontendContractFixture } from "../test-support/frontend-contract-fixture.mjs";
import { pageBlockSignature } from "../src/repository.mjs";

test("human approval drives recommendation, brief, draft, QA, and WordPress draft delivery", async (t) => {
  const { db, repository } = repositoryFixture(t);
  const commercialComponent = {
    id: "affiliate_booking_card", category: "commercial", purpose: "Approved affiliate booking resource.", status: "stable", variants: ["default"],
    schema: { type: "object", additionalProperties: false,
      required: ["affiliate_asset_id", "provider", "asset_type", "product_category", "title", "description", "cta_label", "target_url", "disclosure", "scope_type", "scope_key", "slot_key", "placement", "strategy_version"],
      properties: Object.fromEntries(["affiliate_asset_id", "provider", "asset_type", "product_category", "title", "description", "cta_label", "target_url", "disclosure", "scope_type", "scope_key", "slot_key", "placement", "strategy_version", "price_text", "entity", "route", "destination", "anchor"].map((key) => [key, { type: "string" }])) },
  };
  const contractFixture = frontendContractFixture(t, { components: [...defaultComponents(), commercialComponent] });
  const frontendContracts = new FrontendContractConsumer(repository, {
    sourceRepository: "https://github.com/example/solo-to-china",
    registrySource: contractFixture.registryPath,
    pageSchemaSource: contractFixture.pageSchemaPath,
  });
  await frontendContracts.sync();
  const sourceExtractor = {
    async extract(source) {
      return {
        method: "test_multimodal", model: "source-model",
        inputManifest: source.assets?.length ? {
          version: 1, expectedModality: source.assets[0].kind === "video" ? "video" : "image",
          receivedModality: source.assets[0].kind === "video" ? "video" : "image",
          provider: "test", model: "source-model",
          capabilities: { text: true, image: true, video: true, batch: false },
          assets: source.assets.map((asset, index) => ({
            assetId: asset.id, kind: asset.kind === "video" ? "video" : "image", status: "submitted",
            requestReference: `test-part-${index}`,
          })),
        } : {
          version: 1, expectedModality: "text", receivedModality: "text",
          provider: "test", model: "source-model",
          capabilities: { text: true, image: true, video: true, batch: false }, assets: [],
        },
        result: {
          source: { language: "zh-CN", summary: "Research", destination_name: "Beijing", destination_slug: "beijing", traveler_fit: ["solo"], practical_tips: [], warnings: [], confidence: 0.9 },
          claims: [
            ["beijing.orientation.location", "Beijing orientation", "location", "Central Beijing"],
            ["beijing.transport.metro", "Beijing transport", "metro transport", "Use the metro"],
            ["beijing.booking.reservation", "Beijing booking", "reservation booking", "Reserve timed attractions"],
            ["beijing.payment.methods", "Beijing payment", "payment methods", "Carry a working mobile payment method"],
            ["beijing.cost.budget", "Beijing budget", "cost budget", "Plan admission and transit costs"],
          ].map(([key, subject, predicate, value]) => ({ key, subject, predicate, value,
            qualifiers: [], confidence: 0.85, source_quote: value })),
          blueprint: { format: "guide", hook: "First trip", angle: "solo first visit", sections: [], strengths: ["specific"], gaps: [] },
        },
      };
    },
  };
  const contentEngine = {
    enabled: true,
    async analyzeIntake() {
      return { model: "intake-model", output: {
        classification: "ARTICLE_CANDIDATE", production_mode: "TOPIC_FEATURE",
        production_modes: ["TOPIC_FEATURE", "SOURCE_ADAPTATION", "MULTI_SOURCE_SYNTHESIS"],
        production_paths: [
          { mode: "TOPIC_FEATURE", content_type: "first_time_guide", title: "First-Time Beijing Solo Travel Guide", reader_promise: "Plan a bounded first visit", why_it_works: "The source contains practical planning evidence.", evidence_boundary: "Use the scoped facts only." },
          { mode: "SOURCE_ADAPTATION", content_type: "itinerary", title: "Source A's Beijing Route", reader_promise: "Follow this author's route", why_it_works: "The authorized source contains a coherent route.", evidence_boundary: "Use this source only." },
          { mode: "MULTI_SOURCE_SYNTHESIS", content_type: "comparison", title: "Two Ways to Plan a Beijing First Visit", reader_promise: "Compare compatible approaches", why_it_works: "Two independent sources support useful alternatives.", evidence_boundary: "Use compatible destination facts." },
        ],
        confidence: 0.9, primary_topic: "First-Time Beijing", entities: ["Beijing"],
        knowledge_points: ["Practical planning evidence"], claims: ["beijing.orientation.location"], article_potential: 88,
        information_density: 82, topic_completeness: 76, duplicate_likelihood: 5, recommended_action: "CREATE_CONTENT_PLAN",
        suggested_content_type: "first_time_guide", suggested_article_title: "First-Time Beijing Solo Travel Guide",
        missing_information: [], possible_cluster_topics: [], reasoning_summary: "Evidence supports a human-reviewed article opportunity.",
      } };
    },
    async plan() {
      return { model: "planner-model", output: {
        title: "First-Time Beijing Solo Travel Guide", primary_keyword: "beijing solo travel", search_intent: "informational",
        audience: ["solo travelers"], angle: "first visit", reader_promise: "Plan with confidence",
        outline: [{ section_id: "section_plan", heading: "Plan", purpose: "Practical steps", claim_keys: ["beijing.orientation.location", "beijing.transport.metro"] }],
        adaptation_requirements: ["language"], conflict_instructions: [],
      } };
    },
    async draft(contentPackage) {
      const sourceIds = [...new Set(contentPackage.facts
        .filter((fact) => ["beijing.orientation.location", "beijing.transport.metro"].includes(fact.normalized_key))
        .flatMap((fact) => fact.evidence.map((evidence) => evidence.source_id)))];
      return { model: "writer-model", output: {
        title: "First-Time Beijing Solo Travel Guide", slug: "beijing-solo-guide", meta_description: "A practical first-time Beijing guide.",
        body_markdown: "## Plan\n\nCentral Beijing is the orientation point. Use the metro; this transport evidence was checked on September 7, 2026.",
        evidence_ledger: [{ section_id: "section_plan", section: "Plan", content_node_ids: ["node_plan"], claim_keys: ["beijing.orientation.location", "beijing.transport.metro"], source_ids: sourceIds }],
        unresolved_conflicts: [],
        visuals: [
          { placement: "hero", purpose: "Show Source A real-world travel scene", alt_text: "Source A real-world travel scene", caption: "Beijing orientation", generation_prompt: "", aspect_ratio: "16:9", image_type: "real_world_photo", image_role: "hero", image_subject: "Source A real-world travel scene", factual_image_required: true },
          { placement: "mid_article", purpose: "Explain planning", alt_text: "Beijing trip planning illustration", caption: "Planning overview", generation_prompt: "Editorial illustration of Beijing trip planning, no text or logos", aspect_ratio: "3:2", image_type: "illustration", image_role: "support", image_subject: "Beijing planning", factual_image_required: false },
        ],
      } };
    },
    async composePagePlan() {
      return { model: "composer-model", output: {
        blocks: [{ content_node_id: "node_plan", source_section_ids: ["section_plan"], claim_keys: ["beijing.orientation.location", "beijing.transport.metro"], factuality: "factual", type: "articleSection", variant: "answer-first", semantic_role: "answer", writer_guidance: "Start with the practical evidence-backed answer." }],
      } };
    },
    async composeFrontendPage() {
      const block = { type: "articleSection", variant: "answer-first", data: { heading: "Plan", body: "Central Beijing is the orientation point. Use the metro; this transport evidence was checked on September 7, 2026." } };
      return { model: "payload-composer-model", output: {
        metadata: { title: "First-Time Beijing Solo Travel Guide" },
        blocks: [block],
      }, provenance: { version: "2", valid: true, errors: [], entries: [{ contentNodeId: "node_plan",
        blockSignature: pageBlockSignature(block), sourceSectionIds: ["section_plan"],
        claimKeys: ["beijing.orientation.location", "beijing.transport.metro"], factuality: "factual" }] } };
    },
    async review() {
      return { model: "reviewer-model", output: { passed: true, score: 92, checks: [], issues: [], unsupported_claims: [] } };
    },
  };
  const wordpress = {
    enabled: true,
    config: { siteUrl: "https://example.test" },
    calls: [],
    async upsertContractDraft(publishPackage) {
      this.calls.push({ publishPackage });
      return { postId: 42, postUrl: "https://example.test/?p=42", previewUrl: "https://example.test/?p=42&preview=true", status: "draft" };
    },
  };
  const pipeline = new Pipeline(repository, sourceExtractor, {
    contentEngine, wordpress,
    commercialComposer: new CommercialComposer({ maxOffersPerDraft: 3, disclosure: "Affiliate disclosure." }),
    frontendContracts,
    contentConfig: { minFacts: 5, maxPerDestination: 1 },
  });

  for (const [externalId, title] of [["autoA", "Source A"], ["autoB", "Source B"]]) {
    repository.saveCapture(normalizeXiaohongshuCapture({
      url: `https://www.xiaohongshu.com/explore/${externalId}`, title,
      text: externalId === "autoA"
        ? "Beijing orientation: Central Beijing. Use the metro. Reserve timed attractions. Carry a working mobile payment method. Plan admission and transit costs."
        : "Beijing booking: Central Beijing. Use the metro. Reserve timed attractions. Carry a working mobile payment method. Plan admission and transit costs. Passport checks, museum entry, ticket windows, weekend crowds, airport arrival, luggage storage, hotel check-in, translation, local etiquette, and emergency contacts are reviewed independently.",
      images: [{ url: `https://ci.xhscdn.com/${externalId}.jpg`, alt: `${title} real-world travel scene` }],
    }));
  }
  db.prepare("UPDATE sources SET authority_level=1, verified_at='2026-09-07T00:00:00.000Z'").run();
  repository.upsertCommercialOffer(normalizeCommercialOffer({
    provider: "Trip.com", externalId: "hotel-search-beijing", category: "hotels", destinationSlug: "beijing",
    title: "Browse Beijing hotels", targetUrl: "https://www.trip.com/hotels/?city=beijing",
    ctaLabel: "Check hotel options", description: "Compare available stays for your dates.", priority: 10,
  }));

  for (let index = 0; index < 60; index += 1) await pipeline.runOne();
  assert.equal(repository.listContent().length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM topic_candidates").get().count, 0);
  const dashboardBeforeApproval = repository.dashboard();
  const pendingRecommendationCount = dashboardBeforeApproval.actionCounts.recommendations;
  assert.ok(pendingRecommendationCount > 0);
  assert.equal(dashboardBeforeApproval.totals.contentPipelineItems, 0);
  const recommendation = repository.listContentRecommendations()[0];
  assert.equal(recommendation.strategy_version, CONTENT_STRATEGY.version);
  assert.equal(recommendation.production_paths.length, 3);
  assert.ok(recommendation.production_paths.every((path) => path.opportunity_id));
  assert.ok(repository.listContentOpportunities().length >= 6);
  const adaptationPath = recommendation.production_paths.find((path) => path.mode === "SOURCE_ADAPTATION");
  const approval = repository.decideRecommendation(recommendation.id, "approved_article", "", { opportunityId: adaptationPath.opportunity_id });
  assert.equal(approval.opportunityId, adaptationPath.opportunity_id);
  const dashboardAfterApproval = repository.dashboard();
  assert.equal(dashboardAfterApproval.actionCounts.recommendations, pendingRecommendationCount - 1);
  assert.equal(dashboardAfterApproval.totals.pendingRecommendations, pendingRecommendationCount - 1);
  assert.equal(dashboardAfterApproval.totals.contentPipelineItems, 1, JSON.stringify(approval));
  assert.equal(approval.queued, true, JSON.stringify(approval));
  for (let index = 0; index < 60; index += 1) await pipeline.runOne();

  const content = repository.listContent();
  assert.equal(content.length, 1);
  assert.equal(content[0].draft_status, "wordpress_draft", JSON.stringify(repository.listOperationalExceptions()));
  assert.equal(content[0].qa_passed, 1);
  assert.equal(content[0].wordpress_post_id, 42);
  assert.equal(wordpress.calls.length, 1);
  assert.equal(wordpress.calls[0].publishPackage.page.blocks[0].type, "articleSection");
  assert.equal(wordpress.calls[0].publishPackage.page.blocks[1].type, "affiliate_booking_card");
  assert.equal(wordpress.calls[0].publishPackage.page.blocks[1].data.disclosure, "Affiliate disclosure.");
  const generatedPackage = repository.getDraftPackage(content[0].draft_id);
  const researchDraft = generatedPackage.draft.body_markdown;
  assert.doesNotMatch(researchDraft, /Trip\.com|Optional booking resources/);
  assert.equal(generatedPackage.draft.visuals.length, 2);
  assert.equal(generatedPackage.draft.visuals[0].acquisition_strategy, "use_authorized_source_image");
  assert.equal(generatedPackage.draft.visuals[0].status, "generated");
  assert.ok(generatedPackage.draft.visuals[0].source_asset_id);
  assert.match(generatedPackage.draft.visuals[0].source_remote_url, /xhscdn\.com/);
  assert.equal(generatedPackage.draft.schema_jsonld["@context"], "https://schema.org");
  assert.equal(generatedPackage.draft.strategy_version, CONTENT_STRATEGY.version);
  assert.equal(generatedPackage.frontend_page_plan.plan.blocks[0].type, "articleSection");
  assert.equal(generatedPackage.frontend_page.payload.blocks[0].type, "articleSection");
  assert.equal(generatedPackage.frontend_page.validation.valid, true);
  assert.equal(generatedPackage.publish_composition.validation.valid, true);
  assert.match(generatedPackage.publish_composition.page_content_hash, /^[a-f0-9]{64}$/);
  assert.match(generatedPackage.publish_composition.seo_artifact_hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(generatedPackage.publish_composition.publish_package.page.blocks, wordpress.calls[0].publishPackage.page.blocks);
  assert.equal(generatedPackage.frontend_page.contract_version, "1.2.0");
  assert.equal(generatedPackage.brief.strategy_version, CONTENT_STRATEGY.version);
  assert.equal(generatedPackage.brief.canonical.strategy_version, CONTENT_STRATEGY.version);
  assert.ok(generatedPackage.draft.content_blocks.length > 0);
  assert.equal(db.prepare("SELECT strategy_version FROM wordpress_publications WHERE draft_id=?").get(content[0].draft_id).strategy_version, CONTENT_STRATEGY.version);
  assert.equal(JSON.stringify(repository.getTopicPackage(content[0].id)).includes("Trip.com"), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status='failed'").get().count, 0);

  const mismatched = structuredClone(generatedPackage.publish_composition.publish_package);
  mismatched.contract.contractChecksum = "f".repeat(64);
  assert.equal(frontendContracts.validatePublishPackage(mismatched).errors.some((item) => item.code === "CONTRACT_VERSION_MISMATCH"), true);

  const deliveryError = Object.assign(new Error("Published posts cannot be overwritten."), { code: "POST_NOT_DRAFT" });
  repository.failWordPressPublication(content[0].draft_id, deliveryError);
  const failedPublication = db.prepare("SELECT status, error_code, last_error FROM wordpress_publications WHERE draft_id=?").get(content[0].draft_id);
  assert.equal(failedPublication.status, "failed");
  assert.equal(failedPublication.error_code, "POST_NOT_DRAFT");
  assert.match(failedPublication.last_error, /cannot be overwritten/);
  assert.equal(repository.getDraftPackage(content[0].draft_id).publish_composition.status, "delivery_failed");

  assert.equal(repository.retryContent(content[0].id, { contractAware: true }), "push_wordpress_draft");
  assert.equal(await pipeline.runOne(), true);
  assert.equal(wordpress.calls.length, 2);
  assert.equal(wordpress.calls[1].publishPackage.publication.existing_post_id, 42);
  assert.equal(db.prepare("SELECT status FROM wordpress_publications WHERE draft_id=?").get(content[0].draft_id).status, "synced");

  repository.failWordPressPublication(content[0].draft_id, deliveryError);
  db.prepare("DELETE FROM frontend_publish_compositions WHERE draft_id=?").run(content[0].draft_id);
  assert.equal(repository.retryContent(content[0].id, { contractAware: false }), "push_wordpress_draft");

  const beforeRevision = repository.getDraftPackage(content[0].draft_id);
  const visualIds = beforeRevision.draft.visuals.map((visual) => visual.id);
  repository.saveDraft(beforeRevision.draft.brief_id, {
    ...beforeRevision.draft,
    body_markdown: `${beforeRevision.draft.body_markdown}\n\nEditorial clarification.`,
    faqs: beforeRevision.draft.seo.faqs || [],
    visuals: beforeRevision.draft.visuals,
  }, "writer-model-v2", { deferReview: true });
  const afterRevision = repository.getDraftPackage(content[0].draft_id);
  assert.equal(afterRevision.draft.revision, beforeRevision.draft.revision + 1);
  assert.equal(afterRevision.review, null, "an older passed QA cannot authorize revised content");
  assert.equal(afterRevision.commercial_composition, null, "commercial output is version-bound");
  assert.equal(afterRevision.frontend_page.current, false, "page composition becomes stale after a draft revision");
  assert.deepEqual(afterRevision.draft.visuals.map((visual) => visual.id), visualIds, "unchanged visual assets are reused");

  db.prepare("DELETE FROM jobs WHERE entity_id=?").run(content[0].draft_id);
  const extractionCount = db.prepare("SELECT COUNT(*) AS count FROM segment_extractions").get().count;
  const bodyBeforeMetadataEdit = afterRevision.draft.body_markdown;
  const edited = repository.updateDraftMetadata(content[0].draft_id, {
    title: "First-Time Beijing Solo Travel Guide — 2026 Notes",
    metaDescription: "Practical, evidence-bounded notes for a first solo visit to Beijing.",
  });
  assert.equal(edited.body_markdown, bodyBeforeMetadataEdit, "metadata editing does not invoke or replace writer output");
  assert.equal(edited.model, "manual_metadata_edit");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM segment_extractions").get().count, extractionCount,
    "metadata editing does not rerun evidence extraction");
  assert.deepEqual(db.prepare("SELECT type FROM jobs WHERE entity_id=? AND status='queued' ORDER BY type").all(content[0].draft_id).map((row) => row.type),
    ["review_draft"], "metadata editing invalidates downstream work and reruns only the final content check");
});
