import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db.mjs";

test("migration 41 stores authoritative Batch correlation and anomalies", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stc-migration-41-"));
  const db = openDatabase(path.join(directory, "database.sqlite"));
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 41);
  const jobColumns = new Set(db.prepare("PRAGMA table_info(jobs)").all().map((row) => row.name));
  assert.ok(jobColumns.has("execution_route"));
  const itemColumns = new Set(db.prepare("PRAGMA table_info(vertex_batch_items)").all().map((row) => row.name));
  for (const name of ["transport_key", "request_fingerprint", "correlation_warning"]) assert.ok(itemColumns.has(name));
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vertex_batch_output_anomalies'").get());
});
