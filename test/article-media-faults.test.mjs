import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {openDatabase} from '../src/db.mjs';
import {loadConfig} from '../src/config.mjs';
import {createApplication} from '../src/server.mjs';
import {seedCoverFixture} from '../test-support/cover-fixture.mjs';
import {mediaHash} from '../src/web-media.mjs';

test('article upload diagnoses application 413, disk reserve and decode resource limit without losing a valid session',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cms-media-fault-')),databasePath=path.join(directory,'test.sqlite');
  openDatabase(databasePath).close();
  const app=createApplication(loadConfig({HOST:'127.0.0.1',PORT:'0',DATABASE_PATH:databasePath,CMS_DATA_ROOT:directory,
    GENERATED_MEDIA_DIR:path.join(directory,'media'),SOURCE_UPLOADS_DIR:path.join(directory,'sources'),
    CAPTURE_MEDIA_UPLOADS_DIR:path.join(directory,'uploads'),CMS_PROCESS_ROLE:'api',MAINTENANCE_ENABLED:'false',LOG_LEVEL:'error',
    ADMIN_TOKEN:'fault-local-token',ADMIN_USERNAME:'fault-editor',ADMIN_PASSWORD:'fault-local-only',SESSION_SECRET:'fault-local-secret'}));
  const previous=fs.statfsSync;
  t.after(async()=>{fs.statfsSync=previous;await app.stop();fs.rmSync(directory,{recursive:true,force:true});});
  const seed=await seedCoverFixture(app.repository,path.join(directory,'media'));await app.start();
  const base=`http://127.0.0.1:${app.server.address().port}/api/drafts/${seed.draftId}/article-media`;
  const headers={authorization:'Bearer fault-local-token','content-type':'application/json'};
  const create=(name,bytes)=>fetch(`${base}/uploads`,{method:'POST',headers,body:JSON.stringify({expected_revision:2,name,size:bytes.length,sha256:mediaHash(bytes),mimeType:'image/png'})});
  fs.statfsSync=()=>({bavail:1n,bsize:1n});
  const noSpace=await create('disk-preflight.png',seed.bytes);assert.equal(noSpace.status,507);
  assert.equal((await noSpace.json()).code,'MEDIA_DISK_RESERVE');
  assert.equal(app.repository.db.prepare('SELECT COUNT(*) n FROM article_media_uploads').get().n,0);
  fs.statfsSync=previous;
  const created=await(await create('valid.png',seed.bytes)).json(),url=`${base}/uploads/${created.id}`;
  fs.statfsSync=()=>({bavail:1n,bsize:1n});
  const chunkNoSpace=await fetch(`${url}/chunks/0`,{method:'PUT',headers:{authorization:'Bearer fault-local-token','x-chunk-sha256':seed.hash},body:seed.bytes});
  assert.equal(chunkNoSpace.status,507);assert.equal((await chunkNoSpace.json()).code,'MEDIA_DISK_RESERVE');
  fs.statfsSync=previous;
  assert.deepEqual((await(await fetch(url,{headers})).json()).progress.receivedChunks,[]);
  const tooLarge=Buffer.alloc(8*1024*1024+1);
  const limited=await fetch(`${url}/chunks/0`,{method:'PUT',headers:{authorization:'Bearer fault-local-token','x-chunk-sha256':mediaHash(tooLarge)},body:tooLarge});
  assert.equal(limited.status,413);assert.deepEqual((await(await fetch(url,{headers})).json()).progress.receivedChunks,[]);
  assert.equal((await fetch(`${url}/chunks/0`,{method:'PUT',headers:{authorization:'Bearer fault-local-token','x-chunk-sha256':seed.hash},body:seed.bytes})).status,200);
  const saved=await(await fetch(`${url}/complete`,{method:'POST',headers,body:'{}'})).json();assert.equal(saved.state,'pending_confirmation');
  const giant=await sharp({create:{width:6500,height:6500,channels:3,background:'#ffffff'}}).png().toBuffer();
  const pixels=await(await create('too-many-pixels.png',giant)).json();
  assert.equal((await fetch(`${base}/uploads/${pixels.id}/chunks/0`,{method:'PUT',headers:{authorization:'Bearer fault-local-token','x-chunk-sha256':mediaHash(giant)},body:giant})).status,200);
  const rejected=await fetch(`${base}/uploads/${pixels.id}/complete`,{method:'POST',headers,body:'{}'});assert.ok(rejected.status>=400);
  const state=await(await fetch(`${base}/uploads/${pixels.id}`,{headers})).json();
  assert.equal(state.state,'failed');assert.equal(state.asset_id,null);assert.ok(state.progress.receipt.storageRef);
  assert.equal(app.repository.db.prepare('SELECT COUNT(*) n FROM model_call_metrics').get().n,0);
  console.log(JSON.stringify({status:'PASS',application_413:limited.status,disk_preflight:noSpace.status,disk_chunk:chunkNoSpace.status,
    successful_retry:saved.state,resource_pixels:6500*6500,oversized_decode_state:state.state,failed_original_retained:true,provider_calls:0}));
});
