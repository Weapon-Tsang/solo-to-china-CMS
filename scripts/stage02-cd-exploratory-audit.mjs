import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
const filename='C:/Users/Mloong/AppData/Local/Temp/cms-c-cover-browser-ttoV6D/test.sqlite';
if(!fs.existsSync(filename))throw new Error('Approved isolated browser fixture missing.');
const db=new DatabaseSync(filename,{readOnly:true});
try{
  const q=sql=>db.prepare(sql).get().n;
  const counts={uploads:q('SELECT COUNT(*) n FROM article_media_uploads'),stored:q('SELECT COUNT(*) n FROM article_media_uploads WHERE asset_id IS NOT NULL'),
    revisions:q('SELECT COUNT(*) n FROM article_media_revisions'),selected:q("SELECT COUNT(*) n FROM article_visuals WHERE json_extract(media_metadata_json,'$.manual_article_selection.locked')=1"),
    danglingUploads:q('SELECT COUNT(*) n FROM article_media_uploads u LEFT JOIN source_assets a ON a.id=u.asset_id WHERE u.asset_id IS NOT NULL AND a.id IS NULL'),
    orphanRevisions:q('SELECT COUNT(*) n FROM article_media_revisions r LEFT JOIN article_drafts d ON d.id=r.draft_id WHERE d.id IS NULL'),
    duplicateRevisions:q('SELECT COUNT(*) n FROM (SELECT draft_id,draft_revision,media_revision,COUNT(*) c FROM article_media_revisions GROUP BY 1,2,3 HAVING c>1)'),
    activeJobs:q("SELECT COUNT(*) n FROM jobs WHERE status IN ('running','queued')"),modelCalls:q('SELECT COUNT(*) n FROM model_call_metrics')};
  assert.equal(counts.danglingUploads,0);assert.equal(counts.orphanRevisions,0);assert.equal(counts.duplicateRevisions,0);assert.equal(counts.modelCalls,0);
  for(const row of db.prepare('SELECT a.local_path FROM article_media_uploads u JOIN source_assets a ON a.id=u.asset_id').all())assert.ok(fs.existsSync(row.local_path),'stored original missing');
  console.log(JSON.stringify({status:'PASS',scope:'isolated browser fixture only; after explicit revocation',counts,retained_originals_verified:counts.stored,real_provider:'NOT TESTED',historical_pixels:'NOT TESTED'},null,2));
}finally{db.close();}
