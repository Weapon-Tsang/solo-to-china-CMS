import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { repositoryFixture } from '../test-support/repository-fixture.mjs';
import { publishedRouteFixture } from '../test-support/route-decision-fixture.mjs';
import { ArticleMediaService } from '../src/services/article-media.mjs';
import { manualRouteMediaDecision } from '../src/services/manual-route-media.mjs';
import { mediaHash } from '../src/web-media.mjs';
import { closeLocalPhotoAudit } from '../src/local-photo-audit.mjs';
import { createBackup, restoreBackup } from '../src/backup.mjs';
import { DatabaseSync } from 'node:sqlite';
import {verifyStoredRouteVisual} from '../src/visuals/route-schematic.mjs';

test('T03-29/39/40 confirmed stop photo proceeds locally; a conflicting Day image stays saved and cannot rewrite approved text', async t => {
  t.after(closeLocalPhotoAudit);
  const f = repositoryFixture(t), seed = publishedRouteFixture(f.repository);
  const service = new ArticleMediaService(f.repository, { mediaDir: path.join(f.directory,'media'),
    captureMediaUploads: { uploadDir: path.join(f.directory,'uploads'), storageDir: path.join(f.directory,'originals') } });
  const before = f.db.prepare('SELECT * FROM article_drafts WHERE id=?').get(seed.draft);
  const routeBefore = f.db.prepare('SELECT * FROM route_bundles ORDER BY revision').all();
  const callsBefore = f.db.prepare('SELECT * FROM model_call_metrics').all();
  const bytes = await sharp({ create: { width: 1200, height: 800, channels: 3, background:'#cbd8cd' } }).png().toBuffer();
  const originalHash = mediaHash(bytes);
  async function upload(name) {
    const u = await service.create(seed.draft, { expected_revision: before.revision, name, size: bytes.length, mimeType: 'image/png', sha256: originalHash }, 'editor');
    await service.chunk(seed.draft, u.id, 0, bytes, 'editor', originalHash);
    return service.complete(seed.draft, u.id, 'editor');
  }
  const photo = await upload('stop-photo.png');
  const selected = { upload_id:photo.id, purpose:'body', kind:'photo', caption:'East Hall.', description:'Administrator confirms this article scene.',
    factual_photo:true, no_reader_text:true, quality_confirmed:true, approved_route_hash:seed.bundle.approved_route_hash,
    route_entity_id:seed.bundle.stops[0].entity_id };
  const input = { expected_revision:before.revision, expected_media_revision:0, selections:[selected] };
  const plan = service.plan(seed.draft,input,'editor');
  assert.equal(plan.selections[0].route_blocked,false);
  f.db.exec('SAVEPOINT wrong_body');
  f.db.prepare('UPDATE article_drafts SET body_markdown=? WHERE id=?').run(before.body_markdown.replace('walk','taxi'),seed.draft);
  assert.throws(()=>service.plan(seed.draft,input,'editor'),{code:'ROUTE_TEXT_MISMATCH'},'T03-43 known wrong body is a content error, not silently protected');
  f.db.exec('ROLLBACK TO wrong_body; RELEASE wrong_body');
  f.db.exec('SAVEPOINT stale_receipt');
  f.db.prepare('UPDATE article_drafts SET content_hash=? WHERE id=?').run('changed-body-without-route-receipt',seed.draft);
  assert.throws(()=>service.plan(seed.draft,input,'editor'),{code:'ROUTE_VERSION_STALE'},'missing matching receipt must not turn a route article into an unrestricted photo article');
  assert.equal(service.list(seed.draft,'editor').items[0].asset_id,photo.asset_id,'saved originals remain accessible');
  f.db.exec('ROLLBACK TO stale_receipt; RELEASE stale_receipt');
  const adopted = await service.confirm(seed.draft,{...input,plan_hash:plan.plan_hash,confirmed:true,idempotency_key:'route_photo_stage03_001'},'editor');
  assert.equal(adopted.state,'local_ready',JSON.stringify(adopted.items));
  const visual = f.db.prepare('SELECT * FROM article_visuals WHERE id=?').get(plan.selections[0].slot_id);
  const metadata = JSON.parse(visual.media_metadata_json);
  assert.equal(metadata.route_contract.compatible,true);
  assert.equal(metadata.route_contract.does_not_prove,'route connection or same-day photography');
  assert.equal(mediaHash(fs.readFileSync(metadata.manual_local_receipt.derivative.localPath)),metadata.manual_local_receipt.derivative.sha256);
  const map = await upload('conflicting-day-map.png');
  const conflictInput = { expected_revision:before.revision, expected_media_revision:1, selections:[{ ...selected, upload_id:map.id,
    kind:'route',route_day_id:seed.bundle.days[1].day_id,embedded_day_label:'Day 3' }] };
  const conflict = service.plan(seed.draft,conflictInput,'editor');
  assert.equal(conflict.steps[0].status,'ROUTE_MEDIA_CONFLICT');
  assert.deepEqual(conflict.selections[0].route_decision.differences.find(d=>d.field==='embedded_day_label'),
    {field:'embedded_day_label',expected:'Day 2',actual:'Day 3'});
  const retained = await service.confirm(seed.draft,{...conflictInput,plan_hash:conflict.plan_hash,confirmed:true,idempotency_key:'route_map_stage03_0001'},'editor');
  assert.equal(retained.state,'waiting_attention');
  assert.equal(retained.items[0].state,'ROUTE_MEDIA_CONFLICT');
  assert.equal(mediaHash(fs.readFileSync(service.previewFile(seed.draft,map.id,'editor'))),originalHash);
  assert.deepEqual(f.db.prepare('SELECT * FROM article_drafts WHERE id=?').get(seed.draft),before);
  assert.deepEqual(f.db.prepare('SELECT * FROM route_bundles ORDER BY revision').all(),routeBefore);
  assert.deepEqual(f.db.prepare('SELECT * FROM model_call_metrics').all(),callsBefore);
  assert.equal(f.db.prepare('SELECT status FROM article_visuals WHERE id=?').get(visual.id).status,'generated','already successful photo is reused');
  f.repository.contentConfig.generatedMediaDir=path.join(f.directory,'media');
  const alternative={expected_revision:before.revision,expected_media_revision:2,selections:[{
    ...conflictInput.selections[0],slot_id:conflict.selections[0].slot_id,replace_selection_id:retained.id,route_action:'recompose_approved'}]};
  const alternativePlan=service.plan(seed.draft,alternative,'editor');
  assert.throws(()=>service.plan(seed.draft,{...alternative,selections:[{...alternative.selections[0],approved_route_hash:'old'}]},'editor'),{code:'ROUTE_RECOMPOSITION_SCOPE'});
  assert.throws(()=>service.plan(seed.draft,{...alternative,selections:[{...alternative.selections[0],route_action:'silently_rewrite_body'}]},'editor'),{code:'INVALID_ROUTE_ACTION'});
  f.db.exec('SAVEPOINT factual_obligation');
  f.db.prepare('UPDATE article_visuals SET factual_image_required=1 WHERE id=?').run(conflict.selections[0].slot_id);
  assert.throws(()=>service.plan(seed.draft,alternative,'editor'),{code:'ROUTE_FACTUAL_MEDIA_REQUIRED'});
  f.db.exec('ROLLBACK TO factual_obligation; RELEASE factual_obligation');
  assert.equal(alternativePlan.steps[0].status,'LOCAL_ROUTE_RECOMPOSITION');
  assert.equal(alternativePlan.selections[0].render_preview.days.length,3);
  assert.equal(alternativePlan.selections[0].original_decision.code,'ROUTE_MEDIA_CONFLICT');
  const confirmedInput={...alternative,plan_hash:alternativePlan.plan_hash,confirmed:true,idempotency_key:'route_recompose_stage03_001'};
  const recomposed=await service.confirm(seed.draft,confirmedInput,'editor');
  assert.equal(recomposed.state,'local_ready',JSON.stringify(recomposed.items));
  assert.equal((await service.confirm(seed.draft,confirmedInput,'editor')).id,recomposed.id);
  const rebuilt=f.db.prepare('SELECT * FROM article_visuals WHERE id=?').get(conflict.selections[0].slot_id);
  assert.equal(rebuilt.acquisition_strategy,'render_route_schematic');
  const rebuiltMetadata=JSON.parse(rebuilt.media_metadata_json);
  assert.equal(verifyStoredRouteVisual(f.db,seed.bundle,rebuilt,rebuiltMetadata),true);
  assert.notEqual(mediaHash(fs.readFileSync(rebuilt.media_path)),originalHash);
  assert.equal(mediaHash(fs.readFileSync(service.previewFile(seed.draft,map.id,'editor'))),originalHash);
  assert.equal(rebuiltMetadata.manual_local_receipt.retained_upload_hash,originalHash);
  assert.equal(service.list(seed.draft,'editor').items.find(item=>item.id===map.id).replacement.preview_url,rebuilt.media_url);
  assert.equal((await service.resume(seed.draft,recomposed.id,'editor')).state,'local_ready');
  assert.equal(JSON.parse(f.db.prepare('SELECT media_metadata_json FROM article_visuals WHERE id=?').get(rebuilt.id).media_metadata_json).recovery_budget.deterministic_recovery,1,'successful resume does not spend another render attempt');
  assert.deepEqual(f.db.prepare('SELECT * FROM article_drafts WHERE id=?').get(seed.draft),before);
  assert.deepEqual(f.db.prepare('SELECT * FROM route_bundles ORDER BY revision').all(),routeBefore);
  assert.deepEqual(f.db.prepare('SELECT * FROM model_call_metrics').all(),callsBefore);
  // Combined schema83 snapshot: approved route, actual local renderer, confirmed
  // photo, conflicting map, paused original and recovery records coexist.
  f.repository.contentConfig.generatedMediaDir=path.join(f.directory,'media');
  await f.repository.ensureRouteSchematic(seed.bundle);
  const paused=await service.create(seed.draft,{expected_revision:before.revision,name:'paused.png',size:bytes.length,mimeType:'image/png',sha256:originalHash},'editor');
  await service.chunk(seed.draft,paused.id,0,bytes,'editor',originalHash);service.state(seed.draft,paused.id,'editor','paused');
  const backup=createBackup({databasePath:path.join(f.directory,'test.sqlite'),backupDir:path.join(f.directory,'backups'),
    generatedMediaDir:path.join(f.directory,'media'),sourceUploadsDir:path.join(f.directory,'originals')});
  const restored=restoreBackup(backup.backupPath,path.join(f.directory,'restored'));
  assert.equal(restored.mode,'migration-review');
  const copy=new DatabaseSync(restored.databasePath,{readOnly:true});
  try {
    assert.deepEqual(copy.prepare('SELECT * FROM article_drafts WHERE id=?').get(seed.draft),before);
    assert.deepEqual(copy.prepare('SELECT * FROM route_bundles ORDER BY revision').all(),routeBefore);
    assert.deepEqual(copy.prepare('SELECT * FROM model_call_metrics').all(),callsBefore);
    assert.equal(copy.prepare('SELECT count(*) n FROM article_media_revisions').get().n,3);
    assert.equal(copy.prepare('SELECT state FROM article_media_uploads WHERE id=?').get(paused.id).state,'paused');
    const chunks=JSON.parse(copy.prepare('SELECT upload_json FROM article_media_uploads WHERE id=?').get(paused.id).upload_json).parts;
    assert.equal(mediaHash(fs.readFileSync(chunks[0].localPath)),originalHash);
    const rendered=copy.prepare("SELECT media_path,file_sha256 FROM route_artifacts WHERE artifact_kind='schematic'").get();
    assert.equal(mediaHash(fs.readFileSync(rendered.media_path)),rendered.file_sha256);
    const local=JSON.parse(copy.prepare('SELECT media_metadata_json FROM article_visuals WHERE id=?').get(visual.id).media_metadata_json).manual_local_receipt;
    assert.equal(mediaHash(fs.readFileSync(local.derivative.localPath)),local.derivative.sha256);
    assert.equal(copy.prepare("SELECT count(*) n FROM jobs WHERE status='running'").get().n,0);
  } finally {copy.close();}
});

test('T03-36/38 photo cannot replace a whole-day obligation; claimed matching Day cannot bypass pixel QA or stale approval', t => {
  const f = repositoryFixture(t), { bundle } = publishedRouteFixture(f.repository);
  const photo = {kind:'photo',purpose:'body',approved_route_hash:bundle.approved_route_hash,route_entity_id:bundle.stops[0].entity_id,factual_photo:true};
  assert.equal(manualRouteMediaDecision(bundle,photo).blocked,false);
  assert.equal(manualRouteMediaDecision(bundle,photo,{use:'day_route_diagram'}).blocked,true);
  assert.equal(manualRouteMediaDecision(bundle,{...photo,route_entity_id:'unrelated'}).blocked,true);
  assert.equal(manualRouteMediaDecision(bundle,{...photo,approved_route_hash:'old'}).blocked,true);
  const diagram=manualRouteMediaDecision(bundle,{...photo,kind:'route',route_day_id:bundle.days[0].day_id,embedded_day_label:'Day 1'});
  assert.equal(diagram.blocked,true);assert.equal(diagram.code,'ROUTE_EVIDENCE_PENDING');
  assert.equal(manualRouteMediaDecision(null,{kind:'route'}).code,'ROUTE_SNAPSHOT_REQUIRED');
});

test('T03-42/44 failed manual recomposition keeps its budget across restart and new confirmation',async t=>{
  const f=repositoryFixture(t),seed=publishedRouteFixture(f.repository);
  const config={mediaDir:path.join(f.directory,'media'),captureMediaUploads:{uploadDir:path.join(f.directory,'uploads'),storageDir:path.join(f.directory,'originals')}};
  let service=new ArticleMediaService(f.repository,config),calls=0;
  const bytes=await sharp({create:{width:100,height:100,channels:3,background:'#eee'}}).png().toBuffer(),sha256=mediaHash(bytes);
  const stored=await service.create(seed.draft,{expected_revision:1,name:'conflict.png',size:bytes.length,mimeType:'image/png',sha256},'editor');
  await service.chunk(seed.draft,stored.id,0,bytes,'editor',sha256);await service.complete(seed.draft,stored.id,'editor');
  const selected={upload_id:stored.id,kind:'route',purpose:'body',caption:'Diagram.',description:'Replace conflicting map with approved schematic.',
    approved_route_hash:seed.bundle.approved_route_hash,route_action:'recompose_approved'};
  const input={expected_revision:1,expected_media_revision:0,selections:[selected]},plan=service.plan(seed.draft,input,'editor');
  f.repository.renderDraftRouteVisual=async()=>{calls++;throw Object.assign(new Error('Injected local renderer failure'),{code:'RENDER_FAILURE'});};
  let result=await service.confirm(seed.draft,{...input,confirmed:true,plan_hash:plan.plan_hash,idempotency_key:'render_failure_stage03_001'},'editor');
  assert.equal(result.items[0].state,'RENDER_FAILURE');
  service=new ArticleMediaService(f.repository,config);
  await service.resume(seed.draft,result.id,'editor');await service.resume(seed.draft,result.id,'editor');
  assert.equal((await service.resume(seed.draft,result.id,'editor')).items[0].state,'ROUTE_RENDER_BUDGET_EXHAUSTED');
  const again={expected_revision:1,expected_media_revision:1,selections:[{...selected,slot_id:plan.selections[0].slot_id,replace_selection_id:result.id}]};
  const againPlan=service.plan(seed.draft,again,'editor');
  result=await service.confirm(seed.draft,{...again,confirmed:true,plan_hash:againPlan.plan_hash,idempotency_key:'render_failure_stage03_002'},'editor');
  assert.equal(result.items[0].state,'ROUTE_RENDER_BUDGET_EXHAUSTED');assert.equal(calls,3);
  assert.equal(mediaHash(fs.readFileSync(service.previewFile(seed.draft,stored.id,'editor'))),sha256);
  assert.equal(f.db.prepare('SELECT count(*) n FROM model_call_metrics').get().n,0);
});


test('T03-40 three new Day images cannot reorder an existing three-day article under media-only confirmation',async t=>{
  const f=repositoryFixture(t),seed=publishedRouteFixture(f.repository);
  const service=new ArticleMediaService(f.repository,{mediaDir:path.join(f.directory,'media'),captureMediaUploads:{uploadDir:path.join(f.directory,'uploads'),storageDir:path.join(f.directory,'originals')}});
  const before=f.db.prepare('SELECT * FROM article_drafts WHERE id=?').get(seed.draft);
  const routes=f.db.prepare('SELECT * FROM route_bundles ORDER BY revision').all();
  const bytes=await sharp({create:{width:1200,height:800,channels:3,background:'#ced4dc'}}).png().toBuffer();
  const sha256=mediaHash(bytes),selections=[];
  for(let i=0;i<3;i++){
    const upload=await service.create(seed.draft,{expected_revision:before.revision,name:`day-${i+1}.png`,size:bytes.length,mimeType:'image/png',sha256},'editor');
    await service.chunk(seed.draft,upload.id,0,bytes,'editor',sha256);await service.complete(seed.draft,upload.id,'editor');
    selections.push({upload_id:upload.id,purpose:'body',kind:'route',caption:`Day ${i+1} image.`,description:'A conflicting day label supplied for this article.',
      approved_route_hash:seed.bundle.approved_route_hash,route_day_id:seed.bundle.days[i].day_id,embedded_day_label:`Day ${(i+1)%3+1}`});
  }
  const input={expected_revision:before.revision,expected_media_revision:0,selections};
  const plan=service.plan(seed.draft,input,'editor');
  assert.ok(plan.selections.every(s=>s.route_blocked&&s.route_decision.differences.some(d=>d.field==='embedded_day_label')));
  const result=await service.confirm(seed.draft,{...input,plan_hash:plan.plan_hash,confirmed:true,idempotency_key:'three_day_conflict_stage03'},'editor');
  assert.equal(result.state,'waiting_attention');assert.equal(result.items.length,3);
  assert.ok(result.items.every(x=>x.state==='ROUTE_MEDIA_CONFLICT'));
  for(const selection of selections)assert.equal(mediaHash(fs.readFileSync(service.previewFile(seed.draft,selection.upload_id,'editor'))),sha256);
  assert.deepEqual(f.db.prepare('SELECT * FROM article_drafts WHERE id=?').get(seed.draft),before);
  assert.deepEqual(f.db.prepare('SELECT * FROM route_bundles ORDER BY revision').all(),routes);
  assert.equal(f.db.prepare('SELECT count(*) n FROM model_call_metrics').get().n,0);
});
