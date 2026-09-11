import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("continuous Note workers and the global media semaphore improve every repair fixture", () => {
  const output = execFileSync(process.execPath, ["scripts/benchmark-extension-repair.mjs"], {
    cwd: new URL("..", import.meta.url), encoding: "utf8",
  });
  const report = JSON.parse(output);
  assert.equal(report.noteWorkers, 8);
  assert.equal(report.mediaConcurrency, 12);
  assert.equal(report.scenarios.length, 3);
  for (const scenario of report.scenarios) {
    assert.ok(scenario.improvement.totalTime >= 3, JSON.stringify(scenario));
    assert.ok(scenario.continuous.notesPerMinute > scenario.old.notesPerMinute, JSON.stringify(scenario));
    assert.ok(scenario.continuous.mediaPerMinute > scenario.old.mediaPerMinute, JSON.stringify(scenario));
    assert.equal(scenario.continuous.peakMediaPipelines, 12);
    assert.ok(scenario.continuous.approximatePeakMemoryMb <= 96);
  }
});
