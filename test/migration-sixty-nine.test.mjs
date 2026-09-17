import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { openDatabase, SCHEMA_VERSION } from "../src/db.mjs";

test("migration 69 reconciles only uniquely approved production owners without enqueue or model calls",async(t)=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"stc-migration-69-"));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const source=fs.readFileSync(new URL("../src/db.mjs",import.meta.url),"utf8")
    .replace(/^  if \(current < (\d+)\).*$/gm,(line,version)=>Number(version)>=69 ? "" : line);
  const legacyPath=path.join(directory,"db-v68.mjs"); fs.writeFileSync(legacyPath,source);
  const {openDatabase:openV68}=await import(`${pathToFileURL(legacyPath).href}?schema=68`);
  const filename=path.join(directory,"migration.sqlite"); let db=openV68(filename);
  db.prepare(`INSERT INTO topic_candidates(id,destination_slug,topic_key,proposed_title,rationale,coverage_score,evidence_count,conflict_count,status,created_at,updated_at)
    VALUES ('unique-candidate','beijing','beijing:unique','Unique','fixture',100,1,0,'candidate','now','now'),
      ('ambiguous-candidate','beijing','beijing:ambiguous','Ambiguous','fixture',100,1,0,'candidate','now','now')`).run();
  const insert=db.prepare(`INSERT INTO content_opportunities(id,destination_slug,topic_key,strategy_version,candidate_id,title,readiness_score,readiness_json,status,approved_at,created_at,updated_at,lifecycle_state)
    VALUES (?,'beijing',?,'3.3',?,?,100,'{"ready":true}','producing',?,'now','now','producing')`);
  insert.run("unique-owner","beijing:unique","unique-candidate","Unique","now");
  insert.run("ambiguous-a","beijing:ambiguous:a","ambiguous-candidate","A","now");
  insert.run("ambiguous-b","beijing:ambiguous:b","ambiguous-candidate","B","now");
  db.prepare(`INSERT INTO jobs(id,type,entity_id,status,attempts,max_attempts,available_at,created_at,updated_at,dedupe_key)
    VALUES ('unique-job','plan_content','unique-candidate','failed',1,3,'now','now','now','unique-job'),
      ('ambiguous-job','plan_content','ambiguous-candidate','failed',1,3,'now','now','now','ambiguous-job')`).run();
  const beforeCalls=db.prepare("SELECT COUNT(*) AS count FROM model_call_metrics").get().count;
  db.close(); db=openDatabase(filename);
  assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version,SCHEMA_VERSION);
  assert.equal(db.prepare("SELECT production_owner_opportunity_id FROM jobs WHERE id='unique-job'").get().production_owner_opportunity_id,"unique-owner");
  assert.equal(db.prepare("SELECT production_owner_opportunity_id FROM jobs WHERE id='ambiguous-job'").get().production_owner_opportunity_id,null);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count,2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM model_call_metrics").get().count,beforeCalls);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check,"ok");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
  db.close();
});
