import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { createApplication } from "../src/server.mjs";

test("production APIs expose one state contract and audited idempotent disposition operations", async (t) => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"stc-production-api-"));
  const config=loadConfig({ HOST:"127.0.0.1",PORT:"0",DATABASE_PATH:path.join(directory,"api.sqlite"),
    ADMIN_TOKEN:"production-admin",ADMIN_PASSWORD:"production-password",SESSION_SECRET:"production-api-session-secret-with-enough-entropy",
    MAINTENANCE_ENABLED:"false",LOG_LEVEL:"error" });
  const app=createApplication(config);
  app.repository.db.prepare(`INSERT INTO content_opportunities(id,destination_slug,topic_key,strategy_version,title,readiness_score,readiness_json,status,approved_at,created_at,updated_at,lifecycle_state)
    VALUES ('opp-api','beijing','beijing:api','3.3','API workbench record',20,'{"ready":false,"blockingRequirements":["official_confirmation"]}','approved_waiting_for_evidence','2026-09-01','2026-09-01','2026-09-01','approved')`).run();
  await app.start();
  t.after(async () => { await app.stop();fs.rmSync(directory,{recursive:true,force:true}); });
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const auth={authorization:"Bearer production-admin"};

  let response=await fetch(`${base}/api/content`,{headers:auth});
  assert.equal(response.status,200);
  let body=await response.json();
  assert.equal(body.sections.pending_start,1);
  assert.equal(body.items[0].production_state.readiness,"waiting_for_evidence");

  response=await fetch(`${base}/api/content/opp-api/production-state`,{headers:auth});
  assert.equal(response.status,200);
  body=await response.json();
  assert.equal(body.draft,null);
  assert.equal(body.production_state.current_stage_label,"等待补充证据");

  response=await fetch(`${base}/api/content/opp-api/archive`,{method:"POST",headers:{...auth,"content-type":"application/json","idempotency-key":"api-archive"},body:JSON.stringify({reason:"API test"})});
  assert.equal(response.status,200);
  response=await fetch(`${base}/api/content/opp-api/archive`,{method:"POST",headers:{...auth,"content-type":"application/json","idempotency-key":"api-archive"},body:JSON.stringify({reason:"API test"})});
  assert.equal(response.status,200);
  assert.equal(app.repository.db.prepare("SELECT COUNT(*) AS count FROM production_record_audit WHERE action='archive'").get().count,1);

  response=await fetch(`${base}/api/content/opp-api/production-record`,{method:"DELETE",headers:{...auth,"content-type":"application/json","idempotency-key":"api-delete"},body:JSON.stringify({reason:"API test cleanup"})});
  assert.equal(response.status,200);
  body=await response.json();
  assert.equal(body.production_state.disposition,"deleted");
  response=await fetch(`${base}/api/content/opp-api/history`,{headers:auth});
  assert.equal(response.status,200);
  body=await response.json();
  assert.deepEqual(body.items.filter((item) => item.kind === "record_operation").map((item) => item.action).sort(),["archive","delete_production_record"]);
});

test('media budget grant API accepts only the current failed visual and keeps an audit record', async (t) => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'stc-media-grant-api-'));
  const config=loadConfig({HOST:'127.0.0.1',PORT:'0',DATABASE_PATH:path.join(directory,'api.sqlite'),
    ADMIN_TOKEN:'production-admin',ADMIN_PASSWORD:'production-password',
    SESSION_SECRET:'production-api-session-secret-with-enough-entropy',MAINTENANCE_ENABLED:'false',LOG_LEVEL:'error'});
  const app=createApplication(config);
  const db=app.repository.db;
  app.repository.configureProductionCapabilities({visuals:true});
  db.prepare(`INSERT INTO topic_candidates(id,destination_slug,topic_key,proposed_title,rationale,coverage_score,evidence_count,conflict_count,status,created_at,updated_at)
    VALUES ('grant-topic','beijing','grant','Grant test','fixture',80,0,0,'drafted','now','now')`).run();
  db.prepare(`INSERT INTO content_opportunities(id,destination_slug,topic_key,strategy_version,candidate_id,title,
    readiness_score,readiness_json,status,approved_at,created_at,updated_at,lifecycle_state)
    VALUES ('grant-owner','beijing','grant','3.8','grant-topic','Grant test',100,'{"ready":true}',
      'producing','now','now','now','producing')`).run();
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at)
    VALUES ('grant-brief','beijing','Test','[]','informational','drafted','now','now')`).run();
  db.prepare("UPDATE content_briefs SET candidate_id='grant-topic' WHERE id='grant-brief'").run();
  db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at)
    VALUES ('grant-draft','grant-brief','Test','test','Preserved body','{}','needs_review','now','now')`).run();
  db.prepare(`INSERT INTO article_visuals(id,draft_id,slot,placement,purpose,alt_text,generation_prompt,status,created_at,updated_at)
    VALUES ('grant-visual','grant-draft',1,'hero','Test','Test','Test','failed','now','now')`).run();
  db.prepare(`INSERT INTO media_quota_scopes(scope_key,updated_at) VALUES ('vertex:project:model','now')`).run();
  for (let n=0;n<config.visuals.maxDispatchesPerStep;n++) db.prepare(`INSERT INTO media_dispatches
    (id,scope_key,visual_id,substage,started_at_ms,state,created_at) VALUES (?,?,?,?,?,'failed','now')`)
    .run(`dispatch-${n}`,'vertex:project:model','grant-visual','generate_visual',n);
  db.prepare(`INSERT INTO jobs(id,type,entity_id,status,attempts,max_attempts,available_at,created_at,updated_at,
    production_owner_opportunity_id,last_failure_code)
    VALUES ('grant-job','generate_visuals','grant-draft','failed',4,4,'now','now','now',
      'grant-owner','MEDIA_BUDGET_EXHAUSTED')`).run();
  await app.start();
  t.after(async()=>{await app.stop();fs.rmSync(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const endpoint=`${base}/api/content/grant-owner/media-budget-grants`;
  const headers={authorization:'Bearer production-admin','content-type':'application/json'};
  const body={visualId:'grant-visual',substage:'generate_visual',additionalDispatches:2,
    reason:'Editor reviewed the exhausted image',idempotencyKey:'grant-api-1'};
  assert.equal((await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).status,401);
  assert.equal((await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({...body,visualId:'other'})})).status,409);
  let response=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify(body)});
  assert.equal(response.status,200);
  assert.equal((await response.json()).limit,config.visuals.maxDispatchesPerStep+2);
  response=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify(body)});
  assert.equal(response.status,200);
  assert.equal((await response.json()).idempotent,true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media_budget_grants').get().n,1);
  assert.equal(db.prepare('SELECT spent_at_grant FROM media_budget_grants').get().spent_at_grant,
    config.visuals.maxDispatchesPerStep);
  response=await fetch(`${base}/api/content/grant-owner/production-state`,{headers});
  assert.equal((await response.json()).media_budgets[0].granted,2);
});
