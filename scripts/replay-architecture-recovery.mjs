// Real retained production inputs and persisted model outputs. Work DB only;
// all replay mutations are rolled back. No remote providers or publishing.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {openDatabase} from '../src/db.mjs';
import {Repository} from '../src/repository.mjs';
import {Pipeline} from '../src/pipeline.mjs';
const filename=path.resolve(process.argv[2] || ''),reportPath=path.resolve(process.argv[3] || '');
const relative=path.relative(path.resolve('output'),filename);
if(!process.argv[2]||!process.argv[3]||!/^architecture-audit-[^\\/]+[\\/]/.test(relative)||!filename.endsWith('work.sqlite'))
  throw new Error('Pass an isolated output/architecture-audit-*/...work.sqlite and report path.');
const db=openDatabase(filename),repo=new Repository(db,{sourceUploadsDir:'C:/s01-restore-20260927/source-uploads'});
const digest=()=>crypto.createHash('sha256').update(JSON.stringify({
  drafts:db.prepare('SELECT * FROM article_drafts ORDER BY id').all(),
  facts:db.prepare('SELECT * FROM knowledge_facts ORDER BY id').all(),
  jobs:db.prepare('SELECT * FROM jobs ORDER BY id').all(),
  receipts:db.prepare('SELECT * FROM pipeline_step_receipts ORDER BY request_hash').all(),
})).digest('hex');
const before=digest(),report={version:'architecture-real-recovery-1',providerCalls:0,wordpressWrites:0,productionWrites:0,stages:[]};
const readJson=(value,fallback)=>{try{return JSON.parse(value);}catch{return fallback;}};
const cases=[];
for(const draft of db.prepare(`SELECT ad.id,co.id owner FROM article_drafts ad
  JOIN content_briefs cb ON cb.id=ad.brief_id JOIN content_opportunities co ON co.candidate_id=cb.candidate_id
  WHERE co.approved_at IS NOT NULL ORDER BY ad.id LIMIT 3`).all()){
  const prior=db.prepare('SELECT * FROM quality_reviews WHERE draft_id=? ORDER BY created_at DESC LIMIT 1').get(draft.id);
  assert.ok(prior);
  cases.push({type:'review_draft',entity:draft.id,owner:draft.owner,method:'review',output:{passed:Boolean(prior.passed),score:prior.score,
    checks:readJson(prior.checks_json,[]),issues:readJson(prior.issues_json,[]),unsupported_claims:readJson(prior.unsupported_claims_json,[])}});
}
for(const source of db.prepare(`SELECT source_id,analysis_json FROM content_intake_analyses ORDER BY updated_at DESC LIMIT 2`).all())
  cases.push({type:'analyze_source_diagnostic',entity:source.source_id,method:'analyzeIntake',output:readJson(source.analysis_json,{})});
try{
  for(const scenario of cases){
    db.exec('BEGIN');
    try{
      db.prepare("UPDATE jobs SET status='succeeded' WHERE status IN ('queued','running')").run();
      db.prepare('DELETE FROM pipeline_artifacts WHERE stage=? AND entity_id=?').run(scenario.type,scenario.entity);
      db.prepare('DELETE FROM pipeline_step_receipts WHERE stage=? AND entity_id=?').run(scenario.type,scenario.entity);
      let calls=0,failedCommit=false;
      const engine={enabled:true,[scenario.method]:async()=>{calls++;return {model:'retained-production-output',output:scenario.output};}};
      const jobId=repo.enqueue(scenario.type,scenario.entity,{dedupeKey:`architecture-replay:${scenario.type}:${scenario.entity}`,
        productionOwnerOpportunityId:scenario.owner || null});
      const commit=repo.commitPipelineStage.bind(repo);
      repo.commitPipelineStage=(job,...args)=>{
        if(job.id===jobId&&!failedCommit){failedCommit=true;throw new Error('Replay: commit interrupted after provider output');}
        return commit(job,...args);
      };
      try{
        await new Pipeline(repo,null,{contentEngine:engine,sourceEngine:engine}).runOne();
        const failed=db.prepare('SELECT status,attempts FROM jobs WHERE id=?').get(jobId);
        assert.equal(failed.status,'queued');assert.equal(failed.attempts,1);
        db.prepare("UPDATE jobs SET available_at='2000-01-01',next_eligible_at=NULL WHERE id=?").run(jobId);
        await new Pipeline(repo,null,{contentEngine:engine,sourceEngine:engine}).runOne();
        const after=db.prepare('SELECT status,last_error FROM jobs WHERE id=?').get(jobId);
        assert.equal(after.status,'succeeded',JSON.stringify(after));assert.equal(calls,1);assert.ok(failedCommit);
        report.stages.push({stage:scenario.type,entityId:scenario.entity,owner:scenario.owner,modelOutputsUsed:calls,
          commitFailureInjected:failedCommit,restarted:true,receiptCount:db.prepare('SELECT count(*) n FROM pipeline_step_receipts WHERE job_id=?').get(jobId).n});
      }finally{repo.commitPipelineStage=commit;}
    }finally{db.exec('ROLLBACK');}
  }
  report.historicalExperiences= db.prepare(`SELECT er.status,count(*) n FROM experience_blocks eb
    JOIN experience_extraction_runs er ON er.id=eb.extraction_run_id JOIN sources s ON s.id=er.source_id
    WHERE er.capture_version<>s.capture_version GROUP BY er.status`).all();
  assert.equal(report.historicalExperiences.filter(r=>r.status==='succeeded').length,0);
  report.orphanSegmentJobs=db.prepare(`SELECT count(*) n FROM jobs j LEFT JOIN source_segments s ON s.id=j.entity_id
    WHERE j.status IN ('queued','running') AND j.type IN ('extract_segment_claims','audit_segment_coverage','retry_segment_extraction') AND s.id IS NULL`).get().n;
  assert.equal(report.orphanSegmentJobs,0);
  report.status='PASS';
}catch(error){report.status='FAIL';report.error={message:error.message,stack:error.stack};process.exitCode=1;}
finally{
  report.beforeFingerprint=before;report.afterFingerprint=digest();report.rollbackPreserved=before===report.afterFingerprint;
  if(!report.rollbackPreserved){report.status='FAIL';process.exitCode=1;}
  db.close();fs.writeFileSync(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
