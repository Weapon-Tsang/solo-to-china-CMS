import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { repositoryFixture } from '../test-support/repository-fixture.mjs';
import { freezeRequiredMediaManifest, evaluatePublicationEligibility } from '../src/publication-eligibility.mjs';
import { assertPublicationEligibility } from '../src/publication-eligibility.mjs';
import { WordPressDraftAdapter } from '../src/wordpress.mjs';

function seed(t, count = 3) {
  const { db, directory } = repositoryFixture(t);
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
  return { db, directory };
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
