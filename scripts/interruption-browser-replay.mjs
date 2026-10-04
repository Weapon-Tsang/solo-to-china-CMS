import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {loadConfig} from '../src/config.mjs';
import {createApplication} from '../src/server.mjs';
import {Pipeline} from '../src/pipeline.mjs';
const dir=path.resolve('output/interruption-recovery-20261004');
const filename=path.join(dir,`browser-${Date.now()}-work.sqlite`);
fs.copyFileSync(path.join(dir,'recovery-work.sqlite'),filename);
const app=createApplication(loadConfig({HOST:'127.0.0.1',PORT:'4379',CMS_PROCESS_ROLE:'api',DATABASE_PATH:filename,
  CMS_DATA_ROOT:dir,SOURCE_UPLOADS_DIR:'C:/s01-restore-20260927/source-uploads',MAINTENANCE_ENABLED:'false',LOG_LEVEL:'error',
  ADMIN_USERNAME:'audit',ADMIN_PASSWORD:'local-audit-only',ADMIN_TOKEN:'local-recovery-audit-only',SESSION_SECRET:'isolated-local-recovery-session-secret'}));
const repo=app.repository,db=repo.db;db.exec('PRAGMA foreign_keys=OFF');
repo.configureProductionCapabilities({frontendContract:true,visuals:true,wordpress:false});
db.prepare("UPDATE jobs SET available_at='2100-01-01',next_eligible_at='2100-01-01' WHERE status IN ('queued','running')").run();
const drafts=db.prepare('SELECT id,body_markdown,content_hash FROM article_drafts').all();
const report={status:'RUNNING',productionWrites:0,providerCalls:0,wordpressWrites:0,completed:[],filename};
// Add the retained settled-recognition failure to the real hall's idle plan.
// This exercises the same guard through the UI; no provider result is invented.
const hall=drafts.find(d=>d.id==='draft_5a78fe03455e44ddac1b009e2301c8cb');
db.prepare("UPDATE media_dispatches SET visual_id='visual_15be323a0d8f40b98263953119d31d35' WHERE id='bc3eda67-f65a-47c4-b82a-adde1b6d41e2'").run();
db.prepare("UPDATE jobs SET last_failure_code='MEDIA_OUTCOME_UNKNOWN' WHERE id='job_606d4cd3a1654b8baa709ead38e927ab'").run();
let busy=false;
const poll=setInterval(async()=>{
  if(busy)return;
  const ready=db.prepare("SELECT id,entity_id FROM jobs WHERE status='queued' AND type='generate_visuals' ORDER BY created_at LIMIT 1").get();
  if(!ready)return;busy=true;
  try{
    // Leave the next stage queued for inspection; no text/image provider or WP adapter exists here.
    db.prepare("UPDATE jobs SET available_at='2100-01-01',next_eligible_at='2100-01-01' WHERE status='queued' AND type<>'generate_visuals'").run();
    const pipeline=new Pipeline(repo,null,{visuals:{enabled:true},frontendContracts:{diagnostics:()=>({canCompose:true})}});
    await pipeline.runOne();
    const job=db.prepare('SELECT status,last_error FROM jobs WHERE id=?').get(ready.id);assert.equal(job.status,'succeeded',job.last_error);
    const next=db.prepare("SELECT id,type,status FROM jobs WHERE entity_id=? AND type='compose_frontend_page' AND status='queued'").all(ready.entity_id);
    assert.equal(next.length,1);
    const before=drafts.find(d=>d.id===ready.entity_id),after=db.prepare('SELECT * FROM article_drafts WHERE id=?').get(ready.entity_id);
    assert.equal(after.body_markdown,before.body_markdown);assert.equal(after.content_hash,before.content_hash);
    report.completed.push({draftId:ready.entity_id,status:job.status,next,bodyPreserved:true});
    if(report.completed.length===2)report.status='PASS';
  }catch(error){report.status='FAIL';report.error=error.message;}
  finally{fs.writeFileSync(path.join(dir,'browser-backend.json'),JSON.stringify(report,null,2));busy=false;}
},750);
await app.start();console.log(JSON.stringify({url:'http://127.0.0.1:4379/',filename,stopFile:path.join(dir,'STOP_BROWSER')}));
const stopPoll=setInterval(()=>{if(fs.existsSync(path.join(dir,'STOP_BROWSER')))void stop();},500);
const deadline=setTimeout(()=>void stop(),20*60_000);
let stopped=false;async function stop(){if(stopped)return;stopped=true;clearInterval(poll);clearInterval(stopPoll);clearTimeout(deadline);await app.stop();}
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
