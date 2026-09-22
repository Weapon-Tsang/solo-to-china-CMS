import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { repositoryFixture } from '../test-support/repository-fixture.mjs';
import { freezeRequiredMediaManifest, evaluatePublicationEligibility } from '../src/publication-eligibility.mjs';
import { assertPublicationEligibility } from '../src/publication-eligibility.mjs';
import { WordPressDraftAdapter } from '../src/wordpress.mjs';
import { recoverLegacyVisualReceipts } from '../src/services/legacy-visual-receipts.mjs';

function seed(t, count = 3) {
  const { db, directory, repository } = repositoryFixture(t);
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at)
    VALUES ('brief','beijing','Guide','travelers','informational','ready','2026-01-01','2026-01-01')`).run();
  db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at,revision,content_hash)
    VALUES ('draft','brief','Guide','guide','Body','{}','review','2026-01-01','2026-01-01',1,'body-hash')`).run();
  const insert = db.prepare(`INSERT INTO article_visuals(id,draft_id,slot,placement,purpose,alt_text,generation_prompt,
    aspect_ratio,status,created_at,updated_at,asset_fingerprint,image_type,image_role,acquisition_strategy,factual_image_required,media_metadata_json)
    VALUES (?, 'draft', ?, ?, 'Guide image', 'Beijing guide illustration', '', '16:9', ?, '2026-01-01', '2026-01-01', ?,
    'illustration', 'support', 'generate_illustration', 0, ?)`);
  for (let index = 1; index <= count; index += 1) {
    const bytes = Buffer.from(`image-${index}`);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const file = path.join(directory, `image-${index}.png`);
    fs.writeFileSync(file, bytes);
    const metadata = { binary_qa: { status:'passed', sha256:hash },
      quality_qa: { status:'passed', file_hash:hash } };
    insert.run(`visual-${index}`, index, index === 1 ? 'hero' : 'mid_article', index === 1 ? 'generated' : 'planned',
      `plan-${index}`, JSON.stringify(metadata));
    db.prepare('UPDATE article_visuals SET media_path=? WHERE id=?').run(file, `visual-${index}`);
  }
  return { db, directory, repository };
}

test('required nonfactual images keep the text and block delivery when two of three slots are missing', (t) => {
  const { db } = seed(t);
  const manifest = freezeRequiredMediaManifest(db, 'draft');
  assert.equal(manifest.minimumRequired, 3);
  const state = evaluatePublicationEligibility(db, 'draft');
  assert.equal(state.passed, false);
  assert.equal(state.code, 'MEDIA_INCOMPLETE');
  assert.equal(state.ready, 1);
  assert.equal(state.missing.length, 2);
  assert.equal(db.prepare('SELECT body_markdown FROM article_drafts WHERE id=?').get('draft').body_markdown, 'Body');
  db.prepare('DELETE FROM article_visuals WHERE draft_id=?').run('draft');
  assert.equal(evaluatePublicationEligibility(db, 'draft').passed, false, 'filtered empty media cannot pass');
});

test('manifest cannot be rewritten within one revision and missing manifest does not imply no-image approval', (t) => {
  const { db } = seed(t, 1);
  const first = freezeRequiredMediaManifest(db, 'draft');
  db.prepare("UPDATE article_visuals SET asset_fingerprint='changed' WHERE id='visual-1'").run();
  assert.equal(freezeRequiredMediaManifest(db, 'draft').manifestHash, first.manifestHash);
  assert.equal(evaluatePublicationEligibility(db, 'draft').passed, false);
  db.prepare("UPDATE article_drafts SET revision=revision+1 WHERE id='draft'").run();
  assert.equal(evaluatePublicationEligibility(db, 'draft').code, 'MEDIA_MANIFEST_MISSING_OR_STALE');
});

test('a cached article payload cannot bypass the latest database gate at WordPress upsert', async (t) => {
  const { db }=seed(t,1);
  freezeRequiredMediaManifest(db,'draft');
  assert.equal(evaluatePublicationEligibility(db,'draft').passed,true);
  const cached={title:'Guide',slug:'guide',body_markdown:'Body',visuals:[]};
  db.prepare("UPDATE article_drafts SET revision=revision+1,content_hash='new-hash' WHERE id='draft'").run();
  let remoteCalls=0;
  const adapter=new WordPressDraftAdapter({siteUrl:'https://site.test',username:'editor',applicationPassword:'app password'},
    async()=>{remoteCalls++;return Response.json({id:7,status:'draft'});});
  adapter.deliveryGuard=(draftId,options)=>assertPublicationEligibility(db,draftId,options);
  await assert.rejects(adapter.upsertDraft(cached,null,{draftId:'draft'}),{code:'MEDIA_MANIFEST_MISSING_OR_STALE'});
  assert.equal(remoteCalls,0);
});

test('a QA note identifying a place-name typo blocks publication despite four passed scores', (t) => {
  const { db } = seed(t, 1);
  freezeRequiredMediaManifest(db, 'draft');
  assert.equal(evaluatePublicationEligibility(db, 'draft').passed, true);
  const row = db.prepare("SELECT media_metadata_json FROM article_visuals WHERE id='visual-1'").get();
  const metadata = JSON.parse(row.media_metadata_json);
  metadata.quality_qa.notes = 'Jiafangbei contains a minor pinyin typo for Jiefangbei.';
  db.prepare("UPDATE article_visuals SET media_metadata_json=? WHERE id='visual-1'")
    .run(JSON.stringify(metadata));
  const state = evaluatePublicationEligibility(db, 'draft');
  assert.equal(state.passed, false);
  assert.ok(state.missing[0].reasons.includes('quality_qa_missing_or_stale'));
});

test('legacy successful image bytes and independent QA are rebound by SHA without another provider call', (t) => {
  const {db,directory}=seed(t,1);
  const bytes=fs.readFileSync(path.join(directory,'image-1.png'));
  const hash=crypto.createHash('sha256').update(bytes).digest('hex');
  const recovered=path.join(directory,'draft-01-stored.png');
  fs.writeFileSync(recovered,bytes);
  const qa=Object.fromEntries(['language','completeness','style','semantic']
    .map((field)=>[field,{status:'passed',reason:'Independent historical QA passed.'}]));
  db.prepare("UPDATE article_visuals SET media_path=NULL,status='planned',media_metadata_json=? WHERE id='visual-1'")
    .run(JSON.stringify({binary_qa:{status:'passed',sha256:hash},quality_qa:qa}));
  freezeRequiredMediaManifest(db,'draft');
  assert.equal(evaluatePublicationEligibility(db,'draft').passed,false);
  assert.deepEqual(recoverLegacyVisualReceipts(db,'draft',directory).map(({id})=>id),['visual-1']);
  assert.equal(recoverLegacyVisualReceipts(db,'draft',directory).length,0);
  assert.equal(evaluatePublicationEligibility(db,'draft').passed,true);
  const row=db.prepare("SELECT status,media_path,media_metadata_json FROM article_visuals WHERE id='visual-1'").get();
  assert.equal(row.status,'generated');
  assert.equal(row.media_path,recovered);
  assert.equal(JSON.parse(row.media_metadata_json).quality_qa.file_hash,hash);
});

test('legacy image recovery refuses failed and changed-plan visuals', (t) => {
  const {db,directory}=seed(t,1);
  const bytes=fs.readFileSync(path.join(directory,'image-1.png'));
  const hash=crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(directory,'draft-01-stored.png'),bytes);
  const qa=Object.fromEntries(['language','completeness','style','semantic']
    .map((field)=>[field,{status:'passed'}]));
  db.prepare("UPDATE article_visuals SET media_path=NULL,status='failed',media_metadata_json=? WHERE id='visual-1'")
    .run(JSON.stringify({binary_qa:{status:'passed',sha256:hash},quality_qa:qa}));
  freezeRequiredMediaManifest(db,'draft');
  assert.equal(recoverLegacyVisualReceipts(db,'draft',directory).length,0);
  db.prepare("UPDATE article_visuals SET status='planned',asset_fingerprint='changed' WHERE id='visual-1'").run();
  assert.equal(recoverLegacyVisualReceipts(db,'draft',directory).length,0);
});

test('a strategy 3.9 source photo requires its authoritative local audit, not visual metadata', (t) => {
  const { db, directory } = seed(t, 1);
  const file = path.join(directory, 'image-1.png');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  db.prepare(`INSERT INTO sources(id,adapter,canonical_url,captured_at,raw_text,raw_html,
    raw_payload_json,content_hash,created_at,updated_at)
    VALUES ('source','manual','https://example.test/source','now','text','html','{}','hash','now','now')`).run();
  db.prepare(`INSERT INTO source_assets(id,source_id,kind,remote_url,position,local_path,
    original_bytes_status,durability_status,original_sha256)
    VALUES ('asset','source','image','https://example.test/photo',0,?,'saved_original','ORIGINAL_STORED',?)`)
    .run(file, hash);
  db.prepare("UPDATE article_drafts SET strategy_version='3.9' WHERE id='draft'").run();
  const metadata = { local_photo_audit:{status:'eligible',sha256:hash,providerCalls:0},
    visual_decision:{action:'retain'},authorized_asset_match:{score:1} };
  db.prepare(`UPDATE article_visuals SET source_asset_id='asset',acquisition_strategy='use_authorized_source_image',
    factual_image_required=1,media_metadata_json=? WHERE id='visual-1'`).run(JSON.stringify(metadata));
  freezeRequiredMediaManifest(db, 'draft');
  assert.equal(evaluatePublicationEligibility(db, 'draft').passed, false);
  const audit = {status:'eligible',sha256:hash,providerCalls:0};
  db.prepare('UPDATE source_assets SET local_photo_audit_json=? WHERE id=?').run(JSON.stringify(audit),'asset');
  assert.equal(evaluatePublicationEligibility(db, 'draft').passed, true,
    JSON.stringify(evaluatePublicationEligibility(db, 'draft')));
  db.prepare("UPDATE source_assets SET local_photo_audit_json='{}' WHERE id='asset'").run();
  assert.equal(evaluatePublicationEligibility(db, 'draft').passed, false);
});

test('an older brief accepts an audited documentary original with authentic place signage after a prose revision', (t) => {
  const { db, directory } = seed(t, 1);
  const file = path.join(directory, 'image-1.png');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  db.prepare(`INSERT INTO sources(id,adapter,canonical_url,captured_at,raw_text,raw_html,
    raw_payload_json,content_hash,created_at,updated_at)
    VALUES ('sign-source','manual','https://example.test/ciqikou','now','text','html','{}','hash','now','now')`).run();
  db.prepare(`INSERT INTO source_assets(id,source_id,kind,remote_url,position,local_path,
    original_bytes_status,durability_status,original_sha256,local_photo_audit_json)
    VALUES ('sign-photo','sign-source','image','https://example.test/ciqikou.jpg',0,?,
      'saved_original','ORIGINAL_STORED',?,?)`).run(file,hash,
      JSON.stringify({ status:'eligible', sha256:hash, providerCalls:0 }));
  db.prepare("UPDATE article_drafts SET strategy_version='3.7',revision=2 WHERE id='draft'").run();
  db.prepare(`UPDATE article_visuals SET source_asset_id='sign-photo',
    acquisition_strategy='use_authorized_source_image',factual_image_required=1,
    media_metadata_json=? WHERE id='visual-1'`).run(JSON.stringify({
      source_analysis:{analysis_status:'ready',asset_kind:'documentary_photo',reader_text_present:true,
        text_regions:[{role:'real_world_signage',text:'迎龙门'}]},
      visual_decision:{action:'retain'},authorized_asset_match:{score:0.83},
    }));
  freezeRequiredMediaManifest(db, 'draft');
  assert.equal(evaluatePublicationEligibility(db, 'draft').passed, true,
    JSON.stringify(evaluatePublicationEligibility(db, 'draft')));
  db.prepare("UPDATE source_assets SET local_photo_audit_json='{}' WHERE id='sign-photo'").run();
  assert.equal(evaluatePublicationEligibility(db, 'draft').passed, false,
    'authentic signage alone never waives the authoritative pixel audit');
});

test('historical refresh plans removal of an optional original that fails the new audit', (t) => {
  const { db, directory, repository }=seed(t,1);
  const file=path.join(directory,'image-1.png');
  const hash=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  db.prepare(`INSERT INTO sources(id,adapter,canonical_url,captured_at,raw_text,raw_html,
    raw_payload_json,content_hash,created_at,updated_at)
    VALUES ('old-source','manual','https://example.test/old','now','text','html','{}','hash','now','now')`).run();
  db.prepare(`INSERT INTO source_assets(id,source_id,kind,remote_url,position,local_path,
    original_bytes_status,durability_status,original_sha256,local_photo_audit_json)
    VALUES ('old-photo','old-source','image','https://example.test/old-photo',0,?,
    'saved_original','ORIGINAL_STORED',?,?)`).run(file,hash,
      JSON.stringify({status:'needs_review',sha256:hash,reasons:['chinese_text_dense']}));
  db.prepare("UPDATE article_drafts SET strategy_version='3.8' WHERE id='draft'").run();
  db.prepare(`UPDATE article_visuals SET source_asset_id='old-photo',image_type='real_world_photo',
    acquisition_strategy='use_authorized_source_image',status='generated',factual_image_required=0
    WHERE id='visual-1'`).run();
  const plan=repository.mediaRepairPlan('draft',{strategyVersion:'3.9'});
  assert.equal(plan.slots.length,1);
  assert.equal(plan.slots[0].disposition,'remove');
  assert.equal(plan.slots[0].reason,'visual_not_qualified_under_current_strategy');
});
