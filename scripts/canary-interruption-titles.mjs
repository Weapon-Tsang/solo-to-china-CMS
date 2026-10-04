import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {ContentEngine} from '../src/ai/content-engine.mjs';
import {validateOpportunityTitles} from '../src/services/opportunity-titles.mjs';

if(process.env.RUN_INTERRUPTION_CANARY!=='1')throw new Error('Paid canary is disabled. Set RUN_INTERRUPTION_CANARY=1 explicitly.');
const projectId=process.env.GOOGLE_CLOUD_PROJECT,accessToken=process.env.STC_ARCHITECTURE_VERTEX_TOKEN;
if(!projectId||!accessToken)throw new Error('Short-lived Vertex credentials required.');
const root='output/interruption-history-20261004';
const input=fs.readFileSync(`${root}/live-title-package.json`);
const pack=JSON.parse(input);assert.equal(pack.opportunities.length,6);
const report={status:'RUNNING',inputHash:crypto.createHash('sha256').update(input).digest('hex'),
  goldenOpportunityIds:pack.opportunities.map(x=>x.id),maximumRequests:2,requests:0,metrics:[],productionWrites:0,wordpressWrites:0};
const config={provider:'vertex',projectId,accessToken,model:'gemini-3.8-flash',location:'global',batchEnabled:false,
  structuredSchemaMode:'openapi',maxCompletionTokens:4096,thinkingLevel:'LOW',
  beforeRequest:({signal})=>{signal?.throwIfAborted();if(report.requests>=report.maximumRequests)
    throw Object.assign(new Error('Canary request cap reached'),{code:'CANARY_BUDGET'});report.requests++;},
  onModelCall:m=>report.metrics.push({status:m.status,stage:m.stage,errorCode:m.errorCode,inputTokens:m.inputTokens,
    outputTokens:m.outputTokens,thinkingTokens:m.thinkingTokens,latencyMs:m.latencyMs,requestKind:m.requestKind})};
try {
  const engine=new ContentEngine(config);
  const result=await engine.composeOpportunityTitles(pack);
  validateOpportunityTitles(pack,result.output);
  fs.writeFileSync(`${root}/title-canary-output.json`,JSON.stringify(result,null,2));
  const count=report.requests;
  const cached=await engine.composeOpportunityTitles(pack);
  assert.deepEqual(cached,result);assert.equal(report.requests,count);
  report.cacheWithoutNewRequest=true;report.status='PASS';
} catch(error){report.status='FAIL';report.error={code:error.code,message:error.message};process.exitCode=1;}
finally {fs.writeFileSync(`${root}/title-canary.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
