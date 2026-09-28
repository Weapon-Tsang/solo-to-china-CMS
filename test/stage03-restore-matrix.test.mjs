import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {repositoryFixture} from '../test-support/repository-fixture.mjs';
import {publishedRouteFixture} from '../test-support/route-decision-fixture.mjs';
import {createBackup,restoreBackup} from '../src/backup.mjs';
import {prepareWebMedia,mediaHash} from '../src/web-media.mjs';
import {assertLocalRuntime} from '../src/local-runtime.mjs';
import {loadConfig} from '../src/config.mjs';

for(const change of ['media_only','equivalent_alias_registration','equivalent_english_alias_correction','day_order'])test(`T03-33/44 real snapshot and review restore: ${change}`,async t=>{
  const f=repositoryFixture(t),{repository,db,directory}=f,seed=publishedRouteFixture(repository);
  repository.contentConfig.generatedMediaDir=path.join(directory,'media');
  const visual=db.prepare('SELECT * FROM article_visuals WHERE draft_id=?').get(seed.draft);
  const rendered=await repository.renderDraftRouteVisual(visual);
  repository.saveGeneratedVisual(visual.id,rendered,{expectedFingerprint:visual.asset_fingerprint});
  const protectedTables=['article_drafts','quality_reviews','model_call_metrics','jobs','wordpress_publications'];
  const before=Object.fromEntries(protectedTables.map(name=>[name,db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
  if(change==='media_only') {
    const web=await prepareWebMedia({bytes:fs.readFileSync(rendered.mediaPath),contentType:'image/png',outputDir:repository.contentConfig.generatedMediaDir,
      kind:'route',qa:rendered.metadata.local_route_qa,approvedRouteHash:seed.bundle.approved_route_hash});
    const metadata=JSON.parse(db.prepare('SELECT media_metadata_json FROM article_visuals WHERE id=?').get(visual.id).media_metadata_json);
    // A persisted media receipt is the input being restored, not forged QA.
    db.prepare('UPDATE article_visuals SET media_metadata_json=? WHERE id=?').run(JSON.stringify({...metadata,web_derivative:web.receipt,
      recovery_budget:{deterministic_recovery:2}}),visual.id);
    assert.equal(repository.getPlanningPackage(seed.candidateId,{opportunityId:seed.ownerId}).route_bundle.revision,1);
  } else if(change==='equivalent_alias_registration') {
    db.prepare(`INSERT INTO entity_aliases(id,destination_slug,alias_normalized,entity_key,canonical_subject,aliases_json,resolution_source,confidence,created_at,updated_at,entity_type,granularity)
      VALUES ('equivalent-east','beijing','east pavilion','east','East Hall','[]','manual',1,'now','now','attraction','specific_entity')`).run();
    const current=repository.getPlanningPackage(seed.candidateId,{opportunityId:seed.ownerId}).route_bundle;
    assert.equal(current.approved_route_hash,seed.bundle.approved_route_hash);assert.equal(current.revision,1);
  } else if(change==='equivalent_english_alias_correction') {
    db.prepare("UPDATE entity_aliases SET canonical_subject='East Pavilion',aliases_json='[\"East Hall\",\"East Pavilion\"]' WHERE entity_key='east'").run();
    const current=repository.getPlanningPackage(seed.candidateId,{opportunityId:seed.ownerId}).route_bundle;
    assert.equal(current.approved_route_hash,seed.bundle.approved_route_hash);
    assert.equal(current.revision,1,'equivalent identity correction does not create a different itinerary');
    assert.deepEqual(current.stops,seed.bundle.stops,'frozen article names are not silently rewritten from a global alias edit');
  } else {
    const state=repository.routeDecisionState(seed.ownerId),fragment=state.fragments[0];
    const proposal=repository.proposeRouteRevision(seed.ownerId,{expected_hash:state.current.content_hash,
      idempotency_key:'stage03_restore_day_order',reason:'Explicitly review changed day order.',route_scope:{mode:'evidence_composed_route',fragment_ids:[fragment.fragment_id],day_count:3,
        days:[...fragment.days].reverse().map((day,i)=>({source_day_id:day.day_id,label:`Day ${i+1}`,
          stop_ids:fragment.stops.filter(s=>s.day_id===day.day_id).map(s=>s.stop_id),
          leg_ids:fragment.legs.filter(l=>fragment.stops.some(s=>s.stop_id===l.from_stop_id&&s.day_id===day.day_id)).map(l=>l.leg_id)}))}},'editor');
    repository.decideRouteRevision(seed.ownerId,proposal.id,{decision:'approve_route_revision',authority:'route_revision',
      expected_hash:state.current.content_hash,proposal_hash:proposal.proposal_hash},'editor');
    assert.throws(()=>repository.assertCurrentRoute(seed.bundle),{code:'ROUTE_VERSION_STALE'});
    await assert.rejects(repository.renderDraftRouteVisual(visual),{code:'ROUTE_VERSION_STALE'});
  }
  for(const table of protectedTables)assert.deepEqual(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),before[table]);
  const saved=createBackup({databasePath:path.join(directory,'test.sqlite'),backupDir:path.join(directory,'backups'),generatedMediaDir:repository.contentConfig.generatedMediaDir});
  const restored=restoreBackup(saved.backupPath,path.join(directory,'restored'));
  assert.equal(restored.mode,'migration-review');assert.equal(restored.externalSideEffects,false);
  assert.throws(()=>assertLocalRuntime(loadConfig({CMS_RUN_MODE:'migration-review',CMS_DATA_ROOT:restored.restoredRoot,DATABASE_PATH:restored.databasePath})),/read-only/);
  const copy=new DatabaseSync(restored.databasePath,{readOnly:true});
  try {
    for(const table of [...protectedTables,'route_bundles','writing_packets','entity_aliases'])
      assert.deepEqual(copy.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    assert.deepEqual(copy.prepare("SELECT * FROM route_artifacts WHERE artifact_kind<>'schematic' ORDER BY id").all(),
      db.prepare("SELECT * FROM route_artifacts WHERE artifact_kind<>'schematic' ORDER BY id").all());
    const artifacts=copy.prepare("SELECT * FROM route_artifacts WHERE artifact_kind='schematic'").all();
    for(const artifact of artifacts)assert.equal(mediaHash(fs.readFileSync(artifact.media_path)),artifact.file_sha256);
    const metadata=JSON.parse(copy.prepare('SELECT media_metadata_json FROM article_visuals WHERE id=?').get(visual.id).media_metadata_json);
    if(change==='media_only') {
      assert.equal(metadata.recovery_budget.deterministic_recovery,2);
      assert.equal(mediaHash(fs.readFileSync(metadata.web_derivative.localPath)),metadata.web_derivative.sha256);
    }
    assert.equal(copy.prepare('PRAGMA foreign_key_check').all().length,0);
  }finally{copy.close();}
});
