import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db.mjs";
import { createLogger } from "../src/logger.mjs";
import { ExceptionNotifier } from "../src/notifications.mjs";
import { Repository } from "../src/repository.mjs";

test("job telemetry reports durable queue latency, duration, outcomes, and active work", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-telemetry-test-"));
  const database = openDatabase(path.join(directory, "telemetry.sqlite"));
  const repository = new Repository(database);
  try {
    const succeededId = repository.enqueue("rebuild_editorial", "global");
    const succeeded = repository.claimJob();
    assert.equal(succeeded.id, succeededId);
    repository.completeJob(succeeded.id);

    const failedId = repository.enqueue("plan_content", "missing");
    database.prepare("UPDATE jobs SET max_attempts=1 WHERE id=?").run(failedId);
    const failed = repository.claimJob();
    repository.failJob(failed, new Error("planned failure"));

    repository.enqueue("rebuild_knowledge", "chengdu");
    const telemetry = repository.jobTelemetry(24);
    assert.equal(telemetry.counts.succeeded, 1);
    assert.equal(telemetry.counts.failed, 1);
    assert.equal(telemetry.counts.queued, 1);
    assert.equal(telemetry.recent.completed, 2);
    assert.equal(telemetry.recent.successRate, 50);
    assert.ok(Number.isInteger(telemetry.recent.queueLatencyMs.p95));
    assert.ok(Number.isInteger(telemetry.recent.durationMs.p95));
    assert.ok(telemetry.types.some((item) => item.type === "rebuild_knowledge" && item.queued === 1));
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("startup immediately requeues jobs interrupted by a previous local server process", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-job-recovery-test-"));
  const database = openDatabase(path.join(directory, "recovery.sqlite"));
  try {
    const firstRepository = new Repository(database);
    const jobId = firstRepository.enqueue("extract_source", "src-interrupted");
    firstRepository.claimJob();

    const restartedRepository = new Repository(database);
    const recovered = database.prepare("SELECT status, attempts, locked_at, started_at FROM jobs WHERE id=?").get(jobId);
    assert.equal(recovered.status, "queued");
    assert.equal(recovered.attempts, 0);
    assert.equal(recovered.locked_at, null);
    assert.equal(recovered.started_at, null);
    assert.equal(restartedRepository.claimJob().id, jobId);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("exception webhook sends a deduplicated operational payload with optional bearer auth", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-notification-test-"));
  const database = openDatabase(path.join(directory, "notifications.sqlite"));
  const repository = new Repository(database);
  const requests = [];
  const webhook = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    response.writeHead(204).end();
  });
  await new Promise((resolve) => webhook.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => webhook.close(resolve));
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const jobId = repository.enqueue("plan_content", "missing-topic");
  database.prepare("UPDATE jobs SET max_attempts=1 WHERE id=?").run(jobId);
  repository.failJob(repository.claimJob(), new Error("topic package missing"));
  const notifier = new ExceptionNotifier(repository, {
    webhookUrl: `http://127.0.0.1:${webhook.address().port}/exceptions`,
    webhookToken: "notification-secret",
    minimumSeverity: "blocker",
    repeatHours: 24,
  });

  const delivered = await notifier.deliver();
  const duplicate = await notifier.deliver();
  assert.equal(delivered.itemCount, 1);
  assert.equal(duplicate.itemCount, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.authorization, "Bearer notification-secret");
  assert.equal(requests[0].body.event, "solo_to_china.operational_exceptions");
  assert.equal(requests[0].body.summary.blockers, 1);
  assert.equal(repository.notificationOverview().sent, 1);
  database.prepare("DELETE FROM jobs WHERE id=?").run(jobId);
  await notifier.deliver();
  assert.equal(repository.notificationOverview().tracked, 0);
});

test("failed exception webhook delivery is durable and retryable", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-notification-failure-test-"));
  const database = openDatabase(path.join(directory, "notifications.sqlite"));
  const repository = new Repository(database);
  try {
    const jobId = repository.enqueue("plan_content", "missing-topic");
    database.prepare("UPDATE jobs SET max_attempts=1 WHERE id=?").run(jobId);
    repository.failJob(repository.claimJob(), new Error("topic package missing"));
    const config = { webhookUrl: "http://127.0.0.1:4310/exceptions", repeatHours: 24 };
    const failing = new ExceptionNotifier(repository, config, { fetchImpl: async () => new Response("", { status: 503 }) });
    await assert.rejects(() => failing.deliver(), /HTTP 503/);
    assert.equal(repository.notificationOverview().failed, 1);
    const recovered = new ExceptionNotifier(repository, config, { fetchImpl: async () => new Response(null, { status: 204 }) });
    assert.equal((await recovered.deliver()).itemCount, 1);
    assert.equal(repository.notificationOverview().sent, 1);
    assert.equal(repository.notificationOverview().failed, 0);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("structured logger emits machine-readable events and normalizes errors", () => {
  const lines = [];
  const logger = createLogger({ level: "info", format: "json", sink: (line) => lines.push(line) });
  logger.debug("ignored");
  logger.error("operation.failed", { requestId: "request-1", error: Object.assign(new Error("broken"), { code: "E_TEST" }) });
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.event, "operation.failed");
  assert.equal(entry.requestId, "request-1");
  assert.deepEqual(entry.error, { name: "Error", message: "broken", code: "E_TEST" });
});

test("webhook configuration rejects insecure remote URLs and embedded credentials", () => {
  const repository = { listOperationalExceptions() { return []; } };
  assert.throws(() => new ExceptionNotifier(repository, { webhookUrl: "http://example.com/hook" }), /must use HTTPS/);
  assert.throws(() => new ExceptionNotifier(repository, { webhookUrl: "https://user:pass@example.com/hook" }), /embedded credentials/);
});
