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
