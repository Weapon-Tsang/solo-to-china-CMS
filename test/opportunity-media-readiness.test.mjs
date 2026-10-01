import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {repositoryFixture} from '../test-support/repository-fixture.mjs';
import {seedOpportunityPhoto} from '../test-support/opportunity-media-fixture.mjs';
import {createApplication} from '../src/server.mjs';
import {loadConfig} from '../src/config.mjs';
import {openDatabase} from '../src/db.mjs';

function proposal(f,id='panda') {
  f.db.prepare(`INSERT INTO content_opportunities(id,destination_slug,topic_key,strategy_version,title,content_type,
    readiness_score,readiness_json,coverage_json,status,lifecycle_state,created_at,updated_at)
    VALUES (?,'chongqing',?,?,'Chongqing Zoo: Panda Activity','attraction_guide',100,'{"ready":true,"score":100}',
    '{"publicationMode":"topic_feature"}','recommended','recommended','now','now')`).run(id,id,f.repository.strategyVersion);
  return f.db.prepare('SELECT * FROM content_opportunities WHERE id=?').get(id);
}
async function photoFor(f,row,subject='Chongqing Zoo panda') {
  const photo=await seedOpportunityPhoto(f.repository,f.directory,{subject});
  f.db.prepare('UPDATE content_opportunities SET source_ids_json=? WHERE id=?').run(JSON.stringify([photo.sourceId]),row.id);
  return photo;
}

test('100% fact coverage cannot enter the approvable inbox or create a job without usable media',t=>{
  const f=repositoryFixture(t),row=proposal(f);
  assert.deepEqual(f.repository.listRecommendationInbox(),[]);
  assert.equal(f.repository.reconcileRecommendationInbox().mediaGap,1);
  assert.equal(f.db.prepare('SELECT readiness_score FROM content_opportunities').get().readiness_score,100);
  assert.throws(()=>f.repository.decideOpportunity(row.id,'approve'),/必备配图/);
  assert.equal(f.db.prepare('SELECT approved_at FROM content_opportunities').get().approved_at,null);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM jobs WHERE type='plan_content'").get().n,0);
});

test('related retained photo admits the proposal; removing bytes before approval blocks stale UI and batch decisions',async t=>{
  const f=repositoryFixture(t),row=proposal(f),photo=await photoFor(f,row);
  const items=f.repository.listRecommendationInbox();assert.equal(items.length,1);
  assert.equal(items[0].processingDetail.media.ready,true);
  fs.unlinkSync(photo.filename);
  assert.throws(()=>f.repository.decideOpportunity(row.id,'approve'),/必备配图/);
  assert.equal(f.repository.listRecommendationInbox().length,0);
  assert.equal(f.db.prepare('SELECT approved_at FROM content_opportunities').get().approved_at,null);
});

test('matching facts cannot substitute for pixels, acceptable quality or current capture',async t=>{
  const f=repositoryFixture(t),row=proposal(f),photo=await photoFor(f,row);
  f.db.prepare("UPDATE source_assets SET local_photo_audit_json=json_set(local_photo_audit_json,'$.status','needs_review') WHERE id=?").run(photo.id);
  assert.equal(f.repository.opportunityMediaReadiness(f.db.prepare('SELECT * FROM content_opportunities').get()).ready,false);
  f.db.prepare("UPDATE source_assets SET local_photo_audit_json=json_set(local_photo_audit_json,'$.status','eligible') WHERE id=?").run(photo.id);
  f.db.prepare("UPDATE source_asset_analyses SET primary_subjects_json='[\"Shanghai airport terminal\"]' WHERE asset_id=?").run(photo.id);
  assert.equal(f.repository.opportunityMediaReadiness(f.db.prepare('SELECT * FROM content_opportunities').get()).ready,false);
  f.db.prepare("UPDATE source_asset_analyses SET primary_subjects_json='[\"Chongqing Zoo panda\"]' WHERE asset_id=?").run(photo.id);
  f.db.prepare('UPDATE sources SET capture_version=2 WHERE id=?').run(photo.sourceId);
  assert.equal(f.repository.opportunityMediaReadiness(f.db.prepare('SELECT * FROM content_opportunities').get()).ready,false);
});

test('a broad guide uses only its selected fact subjects, while a focused attraction cannot borrow them',async t=>{
  const f=repositoryFixture(t),row=proposal(f);
  await photoFor(f,row,'Chongqing metro entrance');
  f.db.prepare("INSERT OR IGNORE INTO destinations(id,slug,name,created_at,updated_at) VALUES ('media-scope-destination','chongqing','Chongqing','now','now')").run();
  const destination=f.db.prepare("SELECT id FROM destinations WHERE slug='chongqing'").get().id;
  f.db.prepare(`INSERT INTO knowledge_facts(id,destination_id,normalized_key,subject,predicate,consensus_status,
    preferred_value,support_count,contradiction_count,evidence_json,updated_at)
    VALUES ('media-scope-fact',?,'chongqing.metro.transport','Chongqing Metro','transport','single_source',
    'Use the metro entrance',1,0,'[]','now')`).run(destination);
  f.db.prepare("UPDATE content_opportunities SET title='Chongqing Arrival Preparation',content_type='first_time_guide',coverage_json=? WHERE id=?")
    .run(JSON.stringify({selectedFactKeys:['chongqing.metro.transport']}),row.id);
  const current=()=>f.db.prepare('SELECT * FROM content_opportunities WHERE id=?').get(row.id);
  assert.equal(f.repository.opportunityMediaReadiness(current()).ready,true);
  f.db.prepare("UPDATE content_opportunities SET coverage_json='{}' WHERE id=?").run(row.id);
  assert.equal(f.repository.opportunityMediaReadiness(current()).ready,false,'unselected destination facts cannot authorize the candidate');
  f.db.prepare("UPDATE content_opportunities SET title='Chongqing Zoo: Panda Activity',content_type='attraction_guide',coverage_json=? WHERE id=?")
    .run(JSON.stringify({selectedFactKeys:['chongqing.metro.transport']}),row.id);
  assert.equal(f.repository.opportunityMediaReadiness(current()).ready,false,'a metro image cannot fulfill the zoo subject');
});

test('unstarted historical approval cannot bypass the gate; existing content owner is preserved',t=>{
  const f=repositoryFixture(t),row=proposal(f);
  f.db.prepare("UPDATE content_opportunities SET status='approved_ready',lifecycle_state='approved',approved_at='now' WHERE id=?").run(row.id);
  assert.equal(f.repository.reconcileApprovedOpportunity(row.id).queued,false);
  assert.equal(f.db.prepare('SELECT status FROM content_opportunities').get().status,'approved_waiting_for_evidence');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM topic_candidates').get().n,0);
});

test('recommendations HTTP read removes old fact-only ready projections and reports the material gap',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cms-media-gate-http-'));
  const config=loadConfig({HOST:'127.0.0.1',PORT:'0',DATABASE_PATH:path.join(directory,'test.sqlite'),CMS_DATA_ROOT:directory,CMS_PROCESS_ROLE:'api',ADMIN_TOKEN:'media-gate-test',ADMIN_PASSWORD:'local-test-password',SESSION_SECRET:'media-gate-isolated-test-secret',MAINTENANCE_ENABLED:'false',LOG_LEVEL:'error'});
  openDatabase(config.databasePath).close();
  const app=createApplication(config);
  t.after(async()=>{await app.stop();fs.rmSync(directory,{recursive:true,force:true});});
  proposal({db:app.repository.db,repository:app.repository});
  app.repository.db.prepare("UPDATE content_opportunities SET inbox_state='ACTIONABLE',processing_state='CURRENT'").run();
  await app.start();
  const endpoint=`http://127.0.0.1:${app.server.address().port}/api/recommendations`;
  const response=await fetch(endpoint,{headers:{authorization:'Bearer media-gate-test'}});assert.equal(response.status,200);
  const result=await response.json();assert.deepEqual(result.items,[]);assert.equal(result.summary.mediaGap,1);
  const after=await fetch(endpoint,{headers:{authorization:'Bearer media-gate-test'}});
  assert.equal((await after.json()).summary.mediaGap,1);
  assert.equal(app.repository.db.prepare('SELECT approved_at FROM content_opportunities').get().approved_at,null);
});
