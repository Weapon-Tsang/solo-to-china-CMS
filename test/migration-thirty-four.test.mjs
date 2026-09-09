import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openDatabase } from "../src/db.mjs";

test("migration 34 aligns Trip.com tools and updates incomplete destination attraction tasks", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-migration-34-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "v33.sqlite");
  const source = fs.readFileSync(fileURLToPath(new URL("../src/db.mjs", import.meta.url)), "utf8")
    .replace(/^  if \(current < 3[4-7]\).*$/gm, "");
  const v33ModulePath = path.join(directory, "db-v33.mjs");
  fs.writeFileSync(v33ModulePath, source);
  const { openDatabase: openV33Database } = await import(`${pathToFileURL(v33ModulePath).href}?v=33`);
  const legacy = openV33Database(databasePath);
  legacy.prepare(`INSERT INTO affiliate_provider_accounts(id,provider_key,display_name,connection_mode,site_name,
    default_language,default_disclosure,status,created_at,updated_at)
    VALUES ('provider-trip','trip-com','Trip.com','MANUAL','SoloToChina','en','','CONFIGURED',datetime('now'),datetime('now'))`).run();
  legacy.prepare(`INSERT INTO affiliate_asset_queue_tasks(id,task_key,provider_account_id,provider,status,product_category,
    asset_type,scope_type,scope_key,destination_slug,trip_tool_type,trip_destination,trip_sub1,suggested_title,source_type,
    created_at,updated_at) VALUES ('task-beijing','trip:attraction:destination:beijing','provider-trip','Trip.com',
    'READY_FOR_MANUAL','ATTRACTION','CATEGORY_LINK','DESTINATION','beijing','beijing','CUSTOM_LINK','Beijing',
    'stc_attraction_beijing','Tickets and attractions in Beijing','SEED',datetime('now'),datetime('now'))`).run();
  legacy.prepare(`INSERT INTO affiliate_asset_queue_tasks(id,task_key,provider_account_id,provider,status,product_category,
    asset_type,scope_type,scope_key,destination_slug,trip_tool_type,trip_destination,trip_sub1,suggested_title,source_type,
    created_at,updated_at,skipped_at) VALUES ('task-shanghai','trip:attraction:destination:shanghai','provider-trip','Trip.com',
    'SKIPPED','ATTRACTION','CATEGORY_LINK','DESTINATION','shanghai','shanghai','CUSTOM_LINK','Shanghai',
    'stc_attraction_shanghai','Tickets and attractions in Shanghai','SEED',datetime('now'),datetime('now'),datetime('now'))`).run();
  assert.equal(legacy.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 33);
  legacy.close();

  const upgraded = openDatabase(databasePath);
  try {
    assert.equal(upgraded.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 37);
    const task = upgraded.prepare("SELECT * FROM affiliate_asset_queue_tasks WHERE id='task-beijing'").get();
    assert.equal(task.trip_tool_type, "ATTRACTIONS_TOURS");
    assert.equal(task.trip_pickup_location, "");
    assert.equal(upgraded.prepare("SELECT trip_tool_type FROM affiliate_asset_queue_tasks WHERE id='task-shanghai'").get().trip_tool_type, "CUSTOM_LINK");
    upgraded.prepare("UPDATE affiliate_asset_queue_tasks SET trip_tool_type='CAR_RENTALS',trip_pickup_location='Beijing' WHERE id='task-beijing'").run();
    assert.deepEqual(upgraded.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { upgraded.close(); }
});
