import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";
import { boundedEditorialAssemblyPackage, EDITORIAL_ASSEMBLY_INPUT_BUDGET,
  boundedPlanningPackage, PLANNING_INPUT_BUDGET } from "../src/repository.mjs";
import { executeContentRecovery } from "../src/services/content-recovery.mjs";

function candidate(db,id="shared-candidate") {
  db.prepare(`INSERT INTO topic_candidates(id,destination_slug,topic_key,proposed_title,rationale,coverage_score,evidence_count,conflict_count,status,created_at,updated_at)
    VALUES (?,'beijing',?,'Shared candidate title','fixture',100,2,0,'candidate','2026-09-13','2026-09-13')`).run(id,`beijing:${id}`);
}

function opportunity(db,id,{candidateId="shared-candidate",approved=false,ready=true}={}) {
  db.prepare(`INSERT INTO content_opportunities(id,destination_slug,destination_scopes_json,topic_key,strategy_version,candidate_id,title,content_type,
    readiness_score,readiness_json,coverage_json,status,approved_at,created_at,updated_at,lifecycle_state)
    VALUES (?,'beijing','["beijing"]',?,'3.3',?,?,'practical_guide',?,?,'{}',?,?, '2026-09-13','2026-09-13',?)`)
    .run(id,`beijing:${id}`,candidateId,`Opportunity ${id}`,ready ? 100 : 20,JSON.stringify({ready,blockingRequirements:ready?[]:["official_confirmation"]}),
      approved ? ready ? "approved_ready" : "approved_waiting_for_evidence" : "recommended",approved ? "2026-09-13" : null,approved ? "approved" : "recommended");
}

test("unapproved Candidate and shared unapproved Opportunities never enter Content Workbench",(t)=>{
  const {db,repository}=repositoryFixture(t); candidate(db);
  opportunity(db,"unapproved-a"); opportunity(db,"unapproved-b");
  repository.enqueue("plan_content","shared-candidate",{dedupeKey:"legacy-unowned-failure"});
  db.prepare("UPDATE jobs SET status='failed',last_error='legacy',updated_at='2026-09-13' WHERE dedupe_key='legacy-unowned-failure'").run();
  const workspace=repository.listContentWorkspace({productionOnly:true});
  assert.equal(workspace.items.length,0);
  assert.equal(workspace.sections.needs_attention,0);
});

test("approved evidence waiting is pending start and never needs attention",(t)=>{
  const {db,repository}=repositoryFixture(t); candidate(db);
  opportunity(db,"waiting-owner",{approved:true,ready:false});
  const workspace=repository.listContentWorkspace({productionOnly:true});
  assert.equal(workspace.items.length,1);
  assert.equal(workspace.sections.pending_start,1);
  assert.equal(workspace.sections.needs_attention,0);
  assert.equal(workspace.items[0].production_state.readiness,"waiting_for_evidence");
  assert.equal(workspace.items[0].production_state.stage_status,"waiting");
  assert.equal(workspace.items[0].production_state.needs_human,false);
});

test("an approved ready instance without a Job is the only interrupted sibling after grace",(t)=>{
  const {db,repository}=repositoryFixture(t); candidate(db);
  opportunity(db,"ready-owner",{approved:true,ready:true});
  opportunity(db,"unapproved-sibling",{approved:false,ready:true});
  const workspace=repository.listContentWorkspace({productionOnly:true});
  assert.deepEqual(workspace.items.map((item)=>item.opportunity_id),["ready-owner"]);
  assert.equal(workspace.sections.needs_attention,1);
  assert.equal(workspace.items[0].production_state.stage_status,"interrupted");
  assert.equal(workspace.items[0].production_state.recovery_target,"assemble_editorial");
});

test("one Candidate-level failure has one canonical approved production owner",(t)=>{
  const {db,repository}=repositoryFixture(t); candidate(db);
  opportunity(db,"owner-approved",{approved:true}); opportunity(db,"sibling-a"); opportunity(db,"sibling-b");
  db.prepare(`INSERT INTO editorial_assemblies(id,candidate_id,opportunity_id,input_hash,created_at,updated_at)
    VALUES ('owner-assembly','shared-candidate','owner-approved','hash','2026-09-13','2026-09-13')`).run();
  const jobId=repository.enqueue("plan_content","shared-candidate",{dedupeKey:"owned-failure",productionOwnerOpportunityId:"owner-approved"});
  db.prepare(`UPDATE jobs SET status='failed',attempts=1,failure_class='permanent_input',last_failure_code='MODEL_OUTPUT_LIMIT',
    last_error='structured output reached its token limit',updated_at='2026-09-13T01:00:00Z' WHERE id=?`).run(jobId);
  const workspace=repository.listContentWorkspace({productionOnly:true});
  assert.deepEqual(workspace.items.map((item)=>item.opportunity_id),["owner-approved"]);
  assert.equal(workspace.sections.needs_attention,1);
  assert.equal(workspace.items[0].production_state.latest_error.job_id,jobId);
  assert.equal(workspace.items[0].production_state.production_owner_opportunity_id,"owner-approved");
});

test("retry is idempotent, becomes authoritative, and success supersedes the old failure",(t)=>{
  const {db,repository}=repositoryFixture(t); candidate(db); opportunity(db,"retry-owner",{approved:true});
  db.prepare(`INSERT INTO editorial_assemblies(id,candidate_id,opportunity_id,input_hash,created_at,updated_at)
    VALUES ('retry-assembly','shared-candidate','retry-owner','hash','2026-09-13','2026-09-13')`).run();
  const done=repository.enqueue("assemble_editorial","shared-candidate",{dedupeKey:"retry-assemble",productionOwnerOpportunityId:"retry-owner"});
  db.prepare("UPDATE jobs SET status='succeeded',attempts=1,completed_at='2026-09-13',updated_at='2026-09-13' WHERE id=?").run(done);
  const failed=repository.enqueue("plan_content","shared-candidate",{dedupeKey:"retry-failed",productionOwnerOpportunityId:"retry-owner"});
  db.prepare("UPDATE jobs SET status='failed',attempts=1,failure_class='retryable_provider',last_failure_code='PROVIDER_BUSY',last_error='busy',updated_at='2026-09-13T01:00:00Z' WHERE id=?").run(failed);
  repository.getPlanningPackage=()=>({candidate:{id:"shared-candidate",destination_slug:"beijing",proposed_title:"Beijing guide"},facts:[]});
  const first=executeContentRecovery(repository,"retry-owner",{action:"retry_failed_stage",idempotency_key:"retry-once"},"tester");
  const second=executeContentRecovery(repository,"retry-owner",{action:"retry_failed_stage",idempotency_key:"retry-once"},"tester");
  assert.equal(first.jobId,second.jobId);
  assert.equal(second.idempotent,true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type='plan_content'").get().count,2);
  let state=repository.listContentWorkspace({productionOnly:true}).items[0].production_state;
  assert.equal(state.stage_status,"queued");
  assert.equal(state.latest_error,null);
  assert.equal(state.next_stage,"plan_narrative");
  db.prepare("UPDATE jobs SET status='succeeded',attempts=1,completed_at=?,updated_at=? WHERE id=?").run(repository.jobTimestamp(),repository.jobTimestamp(),first.jobId);
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at,candidate_id)
    VALUES ('retry-brief','beijing','Beijing guide','[]','informational','ready',?,?, 'shared-candidate')`).run(repository.jobTimestamp(),repository.jobTimestamp());
  state=repository.listContentWorkspace({productionOnly:true}).items[0].production_state;
  assert.equal(state.completed_stages.includes("plan_content"),true);
  assert.equal(state.latest_error,null);
  assert.equal(state.next_stage,"plan_narrative");
  assert.equal(state.needs_human,false);
});

test("a downstream historical failure with missing prerequisites recovers the first broken link",(t)=>{
  const {db,repository}=repositoryFixture(t); candidate(db); opportunity(db,"broken-owner",{approved:true});
  repository.configureProductionCapabilities({frontendContract:true});
  db.prepare(`INSERT INTO editorial_assemblies(id,candidate_id,opportunity_id,input_hash,created_at,updated_at)
    VALUES ('broken-assembly','shared-candidate','broken-owner','hash','2026-09-13','2026-09-13')`).run();
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at,candidate_id)
    VALUES ('broken-brief','beijing','Beijing guide','[]','informational','ready','2026-09-13','2026-09-13','shared-candidate')`).run();
  const failed=repository.enqueue("compose_frontend_page_plan","broken-brief",{
    dedupeKey:"legacy-page-plan-failure",productionOwnerOpportunityId:"broken-owner",
  });
  db.prepare(`UPDATE jobs SET status='failed',attempts=1,failure_class='permanent_input',last_failure_code='MODEL_OUTPUT_LIMIT',
    last_error='structured output reached its token limit',updated_at='2026-09-13T01:00:00Z' WHERE id=?`).run(failed);

  let state=repository.listContentWorkspace({productionOnly:true}).items[0].production_state;
  assert.equal(state.version,"1.3");
  assert.equal(state.stage_status,"interrupted");
  assert.equal(state.recovery_target,"plan_narrative");
  assert.equal(state.latest_error,null);
  assert.equal(state.latest_historical_error.stage,"compose_frontend_page_plan");
  assert.equal(state.latest_historical_error.blocks_current_flow,false);
  assert.equal(state.timeline.find((step)=>step.key==="compose_frontend_page_plan").status,"waiting");
  assert.equal(state.available_actions.includes("recover_next_stage"),true);
  assert.equal(state.available_actions.includes("retry_failed_stage"),false);

  const recovered=executeContentRecovery(repository,"broken-owner",{action:"recover_next_stage",idempotency_key:"repair-link"},"tester");
  assert.equal(recovered.resolvedStage,"plan_narrative");
  assert.equal(recovered.preservedStages.includes("plan_content"),true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type='compose_frontend_page_plan'").get().count,1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type='plan_narrative'").get().count,1);
  state=repository.listContentWorkspace({productionOnly:true}).items[0].production_state;
  assert.equal(state.stage_status,"queued");
  assert.equal(state.current_stage,"plan_narrative");
});

test("a planning failure without Editorial Assembly resumes assembly instead of skipping it",(t)=>{
  const {db,repository}=repositoryFixture(t); candidate(db); opportunity(db,"legacy-owner",{approved:true});
  const failed=repository.enqueue("plan_content","shared-candidate",{
    dedupeKey:"legacy-plan-failure",productionOwnerOpportunityId:"legacy-owner",
  });
  db.prepare(`UPDATE jobs SET status='failed',attempts=1,failure_class='permanent_input',last_failure_code='MODEL_OUTPUT_LIMIT',
    last_error='structured output reached its token limit',updated_at='2026-09-13T01:00:00Z' WHERE id=?`).run(failed);
  const state=repository.listContentWorkspace({productionOnly:true}).items[0].production_state;
  assert.equal(state.stage_status,"interrupted");
  assert.equal(state.recovery_target,"assemble_editorial");
  const recovered=executeContentRecovery(repository,"legacy-owner",{action:"recover_next_stage",idempotency_key:"repair-entry"},"tester");
  assert.equal(recovered.resolvedStage,"assemble_editorial");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type='plan_content'").get().count,1);
});

test("a current destination mismatch blocks recovery before a legacy failure can trigger another model stage",(t)=>{
  const {db,repository}=repositoryFixture(t); candidate(db); opportunity(db,"scope-owner",{approved:true});
  db.prepare("UPDATE content_opportunities SET title='Chongqing three day route' WHERE id='scope-owner'").run();
  const oldFailure=repository.enqueue("plan_content","shared-candidate",{
    dedupeKey:"old-output-limit",productionOwnerOpportunityId:"scope-owner",
  });
  db.prepare(`UPDATE jobs SET status='failed',attempts=1,last_failure_code='MODEL_OUTPUT_LIMIT',
    last_error='structured output reached its token limit',updated_at='2026-09-13T01:00:00Z' WHERE id=?`).run(oldFailure);
  const state=repository.listContentWorkspace({productionOnly:true}).items[0].production_state;
  assert.equal(state.stage_status,"failed");
  assert.equal(state.latest_error.code,"DESTINATION_TOPIC_MISMATCH");
  assert.equal(state.latest_error.model_execution,"not_requested");
  assert.equal(state.recoverable,false);
  assert.equal(state.available_actions.includes("retry_failed_stage"),false);
});

test("a Vertex schema rejection records a provider request without claiming model generation",(t)=>{
  const {db,repository}=repositoryFixture(t); candidate(db); opportunity(db,"schema-owner",{approved:true});
  db.prepare(`INSERT INTO editorial_assemblies(id,candidate_id,opportunity_id,input_hash,created_at,updated_at)
    VALUES ('schema-assembly','shared-candidate','schema-owner','hash','2026-09-13','2026-09-13')`).run();
  const failed=repository.enqueue("plan_content","shared-candidate",{
    dedupeKey:"schema-rejected",productionOwnerOpportunityId:"schema-owner",
  });
  db.prepare(`UPDATE jobs SET status='failed',attempts=1,failure_class='permanent_input',last_failure_code='PROVIDER_REQUEST_FAILED',
    last_error='Vertex Gemini request failed (400): Request contains an invalid argument.',updated_at='2026-09-13T01:00:00Z' WHERE id=?`).run(failed);
  repository.recordModelCall({ stage:"content_brief",provider:"vertex",model:"gemini-3.8-flash",promptHash:"p",schemaHash:"s",inputHash:"i",
    latencyMs:12,attempts:2,status:"failed",errorCode:"400",runId:failed,entityId:"shared-candidate",attemptNumber:2,
    requestKind:"provider",attemptStatus:"failed",retryReason:"provider_retry" });
  const state=repository.listContentWorkspace({productionOnly:true}).items[0].production_state;
  assert.equal(state.stage_status,"failed");
  assert.match(state.headline,/结构化输出格式/);
  assert.match(state.latest_error.reason,/开始生成前拒绝/);
  assert.equal(state.latest_error.provider_request_sent,true);
  assert.equal(state.latest_error.model_execution,"rejected_before_generation");
  assert.equal(state.latest_error.model_called,false);
});

test("plan_content output-limit fixture uses the Editorial Assembly subset, stays bounded and preserves qualifiers",()=>{
  const facts=Array.from({length:120},(_,index)=>({
    normalized_key:`beijing.fact.${index}`,subject:"Beijing",predicate:`rule ${index}`,
    preferred_value:`Value ${index} ${"x".repeat(4_000)}`,
    qualifiers:index===3 ? ["not valid after 18:00","exception for public holidays","price as of 2026-09-01"] : ["ordinary"],
    consensus_status:index===3 ? "conflicted" : "supported",
    evidence:Array.from({length:8},(__,evidenceIndex)=>({source_id:`source-${evidenceIndex}`,quote:`Quote ${"q".repeat(3_000)}`,confidence:1-evidenceIndex/10})),
  }));
  const selected=["beijing.fact.3","beijing.fact.17","beijing.fact.44"];
  const result=boundedPlanningPackage({candidate:{id:"large",proposed_title:"Beijing rules"},approved_proposal:{readerPromise:"Explain Beijing rules"},
    facts,editorial_assembly:{id:"assembly",selected_fact_keys:selected},experiences:[],editorial_patterns:[],constraints:{}});
  assert.deepEqual(result.facts.map((fact)=>fact.normalized_key).sort(),selected.sort());
  assert.match(JSON.stringify(result.facts.find((fact)=>fact.normalized_key==="beijing.fact.3").qualifiers),/not valid after 18:00/);
  assert.ok(result.planning_input_manifest.input_bytes<=PLANNING_INPUT_BUDGET.maxInputBytes);
  assert.ok(result.planning_input_manifest.estimated_tokens<=PLANNING_INPUT_BUDGET.maxEstimatedTokens);
  assert.equal(result.planning_input_manifest.destination_fact_count,120);
  assert.equal(result.planning_input_manifest.source_fact_count,3);
});

test("Editorial Assembly bounds a production-sized evidence package before the first model stage",()=>{
  const facts=Array.from({length:180},(_,index)=>({
    normalized_key:`chongqing.fact.${index}`,subject:"Chongqing",predicate:`route rule ${index}`,
    preferred_value:`Value ${index} ${"v".repeat(12_000)}`,
    qualifiers:index===5 ? ["not valid after 19:00","holiday exception","verified 2026-09-01"] : ["ordinary"],
    consensus_status:index===5 ? "conflicted" : "supported",support_count:index===5 ? 5 : 1,confidence:0.9,
    evidence:Array.from({length:10},(__,evidenceIndex)=>({source_id:`source-${evidenceIndex}`,
      quote:`Quote ${index}.${evidenceIndex} ${"q".repeat(20_000)}`,confidence:1-evidenceIndex/20})),
  }));
  const input={candidate:{id:"large",proposed_title:"Chongqing route rules"},
    approved_proposal:{readerPromise:"Explain Chongqing route rules"},facts,production_mode:"research",
    available_experiences:Array.from({length:80},(_,index)=>({id:`experience-${index}`,body:"e".repeat(40_000)})),
    source_families:Array.from({length:100},(_,index)=>({source_id:`source-${index}`,family_id:`family-${index}`})),
    failure_lessons:Array.from({length:30},(_,index)=>({failure_code:`failure-${index}`,remediation_rule:"r".repeat(8_000)})),
    editorial_lessons:Array.from({length:30},(_,index)=>({feedback:"f".repeat(8_000)})),
    golden_articles:Array.from({length:20},(_,index)=>({id:`gold-${index}`,principles:["p".repeat(8_000)]})),
    editorial_patterns:[],experiences:[],constraints:{research_only:true}};
  const result=boundedEditorialAssemblyPackage(input);
  const repeated=boundedEditorialAssemblyPackage(input);
  assert.deepEqual(result,repeated);
  assert.ok(Buffer.byteLength(JSON.stringify(result))<=EDITORIAL_ASSEMBLY_INPUT_BUDGET.maxInputBytes);
  assert.ok(result.editorial_assembly_input_manifest.estimated_tokens<=EDITORIAL_ASSEMBLY_INPUT_BUDGET.maxEstimatedTokens);
  assert.equal(result.editorial_assembly_input_manifest.destination_fact_count,180);
  assert.equal(result.editorial_assembly_input_manifest.deterministic_compression,true);
  assert.match(JSON.stringify(result.facts),/holiday exception/);
});

test("durable model receipts preserve the Vertex schema fallback position",(t)=>{
  const {repository}=repositoryFixture(t);
  const jobId=repository.enqueue("assemble_editorial","schema-candidate");
  repository.recordModelCall({stage:"editorial_assembly",provider:"vertex",model:"gemini-3.8-flash",
    promptHash:"p",schemaHash:"s",inputHash:"i",latencyMs:1,attempts:1,status:"failed",
    errorCode:"SCHEMA_MODE_UNSUPPORTED",runId:jobId,attemptNumber:1,
    retryReason:"schema_transport_fallback:json_schema->openapi"});
  assert.equal(repository.structuredSchemaModeForJob(jobId),"openapi");
  repository.recordModelCall({stage:"editorial_assembly",provider:"vertex",model:"gemini-3.8-flash",
    promptHash:"p",schemaHash:"s",inputHash:"i",latencyMs:1,attempts:2,status:"failed",
    errorCode:"SCHEMA_MODE_UNSUPPORTED",runId:jobId,attemptNumber:2,
    retryReason:"schema_transport_fallback:openapi->prompt_only"});
  assert.equal(repository.structuredSchemaModeForJob(jobId),"prompt_only");
});

test("production_state distinguishes provider cooldown from exhausted automatic retries",(t)=>{
  const {db,repository}=repositoryFixture(t); candidate(db); opportunity(db,"quota-owner",{approved:true});
  const jobId=repository.enqueue("assemble_editorial","shared-candidate",{
    dedupeKey:"quota-assembly",productionOwnerOpportunityId:"quota-owner",
  });
  db.prepare(`UPDATE jobs SET attempts=1,max_attempts=3,failure_class='retryable_provider',
    last_failure_code='PROVIDER_REQUEST_FAILED',last_error='Vertex Gemini request failed (429): Resource has been exhausted.',
    available_at='2099-01-01T00:00:00.000Z',next_eligible_at='2099-01-01T00:00:00.000Z' WHERE id=?`).run(jobId);
  let state=repository.listContentWorkspace({productionOnly:true}).items[0].production_state;
  assert.equal(state.stage_status,"queued");
  assert.equal(state.auto_continue,true);
  assert.match(state.headline,/等待模型配额恢复/);
  assert.deepEqual(state.retry_state,{reason:"provider_backoff",attempt:1,max_attempts:3,remaining_auto_attempts:2,resume_at:"2099-01-01T00:00:00.000Z"});

  db.prepare("UPDATE jobs SET attempts=3 WHERE id=?").run(jobId);
  state=repository.listContentWorkspace({productionOnly:true}).items[0].production_state;
  assert.equal(state.stage_status,"failed");
  assert.equal(state.auto_continue,false);
  assert.equal(state.needs_human,true);
  assert.match(state.headline,/自动重试次数已用完/);
  assert.equal(state.retry_state.remaining_auto_attempts,0);
});

test("mobile Content Workbench uses cards, 2x3 stats, scrolling filters and secondary delete",()=>{
  const source=fs.readFileSync(new URL("../frontend/src/views.jsx",import.meta.url),"utf8");
  assert.match(source,/data-testid="content-mobile-cards"[^>]*md:hidden/);
  assert.match(source,/data-testid="content-mobile-cards"[^>]*min-w-0/);
  assert.match(source,/content-mobile-cards[\s\S]*?<Card[^>]*min-w-0 overflow-hidden/);
  assert.match(source,/data-testid="content-desktop-table"[^>]*hidden md:block/);
  assert.match(source,/data-testid="content-stats"[^>]*grid grid-cols-2[^>]*sm:grid-cols-3[^>]*lg:grid-cols-6/);
  assert.match(source,/data-testid="content-filters"[^>]*flex-nowrap[^>]*overflow-x-auto/);
  assert.match(source,/const secondary=visible\.filter\(\(key\)=>key!==primary\)/);
  assert.match(source,/data-testid="content-mobile-more"[\s\S]*?bottom-full[\s\S]*?z-50/);
  assert.match(source,/state\.retry_state[\s\S]*?剩余自动尝试/);
  assert.doesNotMatch(source,/primary=visible\.find\(\(key\)=>\[[^\]]*delete_production_record/);
});
