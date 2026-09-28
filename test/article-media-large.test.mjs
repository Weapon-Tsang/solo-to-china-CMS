import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {repositoryFixture} from '../test-support/repository-fixture.mjs';
import {seedCoverFixture} from '../test-support/cover-fixture.mjs';
import {ArticleMediaService} from '../src/services/article-media.mjs';
import {mediaHash} from '../src/web-media.mjs';

test('large actual PNG exceeds former inline ceiling; 128/512 MiB transport fixtures stream and remain quarantined',async t=>{
  const f=repositoryFixture(t),seed=await seedCoverFixture(f.repository,f.directory);
  const service=new ArticleMediaService(f.repository,{mediaDir:path.join(f.directory,'media'),captureMediaUploads:{uploadDir:path.join(f.directory,'uploads'),storageDir:path.join(f.directory,'sources')}});
  const image=await sharp(randomBytes(3200*2400*3),{raw:{width:3200,height:2400,channels:3}}).png({compressionLevel:0}).toBuffer();
  assert.ok(image.length>20*1024*1024);
  const session=await service.create(seed.draftId,{expected_revision:2,name:'large-valid.png',mimeType:'image/png',size:image.length,sha256:mediaHash(image)},'editor');
  for(let i=0;i<session.upload.chunkCount;i++){const part=image.subarray(i*session.upload.chunkBytes,(i+1)*session.upload.chunkBytes);await service.chunk(seed.draftId,session.id,i,part,'editor',mediaHash(part));}
  const receipt=await service.complete(seed.draftId,session.id,'editor');assert.equal(receipt.state,'pending_confirmation');assert.equal(receipt.receipt.sizeBytes,image.length);
  const reports=[];
  for(const mib of [128,512]){
    const size=mib*1024*1024,chunk=Buffer.alloc(8*1024*1024),first=Buffer.from(chunk);first.set(image.subarray(0,32));
    const digest=createHash('sha256');for(let i=0;i<mib/8;i++)digest.update(i?chunk:first);
    const session=await service.create(seed.draftId,{expected_revision:2,name:`transport-${mib}.png`,mimeType:'image/png',size,sha256:digest.digest('hex')},'editor');
    const before=process.memoryUsage().rss,started=performance.now();let peak=before;
    for(let i=0;i<session.upload.chunkCount;i++){const part=i?chunk:first;await service.chunk(seed.draftId,session.id,i,part,'editor',mediaHash(part));peak=Math.max(peak,process.memoryUsage().rss);}
    await assert.rejects(service.complete(seed.draftId,session.id,'editor'));
    const stored=await service.status(seed.draftId,session.id,'editor');assert.equal(stored.state,'failed');assert.equal(stored.progress.receipt.sizeBytes,size);
    assert.equal(stored.asset_id,null);assert.ok(fs.existsSync(path.join(service.uploads.storageRoot,stored.progress.receipt.storageRef)));
    reports.push({fixture:'transport-only, intentionally invalid pixels',mib,chunk_bytes:session.upload.chunkBytes,rss_before:before,rss_peak:peak,elapsed_ms:Math.round(performance.now()-started),state:stored.state});
  }
  console.log(JSON.stringify({large_valid_image:{bytes:image.length,width:3200,height:2400},transport:reports}));
});
