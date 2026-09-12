import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.mjs';
import { loadConfig } from '../src/config.mjs';
import { normalizeXiaohongshuCapture } from '../src/adapters/xiaohongshu.mjs';

// Manual browser verification against synthetic data; never loads .env or starts providers.
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'stc-ui-verification-'));
const app=createApplication(loadConfig({HOST:'127.0.0.1',PORT:'0',DATABASE_PATH:path.join(directory,'cms.sqlite'),
  SOURCE_UPLOADS_DIR:path.join(directory,'sources'),CAPTURE_UPLOADS_DIR:path.join(directory,'captures'),
  CAPTURE_MEDIA_UPLOADS_DIR:path.join(directory,'media'),GENERATED_MEDIA_DIR:path.join(directory,'generated'),LOG_LEVEL:'error'}));
for(let i=0;i<65;i++)app.repository.saveCapture(normalizeXiaohongshuCapture({
  url:`https://www.xiaohongshu.com/explore/uifixture${i}`,
  title:`本地测试来源 ${String(i).padStart(2,'0')}`,text:`这是第 ${i} 个合成测试来源。博物馆成人票价为60元，每天09:00开放。仅用于本地界面回归。`,images:[],videos:[]}));
app.repository.db.prepare('DELETE FROM jobs').run();
const requests=[];
app.server.prependListener('request',(request,response)=>{
  if(!String(request.url).startsWith('/api/'))return;
  const start=Date.now();response.once('finish',()=>requests.push({at:new Date(start).toISOString(),method:request.method,path:String(request.url).split('?')[0],status:response.statusCode,ms:Date.now()-start}));
});
await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
const durationMs=Math.max(30_000,Math.min(30*60_000,Number(process.argv.find(arg=>arg.startsWith('--duration-ms='))?.split('=')[1])||180_000));
console.log(JSON.stringify({origin:`http://127.0.0.1:${app.server.address().port}`,fixtureSources:65,durationMs,externalProvidersStarted:false}));
let closed=false;
async function close(){
  if(closed)return;closed=true;clearTimeout(deadline);
  await new Promise(resolve=>app.server.close(resolve));app.repository.db.close();
  const output=path.resolve('output/reliability-2026-09-12/ui-http.json');fs.mkdirSync(path.dirname(output),{recursive:true});
  fs.writeFileSync(output,JSON.stringify({verifiedAt:new Date().toISOString(),requests,scope:'Synthetic 65-source isolated CMS; HTTP observations only. UI assertions recorded separately.'},null,2)+'\n');
  if(path.dirname(directory)!==path.resolve(os.tmpdir())||!path.basename(directory).startsWith('stc-ui-verification-'))throw new Error('Unsafe fixture cleanup target');
  fs.rmSync(directory,{recursive:true,force:true});console.log(output);process.stdin.pause();
}
const deadline=setTimeout(close,durationMs);
process.stdin.on('data',()=>void close());
process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
