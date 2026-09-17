import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { openDatabase, SCHEMA_VERSION } from "../src/db.mjs";

test("migration 68 adds production record controls without jobs, model calls or historical replay", async (t) => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"stc-migration-68-"));
  t.after(() => fs.rmSync(directory,{recursive:true,force:true}));
  const source=fs.readFileSync(new URL("../src/db.mjs",import.meta.url),"utf8")
    .replace(/^  if \(current < (\d+)\).*$/gm,(line,version) => Number(version)>=68 ? "" : line);
  const legacyPath=path.join(directory,"db-v67.mjs");
  fs.writeFileSync(legacyPath,source);
  const { openDatabase:openV67 }=await import(`${pathToFileURL(legacyPath).href}?schema=67`);
  const filename=path.join(directory,"migration.sqlite");
  let db=openV67(filename);
  db.prepare(`INSERT INTO content_opportunities(id,destination_slug,topic_key,strategy_version,title,readiness_score,readiness_json,status,approved_at,created_at,updated_at,lifecycle_state)
    VALUES ('opp-legacy','beijing','beijing:legacy','3.3','Legacy approved content',20,'{"ready":false}','approved_waiting_for_evidence','2026-09-01','2026-09-01','2026-09-01','approved')`).run();
  assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version,67);
  db.close();

  for (let attempt=0;attempt<2;attempt+=1) {
    db=openDatabase(filename);
    assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version,SCHEMA_VERSION);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM production_record_controls").get().count,0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM production_record_audit").get().count,0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count,0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM model_call_metrics").get().count,0);
    assert.equal(db.prepare("SELECT title,approved_at FROM content_opportunities WHERE id='opp-legacy'").get().title,"Legacy approved content");
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check,"ok");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
    db.close();
  }
});
