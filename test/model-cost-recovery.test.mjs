import assert from 'node:assert/strict';
import test from 'node:test';
import {repositoryFixture} from '../test-support/repository-fixture.mjs';
import {normalizeXiaohongshuCapture} from '../src/adapters/xiaohongshu.mjs';
import {Pipeline} from '../src/pipeline.mjs';
import {stageConfiguration} from '../src/pipeline-contract.mjs';
import {createAiClient} from '../src/ai/client.mjs';

test('segment model result survives business commit failure and a fresh Pipeline without repeating the model',async t=>{
 const {repository,db}=repositoryFixture(t);
 const source=repository.saveCapture(normalizeXiaohongshuCapture({url:'https://www.xiaohongshu.com/explore/cost-receipt',text:'Adult tickets cost 60 CNY.'}));
 const [segment]=repository.prepareSourceSegments(source.id);db.prepare('DELETE FROM jobs').run();
 const jobId=repository.enqueue('extract_segment_claims',segment.id);
 let calls=0;
 const extractor={enabled:true,config:{model:'fixture'},extract:async()=>{calls++;return {result:{source:{},claims:[{key:'ticket',subject:'Museum',predicate:'ticket',value:'60 CNY',qualifiers:['adult'],confidence:.9,source_quote:'Adult tickets cost 60 CNY.'}]},model:'fixture',method:'fixture'};}};
 const save=repository.saveSegmentExtraction.bind(repository);let first=true;
 repository.saveSegmentExtraction=(...args)=>{if(first){first=false;throw Object.assign(new Error('Transient commit failure'),{retryable:true});}return save(...args);};
 assert.equal(await new Pipeline(repository,extractor).runOne(),false);
 assert.equal(db.prepare('SELECT count(*) n FROM pipeline_step_receipts').get().n,1);
 db.prepare("UPDATE jobs SET status='queued',available_at='2000-01-01',next_eligible_at='2000-01-01' WHERE id=?").run(jobId);
 assert.equal(await new Pipeline(repository,extractor).runOne(),true);
 assert.equal(calls,1);assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(jobId).status,'succeeded');
});

test('source receipt configuration follows frozen extraction route rather than writing model or current setting',()=>{
 const sourceEngine={configFor:({telemetryContext})=>telemetryContext.modelProfile,artifactContract:()=>({name:'experience_extraction',schema:{type:'object'},prompt:'grounded'})};
 const pipeline={sourceEngine,contentEngine:{config:{model:'writing'}}};
 const options={telemetryContext:{modelProfile:{provider:'deepseek',model:'frozen-a'}}};
 const hash=stageConfiguration(pipeline,'extract_source_experience',options);
 pipeline.contentEngine.config.model='different-writing';assert.equal(stageConfiguration(pipeline,'extract_source_experience',options),hash);
 assert.notEqual(stageConfiguration(pipeline,'extract_source_experience',{telemetryContext:{modelProfile:{provider:'deepseek',model:'frozen-b'}}}),hash);
});

test('experience receipt survives commit failure and enqueues semantic continuation on recovery',async t=>{
 const {repository,db}=repositoryFixture(t);
 const source=repository.saveCapture(normalizeXiaohongshuCapture({url:'https://www.xiaohongshu.com/explore/experience-cost-receipt',text:'A grounded travel source.'}));
 repository.saveExtraction(source.id,{source:{language:'en',summary:'Travel',destination_name:'Changsha',destination_slug:'changsha',traveler_fit:[],practical_tips:[],warnings:[],confidence:.9},claims:[],blueprint:{format:'guide',hook:'Travel',angle:'Travel',sections:[],strengths:[],gaps:[]}},'fixture','offline');
 db.prepare('DELETE FROM jobs').run();db.prepare('DELETE FROM experience_extraction_runs WHERE source_id=?').run(source.id);
 const id=repository.enqueue('extract_source_experience',source.id);let calls=0,first=true;
 const engine={enabled:true,config:{model:'fixture'},analyzeExperience:async()=>{calls++;return {output:{blocks:[]},model:'fixture'};}};
 const save=repository.saveExperienceExtraction.bind(repository);
 repository.saveExperienceExtraction=(...args)=>{if(first){first=false;throw Object.assign(new Error('Transient commit failure'),{retryable:true});}return save(...args);};
 assert.equal(await new Pipeline(repository,{enabled:false,config:{}},{sourceEngine:engine}).runOne(),false);
 db.prepare("UPDATE jobs SET status='queued',available_at='2000-01-01',next_eligible_at='2000-01-01' WHERE id=?").run(id);
 assert.equal(await new Pipeline(repository,{enabled:false,config:{}},{sourceEngine:engine}).runOne(),true);
 assert.equal(calls,1);assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(id).status,'succeeded');
 assert.equal(db.prepare("SELECT count(*) n FROM experience_extraction_runs WHERE source_id=? AND status='succeeded'").get(source.id).n,1);
 assert.ok(db.prepare("SELECT count(*) n FROM jobs WHERE type='resolve_entities' AND entity_id='changsha'").get().n>0);
});

test('DeepSeek bounded schema repair does not restart as another series of paid job retries',async()=>{
 let calls=0;const client=createAiClient({provider:'deepseek',apiKey:'test',baseUrl:'https://example.test',model:'test'},async()=>{
  calls++;return Response.json({choices:[{finish_reason:'stop',message:{content:'{}'}}]});
 });
 await assert.rejects(client.completeJson({name:'source_research_extraction',schema:{type:'object',required:['claims'],properties:{claims:{type:'array'}}},instructions:'JSON',content:'source'}),e=>e.code==='INVALID_MODEL_OUTPUT'&&e.retryable===false);
 assert.equal(calls,2);
});

test('transient rate limiting remains retryable and does not poison successful response reuse',async()=>{
 let calls=0;const client=createAiClient({provider:'deepseek',apiKey:'test',baseUrl:'https://example.test',model:'test'},async()=>{
  if(++calls===1)return Response.json({error:{message:'rate limited'}},{status:429});
  return Response.json({choices:[{finish_reason:'stop',message:{content:'{"claims":[]}'}}]});
 });
 const request={name:'source_research_extraction',schema:{type:'object',required:['claims'],properties:{claims:{type:'array'}}},instructions:'JSON',content:'source'};
 await assert.rejects(client.completeJson(request),e=>e.retryable===true&&e.status===429);
 await client.completeJson(request);await client.completeJson(request);assert.equal(calls,2);
});

test('destination resolution yields at two paid pages and resumes durable receipts without charging again',async t=>{
 const {repository,db}=repositoryFixture(t);
 const source=repository.saveCapture(normalizeXiaohongshuCapture({url:'https://www.xiaohongshu.com/explore/entity-yield',text:'Stable source for entity identity.'}));
 repository.saveExtraction(source.id,{source:{language:'en',summary:'Places',destination_name:'Chongqing',destination_slug:'chongqing',traveler_fit:[],practical_tips:[],warnings:[],confidence:.9},
  claims:Array.from({length:170},(_,i)=>({key:`place.${i}`,subject:`Place ${i}`,predicate:'detail',value:`Value ${i}`,qualifiers:[],confidence:.9,source_quote:`Place ${i}`})),
  blueprint:{format:'guide',hook:'test',angle:'test',sections:[],strengths:[],gaps:[]}},'test','fixture');
 db.prepare('DELETE FROM jobs').run();
 const id=repository.enqueue('resolve_entities','chongqing');let calls=0;
 const sourceEngine={enabled:true,config:{model:'fixture'},resolveEntities:async()=>{calls++;return {output:{entities:[],claim_updates:[],candidates:[]},model:'fixture'};}};
 const make=()=>new Pipeline(repository,{},{sourceEngine,maxConcurrent:1});
 assert.equal(await make().runOne(),false);assert.equal(calls,2);
 const paused=db.prepare('SELECT status,attempts,locked_by FROM jobs WHERE id=?').get(id);
 assert.equal(paused.status,'queued');assert.equal(paused.attempts,0);assert.equal(paused.locked_by,null);
 assert.equal(db.prepare('SELECT count(*) n FROM pipeline_step_receipts').get().n,2);
 const production=repository.enqueue('generate_draft','test-production-brief');
 const next=repository.claimJob();assert.equal(next.id,production);repository.completeJob(next.id,next.locked_by,next.lease_generation);
 // 170 Claims in pages of 40: two paid pages per turn, receipts are never re-bought.
 db.prepare("UPDATE jobs SET available_at='2000-01-01',next_eligible_at='2000-01-01' WHERE id=?").run(id);
 assert.equal(await make().runOne(),false);assert.equal(calls,4);
 db.prepare("UPDATE jobs SET available_at='2000-01-01',next_eligible_at='2000-01-01' WHERE id=?").run(id);
 assert.equal(await make().runOne(),true);assert.equal(calls,5);
 assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(id).status,'succeeded');
 assert.equal(db.prepare("SELECT count(*) n FROM jobs WHERE type='rebuild_knowledge'").get().n,1);
});
