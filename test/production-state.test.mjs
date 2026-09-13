import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";
import { buildPageCompositionPreview } from "../src/services/production-state.mjs";
import { executeContentRecovery } from "../src/services/content-recovery.mjs";
import { normalizeXiaohongshuCapture } from "../src/adapters/xiaohongshu.mjs";

function seedOpportunity(db, { id = "opp-state", ready = true, candidate = true } = {}) {
  if (candidate) db.prepare(`INSERT INTO topic_candidates(id,destination_slug,topic_key,proposed_title,rationale,coverage_score,evidence_count,conflict_count,status,created_at,updated_at)
    VALUES ('candidate-state','beijing','beijing:state','State guide','fixture',100,2,0,'candidate','2026-09-01','2026-09-01')`).run();
  db.prepare(`INSERT INTO content_opportunities(id,destination_slug,destination_scopes_json,topic_key,strategy_version,candidate_id,title,content_type,
    readiness_score,readiness_json,coverage_json,status,approved_at,created_at,updated_at,lifecycle_state)
    VALUES (?,'beijing','["beijing"]','beijing:state','3.3',?,'State guide','practical_guide',?,?,'{}',?,'2026-09-01','2026-09-01','2026-09-01','approved')`)
    .run(id,candidate ? "candidate-state" : null,ready ? 100 : 20,JSON.stringify({ ready,blockingRequirements:ready ? [] : ["official_confirmation"] }),ready ? "approved_ready" : "approved_waiting_for_evidence");
  if (candidate) db.prepare("UPDATE topic_candidates SET opportunity_id=? WHERE id='candidate-state'").run(id);
}

function seedEditorialAssembly(db) {
  db.prepare(`INSERT INTO editorial_assemblies(id,candidate_id,opportunity_id,input_hash,created_at,updated_at)
    VALUES ('assembly-state','candidate-state','opp-state','assembly-hash','2026-09-01','2026-09-01')`).run();
}

test("production_state distinguishes evidence wait, queue, failure and exact targeted recovery", (t) => {
  const { db,repository } = repositoryFixture(t);
  seedOpportunity(db,{candidate:false,ready:false});
  let workspace=repository.listContentWorkspace({productionOnly:true});
  assert.equal(workspace.items[0].production_state.readiness,"waiting_for_evidence");
  assert.equal(workspace.items[0].production_state.stage_status,"waiting");
  assert.equal(workspace.items[0].production_state.auto_continue,true);
  assert.deepEqual(workspace.sections,{pending_start:1,in_progress:0,needs_attention:0,completed:0,history:0,generated_body:0});

  db.prepare("DELETE FROM content_opportunities").run();
  seedOpportunity(db);
  seedEditorialAssembly(db);
  const prerequisite=repository.enqueue("assemble_editorial","candidate-state",{dedupeKey:"test:assemble"});
  db.prepare("UPDATE jobs SET status='succeeded',completed_at='2026-09-01',updated_at='2026-09-01' WHERE id=?").run(prerequisite);
  const jobId=repository.enqueue("plan_content","candidate-state",{dedupeKey:"test:plan"});
  workspace=repository.listContentWorkspace({productionOnly:true});
  assert.equal(workspace.items[0].production_state.stage_status,"queued");
  assert.equal(workspace.items[0].production_state.current_stage,"plan_content");
  assert.equal(workspace.sections.in_progress,1);

  db.prepare(`UPDATE jobs SET status='failed',last_error='Provider quota exhausted',failure_class='retryable_provider',
    last_failure_code='PROVIDER_QUOTA',completed_at='2026-09-02',updated_at='2026-09-02' WHERE id=?`).run(jobId);
  const failed=repository.listContentWorkspace({productionOnly:true}).items[0].production_state;
  assert.equal(failed.lifecycle,"needs_attention");
  assert.equal(failed.latest_error.stage,"plan_content");
  assert.equal(failed.latest_error.code,"PROVIDER_QUOTA");
  assert.equal(failed.available_actions.includes("retry_failed_stage"),true);

  repository.getTopicPackage=() => ({ candidate:{ id:"candidate-state",destination_slug:"beijing",proposed_title:"State guide" },facts:[] });
  const recovered=executeContentRecovery(repository,"opp-state",{action:"retry_failed_stage",idempotency_key:"recover-state"},"tester");
  assert.equal(recovered.resolvedStage,"plan_content");
  assert.equal(recovered.stageOnly,true);
  assert.equal(recovered.preservedStages.includes("assemble_editorial"),true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type='assemble_editorial'").get().count,1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type='plan_content'").get().count,2);
});

test("candidate and missing downstream jobs expose the real interrupted stage", (t) => {
  const { db,repository }=repositoryFixture(t);
  seedOpportunity(db);
  let state=repository.listContentWorkspace({productionOnly:true}).items[0].production_state;
  assert.equal(state.stage_status,"interrupted");
  assert.equal(state.current_stage,null);
  assert.equal(state.recovery_target,"assemble_editorial");
  assert.match(state.headline,/流程中断/);

  const assemble=repository.enqueue("assemble_editorial","candidate-state",{dedupeKey:"done:assemble"});
  db.prepare("UPDATE jobs SET status='succeeded',completed_at='2026-09-01',updated_at='2026-09-01' WHERE id=?").run(assemble);
  seedEditorialAssembly(db);
  db.prepare("UPDATE topic_candidates SET status='brief_ready' WHERE id='candidate-state'").run();
  state=repository.listContentWorkspace({productionOnly:true}).items[0].production_state;
  assert.equal(state.stage_status,"interrupted");
  assert.equal(state.current_stage,"assemble_editorial");
  assert.equal(state.next_stage,"plan_content");
  assert.equal(state.recoverable,true);
});

test("archive and delete are audited, idempotent and preserve governing records", (t) => {
  const { db,repository }=repositoryFixture(t);
  const imageBytes=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.from("retained-media")]);
  const source=repository.saveCapture(normalizeXiaohongshuCapture({ url:"https://www.xiaohongshu.com/explore/retained-production-source",
    title:"Retained Beijing source",text:"Enter the Example Gate in Beijing.",images:[{url:"https://ci.xhscdn.com/retained.png",
      originalDataUrl:`data:image/png;base64,${imageBytes.toString("base64")}`,originalSha256:createHash("sha256").update(imageBytes).digest("hex")}]}));
  repository.saveExtraction(source.id,{ source:{language:"en",summary:"Entry",destination_name:"Beijing",destination_slug:"beijing",traveler_fit:[],practical_tips:[],warnings:[],confidence:.9},
    claims:[{key:"beijing.example.entry",subject:"Example Gate",predicate:"entry gate",value:"East Gate",qualifiers:[],source_quote:"Enter the Example Gate",confidence:.9}],
    blueprint:{format:"guide",hook:"Entry",angle:"planning",sections:[],strengths:[],gaps:[]} },"test","fixture");
  db.prepare(`INSERT INTO source_segments(id,source_id,segment_type,sequence,title,raw_text,content_hash,semantic_hash,status,created_at,updated_at)
    VALUES ('retained-segment',?,'paragraph_group',0,'Entry','Enter the Example Gate','content','semantic','complete','now','now')`).run(source.id);
  db.prepare(`INSERT INTO evidence_spans(id,source_id,segment_id,locator_type,quote,region_json,created_at)
    VALUES ('retained-evidence',?,'retained-segment','text','Enter the Example Gate','{}','now')`).run(source.id);
  repository.saveExperienceExtraction(source.id,{blocks:[]},"test");
  repository.rebuildKnowledge("beijing");
  const retainedBefore={ sources:db.prepare("SELECT COUNT(*) AS count FROM sources").get().count,
    assets:db.prepare("SELECT COUNT(*) AS count FROM source_assets").get().count,claims:db.prepare("SELECT COUNT(*) AS count FROM claims").get().count,
    evidence:db.prepare("SELECT COUNT(*) AS count FROM evidence_spans").get().count,knowledge:db.prepare("SELECT COUNT(*) AS count FROM knowledge_facts").get().count,
    experiences:db.prepare("SELECT COUNT(*) AS count FROM experience_extraction_runs").get().count };
  seedOpportunity(db);
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at,candidate_id)
    VALUES ('brief-state','beijing','State guide','[]','informational','drafted','2026-09-01','2026-09-01','candidate-state')`).run();
  db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at,revision,content_hash)
    VALUES ('draft-state','brief-state','State guide','state-guide','Body','{}','qa_failed','2026-09-01','2026-09-01',1,'hash-state')`).run();
  db.prepare(`INSERT INTO production_attempt_archives(id,opportunity_id,failing_job_id,failing_stage,snapshot_json,failure_code,created_at)
    VALUES ('attempt-state','opp-state','old-job','review_draft','{}','QA_FAILED','2026-09-01')`).run();
  repository.enqueue("review_draft","draft-state",{dedupeKey:"active:review"});

  repository.archiveProductionRecord("opp-state",{actor:"tester",idempotencyKey:"archive-state"});
  repository.archiveProductionRecord("opp-state",{actor:"tester",idempotencyKey:"archive-state"});
  assert.equal(repository.listContentWorkspace({productionOnly:true}).sections.history,1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM production_record_audit WHERE action='archive'").get().count,1);

  repository.deleteProductionRecord("opp-state",{actor:"tester",idempotencyKey:"delete-state"});
  repository.deleteProductionRecord("opp-state",{actor:"tester",idempotencyKey:"delete-state"});
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM content_briefs WHERE id='brief-state'").get().count,0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM article_drafts WHERE id='draft-state'").get().count,0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM topic_candidates WHERE id='candidate-state'").get().count,1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM content_opportunities WHERE id='opp-state' AND approved_at IS NOT NULL").get().count,1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM production_attempt_archives WHERE id='attempt-state'").get().count,1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM production_record_audit WHERE action='delete_production_record'").get().count,1);
  assert.deepEqual({ sources:db.prepare("SELECT COUNT(*) AS count FROM sources").get().count,
    assets:db.prepare("SELECT COUNT(*) AS count FROM source_assets").get().count,claims:db.prepare("SELECT COUNT(*) AS count FROM claims").get().count,
    evidence:db.prepare("SELECT COUNT(*) AS count FROM evidence_spans").get().count,knowledge:db.prepare("SELECT COUNT(*) AS count FROM knowledge_facts").get().count,
    experiences:db.prepare("SELECT COUNT(*) AS count FROM experience_extraction_runs").get().count },retainedBefore);
  assert.equal(repository.reconcileApprovedOpportunity("opp-state").queued,false);
});

test("remote WordPress drafts cannot be locally deleted", (t) => {
  const { db,repository }=repositoryFixture(t);
  seedOpportunity(db);
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at,candidate_id)
    VALUES ('brief-state','beijing','State guide','[]','informational','drafted','now','now','candidate-state')`).run();
  db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at,revision,content_hash)
    VALUES ('draft-state','brief-state','State guide','state-guide','Body','{}','wordpress_draft','now','now',1,'hash-state')`).run();
  repository.prepareWordPressPublication("draft-state","https://site.test");
  db.prepare("UPDATE wordpress_publications SET status='synced',post_id=42,preview_url='https://site.test/?p=42&preview=true',edit_url='https://site.test/wp-admin/post.php?post=42&action=edit'").run();
  assert.throws(() => repository.deleteProductionRecord("opp-state",{idempotencyKey:"delete-blocked"}), (error) => error.code === "REMOTE_WORDPRESS_DRAFT_EXISTS");
  assert.ok(db.prepare("SELECT 1 FROM article_drafts WHERE id='draft-state'").get());
});

test("page composition preview is structural and keeps the Frontend Contract boundary", () => {
  const preview=buildPageCompositionPreview({ frontend_page_payload_json:JSON.stringify({blocks:[
    {type:"article_hero",variant:"default",data:{title:"State guide",image_url:"https://img.test/hero.jpg"},claim_keys:["claim:1"]},
    {type:"affiliate_card",data:{title:"Book"}},
  ]}),frontend_page_status:"valid",frontend_page_current:1,frontend_contract_version:"2.1",frontend_schema_version:"2026-09" });
  assert.equal(preview.kind,"frontend_page_payload");
  assert.equal(preview.blocks.length,2);
  assert.equal(preview.blocks[1].commercial,true);
  assert.match(preview.notice,/不代表 WordPress 最终主题视觉/);
  assert.equal(JSON.stringify(preview).includes("JSX"),true);
});
