import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {pathToFileURL} from "node:url";
import {openDatabase,SCHEMA_VERSION} from "../src/db.mjs";

test("migration 72 is additive and leaves legacy certainty unknown",async(t)=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"stc-migration-72-"));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const source=fs.readFileSync(new URL("../src/db.mjs",import.meta.url),"utf8")
    .replace(/^  if \(current < (\d+)\).*$/gm,(line,version)=>Number(version)>=72?'':line);
  const legacyPath=path.join(directory,"db-v71.mjs");
  fs.writeFileSync(legacyPath,source);
  const {openDatabase:openV71}=await import(`${pathToFileURL(legacyPath).href}?schema=71`);
  const filename=path.join(directory,"migration.sqlite");
  let db=openV71(filename);
  db.prepare(`INSERT INTO jobs(id,type,entity_id,status,attempts,max_attempts,available_at,created_at,updated_at)
    VALUES ('legacy-job','compose_publish_page','draft','failed',1,3,'now','now','now')`).run();
  db.close();

  db=openDatabase(filename);
  assert.equal(db.prepare("SELECT MAX(version) version FROM schema_migrations").get().version,SCHEMA_VERSION);
  assert.equal(db.prepare("SELECT failure_execution_kind FROM jobs WHERE id='legacy-job'").get().failure_execution_kind,"legacy_unknown");
  const slotColumns=new Set(db.prepare("PRAGMA table_info(commercial_slots)").all().map((row)=>row.name));
  assert.ok(slotColumns.has("affiliate_asset_revision"));
  assert.ok(slotColumns.has("affiliate_asset_content_hash"));
  for(const table of ["production_failure_diagnostics","visual_candidates","affiliate_asset_versions"]){
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
  }
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check,"ok");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
  db.close();
});
