import assert from "node:assert/strict";
import test from "node:test";
import { applyDeliveryRefresh, assertWordPressDeliveryScope, deliveryRefreshContinuation, deliveryRefreshScopeForJob, editorialRefreshBaselineForJob, planDeliveryRefresh, wordpressReceiptFingerprint } from "../src/services/delivery-refresh.mjs";

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

test("a published editorial refresh carries the immutable WordPress baseline through child jobs",()=>{
  const receipt={modified_gmt:"2026-09-22 14:01:00",page_payload_hash:"f".repeat(64)};
  const baseline=wordpressReceiptFingerprint(receipt);
  const rows=new Map([
    ["root",{id:"root",dedupe_key:`delivery-refresh:editorial:draft-1:r5:${baseline}`,parent_job_id:null}],
    ["page",{id:"page",dedupe_key:"compose_frontend_page:draft-1",parent_job_id:"root"}],
    ["review",{id:"review",dedupe_key:"review_draft:draft-1",parent_job_id:"page"}],
  ]);
  const repository={db:{prepare:()=>({get:(id)=>rows.get(id)})}};
  assert.equal(deliveryRefreshScopeForJob(repository,rows.get("review")),"editorial");
  assert.equal(editorialRefreshBaselineForJob(repository,rows.get("review")),baseline);
  assert.equal(deliveryRefreshContinuation(repository,rows.get("page"),"compose_frontend_page"),null);
  assert.notEqual(wordpressReceiptFingerprint({...receipt,modified_gmt:"2026-09-22 14:02:00"}),baseline);
  assert.equal(editorialRefreshBaselineForJob(repository,{dedupe_key:"ordinary-production"}),null);
});

test("published WordPress posts reject ordinary retries and require a matching guarded scope",()=>{
  const published={status:'publish',cms_draft_id:'draft-1'};
  assert.throws(()=>assertWordPressDeliveryScope(published,'draft-1',null),
    (error)=>error.code==='WORDPRESS_PUBLISHED_REFRESH_SCOPE_REQUIRED');
  assert.throws(()=>assertWordPressDeliveryScope(published,'draft-2','editorial'),
    (error)=>error.code==='WORDPRESS_REFRESH_IDENTITY_MISMATCH');
  assert.throws(()=>assertWordPressDeliveryScope(null,'draft-1','editorial'),
    (error)=>error.code==='WORDPRESS_EDITORIAL_REFRESH_TARGET_CHANGED');
  assert.throws(()=>assertWordPressDeliveryScope({status:'draft',cms_draft_id:'draft-1'},'draft-1','editorial'),
    (error)=>error.code==='WORDPRESS_EDITORIAL_REFRESH_TARGET_CHANGED');
  assert.doesNotThrow(()=>assertWordPressDeliveryScope(published,'draft-1','editorial'));
  assert.doesNotThrow(()=>assertWordPressDeliveryScope(published,'draft-1','media'));
});
