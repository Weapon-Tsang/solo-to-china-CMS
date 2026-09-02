import assert from "node:assert/strict";
import test from "node:test";
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
