import fs from 'node:fs';
import {createHash} from 'node:crypto';
const filename='C:/Users/Mloong/AppData/Local/Temp/cms-c-cover-browser-tYSlha/benchmark-valid.png';
const bytes=fs.readFileSync(filename),sha=data=>createHash('sha256').update(data).digest('hex');
const base='http://127.0.0.1:59200/api/drafts/cover-draft/article-media',headers={authorization:'Bearer cover-local-fixture-token'};
const started=Date.now(),items=[];
for(let file=0;file<4;file++){
  const name=`node-load-${started}-${file}.png`;
  const created=await fetch(`${base}/uploads`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({expected_revision:2,name,size:bytes.length,sha256:sha(bytes),mimeType:'image/png'})});
  if(!created.ok)throw new Error(`create ${created.status}`);
  const upload=await created.json();
  for(let index=0;index<upload.upload.chunkCount;index++){
    const part=bytes.subarray(index*upload.upload.chunkBytes,(index+1)*upload.upload.chunkBytes);
    const result=await fetch(`${base}/uploads/${upload.id}/chunks/${index}`,{method:'PUT',headers:{...headers,'x-chunk-sha256':sha(part)},body:part});
    if(!result.ok)throw new Error(`chunk ${result.status}`);
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  const finished=await fetch(`${base}/uploads/${upload.id}/complete`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{}'});
  if(!finished.ok)throw new Error(`complete ${finished.status}`);
  items.push({id:upload.id,state:(await finished.json()).state});
}
console.log(JSON.stringify({status:'PASS',started,ended:Date.now(),files:items.length,bytes_each:bytes.length,chunk_bytes:8*1024*1024,items}));
