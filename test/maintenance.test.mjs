import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db.mjs";
import { MaintenanceScheduler } from "../src/maintenance.mjs";
import { Repository } from "../src/repository.mjs";

test("maintenance scheduler backs up, reconciles, prunes, and records durable state", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-to-china-maintenance-test-"));
  const databasePath = path.join(directory, "maintenance.sqlite");
  const database = openDatabase(databasePath);
  const repository = new Repository(database);
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const oldJob = repository.enqueue("rebuild_editorial", "old");
  database.prepare("UPDATE jobs SET status='succeeded', updated_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(oldJob);
  const pipeline = { calls: 0, async runOne() { this.calls += 1; return false; } };
  const scheduler = new MaintenanceScheduler(repository, pipeline, {
    enabled: true,
    intervalMinutes: 15,
    knowledgeReconcileHours: 24,
    autoBackupHours: 24,
    jobHistoryRetentionDays: 30,
    databasePath,
    backupDir: path.join(directory, "backups"),
    backupRetention: 2,
  });

  const first = await scheduler.runDue({ force: true });
  // Entity alias reconciliation is a first-class recurring task alongside
  // knowledge reconciliation, backup, and job-history cleanup.
  assert.equal(first.results.filter((item) => item.status === "succeeded").length, 4);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM jobs WHERE id=?").get(oldJob).count, 0);
  assert.equal(repository.listMaintenanceRuns().length, 4);
  assert.equal(fs.readdirSync(path.join(directory, "backups")).filter((name) => name.endsWith(".sqlite")).length, 1);

  const second = await scheduler.runDue();
  assert.ok(second.results.every((item) => item.status === "fresh"));

  const invalidBackupDir = path.join(directory, "not-a-directory");
  fs.writeFileSync(invalidBackupDir, "blocked");
  const failing = new MaintenanceScheduler(repository, pipeline, { ...scheduler.config, backupDir: invalidBackupDir });
  const failedRun = await failing.runDue({ force: true });
  assert.equal(failedRun.results.find((item) => item.task === "database_backup").status, "failed");
  assert.ok(repository.listOperationalExceptions().some((item) => item.kind === "maintenance"));
});
