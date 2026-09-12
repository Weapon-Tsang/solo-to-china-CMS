import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AsyncSemaphore } from '../extension/sync-core.js';
import { CaptureMediaUploadManager } from '../src/capture-media-upload.mjs';
import { ContentEngine } from '../src/ai/content-engine.mjs';
import { png } from '../test-support/media-fixtures.mjs';
import { DerivativeCache } from '../extension/derivative-cache.js';
import { indexedDB } from 'fake-indexeddb';

test('small work bypasses a blocked large reservation; resizing and cancellation release waiting budgets',async()=>{
  const pool=new AsyncSemaphore(10,{maxBypasses:2});const active=await pool.acquire(6);
  const large=pool.acquire(6);const small=await pool.acquire(4);assert.equal(pool.active,10);
  small();active();const releaseLarge=await large;assert.equal(pool.active,6);
  const queued=pool.acquire(6);const rejected=assert.rejects(queued,{code:'MEDIA_MEMORY_BUDGET_CHANGED'});
  pool.setLimit(4);await rejected;releaseLarge();assert.equal(pool.active,0);
  const held=await pool.acquire(4);const controller=new AbortController();
  const cancelled=pool.acquire(1,controller.signal);controller.abort();await assert.rejects(cancelled);held();
  assert.equal(pool.waiters.length,0);const last=await pool.acquire(4);last();assert.equal(pool.active,0);
});

test('derived media cache separates original hashes, transform parameters and converter versions and evicts only cached derivatives',async()=>{
  const cache=new DerivativeCache({name:'cache-budget-fixture',maxBytes:100,factory:indexedDB});
  const transform={converterVersion:'v1',width:2048};
  const key=cache.key('original-a',transform);
  assert.equal(key,cache.key('original-a',{width:2048,converterVersion:'v1'}));
  assert.notEqual(key,cache.key('original-a',{...transform,converterVersion:'v2'}));
  assert.notEqual(key,cache.key('original-b',transform));
  await cache.save(key,{bytes:new Uint8Array(80),sha256:'fixture'});
  assert.equal((await new DerivativeCache({name:cache.name,maxBytes:100,factory:indexedDB}).get(key)).bytes.length,80);
  const next=cache.key('original-b',transform);await cache.save(next,{bytes:new Uint8Array(80)});
  assert.equal(await cache.get(key),null);assert.equal((await cache.get(next)).bytes.length,80);
});

test('temporary cleanup previews expired fragments, skips active sessions and retains originals and receipts',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'stc-upload-cleanup-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const manager=new CaptureMediaUploadManager({uploadDir:path.join(root,'chunks'),storageDir:path.join(root,'stored')});
  const input={protocolVersion:2,kind:'image',mimeType:'image/png',size:png.length,sha256:createHash('sha256').update(png).digest('hex')};
  const pending=await manager.create(input);await manager.writeChunk(pending.uploadId,0,png,pending.uploadToken);
  const metadataFile=path.join(manager.directory(pending.uploadId),'upload.json');const metadata=JSON.parse(fs.readFileSync(metadataFile));metadata.createdAt='2020-01-01';fs.writeFileSync(metadataFile,JSON.stringify(metadata));
  await assert.rejects(manager.status(pending.uploadId,pending.uploadToken),{code:'MEDIA_UPLOAD_EXPIRED'});
  assert.equal((await manager.cleanupExpired({activeUploadIds:[pending.uploadId]})).expiredUploads,0);
  const preview=await manager.cleanupExpired();assert.equal(preview.expiredUploads,1);assert.ok(preview.bytes>=png.length);assert.equal(fs.existsSync(metadataFile),true);
  const complete=await manager.create(input);await manager.writeChunk(complete.uploadId,0,png,complete.uploadToken);const receipt=await manager.complete(complete.uploadId,complete.uploadToken);
  assert.equal((await manager.cleanupExpired({dryRun:false})).removedUploads,1);
  assert.deepEqual(await manager.complete(complete.uploadId,complete.uploadToken),receipt);assert.equal(fs.existsSync(path.join(manager.storageRoot,receipt.storageRef)),true);
});

test('an empty v2 Writing Packet cannot leak unselected live facts, sources, media or narrative into the writer',async()=>{
  let request;
  const engine=new ContentEngine({apiKey:'test',model:'test',baseUrl:'https://api.example.test/v1'},async(_url,options)=>{
    request=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({title:'Test',slug:'test',body_markdown:'A useful evidence-limited observation.',meta_description:'Test',evidence_ledger:[],unresolved_conflicts:[],verification_notes:[],visuals:[],faqs:[],seo:{meta_title:'Test',focus_keyword:'test',secondary_keywords:[],search_intent:'informational',key_takeaways:[]}})}}]}),{headers:{'content-type':'application/json'}});
  });
  await engine.draft({brief:{strategy_version:'3.1'},writing_packet:{packet_text:'Selected grounded observations only.',selected_fact_keys:[],evidence_ledger:[],context:{version:2,narrative_plan:{throughline:'frozen route'},reader_sources:[],authorized_source_assets:[],internal_link_inventory:[]}},
    facts:[{normalized_key:'unselected',preferred_value:'LIVE_PRIVATE_FACT'}],source_reference:{raw_text:'LIVE_SOURCE'},authorized_source_assets:[{alt_text:'LIVE_MEDIA'}],narrative_plan:{throughline:'LIVE_NARRATIVE'}});
  assert.doesNotMatch(JSON.stringify(request),/LIVE_PRIVATE_FACT|LIVE_SOURCE|LIVE_MEDIA|LIVE_NARRATIVE/);
  assert.match(JSON.stringify(request),/frozen route/);
});
