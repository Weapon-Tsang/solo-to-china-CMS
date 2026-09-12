import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { repositoryFixture } from '../test-support/repository-fixture.mjs';
import { normalizeXiaohongshuCapture } from '../src/adapters/xiaohongshu.mjs';
import { Pipeline } from '../src/pipeline.mjs';

const output = {output:{entities:[],claim_updates:[],candidates:[]},model:'fixture'};
function seedDraft(db) {
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at)
    VALUES ('brief','chongqing','Guide','[]','informational','drafted','now','now')`).run();
  db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at)
    VALUES ('draft','brief','Guide','guide','Original prose','{}','qa_failed','now','now')`).run();
}

test('delivery dependencies ignore their own derived OG URL but reject a changed draft before acknowledging an external result',t=>{
  const {repository,db}=repositoryFixture(t);seedDraft(db);
  const job={type:'push_wordpress_draft',entity_id:'draft'};
  const artifact=repository.preparePipelineArtifact(job,'delivery');
  db.prepare('UPDATE article_drafts SET seo_json=? WHERE id=?').run(JSON.stringify({og_image:'https://media.example/uploaded.png'}),'draft');
  assert.doesNotThrow(()=>repository.assertPipelineInput(artifact,job));
  db.prepare("UPDATE article_drafts SET title='Changed while delivering' WHERE id='draft'").run();
  assert.throws(()=>repository.assertPipelineInput(artifact,job),{code:'STALE_PIPELINE_INPUT'});
});

test('real termination between a saved output and enqueue rolls back both and resumes the same job',async t=>{
  const {repository,db,directory}=repositoryFixture(t);seedDraft(db);
  const jobId=repository.enqueue('revise_draft','draft');
  const program=`import fs from 'node:fs';
    import {openDatabase} from ${JSON.stringify(new URL('../src/db.mjs',import.meta.url).href)};
    import {Repository} from ${JSON.stringify(new URL('../src/repository.mjs',import.meta.url).href)};
    const db=openDatabase(${JSON.stringify(path.join(directory,'test.sqlite'))});const repository=new Repository(db);
    const job=repository.claimJob();const artifact=repository.preparePipelineArtifact(job,'fixture');
    repository.commitPipelineStage(job,artifact,()=>{
      db.prepare("UPDATE article_drafts SET body_markdown='New prose' WHERE id='draft'").run();
      fs.writeSync(1,'DURABLE\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
      repository.enqueue('review_draft','draft');
    });`;
  await killAtCheckpoint(t,program);
  assert.equal(db.prepare("SELECT body_markdown FROM article_drafts WHERE id='draft'").get().body_markdown,'Original prose');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs WHERE type='review_draft'").get().n,0);
  assert.equal(db.prepare("SELECT status FROM pipeline_artifacts WHERE stage='revise_draft'").get().status,'started');
  db.prepare("UPDATE jobs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(jobId);repository.recoverExpiredJobs();
  const job=repository.claimJob();assert.equal(job.id,jobId);
  const artifact=repository.preparePipelineArtifact(job,'fixture');
  repository.commitPipelineStage(job,artifact,()=>{
    db.prepare("UPDATE article_drafts SET body_markdown='New prose' WHERE id='draft'").run();repository.enqueue('review_draft','draft');
  });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM article_drafts').get().n,1);
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(jobId).status,'succeeded');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs WHERE type='review_draft'").get().n,1);
});
function seedEntities(repository, db) {
  const source=repository.saveCapture(normalizeXiaohongshuCapture({url:'https://www.xiaohongshu.com/explore/durablepages',text:'Named places with traceable practical observations.'}));
  repository.saveExtraction(source.id,{
    source:{language:'en',summary:'Places',destination_name:'Chongqing',destination_slug:'chongqing',traveler_fit:[],practical_tips:[],warnings:[],confidence:.9},
    claims:Array.from({length:305},(_,i)=>({key:`place.${i}.access`,subject:`Place ${i}`,predicate:'access',value:'open',qualifiers:[],confidence:.9,source_quote:`Place ${i} is open.`})),
    blueprint:{format:'guide',hook:'Places',angle:'Access',sections:[],strengths:[],gaps:[]},
  },'fixture','offline');
  db.prepare('DELETE FROM jobs').run();db.prepare('DELETE FROM entity_aliases').run();
  return repository.enqueue('resolve_entities','chongqing');
}

async function killAtCheckpoint(t, program) {
  const child=spawn(process.execPath,['--input-type=module','-e',program],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  t.after(()=>child.kill());
  const closed=new Promise(resolve=>child.once('close',resolve));
  let stderr='',stdout='';child.stderr.on('data',bytes=>{stderr+=bytes;});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(new Error('No durable checkpoint: '+stderr));},15000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.stdout.on('data',bytes=>{stdout+=bytes;if(stdout.includes('DURABLE')){clearTimeout(timer);resolve();}});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error('Exited before checkpoint: '+stderr));});
  });
  child.kill();await closed;
}

for (const stopAfter of [1,2]) test(`real process termination after entity page ${stopAfter} resumes receipts without repeating returned calls`,async t=>{
  const {repository,db,directory}=repositoryFixture(t);
  const jobId=seedEntities(repository,db),callsFile=path.join(directory,'model-calls.jsonl');
  const program=`import fs from 'node:fs';
    import {openDatabase} from ${JSON.stringify(new URL('../src/db.mjs',import.meta.url).href)};
    import {Repository} from ${JSON.stringify(new URL('../src/repository.mjs',import.meta.url).href)};
    import {Pipeline} from ${JSON.stringify(new URL('../src/pipeline.mjs',import.meta.url).href)};
    const db=openDatabase(${JSON.stringify(path.join(directory,'test.sqlite'))});
    const repository=new Repository(db);let saved=0;
    const original=repository.savePipelineStep.bind(repository);
    repository.savePipelineStep=(...args)=>{const value=original(...args);if(++saved===${stopAfter}){fs.writeSync(1,'DURABLE\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}return value;};
    const engine={enabled:true,config:{model:'fixture'},resolveEntities:async pack=>{fs.appendFileSync(${JSON.stringify(callsFile)},JSON.stringify(pack.claims.length)+'\\n');return ${JSON.stringify(output)};}};
    await new Pipeline(repository,{enabled:false,config:{}},{contentEngine:engine}).runOne();db.close();`;
  await killAtCheckpoint(t,program);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM pipeline_step_receipts').get().n,stopAfter);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entity_aliases').get().n,0);
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(jobId).status,'running');
  db.prepare("UPDATE jobs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(jobId);
  assert.equal(repository.recoverExpiredJobs(),1);
  const engine={enabled:true,config:{model:'fixture'},resolveEntities:async pack=>{
    fs.appendFileSync(callsFile,JSON.stringify(pack.claims.length)+'\n');return output;
  }};
  assert.equal(await new Pipeline(repository,{enabled:false,config:{}},{contentEngine:engine}).runOne(),true);
  assert.deepEqual(fs.readFileSync(callsFile,'utf8').trim().split('\n').map(Number),[300,5]);
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(jobId).status,'succeeded');
  assert.ok(db.prepare('SELECT COUNT(*) n FROM entity_aliases').get().n>0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs WHERE type='rebuild_knowledge'").get().n,1);
});

test('receipt rejects changed input/configuration, corrupted output and revoked job ownership',t=>{
  const {repository,db}=repositoryFixture(t);
  repository.enqueue('resolve_entities','chongqing');const job=repository.claimJob();
  const artifact=repository.preparePipelineArtifact(job,'config');
  const identity=repository.pipelineStepIdentity(job,artifact,'page',{claims:['one']},'config');
  repository.savePipelineStep(job,artifact,identity,output);
  assert.deepEqual(repository.readPipelineStep(identity).value,output);
  assert.equal(repository.readPipelineStep(repository.pipelineStepIdentity(job,artifact,'page',{claims:['two']},'config')),null);
  assert.equal(repository.readPipelineStep(repository.pipelineStepIdentity(job,artifact,'page',{claims:['one']},'new-config')),null);
  db.prepare("UPDATE pipeline_step_receipts SET result_json='{}'").run();assert.equal(repository.readPipelineStep(identity),null);
  db.prepare('UPDATE jobs SET lease_generation=lease_generation+1 WHERE id=?').run(job.id);
  assert.throws(()=>repository.savePipelineStep(job,artifact,identity,output),/JOB_LEASE_LOST/);
});

test('targeted retry retains its prior extraction during audit failure and reuses only the completed model step',async t=>{
  const {repository,db}=repositoryFixture(t);
  const source=repository.saveCapture(normalizeXiaohongshuCapture({url:'https://www.xiaohongshu.com/explore/targetedreceipt',text:'Adult tickets cost 60 CNY. The museum opens at 09:00 daily.'}));
  const [segment]=repository.prepareSourceSegments(source.id);
  const claim={key:'museum.ticket',subject:'Museum',predicate:'ticket',value:'60 CNY',qualifiers:['adult'],confidence:.9,source_quote:'Adult tickets cost 60 CNY.'};
  repository.saveSegmentExtraction(segment.id,{result:{source:{},claims:[claim]},method:'fixture',model:'fixture'});
  repository.auditSegmentCoverage(segment.id,{uncovered_spans:[{quote:'The museum opens at 09:00 daily.',importance:'material',reason:'Opening time missing'}]});
  const before=repository.getSegmentCoveragePackage(segment.id);
  db.prepare('DELETE FROM jobs').run();const jobId=repository.enqueue('retry_segment_extraction',segment.id);
  let extractions=0,audits=0;
  const extractor={config:{model:'fixture'},extract:async()=>{
    extractions++;return {result:{source:{},claims:[{...claim,key:'museum.opens',predicate:'opens',value:'09:00',qualifiers:[],source_quote:'The museum opens at 09:00 daily.'}]},method:'fixture',model:'fixture'};
  },auditCoverage:async pack=>{
    audits++;assert.equal(pack.extraction.claims.length,2);
    assert.equal(repository.getSegmentCoveragePackage(segment.id).extraction.claims.length,1,'merged output is private until coverage completes');
    if(audits===1)throw Object.assign(new Error('Controlled audit transport failure'),{retryable:true});
    return {output:{uncovered_spans:[]},model:'fixture'};
  }};
  const pipeline=new Pipeline(repository,extractor,{});
  assert.equal(await pipeline.runOne(),false);
  assert.deepEqual(repository.getSegmentCoveragePackage(segment.id).extraction,before.extraction);
  db.prepare("UPDATE jobs SET status='queued',available_at='2000-01-01',next_eligible_at='2000-01-01',locked_by=NULL,lease_expires_at=NULL WHERE id=?").run(jobId);
  assert.equal(await pipeline.runOne(),true);
  assert.equal(extractions,1);assert.equal(audits,2);
  const after=repository.getSegmentCoveragePackage(segment.id);
  assert.equal(after.extraction.claims.length,2);assert.equal(after.segment.attempt,2);assert.equal(after.coverage.status,'passed');
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(jobId).status,'succeeded');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs WHERE type='finalize_source_extraction'").get().n,1);
});
