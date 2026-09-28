import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {normalizeXiaohongshuCapture} from '../src/adapters/xiaohongshu.mjs';
import {mediaHash} from '../src/web-media.mjs';

export async function seedCoverFixture(repository,directory) {
  const db=repository.db;
  const bytes=await sharp({create:{width:1600,height:1000,channels:3,background:'#cbdfdc'}})
    .composite([{input:Buffer.from('<svg width="1600" height="1000"><rect x="640" y="400" width="320" height="200" fill="#39594e"/></svg>')}]).png().toBuffer();
  fs.mkdirSync(directory,{recursive:true});const master=path.join(directory,'cover-test-master.png');fs.writeFileSync(master,bytes);
  db.prepare(`INSERT INTO entity_aliases(id,destination_slug,alias_normalized,entity_key,canonical_subject,aliases_json,
    resolution_source,confidence,created_at,updated_at,entity_type,granularity)
    VALUES ('cover-hall','beijing','east hall','hall','East Hall','[]','manual',1,'now','now','attraction','specific_entity')`).run();
  const source=repository.saveCapture(normalizeXiaohongshuCapture({url:'https://www.xiaohongshu.com/explore/cover-selection-test',
    title:'Synthetic cover fixture',text:'Photo 1 depicts East Hall.',images:[{url:'https://sns-img.xhscdn.com/cover-selection-test.png',alt:'Synthetic Hall'}]}));
  const asset=db.prepare('SELECT id FROM source_assets WHERE source_id=?').get(source.id);
  db.prepare(`UPDATE source_assets SET local_path=?,storage_status='saved',original_bytes_status='saved_original',
    durability_status='ORIGINAL_STORED',original_sha256=?,stored_sha256=? WHERE id=?`).run(master,mediaHash(bytes),mediaHash(bytes),asset.id);
  repository.saveSourceAssetAnalysis(asset.id,{analysis_status:'ready',asset_kind:'documentary_photo',primary_subjects:['Hall'],
    text_regions:[],photo_regions:[],entities:[],reader_text_present:false,confidence:0.9,analysis_version:'media-analysis-2'});
  repository.refreshSourceMediaBindings(source.id,{dryRun:false});
  db.prepare(`INSERT INTO topic_candidates(id,destination_slug,topic_key,proposed_title,rationale,coverage_score,evidence_count,conflict_count,created_at,updated_at)
    VALUES ('cover-topic','beijing','cover','Cover fixture','test',1,1,0,'now','now')`).run();
  db.prepare(`INSERT INTO content_opportunities(id,destination_slug,topic_key,strategy_version,source_id,candidate_id,title,content_type,readiness_score,
    coverage_json,status,approved_at,created_at,updated_at) VALUES ('cover-owner','beijing','cover','3.9',?,'cover-topic',
    'Cover selection fixture','attraction_guide',100,'{}','approved_ready','2026-09-28','now','now')`).run(source.id);
  db.prepare("UPDATE topic_candidates SET opportunity_id='cover-owner' WHERE id='cover-topic'").run();
  db.prepare(`INSERT INTO content_briefs(id,candidate_id,destination_slug,topic,audience,search_intent,status,created_at,updated_at)
    VALUES ('cover-brief','cover-topic','beijing','East Hall','travelers','info','ready','now','now')`).run();
  db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at,revision,content_hash)
    VALUES ('cover-draft','cover-brief','Cover selection fixture','cover-fixture','This original body must not change.','{}','review','now','now',2,'original-body')`).run();
  db.prepare(`INSERT INTO article_visuals(id,draft_id,slot,placement,purpose,alt_text,generation_prompt,aspect_ratio,status,created_at,updated_at,
    media_path,media_url,source_asset_id,image_subject,image_type,acquisition_strategy,media_metadata_json)
    VALUES ('cover-visual','cover-draft',1,'hero','East Hall scene','Synthetic Hall','','16:9','generated','now','now',?,'/media/cover-test-master.png',?,
    'East Hall','real_world_photo','use_source_image',?)`).run(master,asset.id,JSON.stringify({source_sha256:mediaHash(bytes),
      quality_qa:{status:'passed',file_hash:mediaHash(bytes)}}));
  return {draftId:'cover-draft',visualId:'cover-visual',ownerId:'cover-owner',master,bytes,hash:mediaHash(bytes),sourceId:source.id};
}
