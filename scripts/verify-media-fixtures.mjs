import http from 'node:http';
import fs from 'node:fs';
import { png, webm } from '../test-support/media-fixtures.mjs';

// Open the printed loopback URL in a real browser. Only synthetic fixtures are
// served; no CMS database, login state, user files or external requests are used.
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Media fixture decoder check</title>
<h1>Media fixture decoder check</h1><img id="image" src="/pixel.png" alt="Red test pixel" width="64" height="64">
<video id="video" src="/frame.webm" muted playsinline controls width="128" height="128"></video><pre id="result">Checking fixtures…</pre>
<script type="module">
const image=document.querySelector('#image'),video=document.querySelector('#video');
const result={browser:navigator.userAgent,png:null,webm:null};
try{await image.decode();result.png={decoded:true,width:image.naturalWidth,height:image.naturalHeight};}
catch(error){result.png={decoded:false,error:String(error)};}
try{
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Video decode deadline')),8000);
    const done=()=>{clearTimeout(timeout);resolve();};
    video.addEventListener('loadeddata',done,{once:true});
    video.addEventListener('error',()=>{clearTimeout(timeout);reject(new Error(video.error?.message||'Video failed'));},{once:true});
    if(video.readyState>=2)done();video.load();
  });
  result.webm={decoded:video.readyState>=2,width:video.videoWidth,height:video.videoHeight,readyState:video.readyState};
}catch(error){result.webm={decoded:false,error:String(error)};}
document.querySelector('#result').textContent=JSON.stringify(result,null,2);
await fetch('/result',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(result)});
</script></html>`;
const server=http.createServer(async(req,res)=>{
  if(req.url==='/pixel.png'){res.writeHead(200,{'content-type':'image/png'});return res.end(png);}
  if(req.url==='/frame.webm'){res.writeHead(200,{'content-type':'video/webm'});return res.end(webm);}
  if(req.url==='/result'&&req.method==='POST') {
    const chunks=[];let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>8192){res.writeHead(413);res.end();return;}chunks.push(chunk);}
    const result=JSON.parse(Buffer.concat(chunks).toString());
    const report={measuredAt:new Date().toISOString(),pngBytes:png.length,webmBytes:webm.length,...result};
    fs.mkdirSync('output/reliability-2026-09-12',{recursive:true});
    fs.writeFileSync('output/reliability-2026-09-12/media-decoder.json',JSON.stringify(report,null,2)+'\n');
    if(!result.png?.decoded||!result.webm?.decoded||result.png.width!==1||result.webm.width!==1)process.exitCode=1;
    console.log(JSON.stringify(report));res.end('Recorded');
    clearTimeout(deadline);setTimeout(()=>server.close(),200);return;
  }
  if(req.url!=='/'){res.writeHead(404);return res.end();}
  res.writeHead(200,{'content-type':'text/html;charset=utf-8'});res.end(html);
});
server.listen(0,'127.0.0.1',()=>console.log(`http://127.0.0.1:${server.address().port}/`));
const deadline=setTimeout(()=>{server.close();process.exitCode=1;},120000);
