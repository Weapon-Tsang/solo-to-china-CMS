// Offline release helpers. No Repository, worker, provider or server imports.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {collectDatabaseReferences} from '../src/backup.mjs';
import {previewRepair,applyRepair} from './repair-opportunity-families.mjs';

export const repairIds = [
  'opportunity_859f07766f1202a7b54f3058','opportunity_9d066affac5209dd820dae5e',
  'opportunity_e76caea56f5914a2d27a8f85','opportunity_716a5d141a6a239055100d06',
  'opportunity_0ad2ce3a8a6125aa07ee8be4','opportunity_c1f5ed8caac9df16e20abf27',
];
export function fileHash(filename) {
  const h=createHash('sha256'),fd=fs.openSync(filename,'r'),buffer=Buffer.alloc(1024*1024);
  try {let n;while((n=fs.readSync(fd,buffer,0,buffer.length,null)))h.update(buffer.subarray(0,n));}
  finally {fs.closeSync(fd);}return h.digest('hex');
}
export function referenceHash(db) {
  return createHash('sha256').update(JSON.stringify(collectDatabaseReferences(db))).digest('hex');
}
export function assertRepairUnchanged(current,expected) {
  assert.deepEqual(current.ids,repairIds);assert.deepEqual(expected.ids,repairIds);
  assert.deepEqual(current.records.map(r=>[r.id,r.recordFingerprint,r.dependencyFingerprint,r.before,r.after,r.blocked]),
    expected.records.map(r=>[r.id,r.recordFingerprint,r.dependencyFingerprint,r.before,r.after,r.blocked]),
    'Repair inputs changed after preflight; stop and reassess');
  assert.ok(current.records.every(r=>!r.blocked),'Protected or invalid repair');
}
export function verifyBoundaryMedia(db,manifest,preparedReferences) {
  assert.equal(referenceHash(db),preparedReferences,'Media references changed after complete backup');
  // All current referenced bytes must still match the fully verified and restore-drilled snapshot.
  // New unrelated files are preserved in place; they are never removed by migration or rollback.
  for(const file of manifest.files.filter(f=>f.category!=='database')) {
    assert.equal(fs.statSync(file.originalPath).size,file.bytes,`Media size changed: ${file.archivePath}`);
    assert.equal(fileHash(file.originalPath),file.sha256,`Media bytes changed: ${file.archivePath}`);
  }
}
export function repairBoundary(filename,expected,outputDirectory) {
  const stat=fs.statSync(filename);
  const identity={kind:'approved-production-boundary',path:fs.realpathSync(filename),device:String(stat.dev),inode:String(stat.ino)};
  const db=new DatabaseSync(filename);
  try {
    db.exec('BEGIN');const preview=previewRepair(db,repairIds,identity);db.exec('ROLLBACK');
    assertRepairUnchanged(preview,expected);
    fs.writeFileSync(path.join(outputDirectory,'production-repair-preview.json'),JSON.stringify(preview,null,2),{flag:'wx'});
    const result=applyRepair(db,preview,identity);
    assert.equal(result.changed,6);
    assert.equal(applyRepair(db,preview,identity).changed,0);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    fs.writeFileSync(path.join(outputDirectory,'production-repair-result.json'),JSON.stringify({
      ...result,previewFingerprint:preview.previewFingerprint,records:preview.records.map(r=>({id:r.id,before:r.before,after:r.after}))},null,2),{flag:'wx'});
    return result;
  } finally {db.close();}
}
