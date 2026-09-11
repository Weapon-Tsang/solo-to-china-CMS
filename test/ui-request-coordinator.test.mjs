import assert from "node:assert/strict";
import test from "node:test";
import { classifyRefreshOutcome, createInFlightRequestCoordinator, createLatestRequestCoordinator } from "../frontend/src/lib/request-coordinator.js";

test("a slow detail A cannot replace faster detail B", async () => {
  const coordinator = createLatestRequestCoordinator();
  let resolveA;
  let resolveB;
  const a = new Promise((resolve) => { resolveA = resolve; });
  const b = new Promise((resolve) => { resolveB = resolve; });
  let visible = null;
  const requestA = coordinator.begin();
  const pendingA = a.then((value) => { if (requestA.isCurrent()) visible = value; });
  const requestB = coordinator.begin();
  const pendingB = b.then((value) => { if (requestB.isCurrent()) visible = value; });
  assert.equal(requestA.signal.aborted, true);
  resolveB("B");
  await pendingB;
  resolveA("A");
  await pendingA;
  assert.equal(visible, "B");
});

test("closing a detail invalidates its late response", async () => {
  const coordinator = createLatestRequestCoordinator();
  const request = coordinator.begin();
  coordinator.invalidate();
  assert.equal(request.signal.aborted, true);
  assert.equal(request.isCurrent(), false);
});

test("polling reuses an in-flight request for the same view", async () => {
  const coordinator = createInFlightRequestCoordinator();
  let resolve;
  let calls = 0;
  const first = coordinator.run("content", () => {
    calls += 1;
    return new Promise((done) => { resolve = done; });
  });
  const polled = coordinator.run("content", () => {
    calls += 1;
    return Promise.resolve("unexpected");
  });
  assert.equal(polled, first);
  assert.equal(calls, 1);
  assert.equal(coordinator.isPending("content"), true);
  resolve("loaded");
  assert.equal(await polled, "loaded");
  assert.equal(coordinator.isPending("content"), false);
  assert.equal(await coordinator.run("content", () => Promise.resolve("fresh")), "fresh");
});

test("switching views aborts the obsolete in-flight request", async () => {
  const coordinator = createInFlightRequestCoordinator();
  let contentSignal;
  const content = coordinator.run("content", ({ signal }) => {
    contentSignal = signal;
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  });
  await Promise.resolve();
  const settings = coordinator.run("settings", ({ signal }) => {
    assert.equal(signal.aborted, false);
    return Promise.resolve("settings");
  });
  assert.equal(contentSignal.aborted, true);
  await assert.rejects(content, /aborted/);
  assert.equal(await settings, "settings");
});

test("refresh reports partial and failed outcomes instead of false success", () => {
  const ok = { status: "fulfilled", value: { ok: true } };
  const failedView = { status: "fulfilled", value: { ok: false, error: new Error("List returned 500") } };
  const failedOverview = { status: "rejected", reason: new Error("Dashboard returned 500") };
  assert.equal(classifyRefreshOutcome(ok, failedView).state, "partial");
  assert.match(classifyRefreshOutcome(ok, failedView).message, /List returned 500/);
  assert.equal(classifyRefreshOutcome(failedOverview, failedView).state, "failed");
  assert.equal(classifyRefreshOutcome(ok, ok).state, "success");
});
