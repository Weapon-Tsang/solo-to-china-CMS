import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db.mjs";

test("migration 45 adds explicit date semantics without fabricating source dates", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cms-migration-45-"));
  const db = openDatabase(path.join(directory, "database.sqlite"));
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const sourceColumns = new Set(db.prepare("PRAGMA table_info(sources)").all().map((row) => row.name));
  const claimColumns = new Set(db.prepare("PRAGMA table_info(claims)").all().map((row) => row.name));
  assert.ok(["date_kind", "date_confidence", "valid_from", "valid_to"].every((name) => sourceColumns.has(name)));
  assert.ok(["date_kind", "date_confidence", "valid_from", "valid_to"].every((name) => claimColumns.has(name)));
  assert.ok(db.prepare("PRAGMA table_info(knowledge_facts)").all().some((row) => row.name === "validity_state"));

  const migration = db.prepare("SELECT version FROM schema_migrations WHERE version=45").get();
  assert.equal(migration.version, 45);
});
