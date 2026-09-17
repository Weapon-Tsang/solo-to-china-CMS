import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { crc32, inflateSync } from 'node:zlib';
import { indexedDB } from 'fake-indexeddb';
import { CaptureMediaUploadManager } from '../src/capture-media-upload.mjs';
import { trustedMediaRecord, safeMediaPath } from '../src/media-storage.mjs';
import { MediaJournal, mediaJournal } from '../extension/media-journal.js';
import { isPublicMediaAddress, resolveMediaTarget } from '../src/safe-media-http.mjs';
import { png, webm } from '../test-support/media-fixtures.mjs';
import { normalizeXiaohongshuCapture } from '../src/adapters/xiaohongshu.mjs';
import { repositoryFixture } from '../test-support/repository-fixture.mjs';

test('PNG regression fixture has valid chunk CRCs and decodes to a complete RGBA scanline', () => {
  const chunks=[];let offset=8;
  while(offset<png.length) {
    const length=png.readUInt32BE(offset),type=png.subarray(offset+4,offset+8).toString();
    assert.equal(png.readUInt32BE(offset+8+length),crc32(png.subarray(offset+4,offset+8+length)),type);
    chunks.push({type,bytes:png.subarray(offset+8,offset+8+length)});offset+=length+12;
  }
  assert.equal(offset,png.length);
  assert.deepEqual(chunks.map(chunk=>chunk.type),['IHDR','IDAT','IEND']);
  assert.deepEqual(inflateSync(chunks[1].bytes),Buffer.from([0,255,0,0,255]));
});

test('provisional recapture preserves the complete source and archives attempts idempotently',t=>{
  const {repository,db}=repositoryFixture(t);
  const input={url:'https://www.xiaohongshu.com/explore/complete123',text:'Original complete travel note with a useful choice.'};
  const saved=repository.saveCapture(normalizeXiaohongshuCapture(input));
  const original=repository.getSource(saved.id);
  const partial=normalizeXiaohongshuCapture({...input,text:'A newer incomplete travel note which must not replace the original.',completeness:{overall:'partial_retryable',images:{expected:2,complete:false},videos:{expected:0,complete:true}}});
  for(let i=0;i<2;i++)assert.equal(repository.saveCapture(partial).preservedCompleteVersion,true);
  assert.equal(repository.getSource(saved.id).raw_text,original.raw_text);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM capture_versions WHERE source_id=?').get(saved.id).n,2);
});

test('upload restart resumes missing chunks; lost finalize returns same durable receipt; capabilities isolate sessions', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'stc-media-resume-'));
  t.after(() => fs.rmSync(root,{ recursive:true, force:true }));
  const config = { uploadDir:path.join(root,'chunks'), storageDir:path.join(root,'stored'), chunkBytes:512*1024 };
  let manager = new CaptureMediaUploadManager(config);
  const bytes = Buffer.concat([webm,Buffer.alloc(512*1024)]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const upload = await manager.create({ protocolVersion:2,kind:'video',mimeType:'video/webm',size:bytes.length,sha256 });
  await manager.writeChunk(upload.uploadId,0,bytes.subarray(0,upload.chunkBytes),upload.uploadToken);
  await assert.rejects(manager.writeChunk(upload.uploadId,0,Buffer.alloc(upload.chunkBytes),upload.uploadToken), { code:'MEDIA_CHUNK_CONFLICT' });
  await assert.rejects(manager.status(upload.uploadId,'wrong'), { code:'MEDIA_UPLOAD_UNAUTHORIZED' });
  manager = new CaptureMediaUploadManager(config);
  assert.deepEqual((await manager.status(upload.uploadId,upload.uploadToken)).receivedChunks,[0]);
  await assert.rejects(manager.complete(upload.uploadId,upload.uploadToken),{code:'MEDIA_UPLOAD_INCOMPLETE'});
  await manager.writeChunk(upload.uploadId,1,bytes.subarray(upload.chunkBytes),upload.uploadToken);
  const receipt = await manager.complete(upload.uploadId,upload.uploadToken);
  assert.deepEqual(await new CaptureMediaUploadManager(config).complete(upload.uploadId,upload.uploadToken),receipt);
  assert.deepEqual((await manager.create({ protocolVersion:2,kind:'video',mimeType:'video/webm',size:bytes.length,sha256 })).receipt,receipt);
  const stored = path.join(config.storageDir,receipt.storageRef);
  assert.deepEqual(fs.readFileSync(stored),bytes);
  fs.utimesSync(stored,new Date(),new Date(Date.now()+6000));
  assert.deepEqual((await manager.status(upload.uploadId,upload.uploadToken)).receipt,receipt,'restored/touched matching bytes are revalidated');
  fs.appendFileSync(stored,'corrupt');
  assert.equal(trustedMediaRecord(config.storageDir,receipt.storageRef,sha256),null);
  await assert.rejects(manager.complete(upload.uploadId,upload.uploadToken),{code:'MEDIA_STORED_FILE_CHANGED'});
  assert.throws(() => safeMediaPath(config.storageDir,'../outside'),{code:'INVALID_MEDIA_PATH'});
});

test('IndexedDB restart preserves binary and upload progress, enforces quota, and frees accepted bytes', async () => {
  const options = {name:randomUUID(),factory:indexedDB,maxBytes:100};
  const first = new MediaJournal(options);
  await first.put('asset',{bytes:new Uint8Array(80),upload:{uploadId:'one'}});
  const restarted = new MediaJournal(options);
  assert.equal((await restarted.get('asset')).bytes.byteLength,80);
  await assert.rejects(restarted.put('other',{bytes:new Uint8Array(21)}),{code:'MEDIA_JOURNAL_QUOTA'});
  assert.equal((await restarted.get('asset')).upload.uploadId,'one');
  await restarted.remove('asset');
  await restarted.put('other',{bytes:new Uint8Array(100)});
});

test('remote policy rejects IPv4, IPv6, mapped/private and mixed DNS results without network probes', async () => {
  for (const address of ['127.0.0.1','10.0.0.1','169.254.169.254','::1','::ffff:127.0.0.1','fe80::1','fc00::1','2001:db8::1']) assert.equal(isPublicMediaAddress(address),false,address);
  assert.equal(isPublicMediaAddress('8.8.8.8'),true);
  await assert.rejects(resolveMediaTarget('https://media.example/image',async () => [{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}]),{code:'REMOTE_MEDIA_ADDRESS_FORBIDDEN'});
  await assert.rejects(resolveMediaTarget('https://media.example:444/image'),{code:'REMOTE_MEDIA_INVALID'});
});

test('legacy mixed capture crosses extension upload, real signature validation, and Source storage without duplicate base64', async t => {
  const {directory,repository} = repositoryFixture(t);
  const manager = new CaptureMediaUploadManager({uploadDir:path.join(directory,'chunks'),storageDir:path.join(directory,'source-images')});
  const listener = () => ({addListener(){},removeListener(){}});
  globalThis.chrome = { runtime:{onInstalled:listener(),onStartup:listener(),onMessage:listener(),getManifest:()=>({version:'2.0.6'})},
    alarms:{onAlarm:listener(),create:async()=>{},clear:async()=>true},storage:{local:{get:async value=>value,set:async()=>{}}}};
  mediaJournal.factory = indexedDB;
  let downloaded = 0, uploaded = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options={}) => {
    let payload;
    if (String(url).startsWith('https://media.example/')) {
      const video = String(url).endsWith('.webm'), bytes = video ? webm : png;
      downloaded += bytes.length;
      return new Response(bytes,{headers:{'content-type':video?'video/webm':'image/png'}});
    }
    const pathname = new URL(url).pathname, token = options.headers?.['x-upload-token'];
    if (pathname.endsWith('/capture-media-uploads')) payload = await manager.create(JSON.parse(options.body));
    else if (pathname.includes('/chunks/')) { uploaded += options.body.length; const match=pathname.match(/uploads\/([^/]+)\/chunks\/(\d+)/); payload = await manager.writeChunk(match[1],Number(match[2]),options.body,token); }
    else if (pathname.endsWith('/complete')) payload = await manager.complete(pathname.split('/').at(-2),token);
    else payload = {};
    return new Response(JSON.stringify(payload),{headers:{'content-type':'application/json'}});
  };
  t.after(()=>{globalThis.fetch=original;});
  const {persistCaptureMedia} = await import('../extension/background.js?media-integration');
  const capture = {url:'https://www.xiaohongshu.com/explore/mixedmedia',text:'A complete mixed image and video capture fixture.',images:[{url:'https://media.example/a.png'}],videos:[{url:'https://media.example/a.webm'}]};
  const result = await persistCaptureMedia(capture);
  assert.equal(result.capture.mediaPersistenceFailures.length,0,JSON.stringify(result.capture.mediaPersistenceFailures));
  assert.equal(downloaded,png.length+webm.length);
  assert.equal(uploaded,downloaded);
  assert.equal(JSON.stringify(capture).includes(';base64,'),false);
  assert.equal(repository.saveCapture(normalizeXiaohongshuCapture(capture)).mediaDurabilityComplete,true);
});
