import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {pathToFileURL} from "node:url";
import { normalizeXiaohongshuCapture } from "../src/adapters/xiaohongshu.mjs";
import { openDatabase,SCHEMA_VERSION } from "../src/db.mjs";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";

test("schema persists image-level analysis and hydrates the production decision DTO", (t) => {
  const {db,repository}=repositoryFixture(t);
  assert.equal(SCHEMA_VERSION,71);
  const source=repository.saveCapture(normalizeXiaohongshuCapture({
    url:"https://www.xiaohongshu.com/explore/media-analysis",title:"Chongqing card",
    text:"A complete selected travel note long enough to create its current capture segments for extraction.",
    images:[{url:"https://example.test/card.png",alt:"Red and black Chongqing notes card"}],
  }));
  db.prepare("UPDATE source_assets SET storage_status='saved',original_bytes_status='saved_original',durability_status='ORIGINAL_STORED',local_path='fixture.png' WHERE source_id=?").run(source.id);
  const asset=db.prepare("SELECT id FROM source_assets WHERE source_id=?").get(source.id);
  const segment=repository.prepareSourceSegments(source.id)[0];
  db.prepare("UPDATE source_segments SET asset_id=?,segment_type='image' WHERE id=?").run(asset.id,segment.id);
  segment.asset_id=asset.id;
  repository.saveSegmentExtraction(segment.id,{method:"vertex",model:"gemini",result:{source:{language:"en"},claims:[],media_analysis:[{
    asset_id:segment.asset_id,analysis_status:"ready",asset_kind:"editorial_infographic",reader_text_present:true,
    text_regions:[{region_id:"body",text:"09:00–17:00",role:"author_overlay"}],photo_regions:[],entities:["Hongyadong"],
    editor_ui_regions:[{region_id:"toolbar",kind:"notes_toolbar"}],primary_subjects:["Chongqing itinerary"],
    language_by_region:[{region_id:"body",language:"zh-CN",role:"author_overlay"}],confidence:0.94,
    analysis_version:"media-analysis-1",prompt_version:"media-analysis-prompt-1",
  }]}});
  repository.saveSourceAssetAnalysis(segment.asset_id,{
    analysis_status:"ready",asset_kind:"editorial_infographic",reader_text_present:true,
    text_regions:[{region_id:"body",text:"09:00–17:00",role:"author_overlay",language:"zh-CN",readable:true,preserve:false}],
    photo_regions:[],entities:["Hongyadong"],editor_ui_regions:[{region_id:"toolbar",kind:"notes_toolbar"}],
    primary_subjects:["Chongqing itinerary"],language_by_region:[{region_id:"body",language:"zh-CN",role:"author_overlay"}],
    confidence:0.94,analysis_version:"media-analysis-2",prompt_version:"media-analysis-prompt-2",
  });
  const stored=db.prepare("SELECT * FROM source_asset_analyses WHERE asset_id=?").get(segment.asset_id);
  assert.equal(stored.source_sha256,db.prepare("SELECT original_sha256 FROM source_assets WHERE id=?").get(segment.asset_id).original_sha256);
  const dto=repository.sourceAssetDecisionDto(segment.asset_id);
  assert.equal(dto.analysis_status,"ready");
  assert.equal(dto.asset_kind,"editorial_infographic");
  assert.deepEqual(dto.editor_ui_regions,[{region_id:"toolbar",kind:"notes_toolbar"}]);
});

test("a text-bearing image cannot hydrate as ready without decoded text regions", (t) => {
  const {db,repository}=repositoryFixture(t);
  const source=repository.saveCapture(normalizeXiaohongshuCapture({
    url:"https://www.xiaohongshu.com/explore/incomplete-media-analysis",title:"Handwritten card",
    text:"A complete selected travel note long enough to create its current capture segments for extraction.",
    images:[{url:"https://example.test/card.png",alt:"Handwritten travel card"}],
  }));
  const asset=db.prepare("SELECT id FROM source_assets WHERE source_id=?").get(source.id);
  repository.saveSourceAssetAnalysis(asset.id,{analysis_status:"ready",asset_kind:"handwritten_card",reader_text_present:true,
    text_regions:[],photo_regions:[],entities:[],editor_ui_regions:[],primary_subjects:[],language_by_region:[],confidence:0.9,
    analysis_version:"media-analysis-1",prompt_version:"media-analysis-prompt-1"});
  const dto=repository.sourceAssetDecisionDto(asset.id);
  assert.equal(dto.analysis_status,"needs_review");
});

test("migration 71 is additive and does not enqueue or rewrite source assets",async(t)=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"stc-migration-71-"));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const source=fs.readFileSync(new URL("../src/db.mjs",import.meta.url),"utf8")
    .replace(/^  if \(current < 71\).*$/gm,"");
  const legacyPath=path.join(directory,"db-v70.mjs");fs.writeFileSync(legacyPath,source);
  const {openDatabase:openV70}=await import(`${pathToFileURL(legacyPath).href}?schema=70`);
  const filename=path.join(directory,"migration.sqlite");let db=openV70(filename);
  db.prepare(`INSERT INTO sources(id,adapter,canonical_url,captured_at,raw_text,raw_html,raw_payload_json,content_hash,created_at,updated_at)
    VALUES ('source','manual','https://example.test/source','now','Preserved source body','','{}','source-hash','now','now')`).run();
  db.prepare(`INSERT INTO source_assets(id,source_id,kind,remote_url,position,local_path,mime_type,original_filename)
    VALUES ('asset','source','image','https://example.test/card.png',0,'preserved.png','image/png','card.png')`).run();
  const jobsBefore=db.prepare("SELECT COUNT(*) n FROM jobs").get().n;db.close();
  db=openDatabase(filename);
  assert.equal(db.prepare("SELECT MAX(version) version FROM schema_migrations").get().version,71);
  assert.equal(db.prepare("SELECT local_path FROM source_assets WHERE id='asset'").get().local_path,"preserved.png");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM source_asset_analyses").get().n,0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs").get().n,jobsBefore);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check,"ok");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);db.close();
});
