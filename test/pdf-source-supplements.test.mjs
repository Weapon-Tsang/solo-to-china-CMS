import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { pdfFixture } from '../test-support/pdf-supplement-fixture.mjs';
import { sha256 } from '../src/utils.mjs';
import { extractPdfDocument } from '../src/adapters/manual-source.mjs';
import { createBackup,restoreBackup } from '../src/backup.mjs';
import { openDatabase } from '../src/db.mjs';
import { bindingSupportsPhoto } from '../src/repositories/media-bindings.mjs';
import { normalizeVisuals } from '../src/repository.mjs';
import { createApplication } from '../src/server.mjs';
import { loadConfig } from '../src/config.mjs';

test('T02-46a-h: real HTTP receipt, append, confirmation, retrieval, safety and restore',async t=>{
  const f=await pdfFixture();t.after(()=>f.app.stop());
  const {db,repository,parent}=f;
  const headers={authorization:'Bearer pdf-fixture-admin','content-type':'application/json'};
  const request=async(route,body,method=body ? 'POST':'GET',extra={})=>fetch(f.url+route,{method,headers:{...headers,...extra},...(body ? {body:JSON.stringify(body)} : {})});
  const good=async response=>{const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;};
  const endpoint=`/api/source-assets/${parent}/pdf-supplements`;
  const context=await good(await request(endpoint));assert.equal(context.page_count,1);
  assert.equal((await extractPdfDocument(fs.readFileSync(path.join(f.storage,'fixture.pdf')))).pages.length,1);
  assert.equal((await fetch(f.url+endpoint)).status,401);
  assert.equal((await request(endpoint,{},'POST',{origin:'https://evil.invalid'})).status,403);
  const protectedTables=['sources','capture_versions','claims','article_drafts','article_visuals','writing_packets','jobs','model_call_metrics','wordpress_publications'];
  const snapshot=()=>Object.fromEntries(protectedTables.filter(table=>db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table))
    .map(table=>[table,sha256(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()))]));
  const before=snapshot();
  const image=await sharp({create:{width:640,height:480,channels:3,background:'#aabbaa'}}).png().toBuffer();
  const upload=async(bytes=image,hash=sha256(bytes))=>{
    const response=await request('/api/source-supplement-uploads',{size:bytes.length,sha256:hash,mimeType:'image/png'});
    assert.equal(response.status,201);const session=await response.json();if(session.receipt)return session.receipt;
    const base=`/api/source-supplement-uploads/${session.uploadId}`,token={'x-upload-token':session.uploadToken};
    assert.equal((await request(`${base}/complete`,{},'POST',token)).status,409);
    assert.deepEqual((await good(await request(base,null,'GET',token))).receivedChunks,[]);
    assert.equal((await request(base,null,'GET',{'x-upload-token':'incorrect'})).status,403);
    for(let i=0;i<session.chunkCount;i++) assert.equal((await fetch(f.url+`${base}/chunks/${i}`,{method:'PUT',headers:{...headers,...token},body:bytes.subarray(i*session.chunkBytes,(i+1)*session.chunkBytes)})).status,200);
    const result=await request(`${base}/complete`,{},'POST',token);
    if(result.status!==200)return result;
    const receipt=await result.json();assert.deepEqual((await good(await request(base,null,'GET',token))).receipt,receipt);return receipt;
  };
  const receipt=await upload();assert.equal(receipt.sha256,sha256(image));
  const input={context_hash:context.context_hash,idempotency_key:'first_occurrence_0001',filename:'hall.png',receipt};
  const first=await good(await request(endpoint,input));
  assert.equal(first.supplement.state,'pending_confirmation');
  assert.equal((await good(await request(endpoint,input))).asset_id,first.asset_id);
  assert.equal((await request(endpoint,{...input,receipt:{...receipt,sha256:'0'.repeat(64)}})).status,400);
  assert.equal((await request(endpoint,{...input,context_hash:'stale'})).status,409);
  const confirm=`${endpoint}/${first.asset_id}/confirm`;
  const evidence={context_hash:context.context_hash,page:1,caption:'Photo depicts Huguang Guild Hall.',role:'documentary_photo'};
  assert.equal((await request(confirm,{...evidence,page:2})).status,400);
  const confirmed=await good(await request(confirm,evidence));
  assert.equal(confirmed.supplement.state,'confirmed');assert.equal(confirmed.bindings.new_bindings[0].status,'confirmed');
  await good(await request(confirm,evidence));
  const row=db.prepare('SELECT * FROM source_assets WHERE id=?').get(first.asset_id);
  assert.equal(row.width,640);assert.equal(row.height,480);assert.equal(sha256(fs.readFileSync(row.local_path)),sha256(image));
  const candidates=repository.authorizedSourceAssetsForBrief({destination_slug:'chongqing',topic:'Huguang Guild Hall',supporting_facts:[]});
  assert.ok(candidates.some(item=>item.id===first.asset_id));
  const planned=normalizeVisuals([{source_asset_id:first.asset_id,image_type:'real_world_photo',image_subject:'Huguang Guild Hall',
    purpose:'Huguang Guild Hall scene',required:true,media_metadata:{media_purpose:'stop_photo'}}],
    {id:'supplement-plan',title:'Huguang Guild Hall',body_markdown:'Huguang Guild Hall scene',strategy_version:'3.8'},
    {destination_slug:'chongqing',topic:'Huguang Guild Hall'},candidates,{content_type:'itinerary',visuals:{target:1,maximum:5}});
  assert.equal(planned[0].source_asset_id,first.asset_id);
  assert.equal(planned[0].media_metadata.required_visual_gap,null);
  assert.ok(planned[0].media_metadata.authorized_asset_match.source_binding_ids.length);
  assert.equal(bindingSupportsPhoto(repository.sourceAssetDecisionDto(first.asset_id),{entity_key:'hall',media_purpose:'stop_photo'}),true);
  assert.equal(bindingSupportsPhoto(repository.sourceAssetDecisionDto(parent),{entity_key:'hall'}),false);
  const second=await good(await request(endpoint,{...input,idempotency_key:'second_occurrence_0002'}));
  assert.notEqual(second.asset_id,first.asset_id);
  await good(await request(`${endpoint}/${second.asset_id}/confirm`,{...evidence,page:null,caption:'Uncertain topic supplement',role:'unknown'}));
  assert.equal(repository.sourceAssetDecisionDto(second.asset_id).source_bindings.length,0);
  assert.equal((await good(await request(endpoint))).supplements.length,2);
  const conflict=await good(await request(endpoint,{...input,idempotency_key:'conflict_occurrence_003'}));
  await good(await request(`${endpoint}/${conflict.asset_id}/confirm`,{...evidence,caption:'Photo depicts Huguang Guild Hall. Photo is not Huguang Guild Hall.'}));
  assert.equal(bindingSupportsPhoto(repository.sourceAssetDecisionDto(conflict.asset_id),{entity_key:'hall'}),false);
  assert.equal(bindingSupportsPhoto(repository.sourceAssetDecisionDto(first.asset_id),{entity_key:'hall'}),false);
  assert.equal((await request(`${endpoint}/not_this_pdf_asset/confirm`,evidence)).status,400);
  assert.deepEqual(snapshot(),before);
  const bad=await upload(Buffer.from('not an image'));assert.equal(bad.status,400);
  const brokenHash=await upload(image,'a'.repeat(64));assert.equal(brokenHash.status,400);
  const backup=createBackup({databasePath:f.databasePath,backupDir:path.join(f.directory,'backups'),
    sourceUploadsDir:f.storage,captureMediaUploadsDir:f.config.captureMediaUploads.uploadDir});
  const restored=restoreBackup(backup.backupPath,path.join(f.directory,'restored'));
  assert.equal(restored.mode,'migration-review');
  assert.throws(()=>createApplication(loadConfig({CMS_RUN_MODE:'migration-review',CMS_DATA_ROOT:path.join(f.directory,'restored'),
    DATABASE_PATH:restored.databasePath,HOST:'127.0.0.1',PORT:'0',CMS_PROCESS_ROLE:'api'})),/read.only/);
  const copy=openDatabase(restored.databasePath,{migrate:false});
  try {
    const restoredAsset=copy.prepare('SELECT * FROM source_assets WHERE id=?').get(first.asset_id);
    assert.equal(sha256(fs.readFileSync(restoredAsset.local_path)),sha256(image));
    assert.deepEqual(JSON.parse(restoredAsset.provenance_json),JSON.parse(row.provenance_json));
    assert.deepEqual(copy.prepare('SELECT * FROM media_bindings ORDER BY id').all(),db.prepare('SELECT * FROM media_bindings ORDER BY id').all());
    const restoredParent=copy.prepare('SELECT * FROM source_assets WHERE id=?').get(parent);
    assert.equal(sha256(fs.readFileSync(restoredParent.local_path)),context.parent_sha256);
    const receiptRoot=path.join(f.directory,'restored','capture-media-uploads');
    const receipts=fs.readdirSync(receiptRoot).filter(name=>fs.existsSync(path.join(receiptRoot,name,'receipt.json')))
      .map(name=>JSON.parse(fs.readFileSync(path.join(receiptRoot,name,'receipt.json'),'utf8')));
    assert.ok(receipts.some(item=>item.sha256===receipt.sha256));
  } finally {copy.close();}
  const oldText=db.prepare('SELECT raw_text FROM sources WHERE id=?').get(f.source.id).raw_text;
  db.prepare('UPDATE sources SET raw_text=? WHERE id=?').run('Changed source text',f.source.id);
  assert.equal((await request(confirm,evidence)).status,409);
  db.prepare('UPDATE sources SET raw_text=? WHERE id=?').run(oldText,f.source.id);
  db.prepare("UPDATE media_bindings SET status='revoked' WHERE asset_id=?").run(first.asset_id);
  await good(await request(confirm,evidence));
  assert.equal(repository.sourceAssetDecisionDto(first.asset_id).source_bindings.length,0);
  db.prepare('UPDATE sources SET capture_version=capture_version+1 WHERE id=?').run(f.source.id);
  assert.equal((await request(confirm,evidence)).status,409);
  console.log(JSON.stringify({directory:f.directory,T02_46:'a-f,h API/restore PASS; browser separately',assets:3,model_calls:0}));
});
