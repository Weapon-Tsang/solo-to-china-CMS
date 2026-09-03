import assert from "node:assert/strict";
import test from "node:test";
import { normalizeXiaohongshuCapture } from "../src/adapters/xiaohongshu.mjs";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";

test("operational exception queue exposes and safely retries an exhausted generic job", (t) => {
  const { db, repository } = repositoryFixture(t);
  const jobId = repository.enqueue("plan_content", "missing-topic");
  db.prepare("UPDATE jobs SET status='failed', attempts=3, last_error='planner unavailable' WHERE id=?").run(jobId);
  const exception = repository.listOperationalExceptions().find((item) => item.key === `job:${jobId}`);
  assert.equal(exception.severity, "blocker");
  assert.equal(exception.retryable, true);
  assert.equal(repository.retryOperationalException(exception.key), true);
  const job = db.prepare("SELECT status, attempts, last_error FROM jobs WHERE id=?").get(jobId);
  assert.equal(job.status, "queued");
  assert.equal(job.attempts, 0);
  assert.equal(job.last_error, null);
});

test("source retry resets a delayed queued extraction and never masks a running extraction as captured", (t) => {
  const { db, repository } = repositoryFixture(t);
  const source = repository.saveCapture(normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/retry-state",
    title: "Retry state",
    text: "This manually selected travel note has enough source text for a safe retry-state test.",
    images: [],
  }));
  const job = db.prepare("SELECT * FROM jobs WHERE type='extract_source' AND entity_id=?").get(source.id);
  db.prepare("UPDATE jobs SET attempts=2, available_at='2099-01-01T00:00:00.000Z', last_error='quota' WHERE id=?").run(job.id);
  db.prepare("UPDATE sources SET status='exception', last_error='quota' WHERE id=?").run(source.id);

  assert.equal(repository.retrySource(source.id), true);
  let retried = db.prepare("SELECT * FROM jobs WHERE id=?").get(job.id);
  assert.equal(retried.status, "queued");
  assert.equal(retried.attempts, 0);
  assert.equal(retried.last_error, null);
  assert.ok(Date.parse(retried.available_at) <= Date.now());
  assert.equal(db.prepare("SELECT status FROM sources WHERE id=?").get(source.id).status, "queued");

  assert.equal(repository.claimJob().id, job.id);
  assert.equal(repository.retrySource(source.id), true);
  retried = db.prepare("SELECT * FROM jobs WHERE type='extract_source' AND entity_id=? AND status IN ('queued','running')").all(source.id);
  assert.equal(retried.length, 1);
  assert.equal(retried[0].status, "running");
  assert.equal(db.prepare("SELECT status FROM sources WHERE id=?").get(source.id).status, "processing");
});

test("a warning knowledge conflict can be resolved by an administrator and then leaves the exception queue", (t) => {
  const { db, repository } = repositoryFixture(t);
  db.prepare("INSERT INTO destinations(id, slug, name, created_at, updated_at) VALUES ('dst1', 'chongqing', 'Chongqing', 'now', 'now')").run();
  db.prepare(`
    INSERT INTO knowledge_facts(id, destination_id, normalized_key, subject, predicate, consensus_status,
      preferred_value, support_count, contradiction_count, evidence_json, updated_at,
      freshness_state, latest_evidence_at, verification_priority)
    VALUES ('fact1', 'dst1', 'hongyadong.lighting', 'Hongyadong', 'has evening lighting', 'conflicted',
      '20:00-23:00', 1, 1, ?, '2026-09-02T00:00:00.000Z', 'current', '2026-09-02T00:00:00.000Z', 'requires_official')
  `).run(JSON.stringify([
    { source_id: 'source-a', value: '20:00-23:00', quote: 'lighting is on 20:00-23:00' },
    { source_id: 'source-b', value: '19:30-22:30', quote: 'lights start at 19:30' },
  ]));

  const exception = repository.listOperationalExceptions().find((item) => item.key === "knowledge:fact1");
  assert.equal(exception.severity, "warning");
  assert.equal(exception.knowledge.id, "fact1");

  const resolution = repository.resolveKnowledgeConflict("fact1", "19:30-22:30", "Verified against the operator notice.");
  assert.equal(resolution.preferredValue, "19:30-22:30");
  assert.equal(repository.listOperationalExceptions().some((item) => item.key === "knowledge:fact1"), false);
  const fact = repository.getKnowledge().find((item) => item.id === "fact1");
  assert.equal(fact.consensus_status, "resolved");
  assert.equal(fact.preferred_value, "19:30-22:30");
  assert.equal(fact.verification_priority, "manual_confirmed");
  assert.equal(fact.manual_resolution.note, "Verified against the operator notice.");
  assert.equal(repository.dashboard().totals.conflicts, 0);
});

test("extraction review dismissals survive rebuilds while legacy acknowledgements reopen for real correction", (t) => {
  const { db, repository } = repositoryFixture(t);
  const source = repository.saveCapture(normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/extraction-review",
    title: "Chongqing reservation note",
    text: "这是一篇人工筛选保存的重庆旅行笔记，原文说明重庆景点无需提前预约。",
    images: [],
  }));
  repository.saveExtraction(source.id, {
    source: { language: "zh-CN", summary: "Reservation", destination_name: "Chongqing", destination_slug: "chongqing", traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.9 },
    claims: [{ key: "chongqing.reservation", subject: "Chongqing attraction", predicate: "reservation information", value: "advance reservation", qualifiers: [], source_quote: "无需提前预约", confidence: 0.9 }],
    blueprint: { format: "guide", hook: "Booking", angle: "practical", sections: [], strengths: [], gaps: [] },
  }, "test", "fixture-model");

  repository.rebuildKnowledge("chongqing");
  let review = db.prepare("SELECT * FROM claim_review_cases").get();
  assert.equal(review.status, "pending");
  const exception = repository.listOperationalExceptions().find((item) => item.claim_review?.id === review.id);
  assert.equal(exception.claim_review.claimA.sourceId, source.id);
  assert.throws(() => repository.decideClaimReviewCase(review.id, "resolved"), /can only be resolved by re-extracting/);

  repository.decideClaimReviewCase(review.id, "dismissed");
  repository.rebuildKnowledge("chongqing");
  review = db.prepare("SELECT * FROM claim_review_cases").get();
  assert.equal(review.status, "dismissed");
  assert.equal(repository.listOperationalExceptions().some((item) => item.claim_review?.id === review.id), false);

  db.prepare("UPDATE claim_review_cases SET status='resolved' WHERE id=?").run(review.id);
  repository.rebuildKnowledge("chongqing");
  review = db.prepare("SELECT * FROM claim_review_cases").get();
  assert.equal(review.status, "pending");
});
