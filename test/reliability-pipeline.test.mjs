import assert from 'node:assert/strict';
import test from 'node:test';
import { repositoryFixture } from '../test-support/repository-fixture.mjs';
import { dependencyHash, stageConfiguration } from '../src/pipeline-contract.mjs';
import { sourceProcessingProfile } from '../src/source-processing-profile.mjs';
import { Pipeline } from '../src/pipeline.mjs';
import { assessEntityIdentity } from '../src/entity-resolution.mjs';
import { normalizeXiaohongshuCapture } from '../src/adapters/xiaohongshu.mjs';

test('paged entity resolution keeps one input revision and commits all pages with the downstream task', async t => {
  const {repository,db}=repositoryFixture(t);
  const source=repository.saveCapture(normalizeXiaohongshuCapture({url:'https://www.xiaohongshu.com/explore/pagedentities',text:'A selected source with multiple named places and traceable practical observations.'}));
  repository.saveExtraction(source.id,{
    source:{language:'en',summary:'Many places',destination_name:'Chongqing',destination_slug:'chongqing',traveler_fit:[],practical_tips:[],warnings:[],confidence:.9},
    claims:Array.from({length:305},(_,index)=>({key:`place.${index}.access`,subject:`Place ${index}`,predicate:'access',value:'open',qualifiers:[],confidence:.9,source_quote:`Place ${index} is open.`})),
    blueprint:{format:'guide',hook:'Places',angle:'Access',sections:[],strengths:[],gaps:[]},
  },'fixture','offline');
  db.prepare('DELETE FROM jobs').run();db.prepare('DELETE FROM entity_aliases').run();
  let calls=0;
  const engine={enabled:true,config:{model:'fixture'},resolveEntities:async pack=>{
    calls++;assert.equal(db.prepare('SELECT COUNT(*) n FROM entity_aliases').get().n,0,'no earlier page is applied during the next model call');
    assert.equal(pack.claims.length,calls===1?300:5);
    return {output:{entities:[],claim_updates:[],candidates:[]},model:'fixture'};
  }};
  const pipeline=new Pipeline(repository,{enabled:false,config:{}},{contentEngine:engine});
  const jobId=repository.enqueue('resolve_entities','chongqing');
  assert.equal(await pipeline.runOne(),true);assert.equal(calls,2);
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(jobId).status,'succeeded');
  assert.ok(db.prepare('SELECT COUNT(*) n FROM entity_aliases').get().n>0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs WHERE type='rebuild_knowledge' AND status='queued'").get().n,1);
  db.prepare('DELETE FROM jobs').run();db.prepare('DELETE FROM entity_aliases').run();
  calls=0;engine.config.model='fixture-with-concurrent-update';
  engine.resolveEntities=async()=>{
    if(++calls===2)db.prepare('UPDATE claims SET value_text=? WHERE id=(SELECT id FROM claims ORDER BY id LIMIT 1)').run('changed while model was running');
    return {output:{entities:[],claim_updates:[],candidates:[]},model:'fixture'};
  };
  const staleJob=repository.enqueue('resolve_entities','chongqing');
  await pipeline.runOne();assert.equal(calls,2);
  assert.notEqual(db.prepare('SELECT status FROM jobs WHERE id=?').get(staleJob).status,'succeeded');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entity_aliases').get().n,0,'stale second page cannot commit first-page changes');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs WHERE type='rebuild_knowledge'").get().n,0);
});

test('semantic keys ignore object order/timestamps and stage configuration uses the effective adapter', () => {
  assert.equal(dependencyHash({b:2,a:1,updated_at:'old'}),dependencyHash({a:1,b:2,updated_at:'new'}));
  const pipeline = {extractor:{config:{provider:'extractor',model:'one'}},contentEngine:{config:{provider:'writer',model:'two'}}};
  const original = stageConfiguration(pipeline,'extract_segment_claims');
  pipeline.contentEngine.config.model = 'three';
  assert.equal(stageConfiguration(pipeline,'extract_segment_claims'),original);
  pipeline.extractor.config.model = 'four';
  assert.notEqual(stageConfiguration(pipeline,'extract_segment_claims'),original);
  let coveragePrompt='one';
  pipeline.extractor.artifactContract=stage=>({prompt:stage==='audit_segment_coverage'?coveragePrompt:'extraction'});
  const retryConfig=stageConfiguration(pipeline,'retry_segment_extraction');
  coveragePrompt='two';
  assert.notEqual(stageConfiguration(pipeline,'retry_segment_extraction'),retryConfig,'combined retry includes the coverage prompt dependency');
});

test('running rebuild coalesces updates into one durable rerun and does not lose the dirty revision', t => {
  const {repository,db} = repositoryFixture(t);
  const id = repository.enqueue('rebuild_knowledge','test');
  const job = repository.claimJob();
  for (let i=0;i<10;i++) assert.equal(repository.enqueue('rebuild_knowledge','test'),id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM jobs').get().n,1);
  assert.equal(repository.completeJob(job.id,job.locked_by,job.lease_generation),true);
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(id).status,'queued');
  const rerun = repository.claimJob();
  repository.completeJob(rerun.id,rerun.locked_by,rerun.lease_generation);
  assert.equal(repository.claimJob(),null);
});

test('a stage commit rolls output and downstream jobs back together when a save fails',t=>{
  const {repository,db}=repositoryFixture(t);
  repository.enqueue('extract_segment_claims','segment');const job=repository.claimJob();
  const artifact=repository.preparePipelineArtifact(job,'one');
  assert.throws(()=>repository.commitPipelineStage(job,artifact,()=>{repository.enqueue('audit_segment_coverage','segment');throw new Error('simulated commit failure');}),/simulated/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs WHERE type='audit_segment_coverage'").get().n,0);
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(job.id).status,'running');
  assert.equal(db.prepare('SELECT status FROM pipeline_artifacts WHERE id=?').get(artifact.id).status,'started');
  repository.commitPipelineStage(job,artifact,()=>repository.enqueue('audit_segment_coverage','segment'));
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(job.id).status,'succeeded');
  assert.equal(db.prepare('SELECT status FROM pipeline_artifacts WHERE id=?').get(artifact.id).status,'succeeded');
});

test('cache reuse reconstructs the next durable task without a model call', t => {
  const {repository} = repositoryFixture(t);
  const pipeline = new Pipeline(repository,{enabled:false},{enabled:false});
  pipeline.ensureReusedDownstream({type:'extract_segment_claims',entity_id:'segment'});
  pipeline.ensureReusedDownstream({type:'extract_segment_claims',entity_id:'segment'});
  assert.equal(repository.db.prepare("SELECT COUNT(*) n FROM jobs WHERE type='audit_segment_coverage'").get().n,1);
});

test('interactive coverage is not deferred by a Batch threshold; visual pressure does not block text', t => {
  const {repository,db} = repositoryFixture(t);
  repository.enqueue('audit_segment_coverage','interactive',{executionRoute:'realtime'});
  const job = repository.claimJob({deferBatchCoverage:true});
  assert.equal(job.entity_id,'interactive');
  repository.completeJob(job.id);
  repository.enqueue('generate_visuals','visual');
  const visual = repository.claimJob();
  repository.failJob(visual,Object.assign(new Error('capacity'),{status:429,retryable:true}));
  repository.enqueue('extract_segment_claims','new',{executionRoute:'realtime'});
  assert.equal(repository.claimJob({deferBatchExtraction:true}).entity_id,'new');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs WHERE entity_id='visual'").get().n,1);
});

test('short fragments have an opt-in executable route while full sources keep exhaustive processing', () => {
  assert.equal(sourceProcessingProfile({raw_text:'A short complete travel observation without media.'}).route,'fragment');
  assert.equal(sourceProcessingProfile({raw_text:'Long '.repeat(3000)}).route,'segmented');
  assert.equal(sourceProcessingProfile({raw_text:'A video observation',assets:[{kind:'video'}]}).route,'segmented');
  const enqueued=[];
  const pipeline = Object.create(Pipeline.prototype);
  pipeline.repository={contentConfig:{sourceComplexityRouting:true},getSource:()=>({raw_text:'A short complete travel observation without media.'}),enqueue:(...args)=>enqueued.push(args)};
  pipeline.logger={info(){}};
  pipeline.enqueueSourceSemanticDownstream('fragment');
  assert.deepEqual(enqueued,[['analyze_source_family','fragment']]);
});

test('compatible geography and high model confidence cannot prove an entity identity', () => {
  const base={alias:'East Gate',candidate_entity_key:'place.east_gate',candidate_entity_type:'place',candidate_granularity:'specific_entity',
    proposed_canonical_subject:'West Gate',proposed_entity_key:'place.west_gate',proposed_entity_type:'place',proposed_granularity:'specific_entity',confidence:.99,
    candidateLocation:{latitude:30.00001,longitude:120,country:'中国'},proposedLocation:{latitude:30.00002,longitude:120,country:'China'}};
  assert.equal(assessEntityIdentity(base).decision,'UNCERTAIN');
  assert.equal(assessEntityIdentity({...base,identityEvidence:true}).decision,'MERGE');
  assert.equal(assessEntityIdentity({...base,proposedLocation:{latitude:35,longitude:120}}).decision,'DO_NOT_MERGE');
});
