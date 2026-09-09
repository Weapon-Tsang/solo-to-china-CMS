import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeXiaohongshuCapture } from "../src/adapters/xiaohongshu.mjs";
import { openDatabase } from "../src/db.mjs";
import { createLogger } from "../src/logger.mjs";
import { ExceptionNotifier } from "../src/notifications.mjs";
import { Repository } from "../src/repository.mjs";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";

test("source list exposes running, queued, and cooldown order with stable list numbers", (t) => {
  const { db, repository } = repositoryFixture(t);
  const sources = [["running", "111111111111111111111111"], ["queued", "222222222222222222222222"], ["cooldown", "333333333333333333333333"]].map(([name, externalId]) => repository.saveCapture(normalizeXiaohongshuCapture({
    url: `https://www.xiaohongshu.com/explore/${externalId}`, title: `Queue ${name}`,
    text: `A manually selected Chongqing travel note used to verify the visible ${name} processing state and queue position.`, images: [],
  })));
  const jobs = sources.map((source) => db.prepare("SELECT * FROM jobs WHERE type='extract_source' AND entity_id=?").get(source.id));
  const now = new Date();
  db.prepare("UPDATE jobs SET status='running',attempts=1,started_at=?,updated_at=? WHERE id=?")
    .run(new Date(now.valueOf() - 5_000).toISOString(), now.toISOString(), jobs[0].id);
  db.prepare("UPDATE jobs SET available_at=?,created_at=?,updated_at=? WHERE id=?")
    .run(new Date(now.valueOf() - 1_000).toISOString(), new Date(now.valueOf() - 10_000).toISOString(), now.toISOString(), jobs[1].id);
  db.prepare("UPDATE jobs SET available_at=?,last_error=?,updated_at=? WHERE id=?")
    .run(new Date(now.valueOf() + 60_000).toISOString(), "Vertex request failed (429): Resource exhausted.", now.toISOString(), jobs[2].id);
  db.prepare("UPDATE sources SET status='processing' WHERE id IN (?,?,?)").run(...sources.map((source) => source.id));

  const listed = repository.listSources(10);
  assert.deepEqual(listed.map((item) => item.list_number), [1, 2, 3]);
  const byId = new Map(listed.map((item) => [item.id, item]));
  assert.equal(byId.get(sources[0].id).queue.state, "running");
  assert.equal(byId.get(sources[1].id).queue.state, "queued");
  assert.equal(byId.get(sources[1].id).queue.queue_position, 1);
  assert.equal(byId.get(sources[1].id).queue.queue_ahead, 1);
  assert.equal(byId.get(sources[2].id).queue.state, "cooldown");
  assert.equal(byId.get(sources[2].id).queue.queue_position, 2);
  assert.match(byId.get(sources[2].id).queue.last_error, /429/);
});

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

test("startup queues only destinations whose Knowledge is older than active Claims", (t) => {
  const { db, repository } = repositoryFixture(t);
  const source = repository.saveCapture(normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/68abcdef0000000000000031",
    title: "Current startup knowledge",
    text: "Hongyadong is reachable by metro. This selected note contains enough detail for research.",
    images: [],
  }));
  repository.saveExtraction(source.id, {
    source: { language: "en", summary: "Metro access", destination_name: "Chongqing", destination_slug: "chongqing", traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.9 },
    claims: [{ key: "attraction.hongyadong.metro_access", subject: "Hongyadong", predicate: "metro_access",
      value: "reachable by metro", qualifiers: [], source_quote: "reachable by metro", confidence: 0.9 }],
    blueprint: { format: "guide", hook: "Metro", angle: "practical", sections: [], strengths: [], gaps: [] },
  }, "test", "fixture-model");
  repository.rebuildKnowledge("chongqing");
  db.prepare("DELETE FROM jobs").run();
  db.prepare("UPDATE claims SET created_at='2026-01-01T00:00:00.000Z'").run();
  db.prepare("UPDATE knowledge_facts SET updated_at='2026-02-01T00:00:00.000Z'").run();

  repository.enqueueStartupReconciliation();
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type='rebuild_knowledge'").get().count, 0);

  db.prepare("UPDATE claims SET created_at='2026-03-01T00:00:00.000Z'").run();
  repository.enqueueStartupReconciliation();
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type='rebuild_knowledge' AND entity_id='chongqing'").get().count, 1);
});

test("repository construction cannot steal a live job and only an expired lease is recovered", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-job-recovery-test-"));
  const database = openDatabase(path.join(directory, "recovery.sqlite"));
  try {
    let current = new Date();
    const firstRepository = new Repository(database, { workerId: "worker-a", jobLeaseMs: 30_000, clock: () => current });
    const jobId = firstRepository.enqueue("extract_source", "src-interrupted");
    firstRepository.claimJob();

    const secondRepository = new Repository(database, { workerId: "worker-b", jobLeaseMs: 30_000, clock: () => current });
    assert.equal(secondRepository.claimJob(), null);
    let stored = database.prepare("SELECT status, attempts, locked_by FROM jobs WHERE id=?").get(jobId);
    assert.deepEqual({ ...stored }, { status: "running", attempts: 1, locked_by: "worker-a" });
    assert.equal(secondRepository.completeJob(jobId, "worker-b"), false);

    current = new Date(current.getTime() + 31_000);
    assert.equal(secondRepository.recoverExpiredJobs(), 1);
    const recovered = secondRepository.claimJob();
    assert.equal(recovered.id, jobId);
    assert.equal(recovered.attempts, 2);
    assert.equal(recovered.locked_by, "worker-b");
    assert.equal(secondRepository.completeJob(jobId, "worker-b"), true);
    stored = database.prepare("SELECT status, attempts, locked_by FROM jobs WHERE id=?").get(jobId);
    assert.deepEqual({ ...stored }, { status: "succeeded", attempts: 2, locked_by: null });
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("deterministic Contract failures do not enter the automatic retry loop", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-job-contract-failure-"));
  const database = openDatabase(path.join(directory, "failure.sqlite"));
  const repository = new Repository(database);
  try {
    const jobId = repository.enqueue("compose_publish_page", "draft-missing");
    const job = repository.claimJob();
    const error = Object.assign(new Error("UNKNOWN_COMPONENT: made_up"), { code: "UNKNOWN_COMPONENT", retryable: false });
    repository.failJob(job, error);
    const stored = database.prepare("SELECT status, attempts, last_error FROM jobs WHERE id=?").get(jobId);
    assert.equal(stored.status, "failed");
    assert.equal(stored.attempts, 1);
    assert.match(stored.last_error, /UNKNOWN_COMPONENT/);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("provider quota exhaustion pauses AI claiming without rewriting the whole visible queue", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-provider-quota-test-"));
  const database = openDatabase(path.join(directory, "quota.sqlite"));
  let current = new Date("2026-09-09T00:00:00.000Z");
  const repository = new Repository(database, { providerBackoffInitialMs: 5_000, providerBackoffMaxMs: 300_000, clock: () => current });
  try {
    const limitedId = repository.enqueue("extract_segment_claims", "segment-limited");
    database.prepare("UPDATE jobs SET max_attempts=1 WHERE id=?").run(limitedId);
    const limited = repository.claimJob();
    const waitingId = repository.enqueue("audit_segment_coverage", "segment-waiting");
    const contentId = repository.enqueue("generate_draft", "brief-waiting");
    const error = Object.assign(new Error("Vertex Gemini request failed (429): Resource exhausted."), { status: 429, retryable: true });
    repository.failJob(limited, error);
    const retried = database.prepare("SELECT status, attempts, available_at FROM jobs WHERE id=?").get(limitedId);
    const waiting = database.prepare("SELECT status, available_at FROM jobs WHERE id=?").get(waitingId);
    const content = database.prepare("SELECT status, available_at FROM jobs WHERE id=?").get(contentId);
    assert.equal(retried.status, "queued");
    assert.equal(retried.attempts, 1);
    assert.ok(Date.parse(retried.available_at) > current.getTime());
    assert.equal(waiting.status, "queued");
    assert.equal(waiting.available_at, current.toISOString());
    assert.equal(content.available_at, current.toISOString());
    assert.ok(Date.parse(retried.available_at) - current.getTime() < 7_000);
    assert.equal(repository.claimJob(), null);

    const housekeepingId = repository.enqueue("rebuild_editorial", "global");
    assert.equal(repository.claimJob().id, housekeepingId);
    repository.completeJob(housekeepingId);
    current = new Date(repository.providerBackoffUntil + 1);
    const secondLimited = repository.claimJob();
    assert.equal(secondLimited.id, contentId);
    repository.failJob(secondLimited, error);
    const secondDelayMs = Date.parse(database.prepare("SELECT available_at FROM jobs WHERE id=?").get(contentId).available_at) - current.getTime();
    assert.ok(secondDelayMs >= 7_500 && secondDelayMs < 13_000);

    for (let index = 0; index < 5; index += 1) repository.recordModelCall({
      stage: "test", provider: "vertex", model: "fixture", promptHash: "p", schemaHash: "s", inputHash: String(index),
      latencyMs: 1, attempts: 1, status: "succeeded",
    });
    const recoveredId = repository.enqueue("review_draft", "draft-after-recovery");
    database.prepare("UPDATE jobs SET available_at=? WHERE id=?").run(current.toISOString(), recoveredId);
    const recovered = repository.claimJob();
    assert.equal(recovered.id, recoveredId);
    repository.failJob(recovered, error);
    const recoveredDelayMs = Date.parse(database.prepare("SELECT available_at FROM jobs WHERE id=?").get(recoveredId).available_at) - current.getTime();
    assert.ok(recoveredDelayMs >= 3_500 && recoveredDelayMs < 7_000);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("completion-stage jobs bypass an older extraction backlog without bypassing availability", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-job-priority-test-"));
  const database = openDatabase(path.join(directory, "priority.sqlite"));
  const repository = new Repository(database);
  try {
    const extractionId = repository.enqueue("extract_segment_claims", "segment-old");
    const auditId = repository.enqueue("audit_segment_coverage", "segment-ready");
    const finalizeId = repository.enqueue("finalize_source_extraction", "source-ready");
    const knowledgeId = repository.enqueue("rebuild_knowledge", "chongqing");
    const diagnosticId = repository.enqueue("analyze_source_diagnostic", "source-complete");
    database.prepare("UPDATE jobs SET created_at=? WHERE id=?").run("2020-01-01T00:00:00.000Z", extractionId);
    database.prepare("UPDATE jobs SET created_at=? WHERE id=?").run("2020-01-02T00:00:00.000Z", auditId);
    database.prepare("UPDATE jobs SET created_at=? WHERE id=?").run("2020-01-03T00:00:00.000Z", finalizeId);
    database.prepare("UPDATE jobs SET created_at=? WHERE id=?").run("2020-01-04T00:00:00.000Z", knowledgeId);
    database.prepare("UPDATE jobs SET created_at=? WHERE id=?").run("2020-01-05T00:00:00.000Z", diagnosticId);

    const finalize = repository.claimJob();
    assert.equal(finalize.id, finalizeId);
    repository.completeJob(finalize.id);
    const knowledge = repository.claimJob();
    assert.equal(knowledge.id, knowledgeId);
    repository.completeJob(knowledge.id);
    const diagnostic = repository.claimJob();
    assert.equal(diagnostic.id, diagnosticId);
    repository.completeJob(diagnostic.id);
    const audit = repository.claimJob();
    assert.equal(audit.id, auditId);
    repository.completeJob(audit.id);
    assert.equal(repository.claimJob().id, extractionId);

    const unavailableFinalizeId = repository.enqueue("finalize_source_extraction", "source-cooling-down");
    database.prepare("UPDATE jobs SET available_at=? WHERE id=?").run("2999-01-01T00:00:00.000Z", unavailableFinalizeId);
    const availableId = repository.enqueue("rebuild_editorial", "global-priority-test");
    assert.equal(repository.claimJob().id, availableId);
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
