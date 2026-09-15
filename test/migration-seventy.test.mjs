import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { openDatabase, SCHEMA_VERSION } from "../src/db.mjs";

test("migration 70 adds explainable commercial overlays without enqueueing or rewriting editorial data",async(t)=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"stc-migration-70-"));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const source=fs.readFileSync(new URL("../src/db.mjs",import.meta.url),"utf8")
    .replace(/^  if \(current < (\d+)\).*$/gm,(line,version)=>Number(version)>=70 ? "" : line);
  const legacyPath=path.join(directory,"db-v69.mjs"); fs.writeFileSync(legacyPath,source);
  const {openDatabase:openV69}=await import(`${pathToFileURL(legacyPath).href}?schema=69`);
  const filename=path.join(directory,"migration.sqlite"); let db=openV69(filename);
  db.prepare(`INSERT INTO topic_candidates(id,destination_slug,topic_key,proposed_title,rationale,coverage_score,evidence_count,conflict_count,status,created_at,updated_at)
    VALUES ('candidate','chongqing','chongqing:guide','Guide','fixture',100,1,0,'drafted','now','now')`).run();
  db.prepare(`INSERT INTO content_briefs(id,candidate_id,destination_slug,topic,audience,search_intent,status,created_at,updated_at)
    VALUES ('brief','candidate','chongqing','Guide','[]','informational','drafted','now','now')`).run();
  db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at,revision,content_hash)
    VALUES ('draft','brief','Preserved title','preserved','Preserved body','{}','commercial_ready','now','now',3,'body-hash')`).run();
  db.prepare(`INSERT INTO commercial_compositions(id,draft_id,publishable_body_markdown,slots_json,offer_ids_json,disclosure_text,status,created_at,updated_at)
    VALUES ('composition','draft','Preserved body','[]','[]','','no_offers','now','now')`).run();
  db.prepare(`INSERT INTO wordpress_publications(id,draft_id,site_url,status,strategy_version,created_at,updated_at)
    VALUES ('wp','draft','https://site.test','synced','3.3','now','now')`).run();
  const jobsBefore=db.prepare("SELECT COUNT(*) n FROM jobs").get().n;
  db.close(); db=openDatabase(filename);
  assert.equal(db.prepare("SELECT MAX(version) version FROM schema_migrations").get().version,SCHEMA_VERSION);
  const composition=db.prepare("SELECT outcome,diagnostics_json,manifest_json,refresh_required FROM commercial_compositions WHERE draft_id='draft'").get();
  assert.deepEqual({...composition},{outcome:"intentional_noop",diagnostics_json:"{}",manifest_json:"{}",refresh_required:0});
  assert.equal(db.prepare("SELECT body_markdown FROM article_drafts WHERE id='draft'").get().body_markdown,"Preserved body");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs").get().n,jobsBefore);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM commercial_overlay_history").get().n,0);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check,"ok");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
  db.close();
});
