import assert from "node:assert/strict";
import test from "node:test";
import { classifyRefreshOutcome, createLatestRequestCoordinator } from "../frontend/src/lib/request-coordinator.js";

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

test("refresh reports partial and failed outcomes instead of false success", () => {
  const ok = { status: "fulfilled", value: { ok: true } };
  const failedView = { status: "fulfilled", value: { ok: false, error: new Error("List returned 500") } };
  const failedOverview = { status: "rejected", reason: new Error("Dashboard returned 500") };
  assert.equal(classifyRefreshOutcome(ok, failedView).state, "partial");
  assert.match(classifyRefreshOutcome(ok, failedView).message, /List returned 500/);
  assert.equal(classifyRefreshOutcome(failedOverview, failedView).state, "failed");
  assert.equal(classifyRefreshOutcome(ok, ok).state, "success");
});
