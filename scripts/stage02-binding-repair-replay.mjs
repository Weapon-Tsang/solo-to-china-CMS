import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { refreshSourceMediaBindings, readMediaBindings, MEDIA_BINDING_POLICY } from '../src/repositories/media-bindings.mjs';
import { repairMediaBinding } from '../src/repositories/media-binding-repair.mjs';

// Reuse the already disposable historical work DB. All test writes roll back.
// No original/baseline copy, provider, server, worker, or performance benchmark.
const file=fs.realpathSync(process.argv[2] || '');
if (path.basename(file)!=='work.sqlite' || !path.basename(path.dirname(file)).startsWith('cms-phase02-media-replay-')) {
  throw new Error('Pass an existing disposable phase02 replay work.sqlite.');
}
const db=new DatabaseSync(file);
const fingerprint=table=>{
  const hash=crypto.createHash('sha256');let count=0;
  for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate()) {hash.update(JSON.stringify(row));count++;}
  return {count,sha256:hash.digest('hex')};
};
const protectedTables=['sources','source_assets','source_asset_analyses','claims','article_drafts','article_visuals',
  'writing_packets','jobs','model_call_metrics','wordpress_publications'];
const fingerprints=()=>Object.fromEntries(protectedTables.map(table=>[table,fingerprint(table)]));
const before=fingerprints();
const relationsBefore={occurrences:fingerprint('media_occurrences'),bindings:fingerprint('media_bindings')};
const report={scope:'Existing disposable historical work DB, transaction rollback, no media byte/semantic audit',policy:MEDIA_BINDING_POLICY,
  historicalCounts:Object.fromEntries(Object.entries(before).map(([key,value])=>[key,value.count])),reasons:{},assets:0,bindings:0,
  supplementedAssets:0,supplementedChars:0,modelCalls:0};
try {
  db.exec('BEGIN IMMEDIATE');
  for (const {id} of db.prepare('SELECT id FROM sources ORDER BY id').all()) {
    const dry=refreshSourceMediaBindings(db,id);
    const applied=refreshSourceMediaBindings(db,id,{dryRun:false});
    assert.deepEqual(applied.assets,dry.assets);
    for (const asset of applied.assets) {
      report.assets++;report.bindings+=asset.bindings.length;
      report.reasons[asset.reason]=(report.reasons[asset.reason] || 0)+1;
      report.supplementedAssets+=Number(asset.supplementation.read_count>0);
      report.supplementedChars+=asset.supplementation.added_chars;
      assert.equal(readMediaBindings(db,asset.asset_id).length,asset.bindings.filter(row=>row.status==='confirmed').length);
    }
  }
  const id=db.prepare("SELECT asset_id FROM media_bindings WHERE status='confirmed' ORDER BY id LIMIT 1").get().asset_id;
  const preview=repairMediaBinding(db,id);
  const relationsAfter={occurrences:fingerprint('media_occurrences'),bindings:fingerprint('media_bindings')};
  repairMediaBinding(db,id,{apply:true,expectedHash:preview.preview_hash});
  assert.deepEqual({occurrences:fingerprint('media_occurrences'),bindings:fingerprint('media_bindings')},relationsAfter);
  assert.deepEqual(fingerprints(),before);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM media_bindings mb LEFT JOIN media_occurrences mo ON mo.id=mb.occurrence_id WHERE mo.id IS NULL`).get().n,0);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM media_bindings mb JOIN media_occurrences mo ON mo.id=mb.occurrence_id WHERE mb.status='confirmed' AND mo.status='stale'`).get().n,0);
  report.invariants={previewEqualsApply:true,confirmedReadsRevalidated:true,repairIdempotent:true,protectedRowsUnchanged:true,
    foreignKeysValid:true,noOrphanBindings:true,noStaleConfirmedBindings:true};
} finally {
  if (db.isTransaction) db.exec('ROLLBACK');
  assert.deepEqual({occurrences:fingerprint('media_occurrences'),bindings:fingerprint('media_bindings')},relationsBefore);
  assert.deepEqual(fingerprints(),before);
  db.close();
}
report.invariants.rollbackRestoredPriorWork=true;
console.log(JSON.stringify(report,null,2));
