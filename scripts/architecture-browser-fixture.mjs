// Isolated local recovery workflow. No real providers, media services or WordPress.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {loadConfig} from '../src/config.mjs';
import {createApplication} from '../src/server.mjs';
import {Pipeline} from '../src/pipeline.mjs';
import {openDatabase} from '../src/db.mjs';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cms-architecture-browser-'));
const outputDirectory=path.resolve(process.env.CMS_AUDIT_OUTPUT_DIR || 'output/architecture-audit-20261004');
if(!outputDirectory.startsWith(path.resolve('output')+path.sep))throw new Error('Audit output must stay inside local output.');
fs.mkdirSync(outputDirectory,{recursive:true});
openDatabase(path.join(directory,'work.sqlite')).close();
const app=createApplication(loadConfig({HOST:'127.0.0.1',PORT:'4378',CMS_PROCESS_ROLE:'api',
  DATABASE_PATH:path.join(directory,'work.sqlite'),CMS_DATA_ROOT:directory,
  GENERATED_MEDIA_DIR:path.join(directory,'media'),SOURCE_UPLOADS_DIR:path.join(directory,'sources'),
  CAPTURE_UPLOADS_DIR:path.join(directory,'captures'),CAPTURE_MEDIA_UPLOADS_DIR:path.join(directory,'uploads'),
  MAINTENANCE_ENABLED:'false',LOG_LEVEL:'error',ADMIN_USERNAME:'audit',ADMIN_PASSWORD:'local-audit-only',
  ADMIN_TOKEN:'local-architecture-audit-only',SESSION_SECRET:'isolated-local-architecture-session-secret'}));
const {repository}=app,db=repository.db;
db.prepare(`INSERT INTO topic_candidates(id,destination_slug,topic_key,proposed_title,rationale,coverage_score,evidence_count,conflict_count,status,created_at,updated_at)
  VALUES ('audit-topic','beijing','audit','恢复验证：北京参观指南','local fixture',80,0,0,'drafted','2026-10-01','2026-10-01')`).run();
db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at,candidate_id)
  VALUES ('audit-brief','beijing','Visit guide','[]','informational','drafted','2026-10-01','2026-10-01','audit-topic')`).run();
db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at,revision,content_hash)
  VALUES ('audit-draft','audit-brief','恢复验证：北京参观指南','audit-guide','## Visit\n\nThe museum opens at 09:00.','{}','exception','2026-10-01','2026-10-01',1,'preserved-body')`).run();
db.prepare(`INSERT INTO content_opportunities(id,destination_slug,topic_key,strategy_version,candidate_id,title,content_type,
  readiness_score,readiness_json,coverage_json,status,approved_at,created_at,updated_at,lifecycle_state,processing_state,canonical_intent_key,inbox_state,seo_action)
  VALUES ('audit-owner','beijing','audit:approved','3.9','audit-topic','恢复验证：北京参观指南','practical_guide',100,
  '{"ready":true,"score":100}','{"publicationMode":"multi_source_synthesis","proposal":{"readerPromise":"Plan a visit."}}',
  'producing','2026-10-01','2026-10-01','2026-10-01','producing','CURRENT','audit:approved','ACTIONABLE','NEW')`).run();
const failed=repository.enqueue('review_draft','audit-draft',{productionOwnerOpportunityId:'audit-owner'});
const job=repository.claimJob();assert.equal(job.id,failed);
repository.failJob(job,process.env.CMS_AUDIT_FAILURE==='billing'
  ? Object.assign(new Error('DeepSeek request failed (402): Insufficient Balance'),{code:'PROVIDER_REQUEST_FAILED',status:402,retryable:false})
  : Object.assign(new Error('Temporary provider outage during independent review'),{code:'PROVIDER_TIMEOUT',retryable:false}));
const before=db.prepare("SELECT body_markdown,revision,content_hash FROM article_drafts WHERE id='audit-draft'").get();
let calls=0,injected=false,busy=false,completed=false;
const engine={enabled:true,async review(){calls++;return {model:'local-controlled-review',output:{passed:false,score:60,
  checks:[],issues:[{code:'UNSUPPORTED_ASSERTION',severity:'blocker',message:'The 09:00 opening time is not supported by the frozen evidence.'}],
  unsupported_claims:['The museum opens at 09:00.']}};}};
const commit=repository.commitPipelineStage.bind(repository);
repository.commitPipelineStage=(job,...args)=>{
  if(job.type==='review_draft'&&!injected){injected=true;throw new Error('Injected transient commit failure after model response');}
  return commit(job,...args);
};
const poll=setInterval(async()=>{
  if(busy||completed)return;
  if(!db.prepare("SELECT 1 FROM jobs WHERE type='review_draft' AND status='queued'").get())return;
  busy=true;
  try {
    // Fresh runner for every retry; only the durable receipt survives.
    const pipeline=new Pipeline(repository,null,{contentEngine:engine});
    await pipeline.runOne();
    db.prepare("UPDATE jobs SET available_at='2000-01-01',next_eligible_at='2000-01-01' WHERE type='review_draft' AND status='queued'").run();
    if(db.prepare("SELECT 1 FROM jobs WHERE type='review_draft' AND status='succeeded'").get()){
      assert.equal(calls,1);assert.ok(injected);
      assert.deepEqual(db.prepare("SELECT body_markdown,revision,content_hash FROM article_drafts WHERE id='audit-draft'").get(),before);
      const downstream=db.prepare("SELECT type,status,production_owner_opportunity_id FROM jobs WHERE type='revise_draft'").all();
      assert.equal(downstream.length,1);assert.equal(downstream[0].production_owner_opportunity_id,'audit-owner');
      fs.writeFileSync(path.join(outputDirectory,'browser-backend.json'),JSON.stringify({passed:true,reviewCalls:calls,
        commitFailureInjected:injected,bodyPreserved:true,downstream,directory,realProviderCalls:0},null,2));
      completed=true;
    }
  }catch(error){console.error(error);completed=true;}finally{busy=false;}
},750);
await app.start();
console.log(JSON.stringify({url:'http://127.0.0.1:4378/',directory,stopFile:path.join(directory,'STOP')}));
let stopped=false;
const stopPoll=setInterval(()=>{if(fs.existsSync(path.join(directory,'STOP')))void stop();},500);
const deadline=setTimeout(()=>void stop(),30*60_000);
async function stop(){if(stopped)return;stopped=true;clearInterval(poll);clearInterval(stopPoll);clearTimeout(deadline);await app.stop();}
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
