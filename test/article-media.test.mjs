import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {repositoryFixture} from '../test-support/repository-fixture.mjs';
import {seedCoverFixture} from '../test-support/cover-fixture.mjs';
import {ArticleMediaService} from '../src/services/article-media.mjs';
import {loadConfig} from '../src/config.mjs';
import {mediaHash} from '../src/web-media.mjs';
import {mediaManifestForDraft,freezeRequiredMediaManifest,evaluatePublicationEligibility} from '../src/publication-eligibility.mjs';
import {createBackup,restoreBackup} from '../src/backup.mjs';
import {openDatabase} from '../src/db.mjs';
import {Repository} from '../src/repository.mjs';
import {auditDraftCover} from '../src/services/cover-audit.mjs';
import {closeLocalPhotoAudit} from '../src/local-photo-audit.mjs';
import {articleMediaDeliveryPlan,deliverArticleMedia} from '../src/services/article-media-delivery.mjs';
import {previewCoverSelection,saveCoverSelection,readCoverSelection} from '../src/services/cover-selection.mjs';

async function fixture(t){t.after(closeLocalPhotoAudit);const f=repositoryFixture(t);const seed=await seedCoverFixture(f.repository,f.directory);
  const config={mediaDir:path.join(f.directory,'media'),captureMediaUploads:{uploadDir:path.join(f.directory,'uploads'),storageDir:path.join(f.directory,'sources')}};
  return {...f,...seed,config,service:new ArticleMediaService(f.repository,config)};}
async function upload(f,bytes=f.bytes){const input={expected_revision:2,name:'Photo.png',mimeType:'image/png',size:bytes.length,sha256:mediaHash(bytes)};
  const created=await f.service.create(f.draftId,input,'editor');
  await f.service.chunk(f.draftId,created.id,0,bytes,'editor',mediaHash(bytes));
  return f.service.complete(f.draftId,created.id,'editor');}
const request=(f,u)=>({expected_revision:2,expected_media_revision:0,selections:[{upload_id:u.id,slot_id:f.visualId,purpose:'body',kind:'photo',caption:'East Hall in Beijing.',description:'Editor identifies the East Hall scene.',no_reader_text:true,factual_photo:true,quality_confirmed:true}]});

test('operator can adopt a body photo using choices only; descriptions and local processing require no English input',async t=>{
  const f=await fixture(t),u=await upload(f),before=f.db.prepare('SELECT * FROM article_drafts WHERE id=?').get(f.draftId);
  const input={expected_revision:2,expected_media_revision:0,selections:[{upload_id:u.id,slot_id:f.visualId,
    purpose:'body',kind:'photo',relationship:'article_subject',quality_confirmed:true}]};
  const plan=f.service.plan(f.draftId,input,'editor');
  assert.equal(plan.steps[0].status,'LOCAL_VALIDATION_AND_WEB_DERIVATIVE');
  assert.equal(plan.selections[0].caption,'Editor-selected photograph for this article.');
  assert.ok(!plan.selections[0].caption.includes('East Hall'),'unobserved pixels are not inferred from a failed slot');
  const result=await f.service.confirm(f.draftId,{...input,confirmed:true,plan_hash:plan.plan_hash,idempotency_key:'choice_only_body_photo'},'editor');
  assert.equal(result.state,'local_ready');
  assert.deepEqual(f.db.prepare('SELECT * FROM article_drafts WHERE id=?').get(f.draftId),before);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM model_call_metrics').get().n,0);
  assert.equal(f.service.list(f.draftId,'editor').slots[0].purpose,'body');
});

test('choice-only cover stays separate; background or illustration cannot replace a required subject photograph',async t=>{
  const f=await fixture(t),u=await upload(f);
  const input={expected_revision:2,expected_media_revision:0,selections:[{upload_id:u.id,purpose:'cover',kind:'photo',relationship:'article_subject',quality_confirmed:true}]};
  const plan=f.service.plan(f.draftId,input,'editor');
  assert.equal(plan.steps[0].status,'COVER_GEOMETRY_REQUIRED');
  const result=await f.service.confirm(f.draftId,{...input,confirmed:true,plan_hash:plan.plan_hash,idempotency_key:'choice_only_cover_photo'},'editor');
  assert.equal(result.state,'waiting_attention');
  assert.equal(f.service.list(f.draftId,'editor').slots.find(s=>s.id===plan.selections[0].slot_id).purpose,'cover');
  f.db.prepare('UPDATE article_visuals SET factual_image_required=1 WHERE id=?').run(f.visualId);
  const next=request(f,u);next.expected_media_revision=1;next.selections[0].relationship='context';
  assert.throws(()=>f.service.plan(f.draftId,next,'editor'),error=>error.code==='MEDIA_SUBJECT_REQUIRED');
  next.selections[0].relationship='invalid';
  assert.throws(()=>f.service.plan(f.draftId,next,'editor'),error=>error.code==='INVALID_MEDIA_RELATIONSHIP');
});

test('the same original can be used in the body and as a cover without overwriting the body selection',async t=>{
  const f=await fixture(t),u=await upload(f),input=request(f,u);delete input.selections[0].slot_id;
  const plan=f.service.plan(f.draftId,input,'editor');
  await f.service.confirm(f.draftId,{...input,confirmed:true,plan_hash:plan.plan_hash,idempotency_key:'same_photo_body_selection'},'editor');
  const body=f.db.prepare('SELECT * FROM article_visuals WHERE id=?').get(plan.selections[0].slot_id);
  input.expected_media_revision=1;input.selections[0].purpose='cover';
  const cover=f.service.plan(f.draftId,input,'editor');assert.notEqual(cover.selections[0].slot_id,body.id);
  await f.service.confirm(f.draftId,{...input,confirmed:true,plan_hash:cover.plan_hash,idempotency_key:'same_photo_cover_selection'},'editor');
  assert.deepEqual(f.db.prepare('SELECT * FROM article_visuals WHERE id=?').get(body.id),body);
  input.expected_media_revision=2;
  assert.throws(()=>f.service.plan(f.draftId,input,'editor'),error=>error.code==='MEDIA_ALREADY_SELECTED');
});

test('T04-17 lower proxy chunk setting affects new sessions and preserves existing parts across restart',async t=>{
  const f=await fixture(t),bytes=Buffer.alloc(3*1024*1024,7);
  const input={expected_revision:2,name:'pending.png',mimeType:'image/png',size:bytes.length,sha256:mediaHash(bytes)};
  const old=await f.service.create(f.draftId,input,'editor');
  assert.equal(old.upload.chunkBytes,8*1024*1024);
  await f.service.chunk(f.draftId,old.id,0,bytes,'editor',mediaHash(bytes));
  const configured=loadConfig({ARTICLE_MEDIA_CHUNK_BYTES:'1048576'});
  assert.equal(configured.captureMediaUploads.articleChunkBytes,1024*1024);
  const restarted=new ArticleMediaService(f.repository,{...f.config,captureMediaUploads:{...f.config.captureMediaUploads,
    articleChunkBytes:configured.captureMediaUploads.articleChunkBytes}});
  const existing=await restarted.status(f.draftId,old.id,'editor');
  assert.equal(existing.progress.chunkBytes,8*1024*1024);
  assert.deepEqual(existing.progress.receivedChunks,[0]);
  const fresh=await restarted.create(f.draftId,input,'editor');
  assert.equal(fresh.upload.chunkBytes,1024*1024);assert.equal(fresh.upload.chunkCount,3);
  for(let index=0;index<3;index++) {
    const part=bytes.subarray(index*1024*1024,(index+1)*1024*1024);
    await restarted.chunk(f.draftId,fresh.id,index,part,'editor',mediaHash(part));
  }
  assert.deepEqual((await restarted.status(f.draftId,fresh.id,'editor')).progress.receivedChunks,[0,1,2]);
  assert.equal(mediaHash(fs.readFileSync(restarted.uploads.chunkPath(old.id,0))),mediaHash(bytes));
});

test('manual cover geometry completes the existing media revision without resetting body or buying QA',async t=>{
  const f=await fixture(t),u=await upload(f),input=request(f,u);input.selections[0].purpose='cover';
  f.db.prepare("UPDATE article_visuals SET media_metadata_json=json_set(media_metadata_json,'$.media_purpose','cover') WHERE id=?").run(f.visualId);
  const before=f.db.prepare('SELECT * FROM article_drafts WHERE id=?').get(f.draftId);
  const plan=f.service.plan(f.draftId,input,'editor');
  const adopted=await f.service.confirm(f.draftId,{...input,plan_hash:plan.plan_hash,confirmed:true,idempotency_key:'cover_geometry_resume_001'},'editor');
  assert.equal(adopted.state,'waiting_attention');
  const audit=await auditDraftCover(f.db,f.draftId);
  const geometry={visual_id:f.visualId,expected_revision:2,expected_fingerprint:audit.input_fingerprint,master_hash:f.hash,
    safe_region:{x:.4,y:.4,width:.2,height:.2},focal_point:{x:.5,y:.5},locked:true,quality_confirmed:true};
  const preview=await previewCoverSelection(f.db,f.draftId,geometry,{outputDir:f.directory});
  await saveCoverSelection(f.db,f.draftId,{...geometry,confirmed:true,preview_hash:preview.derivative.sha256},{outputDir:f.directory});
  const ready=await f.service.resume(f.draftId,adopted.id,'editor');
  assert.equal(ready.state,'local_ready');assert.equal(ready.media_revision,1);
  assert.deepEqual(f.db.prepare('SELECT * FROM article_drafts WHERE id=?').get(f.draftId),before);
  assert.equal(f.db.prepare('SELECT count(*) n FROM model_call_metrics').get().n,0);
  fs.writeFileSync(preview.derivative.localPath,'corrupt receipt');
  assert.equal((await f.service.resume(f.draftId,adopted.id,'editor')).items[0].state,'COVER_DERIVATIVE_INVALID');
  const replacement=await upload(f),next=request(f,replacement);next.expected_media_revision=1;
  next.selections[0].purpose='cover';next.selections[0].replace_selection_id=adopted.id;
  const nextPlan=f.service.plan(f.draftId,next,'editor');
  const replaced=await f.service.confirm(f.draftId,{...next,plan_hash:nextPlan.plan_hash,confirmed:true,idempotency_key:'cover_replacement_stage03'},'editor');
  assert.equal(replaced.state,'waiting_attention');assert.equal(readCoverSelection(f.db,f.draftId),null,
    'replacing the mother invalidates its old geometry and delivery selection; history remains');
  assert.equal(JSON.parse(f.db.prepare('SELECT media_metadata_json FROM article_visuals WHERE id=?').get(f.visualId).media_metadata_json).cover_selections.length,1);
});

test('T03-31 one confirmation of a body photo and separate cover waits only for cover geometry',async t=>{
  const f=await fixture(t),body=await upload(f),cover=await upload(f),input=request(f,body);
  const coverChoice={...input.selections[0],upload_id:cover.id,purpose:'cover'};delete coverChoice.slot_id;
  input.selections.push(coverChoice);
  const before=f.db.prepare('SELECT * FROM article_drafts WHERE id=?').get(f.draftId);
  const plan=f.service.plan(f.draftId,input,'editor');
  const adopted=await f.service.confirm(f.draftId,{...input,plan_hash:plan.plan_hash,confirmed:true,idempotency_key:'body_cover_combined_stage03'},'editor');
  assert.equal(adopted.state,'waiting_attention');
  assert.equal(adopted.items.find(item=>item.slot_id===f.visualId).state,'ready');
  const coverSlot=plan.selections.find(s=>s.purpose==='cover').slot_id;
  const audit=await auditDraftCover(f.db,f.draftId);
  const geometry={visual_id:coverSlot,expected_revision:2,expected_fingerprint:audit.input_fingerprint,master_hash:f.hash,
    safe_region:{x:.4,y:.4,width:.2,height:.2},focal_point:{x:.5,y:.5},locked:true,quality_confirmed:true};
  const preview=await previewCoverSelection(f.db,f.draftId,geometry,{outputDir:f.directory});
  await saveCoverSelection(f.db,f.draftId,{...geometry,confirmed:true,preview_hash:preview.derivative.sha256},{outputDir:f.directory});
  const ready=await f.service.resume(f.draftId,adopted.id,'editor');assert.equal(ready.state,'local_ready');
  assert.ok(ready.items.every(item=>item.state==='ready'));assert.equal(ready.media_revision,1);
  assert.equal(mediaManifestForDraft(f.db,f.draftId).slots.length,1,'independent cover is not forced into the body');
  assert.equal(articleMediaDeliveryPlan(f.db,f.draftId).ready,true);
  assert.deepEqual(f.db.prepare('SELECT * FROM article_drafts WHERE id=?').get(f.draftId),before);
  assert.equal(f.db.prepare('SELECT count(*) n FROM model_call_metrics').get().n,0);
});

test('display capacity rejects adoption with exact excess while preserving stored originals',async t=>{
  const f=await fixture(t),u=await upload(f);
  const original=f.db.prepare('SELECT * FROM article_visuals WHERE id=?').get(f.visualId),columns=Object.keys(original);
  const insert=f.db.prepare(`INSERT INTO article_visuals(${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);
  for(let i=1;i<200;i++){const row={...original,id:`capacity_${i}`,slot:i+1};insert.run(...columns.map(key=>row[key]));}
  const input=request(f,u);delete input.selections[0].slot_id;
  const plan=f.service.plan(f.draftId,input,'editor');assert.deepEqual([plan.capacity.displayed,plan.capacity.maximum,plan.capacity.excess],[201,200,1]);
  await assert.rejects(f.service.confirm(f.draftId,{...input,confirmed:true,plan_hash:plan.plan_hash,idempotency_key:'capacity_test_0001'},'editor'),{code:'MEDIA_CONTRACT_CAPACITY_EXCEEDED'});
  assert.equal((await f.service.status(f.draftId,u.id,'editor')).asset_id,u.asset_id);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM article_media_revisions').get().n,0);
});

test('manual photo confirm preserves body, old media, manifest and budget; resume and duplicate are idempotent',async t=>{
  const f=await fixture(t),before=f.db.prepare('SELECT * FROM article_drafts').get();freezeRequiredMediaManifest(f.db,f.draftId);
  const u=await upload(f);assert.equal(u.state,'pending_confirmation');assert.equal((await f.service.complete(f.draftId,u.id,'editor')).asset_id,u.asset_id);
  const input=request(f,u),plan=f.service.plan(f.draftId,input,'editor');
  const confirmed={...input,confirmed:true,plan_hash:plan.plan_hash,idempotency_key:'manual_photo_test_001'};
  const result=await f.service.confirm(f.draftId,confirmed,'editor');assert.equal(result.state,'local_ready',JSON.stringify(f.db.prepare('SELECT last_error FROM article_visuals').all()));assert.equal(result.provider_calls,0);
  assert.deepEqual(f.db.prepare('SELECT * FROM article_drafts').get(),before);
  assert.equal((await f.service.confirm(f.draftId,confirmed,'editor')).id,result.id);
  assert.equal((await f.service.resume(f.draftId,result.id,'editor')).state,'local_ready');
  const row=f.db.prepare('SELECT * FROM article_visuals WHERE id=?').get(f.visualId),metadata=JSON.parse(row.media_metadata_json);
  assert.equal(metadata.manual_article_history[0].row.media_path,f.master);assert.equal(fs.readFileSync(f.master).equals(f.bytes),true);
  assert.equal(metadata.quality_qa,null);assert.equal(metadata.manual_local_receipt.provider_calls,0);
  assert.equal(mediaManifestForDraft(f.db,f.draftId).mediaRevision,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM required_media_manifests').get().n,1);
  assert.throws(()=>f.repository.saveGeneratedVisual(f.visualId,{mediaPath:'late'}),{code:'MANUAL_MEDIA_LOCKED'});
  f.repository.failVisual(f.visualId,new Error('Late worker failure'));assert.equal(f.db.prepare('SELECT status FROM article_visuals WHERE id=?').get(f.visualId).status,'generated');
  assert.throws(()=>f.repository.saveWordPressVisual(f.visualId,{id:999,url:'https://example.org/late.webp',metadata:{}}),{code:'STALE_VISUAL_RESULT'});
  assert.equal(evaluatePublicationEligibility(f.db,f.draftId).passed,true);
  f.repository.replaceDraftVisuals(f.draftId,[],'3.9');assert.equal(f.db.prepare('SELECT id FROM article_visuals WHERE id=?').get(f.visualId).id,f.visualId);
});

// 2026-09-30 (Three Gorges Museum): a bounded QA repair bumped the draft revision
// and the adopted operator photo stopped counting, failing MEDIA_INCOMPLETE.
test('an adopted operator photo survives a text-only revision bump of the same slot',async t=>{
  const f=await fixture(t);freezeRequiredMediaManifest(f.db,f.draftId);
  const u=await upload(f);await f.service.complete(f.draftId,u.id,'editor');
  const input=request(f,u),plan=f.service.plan(f.draftId,input,'editor');
  await f.service.confirm(f.draftId,{...input,confirmed:true,plan_hash:plan.plan_hash,idempotency_key:'manual_photo_revision_bump'},'editor');
  assert.equal(evaluatePublicationEligibility(f.db,f.draftId).passed,true);
  f.db.prepare("UPDATE article_drafts SET revision=revision+1,content_hash='repaired-text-hash'").run();
  freezeRequiredMediaManifest(f.db,f.draftId);
  const after=evaluatePublicationEligibility(f.db,f.draftId);
  assert.equal(after.passed,true,JSON.stringify(after.missing || after));
  // A different slot row never inherits the adoption.
  const row=f.db.prepare('SELECT media_metadata_json FROM article_visuals WHERE id=?').get(f.visualId);
  const metadata=JSON.parse(row.media_metadata_json);metadata.manual_article_selection.slot_id='visual_other_slot';
  f.db.prepare('UPDATE article_visuals SET media_metadata_json=? WHERE id=?').run(JSON.stringify(metadata),f.visualId);
  assert.equal(evaluatePublicationEligibility(f.db,f.draftId).passed,false);
});

test('paused chunks and adopted originals survive cross-directory backup; restore requires fresh admin and never executes',async t=>{
  const f=await fixture(t),u=await upload(f),input=request(f,u),plan=f.service.plan(f.draftId,input,'editor');
  await f.service.confirm(f.draftId,{...input,confirmed:true,plan_hash:plan.plan_hash,idempotency_key:'manual_backup_test_01'},'editor');
  const paused=await f.service.create(f.draftId,{expected_revision:2,name:'paused.png',mimeType:'image/png',size:f.bytes.length,sha256:f.hash},'editor');
  await f.service.chunk(f.draftId,paused.id,0,f.bytes,'editor',f.hash);f.service.state(f.draftId,paused.id,'editor','paused');
  const backup=createBackup({databasePath:path.join(f.directory,'test.sqlite'),backupDir:path.join(f.directory,'backups'),generatedMediaDir:f.config.mediaDir,sourceUploadsDir:f.config.captureMediaUploads.storageDir});
  const restored=restoreBackup(backup.backupPath,path.join(f.directory,'restored')),db=openDatabase(restored.databasePath,{migrate:false});
  try{const repository=new Repository(db),config={mediaDir:path.join(f.directory,'restored','media'),captureMediaUploads:{uploadDir:path.join(f.directory,'restored','uploads'),storageDir:path.join(f.directory,'restored','source-uploads')}};
    const service=new ArticleMediaService(repository,config);
    await assert.rejects(service.status(f.draftId,paused.id,'another'),{code:'UPLOAD_OWNER_MISMATCH'});
    const status=await service.status(f.draftId,paused.id,'editor');assert.deepEqual(status.progress.receivedChunks,[0]);
    assert.equal((await service.complete(f.draftId,paused.id,'editor')).state,'pending_confirmation');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM model_call_metrics').get().n,0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM jobs WHERE status=\'running\'').get().n,0);
    const row=db.prepare('SELECT media_metadata_json FROM article_visuals WHERE id=?').get(f.visualId),metadata=JSON.parse(row.media_metadata_json);
    assert.equal(mediaHash(fs.readFileSync(metadata.manual_local_receipt.derivative.localPath)),metadata.manual_local_receipt.derivative.sha256);
    assert.equal((await service.status(f.draftId,u.id,'editor')).receipt.sha256,f.hash);
    assert.equal(mediaHash(fs.readFileSync(service.previewFile(f.draftId,u.id,'editor'))),f.hash);
  }finally{db.close();}
});

test('explicit revocation restores old slot exactly with an appended revision and no provider work',async t=>{
  const f=await fixture(t),old=f.db.prepare('SELECT * FROM article_visuals WHERE id=?').get(f.visualId);freezeRequiredMediaManifest(f.db,f.draftId);
  const u=await upload(f),input=request(f,u),plan=f.service.plan(f.draftId,input,'editor');
  const adopted=await f.service.confirm(f.draftId,{...input,confirmed:true,plan_hash:plan.plan_hash,idempotency_key:'revoke_photo_test_01'},'editor');
  const state=f.service.list(f.draftId,'editor');const requestRevoke={selection_id:adopted.id,expected_revision:2,expected_media_revision:1,fingerprint:state.fingerprint,reason:'Restore original choice',confirmed:true};
  const result=await f.service.revoke(f.draftId,requestRevoke,'editor');assert.equal(result.state,'revoked');assert.equal(result.media_revision,2);
  assert.equal((await f.service.revoke(f.draftId,requestRevoke,'editor')).id,result.id);
  assert.deepEqual(f.db.prepare('SELECT * FROM article_visuals WHERE id=?').get(f.visualId),old);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM article_media_revisions').get().n,2);assert.equal(mediaManifestForDraft(f.db,f.draftId).mediaRevision,2);
  assert.equal((await f.service.resume(f.draftId,result.id,'editor')).state,'revoked');
});

test('text recovery uses the same selected slot only when explicitly enabled outside development; completed QA is reused',async t=>{
  const f=await fixture(t),u=await upload(f),input=request(f,u);input.selections[0].kind='text';
  const before=f.db.prepare('SELECT body_markdown,revision,content_hash FROM article_drafts').get();let calls=0;
  const provider={enabled:true,localizeSourceImage:async visual=>{calls++;assert.equal(visual.id,f.visualId);assert.equal(visual.acquisition_strategy,'localize_source_image');
    const filename=path.join(f.directory,'controlled-translated.png');fs.writeFileSync(filename,f.bytes);
    return {mediaPath:filename,mediaUrl:'/media/controlled-translated.png',metadata:{quality_qa:{status:'passed',file_hash:f.hash},binary_qa:{status:'passed',sha256:f.hash}}};}};
  f.service.provider=provider;
  const plan=f.service.plan(f.draftId,input,'editor');const pending=await f.service.confirm(f.draftId,{...input,confirmed:true,plan_hash:plan.plan_hash,idempotency_key:'provider_gate_test_01'},'editor');
  assert.equal(calls,0);assert.equal(pending.items[0].state,'WAITING_AUTH');
  const enabled=new ArticleMediaService(f.repository,{...f.config,manualMediaProviderRecoveryEnabled:true,deployment:{environment:'production',runMode:''}});enabled.provider=provider;
  assert.equal((await enabled.resume(f.draftId,pending.id,'editor')).items[0].state,'ready');assert.equal(calls,1);
  assert.equal((await enabled.resume(f.draftId,pending.id,'editor')).items[0].state,'ready');assert.equal(calls,1);
  assert.deepEqual(f.db.prepare('SELECT body_markdown,revision,content_hash FROM article_drafts').get(),before);
  const review=new ArticleMediaService(f.repository,{...f.config,manualMediaProviderRecoveryEnabled:true,deployment:{environment:'production',runMode:'migration-review'}});
  assert.equal(review.providerAllowed(),false);
});

test('media-only receiver protocol retains old receipts and reconciles unknown outcomes without duplicate upload',async t=>{
  const f=await fixture(t),u=await upload(f),input=request(f,u),plan=f.service.plan(f.draftId,input,'editor');
  await f.service.confirm(f.draftId,{...input,confirmed:true,plan_hash:plan.plan_hash,idempotency_key:'delivery_protocol_01'},'editor');
  const registry={},page={properties:{metadata:{properties:{featuredMediaId:{}}}}},publish={},checksum=mediaHash(JSON.stringify([registry,page,publish]));
  f.db.prepare(`INSERT INTO frontend_contract_snapshots(id,source_repository,registry_source,page_schema_source,frontend_commit_sha,contract_version,schema_version,checksum,registry_json,page_schema_json,status,synced_at,publish_package_schema_json,artifact_checksum)
    VALUES ('fixed','fixture','fixture','fixture',?,'fixture','fixture',?,?,?,'active','now',?,?)`).run('a'.repeat(40),checksum,JSON.stringify(registry),JSON.stringify(page),JSON.stringify(publish),checksum);
  f.db.prepare("UPDATE frontend_contract_state SET active_snapshot_id='fixed'").run();
  f.db.prepare(`INSERT INTO wordpress_publications(id,draft_id,site_url,post_id,status,created_at,updated_at,response_json)
    VALUES ('wp',?,'https://receiver.invalid',123,'synced','now','now',?)`).run(f.draftId,JSON.stringify({status:'draft',page_payload_hash:'b'.repeat(64),modified_gmt:'2026-09-28T00:00:00'}));
  const before=f.db.prepare('SELECT * FROM wordpress_publications').get(),delivery=articleMediaDeliveryPlan(f.db,f.draftId);assert.equal(delivery.ready,true);
  let writes=0,reconciles=0,receipt;
  const receiver={verifiedCapabilities:async()=>({body_media_only:true,compare_and_swap:true,idempotency_reconciliation:true,site_url:delivery.site_url,contract_hash:checksum,contract_commit:'a'.repeat(40)}),
    refreshMedia:async request=>{writes++;const media=[];for await(const asset of request.assets){const chunks=[];for await(const part of asset.stream)chunks.push(part);assert.equal(mediaHash(Buffer.concat(chunks)),asset.derivative.sha256);
      media.push({slot_id:asset.slot_id,media_id:789,url:'https://media.example.org/verified.webp',upload_hash:asset.derivative.sha256,width:1600,height:1000,mime:'image/webp'});}
      receipt={idempotency_key:request.idempotency_key,post_id:123,cms_draft_id:f.draftId,cms_revision:2,prior_page_hash:delivery.prior_page_hash,protected_content_hash:delivery.protected_content_hash,
        page_payload_hash:'c'.repeat(64),modified_gmt:'2026-09-28T01:00:00',media};throw new Error('Simulated response lost');},reconcile:async()=>{reconciles++;return receipt;}};
  const options={receiver,authorization:{mode:'release',scope:'body_media_only'},expectedPlanHash:delivery.plan_hash,outputDir:f.config.mediaDir};
  await assert.rejects(deliverArticleMedia(f.db,f.draftId,{...options,authorization:{mode:'development'}}),{code:'MEDIA_DELIVERY_NOT_AUTHORIZED'});assert.equal(writes,0);
  await assert.rejects(deliverArticleMedia(f.db,f.draftId,options),{code:'MEDIA_DELIVERY_OUTCOME_UNKNOWN'});
  assert.equal((await deliverArticleMedia(f.db,f.draftId,options)).state,'confirmed');assert.equal(writes,1);assert.equal(reconciles,1);
  assert.equal((await deliverArticleMedia(f.db,f.draftId,options)).state,'confirmed');assert.equal(writes,1);
  assert.deepEqual(f.db.prepare('SELECT * FROM wordpress_publications').get(),before);
  assert.equal(f.db.prepare('SELECT wordpress_media_id FROM article_visuals WHERE id=?').get(f.visualId).wordpress_media_id,789);
});

test('manual cover remains separate from body and exposes an eligible geometry candidate',async t=>{
  const f=await fixture(t),u=await upload(f),input=request(f,u);input.selections[0].purpose='cover';delete input.selections[0].slot_id;
  const before=f.db.prepare('SELECT * FROM article_visuals WHERE id=?').get(f.visualId),plan=f.service.plan(f.draftId,input,'editor');
  const result=await f.service.confirm(f.draftId,{...input,confirmed:true,plan_hash:plan.plan_hash,idempotency_key:'manual_cover_test_01'},'editor');
  assert.equal(result.items[0].state,'COVER_GEOMETRY_REQUIRED');assert.deepEqual(f.db.prepare('SELECT * FROM article_visuals WHERE id=?').get(f.visualId),before);
  assert.equal(f.repository.listDraftVisuals(f.draftId).length,1);
  const candidate=(await auditDraftCover(f.db,f.draftId)).candidates.find(c=>c.id!==f.visualId);
  assert.deepEqual(candidate.reasons,['COVER_SUBJECT_CONFIRMATION_REQUIRED']);assert.equal(candidate.qa_basis,'confirmed_article_photo_local_checks');
});

test('101 actual sessions finish and paginate without count limit; fresh manager resumes server chunks',async t=>{
  const f=await fixture(t);for(let i=0;i<101;i++){const u=await upload(f);assert.equal(u.state,'pending_confirmation');}
  const ids=[];for(let offset=0;offset<101;offset+=25){const page=f.service.list(f.draftId,'editor',{offset});assert.equal(page.total,101);ids.push(...page.items.map(x=>x.id));}
  assert.equal(new Set(ids).size,101);
  const restored=new ArticleMediaService(f.repository,f.config);assert.equal((await restored.status(f.draftId,ids[0],'editor')).receipt.sha256,f.hash);
  assert.throws(()=>restored.list(f.draftId,'editor',{offset:-1}),{code:'INVALID_PAGE'});
  await assert.rejects(restored.status(f.draftId,ids[0],'another'),{code:'UPLOAD_OWNER_MISMATCH'});
});

test('stale revision, bad hash, missing chunk, plan mutation and non-photo awaiting auth are explicit',async t=>{
  const f=await fixture(t);
  const created=await f.service.create(f.draftId,{expected_revision:2,name:'a.png',mimeType:'image/png',size:f.bytes.length,sha256:f.hash},'editor');
  await assert.rejects(f.service.chunk(f.draftId,created.id,0,f.bytes,'editor','bad'),{code:'CHUNK_HASH_MISMATCH'});
  await assert.rejects(f.service.complete(f.draftId,created.id,'editor'),{code:'MEDIA_UPLOAD_INCOMPLETE'});
  await f.service.chunk(f.draftId,created.id,0,f.bytes,'editor',f.hash);
  const u=await f.service.complete(f.draftId,created.id,'editor'),input=request(f,u);
  input.selections[0].kind='text';const plan=f.service.plan(f.draftId,input,'editor');assert.equal(plan.steps[0].status,'WAITING_AUTH');
  await assert.rejects(f.service.confirm(f.draftId,{...input,confirmed:true,plan_hash:'bad',idempotency_key:'manual_photo_test_002'},'editor'),{code:'MEDIA_PLAN_STALE'});
  const result=await f.service.confirm(f.draftId,{...input,confirmed:true,plan_hash:plan.plan_hash,idempotency_key:'manual_photo_test_002'},'editor');
  assert.equal(result.state,'waiting_attention');assert.equal(result.items[0].state,'WAITING_AUTH');
  f.db.prepare('UPDATE article_drafts SET revision=3').run();
  assert.equal((await f.service.resume(f.draftId,result.id,'editor')).items[0].state,'STALE');
});
