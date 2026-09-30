import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { repositoryFixture } from '../test-support/repository-fixture.mjs';
import { auditSourcePhoto, closeLocalPhotoAudit, rejectLowResolutionOriginal } from '../src/local-photo-audit.mjs';
import { Pipeline } from '../src/pipeline.mjs';

test('source photo audit runs locally in a persisted worker job and rejects flat low-quality media', async (t) => {
  t.after(closeLocalPhotoAudit);
  const { db, repository, directory } = repositoryFixture(t);
  const file = path.join(directory, 'flat.png');
  const bytes = await sharp({ create:{width:1000,height:800,channels:3,
    background:{r:240,g:240,b:240}} }).png().toBuffer();
  fs.writeFileSync(file, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  db.prepare(`INSERT INTO sources(id,adapter,canonical_url,captured_at,raw_text,raw_html,
    raw_payload_json,content_hash,created_at,updated_at)
    VALUES ('source','manual','https://example.test/source','now','text','html','{}','hash','now','now')`).run();
  db.prepare(`INSERT INTO source_assets(id,source_id,kind,remote_url,position,local_path,
    original_bytes_status,durability_status,original_sha256)
    VALUES ('asset','source','image','https://example.test/photo',0,?,'saved_original','ORIGINAL_STORED',?)`)
    .run(file, sha256);
  const [jobId] = repository.enqueueSourcePhotoAudits('source', { priority:70 });
  assert.equal(db.prepare('SELECT priority FROM jobs WHERE id=?').get(jobId).priority, 70);
  const pipeline = new Pipeline(repository, {config:{}}, {visuals:null,contentEngine:null});
  assert.equal(await pipeline.runOne(), true);
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(jobId).status, 'succeeded');
  const audit = JSON.parse(db.prepare('SELECT local_photo_audit_json FROM source_assets WHERE id=?').get('asset').local_photo_audit_json);
  assert.equal(audit.status, 'needs_review');
  assert.equal(audit.providerCalls, 0);
  assert.equal(audit.sha256, sha256);
  assert.ok(audit.reasons.includes('detail_low'));
  assert.equal(audit.method, 'sharp_local');
  assert.equal(audit.textChars, null);
  const repeated = repository.enqueue('audit_source_photo', 'asset', { dedupeKey:'repeat-photo-audit' });
  assert.equal(await pipeline.runOne(), true);
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(repeated).status, 'succeeded');
  assert.deepEqual(JSON.parse(db.prepare('SELECT local_photo_audit_json FROM source_assets WHERE id=?').get('asset').local_photo_audit_json), audit);
  assert.equal((await auditSourcePhoto(file)).status, 'needs_review');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM model_call_metrics').get().count, 0);
});

test('tiny originals are rejected before paid recognition; dimensions alone never approve a photo',async t=>{
  const {directory}=repositoryFixture(t);
  const small=path.join(directory,'small.png');
  const large=path.join(directory,'large.png');
  await sharp({create:{width:640,height:853,channels:3,background:'white'}}).png().toFile(small);
  await sharp({create:{width:1200,height:800,channels:3,background:'white'}}).png().toFile(large);
  const rejection=await rejectLowResolutionOriginal(small);
  assert.equal(rejection.status,'needs_review');
  assert.deepEqual(rejection.reasons,['resolution_low']);
  assert.equal(rejection.providerCalls,0);
  assert.equal(rejection.sha256,createHash('sha256').update(fs.readFileSync(small)).digest('hex'));
  assert.equal(await rejectLowResolutionOriginal(large),null,'passing dimensions is not positive identity/quality evidence');
});
