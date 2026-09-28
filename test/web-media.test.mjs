import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {prepareWebMedia,mediaHash} from '../src/web-media.mjs';
import {responsiveImageAttributes,wordpressMediaMetadata,publicMediaUrl} from '../src/media-delivery.mjs';
import {WordPressDraftAdapter} from '../src/wordpress.mjs';

function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cms-b-web-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
async function input(t,{width=2000,height=1000,format='jpeg',alpha=false,orientation=null}={}) {
  let image=sharp({create:{width,height,channels:alpha?4:3,background:alpha?'#22669966':'#226699'}});
  if(orientation)image=image.withMetadata({orientation});
  const bytes=await image[format]().toBuffer();
  return {bytes,contentType:`image/${format}`,outputDir:fixture(t),qa:{status:'passed',file_hash:mediaHash(bytes)}};
}

test('real JPEG/PNG/WebP decode, EXIF orientation, alpha, source identity and immutable master QA',async t=>{
  for(const format of ['jpeg','png','webp']) {
    const source=await input(t,{format,orientation:6,alpha:format!=='jpeg'});
    const before=mediaHash(source.bytes),qa=structuredClone(source.qa);
    const result=await prepareWebMedia(source),meta=await sharp(result.bytes).metadata();
    assert.deepEqual([meta.width,meta.height],[1000,2000]);assert.equal(meta.exif,undefined);
    assert.equal(meta.hasAlpha,format!=='jpeg');assert.equal(mediaHash(source.bytes),before);
    assert.deepEqual(source.qa,qa);assert.equal(result.receipt.parent_hash,before);
    assert.notEqual(result.receipt.sha256,before);assert.equal(result.receipt.semantic_qa_inherited_from,before);
  }
});
test('photos downscale without enlargement; dense text keeps pixels with lossless output',async t=>{
  const photo=await prepareWebMedia(await input(t));assert.equal(photo.receipt.width,1600);
  const small=await prepareWebMedia(await input(t,{width:64,height:32}));assert.equal(small.receipt.width,64);
  assert.equal(small.receipt.size_warning.code,'MEDIA_LOW_RESOLUTION');
  const source=await input(t,{width:1900,height:3100,format:'png'});
  const text=await prepareWebMedia({...source,kind:'route'});
  assert.deepEqual([text.receipt.width,text.receipt.height],[1900,3100]);
  assert.deepEqual(await sharp(text.bytes).raw().toBuffer(),await sharp(source.bytes).raw().toBuffer());
  assert.equal(text.receipt.readability,'lossless_no_downscale');
});
test('invalid MIME, broken decode, pixel resource limit and animation are diagnosed without ready files',async t=>{
  const source=await input(t);
  await assert.rejects(prepareWebMedia({...source,contentType:'image/png'}),{code:'MEDIA_MIME_MISMATCH'});
  const bytes=Buffer.from('not an image');
  await assert.rejects(prepareWebMedia({...source,bytes,qa:{status:'passed',file_hash:mediaHash(bytes)}}),{code:'MEDIA_DECODE_FAILED'});
  await assert.rejects(prepareWebMedia({...source,limitInputPixels:20}),{code:'MEDIA_DECODE_RESOURCE_LIMIT'});
  const gif=await sharp({create:{width:8,height:16,channels:3,background:'red'},pageHeight:8}).gif().toBuffer();
  // Explicit two-frame fixture, not a renamed static image.
  const animated=await sharp(Buffer.concat([Buffer.alloc(8*8*3,0),Buffer.alloc(8*8*3,255)]),
    {raw:{width:8,height:16,channels:3,pageHeight:8}}).gif({loop:0,delay:[100,100]}).toBuffer();
  assert.ok(gif.length);assert.equal((await sharp(animated).metadata()).pages,2);
  await assert.rejects(prepareWebMedia({...source,bytes:animated,contentType:'image/gif',
    qa:{status:'passed',file_hash:mediaHash(animated)}}),{code:'MEDIA_ANIMATION_UNSUPPORTED'});
});
test('cache concurrency, transform version, corrupt cache and QA cannot be bypassed by reuse or fallback',async t=>{
  const source=await input(t);
  const results=await Promise.all(Array.from({length:8},()=>prepareWebMedia(source)));
  assert.equal(new Set(results.map(r=>r.receipt.sha256)).size,1);assert.equal(results.filter(r=>r.reused).length,7);
  assert.equal(new Set(results.map(r=>r.receipt.optimized_at)).size,1,'cache reuse preserves the original processing time');
  assert.ok(Number.isFinite(Date.parse(results[0].receipt.optimized_at)));
  const newer=await prepareWebMedia({...source,version:'web-media-test-v2'});
  assert.notEqual(newer.receipt.localPath,results[0].receipt.localPath);
  await assert.rejects(prepareWebMedia({...source,qa:{status:'failed',file_hash:source.qa.file_hash}}),{code:'MEDIA_MASTER_QA_REQUIRED'});
  fs.writeFileSync(results[0].receipt.localPath,'corrupt');
  await assert.rejects(prepareWebMedia(source),{code:'MEDIA_CACHE_INVALID'});
});
test('optimization fallback obeys safe normalized dimensions and retries only encoding',async t=>{
  const source=await input(t,{orientation:3});let calls=0;
  const result=await prepareWebMedia({...source,encoder:async()=>{calls++;throw new Error('encoder unavailable');}});
  assert.equal(result.receipt.warning.code,'WEB_OPTIMIZATION_FAILED');assert.equal(result.receipt.width,1600);
  assert.equal(result.receipt.optimized_at,null,'failed optimization is not reported as fresh success');
  assert.equal((await sharp(result.bytes).metadata()).exif,undefined);
  const retry=await prepareWebMedia(source);assert.equal(retry.receipt.warning,null);assert.equal(calls,1);
});
test('actual crop bytes contain the safe region and preserve master; unsafe crops fail',async t=>{
  const source=await input(t,{width:400,height:600,format:'png'});
  const crop={x:0.25,y:0.25,width:0.5,height:0.5};
  const result=await prepareWebMedia({...source,crop,safeRegion:crop,kind:'text'});
  assert.deepEqual([result.receipt.width,result.receipt.height],[200,300]);
  assert.equal(result.receipt.parent_hash,source.qa.file_hash);
  await assert.rejects(prepareWebMedia({...source,crop,safeRegion:{x:0,y:0,width:1,height:1}}),{code:'MEDIA_CROP_UNSAFE'});
});
test('actual configured adapter uploads derivative bytes and keeps master QA/source identity',async t=>{
  const source=await input(t);const master=path.join(source.outputDir,'master.jpg');fs.writeFileSync(master,source.bytes);
  let posted;
  const adapter=new WordPressDraftAdapter({siteUrl:'https://receiver.test',username:'a',applicationPassword:'b',mediaDir:source.outputDir},async(url,init)=>{
    posted=init.body;return Response.json({id:5,source_url:'https://receiver.test/uploads/file.webp',mime_type:'image/webp',
      media_details:{width:1600,height:800,sizes:{square:{source_url:'https://receiver.test/square.webp',width:150,height:150},
        medium:{source_url:'https://receiver.test/medium.webp',width:600,height:300}}}},{status:201});});
  const visual={id:'v',media_path:master,image_type:'real_world_photo',media_metadata:{quality_qa:source.qa}};
  const result=await adapter.uploadMedia(visual);
  assert.notEqual(mediaHash(posted),source.qa.file_hash);assert.equal(mediaHash(fs.readFileSync(master)),source.qa.file_hash);
  assert.equal(result.metadata.upload_bytes_hash,mediaHash(posted));assert.equal(result.metadata.master_hash,source.qa.file_hash);
  assert.equal(result.metadata.served_asset_hash,null);assert.deepEqual(result.metadata.quality_qa,source.qa);
  assert.doesNotMatch(responsiveImageAttributes(result.metadata).srcset,/square/);
  assert.deepEqual(result.metadata.expected_sizes_missing,[480,768,1200]);
});
test('public URLs reject local/private/signed delivery and remote hashes remain explicitly unknown',()=>{
  for(const url of ['http://localhost/a','http://127.0.0.1/a','http://10.2.3.4/a','http://[::1]/a','https://a.test/a?X-Amz-Signature=x'])
    assert.equal(publicMediaUrl(url),null);
  const result=wordpressMediaMetadata({id:1,source_url:'https://a.test/a',mime_type:'image/png',media_details:{width:100,height:100}},
    {bytes:Buffer.from('upload'),contentType:'image/webp'});
  assert.equal(result.served_hash_status,'unknown_not_read');assert.equal(result.upload_mime,'image/webp');assert.equal(result.mime,'image/png');
});

test('cache binds original provenance and rejects receipt tampering or missing bytes',async t=>{
  const source=await input(t);
  const first=await prepareWebMedia({...source,originalHash:'original-a'});
  const second=await prepareWebMedia({...source,originalHash:'original-b'});
  assert.equal(second.receipt.original_hash,'original-b');
  assert.notEqual(first.receipt.key,second.receipt.key);
  const manifest=path.join(source.outputDir,'web-derivatives',`${first.receipt.key}.json`);
  const receipt=JSON.parse(fs.readFileSync(manifest,'utf8'));
  for(const patch of [{width:1},{bytes:1},{original_hash:'other'},{policy:{...receipt.policy,quality:80}},
    {semantic_qa_inherited_from:'other'},{verification:'unchecked'}]) {
    fs.writeFileSync(manifest,JSON.stringify({...receipt,...patch}));
    await assert.rejects(prepareWebMedia({...source,originalHash:'original-a'}),{code:'MEDIA_CACHE_INVALID'});
  }
  fs.writeFileSync(manifest,JSON.stringify(receipt));
  fs.unlinkSync(first.receipt.localPath);
  await assert.rejects(prepareWebMedia({...source,originalHash:'original-a'}),{code:'MEDIA_CACHE_INVALID'});
});

test('fractional crop rounds outward to retain every safe-region pixel',async t=>{
  const source=await input(t,{width:101,height:103,format:'png'});
  const crop={x:0.25,y:0.25,width:0.5,height:0.5};
  const result=await prepareWebMedia({...source,crop,safeRegion:crop,kind:'text'});
  assert.deepEqual([result.receipt.width,result.receipt.height],[51,53]);
  const expected=await sharp(source.bytes).extract({left:25,top:25,width:51,height:53}).raw().toBuffer();
  assert.deepEqual(await sharp(result.bytes).raw().toBuffer(),expected);
});
