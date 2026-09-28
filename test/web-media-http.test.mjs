import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {WordPressDraftAdapter} from '../src/wordpress.mjs';
import {mediaHash} from '../src/web-media.mjs';

test('loopback HTTP receiver stores independent bytes, transforms output, loses receipt and returns invalid responses',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cms-b-http-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let mode='normal',posts=0,uploadedHash;
  const remoteFile=path.join(dir,'receiver.png');
  const server=http.createServer(async(req,res)=>{
    if(req.method==='GET'){res.setHeader('content-type','image/png');res.end(fs.readFileSync(remoteFile));return;}
    posts++;const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const bytes=Buffer.concat(chunks);uploadedHash=mediaHash(bytes);
    const publicBytes=await sharp(bytes).resize({width:480,withoutEnlargement:true}).png().toBuffer();
    fs.writeFileSync(remoteFile,publicBytes);
    if(mode==='lost'){req.socket.destroy();return;}
    res.setHeader('content-type','application/json');
    if(mode==='error'){res.statusCode=500;res.end(JSON.stringify({message:'controlled failure'}));return;}
    const dimensions=await sharp(publicBytes).metadata();
    res.end(JSON.stringify({id:mode==='invalid-id'?'invalid':posts,source_url:mode==='private'?'http://127.0.0.1/private':'https://receiver.test/public.png',
      mime_type:mode==='missing-mime'?undefined:'image/png',media_details:{width:dimensions.width,height:dimensions.height}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}`;
  const bytes=await sharp({create:{width:1800,height:900,channels:3,background:'#228844'}}).jpeg().toBuffer();
  const master=path.join(dir,'master.jpg');fs.writeFileSync(master,bytes);
  const visual={id:'http',media_path:master,image_type:'real_world_photo',media_metadata:{quality_qa:{status:'passed',file_hash:mediaHash(bytes)}}};
  const adapter=new WordPressDraftAdapter({siteUrl:url,username:'fixture',applicationPassword:'fixture',mediaDir:dir});
  const result=await adapter.uploadMedia(visual);
  assert.equal(result.metadata.upload_bytes_hash,uploadedHash);assert.equal(result.metadata.served_asset_hash,null);
  assert.equal(result.metadata.width,480);assert.notEqual(mediaHash(fs.readFileSync(remoteFile)),uploadedHash);
  for(mode of ['lost','error','private','invalid-id','missing-mime']) {
    const before=posts;
    await assert.rejects(adapter.uploadMedia(visual),{code:'MEDIA_UPLOAD_OUTCOME_UNKNOWN',retryable:false});
    assert.equal(posts,before+1,'the adapter must not blindly retry an unknown upload');
  }
  fs.unlinkSync(master);
  const served=Buffer.from(await (await fetch(`${url}/public.png`)).arrayBuffer());
  assert.equal(mediaHash(served),mediaHash(fs.readFileSync(remoteFile)));
  assert.equal((await sharp(served).metadata()).width,480);
  // No CMS server or database is needed for the independent receiver GET.
});
