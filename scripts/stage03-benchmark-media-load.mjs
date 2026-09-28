import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {mediaHash} from '../src/web-media.mjs';
import {renderRouteSchematic} from '../src/visuals/route-schematic.mjs';
import {routeFixture} from '../test-support/route-fixture.mjs';

// Only called by the isolated benchmark. Real upload/chunk/finish APIs and the
// real renderer share its API process; no provider, production data or Worker.
export async function startMediaLoad(app,directory) {
  if(!path.basename(directory).startsWith('cms-phase01-bench-'))throw Error('Not an isolated benchmark');
  const root=`http://127.0.0.1:${app.server.address().port}`;
  const api=root+'/api/drafts/draft-0/article-media';
  const raw=Buffer.alloc(3000*2560*3);let value=123;
  for(let i=0;i<raw.length;i++){value^=value<<13;value^=value>>>17;value^=value<<5;raw[i]=value&255;}
  const bytes=await sharp(raw,{raw:{width:3000,height:2560,channels:3}}).png().toBuffer();
  const fileHash=mediaHash(bytes),{bundle}=routeFixture();
  const events=[],memory=[];let stopped=false,failure=null,uploads=0,renders=0;
  const stamp=(type,extra={})=>events.push({type,at:Date.now(),...extra});
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  async function request(url,body,headers={}) {
    const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
    if(!response.ok)throw Error(`Benchmark media HTTP ${response.status}: ${await response.text()}`);
    return response.json();
  }
  const sample=setInterval(()=>memory.push({at:Date.now(),...process.memoryUsage()}),100);
  const waitForStart=async()=>{while(!stopped&&process.argv.includes('--media-load-wait')&&!fs.existsSync(path.join(directory,'.media-load-start')))await delay(50);};
  const renderLoop=(async()=>{
    await waitForStart();
    while(!stopped){stamp('render_start');await renderRouteSchematic(bundle,path.join(directory,'load-render'));renders++;stamp('render_end');await delay(75);}
  })().catch(error=>{failure=String(error);stopped=true;});
  const uploadLoop=(async()=>{
    await waitForStart();
    while(!stopped&&uploads<16){
      stamp('upload_start');
      const upload=await request(api+'/uploads',{expected_revision:1,name:`load-${uploads}.png`,size:bytes.length,sha256:fileHash,mimeType:'image/png'});
      for(let i=0;i<upload.upload.chunkCount;i++) {
        const chunk=bytes.subarray(i*upload.upload.chunkBytes,(i+1)*upload.upload.chunkBytes);
        const response=await fetch(`${api}/uploads/${upload.id}/chunks/${i}`,{method:'PUT',headers:{'content-type':'application/octet-stream','x-chunk-sha256':mediaHash(chunk)},body:chunk});
        if(!response.ok)throw Error(`Chunk HTTP ${response.status}`);stamp('chunk',{index:i,bytes:chunk.length});await delay(100);
      }
      const receipt=await request(`${api}/uploads/${upload.id}/complete`,{});
      if(receipt.receipt.sha256!==fileHash)throw Error('Upload digest mismatch');uploads++;stamp('upload_end');await delay(100);
    }
    if(!stopped)stamp('upload_cap_reached');
  })().catch(error=>{failure=String(error);stopped=true;});
  return {async stop(){stopped=true;await Promise.all([renderLoop,uploadLoop]);clearInterval(sample);
    const report={scope:'same API process: real chunk upload/hash/finish + synthetic approved route PNG renderer',uploads,renders,
      bytesPerUpload:bytes.length,sha256:fileHash,maxFiles:16,failure,events,memory,
      peakRss:Math.max(0,...memory.map(x=>x.rss)),peakHeap:Math.max(0,...memory.map(x=>x.heapUsed))};
    fs.writeFileSync(path.join(directory,'media-load.json'),JSON.stringify(report,null,2));
    if(failure)throw Error(failure);return report;
  }};
}
