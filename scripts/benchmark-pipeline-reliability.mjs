import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { webm } from '../test-support/media-fixtures.mjs';
import { createApplication } from '../src/server.mjs';
import { loadConfig } from '../src/config.mjs';
import { normalizeXiaohongshuCapture } from '../src/adapters/xiaohongshu.mjs';

const baseline='2395fe4ed68f7414d777d0156770af76e858eb1b';
const root=fileURLToPath(new URL('../',import.meta.url));
const quantile=(values,p)=>values.length?[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.ceil(values.length*p)-1)]:null;
const summarize=values=>({count:values.length,p50:quantile(values,.5),p95:quantile(values,.95),max:values.length?Math.max(...values):null});

if(process.argv[2]==='--worker') {
  const [moduleFile,directory]=process.argv.slice(3);
  const {CaptureMediaUploadManager}=await import(pathToFileURL(moduleFile).href);
  const manager=new CaptureMediaUploadManager({uploadDir:path.join(directory,'chunks'),storageDir:path.join(directory,'media'),chunkBytes:4*1024*1024});
  const app=createApplication(loadConfig({HOST:'127.0.0.1',PORT:'0',DATABASE_PATH:path.join(directory,'cms.sqlite'),
    SOURCE_UPLOADS_DIR:path.join(directory,'source-uploads'),CAPTURE_UPLOADS_DIR:path.join(directory,'capture-uploads'),
    CAPTURE_MEDIA_UPLOADS_DIR:path.join(directory,'capture-media'),GENERATED_MEDIA_DIR:path.join(directory,'generated'),LOG_LEVEL:'error'}));
  // Identical current CMS HTTP/SQLite paths in both variants isolate the
  // finalizer change. No pipeline, model, maintenance or WordPress is started.
  for(let index=0;index<250;index++)app.repository.saveCapture(normalizeXiaohongshuCapture({
    url:`https://www.xiaohongshu.com/explore/bench${index}`,text:`Fixture ${index}: A complete source describing a useful journey and practical choices.`,images:[],videos:[]}));
  const server=app.server;
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  app.repository.db.prepare('DELETE FROM jobs').run();
  app.repository.enqueue('rebuild_editorial','heartbeat-benchmark');
  const leasedJob=app.repository.claimJob();
  const latency=[],apiSamples=[],durations=[],fileDurations=[],loopMax=[],heartbeatGaps=[],heartbeatProgress=[];
  let transferred=0,peakRss=process.memoryUsage().rss;
  const rounds=7, concurrency=4, size=16*1024*1024;
  try {
    for(let round=0;round<rounds;round++) {
      const uploads=[];
      for(let item=0;item<concurrency;item++) {
        const bytes=Buffer.alloc(size,round*concurrency+item);webm.copy(bytes);
        const sha256=createHash('sha256').update(bytes).digest('hex');
        const upload=await manager.create({kind:'video',mimeType:'video/webm',size,sha256});
        for(let offset=0,index=0;offset<size;offset+=upload.chunkBytes,index++)await manager.writeChunk(upload.uploadId,index,bytes.subarray(offset,offset+upload.chunkBytes));
        uploads.push(upload);transferred+=size;
      }
      // Independent event loop: probes continue while the server is blocked.
      const probe=new Worker(`const {parentPort,workerData}=require('node:worker_threads');const http=require('node:http');const {performance}=require('node:perf_hooks');let stop=false;parentPort.on('message',()=>{stop=true;});(async()=>{const samples=[];parentPort.postMessage({ready:true});while(!stop){await Promise.all(workerData.paths.map(async path=>{const start=performance.now();await new Promise((resolve,reject)=>http.get(workerData.origin+path,res=>{res.resume();res.on('end',()=>res.statusCode===200?resolve():reject(new Error('HTTP '+res.statusCode)));}).on('error',reject));samples.push({path,ms:performance.now()-start});}));await new Promise(r=>setTimeout(r,5));}parentPort.postMessage({samples});parentPort.close();})();`,{eval:true,workerData:{origin:`http://127.0.0.1:${server.address().port}`,paths:['/api/health','/api/sources?limit=20','/api/dashboard/summary']}});
      const ready=new Promise(resolve=>probe.once('message',resolve));
      const samples=new Promise((resolve,reject)=>{probe.on('message',message=>{if(message.samples)resolve(message.samples);});probe.on('error',reject);});
      await ready;await new Promise(resolve=>setTimeout(resolve,25));
      const delay=monitorEventLoopDelay({resolution:5});delay.enable();
      const ticks=[],gaps=[];let lastBeat=performance.now();
      const heartbeat=setInterval(()=>{
        const tick=performance.now();
        if(!app.repository.heartbeatJob(leasedJob.id,leasedJob.locked_by,leasedJob.lease_generation))throw new Error('Benchmark job lost lease');
        gaps.push(tick-lastBeat);ticks.push(tick);lastBeat=tick;
      },10);
      await new Promise(resolve=>setTimeout(resolve,20));
      const started=performance.now();
      const perFile=await Promise.all(uploads.map(async upload=>{const begin=performance.now();const receipt=await manager.complete(upload.uploadId);if(receipt.sizeBytes!==size)throw new Error('wrong receipt');peakRss=Math.max(peakRss,process.memoryUsage().rss);return performance.now()-begin;}));
      const elapsed=performance.now()-started;
      await new Promise(resolve=>setTimeout(resolve,15));clearInterval(heartbeat);delay.disable();probe.postMessage('stop');
      const measured=await samples;await probe.terminate();
      if(round>0){durations.push(elapsed);fileDurations.push(...perFile);latency.push(...measured.map(sample=>sample.ms));apiSamples.push(...measured);loopMax.push(delay.max/1e6);heartbeatGaps.push(...gaps);heartbeatProgress.push(ticks.filter(tick=>tick>=started&&tick<=started+elapsed).length);}
    }
    console.log(JSON.stringify({rounds:rounds-1,warmupRounds:1,concurrency,sizeBytes:size,chunkBytes:manager.chunkBytes,
      raw:{finalizeBatchMs:durations,finalizeFileMs:fileDurations,lightHttpMs:latency,apiSamples,eventLoopMaxMs:loopMax,heartbeatGapMs:heartbeatGaps,heartbeatsDuringFinalize:heartbeatProgress},
      finalizeBatchMs:summarize(durations),finalizeFileMs:summarize(fileDurations),lightHttpMs:summarize(latency),eventLoopMaxMs:summarize(loopMax),heartbeatGapMs:summarize(heartbeatGaps),heartbeatsDuringFinalize:heartbeatProgress,
      apiMs:Object.fromEntries([...new Set(apiSamples.map(sample=>sample.path))].map(endpoint=>[endpoint,summarize(apiSamples.filter(sample=>sample.path===endpoint).map(sample=>sample.ms))])),
      peakRssBytes:Math.max(peakRss,process.resourceUsage().maxRSS*1024),uploadedBytes:transferred,providerCalls:0,leaseHeartbeatVerified:Boolean(app.repository.db.prepare('SELECT heartbeat_at FROM jobs WHERE id=?').get(leasedJob.id)?.heartbeat_at)}));
  }finally{await new Promise(resolve=>server.close(resolve));app.repository.db.close();}
}else{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'stc-reliability-benchmark-'));
  const oldModule=path.join(temporary,'baseline-media.mjs');
  fs.writeFileSync(oldModule,execFileSync('git',['show',`${baseline}:src/capture-media-upload.mjs`],{cwd:root}));
  const runs=[];
  try {
    // Alternate order across isolated processes to reduce warm-cache bias.
    for(const [index,variant]of ['baseline','current','current','baseline'].entries()){
      const filename=variant==='baseline'?oldModule:path.join(root,'src','capture-media-upload.mjs');
      const result=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--worker',filename,path.join(temporary,`run-${index}`)],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',errors='';child.stdout.on('data',data=>{output+=data;});child.stderr.on('data',data=>{errors+=data;});child.on('error',reject);child.on('close',code=>{if(code!==0)return reject(new Error(errors));try{resolve(JSON.parse(output));}catch(error){reject(error);}});});
      runs.push({variant,...result});console.log(`${variant}: finalize p95 ${result.finalizeBatchMs.p95.toFixed(1)} ms; light HTTP p95 ${result.lightHttpMs.p95.toFixed(1)} ms`);
    }
    const report={measuredAt:new Date().toISOString(),node:process.version,platform:process.platform,baselineHead:baseline,
      method:'Same synthetic 16 MiB WebM-header payloads, 4 concurrent finalizers, 4 MiB chunks, 1 warmup + 6 measured rounds per process; ABBA process order. Chunk preparation excluded from finalize latency. Independent worker concurrently probes actual current CMS health, sources and dashboard-summary HTTP routes with 250 SQLite sources; both variants use the same current CMS routes to isolate original vs current finalizer I/O. A 10ms timer writes a real claimed SQLite job heartbeat; gaps and ticks inside finalize are measured. No Pipeline.runOne or external clients started. This is storage/heartbeat responsiveness, not full Chrome throughput, semantic queue completion or media decoder validation.',runs};
    const destination=path.join(root,'docs','audit','CMS_PIPELINE_PERFORMANCE_2026-09-12.json');fs.writeFileSync(destination,JSON.stringify(report,null,2)+'\n');console.log(destination);
  }finally{
    // Only the exact fresh OS-temporary workspace is removed; no user media.
    if(path.dirname(temporary)!==path.resolve(os.tmpdir())||!path.basename(temporary).startsWith('stc-reliability-benchmark-'))throw new Error('Unsafe benchmark cleanup target');
    fs.rmSync(temporary,{recursive:true,force:true});
  }
}
