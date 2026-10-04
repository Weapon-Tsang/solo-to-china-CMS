import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {ContentEngine} from '../src/ai/content-engine.mjs';
import {extractExperienceWithRecovery} from '../src/experience-recovery.mjs';
if(process.env.RUN_INTERRUPTION_CANARY!=='1')throw new Error('Explicit canary opt-in required.');
const projectId=process.env.GOOGLE_CLOUD_PROJECT,accessToken=process.env.STC_ARCHITECTURE_VERTEX_TOKEN;
if(!projectId||!accessToken)throw new Error('Short-lived Vertex credentials required.');
const root='output/interruption-recovery-20261004';
const raw=fs.readFileSync(`${root}/packages-before.json`);
const {experiences}=JSON.parse(raw.toString(raw[0]===255?'utf16le':'utf8').replace(/^\uFEFF/,''));
assert.equal(experiences.length,2);
const resume=process.argv.includes('--resume') ? JSON.parse(fs.readFileSync(`${root}/experience-canary.json`)) : null;
if(resume)assert.equal(resume.error?.code,'CANARY_BUDGET');
const report={status:'RUNNING',maximumRequests:resume?8:6,requests:resume?.requests||0,productionWrites:0,wordpressWrites:0,metrics:resume?.metrics||[],sources:[]};
const config={provider:'vertex',projectId,accessToken,model:'gemini-3.8-flash',location:'global',batchEnabled:false,
  structuredSchemaMode:resume?'prompt_only':'openapi',maxCompletionTokens:16000,thinkingLevel:'LOW',
  beforeRequest:({signal})=>{signal?.throwIfAborted();if(report.requests>=report.maximumRequests)throw Object.assign(new Error('Canary call cap reached'),{code:'CANARY_BUDGET'});report.requests++;},
  onModelCall:m=>report.metrics.push({status:m.status,stage:m.stage,errorCode:m.errorCode,inputTokens:m.inputTokens,
    outputTokens:m.outputTokens,thinkingTokens:m.thinkingTokens,latencyMs:m.latencyMs,requestKind:m.requestKind})};
const save=()=>fs.writeFileSync(`${root}/experience-canary.json`,JSON.stringify(report,null,2));
try{
  const engine=new ContentEngine(config);
  for(const input of experiences){
    const result=await extractExperienceWithRecovery(input,{
      runStep:async(key,part,fn)=>{
        const hash=crypto.createHash('sha256').update(JSON.stringify({key,part,version:2})).digest('hex');
        const file=`${root}/experience-step-${hash}.json`;
        if(fs.existsSync(file))return JSON.parse(fs.readFileSync(file));
        const value=await fn(AbortSignal.timeout(180000));fs.writeFileSync(file,JSON.stringify(value));save();return value;
      },analyze:(part,options)=>engine.analyzeExperience(part,options)});
    const claims=new Set(input.claims.map(c=>c.id)),spans=new Set(input.evidence_spans.map(s=>s.id)),segments=new Set(input.segments.map(s=>s.id));
    assert.ok(result.output.blocks.length);
    for(const b of result.output.blocks){
      assert.ok(b.segment_ids.length&&b.segment_ids.every(id=>segments.has(id)));
      assert.ok((b.supporting_claim_ids.length||b.evidence_span_ids.length));
      assert.ok(b.supporting_claim_ids.every(id=>claims.has(id))&&b.evidence_span_ids.every(id=>spans.has(id)));
    }
    fs.writeFileSync(`${root}/${input.source.id}-experience.json`,JSON.stringify(result,null,2));
    report.sources.push({sourceId:input.source.id,claims:input.claims.length,blocks:result.output.blocks.length,
      routeFragments:result.output.route_fragments?.length||0,status:'PASS'});save();
    console.log(JSON.stringify(report.sources.at(-1)));
  }
  report.status='PASS';
}catch(error){report.status='FAIL';report.error={code:error.code,message:error.message};process.exitCode=1;}
finally{save();console.log(JSON.stringify({status:report.status,requests:report.requests,error:report.error}));}
