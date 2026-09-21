import fs from 'node:fs';
import path from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const option=(name)=>{
  const index=process.argv.indexOf(name);
  return index<0 ? null : process.argv[index+1];
};
const repositoryRoot=path.resolve(option('--repo') || '.');
const database=path.resolve(option('--database') || '');
const output=option('--output');
if (!/(?:work|replay)/i.test(path.basename(database)) || !fs.existsSync(database)) {
  throw new Error('Benchmark requires an existing disposable work/replay database.');
}
const [{loadConfig},{createApplication}]=await Promise.all([
  import(pathToFileURL(path.join(repositoryRoot,'src/config.mjs')).href),
  import(pathToFileURL(path.join(repositoryRoot,'src/server.mjs')).href),
]);
const config=loadConfig({HOST:'127.0.0.1',PORT:'0',DATABASE_PATH:database,
  CMS_PROCESS_ROLE:'api',MAINTENANCE_ENABLED:'false',LOG_LEVEL:'error'});
const app=createApplication(config);
// Older releases did not support API-only mode. Suppress their background
// pipeline in this read-path comparison; the worker-load run is separate.
if (app.pipeline) app.pipeline.start=()=>{};
if (app.maintenance) app.maintenance.start=()=>{};
const delay=monitorEventLoopDelay({resolution:10});
const percentile=(values,q)=>values.slice().sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*q)-1)] || 0;
const routes=option('--routes')?.split(',') || ['/api/sources?limit=20','/api/content?limit=20','/api/recommendations?limit=20',
  '/api/knowledge/subjects?limit=20','/api/commercial?limit=20','/api/settings','/api/dashboard/summary'];
const sampleCount=Math.max(1,Math.min(100,Number(option('--samples') || 31)));
const profileSql=process.argv.includes('--profile-sql');
try {
  await app.start();
  const base=`http://127.0.0.1:${app.server.address().port}`;
  let sql=0;
  const slowStatements=[];
  const prepare=app.repository.db.prepare.bind(app.repository.db);
  app.repository.db.prepare=(...args)=>{
    const statement=prepare(...args);
    return new Proxy(statement,{get(target,property){
      const value=Reflect.get(target,property);
      if (typeof value!=='function') return value;
      return (...params)=>{
        if (['get','all','run','iterate'].includes(property)) sql++;
        const started=profileSql ? performance.now() : 0;
        try {return value.apply(target,params);}
        finally {if(profileSql && started) slowStatements.push({ms:Number((performance.now()-started).toFixed(2)),sql:String(args[0]).slice(0,200)});}
      };
    }});
  };
  delay.enable();
  const results=[];
  for (const route of routes) {
    const samples=[];
    for (let index=0;index<sampleCount;index++) {
      sql=0;
      const started=performance.now();
      const response=await fetch(base+route,{headers:{'cache-control':index ? 'max-age=30' : 'no-cache'}});
      const body=await response.arrayBuffer();
      samples.push({ms:performance.now()-started,bytes:body.byteLength,sql,status:response.status});
    }
    const warm=samples.slice(1);
    results.push({route,requests:samples.length,errors:samples.filter((item)=>item.status>=400).length,
      coldMs:Number(samples[0].ms.toFixed(2)),warmP50Ms:Number(percentile(warm.map((item)=>item.ms),0.5).toFixed(2)),
      warmP95Ms:Number(percentile(warm.map((item)=>item.ms),0.95).toFixed(2)),
      maxMs:Number(Math.max(...samples.map((item)=>item.ms)).toFixed(2)),
      coldBytes:samples[0].bytes,warmBytes:warm.at(-1).bytes,totalBytes:samples.reduce((sum,item)=>sum+item.bytes,0),
      coldSql:samples[0].sql,warmSql:warm.at(-1)?.sql ?? samples[0].sql,statusCodes:[...new Set(samples.map((item)=>item.status))]});
  }
  delay.disable();
  const report={repositoryRoot,database,rows:{sources:app.repository.db.prepare('SELECT COUNT(*) n FROM sources').get().n,
    drafts:app.repository.db.prepare('SELECT COUNT(*) n FROM article_drafts').get().n,
    knowledgeFacts:app.repository.db.prepare('SELECT COUNT(*) n FROM knowledge_facts').get().n},
    requestCount:results.reduce((sum,item)=>sum+item.requests,0),
    eventLoopDelayP95Ms:Number((delay.percentile(95)/1e6).toFixed(2)),
    eventLoopDelayMaxMs:Number((delay.max/1e6).toFixed(2)),results,
    ...(profileSql ? {slowStatements:slowStatements.sort((a,b)=>b.ms-a.ms).slice(0,25)} : {})};
  if (output) fs.writeFileSync(path.resolve(output),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} finally {
  delay.disable();
  await app.stop();
}
