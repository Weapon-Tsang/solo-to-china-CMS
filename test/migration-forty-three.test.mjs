import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db.mjs";

test("migration 43 freezes provider configuration on every Vertex Batch run", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stc-migration-43-"));
  const db = openDatabase(path.join(directory, "test.sqlite"));
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.ok(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version >= 43);
  const columns = new Set(db.prepare("PRAGMA table_info(vertex_batch_runs)").all().map((row) => row.name));
  for (const column of ["provider", "model", "location", "project_id", "schema_hash", "prompt_hash", "config_version", "config_digest"]) {
    assert.ok(columns.has(column), column);
  }
});
