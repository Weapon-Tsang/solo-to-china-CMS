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

test("an image Batch persists its submitted asset manifest and passes local modality coverage", async (t) => {
  const { db, repository } = repositoryFixture(t);
  const source = repository.saveCapture(normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/68abcdef0000000000000211",
    title: "Batch image",
    text: "A selected image source with enough context for deterministic pipeline coverage.",
    images: [{ url: "https://example.com/batch-image.jpg", alt: "Hongyadong night view" }],
  }));
  const imageSegment = repository.prepareSourceSegments(source.id).find((item) => item.assetId);
  repository.enqueue("extract_segment_claims", imageSegment.id);
  let parsed = 0;
  const extractor = {
    batchEnabled: true,
    config: { batchMinimumRequests: 1, batchMaximumRequests: 10, batchPollMs: 1, model: "gemini-3.8-flash", location: "global" },
    async prepareBatchExtraction(pack, id) {
      const asset = pack.assets[0];
      return { id, request: { contents: [] }, inputManifest: { version: 1, expectedModality: "image", receivedModality: "image",
        provider: "vertex", model: "gemini-3.8-flash", capabilities: { text: true, image: true, video: false, batch: true },
        assets: [{ assetId: asset.id, hash: asset.original_sha256 || null, kind: "image", status: "submitted", requestReference: "inline_data" }] } };
    },
    async createExtractionBatch(requests) { return { name: "projects/p/locations/global/batchPredictionJobs/image-1", inputUri: "gs://bucket/input.jsonl", outputUriPrefix: "gs://bucket/output/", state: "JOB_STATE_PENDING", itemIds: requests.map((item) => item.id), pollMs: 1 }; },
    async getExtractionBatch() { return { state: "JOB_STATE_SUCCEEDED", outputInfo: { gcsOutputDirectory: "gs://bucket/output/image-1/" } }; },
    async readExtractionBatch() {
      return db.prepare("SELECT batch_item_id FROM vertex_batch_items WHERE status='submitted'").all()
        .map((item) => ({ id: item.batch_item_id, output: {} }));
    },
    parseBatchExtraction(_item, context) { parsed += 1; return { ...extraction("Batch image"), inputManifest: context.inputManifest }; },
    async cleanupExtractionBatch() {},
  };
  const pipeline = new Pipeline(repository, extractor, { maxConcurrent: 1 });
  assert.equal(await pipeline.pumpVertexBatch(), true);
  db.prepare("UPDATE vertex_batch_runs SET next_poll_at=datetime('now','-1 minute') WHERE status='submitted'").run();
  assert.equal(await pipeline.pumpVertexBatch(), true);
  assert.equal(parsed, 1);
  assert.equal(db.prepare("SELECT input_modality FROM segment_extractions WHERE segment_id=?").get(imageSegment.id).input_modality, "image");
  assert.equal(repository.auditSegmentCoverage(imageSegment.id).status, "passed");
});

test("a transient Batch output read failure defers ingestion without cleanup or another model request", async (t) => {
  const { db, repository } = repositoryFixture(t);
  const source = repository.saveCapture(normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/68abcdef0000000000000212",
    title: "Recoverable output",
    text: "A complete selected Chongqing source whose finished Batch output must survive a temporary storage error.",
    images: [],
  }));
  const [segment] = repository.prepareSourceSegments(source.id);
  repository.enqueue("extract_segment_claims", segment.id);
  let submissions = 0;
  let reads = 0;
  let cleanups = 0;
  const extractor = {
    batchEnabled: true,
    config: { batchMinimumRequests: 1, batchMaximumRequests: 10, batchPollMs: 1, model: "gemini-3.8-flash", location: "global" },
    async prepareBatchExtraction(_pack, id) { return { id, request: { contents: [] }, inputManifest: { version: 1,
      expectedModality: "text", receivedModality: "text", provider: "vertex", model: "gemini-3.8-flash",
      capabilities: { text: true, image: true, video: false, batch: true }, assets: [] } }; },
    async createExtractionBatch(requests) { submissions += 1; return { name: "projects/p/locations/global/batchPredictionJobs/read-retry-1",
      inputUri: "gs://bucket/input.jsonl", outputUriPrefix: "gs://bucket/output/", state: "JOB_STATE_PENDING",
      itemIds: requests.map((item) => item.id), pollMs: 1 }; },
    async getExtractionBatch() { return { state: "JOB_STATE_SUCCEEDED", outputInfo: { gcsOutputDirectory: "gs://bucket/output/read-retry-1/" } }; },
    async readExtractionBatch() {
      reads += 1;
      if (reads === 1) throw Object.assign(new Error("Cloud Storage batch output download failed (503)."), { retryable: true });
      const item = db.prepare("SELECT batch_item_id FROM vertex_batch_items WHERE status='submitted'").get();
      return [{ id: item.batch_item_id, output: {}, transport: { objectName: "prediction.results-00000-of-00001.jsonl",
        lineNumber: 1, checksum: "fixture-output-sha256" } }];
    },
    parseBatchExtraction(_item, context) { return { ...extraction("Recoverable output"), inputManifest: context.inputManifest }; },
    async cleanupExtractionBatch() { cleanups += 1; },
  };
  const pipeline = new Pipeline(repository, extractor, { maxConcurrent: 1 });
  assert.equal(await pipeline.pumpVertexBatch(), true);
  db.prepare("UPDATE vertex_batch_runs SET next_poll_at=datetime('now','-1 minute') WHERE status='submitted'").run();
  assert.equal(await pipeline.pumpVertexBatch(), false);
  assert.equal(submissions, 1);
  assert.equal(cleanups, 0);
  assert.equal(db.prepare("SELECT status FROM vertex_batch_items").get().status, "submitted");
  assert.equal(db.prepare("SELECT status FROM vertex_batch_runs").get().status, "submitted");
  db.prepare("UPDATE vertex_batch_runs SET next_poll_at=datetime('now','-1 minute') WHERE status='submitted'").run();
  assert.equal(await pipeline.pumpVertexBatch(), true);
  assert.equal(submissions, 1);
  assert.equal(cleanups, 1);
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id=(SELECT job_id FROM vertex_batch_items)").get().status, "succeeded");
  assert.equal(db.prepare("SELECT output_checksum FROM vertex_batch_items").get().output_checksum, "fixture-output-sha256");
});

test("Batch ingestion resumes after a per-item commit without replaying the committed item", async (t) => {
  const { db, repository } = repositoryFixture(t);
  for (const [index, title] of ["Resume A", "Resume B"].entries()) {
    const source = repository.saveCapture(normalizeXiaohongshuCapture({
      url: `https://www.xiaohongshu.com/explore/${index ? "68abcdef0000000000000214" : "68abcdef0000000000000213"}`,
      title, text: `${title} is a complete selected source with enough detail for resumable ingestion.`, images: [],
    }));
    const [segment] = repository.prepareSourceSegments(source.id);
    repository.enqueue("extract_segment_claims", segment.id);
  }
  const run = repository.reserveVertexBatchJobs({ minimum: 2, maximum: 2, model: "gemini-3.8-flash", location: "global" });
  repository.activateVertexBatch(run.id, { name: "projects/p/locations/global/batchPredictionJobs/resume-1",
    inputUri: "gs://bucket/input.jsonl", outputUriPrefix: "gs://bucket/output/", state: "JOB_STATE_SUCCEEDED",
    itemIds: run.items.map((item) => item.batch_item_id), pollMs: 1 });
  const first = repository.dueVertexBatch() || { ...run, items: db.prepare(`SELECT vbi.*,j.type AS job_type FROM vertex_batch_items vbi
    JOIN jobs j ON j.id=vbi.job_id WHERE vbi.run_id=? AND vbi.status='submitted' ORDER BY vbi.rowid`).all(run.id) };
  repository.completeVertexBatchItem(first, first.items[0], extraction("Resume A"),
    { objectName: "prediction.jsonl", lineNumber: 1, checksum: "resume-a" });
  db.prepare("UPDATE vertex_batch_runs SET next_poll_at=datetime('now','-1 minute') WHERE id=?").run(run.id);
  const parsedIds = [];
  const extractor = {
    batchEnabled: true,
    config: { batchMinimumRequests: 2, batchMaximumRequests: 2, batchPollMs: 1, model: "gemini-3.8-flash" },
    async getExtractionBatch() { return { state: "JOB_STATE_SUCCEEDED", outputInfo: { gcsOutputDirectory: "gs://bucket/output/resume-1/" } }; },
    async readExtractionBatch() { return run.items.map((item, index) => ({ id: item.batch_item_id, output: {},
      transport: { objectName: "prediction.jsonl", lineNumber: index + 1, checksum: `resume-${index}` } })); },
    parseBatchExtraction(item) { parsedIds.push(item.id); return extraction(item.id); },
    async cleanupExtractionBatch() {},
  };
  const pipeline = new Pipeline(repository, extractor);
  assert.equal(await pipeline.pumpVertexBatch(), true);
  assert.deepEqual(parsedIds, [run.items[1].batch_item_id]);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM segment_extractions").get().count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM vertex_batch_items WHERE status='succeeded'").get().count, 2);
});

test("partial or missing Batch output is quarantined and retained instead of marked succeeded", async (t) => {
  const { db, repository } = repositoryFixture(t);
  for (const [index, title] of ["Partial A", "Partial B"].entries()) {
    const source = repository.saveCapture(normalizeXiaohongshuCapture({
      url: `https://www.xiaohongshu.com/explore/${index ? "68abcdef0000000000000216" : "68abcdef0000000000000215"}`,
      title, text: `${title} is a complete selected source with enough detail for partial output handling.`, images: [],
    }));
    const [segment] = repository.prepareSourceSegments(source.id);
    repository.enqueue("extract_segment_claims", segment.id);
  }
  let cleanups = 0;
  const extractor = {
    batchEnabled: true,
    config: { batchMinimumRequests: 2, batchMaximumRequests: 2, batchPollMs: 1, batchOutputReadMaxAttempts: 1,
      model: "gemini-3.8-flash", location: "global" },
    async prepareBatchExtraction(_pack, id) { return { id, request: { contents: [] } }; },
    async createExtractionBatch(requests) { return { name: "projects/p/locations/global/batchPredictionJobs/partial-1",
      inputUri: "gs://bucket/input.jsonl", outputUriPrefix: "gs://bucket/output/", state: "JOB_STATE_PENDING",
      itemIds: requests.map((item) => item.id), pollMs: 1 }; },
    async getExtractionBatch() { return { state: "JOB_STATE_PARTIALLY_SUCCEEDED", outputInfo: { gcsOutputDirectory: "gs://bucket/output/partial-1/" } }; },
    async readExtractionBatch() {
      const [item] = db.prepare("SELECT batch_item_id FROM vertex_batch_items WHERE status='submitted' ORDER BY rowid").all();
      return [{ id: item.batch_item_id, output: {}, transport: { objectName: "prediction.jsonl", lineNumber: 1, checksum: "partial-a" } }];
    },
    parseBatchExtraction(item) { return extraction(item.id); },
    async cleanupExtractionBatch() { cleanups += 1; },
  };
  const pipeline = new Pipeline(repository, extractor);
  assert.equal(await pipeline.pumpVertexBatch(), true);
  db.prepare("UPDATE vertex_batch_runs SET next_poll_at=datetime('now','-1 minute') WHERE status='submitted'").run();
  assert.equal(await pipeline.pumpVertexBatch(), true);
  const stored = db.prepare("SELECT status,result_state,succeeded_count,failed_count FROM vertex_batch_runs").get();
  assert.equal(stored.status, "failed");
  assert.equal(stored.result_state, "quarantined");
  assert.equal(stored.succeeded_count, 1);
  assert.equal(stored.failed_count, 1);
  assert.equal(cleanups, 0);
});

test("transport keys keep out-of-order rows distinct when the model repeats its own ID", async (t) => {
  const { db, repository } = repositoryFixture(t);
  for (const [index, title] of ["Transport A", "Transport B"].entries()) {
    const source = repository.saveCapture(normalizeXiaohongshuCapture({
      url: `https://www.xiaohongshu.com/explore/${index ? "68abcdef0000000000000218" : "68abcdef0000000000000217"}`,
      title, text: `${title} is a complete selected source with enough detail for transport correlation.`, images: [],
    }));
    const [segment] = repository.prepareSourceSegments(source.id);
    repository.enqueue("extract_segment_claims", segment.id);
  }
  const extractor = {
    batchEnabled: true,
    config: { batchMinimumRequests: 2, batchMaximumRequests: 2, batchPollMs: 1, model: "gemini-3.8-flash", location: "global" },
    async prepareBatchExtraction(_pack, id) { return { id, transportKey: id, request: { contents: [{ id }] } }; },
    async createExtractionBatch(requests) { return { name: "projects/p/locations/global/batchPredictionJobs/correlation-1",
      inputUri: "gs://bucket/input.jsonl", outputUriPrefix: "gs://bucket/output/", state: "JOB_STATE_PENDING",
      itemIds: requests.map((item) => item.id), pollMs: 1 }; },
    async getExtractionBatch() { return { state: "JOB_STATE_SUCCEEDED", outputInfo: { gcsOutputDirectory: "gs://bucket/output/correlation-1/" } }; },
    async readExtractionBatch() {
      const items = db.prepare("SELECT transport_key,request_fingerprint FROM vertex_batch_items WHERE status='submitted' ORDER BY rowid DESC").all();
      return items.map((item, index) => ({ id: index ? item.transport_key : "", requestFingerprint: index ? "" : item.request_fingerprint,
        modelReportedId: "model-duplicate-id", output: { title: index ? "Transport A" : "Transport B" },
        transport: { objectName: "prediction.jsonl", lineNumber: index + 1, checksum: `correlation-${index}` } }));
    },
    parseBatchExtraction(item) { return extraction(item.output.title); },
    async cleanupExtractionBatch() {},
  };
  const pipeline = new Pipeline(repository, extractor);
  assert.equal(await pipeline.pumpVertexBatch(), true);
  db.prepare("UPDATE vertex_batch_runs SET next_poll_at=datetime('now','-1 minute') WHERE status='submitted'").run();
  assert.equal(await pipeline.pumpVertexBatch(), true);
  assert.deepEqual(db.prepare("SELECT json_extract(result_json,'$.source.summary') AS title FROM segment_extractions ORDER BY title").all().map((row) => row.title),
    ["Transport A", "Transport B"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM vertex_batch_items WHERE correlation_warning<>''").get().count, 2);
});

test("duplicate transport rows are quarantined and MAX_TOKENS falls back per item to realtime", async (t) => {
  const { db, repository } = repositoryFixture(t);
  for (const [index, title] of ["Duplicate A", "Duplicate B"].entries()) {
    const source = repository.saveCapture(normalizeXiaohongshuCapture({
      url: `https://www.xiaohongshu.com/explore/${index ? "68abcdef0000000000000220" : "68abcdef0000000000000219"}`,
      title, text: `${title} is a complete selected source with enough detail for duplicate output isolation.`, images: [],
    }));
    const [segment] = repository.prepareSourceSegments(source.id);
    repository.enqueue("extract_segment_claims", segment.id);
  }
  const extractor = {
    batchEnabled: true,
    config: { batchMinimumRequests: 2, batchMaximumRequests: 2, batchPollMs: 1, batchOutputReadMaxAttempts: 1,
      model: "gemini-3.8-flash", location: "global" },
    async prepareBatchExtraction(_pack, id) { return { id, transportKey: id, request: { contents: [{ id }] } }; },
    async createExtractionBatch(requests) { return { name: "projects/p/locations/global/batchPredictionJobs/duplicate-1",
      inputUri: "gs://bucket/input.jsonl", outputUriPrefix: "gs://bucket/output/", state: "JOB_STATE_PENDING",
      itemIds: requests.map((item) => item.id), pollMs: 1 }; },
    async getExtractionBatch() { return { state: "JOB_STATE_PARTIALLY_SUCCEEDED", outputInfo: { gcsOutputDirectory: "gs://bucket/output/duplicate-1/" } }; },
    async readExtractionBatch() {
      const [first, second] = db.prepare("SELECT transport_key FROM vertex_batch_items WHERE status='submitted' ORDER BY rowid").all();
      return [
        { id: first.transport_key, output: {}, transport: { objectName: "prediction.jsonl", lineNumber: 1, checksum: "duplicate-1" } },
        { id: first.transport_key, output: {}, transport: { objectName: "prediction.jsonl", lineNumber: 2, checksum: "duplicate-2" } },
        { id: second.transport_key, error: "Vertex Batch structured output reached its token limit.", code: "MODEL_OUTPUT_LIMIT",
          finishReason: "MAX_TOKENS", transport: { objectName: "prediction.jsonl", lineNumber: 3, checksum: "limit-1" } },
      ];
    },
    parseBatchExtraction(item) {
      if (item.error) throw Object.assign(new Error(item.error), { code: item.code, retryable: true });
      return extraction("unexpected");
    },
    async cleanupExtractionBatch() { assert.fail("quarantined output must be retained"); },
  };
  const pipeline = new Pipeline(repository, extractor);
  assert.equal(await pipeline.pumpVertexBatch(), true);
  db.prepare("UPDATE vertex_batch_runs SET next_poll_at=datetime('now','-1 minute') WHERE status='submitted'").run();
  assert.equal(await pipeline.pumpVertexBatch(), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM segment_extractions").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM vertex_batch_output_anomalies").get().count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE execution_route='realtime'").get().count, 2);
  assert.equal(db.prepare("SELECT result_state FROM vertex_batch_runs").get().result_state, "quarantined");
});
