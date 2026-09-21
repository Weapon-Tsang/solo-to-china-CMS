import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { loadConfig } from '../src/config.mjs';
import { openDatabase } from '../src/db.mjs';
import { createApplication } from '../src/server.mjs';

if (process.argv[2] !== '--isolated-fixture') throw new Error('Only an isolated fixture is allowed.');
const source=path.resolve('output/v3-preview/cms-preview.sqlite');
if (!fs.existsSync(source)) throw new Error('Production-shaped fixture is absent.');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'stc-admin-http-'));
const databasePath=path.join(directory,'work.sqlite');
fs.copyFileSync(source,databasePath);
const migrated=openDatabase(databasePath);
const sourceInsert=migrated.prepare(`INSERT INTO sources(id,adapter,canonical_url,title,captured_at,raw_text,raw_html,
  raw_payload_json,content_hash,created_at,updated_at) VALUES (?,'xiaohongshu',?,?,?,'fixture','','{}',?,?,?)`);
const knowledgeInsert=migrated.prepare(`INSERT INTO knowledge_facts(id,destination_id,normalized_key,subject,predicate,
  consensus_status,preferred_value,support_count,contradiction_count,evidence_json,updated_at,canonical_subject,entity_key)
  VALUES (?,'bench-city',?,?,'visitor_tip','single_source',?,1,0,'[]',?,?,?)`);
migrated.exec("INSERT OR IGNORE INTO destinations(id,slug,name,created_at,updated_at) VALUES ('bench-city','bench-city','Benchmark City','2026-09-21','2026-09-21')");
migrated.exec('BEGIN IMMEDIATE');
try {
  for(let index=0;index<400;index++) {
    const stamp=new Date(Date.UTC(2026,8,21,0,0,index)).toISOString();
    sourceInsert.run(`bench-source-${index}`,`https://example.test/source/${index}`,`Benchmark source ${index}`,
      stamp,`hash-${index}`,stamp,stamp);
  }
  for(let index=0;index<5000;index++) knowledgeInsert.run(`bench-fact-${index}`,
    `bench.place.${index % 300}.fact.${index}`,`Benchmark Place ${index % 300}`,`Value ${index}`,
    '2026-09-21',`Benchmark Place ${index % 300}`,`bench.place.${index % 300}`);
  migrated.exec('COMMIT');
} catch(error) { migrated.exec('ROLLBACK'); throw error; }
migrated.close();
const app=createApplication(loadConfig({HOST:'127.0.0.1',PORT:'0',DATABASE_PATH:databasePath,
  CMS_PROCESS_ROLE:'api',MAINTENANCE_ENABLED:'false',LOG_LEVEL:'error'}));
const delay=monitorEventLoopDelay({resolution:10});
const p=(values,percentile)=>values.slice().sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*percentile)-1)] || 0;
try {
  await app.start();
  const base=`http://127.0.0.1:${app.server.address().port}`;
  if (process.argv.includes('--serve')) {
    process.stdout.write(`${base}\n`);
    await new Promise((resolve)=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});
  } else {
  let sql=0,prepares=0;
  const original=app.repository.db.prepare.bind(app.repository.db);
  app.repository.db.prepare=(...args)=>{
    prepares+=1;
    const statement=original(...args);
    return new Proxy(statement,{get(target,property){
      const value=Reflect.get(target,property);
      if (typeof value!=='function') return value;
      return (...params)=>{
        if (['get','all','run','iterate'].includes(property)) sql+=1;
        return value.apply(target,params);
      };
    }});
  };
  delay.enable();
  const routes=['/api/sources?limit=20','/api/content?limit=20',
    '/api/recommendations?limit=20','/api/knowledge/subjects?limit=20',
    '/api/commercial?limit=20','/api/settings','/api/dashboard/summary'];
  const results=[];
  for (const route of routes) {
    const samples=[];
    for (let index=0;index<31;index+=1) {
      sql=0;prepares=0;
      const started=performance.now();
      const response=await fetch(base+route,{headers:{'cache-control':index?'max-age=30':'no-cache'}});
      const bytes=Buffer.byteLength(await response.text());
      samples.push({ms:performance.now()-started,bytes,sql,prepares,status:response.status});
    }
    results.push({route,requestCount:samples.length,errorCount:samples.filter((x)=>x.status>=400).length,
      coldMs:Number(samples[0].ms.toFixed(2)),maxMs:Number(Math.max(...samples.map((x)=>x.ms)).toFixed(2)),
      coldBytes:samples[0].bytes,totalBytes:samples.reduce((sum,x)=>sum+x.bytes,0),
      coldSql:samples[0].sql,coldPrepares:samples[0].prepares,
      warmP50Ms:Number(p(samples.slice(1).map((x)=>x.ms),0.5).toFixed(2)),
      warmP95Ms:Number(p(samples.slice(1).map((x)=>x.ms),0.95).toFixed(2)),
      warmBytes:samples.at(-1).bytes,warmSql:samples.at(-1).sql,warmPrepares:samples.at(-1).prepares,
      statusCodes:[...new Set(samples.map((x)=>x.status))]});
  }
  delay.disable();
  process.stdout.write(JSON.stringify({fixture:'isolated synthetic production-shaped data',role:'api',
    requests:results.reduce((sum,item)=>sum+item.requestCount,0),
    eventLoopDelayP95Ms:Number((delay.percentile(95)/1e6).toFixed(2)),
    eventLoopDelayMaxMs:Number((delay.max/1e6).toFixed(2)),results},null,2)+'\n');
  }
} finally {
  delay.disable();
  await app.stop();
  fs.rmSync(directory,{recursive:true,force:true});
}
