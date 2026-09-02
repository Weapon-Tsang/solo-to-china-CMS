import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBackup, drillBackup, verifyBackup } from "../src/backup.mjs";
import { openDatabase } from "../src/db.mjs";

test("database backup creates and verifies a consistent SQLite snapshot", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-to-china-backup-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "source.sqlite");
  const database = openDatabase(databasePath);
  database.prepare("INSERT INTO destinations(id, slug, name, created_at, updated_at) VALUES ('d1','beijing','Beijing','now','now')").run();
  database.close();

  const result = createBackup({
    databasePath,
    backupDir: path.join(directory, "backups"),
    retention: 2,
    clock: () => new Date("2026-08-23T12:00:00.000Z"),
  });
  assert.equal(result.schemaVersion, 15);
  assert.equal(result.integrity, "ok");
  assert.ok(fs.existsSync(result.backupPath));
  assert.ok(fs.existsSync(result.manifestPath));
  const verification = verifyBackup(result.backupPath);
  assert.equal(verification.sha256, result.sha256);
  const drill = drillBackup(result.backupPath);
  assert.equal(drill.drill, "passed");
  assert.equal(drill.counts.sources, 0);
  assert.equal(drill.counts.jobs, 0);
});
