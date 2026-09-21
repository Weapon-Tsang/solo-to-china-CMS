import assert from 'node:assert/strict';
import test from 'node:test';
import { repositoryFixture } from '../test-support/repository-fixture.mjs';

test('an article may checkpoint analysis for its frozen historical source asset', (t) => {
  const {db,repository}=repositoryFixture(t);
  db.prepare(`INSERT INTO sources(id,adapter,canonical_url,captured_at,raw_text,raw_html,
    raw_payload_json,content_hash,capture_version,created_at,updated_at)
    VALUES ('source','manual','https://example.test/source','now','text','html','{}','hash',3,'now','now')`).run();
  db.prepare(`INSERT INTO source_assets(id,source_id,kind,remote_url,position,local_path,
    capture_version,original_bytes_status,durability_status,original_sha256)
    VALUES ('old-asset','source','image','https://example.test/old.png',0,'/stored/old.png',
    2,'saved_original','ORIGINAL_STORED',?)`).run('a'.repeat(64));
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at)
    VALUES ('brief','chongqing','Guide','travelers','informational','ready','now','now')`).run();
  db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,
    status,created_at,updated_at,revision,content_hash)
    VALUES ('draft','brief','Guide','guide','Body','{}','needs_review','now','now',1,'hash')`).run();
  db.prepare(`INSERT INTO article_visuals(id,draft_id,slot,placement,purpose,alt_text,generation_prompt,
    aspect_ratio,status,created_at,updated_at,asset_fingerprint,image_type,image_role,
    acquisition_strategy,factual_image_required,source_asset_id,media_metadata_json)
    VALUES ('visual','draft',1,'hero','Guide image','Guide image','','16:9','planned','now','now',
    'plan-hash','infographic','hero','analyze_source_image',1,'old-asset','{}')`).run();
  const analysis={analysis_status:'ready',asset_kind:'editorial_infographic',reader_text_present:true,
    text_regions:[{region_id:'title',text:'重庆',role:'author_overlay',language:'zh',readable:true,preserve:false}],
    analysis_version:'media-analysis-2'};
  assert.equal(repository.saveSourceAssetAnalysis('old-asset',analysis),false,
    'ordinary current-capture source processing must not write historical analysis');
  assert.equal(repository.saveSourceAssetAnalysis('old-asset',analysis,{forVisualId:'visual'}),true);
  assert.equal(db.prepare("SELECT capture_version,analysis_status FROM source_asset_analyses WHERE asset_id='old-asset'")
    .get().capture_version,2);
  db.prepare("UPDATE article_visuals SET status='failed' WHERE id='visual'").run();
  assert.equal(repository.saveSourceAssetAnalysis('old-asset',analysis,{forVisualId:'visual'}),false,
    'a failed visual cannot buy or accept a new historical analysis checkpoint');
});
