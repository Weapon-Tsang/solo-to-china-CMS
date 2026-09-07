import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openDatabase } from "../src/db.mjs";

test("migration 22 preserves Contract snapshots and adds auditable Publish Composition storage", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-migration-22-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "v21.sqlite");
  const dbModulePath = fileURLToPath(new URL("../src/db.mjs", import.meta.url));
  const v21ModulePath = path.join(directory, "db-v21.mjs");
  const source = fs.readFileSync(dbModulePath, "utf8")
    .replace(/^  if \(current < (?:2[2-9]|30|31)\).*$/gm, "");
  fs.writeFileSync(v21ModulePath, source);
  const { openDatabase: openV21Database } = await import(`${pathToFileURL(v21ModulePath).href}?v=21`);
  const v21 = openV21Database(databasePath);
  v21.prepare(`INSERT INTO frontend_contract_snapshots(id, source_repository, registry_source, page_schema_source,
    contract_version, schema_version, checksum, registry_json, page_schema_json, status, synced_at)
    VALUES ('contract-v21','repo','registry','schema','1.0.0','2020-12','old-checksum','{}','{}','active','2026-09-06T00:00:00.000Z')`).run();
  assert.equal(v21.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 21);
  v21.close();

  const upgraded = openDatabase(databasePath);
  try {
    assert.equal(upgraded.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 31);
    assert.equal(upgraded.prepare("SELECT publish_package_schema_json FROM frontend_contract_snapshots WHERE id='contract-v21'").get().publish_package_schema_json, "{}");
    assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='frontend_publish_compositions'").get());
    assert.ok(upgraded.prepare("PRAGMA table_info(wordpress_publications)").all().some((column) => column.name === "delivery_mode"));
    assert.deepEqual(upgraded.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    upgraded.close();
  }
});
