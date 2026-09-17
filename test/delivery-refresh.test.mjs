import assert from "node:assert/strict";
import test from "node:test";
import { applyDeliveryRefresh, deliveryRefreshContinuation, deliveryRefreshScopeForJob, planDeliveryRefresh } from "../src/services/delivery-refresh.mjs";

function fixture({ modifiedAt="2026-09-15T06:36:52Z", status="draft" } = {}) {
  const commands=[];
  const jobs=[];
  const syncedAt=new Date().toISOString();
  const repository={
    listWordPressInventory:()=>[{site_url:"https://site.test",post_id:96,status,modified_at:modifiedAt,title:"Guide"}],
    getWordPressSyncState:()=>({last_succeeded_at:syncedAt}),
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

test("media refresh is a first-class bounded scope and reports per-slot repair work",()=>{
  const {repository}=fixture({modifiedAt:"2026-09-15T06:00:00Z"});
  repository.mediaRepairPlan=()=>({ plan_hash:"media-plan-1", slots:[
    { visual_id:"visual-bad",slot:2,disposition:"repair",reason:"quality_qa_failed",requires_model:true,max_model_calls:2 },
    { visual_id:"visual-good",slot:1,disposition:"retain",reason:"quality_qa_passed",requires_model:false,max_model_calls:0 },
  ]});
  const plan=planDeliveryRefresh(repository,{scope:"media",draft_ids:["draft-1"]});
  assert.equal(plan.items[0].planned_stage,"generate_visuals");
  assert.equal(plan.items[0].media.slots.filter((slot)=>slot.disposition==="repair").length,1);
  assert.equal(plan.items[0].preserve.body_sha256.length,64);
});

test("media and presentation refresh descendants bypass text QA and preserve the frozen body",()=>{
  const rows=new Map([
    ["root-media",{id:"root-media",dedupe_key:"delivery-refresh:media:draft-1:r4:abc",parent_job_id:null}],
    ["page-media",{id:"page-media",dedupe_key:"child:compose_frontend_page",parent_job_id:"root-media"}],
    ["root-presentation",{id:"root-presentation",dedupe_key:"delivery-refresh:presentation:draft-1:r4:def",parent_job_id:null}],
  ]);
  const repository={db:{prepare:()=>({get:(id)=>rows.get(id)})}};
  const mediaPage=rows.get("page-media");
  assert.equal(deliveryRefreshScopeForJob(repository,mediaPage),"media");
  assert.equal(deliveryRefreshContinuation(repository,mediaPage,"compose_frontend_page"),"compose_commercial");
  assert.equal(deliveryRefreshContinuation(repository,rows.get("root-presentation"),"compose_frontend_page"),"compose_commercial");
  assert.equal(deliveryRefreshContinuation(repository,{dedupe_key:"ordinary-production"},"compose_frontend_page"),null);
});
