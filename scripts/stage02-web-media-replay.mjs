import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {parseMediaMetadata,responsiveImageAttributes} from '../src/media-delivery.mjs';

const file=fs.realpathSync(process.argv[2] || '');
if(file!==fs.realpathSync('D:/cms-phase02-media-replay-xiKzH1/work.sqlite'))
  throw new Error('Only the existing authorized disposable work copy is permitted.');
const db=new DatabaseSync(file);
const tables=['sources','source_assets','article_drafts','article_visuals','writing_packets','jobs','model_call_metrics','wordpress_publications'];
const fingerprint=table=>{const h=crypto.createHash('sha256');let count=0;
  for(const row of db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate()){h.update(JSON.stringify(row));count++;}
  return {count,sha256:h.digest('hex')};};
const before=Object.fromEntries(tables.map(t=>[t,fingerprint(t)]));
const report={scope:'B metadata compatibility and adjacent audit on existing authorized work.sqlite only',
  externalRequests:0,schema:db.prepare('SELECT max(version) v FROM schema_migrations').get().v,before,visuals:[]};
try {
  db.exec('BEGIN IMMEDIATE');
  for(const row of db.prepare('SELECT id,status,media_path,media_metadata_json FROM article_visuals ORDER BY id').all()) {
    const metadata=parseMediaMetadata(row.media_metadata_json);
    const responsive=responsiveImageAttributes(metadata);
    report.visuals.push({id:row.id,status:row.status,hasLocalFile:Boolean(row.media_path && fs.existsSync(row.media_path)),
      legacyHashPresent:Boolean(metadata.sha256),webLineagePresent:Boolean(metadata.web_derivative),
      servedHashKnown:Boolean(metadata.served_asset_hash),responsiveCandidates:(responsive.srcset || '').split(',').filter(Boolean).length,
      returnedSizes:(metadata.derivatives || []).length});
    // Historical upload hashes remain historical, never relabeled as served hashes.
    assert.equal(metadata.web_derivative,undefined,'Historical replay baseline unexpectedly contains new B writes.');
    db.exec('SAVEPOINT metadata_projection');
    try {
      const projected={...metadata,served_asset_hash:null,served_hash_status:'unknown_not_read',
        upload_bytes_hash:metadata.sha256 || null};
      db.prepare('UPDATE article_visuals SET media_metadata_json=? WHERE id=?').run(JSON.stringify(projected),row.id);
      const roundtrip=parseMediaMetadata(db.prepare('SELECT media_metadata_json FROM article_visuals WHERE id=?').get(row.id).media_metadata_json);
      assert.equal(roundtrip.served_asset_hash,null);assert.equal(roundtrip.sha256,metadata.sha256);
      assert.deepEqual(roundtrip.quality_qa,metadata.quality_qa);
    } finally {db.exec('ROLLBACK TO metadata_projection; RELEASE metadata_projection');}
  }
  report.audit={orphanVisuals:db.prepare('SELECT count(*) n FROM article_visuals v LEFT JOIN article_drafts d ON d.id=v.draft_id WHERE d.id IS NULL').get().n,
    generatedWithoutLocalFile:report.visuals.filter(v=>v.status==='generated' && !v.hasLocalFile).length,
    existingWebLineage:report.visuals.filter(v=>v.webLineagePresent).length};
  for(const t of tables)assert.deepEqual(fingerprint(t),before[t]);
} finally {
  if(db.isTransaction)db.exec('ROLLBACK');
  for(const t of tables)assert.deepEqual(fingerprint(t),before[t]);
  db.close();
}
report.rollback='PASS';report.protectedRowsUnchanged=true;
console.log(JSON.stringify(report,null,2));
