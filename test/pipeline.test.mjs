import assert from "node:assert/strict";
import test from "node:test";
import { normalizeXiaohongshuCapture } from "../src/adapters/xiaohongshu.mjs";
import { Pipeline } from "../src/pipeline.mjs";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";

test("pipeline separates extraction, claims, semantic coexistence, and editorial patterns", async (t) => {
  const { repository } = repositoryFixture(t);
  const extractor = {
    async extract(source) {
      const value = source.title.includes("A") ? "East Gate" : "South Gate";
      return {
        method: "test",
        model: "fixture-model",
        result: {
          source: {
            language: "zh-CN", summary: "A source summary", destination_name: "Beijing", destination_slug: "beijing",
            traveler_fit: ["solo"], practical_tips: [], warnings: [], confidence: 0.9,
          },
          claims: [{
            key: "attraction.example.entry_gate", subject: "Example attraction", predicate: "entry gate", value,
            qualifiers: [], confidence: 0.8, source_quote: `Use the ${value}`,
          }],
          blueprint: {
            format: "practical guide", hook: "save time", angle: "first visit",
            sections: [{ heading: "Before you go", purpose: "Preparation" }], strengths: ["specific"], gaps: ["accessibility"],
          },
        },
      };
    },
  };
  const pipeline = new Pipeline(repository, extractor);

  for (const [id, title] of [["sourceA", "Guide A"], ["sourceB", "Guide B"]]) {
    repository.saveCapture(normalizeXiaohongshuCapture({
      url: `https://www.xiaohongshu.com/explore/${id}`,
      title,
      text: `This is source ${id} with a sufficiently long practical travel description. Use the ${title.includes("A") ? "East Gate" : "South Gate"}.`,
      images: [],
    }));
  }

  while (await pipeline.runOne()) { /* drain the Strategy 1.4 staged extraction graph */ }

  const dashboard = repository.dashboard();
  assert.equal(dashboard.totals.sources, 2);
  assert.equal(dashboard.totals.claims, 2);
  assert.equal(dashboard.totals.knowledgeFacts, 1);
  assert.equal(dashboard.totals.conflicts, 0);
  assert.equal(dashboard.actionCounts.exceptions, 0);
  assert.equal(dashboard.actionCounts.recommendations, 0);
  assert.equal(repository.getEditorialBlueprints()[0].sample_count, 2);
  assert.equal(repository.getKnowledge()[0].evidence.length, 2);
});

test("a manual coverage segment does not fail its source before every segment settles", (t) => {
  const { db, repository } = repositoryFixture(t);
  const source = repository.saveCapture(normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/coverage-ordering",
    title: "Chongqing image guide",
    text: "This selected travel note contains a long introduction that the model must inspect before deciding whether it contains a durable travel claim for visitors.",
    images: [{ url: "https://example.com/one.jpg", alt: "first travel image" }, { url: "https://example.com/two.jpg", alt: "second travel image" }],
  }));
  const segments = repository.prepareSourceSegments(source.id);
  assert.equal(segments.length, 3);
  const extraction = (claims = []) => ({
    method: "test_multimodal", model: "fixture-model",
    result: { source: { language: "en", summary: "Guide", destination_name: "Chongqing", destination_slug: "chongqing", traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.9 }, claims,
      blueprint: { format: "guide", hook: "Visit", angle: "practical", sections: [], strengths: [], gaps: [] } },
  });

  repository.saveSegmentExtraction(segments[0].id, extraction());
  assert.equal(repository.auditSegmentCoverage(segments[0].id, { uncovered_spans: [{ quote: "long introduction", importance: "material", reason: "Potential visitor fact is uncovered." }] }).status, "retry_required");
  repository.saveSegmentExtraction(segments[0].id, extraction(), { retry: true });
  assert.equal(repository.auditSegmentCoverage(segments[0].id, { uncovered_spans: [{ quote: "long introduction", importance: "material", reason: "Potential visitor fact is still uncovered." }] }).status, "manual_review");
  assert.equal(db.prepare("SELECT status,last_error FROM sources WHERE id=?").get(source.id).status, "processing");

  for (const [index, segment] of segments.slice(1).entries()) {
    repository.saveSegmentExtraction(segment.id, extraction([{ key: `attraction.test.image_${index + 1}`, subject: "Test place", predicate: "features_view", value: `view ${index + 1}`, qualifiers: [], source_quote: `visible image ${index + 1}`, confidence: 0.9 }]));
    repository.auditSegmentCoverage(segment.id, { uncovered_spans: [], modality: { received: "image", attempted: 1 } });
    const stored = db.prepare("SELECT status,last_error FROM sources WHERE id=?").get(source.id);
    assert.equal(stored.status, index === 0 ? "processing" : "exception");
  }

  const decision = repository.reviewSegmentCoverage(source.id, segments[0].id, { decision: "not_material", note: "Introductory copy only", operator: "tester" });
  assert.equal(decision.sourceState.ready, true);
  assert.equal(db.prepare("SELECT status,last_error FROM sources WHERE id=?").get(source.id).status, "processing");
  assert.equal(db.prepare("SELECT status FROM extraction_coverage WHERE segment_id=?").get(segments[0].id).status, "passed");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type='finalize_source_extraction' AND entity_id=? AND status='queued'").get(source.id).count, 1);
  const audit = JSON.parse(db.prepare("SELECT audit_json FROM extraction_coverage WHERE segment_id=?").get(segments[0].id).audit_json);
  assert.equal(audit.manualReview.operator, "tester");
});

test("coverage drops an untraceable text Claim without blocking supported evidence", (t) => {
  const { db, repository } = repositoryFixture(t);
  const source = repository.saveCapture(normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/traceable-claims",
    title: "Traceable Chongqing route",
    text: "Take Metro Line 2 to reach the downtown route. This complete selected note also explains the walking sequence for first-time visitors.",
    images: [],
  }));
  const [segment] = repository.prepareSourceSegments(source.id);
  repository.saveSegmentExtraction(segment.id, {
    method: "test_text", model: "fixture-model",
    result: {
      source: { language: "en", summary: "Route", destination_name: "Chongqing", destination_slug: "chongqing", traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.9 },
      claims: [
        { key: "chongqing.route.metro", subject: "Downtown route", predicate: "transport route", value: "Metro Line 2", qualifiers: [], source_quote: "Take Metro Line 2", confidence: 0.9 },
        { key: "chongqing.route.fabricated", subject: "Downtown route", predicate: "opening time", value: "08:00", qualifiers: [], source_quote: "Opens every day at 08:00", confidence: 0.8 },
      ],
      blueprint: { format: "itinerary", hook: "Easy route", angle: "first visit", sections: [], strengths: [], gaps: [] },
    },
  });
  const audit = repository.auditSegmentCoverage(segment.id, { uncovered_spans: [] });
  assert.equal(audit.status, "passed");
  assert.equal(audit.claimCount, 1);
  assert.equal(audit.unsupportedClaimCount, 1);
  repository.finalizeSegmentedExtraction(source.id);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM claims WHERE source_id=?").get(source.id).count, 1);
});

test("coverage audit ignores and repairs legacy unsupported-Claim false positives", (t) => {
  const { db, repository } = repositoryFixture(t);
  const source = repository.saveCapture(normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/68abcdef0000000000000099",
    title: "Traceable route audit",
    text: "Take Metro Line 2 for this complete Chongqing route and follow the signed walking path.",
    images: [],
  }));
  const [segment] = repository.prepareSourceSegments(source.id);
  repository.saveSegmentExtraction(segment.id, {
    method: "vertex", model: "fixture-model",
    result: { source: { language: "en", summary: "Route", destination_name: "Chongqing", destination_slug: "chongqing", traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.9 },
      claims: [{ key: "chongqing.route.metro", subject: "Route", predicate: "transport_route", value: "Metro Line 2", qualifiers: [], source_quote: "Take Metro Line 2", confidence: 0.9 }],
      blueprint: { format: "pending", hook: "", angle: "", sections: [], strengths: [], gaps: [] } },
  });
  const falsePositive = { uncovered_spans: [{ quote: "segment 1", importance: "material", reason: "One or more extracted Claims do not contain a quote traceable to this segment." }] };
  assert.equal(repository.auditSegmentCoverage(segment.id, falsePositive).status, "passed");
  db.prepare(`UPDATE extraction_coverage SET status='manual_review',important_uncovered_count=1,uncovered_spans_json=? WHERE segment_id=?`)
    .run(JSON.stringify(falsePositive.uncovered_spans.map((item) => ({ locator: item.quote, importance: item.importance, reason: item.reason }))), segment.id);
  db.prepare("UPDATE source_segments SET status='failed' WHERE id=?").run(segment.id);
  db.prepare("UPDATE sources SET status='exception',last_error='legacy false positive' WHERE id=?").run(source.id);
  assert.equal(repository.reconcileCoverageAuditFalsePositives(), 1);
  assert.equal(db.prepare("SELECT status FROM extraction_coverage WHERE segment_id=?").get(segment.id).status, "passed");
  assert.equal(db.prepare("SELECT status FROM sources WHERE id=?").get(source.id).status, "processing");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type='finalize_source_extraction' AND entity_id=? AND status='queued'").get(source.id).count, 1);
});

test("media segment coverage uses extraction metadata instead of a second model call", async () => {
  let audits = 0;
  const repository = {
    claimJob: () => ({ id: "job-audit-image", type: "audit_segment_coverage", entity_id: "segment-image" }),
    getSegmentCoveragePackage: () => ({ expectedModality: "image", staleCaptureVersion: false }),
    auditSegmentCoverage: () => ({ status: "passed", sourceState: { ready: false } }),
    sourceCoverageReady: () => false,
    completeJob: () => true,
    failJob: (_job, error) => assert.fail(error),
  };
  const pipeline = new Pipeline(repository, { auditCoverage: async () => { audits += 1; } });
  assert.equal(await pipeline.runOne(), true);
  assert.equal(audits, 0);
});

test("coverage trusts the persisted input manifest instead of guessing batch modality", (t) => {
  const { db, repository } = repositoryFixture(t);
  const source = repository.saveCapture(normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/68abcdef0000000000000199",
    title: "Chongqing image evidence",
    text: "A selected image source with enough context for the extraction pipeline.",
    images: [{ url: "https://example.com/batch-image.jpg", alt: "Hongyadong at night" }],
  }));
  const imageSegment = repository.prepareSourceSegments(source.id).find((segment) => segment.assetId);
  const asset = db.prepare("SELECT * FROM source_assets WHERE id=?").get(imageSegment.assetId);

  repository.saveSegmentExtraction(imageSegment.id, {
    method: "vertex_batch",
    model: "gemini-3.8-flash",
    inputManifest: {
      version: 1,
      expectedModality: "image",
      receivedModality: "image",
      provider: "vertex",
      model: "gemini-3.8-flash",
      capabilities: { text: true, image: true, video: false, batch: true },
      assets: [{ assetId: asset.id, hash: asset.original_sha256 || null, kind: "image", status: "submitted", requestReference: "inline_data" }],
    },
    result: {
      source: { language: "en", summary: "Image", destination_name: "Chongqing", destination_slug: "chongqing", traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.9 },
      claims: [{ key: "chongqing.hongyadong.night_view", subject: "Hongyadong", predicate: "features_view", value: "Night view", qualifiers: [], source_quote: "Hongyadong at night", confidence: 0.9 }],
      blueprint: { format: "guide", hook: "", angle: "", sections: [], strengths: [], gaps: [] },
    },
  });

  const audit = repository.auditSegmentCoverage(imageSegment.id);
  assert.equal(audit.receivedModality, "image");
  assert.equal(audit.status, "passed");
  assert.equal(audit.attempted, 1);

  repository.saveSegmentExtraction(imageSegment.id, {
    method: "vertex_batch",
    model: "gemini-3.8-flash",
    inputManifest: {
      version: 1,
      expectedModality: "image",
      receivedModality: "text",
      provider: "vertex",
      model: "gemini-3.8-flash",
      capabilities: { text: true, image: true, video: false, batch: true },
      assets: [{ assetId: asset.id, hash: asset.original_sha256 || null, kind: "image", status: "failed",
        requestReference: null, failureCode: "IMAGE_FETCH_FAILED", failureReason: "Image fetch failed (503)." }],
    },
    result: {
      source: { language: "en", summary: "Text fallback", destination_name: "Chongqing", destination_slug: "chongqing", traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.6 },
      claims: [],
      blueprint: { format: "guide", hook: "", angle: "", sections: [], strengths: [], gaps: [] },
    },
  });
  const failed = repository.auditSegmentCoverage(imageSegment.id);
  assert.equal(failed.receivedModality, "text");
  assert.equal(failed.status, "retry_required");
  assert.match(failed.uncovered[0].reason, /Image fetch failed \(503\)/);

  db.prepare("UPDATE segment_extractions SET input_modality='unknown',input_manifest_json='{}' WHERE segment_id=?").run(imageSegment.id);
  const legacy = repository.auditSegmentCoverage(imageSegment.id);
  assert.equal(legacy.receivedModality, "unknown");
  assert.equal(legacy.status, "retry_required");
});

test("entity resolution falls back deterministically when model structured output is invalid", async () => {
  const completed = [];
  const enqueued = [];
  let deterministicCalls = 0;
  const repository = {
    claimJob: () => ({ id: "job-entity", type: "resolve_entities", entity_id: "chongqing", attempts: 1, max_attempts: 3 }),
    getEntityResolutionPackage: () => ({ claims: [{ id: "claim-1" }] }),
    resolveEntitiesDeterministically: (slug) => { assert.equal(slug, "chongqing"); deterministicCalls += 1; },
    enqueue: (type, entityId) => enqueued.push([type, entityId]),
    completeJob: (jobId) => completed.push(jobId),
    failJob: () => assert.fail("recoverable model output must not fail the job"),
  };
  const contentEngine = {
    enabled: true,
    resolveEntities: async () => { throw new Error("Vertex Gemini returned invalid JSON twice despite structured output mode."); },
  };
  const pipeline = new Pipeline(repository, {}, { contentEngine });
  assert.equal(await pipeline.runOne(), true);
  assert.equal(deterministicCalls, 1);
  assert.deepEqual(enqueued, [["rebuild_knowledge", "chongqing"]]);
  assert.deepEqual(completed, ["job-entity"]);
});

test("re-extraction versions derived claims instead of erasing their audit history", (t) => {
  const { db, repository } = repositoryFixture(t);
  const source = repository.saveCapture(normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/versioned-extraction",
    title: "Versioned extraction",
    text: "A manually selected Chongqing travel note with enough text for extraction version testing.",
    images: [],
  }));
  const result = (value) => ({
    source: {
      language: "zh-CN", summary: "A source summary", destination_name: "Chongqing", destination_slug: "chongqing",
      traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.9,
    },
    claims: [{
      key: "attraction.example.reservation_required", subject: "Example attraction",
      predicate: "reservation_required", value, qualifiers: [], confidence: 0.9,
      source_quote: value === "true" ? "需要预约" : "无需预约", claim_role: "fact", knowledge_eligible: true,
    }],
    blueprint: { format: "guide", hook: "Plan ahead", angle: "practical", sections: [], strengths: [], gaps: [] },
  });

  repository.saveExtraction(source.id, result("true"), "test", "model-a");
  const firstClaim = db.prepare("SELECT * FROM claims WHERE source_id=?").get(source.id);
  repository.saveExtraction(source.id, result("false"), "test", "model-b");

  const current = db.prepare("SELECT * FROM claims WHERE source_id=?").get(source.id);
  const history = db.prepare("SELECT * FROM claim_history WHERE source_id=?").all(source.id);
  const runs = db.prepare("SELECT * FROM extraction_runs WHERE source_id=? ORDER BY revision").all(source.id);
  assert.equal(current.extraction_revision, 2);
  assert.equal(current.value_text, "false");
  assert.equal(history.length, 1);
  assert.equal(history[0].claim_id, firstClaim.id);
  assert.equal(JSON.parse(history[0].snapshot_json).value_text, "true");
  assert.deepEqual(runs.map((run) => run.status), ["superseded", "active"]);
  const hydrated = repository.getSource(source.id);
  assert.equal(hydrated.extraction_runs.length, 2);
  assert.equal(hydrated.claim_history[0].snapshot.value_text, "true");
});

test("editorial metadata and personal experience remain as claims but stay out of knowledge", (t) => {
  const { db, repository } = repositoryFixture(t);
  const source = repository.saveCapture(normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/knowledge-admission",
    title: "Knowledge admission",
    text: "A manually selected Chongqing note containing a place fact and an author disclaimer for testing.",
    images: [],
  }));
  repository.saveExtraction(source.id, {
    source: {
      language: "zh-CN", summary: "Mixed source", destination_name: "Chongqing", destination_slug: "chongqing",
      traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.9,
    },
    claims: [
      { key: "attraction.example.opening_time", subject: "Example attraction", predicate: "opening_time", value: "09:00", qualifiers: [], confidence: 0.9, source_quote: "09:00开放", claim_role: "fact", knowledge_eligible: true },
      { key: "source.recommendations.disclaimer", subject: "recommendations", predicate: "stated as", value: "作者主观体验，非唯一答案", qualifiers: [], confidence: 0.9, source_quote: "只是作者主观体验，并非唯一答案", claim_role: "editorial_metadata", knowledge_eligible: false },
    ],
    blueprint: { format: "guide", hook: "Plan ahead", angle: "practical", sections: [], strengths: [], gaps: [] },
  }, "test", "fixture-model");

  repository.rebuildKnowledge("chongqing");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM claims WHERE source_id=?").get(source.id).count, 2);
  assert.equal(repository.knowledgeForDestination("chongqing").length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM claim_review_cases").get().count, 0);
});

test("equivalent reservation wording produces one corroborated canonical Knowledge fact", (t) => {
  const { db, repository } = repositoryFixture(t);
  const assertions = [
    { id: "6a0000000000000000000001", predicate: "does not require", value: "advance reservation", quote: "无需预约" },
    { id: "6a0000000000000000000002", predicate: "requires reservation", value: "no reservation required", quote: "无需预约" },
  ];
  for (const assertion of assertions) {
    const source = repository.saveCapture(normalizeXiaohongshuCapture({
      url: `https://www.xiaohongshu.com/explore/${assertion.id}`,
      title: assertion.id,
      text: "A manually selected Chongqing note containing a reservation assertion for canonicalization testing.",
      images: [],
    }));
    repository.saveExtraction(source.id, {
      source: {
        language: "zh-CN", summary: "Reservation", destination_name: "Chongqing", destination_slug: "chongqing",
        traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.9,
      },
      claims: [{
        key: "attraction.hongyadong.reservation_required", subject: "Hongyadong",
        predicate: assertion.predicate, value: assertion.value, qualifiers: [], confidence: 0.9,
        source_quote: assertion.quote, claim_role: "fact", knowledge_eligible: true,
      }],
      blueprint: { format: "guide", hook: "Plan ahead", angle: "practical", sections: [], strengths: [], gaps: [] },
    }, "test", "fixture-model");
  }

  repository.rebuildKnowledge("chongqing");
  const [fact] = repository.knowledgeForDestination("chongqing");
  assert.equal(fact.predicate, "reservation_required");
  assert.equal(fact.preferred_value, "false");
  assert.equal(fact.consensus_status, "corroborated");
  assert.equal(fact.support_count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM claim_review_cases").get().count, 0);
});
