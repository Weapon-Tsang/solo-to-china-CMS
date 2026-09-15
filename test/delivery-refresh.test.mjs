import assert from "node:assert/strict";
import test from "node:test";
import { applyDeliveryRefresh, planDeliveryRefresh } from "../src/services/delivery-refresh.mjs";

function fixture({ modifiedAt="2026-09-15T06:36:52Z", status="draft" } = {}) {
  const commands=[];
  const jobs=[];
  const repository={
    listWordPressInventory:()=>[{site_url:"https://site.test",post_id:96,status,modified_at:modifiedAt,title:"Guide"}],
    getWordPressSyncState:()=>({last_succeeded_at:new Date().toISOString()}),
    getDraftPackage:()=>({
      draft:{id:"draft-1",title:"Guide",revision:4,content_hash:"content-hash",body_markdown:"Frozen body",visuals:[{id:"visual-1",asset_fingerprint:"visual-hash"}]},
      review:{passed:1},frontend_page:{id:"page-1",current:true,draft_content_hash:"content-hash"},
      publication:{post_id:96,updated_at:"2026-09-15T06:36:55Z",response_json:'{"status":"draft"}'},
    }),
    db:{
      exec:(sql)=>commands.push(sql),
      prepare:(sql)=>({
        get:()=>sql.includes("topic_candidates") ? {opportunity_id:"opp-1"} : undefined,
        run:()=>({changes:1}),
      }),
    },
    enqueue:(stage,draftId,options)=>{jobs.push({stage,draftId,options});return "job-1";},
  };
  return {repository,commands,jobs};
}

test("delivery refresh requires a fresh exact whitelist and preserves body/media layers",()=>{
  const {repository}=fixture();
  const plan=planDeliveryRefresh(repository,{scope:"presentation",draft_ids:["draft-1"]});
  assert.equal(plan.summary.eligible,1);
  assert.equal(plan.items[0].planned_stage,"compose_frontend_page");
  assert.match(plan.items[0].preserve.body_sha256,/^[a-f0-9]{64}$/);
  assert.match(plan.confirmation,/^[a-f0-9]{64}$/);
});

test("delivery refresh stops on an external WordPress edit and stale confirmation",()=>{
  const changed=planDeliveryRefresh(fixture({modifiedAt:"2026-09-15T07:00:00Z"}).repository,{scope:"presentation",draft_ids:["draft-1"]});
  assert.equal(changed.items[0].reason,"wordpress_draft_changed_outside_cms");
  const {repository}=fixture();
  assert.throws(()=>applyDeliveryRefresh(repository,{scope:"presentation",draft_ids:["draft-1"],confirmation:"stale"}),
    (error)=>error.code==="DELIVERY_REFRESH_CONFIRMATION_MISMATCH");
});

test("confirmed delivery refresh atomically queues only the bounded presentation stage",()=>{
  const {repository,commands,jobs}=fixture();
  const plan=planDeliveryRefresh(repository,{scope:"presentation",draft_ids:["draft-1"]});
  const result=applyDeliveryRefresh(repository,{scope:"presentation",draft_ids:["draft-1"],confirmation:plan.confirmation},"release-operator");
  assert.deepEqual(commands,["BEGIN IMMEDIATE","COMMIT"]);
  assert.equal(result.queued.length,1);
  assert.equal(jobs[0].stage,"compose_frontend_page");
  assert.equal(jobs[0].options.workloadClass,"historical_recovery");
  assert.equal(jobs[0].options.productionOwnerOpportunityId,"opp-1");
});
