import test from 'node:test';
import assert from 'node:assert/strict';
import {repositoryFixture} from '../test-support/repository-fixture.mjs';
import {seedCoverFixture} from '../test-support/cover-fixture.mjs';
import {normalizeXiaohongshuCapture} from '../src/adapters/xiaohongshu.mjs';
import {coverInventory,importCoverSource,planCoverIllustration} from '../src/services/cover-inventory.mjs';
import {auditDraftCover} from '../src/services/cover-audit.mjs';
import {coverDeliveryBlocker} from '../src/services/cover-selection.mjs';

test('same-entity stored source becomes a separate cover candidate with real binding checks; illustration plan never dispatches',async t=>{
  const f=repositoryFixture(t),seed=await seedCoverFixture(f.repository,f.directory),db=f.db;
  const source=f.repository.saveCapture(normalizeXiaohongshuCapture({url:'https://www.xiaohongshu.com/explore/coverinventorytest',
    title:'Synthetic same-entity source',text:'Photo 1 depicts East Hall.',images:[{url:'https://sns-img.xhscdn.com/cover-inventory-test.png',alt:'East Hall fixture'}]}));
  const asset=db.prepare('SELECT id FROM source_assets WHERE source_id=?').get(source.id);
  db.prepare("UPDATE source_assets SET local_path=?,storage_status='saved',original_bytes_status='saved_original',durability_status='ORIGINAL_STORED',original_sha256=?,stored_sha256=? WHERE id=?").run(seed.master,seed.hash,seed.hash,asset.id);
  f.repository.saveSourceAssetAnalysis(asset.id,{analysis_status:'ready',asset_kind:'documentary_photo',primary_subjects:['Hall'],text_regions:[],photo_regions:[],entities:[],reader_text_present:false,confidence:.9,analysis_version:'media-analysis-2'});
  f.repository.refreshSourceMediaBindings(source.id,{dryRun:false});
  const inventory=coverInventory(db,seed.draftId);assert.equal(inventory.items.length,1,JSON.stringify({bindings:db.prepare('SELECT asset_id,destination_slug,status FROM media_bindings').all(),analyses:db.prepare('SELECT asset_id,source_sha256 FROM source_asset_analyses').all(),source:db.prepare('SELECT id,original_sha256 FROM current_source_assets').all()}));assert.equal(inventory.items[0].eligible,true);
  const created=importCoverSource(db,seed.draftId,{...inventory.items[0],expected_revision:2},'editor');
  const candidate=(await auditDraftCover(db,seed.draftId)).candidates.find(x=>x.id===created.visual_id);
  assert.deepEqual(candidate.reasons,['COVER_SUBJECT_CONFIRMATION_REQUIRED']);assert.ok(candidate.master_preview_url);
  assert.equal(f.repository.listDraftVisuals(seed.draftId).length,1);assert.equal(f.repository.listDraftVisualsForDelivery(seed.draftId).length,1);
  assert.equal(coverDeliveryBlocker(db,seed.draftId).code,'REQUIRED_COVER_MISSING');
  const calls=db.prepare('SELECT COUNT(*) n FROM model_call_metrics').get().n,jobs=db.prepare('SELECT COUNT(*) n FROM jobs').get().n;
  assert.throws(()=>planCoverIllustration(db,seed.draftId,{expected_revision:2,abstract_topic:'real-landmark'},'editor'),{code:'COVER_ILLUSTRATION_SCOPE_INVALID'});
  const result=planCoverIllustration(db,seed.draftId,{expected_revision:2,abstract_topic:'packing'},'editor');assert.equal(result.status,'WAITING_AUTH');
  assert.equal(planCoverIllustration(db,seed.draftId,{expected_revision:2,abstract_topic:'packing'},'editor').visual_id,result.visual_id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM jobs').get().n,jobs);assert.equal(db.prepare('SELECT COUNT(*) n FROM model_call_metrics').get().n,calls);
});
