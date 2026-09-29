import assert from 'node:assert/strict';
import test from 'node:test';
import {createAiClient} from '../src/ai/client.mjs';
import {resolveStagePolicy} from '../src/ai/stage-policy.mjs';
import stagePolicy from '../config/model-stage-policy.json' with {type:'json'};
import {repositoryFixture} from '../test-support/repository-fixture.mjs';
import {compactExperienceReferences} from '../src/ai/experience-references.mjs';
import {validateJsonSchema} from '../src/frontend-contract.mjs';
const schema={type:'object',required:['blocks'],properties:{blocks:{type:'array',items:{type:'object'}}}};
const config={provider:'deepseek',model:'deepseek-flash',apiKey:'test',baseUrl:'https://example.test',stagePolicy};
test('wire references preserve all evidence, nested links, unknown references and alias-like source text',()=>{
 const input={source:{title:'@experience:0'},segments:[{id:'segment-long-id',asset_id:'asset-long-id',text_excerpt:'Original unchanged quote'}],
  claims:[{id:'claim-long-id',evidence_span_ids:['span-long-id'],value:'Keep all conditions'}],evidence_spans:[{id:'span-long-id',segment_id:'segment-long-id',asset_id:'asset-long-id',quote:'Keep all conditions'}],media:[{id:'asset-long-id'}]};
 const before=JSON.stringify(input),wire=compactExperienceReferences(input);
 assert.deepEqual(wire.restore(wire.input),input);assert.equal(JSON.stringify(input),before);
 assert.equal(wire.input.source.title,'@experience:0');
 assert.ok(wire.input.claims[0].id.includes(':claim:'));
 assert.ok(wire.input.evidence_spans[0].id.includes(':span:'));
 assert.equal(wire.input.evidence_spans[0].segment_id,wire.input.segments[0].id);
 assert.deepEqual(wire.restore({refs:[wire.input.claims[0].id,'unknown-id']}),{refs:['claim-long-id','unknown-id']});
});
test('DeepSeek output allowance is provider managed and thinking remains enabled',()=>{
 const policy=resolveStagePolicy('experience_extraction',config);
 assert.equal(policy.thinking,'LOW');assert.equal(policy.maxOutputTokens,null);
 assert.equal(resolveStagePolicy('content_intake_analysis',config).maxOutputTokens,null);
 assert.equal(resolveStagePolicy('experience_extraction',{...config,provider:'vertex'}).thinking,'LOW');
 assert.equal(resolveStagePolicy('content_intake_analysis',config).thinking,'LOW');
 assert.notEqual(policy.configHash,resolveStagePolicy('experience_extraction',{...config,provider:'vertex'}).configHash);
});
test('production reasoning exhaustion regression: request omits max_tokens while retaining thinking',async()=>{
 const metrics=[];
 const client=createAiClient({...config,onModelCall:m=>metrics.push(m)},async(_url,init)=>{
  const body=JSON.parse(init.body);
  assert.deepEqual(body.thinking,{type:'enabled'});assert.equal(body.reasoning_effort,'low');
  assert.equal(Object.hasOwn(body,'max_tokens'),false);
  assert.ok(body.messages[0].content.includes('complete JSON Schema'));
  return Response.json({choices:[{finish_reason:'stop',message:{content:'{"blocks":[]}'}}],usage:{prompt_tokens:52309,completion_tokens:10,completion_tokens_details:{reasoning_tokens:0}}});
 });
 const r=await client.completeJson({name:'experience_extraction',schema,instructions:'Return grounded JSON',content:'claims'});
 assert.deepEqual(r.output,{blocks:[]});assert.equal(metrics[0].thinkingTokens,0);
 assert.equal(metrics[0].configHash,resolveStagePolicy('experience_extraction',config).configHash);
});
test('unknown route region accepts explicit nullable without accepting malformed geometry',()=>{
 const region={type:'object',nullable:true,required:['x'],properties:{x:{type:'number'}}};
 assert.deepEqual(validateJsonSchema(null,region),[]);
 assert.ok(validateJsonSchema({},region).length);
 assert.ok(validateJsonSchema('unknown',region).length);
 assert.ok(validateJsonSchema(null,{...region,nullable:false}).length);
 assert.ok(validateJsonSchema(null,{type:'string',nullable:true,enum:['known']}).length);
});
test('remaining experience output limit is terminal instead of three identical paid retries',async()=>{
 let calls=0;
 const client=createAiClient(config,async()=>{calls++;return Response.json({choices:[{finish_reason:'length',message:{content:'{"blocks":['}}]});});
 await assert.rejects(client.completeJson({name:'experience_extraction',schema,instructions:'JSON',content:'claims'}),e=>e.code==='MODEL_OUTPUT_LIMIT'&&e.retryable===false);
 assert.equal(calls,1);
});
test('queue preserves experience output-limit failure and does not requeue identical input',async(t)=>{
 const {db,repository}=repositoryFixture(t);
 const id=repository.enqueue('extract_source_experience','budget-regression-source');
 const job=repository.claimJob();assert.equal(job.id,id);
 const client=createAiClient(config,async()=>Response.json({choices:[{finish_reason:'length',message:{content:''}}]}));
 let failure;
 try{await client.completeJson({name:'experience_extraction',schema,instructions:'JSON',content:'claims'});}catch(e){failure=e;}
 assert.ok(failure);repository.failJob(job,failure);
 const stored=db.prepare('SELECT status,attempts,last_failure_code,next_eligible_at FROM jobs WHERE id=?').get(id);
 assert.equal(stored.status,'failed');assert.equal(stored.attempts,1);
 assert.equal(stored.last_failure_code,'MODEL_OUTPUT_LIMIT');assert.equal(stored.next_eligible_at,null);
});
