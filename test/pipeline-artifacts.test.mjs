import assert from "node:assert/strict";
import test from "node:test";
import { normalizeXiaohongshuCapture } from "../src/adapters/xiaohongshu.mjs";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";

function capturedSource(repository, suffix = "41") {
  return repository.saveCapture(normalizeXiaohongshuCapture({
    url: `https://www.xiaohongshu.com/explore/68abcdef00000000000000${suffix}`,
    title: "Bounded pipeline source",
    text: "This manually selected source contains enough stable text to exercise resumable extraction and dependency reuse.", images: [],
  }));
}

test("a completed dependency artifact makes duplicate model scheduling reusable", (t) => {
  const { repository } = repositoryFixture(t);
  const source = capturedSource(repository);
  const [segment] = repository.prepareSourceSegments(source.id);
  const job = { type: "extract_segment_claims", entity_id: segment.id };
  const first = repository.preparePipelineArtifact(job, "config-1");
  assert.equal(first.reused, false);
  repository.saveSegmentExtraction(segment.id, { result: {
    source: { language: "en", summary: "Summary", destination_name: "Chongqing", destination_slug: "chongqing",
      traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.9 },
    claims: [{ key: "transport.metro", subject: "Metro", predicate: "access", value: "available", qualifiers: [],
      confidence: 0.9, source_quote: "stable text" }],
  }, method: "test", model: "fixed" });
  repository.completePipelineArtifact(first, job);
  const duplicate = repository.preparePipelineArtifact(job, "config-1");
  assert.equal(duplicate.reused, true);
  assert.ok(duplicate.input_hash && duplicate.output_hash);
  assert.equal(repository.preparePipelineArtifact(job, "config-2").reused, false);
});

test("entity resolution pages through the entire claim set instead of truncating at the newest 300", (t) => {
  const { repository } = repositoryFixture(t);
  const source = capturedSource(repository, "42");
  repository.saveExtraction(source.id, {
    source: { language: "en", summary: "Large evidence set", destination_name: "Chongqing", destination_slug: "chongqing",
      traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.9 },
    claims: Array.from({ length: 305 }, (_, index) => ({ key: `test.fact.${String(index).padStart(3, "0")}`,
      subject: `Place ${index}`, predicate: "detail", value: `Value ${index}`, qualifiers: [], confidence: 0.9,
      source_quote: `Evidence quote ${index}` })),
    blueprint: { format: "guide", hook: "Test", angle: "Test", sections: [], strengths: [], gaps: [] },
  }, "test", "fixture-model");
  const first = repository.getEntityResolutionPackage("chongqing", 300);
  const second = repository.getEntityResolutionPackage("chongqing", 300, first.nextCursor);
  assert.equal(first.claims.length, 300);
  assert.equal(second.claims.length, 5);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.claims, ...second.claims].map((claim) => claim.id)).size, 305);
});

test("queue policy exposes age, keeps interactive Research ahead of production, and reports only measured percentiles", (t) => {
  const { db, repository } = repositoryFixture(t);
  const source = capturedSource(repository, "43");
  db.prepare("DELETE FROM jobs").run();
  repository.enqueue("extract_segment_claims", "segment-new");
  repository.enqueue("preflight_source", source.id);
  repository.enqueue("review_draft", "draft-new");
  const claimed = repository.claimJob();
  assert.equal(claimed.type, "extract_segment_claims");
  repository.completeJob(claimed.id);
  const report = repository.pipelinePerformanceReport({ concurrency: 2 });
  assert.equal(report.environment.concurrency, 2);
  assert.equal(report.durationMs.samples, 1);
  assert.equal(report.durationMs.p95, null);
  assert.equal(report.databaseQueryCount, null);

  const queued = repository.listSources(10).find((item) => item.id === source.id)?.queue;
  assert.equal(queued.state, "queued");
  assert.ok(Number.isInteger(queued.queue_age_ms));
});
