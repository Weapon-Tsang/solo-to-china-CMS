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
import { Pipeline } from "../src/pipeline.mjs";
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

test("a processed source does not project a superseded extraction failure", (t) => {
  const {db,repository}=repositoryFixture(t);
  const source=repository.saveCapture(normalizeXiaohongshuCapture({
    url:"https://www.xiaohongshu.com/explore/status-projection-recovered",title:"Recovered source",
    text:"Complete evidence for a source whose older extraction attempt failed.",images:[],
  }));
  const job=db.prepare("SELECT id FROM jobs WHERE type='extract_source' AND entity_id=?").get(source.id);
  db.prepare("UPDATE jobs SET status='failed',attempts=3,max_attempts=3,last_error='old fetch failure' WHERE id=?").run(job.id);
  db.prepare("UPDATE sources SET status='processed',last_error=NULL WHERE id=?").run(source.id);
  const projected=repository.listSourceStatusProjection({ids:[source.id]})[0];
  assert.equal(projected.queue,null);
  assert.equal(repository.sourceTimeline(source.id).some((event)=>event.status==="failed"),true);
});

test("successful retry clears its previous error text", (t) => {
  const {db,repository}=repositoryFixture(t);
  repository.enqueue("rebuild_editorial","global");
  const job=repository.claimJob();
  db.prepare("UPDATE jobs SET last_error='temporary provider failure' WHERE id=?").run(job.id);
  assert.equal(repository.completeJob(job.id,job.locked_by,job.lease_generation),true);
  assert.equal(db.prepare("SELECT last_error FROM jobs WHERE id=?").get(job.id).last_error,null);
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
  db.prepare("UPDATE destinations SET updated_at='2026-02-01T00:00:00.000Z'").run();

  repository.enqueueStartupReconciliation();
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type='rebuild_knowledge'").get().count, 0);

  db.prepare("UPDATE claims SET created_at='2026-03-01T00:00:00.000Z'").run();
  repository.enqueueStartupReconciliation();
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type='rebuild_knowledge' AND entity_id='chongqing'").get().count, 1);
});

test("approved-opportunity startup reconciliation rebuilds coverage once per destination", (t) => {
  const { db, repository } = repositoryFixture(t);
  const timestamp = new Date().toISOString();
  const insert = db.prepare(`INSERT INTO content_opportunities(
    id,destination_slug,topic_key,strategy_version,title,readiness_score,status,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?)`);
  insert.run("op-cq-1", "chongqing", "chongqing:route-1", "2.0", "Route one", 40,
    "approved_waiting_for_evidence", timestamp, timestamp);
  insert.run("op-cq-2", "chongqing", "chongqing:route-2", "2.0", "Route two", 50,
    "approved_waiting_for_evidence", timestamp, timestamp);
  insert.run("op-cq-ready", "chongqing", "chongqing:route-3", "2.0", "Route three", 100,
    "approved_ready", timestamp, timestamp);
  insert.run("op-bj-1", "beijing", "beijing:route-1", "2.0", "Beijing route", 40,
    "approved_waiting_for_evidence", timestamp, timestamp);

  const rebuilt = [];
  const reconciled = [];
  repository.rebuildCoverageMatrices = (slug) => rebuilt.push(slug);
  repository.reconcileApprovedOpportunity = (id) => { reconciled.push(id); return { candidateId: id, queued: false }; };

  repository.reconcileApprovedOpportunities();
  assert.deepEqual(rebuilt.sort(), ["beijing", "chongqing"]);
  assert.deepEqual(reconciled.sort(), ["op-bj-1", "op-cq-1", "op-cq-2", "op-cq-ready"]);
});

test("a new Claim classifier revision rechecks pending reviews once at startup", (t) => {
  const { db, repository } = repositoryFixture(t);
  const source = repository.saveCapture(normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/68abcdef0000000000000032",
    title: "Metro exit alias",
    text: "下浩里最近的地铁出口是上新街地铁站1号出口。这是一条人工选择的重庆交通笔记。",
    images: [],
  }));
  repository.saveExtraction(source.id, {
    source: { language: "zh-CN", summary: "交通", destination_name: "重庆", destination_slug: "chongqing", traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.9 },
    claims: [{ key: "attraction.xiahaoli.nearest_metro_exit", subject: "下浩里", predicate: "nearest_metro_exit",
      value: "上新街地铁站1号出口", qualifiers: [], source_quote: "上新街地铁站1号出口", confidence: 0.9 }],
    blueprint: { format: "guide", hook: "交通", angle: "practical", sections: [], strengths: [], gaps: [] },
  }, "test", "fixture-model");
  repository.rebuildKnowledge("chongqing");
  const claimId = db.prepare("SELECT id FROM claims WHERE source_id=?").get(source.id).id;
  db.prepare(`INSERT INTO claim_review_cases(id,destination_slug,claim_a_id,claim_b_id,review_type,reason,status,created_at,updated_at)
    VALUES ('legacy-metro-review','chongqing',?,?,'SOURCE_CONFLICT','legacy alias mismatch','pending','now','now')`).run(claimId, claimId);
  db.prepare("DELETE FROM jobs").run();

  repository.enqueueStartupReconciliation();
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type='rebuild_knowledge' AND entity_id='chongqing'").get().count, 1);

  db.prepare("DELETE FROM jobs").run();
  repository.enqueueStartupReconciliation();
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type='rebuild_knowledge'").get().count, 0);
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

test("a worker can release only its own running jobs during graceful shutdown", (t) => {
  const { db } = repositoryFixture(t);
  const owner = new Repository(db, { workerId: "worker-owner" });
  const peer = new Repository(db, { workerId: "worker-peer" });
  const ownerJob = owner.enqueue("extract_source", "owned");
  owner.claimJob();
  const peerJob = peer.enqueue("extract_source", "peer");
  peer.claimJob();

  assert.equal(owner.releaseOwnedJobs(), 1);
  assert.deepEqual({ ...db.prepare("SELECT status,locked_by FROM jobs WHERE id=?").get(ownerJob) },
    { status: "queued", locked_by: null });
  assert.deepEqual({ ...db.prepare("SELECT status,locked_by FROM jobs WHERE id=?").get(peerJob) },
    { status: "running", locked_by: "worker-peer" });
});

test("pipeline periodically recovers leases that expire after process startup", async (t) => {
  const calls = { jobs: 0, batches: 0, claims: 0 };
  const repository = {
    recoverExpiredJobs() { calls.jobs += 1; return calls.jobs === 2 ? 1 : 0; },
    recoverPreparingVertexBatches() { calls.batches += 1; return 0; },
    claimJob() { calls.claims += 1; return null; },
  };
  const pipeline = new Pipeline(repository, { batchEnabled: false }, {
    pollMs: 60_000,
    maxConcurrent: 1,
    recoveryIntervalMs: 1_000,
  });
  t.after(() => pipeline.stop());

  pipeline.start();
  assert.equal(calls.jobs, 1);
  pipeline.nextRecoveryAt = 0;
  pipeline.pump();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.jobs, 2);
  assert.equal(calls.batches, 2);
  assert.ok(calls.claims >= 1);
});

test("pipeline shutdown aborts active work and releases the current worker leases", () => {
  let released = 0;
  const repository = { releaseOwnedJobs() { released += 1; return 2; } };
  const pipeline = new Pipeline(repository, { batchEnabled: false });
  const controller = new AbortController();
  pipeline.activeAbortControllers.add(controller);

  pipeline.stop();
  assert.equal(controller.signal.aborted, true);
  assert.equal(released, 1);
});

test("a stale lease generation cannot complete, fail, or mutate the reclaimed entity", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-job-fence-test-"));
  const database = openDatabase(path.join(directory, "fence.sqlite"));
  let current = new Date("2026-09-10T02:00:00.000Z");
  try {
    const sourceRepository = new Repository(database, { workerId: "worker-a", jobLeaseMs: 30_000, clock: () => current });
    const source = sourceRepository.saveCapture(normalizeXiaohongshuCapture({
      url: "https://www.xiaohongshu.com/explore/444444444444444444444444", title: "Fenced source",
      text: "A complete source used to verify monotonic lease fencing across worker recovery.", images: [],
    }));
    database.prepare("DELETE FROM jobs").run();
    const jobId = sourceRepository.enqueue("extract_source", source.id);
    const stale = sourceRepository.claimJob();
    assert.equal(stale.lease_generation, 1);
    current = new Date(current.getTime() + 31_000);
    const owner = new Repository(database, { workerId: "worker-b", jobLeaseMs: 30_000, clock: () => current });
    assert.equal(owner.recoverExpiredJobs(), 1);
    const live = owner.claimJob();
    assert.equal(live.lease_generation, 2);
    assert.equal(sourceRepository.completeJob(jobId, stale.locked_by, stale.lease_generation), false);
    assert.equal(sourceRepository.failJob(stale, Object.assign(new Error("stale worker failure"), { retryable: false })), false);
    assert.equal(database.prepare("SELECT status FROM sources WHERE id=?").get(source.id).status, "processing");
    assert.deepEqual({ ...database.prepare("SELECT status,locked_by,lease_generation FROM jobs WHERE id=?").get(jobId) },
      { status: "running", locked_by: "worker-b", lease_generation: 2 });
    assert.equal(owner.completeJob(jobId, live.locked_by, live.lease_generation), true);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("heartbeat ownership loss aborts the model call and prevents stale extraction writes", async (t) => {
  const { db, repository } = repositoryFixture(t, { workerId: "worker-a", jobLeaseMs: 30_000 });
  const source = repository.saveCapture(normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/555555555555555555555555", title: "Abort source",
    text: "A complete source used to prove heartbeat loss cancels ongoing model work before persistence.", images: [],
  }));
  db.prepare("DELETE FROM jobs").run();
  const [segment] = repository.prepareSourceSegments(source.id);
  const jobId = repository.enqueue("extract_segment_claims", segment.id);
  let aborted = false;
  const extractor = {
    batchEnabled: false, config: {},
    async extract(_pack, { signal }) {
      setTimeout(() => db.prepare("UPDATE jobs SET locked_by='worker-b',lease_generation=lease_generation+1 WHERE id=?").run(jobId), 0);
      return new Promise((resolve, reject) => signal.addEventListener("abort", () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true }));
    },
  };
  const pipeline = new Pipeline(repository, extractor, { maxConcurrent: 1, heartbeatIntervalMs: 5 });
  assert.equal(await pipeline.runOne(), false);
  assert.equal(aborted, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM segment_extractions WHERE segment_id=?").get(segment.id).count, 0);
  const stored = db.prepare("SELECT status,locked_by,lease_generation,last_error FROM jobs WHERE id=?").get(jobId);
  assert.equal(stored.status, "running");
  assert.equal(stored.locked_by, "worker-b");
  assert.equal(stored.lease_generation, 2);
  assert.equal(stored.last_error, null);
});

test("startup recovery leaves a live Batch preparation lease alone and reclaims only expiry", (t) => {
  let current = new Date("2026-09-10T03:00:00.000Z");
  const { db, repository } = repositoryFixture(t, { workerId: "worker-a", jobLeaseMs: 30_000, clock: () => current });
  const source = repository.saveCapture(normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/666666666666666666666666", title: "Preparing source",
    text: "A complete source used to verify preparation lease recovery behavior.", images: [],
  }));
  db.prepare("DELETE FROM jobs").run();
  const [segment] = repository.prepareSourceSegments(source.id);
  repository.enqueue("extract_segment_claims", segment.id);
  const run = repository.reserveVertexBatchJobs({ minimum: 1, maximum: 1 });
  assert.equal(repository.recoverPreparingVertexBatches(), 0);
  assert.equal(db.prepare("SELECT status FROM vertex_batch_runs WHERE id=?").get(run.id).status, "preparing");
  current = new Date(current.getTime() + 31_000);
  assert.equal(repository.recoverPreparingVertexBatches(), 1);
  assert.equal(db.prepare("SELECT status FROM vertex_batch_runs WHERE id=?").get(run.id).status, "failed");
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
    assert.equal(secondLimited.id, waitingId);
    repository.failJob(secondLimited, error);
    const secondDelayMs = Date.parse(database.prepare("SELECT available_at FROM jobs WHERE id=?").get(waitingId).available_at) - current.getTime();
    assert.ok(secondDelayMs >= 7_500 && secondDelayMs < 13_000);

    for (let index = 0; index < 5; index += 1) repository.recordModelCall({
      stage: "test", provider: "vertex", model: "fixture", promptHash: "p", schemaHash: "s", inputHash: String(index),
      latencyMs: 1, attempts: 1, status: "succeeded",
    });
    const resumedExtraction = repository.claimJob();
    assert.equal(resumedExtraction.id,limitedId);
    repository.completeJob(resumedExtraction.id);
    const pendingContent = repository.claimJob();
    assert.equal(pendingContent.id,contentId);
    repository.completeJob(pendingContent.id);
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
    const audit = repository.claimJob();
    assert.equal(audit.id, auditId);
    repository.completeJob(audit.id);
    assert.equal(repository.claimJob().id, extractionId);
    const diagnostic = repository.claimJob();
    assert.equal(diagnostic.id, diagnosticId);
    repository.completeJob(diagnostic.id);

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
  repository.failJob(repository.claimJob(), new Error("AI_PROVIDER_AUTH: missing production credential"));
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
    repository.failJob(repository.claimJob(), new Error("AI_PROVIDER_AUTH: missing production credential"));
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
