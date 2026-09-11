import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeXiaohongshuCapture } from "../src/adapters/xiaohongshu.mjs";
import { ChunkedUploadManager } from "../src/chunked-upload.mjs";
import { classifySourceFamily, evaluateCoverage, segmentSource } from "../src/research-strategy.mjs";
import { scopeFactsForOpportunity } from "../src/repository.mjs";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";

test("Strategy 1.4 accounts for every captured image as an auditable segment", () => {
  const source = {
    id: "source-many-images", source_kind: "xiaohongshu_note", raw_text: "A useful route description.", title: "Guide",
    assets: Array.from({ length: 18 }, (_, index) => ({ id: `asset-${index}`, kind: "image", original_filename: `${index}.jpg`, alt_text: `Image ${index + 1}` })),
  };
  const segments = segmentSource(source);
  assert.equal(segments.filter((item) => item.segmentType === "image").length, 18);
  assert.deepEqual(segments.filter((item) => item.segmentType === "image").map((item) => item.imageIndex), Array.from({ length: 18 }, (_, index) => index + 1));
});

test("a single oversized paragraph is hard-split without silent truncation", () => {
  const text = "长文本证据。".repeat(15_000);
  const segments = segmentSource({ id: "long", source_kind: "manual_text", raw_text: text, title: "Long", assets: [] });
  assert.ok(segments.length > 10);
  assert.ok(segments.every((segment) => segment.rawText.length <= 6_000));
  assert.ok(segments.map((segment) => segment.rawText).join("").length >= text.length);
});

test("opportunity evidence is scoped to the named entity", () => {
  const facts = [
    { normalized_key: "attraction.forbidden_city.reservation", subject: "Forbidden City", predicate: "reservation" },
    { normalized_key: "attraction.summer_palace.opening_time", subject: "Summer Palace", predicate: "opening time" },
  ];
  const selected = scopeFactsForOpportunity(facts, { destinationSlug: "beijing", topic: "Forbidden City", title: "How to Visit Forbidden City" });
  assert.deepEqual(selected.map((item) => item.subject), ["Forbidden City"]);
});

test("Chinese near-duplicates are grouped by character n-grams", () => {
  const left = { raw_text: "故宫需要提前预约，游客应携带护照，从午门进入参观。", author_name: "旅行者" };
  const right = { raw_text: "故宫需提前预约，游客要带护照，从午门入场参观。", author_name: "旅行者" };
  assert.notEqual(classifySourceFamily(left, right).relation, "INDEPENDENT");
});

test("Coverage Matrix blocks approval until required evidence and independent families exist", () => {
  const missing = evaluateCoverage({ topicKey: "beijing:first", contentType: "first_time_guide", facts: [], sourceFamilyCount: 1 });
  assert.equal(missing.readiness.ready, false);
  assert.deepEqual(missing.readiness.blockingRequirements, ["orientation", "transport", "booking", "payment"]);
  const facts = ["orientation.location", "transport.metro", "booking.reservation", "payment.methods"]
    .map((normalized_key) => ({ normalized_key, consensus_status: "corroborated", verification_priority: "normal", freshness_state: "current" }));
  const ready = evaluateCoverage({ topicKey: "beijing:first", contentType: "first_time_guide", facts, sourceFamilyCount: 2 });
  assert.equal(ready.readiness.ready, true);
});

test("focused features and authorized source adaptations use editorial sufficiency instead of encyclopedia coverage", () => {
  const facts = ["selection.best", "items.attraction", "transport.metro", "timing.duration"]
    .map((normalized_key) => ({ normalized_key, consensus_status: "corroborated", verification_priority: "normal", freshness_state: "current" }));
  const feature = evaluateCoverage({ topicKey: "chongqing:photo-spots", contentType: "listicle", facts, sourceFamilyCount: 1, publicationMode: "topic_feature" });
  assert.equal(feature.readiness.ready, true);
  assert.equal(feature.readiness.publicationMode, "topic_feature");
  const adaptation = evaluateCoverage({ topicKey: "chongqing:one-day", contentType: "itinerary", facts, sourceFamilyCount: 1, publicationMode: "source_adaptation" });
  assert.equal(adaptation.readiness.ready, true);
  assert.deepEqual(adaptation.readiness.blockingRequirements, []);
  const synthesis = evaluateCoverage({ topicKey: "chongqing:complete", contentType: "itinerary", facts, sourceFamilyCount: 1 });
  assert.equal(synthesis.readiness.ready, false);
});

test("dated dynamic evidence remains usable and never creates an official-verification blocker", () => {
  const facts = [
    ["orientation.location", "current", "normal"],
    ["transport.metro", "stale", "review"],
    ["booking.reservation", "stale", "requires_official"],
    ["payment.methods", "current", "normal"],
  ].map(([normalized_key, freshness_state, verification_priority]) => ({
    normalized_key, freshness_state, verification_priority, consensus_status: "corroborated",
  }));
  const result = evaluateCoverage({
    topicKey: "beijing:first-dated", contentType: "first_time_guide", facts, sourceFamilyCount: 2,
  });
  assert.equal(result.readiness.ready, true);
  assert.equal(result.readiness.usableFactCount, 4);
  assert.equal(result.readiness.staleCount, 0);
  assert.equal(result.readiness.requiresOfficialCount, 0);
  assert.deepEqual(result.readiness.blockingRequirements, []);
  assert.deepEqual(result.requirements.filter((item) => item.state === "dated"), []);
  assert.equal(result.requirements.every((item) => item.state !== "conflicted"), true);
});

test("an editor can classify an opportunity as create, update, merge, or retire against published inventory", (t) => {
  const { db, repository } = repositoryFixture(t);
  const source = repository.saveCapture(normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/lifecycle-classification",
    title: "Published guide revision",
    text: "A manually selected source for publication lifecycle review.",
    images: [],
  }));
  const timestamp = new Date().toISOString();
  db.prepare(`INSERT INTO wordpress_content_inventory(id,site_url,post_id,slug,title,status,post_url,modified_at,synced_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run("wp-lifecycle", "https://example.test", 42, "existing-guide", "Existing Guide", "publish", "https://example.test/existing-guide/", timestamp, timestamp);
  db.prepare(`INSERT INTO content_opportunities(id,destination_slug,topic_key,strategy_version,source_id,title,readiness_score,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run("opportunity-lifecycle", "beijing", "beijing:existing", "1.5", source.id, "Existing Guide", 100, "recommended", timestamp, timestamp);

  for (const action of ["update", "expand", "merge", "retire"]) {
    const result = repository.setOpportunityLifecycle("opportunity-lifecycle", action, { targetPostId: 42, note: `${action} reviewed`, operator: "editor" });
    assert.equal(result.lifecycleAction, action);
    assert.equal(result.targetPostId, 42);
    assert.equal(result.publicationImpact.requiresEditorialApproval, true);
    assert.equal(result.seoAction, {update:"UPDATE",expand:"EXPAND",merge:"MERGE",retire:"SKIP"}[action]);
  }
  const create = repository.setOpportunityLifecycle("opportunity-lifecycle", "create", { operator: "editor" });
  assert.equal(create.targetPostId, null);
  assert.equal(create.publicationImpact.requiresEditorialApproval, false);
  assert.throws(() => repository.setOpportunityLifecycle("opportunity-lifecycle", "retire", { targetPostId: 404 }), /published WordPress/);
});

test("Claim exclusion and Knowledge visibility are reversible and survive rebuilds", (t) => {
  const { db, repository } = repositoryFixture(t);
  const source = repository.saveCapture(normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/admin-lifecycle", title: "Beijing entry",
    text: "A manually selected source with specific Beijing entry evidence for lifecycle testing.", images: [],
  }));
  repository.saveExtraction(source.id, {
    source: { language: "en", summary: "Entry", destination_name: "Beijing", destination_slug: "beijing", traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.9 },
    claims: [{ key: "beijing.entry.gate", subject: "Example Gate", predicate: "entry gate", value: "East Gate", qualifiers: [], source_quote: "Enter through East Gate", confidence: 0.9 }],
    blueprint: { format: "guide", hook: "Entry", angle: "planning", sections: [], strengths: [], gaps: [] },
  }, "test", "fixture");
  repository.rebuildKnowledge("beijing");
  const fact = repository.getKnowledge()[0];
  repository.setKnowledgeVisibility(fact.id, "hide", "Not suitable for current editorial use", "operator");
  repository.rebuildKnowledge("beijing");
  assert.equal(repository.getKnowledge()[0].visibility_status, "hidden");
  assert.equal(repository.knowledgeForDestination("beijing").length, 0);
  repository.setKnowledgeVisibility(fact.id, "restore", "", "operator");
  repository.rebuildKnowledge("beijing");
  assert.equal(repository.knowledgeForDestination("beijing").length, 1);

  const claimId = db.prepare("SELECT id FROM claims WHERE source_id=?").get(source.id).id;
  repository.setClaimLifecycle(claimId, "exclude", "Incorrect extraction", "operator");
  repository.rebuildKnowledge("beijing");
  assert.equal(db.prepare("SELECT lifecycle_status FROM claims WHERE id=?").get(claimId).lifecycle_status, "excluded");
  assert.equal(repository.knowledgeForDestination("beijing").length, 0);
  repository.setClaimLifecycle(claimId, "restore", "", "operator");
  repository.rebuildKnowledge("beijing");
  assert.equal(repository.knowledgeForDestination("beijing").length, 1);
});

test("derived research reset preserves raw Sources and requeues Strategy 1.4 processing", (t) => {
  const { db, repository } = repositoryFixture(t);
  const source = repository.saveCapture(normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/reset-derived", title: "Chongqing source",
    text: "A manually selected Chongqing source with enough evidence for reset testing.", images: [],
  }));
  repository.saveExtraction(source.id, {
    source: { language: "en", summary: "Source", destination_name: "Chongqing", destination_slug: "chongqing", traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.9 },
    claims: [{ key: "chongqing.route.metro", subject: "Chongqing route", predicate: "metro route", value: "Line 2", qualifiers: [], source_quote: "Take Line 2", confidence: 0.9 }],
    blueprint: { format: "guide", hook: "Route", angle: "planning", sections: [], strengths: [], gaps: [] },
  }, "test", "fixture");
  const timestamp = new Date().toISOString();
  db.prepare(`INSERT INTO content_opportunities(id,destination_slug,topic_key,strategy_version,source_id,title,readiness_score,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run("opportunity-reset", "chongqing", "chongqing:practical_guide:route", "1.4", source.id, "Route", 100, "approved_ready", timestamp, timestamp);
  db.prepare(`INSERT INTO topic_candidates(id,destination_slug,topic_key,proposed_title,rationale,coverage_score,evidence_count,conflict_count,status,created_at,updated_at,opportunity_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run("candidate-reset", "chongqing", "chongqing:route", "Route", "Ready", 100, 1, 0, "candidate", timestamp, timestamp, "opportunity-reset");
  db.prepare("UPDATE content_opportunities SET candidate_id=? WHERE id=?").run("candidate-reset", "opportunity-reset");
  const reset = repository.resetDerivedResearchAndRequeue();
  assert.equal(reset.preservedSources, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM sources").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM claims").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM content_opportunities").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM topic_candidates").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM jobs WHERE type='extract_source' AND entity_id=?").get(source.id).count, 1);
});

test("chunked upload accepts videos above 100 MB and validates completed video signatures", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stc-chunked-upload-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manager = new ChunkedUploadManager({ uploadDir: directory, maxVideoBytes: 256 * 1024 * 1024 });
  const large = manager.create({ kind: "video", name: "large.mp4", mimeType: "video/mp4", size: 101 * 1024 * 1024 });
  assert.ok(large.chunkCount > 20);

  const size = 6 * 1024 * 1024;
  const bytes = Buffer.alloc(size);
  bytes.writeUInt32BE(24, 0);
  bytes.write("ftyp", 4, "ascii");
  const session = manager.create({ kind: "video", name: "route.mp4", mimeType: "video/mp4", size });
  for (let index = 0; index < session.chunkCount; index += 1) {
    const start = index * session.chunkBytes;
    manager.writeChunk(session.uploadId, index, bytes.subarray(start, Math.min(size, start + session.chunkBytes)));
  }
  const completed = manager.complete(session.uploadId, { title: "Route video" });
  assert.equal(completed.capture.files[0].sizeBytes, size);
  assert.equal(completed.capture.sourceKind, "video");
  completed.cleanup();
});
