import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openDatabase } from "../src/db.mjs";

test("migration 33 adds an indexed queue without changing existing affiliate data", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-migration-33-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "v32.sqlite");
  const source = fs.readFileSync(fileURLToPath(new URL("../src/db.mjs", import.meta.url)), "utf8")
    .replace(/^  if \(current < 3[3-5]\).*$/gm, "");
  const v32ModulePath = path.join(directory, "db-v32.mjs");
  fs.writeFileSync(v32ModulePath, source);
  const { openDatabase: openV32Database } = await import(`${pathToFileURL(v32ModulePath).href}?v=32`);
  const legacy = openV32Database(databasePath);
  legacy.prepare(`INSERT INTO affiliate_provider_accounts(id,provider_key,display_name,connection_mode,site_name,
    default_language,default_disclosure,status,created_at,updated_at)
    VALUES ('provider-existing','trip-com','Trip.com','MANUAL','','en','','CONFIGURED',datetime('now'),datetime('now'))`).run();
  assert.equal(legacy.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 32);
  legacy.close();

  const upgraded = openDatabase(databasePath);
  try {
    assert.equal(upgraded.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 35);
    assert.equal(upgraded.prepare("SELECT display_name FROM affiliate_provider_accounts WHERE id='provider-existing'").get().display_name, "Trip.com");
    const indexes = new Set(upgraded.prepare("PRAGMA index_list(affiliate_asset_queue_tasks)").all().map((item) => item.name));
    assert.ok(indexes.has("idx_affiliate_queue_status_key"));
    assert.ok(indexes.has("idx_affiliate_queue_opportunity"));
    assert.ok(indexes.has("idx_affiliate_queue_provider"));
    assert.deepEqual(upgraded.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { upgraded.close(); }
});
