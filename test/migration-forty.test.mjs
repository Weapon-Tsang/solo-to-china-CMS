import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db.mjs";

test("migration 40 persists Batch result ingestion and cleanup state", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stc-migration-40-"));
  const db = openDatabase(path.join(directory, "database.sqlite"));
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.ok(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version >= 40);
  const runColumns = new Set(db.prepare("PRAGMA table_info(vertex_batch_runs)").all().map((row) => row.name));
  for (const name of ["result_state", "output_read_attempts", "output_checksum", "last_output_error", "cleanup_eligible_at", "cleaned_at"]) {
    assert.ok(runColumns.has(name));
  }
  const itemColumns = new Set(db.prepare("PRAGMA table_info(vertex_batch_items)").all().map((row) => row.name));
  for (const name of ["output_object", "output_line", "output_checksum", "ingested_at"]) assert.ok(itemColumns.has(name));
});
