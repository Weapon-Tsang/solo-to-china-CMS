import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {normalizeXiaohongshuCapture} from '../src/adapters/xiaohongshu.mjs';
import {mediaHash} from '../src/web-media.mjs';

// Synthetic bytes and hand-authored pixel labels exercise the deterministic
// material gate. This fixture never asserts real-world semantic acceptance.
export async function seedOpportunityPhoto(repository,directory,{subject,destination='chongqing',sourceId}={}) {
  const db=repository.db;
  if(!sourceId) {
    const source=repository.saveCapture(normalizeXiaohongshuCapture({url:`https://www.xiaohongshu.com/explore/media-${mediaHash(subject).slice(0,16)}`,
      title:subject,text:`Synthetic local media fixture for ${subject}. No real-world image suitability is asserted.`}));sourceId=source.id;
    db.prepare("UPDATE sources SET status='processed' WHERE id=?").run(sourceId);
    db.prepare(`INSERT INTO experience_extraction_runs(id,source_id,capture_version,input_hash,status,degraded,created_at,updated_at)
      VALUES (?,?,1,?,'succeeded',0,'now','now')`).run(`fixture_experience_${mediaHash(sourceId).slice(0,16)}`,sourceId,mediaHash(subject));
  }
  const bytes=await sharp({create:{width:1200,height:800,channels:3,background:'#b8c7b5'}}).png().toBuffer();
  const sha256=mediaHash(bytes),id=`fixture_media_${mediaHash(sourceId+subject).slice(0,20)}`,filename=path.join(directory,`${id}.png`);
  fs.writeFileSync(filename,bytes);
  db.prepare(`INSERT INTO source_assets(id,source_id,kind,remote_url,local_path,mime_type,width,height,storage_status,original_bytes_status,
    durability_status,original_sha256,stored_sha256,capture_version,local_photo_audit_json,alt_text,position)
    VALUES (?,?,'image',?,?, 'image/png',1200,800,'saved','saved_original','ORIGINAL_STORED',?,?,1,?,?,0)`)
    .run(id,sourceId,`https://example.com/${id}.png`,filename,sha256,sha256,JSON.stringify({status:'eligible',sha256,providerCalls:0}),subject);
  repository.saveSourceAssetAnalysis(id,{analysis_status:'ready',asset_kind:'documentary_photo',primary_subjects:[subject],reader_text_present:false,
    text_regions:[],photo_regions:[],entities:[],confidence:1,source_sha256:sha256,analysis_version:'media-analysis-2'});
  return {id,sourceId,filename,sha256};
}
