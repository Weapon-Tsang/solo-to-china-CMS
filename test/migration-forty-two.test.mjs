import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db.mjs";

test("migration 42 stores durable Batch routing, classification, budget, and eligibility", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stc-migration-42-"));
  const db = openDatabase(path.join(directory, "test.sqlite"));
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.ok(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version >= 42);
  const columns = new Set(db.prepare("PRAGMA table_info(jobs)").all().map((row) => row.name));
  for (const column of ["execution_route", "failure_class", "batch_attempts", "next_eligible_at", "last_failure_code"]) {
    assert.ok(columns.has(column), column);
  }
});
