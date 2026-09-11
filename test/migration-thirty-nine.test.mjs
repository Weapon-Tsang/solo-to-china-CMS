import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db.mjs";

test("migration 39 persists extraction input modality and manifests", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stc-migration-39-"));
  const db = openDatabase(path.join(directory, "database.sqlite"));
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.ok(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version >= 39);
  for (const table of ["segment_extractions", "vertex_batch_items"]) {
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
    assert.ok(columns.has("input_modality"));
    assert.ok(columns.has("input_manifest_json"));
  }
});
