import assert from "node:assert/strict";
import test from "node:test";
import { normalizeXiaohongshuCapture } from "../src/adapters/xiaohongshu.mjs";
import { createProviderRateLimiter, estimateRequestTokens, isRateLimitMetric } from "../src/ai/provider-rate-limiter.mjs";
import { checkContextBudget } from "../src/ai/context-budget.mjs";
import { VertexGeminiClient, isNonSchemaBadRequest } from "../src/ai/vertex-gemini-client.mjs";
import { destinationCoverageSummary } from "../src/repository.mjs";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";

function fakeClock() {
  let at = 1_000_000;
  const sleeps = [];
  return { now: () => at, sleep: async (ms) => { sleeps.push(ms); at += ms; }, sleeps };
}

test("rate limiter waits for request capacity instead of dispatching into a 429", async () => {
  const clock = fakeClock();
  const limiter = createProviderRateLimiter({ limits: { vertex: { rpm: 2 } }, now: clock.now, sleep: clock.sleep });
  await limiter.acquire({ provider: "vertex", model: "m" });
  await limiter.acquire({ provider: "vertex", model: "m" });
  assert.deepEqual(clock.sleeps, []);
  await limiter.acquire({ provider: "vertex", model: "m" });
  assert.equal(clock.sleeps.reduce((sum, ms) => sum + ms, 0), 60_000);
});

test("rate limiter bounds estimated tokens per minute and admits a single oversized request alone", async () => {
  const clock = fakeClock();
  const limiter = createProviderRateLimiter({ limits: { vertex: { tpm: 100_000 } }, now: clock.now, sleep: clock.sleep });
  await limiter.acquire({ provider: "vertex", model: "m", estimatedTokens: 70_000 });
  await limiter.acquire({ provider: "vertex", model: "m", estimatedTokens: 40_000 });
  assert.equal(clock.sleeps.reduce((sum, ms) => sum + ms, 0), 60_000);
  // Larger than the whole budget: waits for an empty window, then proceeds.
  await limiter.acquire({ provider: "vertex", model: "m", estimatedTokens: 500_000 });
  assert.equal(limiter.snapshot()[0].tokensLastMinute, 500_000);
});

test("rate limiter lanes are independent and a 429 pauses only its own lane", async () => {
  const clock = fakeClock();
  const limiter = createProviderRateLimiter({ limits: { default: { rpm: 100 } }, now: clock.now, sleep: clock.sleep });
  limiter.penalize({ provider: "vertex", model: "m", retryAfterMs: 20_000 });
  await limiter.acquire({ provider: "deepseek", model: "d" });
  assert.deepEqual(clock.sleeps, []);
  await limiter.acquire({ provider: "vertex", model: "m" });
  assert.deepEqual(clock.sleeps, [20_000]);
  assert.equal(isRateLimitMetric({ errorCode: "429" }), true);
  assert.equal(isRateLimitMetric({ errorCode: "PROVIDER_REQUEST_FAILED", httpStatus: 429 }), true);
  assert.equal(isRateLimitMetric({ errorCode: "INVALID_MODEL_OUTPUT" }), false);
});

test("token estimates count media parts as fixed allowances rather than base64 payload size", () => {
  const image = { inlineData: { mimeType: "image/jpeg", data: "A".repeat(3_000_000) } };
  assert.equal(estimateRequestTokens([image]), 1_500);
  assert.equal(estimateRequestTokens("x".repeat(3_500)), 1_000);
});

test("context budgets flag oversized stage inputs without touching the stage policy hash", () => {
  assert.equal(checkContextBudget({ stage: "content_intake_analysis", estimatedTokens: 5_000 }), null);
  const overrun = checkContextBudget({ stage: "content_intake_analysis", estimatedTokens: 311_000 });
  assert.equal(overrun.budget, 12_000);
  assert.ok(overrun.ratio > 25);
  assert.equal(checkContextBudget({ stage: "unknown_stage", estimatedTokens: 1e9 }), null);
});

test("a non-schema 400 is not retried with weaker schema transports", async () => {
  const requests = [];
  const client = new VertexGeminiClient({ projectId: "p", location: "global", model: "gemini-3.8-flash", accessToken: "t",
    schemaModeRegistry: new Map() }, async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return Response.json({ error: { code: 400, message: "The input token count (1200000) exceeds the maximum number of tokens allowed (1048576)." } }, { status: 400 });
  });
  await assert.rejects(() => client.completeJson({ name: "content_brief", schema: { type: "object" }, instructions: "Plan.", content: "x" }));
  assert.equal(requests.length, 1);
  assert.equal(isNonSchemaBadRequest("Unable to process input image."), true);
  assert.equal(isNonSchemaBadRequest("Request contains an invalid argument."), false);
});

test("a schema transport rejection is remembered across later requests for the same schema", async () => {
  const registry = new Map();
  const requests = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (body.generationConfig.responseSchema) return Response.json({ error: { code: 400, message: "Request contains an invalid argument." } }, { status: 400 });
    return Response.json({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] });
  };
  const config = { projectId: "p", location: "global", model: "gemini-3.8-flash", accessToken: "t", schemaModeRegistry: registry };
  const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
  await new VertexGeminiClient(config, fetchImpl).completeJson({ name: "content_brief", schema, instructions: "Plan.", content: "a" });
  assert.equal(requests.length, 2);
  await new VertexGeminiClient(config, fetchImpl).completeJson({ name: "content_brief", schema, instructions: "Plan.", content: "b" });
  assert.equal(requests.length, 3, "second Job starts directly on the accepted transport");
  assert.equal(requests[2].generationConfig.responseSchema, undefined);
});

test("intake coverage summary is value-free and bounded regardless of evidence volume", () => {
  const facts = Array.from({ length: 500 }, (_, index) => ({ subject: `Place ${index % 90}`, predicate: `p${index % 20}`,
    preferred_value: "secret value ".repeat(50), consensus_status: index % 2 ? "corroborated" : "single_source",
    evidence: [{ quote: "long quote ".repeat(100) }] }));
  const summary = destinationCoverageSummary(facts);
  assert.equal(summary.fact_count, 500);
  assert.equal(summary.subjects.length, 60);
  assert.equal(summary.omitted_subjects, 30);
  assert.doesNotMatch(JSON.stringify(summary), /secret value|long quote/);
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 12_000);
});

test("entity resolution skips claims already naming a confirmed alias and keeps paging", (t) => {
  const { repository } = repositoryFixture(t);
  const source = repository.saveCapture(normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/68abcdef0000000000000977", title: "Alias source",
    text: "This manually selected source contains enough stable text to exercise entity resolution paging.", images: [],
  }));
  repository.saveExtraction(source.id, {
    source: { language: "en", summary: "s", destination_name: "Chongqing", destination_slug: "chongqing",
      traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.9 },
    claims: Array.from({ length: 30 }, (_, index) => ({ key: `test.fact.${String(index).padStart(3, "0")}`,
      subject: index < 20 ? "Hongyadong" : `Place ${index}`, predicate: "detail", value: `Value ${index}`,
      qualifiers: [], confidence: 0.9, source_quote: `Quote ${index}` })),
    blueprint: { format: "guide", hook: "h", angle: "a", sections: [], strengths: [], gaps: [] },
  }, "test", "fixture-model");
  repository.upsertEntityAlias("chongqing", "hongyadong",
    { entityKey: "attraction.hongyadong", canonicalSubject: "Hongyadong", aliases: ["Hongyadong"] }, "model", 0.95);
  const first = repository.getEntityResolutionPackage("chongqing", 5);
  assert.ok(first.claims.every((claim) => claim.subject !== "Hongyadong"));
  const seen = [...first.claims];
  let cursor = first.nextCursor;
  while (cursor) {
    const page = repository.getEntityResolutionPackage("chongqing", 5, cursor);
    seen.push(...page.claims);
    cursor = page.nextCursor;
  }
  assert.equal(seen.length, 10);
  assert.equal(new Set(seen.map((claim) => claim.id)).size, 10);
});

// --- Image Cards: image understanding from the extraction call itself ---
import { KimiExtractor, imageCardMediaAnalysis, sanitizeImageCard } from "../src/ai/kimi.mjs";
import { isDeferredMediaAnalysisPlaceholder } from "../src/repository.mjs";

function deepseekExtractor(output, requests = []) {
  return new KimiExtractor({ provider: "deepseek", apiKey: "test", model: "deepseek-flash", baseUrl: "https://example.test",
    stagePolicy: { version: "test", stages: { source_research_extraction: { maxAttempts: 1, maxOutputTokens: 4000, timeoutMs: 5000 } } } },
  async (url, init) => {
    if (String(url).includes("example.test")) {
      requests.push(JSON.parse(init.body));
      return Response.json({ model: "deepseek-flash", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(output) } }] });
    }
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } });
  });
}

const extractionOutput = (cards) => ({ source: { language: "zh-CN", summary: "s", destination_name: "Chongqing",
  destination_slug: "chongqing", traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.8 },
claims: [{ key: "place.view", subject: "Hongyadong", predicate: "has_view", value: "night", qualifiers: [], confidence: 0.8,
  source_quote: "night", claim_role: "fact", knowledge_eligible: true }], image_cards: cards });

test("DeepSeek extraction turns a plain-photo image card into a ready pixel analysis without a second call", async () => {
  const requests = [];
  const extractor = deepseekExtractor(extractionOutput([{ asset_id: "asset-1", asset_kind: "documentary_photo",
    primary_subjects: ["Hongyadong stilt buildings at night"], place_names: ["Hongyadong"], scene: "architecture",
    visible_text: false, photo_quality: "high", editorial_use: "hero", alt_text: "Hongyadong lit up at night above the Jialing River", confidence: 0.9 }]), requests);
  const result = await extractor.extract({ title: "Night", raw_text: "photo", assets: [{ id: "asset-1", kind: "image",
    remote_url: "https://sns-img.xhscdn.com/a.jpg", segment_id: "segment-1" }] });
  assert.equal(requests.length, 1);
  assert.match(requests[0].messages[0].content, /image_cards/);
  const [analysis] = result.result.media_analysis;
  assert.equal(analysis.analysis_status, "ready");
  assert.equal(analysis.asset_kind, "documentary_photo");
  assert.equal(analysis.analysis_version, "image-card-1");
  assert.deepEqual(analysis.primary_subjects, ["Hongyadong stilt buildings at night"]);
  assert.equal(analysis.photo_regions[0].editorial_use, "hero");
  assert.equal(result.result.image_cards.length, 1);
});

test("text-bearing, unusable or missing image cards keep the explicit deferral", async () => {
  const card = { asset_id: "asset-1", asset_kind: "editorial_infographic", primary_subjects: ["ticket prices"], place_names: [],
    scene: "signage", visible_text: true, photo_quality: "high", editorial_use: "body", alt_text: "Price card", confidence: 0.95 };
  const extractor = deepseekExtractor(extractionOutput([card]));
  const result = await extractor.extract({ title: "Card", raw_text: "photo", assets: [{ id: "asset-1", kind: "image",
    remote_url: "https://sns-img.xhscdn.com/a.jpg", segment_id: "segment-1" }] });
  assert.equal(result.result.media_analysis[0].analysis_status, "needs_review");
  assert.equal(isDeferredMediaAnalysisPlaceholder(result.result.media_analysis[0]), true);
  assert.equal(imageCardMediaAnalysis(sanitizeImageCard({ ...card, asset_kind: "documentary_photo", visible_text: false, editorial_use: "unusable" })), null);
  assert.equal(imageCardMediaAnalysis(sanitizeImageCard({ ...card, asset_kind: "documentary_photo", visible_text: false, confidence: 0.4 })), null);
  // Unknown text presence is never assumed text-free.
  assert.equal(sanitizeImageCard({ asset_id: "x" }).visible_text, true);
});

// Regression from the 2026-09-30 L5 DeepSeek canary: JSON mode returned scene
// values outside the enum and the strict card schema failed the whole extraction.
test("malformed image cards never fail Claim extraction on a JSON-mode provider", async () => {
  const extractor = deepseekExtractor(extractionOutput([
    { assetId: "asset-1", asset_kind: "Photo", primary_subjects: "Jiefangbei monument at dusk", scene: "city scene at night",
      visible_text: "false", photo_quality: "High", editorial_use: "Hero image", alt_text: "Jiefangbei at dusk", confidence: "0.85",
      mood: "busy" },
    { asset_id: "asset-2", scene: 42 },
    { note: "no id at all" },
  ]));
  const result = await extractor.extract({ title: "Mixed", raw_text: "photos", assets: [
    { id: "asset-1", kind: "image", remote_url: "https://sns-img.xhscdn.com/a.jpg", segment_id: "segment-1" },
    { id: "asset-2", kind: "image", remote_url: "https://sns-img.xhscdn.com/b.jpg", segment_id: "segment-2" }] });
  assert.equal(result.result.claims.length, 1, "Claims survive malformed optional cards");
  const [first, second] = result.result.image_cards;
  assert.equal(result.result.image_cards.length, 2);
  assert.deepEqual([first.asset_id, first.asset_kind, first.scene, first.visible_text, first.photo_quality, first.confidence],
    ["asset-1", "documentary_photo", "other", false, "high", 0.85]);
  assert.deepEqual(first.primary_subjects, ["Jiefangbei monument at dusk"]);
  assert.deepEqual([second.scene, second.visible_text, second.editorial_use], ["other", true, "evidence_only"]);
  assert.equal(sanitizeImageCard({ scene: "Restaurant" }).scene, "food");
});

// Regression from the second 2026-09-30 L5 DeepSeek canary: a numeric Claim value
// ($.claims[2].value) failed validation and discarded every Claim in the batch.
test("scalar Claim fields from a JSON-mode provider are coerced instead of failing the batch", async () => {
  const output = extractionOutput([]);
  output.claims.push(
    { key: "ticket.price", subject: "Hongyadong", predicate: "ticket_price_cny", value: 15, qualifiers: "adult", confidence: "0.8", source_quote: "15元" },
    { key: "hours.open", subject: "Hongyadong", predicate: "open_24h", value: true, qualifiers: [], confidence: 0.7, source_quote: "全天" },
    { key: "empty.value", subject: "Hongyadong", predicate: "note", value: null, qualifiers: [], confidence: 0.5, source_quote: "x" });
  const result = await deepseekExtractor(output).extract({ title: "Values", raw_text: "text", assets: [{ id: "asset-1", kind: "image",
    remote_url: "https://sns-img.xhscdn.com/a.jpg", segment_id: "segment-1" }] });
  const byKey = new Map(result.result.claims.map((claim) => [claim.key, claim]));
  assert.equal(byKey.get("ticket.price").value, "15");
  assert.equal(byKey.get("ticket.price").confidence, 0.8);
  assert.deepEqual(byKey.get("ticket.price").qualifiers, ["adult"]);
  assert.equal(byKey.get("hours.open").value, "true");
  assert.equal(byKey.has("empty.value"), false, "a null value drops only that Claim");
  assert.equal(result.result.claims.length, 3);
});

test("a deferral placeholder is not persisted, and legacy placeholder rows read as not analyzed", async (t) => {
  const { db, repository } = repositoryFixture(t);
  const saved = repository.saveCapture(normalizeXiaohongshuCapture({ url: "https://www.xiaohongshu.com/explore/68abcdef0000000000000988",
    title: "Photos", text: "A note with one photo of the riverside.", images: [{ url: "https://sns-img.xhscdn.com/p-0.jpg" }] }));
  const segments = repository.prepareSourceSegments(saved.id);
  const found = segments.find((segment) => segment.asset_id || segment.assetId);
  const imageSegment = { ...found, asset_id: found.asset_id || found.assetId };
  const placeholder = { asset_id: imageSegment.asset_id, analysis_status: "needs_review", asset_kind: "unknown", text_regions: [],
    photo_regions: [], entities: [], editor_ui_regions: [], primary_subjects: [], language_by_region: [], reader_text_present: true,
    confidence: 0, analysis_version: "media-analysis-2", prompt_version: "media-analysis-prompt-2" };
  repository.saveSegmentExtraction(imageSegment.id, { result: { ...extractionOutput([]), media_analysis: [placeholder] },
    method: "deepseek_multimodal", model: "deepseek-flash" });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM source_asset_analyses WHERE asset_id=?").get(imageSegment.asset_id).n, 0);
  assert.equal(isDeferredMediaAnalysisPlaceholder({ analysis_status: "needs_review", asset_kind: "unknown", analysis_confidence: 0,
    primary_subjects_json: "[]", text_regions_json: "[]", entities_json: "[]" }), true);
  assert.equal(isDeferredMediaAnalysisPlaceholder({ analysis_status: "needs_review", asset_kind: "handwritten_card", analysis_confidence: 0.7,
    primary_subjects_json: '["menu"]', text_regions_json: "[]", entities_json: "[]" }), false);
});

test("derived rebuilds are debounced so a burst of Source completions coalesces into one job", (t) => {
  let at = Date.parse("2026-09-30T00:00:00.000Z");
  const { db, repository } = repositoryFixture(t, { rebuildDebounceMs: 30_000, clock: () => new Date(at) });
  const first = repository.enqueue("rebuild_topic_clusters", "chongqing");
  at += 5_000;
  const second = repository.enqueue("rebuild_topic_clusters", "chongqing");
  assert.equal(first, second);
  const row = db.prepare("SELECT available_at FROM jobs WHERE id=?").get(first);
  assert.equal(row.available_at, "2026-09-30T00:00:30.000Z");
  // Interactive work and non-rebuild stages are never delayed.
  const interactive = repository.enqueue("rebuild_knowledge", "beijing", { interactive: true });
  assert.equal(db.prepare("SELECT available_at FROM jobs WHERE id=?").get(interactive).available_at, "2026-09-30T00:00:05.000Z");
  const { repository: immediate, db: immediateDb } = repositoryFixture(t, { clock: () => new Date(at) });
  const job = immediate.enqueue("rebuild_topic_clusters", "chongqing");
  assert.equal(immediateDb.prepare("SELECT available_at FROM jobs WHERE id=?").get(job).available_at, "2026-09-30T00:00:05.000Z");
});

import { imageCardOf, rankPlanningAssets } from "../src/repository.mjs";

test("planning shows the most relevant, publishable photos instead of the newest twelve", () => {
  const card = (use, quality, places = []) => [{ region_id: "image", source: "image-card-1", scene: "architecture",
    photo_quality: quality, editorial_use: use, alt_text: "alt", place_names: places }];
  const assets = [
    { id: "newest-unanalyzed", analysis_status: "not_analyzed", primary_subjects: [] },
    { id: "blurred", analysis_status: "ready", primary_subjects: ["Hongyadong"], photo_regions: card("unusable", "low", ["Hongyadong"]) },
    { id: "other-place", analysis_status: "ready", primary_subjects: ["Ciqikou lanes"], photo_regions: card("body", "high") },
    { id: "hero", analysis_status: "ready", primary_subjects: ["Hongyadong stilt houses at night"], photo_regions: card("hero", "high", ["Hongyadong"]) },
  ];
  const ranked = rankPlanningAssets(assets, { title: "Hongyadong at night", targetEntities: ["Hongyadong"] }).map((asset) => asset.id);
  assert.equal(ranked[0], "hero");
  assert.ok(ranked.indexOf("blurred") > ranked.indexOf("other-place"));
  assert.deepEqual(imageCardOf(assets[3]), { scene: "architecture", photo_quality: "high", editorial_use: "hero", alt_text: "alt", place_names: ["Hongyadong"] });
  assert.equal(imageCardOf(assets[0]), null);
});

// --- Production lane: approved articles cannot be stranded by ingest/semantic work ---
import { workloadClassForJob } from "../src/job-policy.mjs";
import { Pipeline } from "../src/pipeline.mjs";

test("production stages run in their own lane unless an operator or recovery lane is explicit", () => {
  assert.equal(workloadClassForJob("generate_draft", "normal_ingest"), "production");
  assert.equal(workloadClassForJob("review_draft"), "production");
  assert.equal(workloadClassForJob("generate_draft", "historical_recovery"), "historical_recovery");
  assert.equal(workloadClassForJob("generate_draft", "interactive"), "interactive");
  assert.equal(workloadClassForJob("resolve_entities"), "semantic");
  assert.equal(workloadClassForJob("extract_segment_claims"), "normal_ingest");
});

test("a production-lane claim skips higher-priority semantic work and accepts legacy production rows", (t) => {
  const { db, repository } = repositoryFixture(t);
  db.prepare("DELETE FROM jobs").run();
  repository.enqueue("resolve_entities", "chongqing", { priority: 1 });
  const legacy = repository.enqueue("review_draft", "draft-legacy");
  db.prepare("UPDATE jobs SET workload_class='normal_ingest' WHERE id=?").run(legacy);
  const claimed = repository.claimJob({ workloadClass: "production" });
  assert.equal(claimed.id, legacy);
  assert.equal(repository.claimJob({ workloadClass: "production" }), null);
  assert.equal(repository.claimJob().type, "resolve_entities");
});

test("the reserved production slot runs even when adaptive concurrency is exhausted", async () => {
  const claims = [];
  const repository = { claimJob: (options) => { claims.push(options); return null; }, countVertexBatchEligibleJobs: () => 0 };
  const pipeline = new Pipeline(repository, null, { extractionConfig: { productionReserveSlots: 1, concurrencyInitial: 1 } });
  pipeline.working = 1;
  assert.equal(await pipeline.runOne(), false);
  assert.equal(claims.length, 0);
  await pipeline.runOne({ reservedLane: "production" });
  assert.equal(claims.length, 1);
  assert.equal(claims[0].workloadClass, "production");
  assert.equal(pipeline.reservedWorking, 0);
  const unreserved = new Pipeline(repository, null, { extractionConfig: { concurrencyInitial: 1 } });
  assert.equal(await unreserved.runOne({ reservedLane: "production" }), false);
});

test("entity review sends only claims created since the last successful pass, with a periodic full sweep", (t) => {
  let at = Date.parse("2026-09-30T00:00:00.000Z");
  const { db, repository } = repositoryFixture(t, { entityFullReviewDays: 7, clock: () => new Date(at) });
  const seed = (suffix, subjects) => {
    const source = repository.saveCapture(normalizeXiaohongshuCapture({ url: `https://www.xiaohongshu.com/explore/68abcdef00000000000009${suffix}`,
      title: "Review source", text: "This manually selected source contains enough stable text for entity review.", images: [] }));
    repository.saveExtraction(source.id, { source: { language: "en", summary: "s", destination_name: "Chongqing", destination_slug: "chongqing",
      traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.9 },
    claims: subjects.map((subject, index) => ({ key: `review.${suffix}.${index}`, subject, predicate: "detail", value: `v${index}`,
      qualifiers: [], confidence: 0.9, source_quote: `q${index}` })),
    blueprint: { format: "guide", hook: "h", angle: "a", sections: [], strengths: [], gaps: [] } }, "test", "fixture-model");
  };
  seed("91", ["Old Place A", "Old Place B"]);
  assert.equal(repository.entityReviewSince("chongqing"), null, "no prior full pass: review everything");
  const reviewedAt = new Date(Date.now() + 60_000).toISOString();
  repository.recordEntityReview("chongqing", reviewedAt, { full: true, claims: 2 });
  at = Date.parse(reviewedAt) + 86_400_000;
  const since = repository.entityReviewSince("chongqing");
  assert.equal(since, reviewedAt);
  db.prepare("UPDATE claims SET created_at=? ").run("2026-09-29T00:00:00.000Z");
  seed("92", ["New Place C"]);
  db.prepare("UPDATE claims SET created_at=? WHERE subject='New Place C'").run(new Date(Date.parse(reviewedAt) + 1_000).toISOString());
  const incremental = repository.getEntityResolutionPackage("chongqing", 80, null, { since });
  assert.deepEqual(incremental.claims.map((claim) => claim.subject), ["New Place C"]);
  at = Date.parse(reviewedAt) + 8 * 86_400_000;
  assert.equal(repository.entityReviewSince("chongqing"), null, "full sweep is due again");
});

test("a completed resolve_entities job records the review watermark and the next pass sends only new claims", async (t) => {
  const { db, repository } = repositoryFixture(t, { entityFullReviewDays: 7 });
  const seed = (suffix, subject) => {
    const source = repository.saveCapture(normalizeXiaohongshuCapture({ url: `https://www.xiaohongshu.com/explore/68abcdef00000000000008${suffix}`,
      title: "Resolve source", text: "This manually selected source contains enough stable text for entity review.", images: [] }));
    repository.saveExtraction(source.id, { source: { language: "en", summary: "s", destination_name: "Chongqing", destination_slug: "chongqing",
      traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.9 },
    claims: [{ key: `resolve.${suffix}`, subject, predicate: "detail", value: "v", qualifiers: [], confidence: 0.9, source_quote: "q" }],
    blueprint: { format: "guide", hook: "h", angle: "a", sections: [], strengths: [], gaps: [] } }, "test", "fixture-model");
  };
  seed("81", "First Place");
  const sent = [];
  const engine = { enabled: true, config: { model: "fixture" },
    resolveEntities: async (pack) => { sent.push(pack.claims.map((claim) => claim.subject)); return { output: { entities: [], claim_updates: [], candidates: [] }, model: "fixture" }; } };
  const run = async () => {
    db.prepare("DELETE FROM jobs").run();
    repository.enqueue("resolve_entities", "chongqing");
    const pipeline = new Pipeline(repository, { enabled: false, config: {} }, { contentEngine: engine });
    assert.equal(await pipeline.runOne(), true);
  };
  await run();
  assert.ok(db.prepare("SELECT 1 FROM integration_sync_state WHERE sync_key='entity_full_review:chongqing' AND status='succeeded'").get());
  await new Promise((resolve) => setTimeout(resolve, 5));
  seed("82", "Second Place");
  await run();
  assert.deepEqual(sent.at(-1), ["Second Place"]);
});

test("an entity page that overflows the provider output limit is split instead of abandoning the destination", async (t) => {
  const { db, repository } = repositoryFixture(t);
  const source = repository.saveCapture(normalizeXiaohongshuCapture({ url: "https://www.xiaohongshu.com/explore/68abcdef0000000000000777",
    title: "Split source", text: "This manually selected source contains enough stable text for entity review.", images: [] }));
  repository.saveExtraction(source.id, { source: { language: "en", summary: "s", destination_name: "Chongqing", destination_slug: "chongqing",
    traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.9 },
  claims: Array.from({ length: 50 }, (_, index) => ({ key: `split.${index}`, subject: `Split Place ${index}`, predicate: "detail",
    value: "v", qualifiers: [], confidence: 0.9, source_quote: "q" })),
  blueprint: { format: "guide", hook: "h", angle: "a", sections: [], strengths: [], gaps: [] } }, "test", "fixture-model");
  db.prepare("DELETE FROM jobs").run();
  const sizes = [];
  const engine = { enabled: true, config: { model: "fixture" }, resolveEntities: async (pack) => {
    sizes.push(pack.claims.length);
    if (pack.claims.length > 20) throw Object.assign(new Error("DeepSeek output reached its token limit."), { code: "MODEL_OUTPUT_LIMIT" });
    return { output: { entities: [], claim_updates: [], candidates: [] }, model: "fixture" };
  } };
  const jobId = repository.enqueue("resolve_entities", "chongqing");
  const pipeline = new Pipeline(repository, { enabled: false, config: {} }, { contentEngine: engine });
  for (let turn = 0; turn < 6 && db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId).status !== "succeeded"; turn += 1) {
    db.prepare("UPDATE jobs SET available_at='2000-01-01T00:00:00.000Z',next_eligible_at=NULL WHERE id=? AND status='queued'").run(jobId);
    await pipeline.runOne();
  }
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId).status, "succeeded");
  // 40 overflows once, then the rest of the destination is reviewed in pages of 20.
  assert.deepEqual(sizes, [40, 20, 20, 10]);
});

// Regression from the third 2026-09-30 L5 DeepSeek canary ($.type): stray keys and
// omitted defaults must not discard a batch of otherwise valid Claims.
test("extraction tolerates stray keys, omitted defaults and off-enum labels but still requires core evidence", async () => {
  const output = { type: "object", note: "extra", source: { summary: "Night route", destination_slug: "Chongqing", mood: "x" },
    claims: [
      { key: "Route.Night", subject: "Hongyadong", predicate: "best_time", value: "night", source_quote: "晚上去", extra: 1,
        date_confidence: "HIGH", claim_role: "Fact", knowledge_eligible: "true" },
      { key: "no.quote", subject: "x", predicate: "y", value: "z" },
    ] };
  const result = await deepseekExtractor(output).extract({ title: "t", raw_text: "text", assets: [] });
  assert.equal(result.result.type, undefined);
  assert.equal(result.result.source.destination_slug, "chongqing");
  assert.deepEqual(result.result.source.traveler_fit, []);
  const [claim] = result.result.claims;
  assert.equal(claim.key, "route.night");
  assert.equal(claim.extra, undefined);
  assert.equal(claim.date_confidence, "high");
  assert.equal(claim.confidence, 0);
  assert.deepEqual(claim.qualifiers, []);
  // A Claim without its source quote is not evidence: it alone is dropped and reported.
  assert.equal(result.result.claims.length, 1);
  assert.match(result.result.source.warnings.join(" "), /1 claims were dropped for missing required evidence fields/);
});

// --- Disk guard: the 2026-09-30 production disk reached 100% unnoticed ---
import { diskHealthSeverity, diskUsage, describeDiskUsage } from "../src/disk-guard.mjs";

test("disk usage above 80%/90% becomes a warning/blocker health issue", (t) => {
  const fake = (freeBlocks) => () => ({ blocks: 1000n, bsize: 4096n, bavail: BigInt(freeBlocks) });
  assert.equal(diskHealthSeverity(diskUsage("/data", fake(500))), null);
  assert.equal(diskHealthSeverity(diskUsage("/data", fake(150))), "warning");
  assert.equal(diskHealthSeverity(diskUsage("/data", fake(0))), "blocker");
  assert.equal(diskUsage("/missing", () => { throw new Error("ENOENT"); }), null);
  assert.match(describeDiskUsage(diskUsage("/data", fake(0))), /已使用 100%/);
  const { repository } = repositoryFixture(t, { diskMonitorPath: process.cwd() });
  const items = repository.listOperationalExceptions();
  const disk = items.find((item) => item.key === "sync:disk:data");
  const actual = diskHealthSeverity(diskUsage(process.cwd()));
  assert.equal(Boolean(disk), Boolean(actual));
});

import { buildProductionState } from "../src/services/production-state.mjs";

test("a published article with a stale commercial overlay stays completed instead of pipeline-interrupted", (t) => {
  const { db } = repositoryFixture(t);
  const base = { opportunity_id: "opp-frozen", draft_id: "draft-frozen", commercial_refresh_required: 1,
    commercial_refresh_reason: "affiliate_asset_inventory_changed", draft_updated_at: "2026-09-30T04:20:00.000Z",
    approved_at: "2026-09-20T00:00:00.000Z" };
  const published = buildProductionState(db, { ...base, draft_status: "published" });
  assert.equal(published.stage_status, "succeeded");
  assert.equal(published.headline, "文章已在 WordPress 发布");
  // Published remotely before the CMS status caught up: the stale overlay flag
  // changes nothing (this minimal row lacks other stage evidence either way).
  const remote = { ...base, draft_status: "wordpress_draft", wordpress_remote_status: "publish" };
  const flagged = buildProductionState(db, remote);
  const unflagged = buildProductionState(db, { ...remote, commercial_refresh_required: 0 });
  assert.equal(flagged.headline, unflagged.headline);
  assert.doesNotMatch(String(flagged.headline || "") + String(flagged.explanation || ""), /商业内容组合|流程断链/);
  const pending = buildProductionState(db, { ...base, draft_status: "commercial_ready" });
  assert.match(JSON.stringify(pending), /COMMERCIAL_OVERLAY_STALE|商业/);
});

// 2026-09-30: the first pass after the watermark release re-sent every claim
// (~2.1M DeepSeek tokens) although daily full passes had already run for weeks.
test("the entity review watermark bootstraps from the last successful resolution instead of a paid full sweep", (t) => {
  const { db, repository } = repositoryFixture(t, { entityFullReviewDays: 30, clock: () => new Date("2026-09-30T06:00:00.000Z") });
  assert.equal(repository.entityReviewSince("chongqing"), null, "never resolved: a first full pass is required");
  const jobId = repository.enqueue("resolve_entities", "chongqing");
  db.prepare("UPDATE jobs SET status='succeeded', started_at=?, completed_at=? WHERE id=?")
    .run("2026-09-29T20:09:00.000Z", "2026-09-29T20:40:00.000Z", jobId);
  assert.equal(repository.entityReviewSince("chongqing"), "2026-09-29T20:09:00.000Z");
  assert.ok(db.prepare("SELECT 1 FROM integration_sync_state WHERE sync_key='entity_full_review:chongqing'").get());
});
