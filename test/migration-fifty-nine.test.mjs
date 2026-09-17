import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openDatabase, SCHEMA_VERSION } from "../src/db.mjs";
import { Repository } from "../src/repository.mjs";

test("migration 59 archives the four historical seed assets without deleting audit rows", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stc-migration-59-"));
  t.after(() => fs.rmSync(directory, { recursive:true,force:true }));
  const databasePath = path.join(directory,"v58.sqlite");
  const source = fs.readFileSync(fileURLToPath(new URL("../src/db.mjs",import.meta.url)),"utf8")
    .replace(/^  if \(current < (\d+)\).*$/gm,(line,version) => Number(version) >= 59 ? "" : line);
  const modulePath = path.join(directory,"db-v58.mjs");
  fs.writeFileSync(modulePath,source);
  const { openDatabase:openV58Database } = await import(`${pathToFileURL(modulePath).href}?v=58`);
  const legacy = openV58Database(databasePath);
  legacy.prepare(`INSERT INTO affiliate_provider_accounts(id,provider_key,display_name,created_at,updated_at)
    VALUES ('provider','trip','Trip.com','2026-09-01','2026-09-01')`).run();
  const names = [
    ["beijing-hotel","trip:hotel:destination:beijing","HOTEL","HOTELS","Hotels in Beijing"],
    ["shanghai-hotel","trip:hotel:destination:shanghai","HOTEL","HOTELS","Hotels in Shanghai"],
    ["beijing-ticket","trip:attraction:destination:beijing","ATTRACTION","ATTRACTIONS_TOURS","Tickets and attractions in Beijing"],
    ["shanghai-ticket","trip:attraction:destination:shanghai","ATTRACTION","ATTRACTIONS_TOURS","Tickets and attractions in Shanghai"],
  ];
  for (const [assetId,taskKey,category,tool,title] of names) {
    legacy.prepare(`INSERT INTO affiliate_assets(id,provider_account_id,provider,asset_type,product_category,scope_type,scope_key,title,target_url,created_at,updated_at)
      VALUES (?,?, 'Trip.com','CATEGORY_LINK',?,'DESTINATION',?,?, 'https://trip.com/', '2026-09-01','2026-09-01')`)
      .run(assetId,"provider",category,taskKey.includes("beijing") ? "beijing" : "shanghai",title);
    legacy.prepare(`INSERT INTO affiliate_asset_mappings(id,affiliate_asset_id,scope_type,scope_key,created_at)
      VALUES (?,?, 'DESTINATION',?, '2026-09-01')`).run(`mapping-${assetId}`,assetId,taskKey.includes("beijing") ? "beijing" : "shanghai");
    legacy.prepare(`INSERT INTO affiliate_asset_queue_tasks(id,task_key,provider_account_id,provider,status,product_category,asset_type,
      scope_type,scope_key,trip_tool_type,trip_sub1,suggested_title,source_type,affiliate_asset_id,created_at,updated_at)
      VALUES (?,?,?,'Trip.com','COMPLETED',?,'CATEGORY_LINK','DESTINATION',?,?,?,?, 'SEED',?,'2026-09-01','2026-09-01')`)
      .run(`task-${assetId}`,taskKey,"provider",category,taskKey.includes("beijing") ? "beijing" : "shanghai",tool,`seed_${assetId.replaceAll("-","_")}`,title,assetId);
  }
  legacy.close();

  const upgraded = openDatabase(databasePath);
  assert.equal(upgraded.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version,SCHEMA_VERSION);
  assert.equal(upgraded.prepare("SELECT COUNT(*) AS count FROM affiliate_assets WHERE lifecycle_state='legacy_test_seed' AND active=0").get().count,4);
  assert.equal(upgraded.prepare("SELECT COUNT(*) AS count FROM affiliate_asset_mappings WHERE active=0").get().count,4);
  assert.equal(upgraded.prepare("SELECT COUNT(*) AS count FROM affiliate_asset_queue_tasks WHERE source_type='SEED'").get().count,4);
  const repository = new Repository(upgraded,{});
  assert.equal(repository.listAffiliateAssets({activeOnly:true}).length,0);
  upgraded.close();
});
