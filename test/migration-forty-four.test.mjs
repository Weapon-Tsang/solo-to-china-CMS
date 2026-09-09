import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase, SCHEMA_VERSION } from "../src/db.mjs";

test("migration 44 adds monotonic job fencing and preparation leases", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stc-migration-44-"));
  const db = openDatabase(path.join(directory, "test.sqlite"));
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, SCHEMA_VERSION);
  assert.ok(db.prepare("PRAGMA table_info(jobs)").all().some((row) => row.name === "lease_generation"));
  const runColumns = new Set(db.prepare("PRAGMA table_info(vertex_batch_runs)").all().map((row) => row.name));
  for (const column of ["preparation_owner", "preparation_generation", "preparation_lease_expires_at"]) assert.ok(runColumns.has(column));
});
