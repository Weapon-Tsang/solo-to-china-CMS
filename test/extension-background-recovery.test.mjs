import assert from "node:assert/strict";
import test from "node:test";
import { applyIdentityBatch, createSession, transitionTask } from "../extension/sync-core.js";

test("MV3 module restart automatically requeues and drives an in-flight task without popup Resume", async () => {
  const storage = {};
  let createdTabs = 0;
  const listener = () => ({ addListener() {}, removeListener() {} });
  globalThis.chrome = {
    runtime: {
      onInstalled: listener(), onStartup: listener(), onMessage: listener(),
      getManifest: () => ({ version: "2.0.5" }),
    },
    alarms: { onAlarm: listener(), create: async () => {}, clear: async () => true },
    storage: { local: {
      get: async (defaults) => Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, storage[key] ?? value])),
      set: async (values) => Object.assign(storage, values),
    } },
    tabs: {
      query: async () => [],
      get: async (id) => ({ id, status: "complete", url: "https://www.xiaohongshu.com/explore/restart-active" }),
      update: async (id, options) => ({ id, status: "complete", url: options.url }),
      create: async (options) => ({ id: ++createdTabs, status: "complete", url: options.url }),
      remove: async () => {}, onUpdated: listener(), onRemoved: listener(),
    },
    scripting: { executeScript: async (options) => options.files ? [] : [{ result: {
      ok: false, error: { code: "NOTE_UNAVAILABLE", message: "fixture unavailable", retryable: false },
    } }] },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  try {
    const background = await import(`../extension/background.js?recovery=${Date.now()}`);
    const scope = { key: "scope:restart", url: "https://www.xiaohongshu.com/user/profile/test?tab=fav", label: "Favorites" };
    let session = createSession({ scope, settings: { concurrencyMode: "custom", customConcurrency: 2 } });
    session.phase = "acquisition";
    session.discoveryComplete = true;
    session = applyIdentityBatch(session, [
      { externalId: "restart-done", url: "https://www.xiaohongshu.com/explore/restart-done" },
      { externalId: "restart-active", url: "https://www.xiaohongshu.com/explore/restart-active" },
    ], [{ externalId: "restart-done", known: false }, { externalId: "restart-active", known: false }]);
    session = transitionTask(session, session.queue[0].taskId, "captured");
    session = transitionTask(session, session.queue[1].taskId, "extracting", {
      leaseId: "stale-lease", workerId: "old-worker", leaseStartedAt: session.startedAt,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    storage.favoritesSyncState = session;

    await background.restoreAfterRestart();
    for (let attempt = 0; attempt < 100 && storage.favoritesSyncState?.status === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(storage.favoritesSyncState.status, "completed_with_failures");
    assert.equal(storage.favoritesSyncState.stats.captured, 1);
    assert.equal(storage.favoritesSyncState.stats.failed, 1);
    assert.notEqual(storage.favoritesSyncState.status, "paused_recovered");
    assert.ok(createdTabs >= 1, "automatic drive should rebuild/use a worker tab");
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
