import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import sharp from 'sharp';
import {repositoryFixture} from '../test-support/repository-fixture.mjs';
import {seedCoverFixture} from '../test-support/cover-fixture.mjs';
import {auditDraftCover} from '../src/services/cover-audit.mjs';
import {previewCoverSelection,saveCoverSelection,readCoverSelection,coverDeliveryBlocker} from '../src/services/cover-selection.mjs';
import {mediaHash} from '../src/web-media.mjs';
import {Pipeline} from '../src/pipeline.mjs';
import path from 'node:path';
import {createBackup,restoreBackup} from '../src/backup.mjs';
import {openDatabase} from '../src/db.mjs';
import {evaluateCoverCandidate} from '../src/cover-policy.mjs';
import {renderCoverMedia} from '../src/cover-media.mjs';

test('actual cover output normalizes EXIF, preserves alpha and never enlarges small images',async t=>{
  const {directory}=repositoryFixture(t);
  for(const [width,height,orientation,expected] of [[800,1200,6,[1200,675]],[400,800,1,[400,225]]]) {
    const bytes=await sharp({create:{width,height,channels:4,background:'#22554477'}}).withMetadata({orientation}).png().toBuffer();
    const hash=mediaHash(bytes),candidate=evaluateCoverCandidate({id:'test',masterHash:hash,qa:{file_hash:hash,
      ...Object.fromEntries(['language','completeness','style','semantic'].map(k=>[k,{status:'passed'}]))},
      width:orientation===6?height:width,height:orientation===6?width:height,relationshipVerified:true,
      analysis:{analysis_status:'ready',asset_kind:'documentary_photo'},
      geometry:{safeRegion:{x:0.45,y:0.45,width:0.1,height:0.1},focalPoint:{x:0.5,y:0.5},qualityConfirmed:true}});
    const result=await renderCoverMedia({bytes,candidate,outputDir:directory}),meta=await sharp(result.localPath).metadata();
    assert.deepEqual([meta.width,meta.height],expected);assert.equal(meta.hasAlpha,true);
    for(const key of ['exif','xmp','iptc','icc'])assert.equal(meta[key],undefined);
    assert.equal(mediaHash(bytes),hash);assert.equal(result.parent_hash,hash);
    assert.equal((await renderCoverMedia({bytes,candidate,outputDir:directory})).reused,true);
  }
});

const inputFor=(seed,audit)=>({visual_id:seed.visualId,expected_revision:2,expected_fingerprint:audit.input_fingerprint,
  master_hash:seed.hash,safe_region:{x:0.4,y:0.4,width:0.2,height:0.2},focal_point:{x:0.5,y:0.5},locked:true});

test('real cover pixels, explicit preview confirmation, CAS, history and body preservation',async t=>{
  const {db,directory,repository}=repositoryFixture(t),seed=await seedCoverFixture(repository,directory);
  const before=db.prepare('SELECT * FROM article_drafts').all(),bodyVisual=db.prepare('SELECT media_path,media_url FROM article_visuals').get();
  const audit=await auditDraftCover(db,seed.draftId),input=inputFor(seed,audit),options={outputDir:directory};
  const preview=await previewCoverSelection(db,seed.draftId,input,options);
  const info=await sharp(preview.derivative.localPath).metadata();assert.deepEqual([info.width,info.height],[1200,675]);
  assert.equal(mediaHash(fs.readFileSync(seed.master)),seed.hash);assert.equal(readCoverSelection(db,seed.draftId),null);
  await assert.rejects(saveCoverSelection(db,seed.draftId,input,options),{code:'COVER_PREVIEW_CONFIRMATION_REQUIRED'});
  await assert.rejects(saveCoverSelection(db,seed.draftId,{...input,confirmed:true,preview_hash:'stale'},options),{code:'COVER_PREVIEW_STALE'});
  const selection=await saveCoverSelection(db,seed.draftId,{...input,confirmed:true,preview_hash:preview.derivative.sha256},options);
  assert.equal(readCoverSelection(db,seed.draftId).id,selection.id);assert.equal(selection.derivative.parent_hash,seed.hash);
  assert.deepEqual(db.prepare('SELECT * FROM article_drafts').all(),before);
  assert.deepEqual(db.prepare('SELECT media_path,media_url FROM article_visuals').get(),bodyVisual);
  await assert.rejects(saveCoverSelection(db,seed.draftId,{...input,confirmed:true,preview_hash:preview.derivative.sha256},options),{code:'COVER_REVISION_CONFLICT'});
  const next={...input,expected_fingerprint:(await auditDraftCover(db,seed.draftId)).input_fingerprint,
    expected_selection_id:selection.id,locked:false,confirmed:true,preview_hash:preview.derivative.sha256};
  const unlocked=await saveCoverSelection(db,seed.draftId,next,options);
  assert.notEqual(unlocked.id,selection.id);assert.equal(readCoverSelection(db,seed.draftId).locked,false);
  const metadata=JSON.parse(db.prepare('SELECT media_metadata_json FROM article_visuals').get().media_metadata_json);
  assert.equal(metadata.cover_selections.length,2);assert.equal(metadata.cover_selections[0].id,selection.id);
  assert.equal(db.prepare('SELECT count(*) n FROM model_call_metrics').get().n,0);
  assert.equal(coverDeliveryBlocker(db,seed.draftId).code,'COVER_RECEIVER_CAPABILITY_UNVERIFIED');
  let uploads=0;const pipeline=new Pipeline(repository,{enabled:false},{wordpress:{enabled:true,resolveVisualMedia:async()=>{uploads++;return [];}}});
  await assert.rejects(pipeline.uploadVisualMedia({draft:{id:seed.draftId}}),{code:'COVER_RECEIVER_CAPABILITY_UNVERIFIED'});
  assert.equal(uploads,0);
});

test('unsafe geometry, stale source relation and concurrent confirmations cannot save a cover',async t=>{
  const {db,directory,repository}=repositoryFixture(t),seed=await seedCoverFixture(repository,directory);
  const input=inputFor(seed,await auditDraftCover(db,seed.draftId)),options={outputDir:directory};
  await assert.rejects(previewCoverSelection(db,seed.draftId,{...input,safe_region:{x:0,y:0,width:1,height:1}},options),{code:'COVER_CANDIDATE_REJECTED'});
  const preview=await previewCoverSelection(db,seed.draftId,input,options);
  const results=await Promise.allSettled([1,2].map(()=>saveCoverSelection(db,seed.draftId,{...input,confirmed:true,preview_hash:preview.derivative.sha256},options)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  db.prepare("UPDATE sources SET raw_text='Photo 1 is not East Hall.' WHERE id=?").run(seed.sourceId);
  const fresh={...input,expected_fingerprint:(await auditDraftCover(db,seed.draftId)).input_fingerprint};
  await assert.rejects(previewCoverSelection(db,seed.draftId,fresh,options),{code:'COVER_CANDIDATE_REJECTED'});
});

test('retained original photo uses existing deterministic qualification without fabricating model QA',async t=>{
  const {db,directory,repository}=repositoryFixture(t),seed=await seedCoverFixture(repository,directory);
  db.prepare("UPDATE article_visuals SET acquisition_strategy='use_authorized_source_image',media_metadata_json=? WHERE id=?")
    .run(JSON.stringify({visual_decision:{action:'retain'}}),seed.visualId);
  const input=inputFor(seed,await auditDraftCover(db,seed.draftId));
  const preview=await previewCoverSelection(db,seed.draftId,input,{outputDir:directory});
  assert.equal(preview.derivative.qa_basis,'retained_source_checks');
  assert.equal(JSON.parse(db.prepare('SELECT media_metadata_json FROM article_visuals').get().media_metadata_json).quality_qa,undefined);
  assert.equal(db.prepare('SELECT count(*) n FROM model_call_metrics').get().n,0);
});

test('cover history files restore across directories, cleanup preserves references, and review does not dispatch',async t=>{
  const {db,directory,repository}=repositoryFixture(t),mediaDir=path.join(directory,'media');
  const seed=await seedCoverFixture(repository,mediaDir),input=inputFor(seed,await auditDraftCover(db,seed.draftId));
  const options={outputDir:mediaDir},preview=await previewCoverSelection(db,seed.draftId,input,options);
  const saved=await saveCoverSelection(db,seed.draftId,{...input,confirmed:true,preview_hash:preview.derivative.sha256},options);
  db.prepare('INSERT INTO source_delete_file_queue(path,queued_at) VALUES (?,?)').run(saved.derivative.localPath,'now');
  repository.cleanupDeletedSourceFiles();assert.equal(fs.existsSync(saved.derivative.localPath),true);
  const snapshot=createBackup({databasePath:path.join(directory,'test.sqlite'),backupDir:path.join(directory,'snapshots'),
    generatedMediaDir:mediaDir,sourceUploadsDir:path.join(directory,'source-images')});
  const restored=restoreBackup(snapshot.backupPath,path.join(directory,'restored'));
  const copy=openDatabase(restored.databasePath,{migrate:false});
  try {
    const selection=readCoverSelection(copy,seed.draftId);
    assert.equal(selection.id,saved.id);assert.equal(selection.locked,true);
    assert.notEqual(selection.derivative.localPath,saved.derivative.localPath);
    assert.equal(mediaHash(fs.readFileSync(selection.derivative.localPath)),saved.derivative.sha256);
    assert.equal(copy.prepare('SELECT count(*) n FROM jobs WHERE status=\'running\'').get().n,0);
    assert.equal(coverDeliveryBlocker(copy,seed.draftId).code,'COVER_RECEIVER_CAPABILITY_UNVERIFIED');
    assert.equal(copy.prepare('SELECT body_markdown FROM article_drafts').get().body_markdown,'This original body must not change.');
  } finally {copy.close();}
});
