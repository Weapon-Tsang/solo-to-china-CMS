import test from 'node:test';
import assert from 'node:assert/strict';
import { repositoryFixture } from '../test-support/repository-fixture.mjs';
import { normalizeXiaohongshuCapture } from '../src/adapters/xiaohongshu.mjs';
import { decideRecommendationCommand, decideRecommendationsBulk } from '../src/services/recommendation-bulk.mjs';
import { createApplication } from '../src/server.mjs';
import { loadConfig } from '../src/config.mjs';

function fixture(t, count=2) {
  const {db,repository}=repositoryFixture(t);
  for(let i=0;i<count;i++) {
    const source=repository.saveCapture(normalizeXiaohongshuCapture({url:`https://www.xiaohongshu.com/explore/${(100+i).toString(16).padStart(24,'a')}`,title:`Note ${i}`,text:`Independent captured evidence ${i} for a Chongqing walk.`}));
    repository.saveExtraction(source.id,{source:{language:'en',summary:'Fixture',destination_name:'Chongqing',destination_slug:'chongqing',traveler_fit:[],practical_tips:[],warnings:[],confidence:0.9},claims:[],blueprint:{format:'guide',hook:'Walk',angle:'Local',sections:[],strengths:[],gaps:[]}},'test','fixture');
    repository.saveIntakeAnalysis(source.id,{classification:'ARTICLE_CANDIDATE',production_mode:'TOPIC_FEATURE',primary_topic:`Walk ${i}`,suggested_article_title:`Walk ${i}`,suggested_content_type:'itinerary',confidence:0.9,article_potential:90,information_density:90,topic_completeness:90,reasoning_summary:'Fixture',production_paths:[{mode:'SOURCE_ADAPTATION',title:`Narrow walk ${i}`,content_type:'itinerary',reader_promise:'Follow a short walk',why_it_works:'Bounded',evidence_boundary:'Source only'}]},'fixture');
  }
  const items=repository.listContentRecommendations();
  return {db,repository,items};
}
const input=item=>({recommendationId:item.id,updatedAt:item.updated_at,opportunityId:item.opportunity_id});

test('source analyses and parallel proposals never create jobs before explicit approval',t=>{
  const {db,repository,items}=fixture(t,3);
  assert.equal(items.length,3);
  assert.ok(items.every(item=>item.opportunities.length>=2));
  assert.equal(repository.listContentOpportunities().length,0,'unapproved source proposals are not counted as content opportunities');
  assert.equal(db.prepare("SELECT count(*) n FROM jobs WHERE type IN ('plan_content','draft_article','review_draft','compose_frontend_page')").get().n,0);
});
test('batch approves only selected paths, preserves missing-evidence gate and is idempotent',t=>{
  const {db,repository,items}=fixture(t);
  const payload={decision:'approved_article',items:items.map(input)};
  const result=decideRecommendationsBulk(repository,payload);
  assert.equal(result.processed,2);
  assert.equal(result.queued,0);
  assert.ok(result.results.every(r=>r.outcome==='approved_waiting_for_evidence'));
  assert.equal(repository.listContentOpportunities().length,2,'only the two approved article plans become visible opportunities');
  for(const item of items)assert.ok(db.prepare('SELECT status FROM content_opportunities WHERE recommendation_id=? AND id<>?').all(item.id,item.opportunity_id).every(p=>p.status==='recommended'||p.status==='research_required'));
  assert.equal(decideRecommendationsBulk(repository,payload).skipped,2);
  assert.equal(db.prepare("SELECT count(*) n FROM jobs WHERE type IN ('plan_content','draft_article','review_draft','compose_frontend_page')").get().n,0);
});
test('batch validates stale versions and path ownership independently; repeated entries are skipped',t=>{
  const {repository,items}=fixture(t,3);
  const result=decideRecommendationsBulk(repository,{decision:'approved_article',items:[input(items[0]),{...input(items[1]),updatedAt:'stale'},{...input(items[2]),opportunityId:items[0].opportunity_id},input(items[0])]});
  assert.deepEqual([result.processed,result.failed,result.skipped],[1,2,1]);
  assert.throws(()=>decideRecommendationsBulk(repository,{decision:'invalid',items:items.map(input)}));
  assert.throws(()=>decideRecommendationsBulk(repository,{decision:'ignored',items:Array(101).fill(input(items[0]))}));
});
test('single and batch share approval rules; another parallel path remains explicitly approvable',t=>{
  const {repository,items}=fixture(t,1);
  const item=items[0];
  const first=decideRecommendationCommand(repository,{...input(item),decision:'approved_article'});
  assert.equal(first.needsEvidence,true);
  assert.equal(decideRecommendationCommand(repository,{recommendationId:item.id,decision:'approved_article',opportunityId:item.opportunity_id}).status,'skipped');
  const fresh=repository.listContentRecommendations()[0];
  const second=fresh.opportunities.find(p=>p.id!==item.opportunity_id);
  assert.equal(decideRecommendationCommand(repository,{...input(fresh),decision:'approved_article',opportunityId:second.id}).opportunityId,second.id);
  assert.equal(decideRecommendationCommand(repository,{recommendationId:item.id,decision:'ignored'}).status,'skipped');
});
test('a failed item rolls back its own mutation without rolling back successful decisions',t=>{
  const {db,repository,items}=fixture(t);
  const original=repository.decideRecommendation.bind(repository);
  repository.decideRecommendation=(id,...args)=>{const result=original(id,...args);if(id===items[1].id)throw new Error('Injected storage failure');return result;};
  const result=decideRecommendationsBulk(repository,{decision:'knowledge_only',items:items.map(input)});
  assert.equal(result.processed,1);assert.equal(result.failed,1);
  assert.equal(db.prepare('SELECT decision FROM content_recommendations WHERE id=?').get(items[0].id).decision,'knowledge_only');
  assert.equal(db.prepare('SELECT decision FROM content_recommendations WHERE id=?').get(items[1].id).decision,'pending');
});

test('ready approval creates one planning job and retry cannot create a second job',t=>{
  const {db,repository,items}=fixture(t,1);
  const item=items[0];
  // This test isolates command/queue semantics, not factual readiness quality.
  db.prepare('UPDATE content_opportunities SET readiness_json=? WHERE id=?').run(JSON.stringify({ready:true,score:80,factCount:5,sourceFamilyCount:1}),item.opportunity_id);
  const payload={decision:'approved_article',items:[input(item)]};
  assert.equal(decideRecommendationsBulk(repository,payload).queued,1);
  assert.equal(decideRecommendationsBulk(repository,payload).queued,0);
  assert.equal(db.prepare("SELECT count(*) n FROM jobs WHERE type='plan_content'").get().n,1);
});

test('bulk HTTP entry requires administrator authorization and validates payload',async t=>{
  const config=loadConfig({HOST:'127.0.0.1',PORT:'0',DATABASE_PATH:':memory:',ADMIN_TOKEN:'isolated-test-only',MAINTENANCE_ENABLED:'false',LOG_LEVEL:'error'});
  config.databasePath=':memory:';
  const app=createApplication(config);
  app.pipeline.runOne=async()=>{throw new Error('No production execution expected');};
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(()=>app.stop());
  const endpoint=`http://127.0.0.1:${app.server.address().port}/api/recommendations/bulk-decision`;
  assert.equal((await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
  assert.equal((await fetch(endpoint,{method:'POST',headers:{authorization:'Bearer isolated-test-only','content-type':'application/json'},body:'{}'})).status,400);
});

test('approval freezes scope and a changed proposal fingerprint is rejected even with unchanged recommendation time',t=>{
  const {db,repository,items}=fixture(t,1);
  const item=items[0];const path=item.opportunities.find(p=>p.id===item.opportunity_id);
  db.prepare('UPDATE content_opportunities SET title=? WHERE id=?').run('Different promised scope',path.id);
  assert.throws(()=>decideRecommendationCommand(repository,{...input(item),decision:'approved_article',proposalFingerprint:path.proposalFingerprint}),/范围已变化/);
  const fresh=repository.listContentRecommendations()[0];
  decideRecommendationCommand(repository,{...input(fresh),decision:'approved_article',proposalFingerprint:fresh.opportunities.find(p=>p.id===path.id).proposalFingerprint});
  const before=JSON.parse(db.prepare('SELECT coverage_json FROM content_opportunities WHERE id=?').get(path.id).coverage_json);
  assert.equal(before.approval.proposal.title,'Different promised scope');
  repository.rebuildCoverageMatrices('chongqing');
  const after=JSON.parse(db.prepare('SELECT coverage_json FROM content_opportunities WHERE id=?').get(path.id).coverage_json);
  assert.deepEqual(after.approval,before.approval);
});
