import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {openDatabase} from '../src/db.mjs';
import {Repository} from '../src/repository.mjs';
import {Pipeline} from '../src/pipeline.mjs';
import {freezeRequiredMediaManifest,evaluatePublicationEligibility,mediaManifestForDraft} from '../src/publication-eligibility.mjs';
import {blockingMediaDispatchSql} from '../src/media-request-executor.mjs';
import {splitExperiencePackage} from '../src/experience-recovery.mjs';
const dir=path.resolve('output/interruption-recovery-20261004');
const source=path.join(dir,'recovery-work.sqlite'),filename=path.join(dir,`run-${Date.now()}-work.sqlite`);
fs.copyFileSync(source,filename);
const db=openDatabase(filename),repo=new Repository(db,{sourceUploadsDir:'C:/s01-restore-20260927/source-uploads'});
// This is a bounded relational slice. External rows are intentionally absent;
// never treat its cross-slice foreign-key omissions as production anomalies.
db.exec('PRAGMA foreign_keys=OFF');
const digest=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const protectedRows=()=>digest(['claims','source_assets','sources','knowledge_facts'].map(t=>db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()));
const evidenceBefore=protectedRows();
const report={status:'RUNNING',filename,sourceTables:31,productionWrites:0,providerCalls:0,wordpressWrites:0,articles:[],experiences:[]};
try{
  for(const draft of db.prepare('SELECT * FROM article_drafts ORDER BY id').all()){
    const before=repo.listDraftVisuals(draft.id),oldManifest=mediaManifestForDraft(db,draft.id);
    const owner=db.prepare('SELECT co.id FROM content_opportunities co JOIN content_briefs cb ON cb.candidate_id=co.candidate_id WHERE cb.id=?').get(draft.brief_id);
    repo.ensureAuthorizedSourceVisuals(draft.id);
    const after=repo.listDraftVisuals(draft.id);assert.ok(after.length);assert.equal(repo.blockedRequiredVisuals(draft.id).length,0);
    assert.ok(after.every(v=>v.status==='generated'&&v.acquisition_strategy==='use_authorized_source_image'));
    for(const v of after){const a=db.prepare('SELECT local_path,original_sha256 FROM source_assets WHERE id=?').get(v.source_asset_id);
      assert.ok(fs.existsSync(a.local_path));assert.equal(crypto.createHash('sha256').update(fs.readFileSync(a.local_path)).digest('hex'),a.original_sha256);}
    const hashes=after.map(v=>v.media_metadata.source_sha256);assert.equal(new Set(hashes).size,hashes.length);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM article_visuals av JOIN source_assets sa ON sa.id=av.source_asset_id
      JOIN sources s ON s.id=sa.source_id WHERE av.draft_id=? AND sa.capture_version<>s.capture_version`).get(draft.id).n,0);
    const deliveryPlan=rows=>rows.map(v=>({id:v.id,fingerprint:v.asset_fingerprint,asset:v.source_asset_id,
      status:v.status,alt:v.alt_text,caption:v.caption,gap:v.media_metadata?.required_visual_gap||null}));
    const once=digest(deliveryPlan(after));
    repo.ensureAuthorizedSourceVisuals(draft.id);assert.equal(digest(deliveryPlan(repo.listDraftVisuals(draft.id))),once,'media repair converges');
    const current=db.prepare('SELECT * FROM article_drafts WHERE id=?').get(draft.id);
    if(oldManifest){
      const retained=db.prepare('SELECT * FROM required_media_manifests WHERE draft_id=? AND revision=?').get(draft.id,draft.revision);
      assert.equal(retained.manifest_hash,oldManifest.manifestHash);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM production_record_audit WHERE action='repair_automatic_media_plan' AND opportunity_id=?").get(owner.id).n,1);
    }
    assert.equal(current.body_markdown,draft.body_markdown);assert.equal(current.content_hash,draft.content_hash);
    // A changed required subject without a prior automatic card plan needs a
    // fresh revision too; the frozen baseline remains evidence, never edited.
    freezeRequiredMediaManifest(db,draft.id);
    let gate=evaluatePublicationEligibility(db,draft.id);
    assert.ok(gate.passed,JSON.stringify(gate));
    db.prepare("UPDATE jobs SET available_at='2100-01-01',next_eligible_at='2100-01-01' WHERE status IN ('queued','running')").run();
    const jobId=repo.enqueue('generate_visuals',draft.id,{dedupeKey:`replay:${draft.id}`,productionOwnerOpportunityId:owner.id});
    const pipeline=new Pipeline(repo,null,{visuals:{enabled:true},frontendContracts:{diagnostics:()=>({canCompose:true})}});
    await pipeline.runOne();
    const job=db.prepare('SELECT status,last_error FROM jobs WHERE id=?').get(jobId);assert.equal(job.status,'succeeded',job.last_error);
    const next=db.prepare("SELECT * FROM jobs WHERE entity_id=? AND type='compose_frontend_page' AND status='queued'").all(draft.id);
    assert.equal(next.length,1);assert.equal(next[0].production_owner_opportunity_id,owner.id);
    report.articles.push({id:draft.id,beforeVisuals:before.length,afterVisuals:after.length,beforeRequired:oldManifest?.minimumRequired ?? null,
      revisionBefore:draft.revision,revisionAfter:current.revision,mediaGate:gate.code||'PASS',bodyPreserved:true,
      paidMediaCalls:0,nextStage:next[0].type,converges:true});
  }
  for(const sourceId of ['src_6dc34bb235f94932be6587cd906ce317','src_00f770704f8d4635ab3b4a5fe53f963a']){
    assert.equal(repo.listSources(1,{ids:[sourceId]})[0].experience_status,'failed');
    const input=repo.getExperienceExtractionPackage(sourceId),result=JSON.parse(fs.readFileSync(path.join(dir,`${sourceId}-experience.json`)));
    const retained=new Map();
    function loadResponses(part,key='experience'){
      const hash=digest({key:`${key}:result`,part,version:2});
      const response=JSON.parse(fs.readFileSync(path.join(dir,`experience-step-${hash}.json`)));
      if(response.partitionRequired){for(const [index,child] of splitExperiencePackage(part).entries())loadResponses(child,`${key}:${index+1}`);}
      else retained.set(digest(part),response);
    }
    loadResponses(input);let receiptReplays=0;
    const sourceEngine={enabled:true,analyzeExperience:async part=>{
      const response=retained.get(digest(part));assert.ok(response,'Replay requires the exact retained real Provider response.');
      receiptReplays++;return response;
    }};
    db.prepare("UPDATE jobs SET available_at='2100-01-01',next_eligible_at='2100-01-01' WHERE status='queued'").run();
    const jobId=repo.enqueue('extract_source_experience',sourceId,{dedupeKey:`replay:experience:${sourceId}`});
    await new Pipeline(repo,null,{sourceEngine}).runOne();
    const job=db.prepare('SELECT status,last_error FROM jobs WHERE id=?').get(jobId);assert.equal(job.status,'succeeded',job.last_error);
    const saved={blocks:repo.listExperienceBlocks(sourceId)};
    assert.ok(saved.blocks.length);const repeated=repo.saveExperienceExtraction(sourceId,result.output,result.model,input);
    assert.equal(repeated.reused,true);assert.equal(repeated.blocks.length,saved.blocks.length);
    assert.equal(repo.listSources(1,{ids:[sourceId]})[0].experience_status,'succeeded');
    report.experiences.push({sourceId,claims:input.claims.length,blocks:saved.blocks.length,idempotent:true,
      statusBefore:'failed',statusAfter:'succeeded',pipelineStatus:job.status,retainedProviderResponses:receiptReplays,
      downstream:db.prepare('SELECT type,status FROM jobs WHERE parent_job_id=?').all(jobId)});
  }
  report.unknownDispatches={before:db.prepare("SELECT COUNT(*) n FROM media_dispatches WHERE state IN ('dispatch_started','outcome_unknown')").get().n,
    actuallyBlocking:db.prepare(`SELECT COUNT(*) n FROM media_dispatches md WHERE ${blockingMediaDispatchSql()}`).get().n};
  assert.equal(report.unknownDispatches.actuallyBlocking,0);
  assert.equal(protectedRows(),evidenceBefore);report.sourceEvidencePreserved=true;
  report.exploratoryAudit={status:'PASS',currentCaptureMedia:true,uniqueImageBytes:true,oldManifestsPreserved:true,
    oneDownstreamJobPerOwner:true,sourceAndKnowledgeUnchanged:true,scope:'two articles and two Experience sources'};
  report.status='PASS';
}catch(error){report.status='FAIL';report.error={message:error.message,code:error.code,stack:error.stack};process.exitCode=1;}
finally{db.close();fs.writeFileSync(path.join(dir,'recovery-replay.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
