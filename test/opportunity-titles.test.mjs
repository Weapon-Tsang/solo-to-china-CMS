import test from 'node:test';
import assert from 'node:assert/strict';
import { repositoryFixture } from '../test-support/repository-fixture.mjs';
import { normalizeXiaohongshuCapture } from '../src/adapters/xiaohongshu.mjs';
import { opportunityTitlePackage,queueOpportunityTitles,saveOpportunityTitles } from '../src/services/opportunity-titles.mjs';
import { Pipeline } from '../src/pipeline.mjs';
import { ContentEngine } from '../src/ai/content-engine.mjs';

function fixture(t) {
  const result=repositoryFixture(t),{repository,db}=result;
  for (const [n,predicate,value] of [[1,'route','Line 18 connects the airport'],[2,'payment','Use a mobile payment app']]) {
    const saved=repository.saveCapture(normalizeXiaohongshuCapture({url:`https://www.xiaohongshu.com/explore/68abcdef00000000000000e${n}`,
      title:'Airport transit',text:value,images:[]}));
    repository.saveExtraction(saved.id,{source:{language:'en',summary:value,destination_name:'Chengdu',destination_slug:'chengdu',
      traveler_fit:['solo'],practical_tips:[],warnings:[],confidence:.9},
      claims:[{key:`metro.${predicate}`,subject:'Chengdu Metro',predicate,value,qualifiers:[],source_quote:value,confidence:.9}],
      blueprint:{format:'guide',hook:'transit',angle:'airport',sections:[],strengths:[],gaps:[]}},'test','test');
    repository.saveExperienceExtraction(saved.id,{blocks:[]},'test');
  }
  repository.rebuildKnowledge('chengdu');repository.rebuildTopicClusters('chengdu');repository.rebuildKnowledgeOpportunities('chengdu');
  repository.reconcileRecommendationInbox();
  db.prepare('DELETE FROM jobs').run();
  const pack=opportunityTitlePackage(repository,'chengdu');assert.equal(pack.opportunities.length,1);
  const output={proposals:[{id:pack.opportunities[0].id,title:'Chengdu Airport by Metro: Choosing Your Line and Paying for the Ride',
    angle:'Airport metro decision',reader_promise:'Choose the airport metro line and understand mobile payment.',
    evidence_keys:pack.opportunities[0].facts.map(fact=>fact.key)}]};
  return {...result,pack,output};
}

test('opportunity title has real values, rejects old template and preserves identity on rebuild',t=>{
  const {repository,db,pack,output}=fixture(t),id=pack.opportunities[0].id;
  const before=db.prepare('SELECT * FROM content_opportunities WHERE id=?').get(id);
  assert.equal(before.title,'Chengdu Metro');
  assert.ok(pack.opportunities[0].facts.some(f=>f.value.includes('Line 18')));
  for (const title of ['Chengdu Metro: Booking, Costs, Opening Hours','Visiting Luo Zhongli Art Museum: Hours, Booking, and Metro Access','Chengdu Metro','成都地铁：机场交通'])
    assert.throws(()=>saveOpportunityTitles(repository,pack,{proposals:[{...output.proposals[0],title}]},'mock'),/specific English/);
  assert.equal(db.prepare('SELECT title FROM content_opportunities WHERE id=?').get(id).title,before.title);
  assert.throws(()=>repository.decideOpportunity(id,'approve'),/Editorial title/);
  saveOpportunityTitles(repository,pack,output,'mock');
  assert.equal(opportunityTitlePackage(repository,'chengdu').opportunities.length,0);
  repository.rebuildKnowledgeOpportunities('chengdu');
  const after=db.prepare('SELECT * FROM content_opportunities WHERE id=?').get(id);
  assert.equal(after.title,output.proposals[0].title);
  for (const key of ['id','topic_key','readiness_json','approved_at','candidate_id']) assert.equal(after[key],before[key],key);
  assert.equal(JSON.parse(after.coverage_json).proposal.readerPromise,output.proposals[0].reader_promise);
  assert.equal(queueOpportunityTitles(repository,'chengdu'),null);
});

test('changed evidence and approval races discard stale title output',t=>{
  const {repository,db,pack,output}=fixture(t),id=pack.opportunities[0].id;
  db.prepare("UPDATE knowledge_facts SET preferred_value='Line 19 connects the airport' WHERE predicate='route'").run();
  assert.deepEqual(saveOpportunityTitles(repository,pack,output,'mock').changed,[]);
  const current=opportunityTitlePackage(repository,'chengdu');
  assert.notEqual(current.opportunities[0].input_hash,pack.opportunities[0].input_hash);
  db.prepare("UPDATE content_opportunities SET approved_at='2026-09-30',lifecycle_state='approved' WHERE id=?").run(id);
  assert.deepEqual(saveOpportunityTitles(repository,current,output,'mock').changed,[]);
  assert.equal(db.prepare('SELECT title FROM content_opportunities WHERE id=?').get(id).title,'Chengdu Metro');
});

test('unknown IDs, duplicate proposals and fabricated evidence cannot write titles',t=>{
  const {repository,pack,output}=fixture(t);
  for (const proposals of [[{...output.proposals[0],id:'other'}],output.proposals.concat(output.proposals),
    [{...output.proposals[0],evidence_keys:['fabricated']}],[]])
    assert.throws(()=>saveOpportunityTitles(repository,pack,{proposals},'mock'),error=>error.code==='INVALID_OPPORTUNITY_TITLE');
});

test('current grounded experiences retain their supporting fact keys in title input',t=>{
  const {repository,db}=fixture(t);
  const claim=db.prepare("SELECT * FROM claims WHERE predicate='route' LIMIT 1").get();
  const run=db.prepare('SELECT id FROM experience_extraction_runs WHERE source_id=?').get(claim.source_id);
  db.prepare(`INSERT INTO experience_blocks(id,source_id,extraction_run_id,type,title,traveler_goal,
    supporting_claim_ids_json,created_at,updated_at) VALUES ('title-experience',?,?,'decision','Airport metro decision','Choose a metro line',?,'2026-09-30','2026-09-30')`)
    .run(claim.source_id,run.id,JSON.stringify([claim.id]));
  const [input]=opportunityTitlePackage(repository,'chengdu').opportunities;
  assert.equal(input.experiences.length,1);
  assert.ok(input.experiences[0].evidence_keys.every(key=>input.facts.some(f=>f.key===key)));
  assert.ok(input.facts.every(f=>Array.isArray(f.evidence_bounds)));
});

test('title jobs drain actionable opportunities in batches of six and skip protected owners',async t=>{
  const {repository,db}=fixture(t);
  const row=db.prepare('SELECT * FROM content_opportunities LIMIT 1').get();
  const columns=Object.keys(row),insert=db.prepare(`INSERT INTO content_opportunities(${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);
  for(let i=1;i<8;i++)insert.run(...columns.map(key=>key==='id'?`batch-${i}`:key==='topic_key'?`${row.topic_key}-${i}`:row[key]));
  db.prepare("UPDATE content_opportunities SET approved_at='2026-09-30',lifecycle_state='approved' WHERE id='batch-7'").run();
  const batches=[];
  const pipeline=new Pipeline(repository,{enabled:true,config:{}},{contentEngine:{enabled:true,
    composeOpportunityTitles:async pack=>{batches.push(pack.opportunities.length);return {model:'mock',output:{proposals:pack.opportunities.map(input=>({
      id:input.id,title:`Planning a Chengdu Airport Metro Journey (${input.id})`,angle:'Airport transport',
      reader_promise:'Understand the supplied airport route and payment options.',evidence_keys:input.facts.map(f=>f.key)}))}};}},
    logger:{info(){},warn(){},error(){}}});
  queueOpportunityTitles(repository,'chengdu');await pipeline.runOne();await pipeline.runOne();
  assert.deepEqual(batches,[6,1]);assert.equal(queueOpportunityTitles(repository,'chengdu'),null);
  assert.equal(db.prepare("SELECT title FROM content_opportunities WHERE id='batch-7'").get().title,row.title);
});

test('queued title job uses writing runtime, deduplicates and completes without production or publication',async t=>{
  const {repository,db,output}=fixture(t);
  const jobId=queueOpportunityTitles(repository,'chengdu');
  assert.equal(queueOpportunityTitles(repository,'chengdu'),jobId);
  assert.equal(db.prepare('SELECT model_role FROM jobs WHERE id=?').get(jobId).model_role,'writing');
  let calls=0;
  const pipeline=new Pipeline(repository,{enabled:true,config:{}},{contentEngine:{enabled:true,
    composeOpportunityTitles:async pack=>{calls++;assert.ok(pack.opportunities.length<=6);return {output,model:'mock'};}},
    logger:{info(){},warn(){},error(){}}});
  await pipeline.runOne();
  assert.equal(calls,1);
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(jobId).status,'succeeded');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM topic_candidates').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM wordpress_publications').get().n,0);
  assert.equal(queueOpportunityTitles(repository,'chengdu'),null);
});

test('title model contract requires English angles, evidence and bounded reader promises',async()=>{
  const engine=new ContentEngine({provider:'vertex',model:'mock',projectId:'mock'});
  engine.respond=async request=>request;
  const result=await engine.composeOpportunityTitles({opportunities:[]});
  assert.equal(result.name,'opportunity_editorial_titles');
  assert.match(result.instructions,/Never invent/);
  assert.ok(result.schema.properties.proposals.items.required.includes('evidence_keys'));
});

test('rejected template output is never reused and an explicit retry can generate a valid title',async t=>{
  const {repository,db,output}=fixture(t);let calls=0;
  const pipeline=new Pipeline(repository,{enabled:true,config:{}},{contentEngine:{enabled:true,
    composeOpportunityTitles:async()=>({model:'mock',output:{proposals:[{...output.proposals[0],
      title:++calls===1?'Chengdu Metro: Booking, Costs, Opening Hours':output.proposals[0].title}]}})},
    logger:{info(){},warn(){},error(){}}});
  const first=queueOpportunityTitles(repository,'chengdu');await pipeline.runOne();
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(first).status,'failed');
  assert.equal(db.prepare('SELECT count(*) n FROM pipeline_step_receipts WHERE stage=?').get('compose_opportunity_titles').n,0);
  const second=queueOpportunityTitles(repository,'chengdu');assert.notEqual(first,second);
  await pipeline.runOne();assert.equal(calls,2);
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(second).status,'succeeded');
});
