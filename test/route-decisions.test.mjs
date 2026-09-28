import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { loadConfig } from '../src/config.mjs';
import { createApplication } from '../src/server.mjs';
import { repositoryFixture } from '../test-support/repository-fixture.mjs';
import { publishedRouteFixture as publishedFixture } from '../test-support/route-decision-fixture.mjs';
import { createBackup,restoreBackup } from '../src/backup.mjs';
import { DatabaseSync } from 'node:sqlite';
import { Pipeline } from '../src/pipeline.mjs';

function proposalInput(state,key='proposal-test-001') {
  const f=state.fragments[0];
  return {expected_hash:state.current.content_hash,idempotency_key:key,reason:'Explicitly approve a different day order',route_scope:{
    mode:'evidence_composed_route',fragment_ids:[f.fragment_id],day_count:3,days:[...f.days].reverse().map((d,i)=>({
      source_day_id:d.day_id,label:`Day ${i+1}`,stop_ids:f.stops.filter(s=>s.day_id===d.day_id).map(s=>s.stop_id),
      leg_ids:f.legs.filter(l=>f.stops.some(s=>s.stop_id===l.from_stop_id && s.day_id===d.day_id)).map(l=>l.leg_id)}))}};
}
const decision=(state,proposal,action='approve_route_revision')=>({decision:action,authority:'route_revision',
  expected_hash:state.current.content_hash,proposal_hash:proposal.proposal_hash});
const protectedRows=db=>Object.fromEntries(['article_drafts','article_visuals','writing_packets','quality_reviews','jobs','model_call_metrics','wordpress_publications']
  .map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));

test('historical article without route snapshot stays unknown and cannot be silently backfilled',t=>{
  const {repository,db}=repositoryFixture(t),seed=publishedFixture(repository);
  const input=proposalInput(repository.routeDecisionState(seed.ownerId));
  db.prepare('DELETE FROM route_artifacts WHERE route_id=?').run(seed.bundle.route_id);
  db.prepare('DELETE FROM route_bundles WHERE route_id=?').run(seed.bundle.route_id);
  const before=protectedRows(db),state=repository.routeDecisionState(seed.ownerId);
  assert.equal(state.article_route_status,'unknown');assert.equal(state.can_propose,false);
  assert.equal(state.current,null);assert.deepEqual(state.fragments,[]);
  assert.throws(()=>repository.proposeRouteRevision(seed.ownerId,input,'editor'),{code:'ROUTE_SNAPSHOT_REQUIRED'});
  assert.deepEqual(protectedRows(db),before);
  assert.equal(db.prepare('SELECT count(*) n FROM route_bundles').get().n,0);
});

test('malformed scopes and unresolved targets cannot create an approved route or mutate body/jobs',t=>{
  const {repository,db}=repositoryFixture(t),seed=publishedFixture(repository);
  const state=repository.routeDecisionState(seed.ownerId),before=protectedRows(db);
  for(const payload of [null,[],{...proposalInput(state),route_scope:{mode:'evidence_composed_route',fragment_ids:['x'],days:[null]}}])
    assert.throws(()=>repository.proposeRouteRevision(seed.ownerId,payload,'editor'),{code:'ROUTE_DECISION_INPUT'});
  const input=proposalInput(state);
  input.route_scope.days[0].leg_ids=[];
  const proposal=repository.proposeRouteRevision(seed.ownerId,input,'editor');
  assert.notEqual(proposal.target.status,'FROZEN');
  assert.throws(()=>repository.decideRouteRevision(seed.ownerId,proposal.id,decision(state,proposal),'editor'));
  assert.throws(()=>repository.decideRouteRevision('missing-owner',proposal.id,decision(state,proposal),'editor'),{statusCode:404});
  assert.equal(repository.routeDecisionState(seed.ownerId).current.revision,1);
  assert.equal(repository.routeDecisionState(seed.ownerId).proposals[0].status,'pending');
  assert.deepEqual(protectedRows(db),before);
});

test('published three-day article: media-only permission cannot decide; explicit approval preserves body, publication, budget and jobs',t=>{
  const {repository,db}=repositoryFixture(t),seed=publishedFixture(repository);
  const before=protectedRows(db),state=repository.routeDecisionState(seed.ownerId),input=proposalInput(state);
  const proposal=repository.proposeRouteRevision(seed.ownerId,input,'editor');
  assert.equal(proposal.target.status,'FROZEN');assert.ok(proposal.differences.length>0);
  assert.equal(repository.routeDecisionState(seed.ownerId).current.revision,1);
  assert.equal(repository.proposeRouteRevision(seed.ownerId,input,'editor').id,proposal.id);
  assert.throws(()=>repository.proposeRouteRevision(seed.ownerId,{...input,reason:'different'},'editor'),{code:'ROUTE_IDEMPOTENCY_CONFLICT'});
  assert.throws(()=>repository.decideRouteRevision(seed.ownerId,proposal.id,{...decision(state,proposal),authority:'media_only'},'editor'),{code:'ROUTE_REVISION_PERMISSION_REQUIRED'});
  assert.throws(()=>repository.decideRouteRevision(seed.ownerId,proposal.id,{...decision(state,proposal),proposal_hash:'forged'},'editor'),{code:'ROUTE_PROPOSAL_STALE'});
  const receipt=repository.decideRouteRevision(seed.ownerId,proposal.id,decision(state,proposal),'editor');
  assert.equal(receipt.approved_revision,2);assert.equal(receipt.jobs_queued,0);
  assert.deepEqual(repository.decideRouteRevision(seed.ownerId,proposal.id,decision(state,proposal),'editor'),receipt);
  const after=repository.routeDecisionState(seed.ownerId);
  assert.equal(after.current.revision,2);assert.equal(after.article_route.revision,1);
  assert.equal(after.article_route.days.length,3);assert.equal(after.proposals[0].status,'approve_route_revision');
  assert.deepEqual(protectedRows(db),before);
  assert.equal(repository.getPlanningPackage(seed.candidateId,{opportunityId:seed.ownerId}).route_bundle.revision,2);
  assert.throws(()=>repository.assertCurrentRoute(seed.bundle),{code:'ROUTE_VERSION_STALE'});
  assert.throws(()=>repository.decideRouteRevision(seed.ownerId,proposal.id,decision(state,proposal,'reject_route_revision'),'editor'),{code:'ROUTE_ALREADY_DECIDED'});
});

test('Worker rejects approved route v2 with preserved article v1 before composition, QA or delivery',async t=>{
  const {repository,db}=repositoryFixture(t),seed=publishedFixture(repository);
  const state=repository.routeDecisionState(seed.ownerId),proposal=repository.proposeRouteRevision(seed.ownerId,proposalInput(state),'editor');
  repository.decideRouteRevision(seed.ownerId,proposal.id,decision(state,proposal),'editor');
  db.prepare('DELETE FROM jobs').run();
  const before=db.prepare('SELECT * FROM article_drafts WHERE id=?').get(seed.draft);
  let calls=0;
  const denied=async()=>{calls++;throw new Error('External boundary must not be reached');};
  const pipeline=new Pipeline(repository,{enabled:false},{contentEngine:{enabled:true,review:denied},
    wordpress:{enabled:true,resolveVisualMedia:denied,pushDraft:denied,publishPost:denied}});
  for(const type of ['generate_visuals','compose_frontend_page','review_draft','compose_publish_page','push_wordpress_draft','publish_wordpress_post']) {
    repository.enqueue(type,seed.draft,{productionOwnerOpportunityId:seed.ownerId});
    await pipeline.runOne();
    const job=db.prepare('SELECT * FROM jobs WHERE type=?').get(type);
    assert.equal(job.status,'failed',type);assert.equal(job.last_failure_code,'ROUTE_VERSION_STALE',type);
  }
  assert.equal(calls,0);
  const after=db.prepare('SELECT * FROM article_drafts WHERE id=?').get(seed.draft);
  assert.equal(after.status,'exception');
  assert.deepEqual({...after,status:before.status,updated_at:before.updated_at},{...before});
  assert.equal(repository.routeDecisionState(seed.ownerId).article_route.revision,1);
});

test('source change or another decision makes approval stale; rejection creates no route revision',t=>{
  const {repository,db}=repositoryFixture(t),seed=publishedFixture(repository);
  const state=repository.routeDecisionState(seed.ownerId),proposal=repository.proposeRouteRevision(seed.ownerId,proposalInput(state),'editor');
  const before=protectedRows(db);
  const changed=structuredClone(seed.fragment);changed.legs[0].mode='taxi';
  repository.saveExperienceExtraction(seed.source.id,{blocks:[],route_fragments:[changed]},'fixture',seed.input);
  assert.throws(()=>repository.decideRouteRevision(seed.ownerId,proposal.id,decision(state,proposal),'editor'),{code:'ROUTE_SOURCE_STALE'});
  assert.equal(repository.routeDecisionState(seed.ownerId).current.revision,1);
  repository.decideRouteRevision(seed.ownerId,proposal.id,decision(state,proposal,'reject_route_revision'),'editor');
  assert.equal(repository.routeDecisionState(seed.ownerId).proposals[0].status,'reject_route_revision');
  assert.deepEqual(protectedRows(db),before);
});

test('pending proposal and approved decision survive real migration-review restore without starting work',t=>{
  const {repository,db,directory}=repositoryFixture(t),seed=publishedFixture(repository);
  const state=repository.routeDecisionState(seed.ownerId),a=repository.proposeRouteRevision(seed.ownerId,proposalInput(state,'first-proposal'),'editor');
  const b=repository.proposeRouteRevision(seed.ownerId,proposalInput(state,'other-proposal'),'editor');
  repository.decideRouteRevision(seed.ownerId,a.id,decision(state,a),'editor');
  assert.throws(()=>repository.decideRouteRevision(seed.ownerId,b.id,decision(state,b),'editor'),{code:'ROUTE_VERSION_STALE'});
  const backup=createBackup({databasePath:path.join(directory,'test.sqlite'),backupDir:path.join(directory,'backups'),retention:2});
  const restored=restoreBackup(backup.backupPath,path.join(directory,'restored'));
  assert.equal(restored.mode,'migration-review');
  const copy=new DatabaseSync(restored.databasePath,{readOnly:true});
  try {
    for(const table of ['route_bundles','route_artifacts','article_drafts','wordpress_publications'])
      assert.deepEqual(copy.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    assert.equal(copy.prepare('PRAGMA foreign_key_check').all().length,0);
  } finally{copy.close();}
});

test('actual HTTP: admin and origin guards, malformed requests, preview, proposal and reject are enforced',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cms-route-api-')),databasePath=path.join(directory,'test.sqlite');
  openDatabase(databasePath).close();
  const app=createApplication(loadConfig({HOST:'127.0.0.1',PORT:'0',DATABASE_PATH:databasePath,CMS_PROCESS_ROLE:'api',
    ADMIN_TOKEN:'route-fixture-only',MAINTENANCE_ENABLED:'false',LOG_LEVEL:'error'}));
  t.after(async()=>{await app.stop();assert.equal(path.dirname(fs.realpathSync(directory)),fs.realpathSync(os.tmpdir()));fs.rmSync(directory,{recursive:true,force:true});});
  const seed=publishedFixture(app.repository);await app.start();
  const url=`http://127.0.0.1:${app.server.address().port}/api/content/${seed.ownerId}/route-decisions`;
  const headers={authorization:'Bearer route-fixture-only','content-type':'application/json'};
  assert.equal((await fetch(url)).status,401);
  const state=await(await fetch(url,{headers})).json();assert.equal(state.article_route.days.length,3);
  assert.equal((await fetch(url,{method:'POST',headers:{...headers,origin:'https://untrusted.invalid'},body:'{}'})).status,403);
  assert.equal((await fetch(url,{method:'POST',headers,body:'{}'})).status,400);
  const response=await fetch(url,{method:'POST',headers,body:JSON.stringify(proposalInput(state))});assert.equal(response.status,200);
  const proposal=await response.json(),target=`${url}/${proposal.id}`;
  assert.equal((await fetch(target,{method:'POST',headers,body:JSON.stringify({...decision(state,proposal),authority:'media_only'})})).status,403);
  assert.equal((await fetch(target,{method:'POST',headers,body:JSON.stringify(decision(state,proposal,'reject_route_revision'))})).status,200);
  const final=await(await fetch(url,{headers})).json();assert.equal(final.proposals[0].status,'reject_route_revision');
  assert.equal(final.current.revision,1);
  const revision=app.repository.proposeRouteRevision(seed.ownerId,proposalInput(final,'adapter-revision-test'),'editor');
  app.repository.decideRouteRevision(seed.ownerId,revision.id,decision(final,revision),'editor');
  const adapter=app.pipeline.wordpress;
  adapter.config={siteUrl:'https://example.invalid',username:'fixture',applicationPassword:'fixture-only'};
  let requests=0;adapter.fetch=async()=>{requests++;throw new Error('No external transport allowed');};
  await assert.rejects(adapter.upsertDraft({title:'Old route'},null,{draftId:seed.draft}),{code:'ROUTE_VERSION_STALE'});
  await assert.rejects(adapter.upsertContractDraft({page:{}},{draftId:seed.draft}),{code:'ROUTE_VERSION_STALE'});
  assert.equal(requests,0,'the real application deliveryGuard must reject before the adapter transport');
});
