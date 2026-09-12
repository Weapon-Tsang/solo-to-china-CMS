import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db.mjs";
import { Repository } from "../src/repository.mjs";
import { runNodeJsonProcess } from "../src/process-runner.mjs";

const directory=fs.mkdtempSync(path.join(os.tmpdir(),"stc-knowledge-benchmark-"));
const databasePath=path.join(directory,"benchmark.sqlite");
const uploads=path.join(directory,"uploads");fs.mkdirSync(uploads);
const database=openDatabase(databasePath);const repository=new Repository(database,{sourceUploadsDir:uploads});
try{
  const claimCount=Math.max(20,Math.min(500,Number(process.argv[2]||120)));
  for(let sourceIndex=0;sourceIndex<2;sourceIndex+=1){
    const source=repository.saveCapture({adapter:"manual",externalId:`benchmark-${sourceIndex}`,
      canonicalUrl:`https://example.com/benchmark-${sourceIndex}`,title:`Benchmark ${sourceIndex}`,authorName:`author-${sourceIndex}`,
      authorUrl:"",publishedAt:"2026-09-10T00:00:00.000Z",capturedAt:"2026-09-11T00:00:00.000Z",
      rawText:"Synthetic benchmark evidence. ".repeat(200),rawHtml:"",sourceKind:"manual_text",assets:[],files:[],
      completeness:{overall:"complete"},rights:{},client:{}});
    repository.saveExtraction(source.id,{source:{language:"en",summary:"Benchmark",destination_name:"Benchmark",destination_slug:"benchmark",
      traveler_fit:[],practical_tips:[],warnings:[],confidence:.95},claims:Array.from({length:claimCount},(_,index)=>{
        const place=Math.floor(index/2),price=index%2===0;
        return {key:`attraction.place_${place}.${price?'ticket_price':'opening_time'}`,subject:`Place ${place}`,
          predicate:price?"ticket_price":"opening_time",value:price?`${20+place} CNY`:`${8+place%4}:00`,
          qualifiers:[],source_quote:price?`Price ${20+place} CNY`:`Opens ${8+place%4}:00`,confidence:.9};}),
      blueprint:{format:"guide",hook:"benchmark",angle:"benchmark",sections:[],strengths:[],gaps:[]}},"benchmark","benchmark");
  }
  database.prepare("DELETE FROM jobs").run();
  repository.rebuildKnowledge("benchmark");repository.rebuildTopicClusters("benchmark");repository.rebuildKnowledgeOpportunities("benchmark");
  const facts=repository.knowledgeForDestination("benchmark");
  const fullStarted=performance.now();const fullUpdated=repository.rebuildCoverageMatrices("benchmark");const fullMs=performance.now()-fullStarted;
  const changedKey=facts[Math.floor(facts.length/2)]?.normalized_key;
  const incrementalStarted=performance.now();const incrementalUpdated=repository.rebuildCoverageMatrices("benchmark",{changedFactKeys:[changedKey]});
  const incrementalMs=performance.now()-incrementalStarted;
  const sampleSource=database.prepare("SELECT id FROM sources ORDER BY id LIMIT 1").get();
  const compact=repository.getIntakePackage(sampleSource.id);
  const legacyBytes=Buffer.byteLength(JSON.stringify(repository.knowledgeForDestination("benchmark").slice(0,80)));
  const compactBytes=Buffer.byteLength(JSON.stringify(compact));

  const server=http.createServer((request,response)=>{response.writeHead(200,{"content-type":"application/json"});response.end('{"ready":true}');});
  await new Promise((resolve)=>server.listen(0,"127.0.0.1",resolve));
  const url=`http://127.0.0.1:${server.address().port}`;
  const busyScript=path.join(directory,"busy-worker.mjs");
  fs.writeFileSync(busyScript,"const until=Date.now()+800; while(Date.now()<until){}; console.log(JSON.stringify({ok:true}))");
  const worker=runNodeJsonProcess(busyScript,[],{timeoutMs:5_000});
  const latencies=[];
  while(latencies.length<30){const started=performance.now();await fetch(url);latencies.push(performance.now()-started);await new Promise((resolve)=>setTimeout(resolve,10));}
  await worker;latencies.sort((a,b)=>a-b);
  fs.writeFileSync(path.join(uploads,"backup-load.bin"),Buffer.alloc(32*1024*1024,7));
  const backupScript=fileURLToPath(new URL('../src/backup.mjs',import.meta.url));
  let backupDone=false;
  const backupPromise=runNodeJsonProcess(backupScript,[databasePath,path.join(directory,"backups")],{timeoutMs:120_000,env:{
    SOURCE_UPLOADS_DIR:uploads,GENERATED_MEDIA_DIR:path.join(directory,"generated"),BACKUP_RETENTION:"1",BACKUP_REASON:"benchmark",
  }}).finally(()=>{backupDone=true;});
  const backupLatencies=[];
  while(!backupDone||backupLatencies.length<10){const started=performance.now();await fetch(url);backupLatencies.push(performance.now()-started);
    await new Promise((resolve)=>setTimeout(resolve,10));}
  const backup=await backupPromise;backupLatencies.sort((a,b)=>a-b);await new Promise((resolve)=>server.close(resolve));
  const result={claimCount,factCount:facts.length,opportunityCount:database.prepare("SELECT COUNT(*) n FROM content_opportunities").get().n,
    coverage:{full:{durationMs:round(fullMs),updated:fullUpdated},incremental:{durationMs:round(incrementalMs),updated:incrementalUpdated},
      speedup:round(fullMs/Math.max(.01,incrementalMs))},intake:{legacyBytes,compactBytes,reductionPercent:round((1-compactBytes/legacyBytes)*100)},
    isolatedWorkerHealth:{samples:latencies.length,p50Ms:round(percentile(latencies,.5)),p95Ms:round(percentile(latencies,.95)),maxMs:round(Math.max(...latencies))},
    isolatedBackupHealth:{samples:backupLatencies.length,p50Ms:round(percentile(backupLatencies,.5)),p95Ms:round(percentile(backupLatencies,.95)),
      maxMs:round(Math.max(...backupLatencies)),backupBytes:backup.bytes,verified:backup.integrity==="ok"}};
  process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
}finally{database.close();fs.rmSync(directory,{recursive:true,force:true});}

function percentile(values,p){return values[Math.min(values.length-1,Math.floor(values.length*p))]||0;}
function round(value){return Math.round(value*100)/100;}
