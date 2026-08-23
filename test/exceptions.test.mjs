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
