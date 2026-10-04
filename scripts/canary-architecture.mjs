import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createAiClient } from '../src/ai/client.mjs';
import { ContentEngine } from '../src/ai/content-engine.mjs';

if (process.env.RUN_ARCHITECTURE_CANARY !== '1') throw new Error('Explicit RUN_ARCHITECTURE_CANARY=1 required; paid calls are disabled by default.');
const projectId=process.env.GOOGLE_CLOUD_PROJECT,accessToken=process.env.STC_ARCHITECTURE_VERTEX_TOKEN;
if (!projectId || !accessToken) throw new Error('Supply a project and a short-lived Vertex token through the environment.');
const output=path.resolve(process.argv[2] || 'output/architecture-audit-20261004/canary.json');
let admitted=0,dispatched=0;
const maximumRequests=Math.max(1,Math.min(4,Number(process.env.ARCHITECTURE_CANARY_MAX_REQUESTS || 4)));
const attempts=[],results=[];
const config={provider:'vertex',model:'gemini-3.8-flash',projectId,accessToken,location:'global',batchEnabled:false,
  maxCompletionTokens:4096,structuredSchemaMode:'openapi',thinkingLevel:'LOW',
  beforeRequest:({signal})=>{signal?.throwIfAborted();if(++admitted>maximumRequests)throw Object.assign(new Error('Hard canary request budget reached'),{code:'CANARY_BUDGET'});},
  onModelCall:m=>attempts.push({stage:m.stage,status:m.attemptStatus,errorCode:m.errorCode,inputTokens:m.inputTokens,
    outputTokens:m.outputTokens,thinkingTokens:m.thinkingTokens,latencyMs:m.latencyMs,returnedModel:m.returnedModel}),
  stagePolicy:{version:'architecture-canary-1',stages:{
    architecture_canary:{thinking:'LOW',maxOutputTokens:256,timeoutMs:60_000,maxAttempts:1},
    article_draft_v2:{thinking:'LOW',maxOutputTokens:4096,timeoutMs:120_000,maxAttempts:1},
  }}};
const client=createAiClient(config);
const started=Date.now();
try {
  const request={name:'architecture_canary',instructions:'Extract only the supplied facts. Return JSON.',
    content:'Golden source: The information desk is open 24 hours every day. Admission is free (0 CNY).',
    schema:{type:'object',required:['hours','price'],properties:{hours:{type:'integer'},price:{type:'integer'}}},
    onProviderDispatch:()=>{dispatched++;return {finish:receipt=>results.push({kind:'dispatch_receipt',received:receipt.responseReceived,failed:Boolean(receipt.error)})};}};
  const first=await client.completeJson(request);
  assert.deepEqual(first.output,{hours:24,price:0});
  const second=await client.completeJson(request);
  assert.deepEqual(second.output,first.output);assert.equal(dispatched,1);
  results.push({kind:'structured_and_cached',status:'PASS',dispatches:dispatched});
  const fact={normalized_key:'golden.gallery.ticket',subject:'Golden Gallery',predicate:'admission_fee',preferred_value:'CNY 20',
    selection_frozen:true,consensus_status:'single_source',freshness_state:'current',evidence:[
      {claim_id:'weekday',source_id:'golden',value:'CNY 20',quote:'Adult tickets cost CNY 20 on weekdays.',qualifiers:['adults','weekdays'],evidence_role:'current'},
      {claim_id:'weekend',source_id:'golden',value:'CNY 20',quote:'Adult tickets cost CNY 20 on weekends; advance booking is required.',qualifiers:['adults','weekends','advance booking required'],evidence_role:'conditional'}]};
  const pack={brief:{strategy_version:'3.9',plan:{title:'Golden Gallery tickets',reader_promise:'Explain adult admission and the weekend booking condition in 120–200 words.',
    outline:[{section_id:'admission',heading:'Adult admission',purpose:'Explain weekday and weekend conditions.',claim_keys:[fact.normalized_key]}]}},
    writing_packet:{selected_fact_keys:[fact.normalized_key],evidence_ledger:[{fact_snapshot:fact}],context:{version:2,
      content_policy:{faq:{maximum:0},visuals:{maximum:0}},narrative_plan:{},reader_sources:[],authorized_source_assets:[],internal_link_inventory:[]}}};
  const draft=await new ContentEngine(config).draft(pack);
  assert.match(draft.output.body_markdown,/weekend/i);assert.match(draft.output.body_markdown,/book|reserv/i);
  assert.match(draft.output.body_markdown,/20/);
  results.push({kind:'scoped_writing',status:'PASS',conditionsRetained:true,model:draft.model});
  fs.mkdirSync(path.dirname(output),{recursive:true});
  fs.writeFileSync(path.join(path.dirname(output),'canary-draft.json'),JSON.stringify(draft.output,null,2));
} catch(error) {results.push({status:'FAIL',code:error.code || error.name,message:error.message});process.exitCode=1;}
finally {
  fs.mkdirSync(path.dirname(output),{recursive:true});
  const report={results,providerAttempts:attempts.filter(x=>x.latencyMs>0).length,attempts,maximumRequests,
    elapsedMs:Date.now()-started,productionWrites:0,wordpressWrites:0};
  fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}
