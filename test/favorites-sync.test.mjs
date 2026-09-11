import assert from "node:assert/strict";
import test from "node:test";
import {
  applyIdentityBatch, applySettingsToSession, AsyncSemaphore, canonicalizeNoteUrl, classifyCaptureApiError, classifyTaskDisposition,
  compactSessionState, createSession, hasUnresolvedFailures, HUMAN_PAUSE_STATES, leaseNextTask, nextConcurrency, reconcileStrandedTasks, retryDelayMs,
  runContinuousPool, isFavoritesAlbumOverviewUrl, normalizeCard, normalizeSettings, noteIdentity, recoverSession, scopeFromUrl,
  shouldStopDiscovery, transitionTask, updateSessionConcurrency,
  prepareSessionCompletion, prepareSessionResume,
} from "../extension/sync-core.js";

test("capture API errors distinguish an outdated backend from content rejection", () => {
  assert.deepEqual(classifyCaptureApiError(404), {
    code: "CAPTURE_API_UNAVAILABLE", retryable: false,
    message: "This SoloToChina Engine version does not provide the Favorites Sync API.",
  });
  assert.equal(classifyCaptureApiError(401).code, "CAPTURE_UNAUTHORIZED");
  assert.equal(classifyCaptureApiError(503).code, "CAPTURE_SERVER_UNAVAILABLE");
  assert.equal(classifyCaptureApiError(429).code, "CAPTURE_RATE_LIMITED");
  assert.equal(classifyCaptureApiError(422, { error: "invalid capture" }).code, "CAPTURE_REJECTED");
});

const scope = { key: "scope:favorites", url: "https://www.xiaohongshu.com/user/profile/test?tab=fav", label: "Favorites" };
const card = (id) => ({ externalId: id, url: `https://www.xiaohongshu.com/explore/${id}?xsec_token=secret&utm_source=share` });
const identities = (cards, known) => cards.map((item) => ({ externalId: item.externalId, canonicalUrl: canonicalizeNoteUrl(item.url), known }));

test("Favorites identities prefer externalId and remove transient tracking", () => {
  const first = card("note123");
  const second = { ...first, url: "https://www.xiaohongshu.com/discovery/item/note123?share_id=other" };
  assert.equal(noteIdentity(first), "xiaohongshu:note123");
  assert.equal(noteIdentity(second), "xiaohongshu:note123");
  assert.equal(canonicalizeNoteUrl(first.url), "https://www.xiaohongshu.com/explore/note123");
  assert.equal(noteIdentity({ url: "not a url" }), "");
});

test("collection cards retain the visible navigation token but use a token-free stable identity", () => {
  const navigationUrl = "https://www.xiaohongshu.com/board/board123/note123?xsec_token=temporary&xsec_source=pc_feed&source=web_user_page";
  const normalized = normalizeCard({ url: navigationUrl, externalId: "note123" });
  assert.equal(normalized?.canonicalUrl, "https://www.xiaohongshu.com/explore/note123");
  assert.equal(normalized?.navigationUrl, "https://www.xiaohongshu.com/board/board123/note123?xsec_token=temporary&xsec_source=pc_feed");
  assert.equal(normalized?.identityKey, "xiaohongshu:note123");
});

test("Xiaohongshu board URLs are recognized as stable Favorites scopes", () => {
  const board = scopeFromUrl("https://xiaohongshu.com/board/6a89fa03000000002300f671?source=web_user_page");
  assert.equal(board?.url, "https://www.xiaohongshu.com/board/6a89fa03000000002300f671");
  assert.equal(board?.key, "xhs_scope:https://www.xiaohongshu.com/board/6a89fa03000000002300f671");
  assert.match(board?.label || "", /小红书收藏夹/);
  assert.equal(scopeFromUrl("https://www.xiaohongshu.com/explore/note123"), null);
  assert.equal(scopeFromUrl("https://www.xiaohongshu.com/"), null);
  const overview = "https://www.xiaohongshu.com/user/profile/60a0e1ec0000000010009f8?tab=fav&subTab=board";
  assert.equal(isFavoritesAlbumOverviewUrl(overview), true);
  assert.equal(scopeFromUrl(overview), null);
  const allNotes = scopeFromUrl("https://www.xiaohongshu.com/user/profile/60a0e1ec0000000010009f8?source=profile&tab=fav&subTab=note");
  assert.equal(allNotes?.url, "https://www.xiaohongshu.com/user/profile/60a0e1ec0000000010009f8?subTab=note&tab=fav");
  assert.equal(isFavoritesAlbumOverviewUrl(allNotes?.url), false);
});

test("malformed or non-note cards never enter the acquisition queue", () => {
  let session = createSession({ scope });
  session = applyIdentityBatch(session, [
    { title: "missing URL" },
    { url: "https://example.com/explore/not-xhs" },
    { url: "https://www.xiaohongshu.com/user/profile/not-a-note" },
  ], []);
  assert.equal(session.queue.length, 0);
  assert.equal(session.stats.discovered, 0);
});

test("incremental discovery requires a reliable checkpoint, a clean window, and twelve consecutive known notes", () => {
  const checkpointCards = Array.from({ length: 12 }, (_, index) => card(`known${index}`));
  let session = createSession({ scope, settings: { stopAfterConsecutiveKnown: 12 },
    checkpoint: { topIdentityKeys: ["xiaohongshu:known0"], lastSuccessfulSyncAt: "2026-09-01T00:00:00.000Z" } });
  const fresh = Array.from({ length: 8 }, (_, index) => card(`new${index}`));
  session = applyIdentityBatch(session, fresh, identities(fresh, false));
  assert.equal(shouldStopDiscovery(session), false);
  assert.equal(session.queue.length, 8);
  session = applyIdentityBatch(session, checkpointCards, identities(checkpointCards, true));
  assert.equal(shouldStopDiscovery(session), true);
  assert.deepEqual(session.stats, { discovered: 20, known: 12, new: 8, repair: 0, captured: 0, duplicate: 0, failed: 0, unavailable: 0, retrying: 0 });
});

test("a new or reordered discovery window cannot trigger an early incremental stop", () => {
  let session = createSession({ scope, settings: { stopAfterConsecutiveKnown: 4 },
    checkpoint: { topIdentityKeys: ["xiaohongshu:known0"] } });
  const mixed = [card("known0"), card("known1"), card("fresh"), card("known2"), card("known3"), card("known4"), card("known5")];
  session = applyIdentityBatch(session, mixed, mixed.map((item) => ({ externalId: item.externalId, known: item.externalId !== "fresh" })));
  assert.equal(session.scan.consecutiveKnown, 4);
  assert.equal(session.scan.windowNew, 1);
  assert.equal(shouldStopDiscovery(session), false);
});

test("full historical sync streams multiple bounded batches until collection end without a session total cap", () => {
  let session = createSession({ scope, mode: "full", settings: { discoveryBatchSize: 100 } });
  for (let batch = 0; batch < 11; batch += 1) {
    const cards = Array.from({ length: 100 }, (_, index) => card(`history${batch}_${index}`));
    session = applyIdentityBatch(session, cards, identities(cards, false), { collectionEnd: false });
    assert.equal(shouldStopDiscovery(session), false);
  }
  session = applyIdentityBatch(session, [], [], { collectionEnd: true });
  assert.equal(shouldStopDiscovery(session), false);
  session = applyIdentityBatch(session, [], [], { collectionEnd: true });
  assert.equal(session.queue.length, 1_100);
  assert.equal(shouldStopDiscovery(session), true);
});

test("restart recovery keeps successful tasks and requeues only unfinished work", () => {
  let session = createSession({ scope });
  const cards = [card("done"), card("active")];
  session = applyIdentityBatch(session, cards, identities(cards, false));
  session = transitionTask(session, session.queue[0].taskId, "captured", { sourceId: "src_done" });
  session = transitionTask(session, session.queue[1].taskId, "extracting");
  const recovered = recoverSession(session, "2026-09-08T01:00:00.000Z");
  assert.equal(recovered.status, "running");
  assert.equal(recovered.queue[0].status, "captured");
  assert.equal(recovered.queue[1].status, "queued");
});

test("recovery rediscovers unfinished legacy tasks that lack the visible card navigation URL", () => {
  let session = createSession({ scope });
  session = applyIdentityBatch(session, [card("legacy")], identities([card("legacy")], false));
  delete session.queue[0].navigationUrl;
  session.queue[0].status = "failed";
  session.status = "paused_error";
  session.phase = "acquisition";
  const recovered = recoverSession(session);
  assert.equal(recovered.status, "running");
  assert.equal(recovered.phase, "discovery");
  assert.equal(recovered.queue.length, 0);
  assert.equal(recovered.seenIdentityKeys.length, 0);
  assert.equal(recovered.stats.discovered, 0);
  assert.equal(recovered.stats.new, 0);
});

test("streaming session compaction bounds terminal task history while retaining active identities", () => {
  let session = createSession({ scope });
  const cards = Array.from({ length: 180 }, (_, index) => card(`compact${index}`));
  session = applyIdentityBatch(session, cards, identities(cards, false));
  for (let index = 0; index < 150; index += 1) session = transitionTask(session, session.queue[index].taskId, "captured");
  const compacted = compactSessionState(session, 20);
  assert.equal(compacted.queue.filter((task) => task.status === "captured").length, 20);
  assert.equal(compacted.queue.filter((task) => task.status === "queued").length, 30);
  for (const task of compacted.queue.filter((item) => item.status === "queued")) assert.ok(compacted.seenIdentityKeys.includes(task.identityKey));
  assert.equal(compacted.stats.captured, 150);
});

test("Repair queues only browser work and carries only missing original media identities", () => {
  let session = createSession({ scope, mode: "repair" });
  const cards = [card("server-only"), card("browser-required")];
  session = applyIdentityBatch(session, cards, [
    { externalId: "server-only", sourceExists: true, requiredActions: ["SERVER_MEDIA_RECOVERY", "VERIFY_MEDIA_ORIGINALS"],
      repairMedia: { missingOriginals: [{ mediaIdentity: "server-media" }] } },
    { externalId: "browser-required", sourceExists: true, sourceId: "src-browser", requiredActions: ["BROWSER_MEDIA_REPAIR"],
      repairMedia: { missingOriginals: [{ mediaIdentity: "missing-a" }, { mediaIdentity: "missing-b" }] } },
  ]);
  assert.equal(session.queue.length, 1);
  assert.equal(session.queue[0].externalId, "browser-required");
  assert.deepEqual(session.queue[0].repairMediaIdentities, ["missing-a", "missing-b"]);
});

test("failed tasks remain recoverable and a completed partial run can resume without duplicating captures", () => {
  let session = createSession({ scope, mode: "full" });
  session = applyIdentityBatch(session, [card("saved"), card("blocked")], identities([card("saved"), card("blocked")], false));
  session = transitionTask(session, session.queue[0].taskId, "captured");
  session = transitionTask(session, session.queue[1].taskId, "failed", { error: { code: "NAVIGATION_INTERRUPTED" } });
  session.status = "completed";
  session.phase = "completed";
  session.completedAt = "2026-09-08T15:00:00.000Z";
  const compacted = compactSessionState(session, 0);
  assert.equal(compacted.queue.length, 1);
  assert.equal(compacted.queue[0].status, "failed");
  assert.ok(compacted.queue[0].navigationUrl);
  assert.equal(hasUnresolvedFailures(compacted), true);
  const resumed = prepareSessionResume(compacted);
  assert.equal(resumed.status, "running");
  assert.equal(resumed.phase, "acquisition");
  assert.equal(resumed.queue[0].status, "queued");
  assert.equal(resumed.queue[0].attempts, 0);
  assert.equal(resumed.stats.failed, 0);
  assert.equal(resumed.stats.captured, 1);
  assert.equal(resumed.completedAt, null);
});

test("completion state is committed before cleanup and unresolved failures remain resumable", () => {
  let successful = createSession({ scope, mode: "full" });
  successful.phase = "completed";
  const completed = prepareSessionCompletion(successful, "2026-09-09T05:00:00.000Z");
  assert.equal(completed.status, "completed");
  assert.equal(completed.phase, "completed");
  assert.equal(completed.completedAt, "2026-09-09T05:00:00.000Z");

  let partial = createSession({ scope, mode: "full" });
  partial = applyIdentityBatch(partial, [card("blocked-finalize")], identities([card("blocked-finalize")], false));
  partial = transitionTask(partial, partial.queue[0].taskId, "failed", { error: { code: "CAPTURE_REQUEST_TIMEOUT" } });
  partial.phase = "completed";
  const paused = prepareSessionCompletion(partial, "2026-09-09T05:01:00.000Z");
  assert.equal(paused.status, "completed_with_failures");
  assert.equal(paused.completedAt, "2026-09-09T05:01:00.000Z");
  assert.equal(hasUnresolvedFailures(paused), true);
  assert.equal(prepareSessionResume(paused).phase, "acquisition");
});

test("a legacy completed partial run rediscovers token-free failed items", () => {
  let session = createSession({ scope, mode: "full" });
  session = applyIdentityBatch(session, [card("legacy-blocked")], identities([card("legacy-blocked")], false));
  session = transitionTask(session, session.queue[0].taskId, "failed");
  delete session.queue[0].navigationUrl;
  session.status = "completed";
  session.phase = "completed";
  const resumed = prepareSessionResume(session);
  assert.equal(resumed.status, "running");
  assert.equal(resumed.phase, "discovery");
  assert.equal(resumed.queue.length, 0);
  assert.equal(resumed.seenIdentityKeys.length, 0);
  assert.equal(resumed.stats.discovered, 0);
  assert.equal(resumed.stats.new, 0);
  assert.equal(resumed.stats.failed, 0);
});

test("adaptive concurrency remains bounded, grows on healthy samples, and backs off on pressure", () => {
  const settings = { concurrencyMode: "auto", concurrencyInitial: 4, concurrencyMax: 16 };
  const healthy = Array.from({ length: 20 }, () => ({ result: "succeeded", noteLoadMs: 45_000, totalMs: 70_000 }));
  assert.equal(nextConcurrency(4, healthy, settings), 5);
  assert.equal(nextConcurrency(16, healthy, settings), 16);
  assert.equal(nextConcurrency(10, { result: "failed", rateLimited: true }, settings), 7);
  assert.equal(nextConcurrency(8, { result: "failed", errorClass: "MEDIA_HTTP_403" }, settings), 8);
  assert.equal(nextConcurrency(4, healthy, { ...settings, concurrencyMode: "conservative" }), 2);
  assert.equal(normalizeSettings({ customConcurrency: 16, concurrencyMax: 16 }).customConcurrency, 16);
});

test("live settings immediately update the running session without replacing it", () => {
  const started = createSession({ scope, settings: { concurrencyMode: "custom", customConcurrency: 2 } });
  const updated = applySettingsToSession(started, { concurrencyMode: "custom", customConcurrency: 8 }, "2026-09-12T01:00:00.000Z");
  assert.equal(updated.sessionId, started.sessionId);
  assert.equal(updated.config.customConcurrency, 8);
  assert.equal(updated.concurrency, 8);
  assert.equal(updated.status, "running");
});

test("durable task leases are exclusive and watchdog recovery requeues only stranded work", () => {
  let session = createSession({ scope, settings: { taskLeaseMs: 60_000 } });
  session.phase = "acquisition";
  session = applyIdentityBatch(session, [card("lease-one"), card("lease-two")], identities([card("lease-one"), card("lease-two")], false));
  const first = leaseNextTask(session, { workerId: "worker-1", leaseId: "lease-1", now: "2026-09-12T02:00:00.000Z" });
  const second = leaseNextTask(first.session, { workerId: "worker-2", leaseId: "lease-2", now: "2026-09-12T02:00:10.000Z" });
  assert.equal(first.task.externalId, "lease-one");
  assert.equal(second.task.externalId, "lease-two");
  assert.notEqual(first.task.taskId, second.task.taskId);
  const recovered = reconcileStrandedTasks(second.session, { now: "2026-09-12T02:01:01.000Z" });
  assert.equal(recovered.recovered, 1);
  assert.equal(recovered.session.queue.find((task) => task.taskId === first.task.taskId).status, "queued");
  assert.equal(recovered.session.queue.find((task) => task.taskId === second.task.taskId).status, "opening");
});

test("only human-required failures pause a session and ordinary task errors stay local", () => {
  assert.ok(HUMAN_PAUSE_STATES.includes("paused_by_user"));
  for (const [code, status] of [
    ["NOT_LOGGED_IN", "paused_login_required"],
    ["VERIFICATION_REQUIRED", "paused_verification_required"],
    ["CAPTURE_UNAUTHORIZED", "paused_capture_unauthorized"],
  ]) assert.deepEqual(classifyTaskDisposition({ code, retryable: false }, 1, 3), { action: "pause", status });

  for (const code of ["NAVIGATION_INTERRUPTED", "TAB_LOAD_TIMEOUT", "CONTENT_NOT_READY", "CAPTURE_SERVER_UNAVAILABLE", "WORKER_TAB_CLOSED"]) {
    assert.equal(classifyTaskDisposition({ code, retryable: true }, 1, 3).action, "retry");
  }
  for (const code of ["NOTE_UNAVAILABLE", "MEDIA_HTTP_403"]) {
    assert.equal(classifyTaskDisposition({ code, retryable: false }, 1, 3).action, "fail");
  }
  assert.equal(retryDelayMs(3, { baseMs: 1_000, maxMs: 30_000, random: () => 0.5 }), 4_000);
});

test("continuous worker pool lets a free slot claim new work before a slow note finishes", async () => {
  const completed = [];
  const delays = [40, 2, 2, 2];
  const results = await runContinuousPool(delays, 2, async (delay, index) => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    completed.push(index);
    return index;
  });
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
  assert.ok(completed.indexOf(2) < completed.indexOf(0), JSON.stringify(completed));
});

test("global media semaphore respects its limit and still processes every asset", async () => {
  const semaphore = new AsyncSemaphore(3);
  let active = 0;
  let maximum = 0;
  const items = Array.from({ length: 24 }, (_, index) => index);
  const results = await Promise.all(items.map((item) => semaphore.run(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return item;
  })));
  assert.equal(maximum, 3);
  assert.deepEqual(results, items);
});

test("rolling controller ignores isolated media failures and does not require a 12 second note p95", () => {
  let session = createSession({ scope, settings: { concurrencyMode: "auto", concurrencyInitial: 4, concurrencyMax: 12 } });
  for (let index = 0; index < 20; index += 1) {
    session = updateSessionConcurrency(session, {
      result: index === 5 ? "failed" : "succeeded",
      errorClass: index === 5 ? "MEDIA_HTTP_403" : "",
      noteLoadMs: 25_000, totalMs: 60_000,
    }, new Date(Date.UTC(2026, 8, 12, 3, index, 0)).toISOString());
  }
  assert.equal(session.concurrency, 5);
  assert.equal(session.concurrencySamples.length, 20);
  const pressured = updateSessionConcurrency(session, { result: "failed", errorClass: "MEDIA_HTTP_429", rateLimited: true }, "2026-09-12T04:00:00.000Z");
  assert.ok(pressured.mediaConcurrency < session.mediaConcurrency);
  assert.equal(pressured.mediaConcurrencyController.reason, "rate_limited");
});
