import assert from "node:assert/strict";
import test from "node:test";
import { normalizeXiaohongshuCapture } from "../src/adapters/xiaohongshu.mjs";
import { Pipeline } from "../src/pipeline.mjs";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";

const extraction = (title) => ({
  result: {
    source: { language: "zh-CN", summary: title, destination_name: "Chongqing", destination_slug: "chongqing", traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.9 },
    claims: [{ key: `route.${title.toLowerCase()}`, subject: title, predicate: "suggested_route", value: title, qualifiers: [], confidence: 0.9, source_quote: title,
      claim_role: "recommendation", knowledge_eligible: true }],
    blueprint: { format: "pending-separate-analysis", hook: "", angle: "", sections: [], strengths: [], gaps: [] },
  },
  method: "vertex_batch",
  model: "gemini-3.8-flash",
});

test("large extraction backlog stays queued while Vertex Batch runs and updates only on completion", async (t) => {
  const { db, repository } = repositoryFixture(t);
  for (const [index, title] of ["Route A", "Route B"].entries()) {
    const source = repository.saveCapture(normalizeXiaohongshuCapture({
      url: `https://www.xiaohongshu.com/explore/${index ? "68abcdef0000000000000002" : "68abcdef0000000000000001"}`,
      title,
      text: `${title} is a complete selected Chongqing itinerary with practical steps for independent visitors.`,
      images: [],
    }));
    const [segment] = repository.prepareSourceSegments(source.id);
    repository.enqueue("extract_segment_claims", segment.id);
  }
  const extractor = {
    batchEnabled: true,
    config: { batchMinimumRequests: 2, batchMaximumRequests: 10, batchPollMs: 1, model: "gemini-3.8-flash", location: "global" },
    async prepareBatchExtraction(_source, id) { return { id, request: { contents: [] } }; },
    async createExtractionBatch(requests) { return { name: "projects/p/locations/global/batchPredictionJobs/job-1", inputUri: "gs://bucket/input.jsonl", outputUriPrefix: "gs://bucket/output/", state: "JOB_STATE_PENDING", itemIds: requests.map((item) => item.id), pollMs: 1 }; },
    async getExtractionBatch() { return { state: "JOB_STATE_SUCCEEDED", outputInfo: { gcsOutputDirectory: "gs://bucket/output/job-1/" } }; },
    async readExtractionBatch() {
      return db.prepare("SELECT batch_item_id FROM vertex_batch_items WHERE status='submitted' ORDER BY rowid").all()
        .map((item) => ({ id: item.batch_item_id, output: { title: item.batch_item_id } }));
    },
    parseBatchExtraction(item) { return extraction(item.id); },
    async cleanupExtractionBatch() {},
  };
  const pipeline = new Pipeline(repository, extractor, { maxConcurrent: 1 });
  assert.equal(repository.countVertexBatchEligibleJobs(), 2);
  assert.equal(await pipeline.pumpVertexBatch(), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM vertex_batch_runs WHERE status='submitted'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type='extract_segment_claims' AND status='queued'").get().count, 2);
  db.prepare("UPDATE vertex_batch_runs SET next_poll_at=datetime('now','-1 minute') WHERE status='submitted'").run();
  assert.equal(await pipeline.pumpVertexBatch(), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type='extract_segment_claims' AND status='succeeded'").get().count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type='audit_segment_coverage' AND status='queued'").get().count, 2);
  assert.equal(db.prepare("SELECT succeeded_count FROM vertex_batch_runs").get().succeeded_count, 2);
});

test("large text coverage backlog also uses Vertex Batch and completes only after output import", async (t) => {
  const { db, repository } = repositoryFixture(t);
  for (const [index, title] of ["Coverage A", "Coverage B"].entries()) {
    const source = repository.saveCapture(normalizeXiaohongshuCapture({
      url: `https://www.xiaohongshu.com/explore/${index ? "68abcdef0000000000000012" : "68abcdef0000000000000011"}`,
      title,
      text: `${title} is a complete selected Chongqing itinerary with practical steps for independent visitors.`,
      images: [],
    }));
    const [segment] = repository.prepareSourceSegments(source.id);
    assert.equal(repository.saveSegmentExtraction(segment.id, extraction(title)), true);
    repository.enqueue("audit_segment_coverage", segment.id);
  }
  const extractor = {
    batchEnabled: true,
    config: { batchMinimumRequests: 2, batchMaximumRequests: 10, batchPollMs: 1, model: "gemini-3.8-flash", location: "global" },
    async prepareBatchCoverage(_pack, id) { return { id, request: { contents: [] } }; },
    async createExtractionBatch(requests) { return { name: "projects/p/locations/global/batchPredictionJobs/audit-1", inputUri: "gs://bucket/input.jsonl", outputUriPrefix: "gs://bucket/output/", state: "JOB_STATE_PENDING", itemIds: requests.map((item) => item.id), pollMs: 1 }; },
    async getExtractionBatch() { return { state: "JOB_STATE_SUCCEEDED", outputInfo: { gcsOutputDirectory: "gs://bucket/output/audit-1/" } }; },
    async readExtractionBatch() {
      return db.prepare("SELECT batch_item_id FROM vertex_batch_items WHERE status='submitted' ORDER BY rowid").all()
        .map((item) => ({ id: item.batch_item_id, output: { uncovered_spans: [] } }));
    },
    parseBatchCoverage() { return { output: { uncovered_spans: [], modality: { expected: "text", received: "text", attempted: 0 } } }; },
    async cleanupExtractionBatch() {},
  };
  const pipeline = new Pipeline(repository, extractor, { maxConcurrent: 1 });
  assert.equal(repository.countVertexBatchEligibleJobs("audit_segment_coverage"), 2);
  assert.equal(await pipeline.pumpVertexBatch(), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type='audit_segment_coverage' AND status='queued'").get().count, 2);
  db.prepare("UPDATE vertex_batch_runs SET next_poll_at=datetime('now','-1 minute') WHERE status='submitted'").run();
  assert.equal(await pipeline.pumpVertexBatch(), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type='audit_segment_coverage' AND status='succeeded'").get().count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM extraction_coverage WHERE status='passed'").get().count, 2);
  assert.equal(db.prepare("SELECT succeeded_count FROM vertex_batch_runs").get().succeeded_count, 2);
});
