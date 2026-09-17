import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { classifyClaimPair, predicateValueCompatibility, stableCanonicalSerialize, structureClaim } from "../src/claim-resolution.mjs";
import { decideKnowledgeResolution } from "../src/knowledge-resolution.mjs";
import { resolveEvidenceConsensus } from "../src/evidence-consensus.mjs";
import { inheritJobContext, laneBackoffMs } from "../src/job-policy.mjs";
import { estimateSourceProcessing } from "../src/source-preflight.mjs";
import { runNodeJsonProcess } from "../src/process-runner.mjs";
import { Pipeline } from "../src/pipeline.mjs";
import { MaintenanceScheduler } from "../src/maintenance.mjs";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";

const nowMs=Date.parse("2026-09-12T12:00:00.000Z");
const fact=(predicate,value,extra={})=>{
  const row={source_id:extra.source_id||Math.random().toString(16),normalized_key:extra.normalized_key||`place.test.${predicate}`,
    subject:"Test place",predicate,value_text:value,source_quote:extra.source_quote||value,confidence:.9,
    source_authority_level:extra.source_authority_level||4,source_adapter:"manual",source_completeness_status:"complete",
    captured_at:extra.captured_at||"2026-09-10T00:00:00.000Z",...extra};
  row.structured_value=structureClaim({predicate,value,qualifiers:extra.qualifiers||[],sourceQuote:row.source_quote});
  return row;
};
const resolution=(left,right)=>{
  const comparison=classifyClaimPair(left,right);
  const consensus=resolveEvidenceConsensus([left,right],{nowMs,variantKey:(row)=>stableCanonicalSerialize(row.structured_value.typed_value??row.value_text)});
  return decideKnowledgeResolution({comparison,left,right,consensus,nowMs});
};

test("K01 canonical typed serialization removes hours and free-price wording noise",()=>{
  const hours=["24_hours","24/7","全天","24 hours"].map((value)=>structureClaim({predicate:"opening_hours",value}).typed_value);
  const prices=["free","0","0 RMB","0 CNY","免费"].map((value)=>structureClaim({predicate:"ticket_price",value}).typed_value);
  assert.equal(new Set(hours.map(stableCanonicalSerialize)).size,1);
  assert.equal(new Set(prices.map(stableCanonicalSerialize)).size,1);
});

test("K02 opening schedules retain interval, closed day and effective dates",()=>{
  const value=structureClaim({predicate:"opening_hours",value:"Weekdays 09:00-17:30, closed Sunday, from 2026-10-01 until 2026-12-31"}).typed_value;
  assert.equal(value.mode,"schedule"); assert.equal(value.intervals[0].open,"09:00"); assert.ok(value.closedDays.includes("sun"));
  assert.equal(value.validFrom,"2026-10-01"); assert.equal(value.validTo,"2026-12-31");
});

test("K03 opening-hours open access is locally reclassified rather than compared as a schedule",()=>{
  const check=predicateValueCompatibility({predicate:"opening_hours",value:"open access"});
  assert.equal(check.code,"PREDICATE_VALUE_MISMATCH"); assert.equal(check.repairedPredicate,"access_policy");
  assert.equal(structureClaim({predicate:"opening_hours",value:"open access"}).canonical_predicate,"access_policy");
});

test("K04 admission price and metro fare split by product scope",()=>{
  const result=resolution(fact("admission_fee","free"),fact("fare","metro fare 2 RMB"));
  assert.equal(result.state,"AUTO_SCOPE_SPLIT"); assert.equal(result.humanRequired,false);
});

test("K05 current, historical and scheduled values remain separate",()=>{
  const old=fact("ticket_price","50 CNY",{valid_to:"2024-12-31",observed_at:"2024-06-01"});
  const current=fact("ticket_price","60 CNY",{valid_from:"2026-01-01",observed_at:"2026-09-01"});
  const future=fact("ticket_price","70 CNY",{valid_from:"2027-01-01",observed_at:"2026-09-01"});
  assert.equal(resolution(old,current).state,"AUTO_TEMPORAL");
  const consensus=resolveEvidenceConsensus([current,future],{nowMs,variantKey:(row)=>row.value_text});
  assert.equal(consensus.preferredValue,"60 CNY"); assert.equal(consensus.scheduledEvidenceCount,1);
});

test("K06 ordinary dynamic conflict reaches consensus or targeted verification",()=>{
  const left=fact("ticket_price","50 CNY",{source_id:"one",source_author_name:"one"});
  const right=fact("ticket_price","60 CNY",{source_id:"two",source_author_name:"two"});
  assert.ok(["AUTO_CONSENSUS","VERIFICATION_REQUIRED"].includes(resolution(left,right).state));
});

test("K07 safety-critical disagreement alone requires a human",()=>{
  const result=resolution(fact("emergency_exit","east gate"),fact("emergency_exit","west gate"));
  assert.equal(result.state,"HUMAN_REQUIRED"); assert.equal(result.humanRequired,true);
});

test("K08 verification jobs expose retry and completion state",t=>{
  const {repository,db}=repositoryFixture(t);
  db.prepare(`INSERT INTO knowledge_verification_jobs(id,destination_slug,normalized_key,status,source_priority_json,evidence_json,result_json,created_at,updated_at)
    VALUES ('verify','test','place.test.price','failed','[]','[]','{}','now','now')`).run();
  assert.equal(repository.updateKnowledgeVerificationJob("verify",{action:"retry"}).status,"queued");
  assert.equal(repository.updateKnowledgeVerificationJob("verify",{action:"complete",result:{value:"60 CNY"}}).status,"completed");
});

test("K09 Knowledge status separates automatic, verification, repair and human queues",t=>{
  const {repository,db}=repositoryFixture(t);
  db.prepare(`INSERT INTO knowledge_resolution_events(id,destination_slug,normalized_key,resolution_state,reason,detail_json,engine_version,created_at)
    VALUES ('event','test','key','AUTO_EQUIVALENT','same','{}','test','now')`).run();
  db.prepare(`INSERT INTO knowledge_verification_jobs(id,destination_slug,normalized_key,status,source_priority_json,evidence_json,result_json,created_at,updated_at)
    VALUES ('verify','test','key','queued','[]','[]','{}','now','now')`).run();
  const status=repository.getKnowledgeResolutionStatus("test");
  assert.equal(status.automatic[0].count,1); assert.equal(status.verification[0].status,"queued");
});

test("K10 recomputation dry run projects equivalent legacy review away without mutating it",t=>{
  const {repository,db}=repositoryFixture(t);
  const ids=seedClaims(repository,["24 hours","全天"],"opening_hours");
  db.prepare(`INSERT INTO claim_review_cases(id,destination_slug,claim_a_id,claim_b_id,review_type,reason,status,created_at,updated_at)
    VALUES ('legacy','test',?,?,'SOURCE_CONFLICT','legacy','pending','now','now')`).run(...ids);
  const report=repository.runKnowledgeResolutionBackfill();
  assert.equal(report.beforeManualReviewCount,1); assert.equal(report.projectedManualReviewCount,0);
  assert.equal(db.prepare("SELECT status FROM claim_review_cases WHERE id='legacy'").get().status,"pending");
});

test("S01 processing gap dry run reports the exact missing stage and no mutation",t=>{
  const {repository,db}=repositoryFixture(t); const source=saveTextSource(repository,"gap"); db.prepare("DELETE FROM jobs").run();
  const report=repository.runSourceProcessingGapRecovery(); const item=report.items.find((entry)=>entry.sourceId===source.id);
  assert.equal(item.category,"MISSING_SEGMENTS"); assert.equal(item.actions[0].stage,"preflight_source");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs").get().n,0);
});

test("S03 approved recovery jobs inherit historical lane, priority, route and recovery ID",t=>{
  const {repository,db}=repositoryFixture(t); const source=saveTextSource(repository,"recover"); db.prepare("DELETE FROM jobs").run();
  const dry=repository.runSourceProcessingGapRecovery(); const run=repository.runSourceProcessingGapRecovery({dryRun:false,approvedFromRunId:dry.id});
  const job=db.prepare("SELECT * FROM jobs WHERE entity_id=?").get(source.id);
  assert.equal(job.workload_class,"historical_recovery"); assert.equal(job.priority,70); assert.equal(job.recovery_run_id,run.id);
  assert.equal(inheritJobContext(job,{type:"segment_source"}).recoveryRunId,run.id);
  const semanticChild=inheritJobContext(job,{type:"rebuild_knowledge",workloadClass:"semantic",priority:10,executionRoute:"realtime"});
  assert.equal(semanticChild.workloadClass,"historical_recovery"); assert.equal(semanticChild.priority,70);
  assert.equal(semanticChild.executionRoute,job.execution_route);
});

test("S04 a legacy gate becomes a stored dry-run manifest without queued recovery",t=>{
  const {repository,db}=repositoryFixture(t); const source=saveTextSource(repository,"legacy"); db.prepare("DELETE FROM jobs").run();
  const metadata={processingEstimate:{requiresManualStart:true,processingClass:"heavy"}};
  db.prepare("UPDATE sources SET submission_metadata_json=? WHERE id=?").run(JSON.stringify(metadata),source.id);
  const manifest=repository.createLegacySourceRecoveryManifest();
  assert.equal(manifest.dryRun,true); assert.equal(manifest.sourceCount,1); assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs").get().n,0);
  const repeated=repository.createLegacySourceRecoveryManifest();
  assert.equal(repeated.id,manifest.id);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM source_processing_gap_runs").get().n,1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM source_recovery_manifests").get().n,1);
});

test("S05-S07 core jobs precede background and interactive intake precedes historical recovery",t=>{
  const {repository,db}=repositoryFixture(t);
  repository.enqueue("preflight_source","history",{workloadClass:"historical_recovery",priority:1});
  const interactive=repository.enqueue("extract_source","new",{workloadClass:"interactive",interactive:true,priority:10});
  assert.equal(repository.claimJob().id,interactive);
  db.prepare("DELETE FROM jobs").run();
  const enqueued=[]; const pipeline=Object.create(Pipeline.prototype);
  pipeline.repository={contentConfig:{sourceComplexityRouting:false},getSource:()=>({structured:{destination_slug:"test"},raw_text:"Enough source text for a normal route."}),enqueue:(...args)=>{enqueued.push(args);return args[0];}};
  pipeline.extractor={analyzeBlueprint(){}};pipeline.contentEngine={enabled:true};pipeline.logger={info(){}};
  pipeline.enqueueSourceSemanticDownstream("source",{id:"parent",priority:10,workload_class:"interactive"});
  assert.equal(enqueued[0][0],"resolve_entities"); assert.equal(enqueued[0][2].workloadClass,"semantic");
  assert.ok(enqueued.slice(1).every((entry)=>entry[2].workloadClass==="background_enrichment"));
});

test("S02/S06 nineteen and twenty-seven images auto-schedule while only a hard limit blocks",()=>{
  for(const count of [19,27]){const estimate=estimateSourceProcessing({rawText:"one paragraph",assets:Array.from({length:count},()=>({kind:"image"}))});
    assert.equal(estimate.blocked,false); assert.equal(estimate.requiresManualStart,false);}
  assert.equal(estimateSourceProcessing({assets:Array.from({length:201},()=>({kind:"image"}))}).blocked,true);
});

test("S08 recovery backoff is lane-aware and historical work cannot flood concurrent claims",t=>{
  assert.ok(laneBackoffMs("historical_recovery",1000)>laneBackoffMs("interactive",1000));
  const {repository}=repositoryFixture(t); const first=repository.enqueue("preflight_source","a",{workloadClass:"historical_recovery"});
  repository.enqueue("preflight_source","b",{workloadClass:"historical_recovery"}); assert.equal(repository.claimJob().id,first);
  assert.equal(repository.claimJob(),null);
});

test("P01 database-heavy subprocess jobs are exclusive and lane limits are enforced",t=>{
  const {repository,db}=repositoryFixture(t);
  const first=repository.enqueue("rebuild_knowledge","alpha",{workloadClass:"semantic"});
  repository.enqueue("rebuild_knowledge","beta",{workloadClass:"semantic"});
  repository.enqueue("build_coverage_matrix","alpha",{workloadClass:"background_enrichment"});
  assert.equal(repository.claimJob().id,first);
  assert.equal(repository.claimJob(),null,"a database-heavy writer excludes every other pipeline writer");
  db.prepare("UPDATE jobs SET status='succeeded' WHERE status IN ('queued','running')").run();
  repository.enqueue("preflight_source","interactive-a",{workloadClass:"interactive"});
  const interactive=repository.claimJob();
  assert.equal(interactive.entity_id,"interactive-a");
  repository.enqueue("rebuild_knowledge","gamma",{workloadClass:"semantic"});
  assert.equal(repository.claimJob(),null,"a database-heavy job waits for an ordinary running job");
});

test("P01 a busy recovery tick is deferred without escaping the pipeline timer",()=>{
  const events=[];const busy=Object.assign(new Error("database is locked"),{code:"ERR_SQLITE_ERROR",errcode:5});
  const pipeline=Object.create(Pipeline.prototype);
  Object.assign(pipeline,{nextRecoveryAt:0,recoveryIntervalMs:60_000,working:0,maxConcurrent:0,batchWorking:false,
    repository:{recoverExpiredJobs(){throw busy;}},logger:{warn:(event)=>events.push(event),error:(event)=>events.push(event)}});
  assert.doesNotThrow(()=>pipeline.pump());
  assert.deepEqual(events,["pipeline.recovery_deferred_database_busy"]);
});

test("P01/P03 child CPU work keeps timers responsive and a child crash stays contained",async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"stc-isolation-"));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const worker=path.join(directory,"worker.mjs");fs.writeFileSync(worker,"const until=Date.now()+250; while(Date.now()<until){}; console.log(JSON.stringify({ok:true}))");
  let ticks=0;const timer=setInterval(()=>{ticks+=1;},10);const result=await runNodeJsonProcess(worker,[],{timeoutMs:2000});clearInterval(timer);
  assert.equal(result.ok,true);assert.ok(ticks>=10);
  const failed=path.join(directory,"failed.mjs");fs.writeFileSync(failed,"throw new Error('contained')");
  await assert.rejects(runNodeJsonProcess(failed,[],{timeoutMs:2000}),/exited/);
  assert.equal(1+1,2);
});

test("P01 isolated Knowledge rebuild waits for a WAL writer and commits through the shared database",async t=>{
  const {repository,db,directory}=repositoryFixture(t);seedClaims(repository,["free","0 CNY"],"ticket_price");
  db.exec("BEGIN IMMEDIATE");
  const script=fileURLToPath(new URL("../scripts/run-isolated-repository-task.mjs",import.meta.url));
  const child=runNodeJsonProcess(script,["rebuild_knowledge",path.join(directory,"test.sqlite"),"test"],{timeoutMs:5_000});
  await new Promise((resolve)=>setTimeout(resolve,100));db.exec("COMMIT");
  const result=await child;
  assert.equal(result.ok,true);assert.equal(db.prepare("SELECT COUNT(*) n FROM knowledge_facts").get().n,1);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check,"ok");
});

test("P02 compact intake omits raw payloads and reports an input budget",t=>{
  const {repository}=repositoryFixture(t); const source=saveTextSource(repository,"compact");
  repository.saveExtraction(source.id,{source:{language:"en",summary:"test",destination_name:"Test",destination_slug:"test",traveler_fit:[],practical_tips:[],warnings:[],confidence:.9},
    claims:[{key:"place.test.address",subject:"Test",predicate:"address",value:"1 Main St",qualifiers:[],source_quote:"1 Main St",confidence:.9}],
    blueprint:{format:"guide",hook:"test",angle:"test",sections:[],strengths:[],gaps:[]}},"test","test");
  const pack=repository.getIntakePackage(source.id);const serialized=JSON.stringify(pack);
  assert.ok(pack.input_telemetry.estimated_tokens>0);assert.doesNotMatch(serialized,/raw_html|raw_payload_json/);
});

test("P03 backup process failure is recorded without blocking the pipeline",async()=>{
  let pipelineRuns=0;
  const repository={enqueueEntityResolutionForAllDestinations:()=>0,enqueueKnowledgeReconciliation:()=>0,pruneSucceededJobs:()=>0,
    startMaintenance(){},completeMaintenance(){},failMaintenance(){}};
  const scheduler=new MaintenanceScheduler(repository,{runOne:async()=>{pipelineRuns+=1;}},{enabled:true,entityResolutionHours:24,
    knowledgeReconcileHours:24,autoBackupHours:24,jobHistoryRetentionDays:30,processIsolationEnabled:true,databasePath:"db",backupDir:"backups",
    sourceUploadsDir:"uploads",generatedMediaDir:"media",backupRetention:1},{},{processRunner:async()=>{throw new Error("backup failed");}});
  const run=await scheduler.runDue({force:true});
  assert.equal(run.results.find((item)=>item.task==="database_backup").status,"failed");
  await new Promise((resolve)=>setImmediate(resolve));assert.equal(pipelineRuns,1);
});

function saveTextSource(repository,id){return repository.saveCapture({adapter:"manual",externalId:id,canonicalUrl:`https://example.com/${id}`,
  title:id,authorName:"",authorUrl:"",publishedAt:null,capturedAt:new Date().toISOString(),rawText:"Complete source text with enough evidence for extraction.",
  rawHtml:"",sourceKind:"manual_text",assets:[],files:[],completeness:{overall:"complete"},rights:{},client:{}});}

function seedClaims(repository,values,predicate){
  const ids=[];
  for(const [index,value] of values.entries()){
    const source=saveTextSource(repository,`claim-${index}`);
    repository.saveExtraction(source.id,{source:{language:"en",summary:"test",destination_name:"Test",destination_slug:"test",traveler_fit:[],practical_tips:[],warnings:[],confidence:.9},
      claims:[{key:`place.test.${predicate}`,subject:"Test",predicate,value,qualifiers:[],source_quote:value,confidence:.9}],
      blueprint:{format:"guide",hook:"test",angle:"test",sections:[],strengths:[],gaps:[]}},"test","test");
    ids.push(repository.db.prepare("SELECT id FROM claims WHERE source_id=?").get(source.id).id);
  }
  return ids;
}
