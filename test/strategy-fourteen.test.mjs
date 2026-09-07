import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeXiaohongshuCapture } from "../src/adapters/xiaohongshu.mjs";
import { ChunkedUploadManager } from "../src/chunked-upload.mjs";
import { evaluateCoverage, segmentSource } from "../src/research-strategy.mjs";
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

test("Coverage Matrix blocks approval until required evidence and independent families exist", () => {
  const missing = evaluateCoverage({ topicKey: "beijing:first", contentType: "first_time_guide", facts: [], sourceFamilyCount: 1 });
  assert.equal(missing.readiness.ready, false);
  assert.deepEqual(missing.readiness.blockingRequirements, ["orientation", "transport", "booking", "payment"]);
  const facts = ["orientation.location", "transport.metro", "booking.reservation", "payment.methods"]
    .map((normalized_key) => ({ normalized_key, consensus_status: "corroborated", verification_priority: "normal", freshness_state: "current" }));
  const ready = evaluateCoverage({ topicKey: "beijing:first", contentType: "first_time_guide", facts, sourceFamilyCount: 2 });
  assert.equal(ready.readiness.ready, true);
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
  const reset = repository.resetDerivedResearchAndRequeue();
  assert.equal(reset.preservedSources, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM sources").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM claims").get().count, 0);
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
