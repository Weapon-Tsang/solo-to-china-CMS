import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { openDatabase, SCHEMA_VERSION } from '../src/db.mjs';
import { repositoryFixture } from '../test-support/repository-fixture.mjs';
import { png } from '../test-support/media-fixtures.mjs';
import { CaptureMediaUploadManager } from '../src/capture-media-upload.mjs';
import { normalizeXiaohongshuCapture } from '../src/adapters/xiaohongshu.mjs';

test('output-limit splitting cannot remove a segment with earlier cited evidence',t=>{
  const {repository,db}=repositoryFixture(t);
  const source=repository.saveCapture(normalizeXiaohongshuCapture({url:'https://www.xiaohongshu.com/explore/citedsegment',text:'A detailed museum visit preserves the original entrance and ticket evidence. '.repeat(30)}));
  const [segment]=repository.prepareSourceSegments(source.id);
  db.prepare(`INSERT INTO evidence_spans(id,source_id,segment_id,locator_type,quote,created_at)
    VALUES ('cited-span',?,?,'text','original entrance','now')`).run(source.id,segment.id);
  assert.deepEqual(repository.splitSourceSegmentForRetry(segment.id),[]);
  assert.equal(db.prepare("SELECT segment_id FROM evidence_spans WHERE id='cited-span'").get().segment_id,segment.id);
  assert.ok(repository.getSegmentExtractionPackage(segment.id));
});

test('killing migration 64 before commit preserves schema 63 and all foreign-key IDs; reopening upgrades idempotently', async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'stc-history-migration-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const dbModule=new URL('../src/db.mjs',import.meta.url);
  const legacy=fs.readFileSync(dbModule,'utf8').replace(/^  if \(current < (\d+)\).*$/gm,(line,v)=>Number(v)>63?'':line);
  const legacyFile=path.join(directory,'db63.mjs');fs.writeFileSync(legacyFile,legacy);
  const filename=path.join(directory,'history.sqlite');
  let db=(await import(pathToFileURL(legacyFile).href)).openDatabase(filename);
  db.prepare(`INSERT INTO sources(id,adapter,external_id,canonical_url,captured_at,raw_text,raw_html,raw_payload_json,content_hash,created_at,updated_at,capture_version)
    VALUES ('old-source','xiaohongshu','old','https://www.xiaohongshu.com/explore/old','now','Original','','{}','old','now','now',3)`).run();
  db.prepare("INSERT INTO source_assets(id,source_id,kind,remote_url,position) VALUES ('old-asset','old-source','image','https://media.example/old.png',0)").run();
  db.prepare(`INSERT INTO source_files(id,source_id,file_kind,original_filename,mime_type,storage_path,size_bytes,sha256,created_at)
    VALUES ('old-file','old-source','image','old.png','image/png','fixture-only.png',70,'fixture','now')`).run();
  db.prepare(`INSERT INTO source_segments(id,source_id,segment_type,sequence,asset_id,content_hash,semantic_hash,created_at,updated_at,capture_version)
    VALUES ('old-segment','old-source','image',0,'old-asset','old','old','now','now',3)`).run();
  db.prepare("INSERT INTO evidence_spans(id,source_id,segment_id,asset_id,locator_type,created_at) VALUES ('span','old-source','old-segment','old-asset','asset','now')").run();
  db.close();
  const program=`import {DatabaseSync} from 'node:sqlite';import fs from 'node:fs';
    const original=DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec=function(sql){const value=original.call(this,sql);if(sql.includes('CREATE VIEW current_source_assets')){fs.writeSync(1,'UNCOMMITTED\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}return value;};
    const {openDatabase}=await import(${JSON.stringify(dbModule.href)});openDatabase(${JSON.stringify(filename)});`;
  const child=spawn(process.execPath,['--input-type=module','-e',program],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  t.after(()=>child.kill());
  let error='';child.stderr.on('data',bytes=>{error+=bytes;});
  const closed=new Promise(resolve=>child.once('close',resolve));
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{child.kill();reject(new Error('Migration checkpoint timed out: '+error));},15000);
    child.on('error',cause=>{clearTimeout(timeout);reject(cause);});
    child.stdout.on('data',bytes=>{if(String(bytes).includes('UNCOMMITTED')){clearTimeout(timeout);resolve();}});
    child.once('exit',()=>{clearTimeout(timeout);reject(new Error('Migration exited before checkpoint: '+error));});
  });
  child.kill();await closed;
  db=new DatabaseSync(filename);
  assert.equal(db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v,63);
  assert.equal(db.prepare('PRAGMA table_info(source_assets)').all().some(column=>column.name==='capture_version'),false);
  assert.equal(db.prepare('SELECT asset_id FROM evidence_spans').get().asset_id,'old-asset');db.close();
  for(let i=0;i<2;i++){
    db=openDatabase(filename);
    assert.equal(db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v,SCHEMA_VERSION);
    assert.equal(db.prepare('SELECT capture_version FROM source_assets').get().capture_version,3);
    assert.equal(db.prepare('SELECT id FROM current_source_assets').get().id,'old-asset');
    assert.equal(db.prepare('SELECT id FROM current_source_files').get().id,'old-file');
    assert.equal(db.prepare('SELECT capture_version FROM source_files').get().capture_version,3);
    assert.equal(db.prepare('SELECT asset_id FROM current_evidence_spans').get().asset_id,'old-asset');
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);db.close();
  }
});

test('complete recapture retains referenced images and evidence spans while current reads use only the new version', async t => {
  const {db,repository,directory}=repositoryFixture(t);
  const manager=new CaptureMediaUploadManager({uploadDir:path.join(directory,'chunks'),storageDir:repository.contentConfig.sourceUploadsDir});
  const upload=await manager.create({kind:'image',mimeType:'image/png',size:png.length,sha256:createHash('sha256').update(png).digest('hex')});
  await manager.writeChunk(upload.uploadId,0,png);const receipt=await manager.complete(upload.uploadId);
  const filePath=path.join(directory,'original-file.png');fs.writeFileSync(filePath,png);
  const capture=(text,caption)=>({...normalizeXiaohongshuCapture({url:'https://www.xiaohongshu.com/explore/versionedmedia',text,
    images:[{url:'https://media.example/same.png',originalStorageRef:receipt.storageRef,originalSha256:receipt.sha256,captionText:caption}],videos:[]}),
    files:[{id:'original-file',fileKind:'image',originalFilename:'original-file.png',mimeType:'image/png',storagePath:filePath,sizeBytes:png.length,sha256:receipt.sha256}]});
  const first=repository.saveCapture(capture('Original route with the old entrance and its original caption.','Old entrance'));
  const old=repository.getSource(first.id),asset=old.assets[0];
  const segments=repository.prepareSourceSegments(first.id),imageSegment=segments.find(segment=>segment.assetId===asset.id);
  db.prepare(`INSERT INTO evidence_spans(id,source_id,segment_id,asset_id,locator_type,quote,created_at)
    VALUES ('old-span',?,?,?,'asset','Old entrance','now')`).run(first.id,imageSegment.id,asset.id);
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at)
    VALUES ('history-brief','chongqing','Guide','[]','informational','drafted','now','now')`).run();
  db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at)
    VALUES ('history-draft','history-brief','Guide','history-guide','Original prose','{}','qa_failed','now','now')`).run();
  db.prepare(`INSERT INTO article_visuals(id,draft_id,slot,placement,purpose,alt_text,generation_prompt,created_at,updated_at,source_asset_id)
    VALUES ('history-visual','history-draft',0,'hero','Place','Old entrance','','now','now',?)`).run(asset.id);
  const second=repository.saveCapture(capture('Updated route now uses the east entrance with its own caption.','East entrance'));
  assert.equal(second.captureVersion,2);
  const current=repository.getSource(first.id);
  assert.equal(current.assets.length,1);assert.notEqual(current.assets[0].id,asset.id);
  assert.equal(current.files.length,1);assert.notEqual(current.files[0].id,old.files[0].id);
  assert.equal(repository.getSourceCaptureVersion(first.id,1).files[0].id,old.files[0].id);
  assert.deepEqual(fs.readFileSync(filePath),png,'original file remains byte-for-byte intact');
  assert.equal(repository.getSourceAssetPreview(asset.id).id,asset.id);
  db.prepare("UPDATE source_assets SET authorization_status='owner_confirmed',publishable=1 WHERE source_id=?").run(first.id);
  db.prepare("UPDATE sources SET authorization_status='owner_confirmed',publishable=1 WHERE id=?").run(first.id);
  const frozenMedia=repository.authorizedSourceAssetsForBrief({destination_slug:'chongqing',evidence_ledger_json:'[]'},
    {packet:{context:{version:2,authorized_source_assets:[{id:asset.id}]}}});
  assert.deepEqual(frozenMedia.map(item=>item.id),[asset.id],'frozen Packet can retain its old authorized photo after recapture');
  assert.deepEqual(repository.authorizedSourceAssetsForBrief({destination_slug:'chongqing',evidence_ledger_json:'[]'},
    {packet:{context:{version:2,authorized_source_assets:[]}}}),[]);
  assert.equal(db.prepare('SELECT source_asset_id FROM article_visuals').get().source_asset_id,asset.id);
  assert.deepEqual(fs.readFileSync(asset.local_path),png);
  repository.prepareSourceSegments(first.id);
  assert.equal(db.prepare("SELECT asset_id FROM evidence_spans WHERE id='old-span'").get().asset_id,asset.id);
  assert.equal(repository.getSource(first.id).segments.every(segment=>segment.capture_version===2),true);
  assert.equal(repository.sourceCoverageReady(first.id),false,'old coverage cannot make a new capture ready');
  const historical=repository.getSourceCaptureVersion(first.id,1);
  assert.equal(historical.assets[0].id,asset.id);assert.equal(historical.raw_text,old.raw_text);
  assert.equal(historical.segments.some(segment=>segment.id===imageSegment.id),true);
  const evidence=repository.claimReviewEvidence(first.id,JSON.stringify(['old-span']),'Old entrance');
  assert.equal(evidence.assets[0].id,asset.id);
  assert.equal(repository.listSources(10).find(source=>source.id===first.id).discovered_media_count,1);
  const partial=capture('Incomplete third attempt must not replace the accepted second route.','Missing image');
  partial.completeness={overall:'partial_retryable'};
  assert.equal(repository.saveCapture(partial).preservedCompleteVersion,true);
  assert.equal(repository.getSource(first.id).capture_version,2);
  assert.equal(repository.getSource(first.id).assets[0].id,current.assets[0].id);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});
