import assert from "node:assert/strict";
import test from "node:test";
import { acquisitionStatus, completionStatus, deriveSyncProgress, progressCards } from "../extension/popup-state.js";

const activeStates = ["opening", "loading", "extracting", "submitting"];

test("Repair progress distinguishes the cumulative total from current work", () => {
  const session = fixture("repair", {
    repair: 72, captured: 60,
    tasks: [...activeStates.slice(0, 2), ...Array(10).fill("queued")],
  });
  assert.deepEqual(deriveSyncProgress(session), {
    completed: 60, inFlight: 2, queued: 10, retryWait: 0, failed: 0, total: 72,
  });
  assert.deepEqual(progressCards(session), [
    ["修复进度", "60 / 72"], ["正在修复", 2], ["等待修复", 10], ["失败", 0],
  ]);
  assert.match(acquisitionStatus(session), /进度 60 \/ 72，正在处理 2 条，等待 10 条，当前并发 8/);
  assert.ok(!progressCards(session).some(([label]) => label === "待修复"));
});

test("Repair progress reports queued and retry_wait separately", () => {
  const session = fixture("repair", {
    repair: 72, captured: 60,
    tasks: [...activeStates.slice(0, 2), ...Array(8).fill("queued"), ...Array(2).fill("retry_wait")],
  });
  assert.deepEqual(progressCards(session), [
    ["修复进度", "60 / 72"], ["正在修复", 2], ["等待修复", 8], ["等待重试", 2], ["失败", 0],
  ]);
  assert.match(acquisitionStatus(session), /等待 8 条，等待重试 2 条/);
});

test("Repair completion is terminal even when a few items cannot recover", () => {
  assert.equal(completionStatus(fixture("repair", { repair: 72, captured: 72 })), "修复完成：已修复 72 / 72，失败 0。");
  assert.equal(completionStatus(fixture("repair", { repair: 72, captured: 68, failed: 4 })), "修复完成：已修复 68 / 72，无法自动恢复 4。");
});

test("Incremental and Full use collection and verification language respectively", () => {
  const incremental = progressCards(fixture("incremental", { discovered: 75, known: 3, newCount: 72, captured: 60, tasks: ["opening", "queued"] }));
  assert.deepEqual(incremental.map(([label]) => label), ["已发现", "已存在", "新增", "已采集", "排队中", "失败"]);
  assert.doesNotMatch(JSON.stringify(incremental), /修复|核验/);

  const full = fixture("full", { newCount: 60, repair: 12, captured: 60, tasks: ["loading", ...Array(11).fill("queued")] });
  assert.deepEqual(progressCards(full), [
    ["需核验总数", 72], ["已核验", 60], ["正在核验", 1], ["等待核验", 11], ["失败", 0],
  ]);
  assert.doesNotMatch(JSON.stringify(progressCards(full)), /修复/);
  assert.match(acquisitionStatus(full), /^正在完整核验收藏/);
});

function fixture(mode, { repair = 0, captured = 0, duplicate = 0, failed = 0, discovered = 0, known = 0, newCount = 0, tasks = [] }) {
  return {
    mode, concurrency: 8,
    stats: { repair, captured, duplicate, failed, discovered, known, new: newCount },
    queue: tasks.map((status, index) => ({ taskId: `task-${index}`, status })),
  };
}
