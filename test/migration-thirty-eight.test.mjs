import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db.mjs";

test("migration 38 stores auditable automated evidence consensus", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stc-migration-38-"));
  const db = openDatabase(path.join(directory, "database.sqlite"));
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 38);
  const columns = new Set(db.prepare("PRAGMA table_info(knowledge_facts)").all().map((row) => row.name));
  assert.ok(columns.has("consensus_method"));
  assert.ok(columns.has("consensus_confidence"));
  assert.ok(columns.has("consensus_detail_json"));
});
