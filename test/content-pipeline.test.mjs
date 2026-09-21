import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from 'node:fs';
import path from 'node:path';
import test from "node:test";
import sharp from 'sharp';
import { auditSourcePhoto, closeLocalPhotoAudit } from '../src/local-photo-audit.mjs';
import { normalizeXiaohongshuCapture } from "../src/adapters/xiaohongshu.mjs";
import { Pipeline } from "../src/pipeline.mjs";
import { CONTENT_STRATEGY } from "../src/content-strategy.mjs";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";
import { CommercialComposer, normalizeCommercialOffer } from "../src/commercial.mjs";
import { FrontendContractConsumer } from "../src/frontend-contract.mjs";
import { defaultComponents, frontendContractFixture } from "../test-support/frontend-contract-fixture.mjs";
import { pageBlockSignature } from "../src/repository.mjs";

for (const pipelineMode of ['legacy','article_bundle_v1']) test(`human approval drives ${pipelineMode} to QA and WordPress draft delivery`, async (t) => {
  t.after(closeLocalPhotoAudit);
  const { db, repository, directory } = repositoryFixture(t);
  const commercialComponent = {
    id: "affiliate_booking_card", category: "commercial", purpose: "Approved affiliate booking resource.", status: "stable", variants: ["default"],
    schema: { type: "object", additionalProperties: false,
      required: ["affiliate_asset_id", "provider", "asset_type", "product_category", "title", "description", "cta_label", "target_url", "disclosure", "scope_type", "scope_key", "slot_key", "placement", "strategy_version"],
      properties: Object.fromEntries(["affiliate_asset_id", "provider", "asset_type", "product_category", "title", "description", "cta_label", "target_url", "disclosure", "scope_type", "scope_key", "slot_key", "placement", "strategy_version", "price_text", "entity", "route", "destination", "anchor"].map((key) => [key, { type: "string" }])) },
  };
  const imageComponent = {
    id:"image", category:"media", purpose:"Delivered article image.", status:"stable", variants:["featured","context"],
    schema:{ type:"object", additionalProperties:false, required:["media_id","alt","role"], properties:{
      media_id:{type:"integer"}, alt:{type:"string"}, caption:{type:"string"}, role:{type:"string"},
    } },
  };
  const contractFixture = frontendContractFixture(t, { components: [...defaultComponents(), imageComponent, commercialComponent] });
  const frontendContracts = new FrontendContractConsumer(repository, {
    sourceRepository: "https://github.com/example/solo-to-china",
    registrySource: contractFixture.registryPath,
    pageSchemaSource: contractFixture.pageSchemaPath,
  });
  await frontendContracts.sync();
  const sourceExtractor = {
    config: { sourceUploadsDir: repository.contentConfig.sourceUploadsDir },
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
          source: { language: "en", summary: "Research", destination_name: "Beijing", destination_slug: "beijing", traveler_fit: ["solo"], practical_tips: [], warnings: [], confidence: 0.9 },
          claims: [
            ["beijing.orientation.location", "Beijing orientation", "location", "Central Beijing"],
            ["beijing.transport.metro", "Beijing transport", "metro transport", "Use the metro"],
            ["beijing.booking.reservation", "Beijing booking", "reservation booking", "Reserve timed attractions"],
            ["beijing.payment.methods", "Beijing payment", "payment methods", "Carry a working mobile payment method"],
            ["beijing.cost.budget", "Beijing budget", "cost budget", "Plan admission and transit costs"],
          ].map(([key, subject, predicate, value]) => ({ key, subject, predicate, value,
            qualifiers: [], confidence: 0.85, source_quote: value })),
          media_analysis:(source.assets || []).map((asset)=>({asset_id:asset.id,analysis_status:"ready",
            asset_kind:"documentary_photo",text_regions:[],photo_regions:[{region_id:"photo",subject:"Beijing travel scene"}],
            entities:["Beijing"],editor_ui_regions:[],primary_subjects:["Beijing travel scene"],language_by_region:[],
            reader_text_present:false,confidence:0.95,analysis_version:"media-analysis-1",prompt_version:"media-analysis-prompt-1"})),
          blueprint: { format: "guide", hook: "First trip", angle: "solo first visit", sections: [], strengths: ["specific"], gaps: [] },
        },
      };
    },
  };
  const stageCalls = [];
  const contentEngine = {
    enabled: true,
    async articleBundle(research) {
      stageCalls.push('article_bundle_v1');
      const [brief,draft]=await Promise.all([this.plan(research),this.draft(research)]);
      return {model:'bundle-model',output:{brief:brief.output,draft:draft.output}};
    },
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
      stageCalls.push("generate_draft");
      assert.ok(contentPackage.authorized_source_assets?.some((asset) => asset.mime_type === "image/png" && asset.preview_url),
        "saved authorized source images must be selected before writing starts");
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
    async composeFrontendPage(contentPackage) {
      stageCalls.push("compose_frontend_page");
      const block = { type: "articleSection", variant: "answer-first", data: { heading: "Plan", body: "Central Beijing is the orientation point. Use the metro; this transport evidence was checked on September 7, 2026." } };
      const imageBlocks=(contentPackage.draft.visuals || []).map((visual,index)=>({ type:"image", variant:index === 0 ? "featured" : "context",
        data:{ media_id:visual.wordpress_media_id, alt:visual.alt_text, caption:visual.caption, role:index === 0 ? "featured" : "context" } }));
      return { model: "payload-composer-model", output: {
        metadata: { title: "First-Time Beijing Solo Travel Guide" },
        blocks: [block,...imageBlocks],
      }, provenance: { version: "2", valid: true, errors: [], entries: [{ contentNodeId: "node_plan",
        blockSignature: pageBlockSignature(block), sourceSectionIds: ["section_plan"],
        claimKeys: ["beijing.orientation.location", "beijing.transport.metro"], factuality: "factual" },
        ...imageBlocks.map((image,index)=>({ contentNodeId:`node_media_${index}`, blockSignature:pageBlockSignature(image),
          sourceSectionIds:[], claimKeys:[], factuality:"non_factual" }))] } };
    },
    async review() {
      stageCalls.push("review_draft");
      return { model: "reviewer-model", output: { passed: true, score: 92, checks: [], issues: [], unsupported_claims: [] } };
    },
  };
  const wordpress = {
    enabled: true,
    config: { siteUrl: "https://example.test" },
    calls: [],
    async resolveVisualMedia(visuals, onProgress) {
      const uploaded = visuals.map((visual, index) => ({ visualId:visual.id, id:100 + index,
        url:`https://example.test/uploads/${visual.id}.png`, metadata:{
          url:`https://example.test/uploads/${visual.id}.png`, width:1200, height:800, mime:"image/png", bytes:1024 + index,
           sha256:createHash("sha256").update(fs.readFileSync(visual.media_path || visual.source_asset_local_path)).digest("hex"), derivatives:[],
          source_provenance:visual.source_asset_id ? { source_asset_id:visual.source_asset_id, original_stored:true,
            project_owner_confirmed:true } : undefined,
          authorization_policy:visual.source_asset_id ? "project_source_media_full_authorization" : undefined,
        } }));
      for (const item of uploaded) onProgress?.(item);
      return uploaded;
    },
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
    const pixels=Buffer.alloc(1200*800*3);
    for (let i=0;i<pixels.length;i++) pixels[i]=(i*73+(i>>4)*29) & 255;
    const sourceBytes=await sharp(pixels,{raw:{width:1200,height:800,channels:3}}).png().toBuffer();
    repository.saveCapture(normalizeXiaohongshuCapture({
      url: `https://www.xiaohongshu.com/explore/${externalId}`, title,
      text: externalId === "autoA"
        ? "Beijing orientation: Central Beijing. Use the metro. Reserve timed attractions. Carry a working mobile payment method. Plan admission and transit costs."
        : "Beijing booking: Central Beijing. Use the metro. Reserve timed attractions. Carry a working mobile payment method. Plan admission and transit costs. Passport checks, museum entry, ticket windows, weekend crowds, airport arrival, luggage storage, hotel check-in, translation, local etiquette, and emergency contacts are reviewed independently.",
      images: [{ url: `https://ci.xhscdn.com/${externalId}.jpg`, alt: `${title} real-world travel scene`,
        originalDataUrl: `data:image/png;base64,${sourceBytes.toString('base64')}`,
        originalSha256: createHash('sha256').update(sourceBytes).digest('hex') }],
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
  assert.equal(repository.listContentOpportunities().length, 0, "unapproved source proposals are not content opportunities");
  assert.equal(repository.listApprovedContentOpportunities().length, 0);
  assert.equal(repository.listContent({ approvedOnly: true }).length, 0);
  const adaptationPath = recommendation.production_paths.find((path) => path.mode === "SOURCE_ADAPTATION");
  const approval = repository.decideRecommendation(recommendation.id, "approved_article", "", { opportunityId: adaptationPath.opportunity_id });
  assert.equal(approval.opportunityId, adaptationPath.opportunity_id);
  assert.equal(repository.listContentOpportunities().length, 1, "the approved article plan becomes a content opportunity");
  const [approvedOpportunity] = repository.listApprovedContentOpportunities();
  assert.equal(Boolean(approvedOpportunity), true);
  assert.equal("coverage_json" in approvedOpportunity, false);
  assert.equal("readiness_json" in approvedOpportunity, false);
  const dashboardAfterApproval = repository.dashboard();
  assert.equal(dashboardAfterApproval.actionCounts.recommendations, pendingRecommendationCount - 1);
  assert.equal(dashboardAfterApproval.totals.pendingRecommendations, pendingRecommendationCount - 1);
  assert.equal(dashboardAfterApproval.totals.contentPipelineItems, 1, JSON.stringify(approval));
  assert.equal(approval.queued, true, JSON.stringify(approval));
  assert.equal(db.prepare("SELECT pipeline_version FROM jobs WHERE type='plan_content' AND status='queued'").get().pipeline_version,
    'article_bundle_v1');
  // Exercise the historical job path; newly approved jobs use article_bundle_v1.
  if (pipelineMode === 'legacy') db.prepare("UPDATE jobs SET pipeline_version='legacy' WHERE type='plan_content' AND status='queued'").run();
  let mediaReady = false;
  for (let index = 0; index < 60; index += 1) {
    if (!mediaReady) {
      const draft = db.prepare('SELECT id FROM article_drafts LIMIT 1').get();
      if (draft) {
        for (const visual of repository.listDraftVisualsForDelivery(draft.id)) {
          const file = visual.media_path || visual.source_asset_local_path
            || path.join(directory, `${visual.id}.png`);
          if (!fs.existsSync(file)) fs.writeFileSync(file, Buffer.from(`illustration-${visual.id}`));
          const hash = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
          const metadata = { ...visual.media_metadata, binary_qa:{status:'passed',sha256:hash},
            quality_qa:{status:'passed',file_hash:hash} };
          db.prepare("UPDATE article_visuals SET status='generated',media_path=?,media_metadata_json=? WHERE id=?")
            .run(file, JSON.stringify(metadata), visual.id);
        }
        mediaReady = true;
      }
    }
    await pipeline.runOne();
  }

  const content = repository.listContent();
  assert.equal(content.length, 1);
  assert.equal(repository.listContent({ approvedOnly: true }).length, 1);
  assert.equal(content[0].draft_status, "wordpress_draft", JSON.stringify({ exceptions: repository.listOperationalExceptions(),
    jobs: repository.db.prepare('SELECT type,last_error,failure_details_json FROM jobs WHERE last_error IS NOT NULL').all() }));
  assert.equal(content[0].qa_passed, 1);
  assert.equal(content[0].wordpress_post_id, 42);
  assert.equal(wordpress.calls.length, 1);
  assert.equal(wordpress.calls[0].publishPackage.page.blocks[0].type,
    pipelineMode === 'legacy' ? 'articleSection' : 'image');
  const deliveredCommercial = wordpress.calls[0].publishPackage.page.blocks.find((block)=>block.type === "affiliate_booking_card");
  assert.equal(deliveredCommercial.type, "affiliate_booking_card");
  assert.equal(deliveredCommercial.data.disclosure, "Affiliate disclosure.");
  const generatedPackage = repository.getDraftPackage(content[0].draft_id);
  assert.equal(generatedPackage.brief.plan.working_title,"First-Time Beijing Solo Travel Guide");
  assert.equal(generatedPackage.brief.plan.why_this_article,"Plan with confidence");
  assert.equal(generatedPackage.brief.plan.evidence_plan[0].section_id,"section_plan");
  assert.deepEqual(generatedPackage.brief.plan.evidence_plan[0].claim_keys,["beijing.orientation.location","beijing.transport.metro"]);
  const researchDraft = generatedPackage.draft.body_markdown;
  assert.doesNotMatch(researchDraft, /Trip\.com|Optional booking resources/);
  assert.equal(generatedPackage.draft.visuals.length, 2);
  assert.equal(generatedPackage.draft.visuals[0].acquisition_strategy, "use_authorized_source_image");
  assert.equal(generatedPackage.draft.visuals[0].status, "generated");
  assert.ok(generatedPackage.draft.visuals[0].source_asset_id);
  assert.match(generatedPackage.draft.visuals[0].source_remote_url, /xhscdn\.com/);
  db.exec("SAVEPOINT legacy_visual_metadata");
  try {
    db.prepare("UPDATE article_visuals SET media_metadata_json='{}' WHERE id=?").run(generatedPackage.draft.visuals[0].id);
    const [legacyDeliveryVisual] = repository.listDraftVisualsForDelivery(generatedPackage.draft.id);
    assert.equal(legacyDeliveryVisual.media_metadata.authorization_policy, "project_source_media_full_authorization");
    assert.equal(legacyDeliveryVisual.media_metadata.source_provenance.source_asset_id, legacyDeliveryVisual.source_asset_id);
    assert.equal(legacyDeliveryVisual.media_metadata.source_provenance.original_stored, true);
    assert.equal(legacyDeliveryVisual.media_metadata.source_provenance.project_owner_confirmed, true);
    db.prepare("UPDATE source_assets SET local_path=? WHERE id=?").run("missing-authorized-original.png", legacyDeliveryVisual.source_asset_id);
    const [missingOriginalVisual] = repository.listDraftVisualsForDelivery(generatedPackage.draft.id);
    assert.equal(missingOriginalVisual.media_metadata.source_provenance.original_stored, false,
      "project authorization must not fabricate a missing original file");
  } finally {
    db.exec("ROLLBACK TO legacy_visual_metadata; RELEASE legacy_visual_metadata");
  }
  assert.equal(generatedPackage.draft.schema_jsonld["@context"], "https://schema.org");
  assert.equal(generatedPackage.draft.strategy_version, CONTENT_STRATEGY.version);
  db.exec('SAVEPOINT missing_generated_derivative');
  try {
    const derivative=generatedPackage.draft.visuals.find((visual)=>
      visual.acquisition_strategy==='generate_illustration');
    assert.ok(derivative?.media_path,'fixture must include a durable generated illustration');
    db.prepare("UPDATE article_visuals SET media_path=NULL,status='generated' WHERE id=?").run(derivative.id);
    const repair=repository.mediaRepairPlan(generatedPackage.draft.id);
    assert.equal(repair.slots.find((slot)=>slot.visual_id===derivative.id)?.reason,'generated_file_missing');
    repository.ensureAuthorizedSourceVisuals(generatedPackage.draft.id);
    assert.equal(db.prepare('SELECT status FROM article_visuals WHERE id=?').get(derivative.id).status,'planned',
      'missing generated bytes must re-enter the media stage without replacing the article body');
  } finally {
    db.exec('ROLLBACK TO missing_generated_derivative; RELEASE missing_generated_derivative');
  }
  if (pipelineMode === 'legacy') assert.equal(generatedPackage.frontend_page_plan.plan.blocks[0].type, "articleSection");
  assert.equal(generatedPackage.frontend_page.payload.blocks[0].type,
    pipelineMode === 'legacy' ? 'articleSection' : 'image');
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
  db.exec('SAVEPOINT published_review_blocker');
  try {
    const publication=db.prepare('SELECT site_url,post_id,post_url FROM wordpress_publications WHERE draft_id=?')
      .get(content[0].draft_id);
    repository.replaceWordPressInventory(publication.site_url,[{postId:publication.post_id,
      slug:'published-review-blocker',title:generatedPackage.draft.title,status:'publish',
      postUrl:publication.post_url,modifiedAt:new Date().toISOString()}]);
    db.prepare("UPDATE article_drafts SET status='needs_review' WHERE id=?").run(content[0].draft_id);
    const blocked=repository.getDraftPackage(content[0].draft_id);
    assert.equal(blocked.draft.status,'needs_review');
    assert.equal(blocked.publication.remote_status,'publish');
    const compact=repository.listContentWorkspace({productionOnly:true,compact:true,limit:20}).items
      .find((item)=>item.draft_id===content[0].draft_id);
    assert.equal(compact.wordpress_remote_status,'publish',
      'a media review blocker cannot hide the observed WordPress publication');
    assert.notEqual(repository.planArticlePhotoRefresh([content[0].draft_id]).items[0].reason,
      'wordpress_status_mismatch','a published post can repair media while its local gate is blocked');
  } finally {
    db.exec('ROLLBACK TO published_review_blocker; RELEASE published_review_blocker');
  }
  if (pipelineMode === 'legacy') assert.ok(stageCalls.indexOf("compose_frontend_page") < stageCalls.indexOf("review_draft"),
    `page composition must precede QA: ${stageCalls.join(" -> ")}`);
  else {
    assert.equal(stageCalls.filter((stage)=>stage==='article_bundle_v1').length,1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs WHERE type IN ('assemble_editorial','plan_narrative','compose_frontend_page_plan','generate_draft')").get().n,0);
  }

  const mismatched = structuredClone(generatedPackage.publish_composition.publish_package);
  mismatched.contract.contractChecksum = "f".repeat(64);
  assert.equal(frontendContracts.validatePublishPackage(mismatched).errors.some((item) => item.code === "CONTRACT_VERSION_MISMATCH"), true);

  db.exec('SAVEPOINT historical_photo_refresh');
  try {
    db.prepare('DELETE FROM wordpress_publications WHERE draft_id=?').run(content[0].draft_id);
    db.prepare('DELETE FROM article_visuals WHERE draft_id=? AND slot=2').run(content[0].draft_id);
    db.prepare(`INSERT INTO source_assets(id,source_id,kind,remote_url,alt_text,position,local_path,mime_type,
      storage_status,original_bytes_status,durability_status,original_sha256,capture_version,local_photo_audit_json)
      SELECT 'extra-photo',source_id,kind,'https://ci.xhscdn.com/extra-photo.jpg',
        'Central Beijing metro transport orientation photograph',position+10,local_path,mime_type,
        storage_status,original_bytes_status,durability_status,original_sha256,capture_version,local_photo_audit_json
      FROM source_assets WHERE id=?`).run(generatedPackage.draft.visuals[0].source_asset_id);
    const secondPixels=Buffer.alloc(1200*800*3);
    for (let i=0;i<secondPixels.length;i++) secondPixels[i]=(i*59+(i>>6)*37+17)&255;
    const secondBytes=await sharp(secondPixels,{raw:{width:1200,height:800,channels:3}}).png().toBuffer();
    const secondPath=path.join(directory,'extra-photo.png');
    fs.writeFileSync(secondPath,secondBytes);
    const secondAudit=await auditSourcePhoto(secondPath);
    assert.equal(secondAudit.status,'eligible');
    db.prepare(`UPDATE source_assets SET local_path=?,original_sha256=?,local_photo_audit_json=? WHERE id='extra-photo'`)
      .run(secondPath,secondAudit.sha256,JSON.stringify(secondAudit));
    db.prepare("UPDATE article_drafts SET strategy_version='3.8' WHERE id=?").run(content[0].draft_id);
    const plan=repository.planArticlePhotoRefresh([content[0].draft_id]);
    assert.equal(plan.items[0].disposition,'eligible',JSON.stringify(plan.items[0]));
    const body=repository.getDraftPackage(content[0].draft_id).draft.body_markdown;
    const calls=db.prepare('SELECT COUNT(*) AS count FROM model_call_metrics').get().count;
    const applied=repository.applyArticlePhotoRefresh([content[0].draft_id],plan.confirmation);
    assert.equal(applied.queued.length,1);
    const refreshed=repository.getDraftPackage(content[0].draft_id);
    assert.equal(refreshed.draft.body_markdown,body);
    assert.equal(refreshed.draft.strategy_version,'3.9');
    assert.equal(refreshed.review?.passed,true,'the independent unchanged-text QA remains current');
    assert.equal(refreshed.draft.visuals.length,2);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM model_call_metrics').get().count,calls,
      'reusing audited originals must not call a Provider');
  } finally {
    db.exec('ROLLBACK TO historical_photo_refresh; RELEASE historical_photo_refresh');
  }

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
