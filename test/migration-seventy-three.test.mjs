import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { openDatabase, SCHEMA_VERSION } from "../src/db.mjs";

test("migration 73 adds routing state without replaying or relabeling historical work", async (t) => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"stc-migration-73-"));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const source=fs.readFileSync(new URL("../src/db.mjs",import.meta.url),"utf8")
    .replace(/^  if \(current < (\d+)\).*$/gm,(line,version)=>Number(version)>=73?"":line);
  const legacyPath=path.join(directory,"db-v72.mjs");fs.writeFileSync(legacyPath,source);
  const {openDatabase:openV72}=await import(`${pathToFileURL(legacyPath).href}?schema=72`);
  const filename=path.join(directory,"migration.sqlite");let db=openV72(filename);
  db.prepare(`INSERT INTO jobs(id,type,entity_id,status,attempts,max_attempts,available_at,created_at,updated_at)
    VALUES ('old-job','extract_segment_claims','segment','queued',0,3,'now','now','now')`).run();
  const jobsBefore=db.prepare("SELECT COUNT(*) n FROM jobs").get().n;
  const callsBefore=db.prepare("SELECT COUNT(*) n FROM model_call_metrics").get().n;
  db.close();db=openDatabase(filename);
  assert.equal(db.prepare("SELECT MAX(version) v FROM schema_migrations").get().v,SCHEMA_VERSION);
  assert.deepEqual({...db.prepare("SELECT model_role,model_profile_json,model_routing_revision FROM jobs WHERE id='old-job'").get()},
    {model_role:"unassigned",model_profile_json:"{}",model_routing_revision:null});
  assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs").get().n,jobsBefore);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM model_call_metrics").get().n,callsBefore);
  for(const table of ["model_credentials","model_routing_settings","model_routing_audit","draft_knowledge_updates","luna_dispute_reviews"]){
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
  }
  assert.equal(db.prepare("SELECT active_provider FROM model_routing_settings").get().active_provider,"legacy");
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check,"ok");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);db.close();
});
