import assert from "node:assert/strict";
import test from "node:test";
import { normalizeXiaohongshuCapture } from "../src/adapters/xiaohongshu.mjs";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";

function saveSource(repository,{externalId="second-pass-source",images=[],claims=2}={}) {
  const text="Take Line 2 from the airport. Use a supported mobile payment method. Check the last train before departure.";
  const saved=repository.saveCapture(normalizeXiaohongshuCapture({
    url:`https://www.xiaohongshu.com/explore/${externalId}`,title:"Shanghai airport metro",text,images,
  }));
  repository.saveExtraction(saved.id,{
    source:{language:"en",summary:text,destination_name:"Shanghai",destination_slug:"shanghai",traveler_fit:["solo"],practical_tips:[],warnings:[],confidence:.9},
    claims:[
      {key:"shanghai.metro.airport",subject:"Shanghai Metro",predicate:"airport route",value:"Take Line 2 from the airport",qualifiers:[],source_quote:"Take Line 2 from the airport",confidence:.9},
      {key:"shanghai.metro.payment",subject:"Shanghai Metro",predicate:"payment",value:"Use a supported mobile payment method",qualifiers:[],source_quote:"Use a supported mobile payment method",confidence:.9},
    ].slice(0,claims),
    blueprint:{format:"guide",hook:"arrival",angle:"practical",sections:[],strengths:[],gaps:[]},
  },"test","test");
  return saved.id;
}

function saveRecommendation(repository,sourceId) {
  repository.saveIntakeAnalysis(sourceId,{
    classification:"ARTICLE_CANDIDATE",recommended_action:"CREATE_CONTENT_PLAN",production_mode:"TOPIC_FEATURE",
    primary_topic:"Shanghai airport metro",suggested_article_title:"Shanghai airport metro arrival guide",
    suggested_content_type:"practical_guide",confidence:.9,article_potential:90,information_density:85,topic_completeness:70,
    reasoning_summary:"Current evidence can answer the arrival decision.",
  },"test");
  return repository.db.prepare("SELECT * FROM content_opportunities WHERE source_id=? ORDER BY created_at LIMIT 1").get(sourceId);
}

test("recommendation inbox separates processing gaps from approvable evidence gaps", (t) => {
  const {repository}=repositoryFixture(t);
  const sourceId=saveSource(repository);
  let opportunity=saveRecommendation(repository,sourceId);
  assert.equal(opportunity.processing_state,"PROCESSING_GAP");
  assert.equal(opportunity.inbox_state,"INTERNAL");
  assert.deepEqual(repository.listRecommendationInbox(),[]);

  repository.saveExperienceExtraction(sourceId,{blocks:[]},"test");
  const inbox=repository.listRecommendationInbox();
  assert.equal(inbox.length,1);
  assert.equal(inbox[0].processing_state,"EVIDENCE_GAP");
  assert.equal(inbox[0].displayStatus,"等待关键证据");
  const approved=repository.decideOpportunity(inbox[0].id,"approve");
  assert.equal(approved.needsEvidence,true);
  assert.deepEqual(repository.listProductionContentOpportunities(),[]);
  assert.deepEqual(repository.listContent({productionOnly:true}),[]);
});

test("recommendation backfill promotes compatible diagnostics without another model job", (t) => {
  const {db,repository}=repositoryFixture(t);
  const sourceId=saveSource(repository,{externalId:"stale-strategy-diagnostic"});
  repository.saveExperienceExtraction(sourceId,{blocks:[]},"test");
  saveRecommendation(repository,sourceId);
  db.prepare("UPDATE content_intake_analyses SET strategy_version='3.2' WHERE source_id=?").run(sourceId);
  db.prepare("UPDATE content_recommendations SET strategy_version='3.2' WHERE source_id=?").run(sourceId);
  db.prepare("UPDATE content_opportunities SET strategy_version='3.2' WHERE source_id=?").run(sourceId);
  db.prepare("DELETE FROM jobs").run();
  const preview=repository.runRecommendationReconciliationBackfill();
  assert.equal(preview.reusableDiagnosticSources,1);
  assert.equal(preview.staleDiagnosticSources,0);
  assert.equal(preview.modelCallsAvoided,1);
  assert.equal(preview.queued,0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs").get().n,0);
  const applied=repository.runRecommendationReconciliationBackfill({dryRun:false,approvedFromRunId:preview.id});
  assert.equal(applied.reused,1);
  assert.equal(applied.queued,0);
  assert.equal(applied.modelCallsAvoided,1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs").get().n,0);
  assert.equal(db.prepare("SELECT strategy_version FROM content_intake_analyses WHERE source_id=?").get(sourceId).strategy_version,repository.strategyVersion);
  assert.equal(db.prepare("SELECT strategy_version FROM content_recommendations WHERE source_id=?").get(sourceId).strategy_version,repository.strategyVersion);
  assert.equal(db.prepare("SELECT strategy_version FROM content_opportunities WHERE source_id=?").get(sourceId).strategy_version,repository.strategyVersion);
  assert.throws(()=>repository.runRecommendationReconciliationBackfill({dryRun:false,approvedFromRunId:"missing"}),/dry-run/);
});

test("recommendation backfill queues only diagnostics with an incompatible contract", (t) => {
  const {db,repository}=repositoryFixture(t);
  const sourceId=saveSource(repository,{externalId:"incompatible-strategy-diagnostic"});
  repository.saveExperienceExtraction(sourceId,{blocks:[]},"test");
  saveRecommendation(repository,sourceId);
  db.prepare("UPDATE content_intake_analyses SET strategy_version='1.8' WHERE source_id=?").run(sourceId);
  db.prepare("UPDATE content_recommendations SET strategy_version='1.8' WHERE source_id=?").run(sourceId);
  db.prepare("DELETE FROM jobs").run();
  const preview=repository.runRecommendationReconciliationBackfill();
  assert.equal(preview.reusableDiagnosticSources,0);
  assert.equal(preview.staleDiagnosticSources,1);
  const applied=repository.runRecommendationReconciliationBackfill({dryRun:false,approvedFromRunId:preview.id});
  assert.equal(applied.reused,0);
  assert.equal(applied.queued,1);
  const job=db.prepare("SELECT type,workload_class,recovery_run_id FROM jobs WHERE entity_id=?").get(sourceId);
  assert.equal(job.type,"analyze_source_diagnostic");
  assert.equal(job.workload_class,"historical_recovery");
  assert.equal(job.recovery_run_id,preview.id);
});

test("Content becomes visible only after the durable production entry job exists", (t) => {
  const {repository}=repositoryFixture(t);
  const sourceId=saveSource(repository);
  repository.saveExperienceExtraction(sourceId,{blocks:[]},"test");
  const opportunity=saveRecommendation(repository,sourceId);
  repository.listRecommendationInbox();
  repository.db.prepare(`UPDATE content_opportunities SET readiness_json='{"ready":true,"factCount":2,"sourceFamilyCount":1}',
    readiness_score=100,processing_state='CURRENT',inbox_state='ACTIONABLE' WHERE id=?`).run(opportunity.id);
  const result=repository.decideOpportunity(opportunity.id,"approve");
  assert.equal(result.queued,true);
  assert.equal(repository.listProductionContentOpportunities().length,1);
  assert.equal(repository.listContent({productionOnly:true}).length,1);
});

test("semantic intent reconciliation merges title variants without deleting internal opportunities", (t) => {
  const {db,repository}=repositoryFixture(t);
  const insert=db.prepare(`INSERT INTO content_opportunities(id,destination_slug,destination_scopes_json,topic_key,strategy_version,
    title,content_type,readiness_score,readiness_json,coverage_json,status,created_at,updated_at,lifecycle_state)
    VALUES (?,'chongqing','["chongqing"]',?,?,?,'itinerary',100,'{"ready":true,"factCount":4,"sourceFamilyCount":2}',
      '{"publicationMode":"topic_feature"}','recommended','2026-09-12','2026-09-12','recommended')`);
  insert.run("semantic-a","chongqing:72-hour",repository.strategyVersion,"Chongqing for first-time travelers: a 72-hour walking route");
  insert.run("semantic-b","chongqing:3-day",repository.strategyVersion,"3-day city walk itinerary in Chongqing");
  const summary=repository.reconcileRecommendationInbox();
  assert.equal(summary.internalOpportunities,2);
  assert.equal(summary.actionableInbox,1);
  assert.equal(summary.merged,1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM content_opportunities").get().n,2);
  assert.equal(repository.listRecommendationInbox().length,1);
});

test("superseded strategy rows do not inflate current processing totals", (t) => {
  const {db,repository}=repositoryFixture(t);
  db.prepare(`INSERT INTO content_opportunities(id,destination_slug,destination_scopes_json,topic_key,strategy_version,
    title,content_type,readiness_score,readiness_json,coverage_json,status,created_at,updated_at,lifecycle_state)
    VALUES ('historical-opportunity','chongqing','["chongqing"]','chongqing:historical','3.0','Historical guide',
      'practical_guide',100,'{"ready":true}','{"publicationMode":"topic_feature"}','recommended','now','now','recommended')`).run();
  const summary=repository.reconcileRecommendationInbox();
  assert.equal(summary.internalOpportunities,0);
  assert.equal(summary.processingGap,0);
  assert.equal(summary.superseded,1);
  assert.equal(repository.dashboardSummary().totals.processingGapOpportunities,0);
  assert.equal(db.prepare("SELECT inbox_state FROM content_opportunities WHERE id='historical-opportunity'").get().inbox_state,"SUPERSEDED");
});

test("historical production failure re-enters the inbox only with an active safe remediation", (t) => {
  const {db,repository}=repositoryFixture(t);
  db.prepare(`INSERT INTO content_opportunities(id,destination_slug,destination_scopes_json,topic_key,strategy_version,
    title,content_type,readiness_score,readiness_json,coverage_json,status,created_at,updated_at,lifecycle_state)
    VALUES ('retry-opportunity','xian','["xian"]','xian:retry',?,'Xi''an practical guide','practical_guide',100,
      '{"ready":true}','{"publicationMode":"topic_feature"}','recommended','now','now','recommended_again')`).run(repository.strategyVersion);
  db.prepare(`INSERT INTO failure_lessons(id,scope,failure_code,category,normalized_reason,opportunity_id,failing_stage,
    previous_input_json,remediation_rule,retry_safe,status,created_at,updated_at)
    VALUES ('retry-lesson','OPPORTUNITY','QUALITY','EDITORIAL_QUALITY','old prose failed','retry-opportunity','review_draft','{}',
      'Rebuild the narrative plan.',0,'active','now','now')`).run();
  db.prepare("UPDATE content_opportunities SET last_failure_lesson_id='retry-lesson' WHERE id='retry-opportunity'").run();
  assert.deepEqual(repository.listRecommendationInbox(),[]);
  assert.equal(db.prepare("SELECT inbox_state FROM content_opportunities WHERE id='retry-opportunity'").get().inbox_state,"SUPERSEDED");
  db.prepare("UPDATE failure_lessons SET retry_safe=1 WHERE id='retry-lesson'").run();
  assert.equal(repository.listRecommendationInbox()[0].displayStatus,"建议重新生产");
});

test("System Health excludes maintenance, browser repair, and editorial evidence work", (t) => {
  const {db,repository}=repositoryFixture(t);
  repository.enqueue("repair_media_asset","missing-media");
  repository.enqueue("rebuild_topic_clusters","maintenance-work");
  db.prepare("UPDATE jobs SET status='failed',last_error='operator repair required' WHERE entity_id='missing-media'").run();
  db.prepare("UPDATE jobs SET status='failed',last_error='knowledge rebuild input needs review' WHERE entity_id='maintenance-work'").run();
  const infra=repository.enqueue("resolve_entities","infra-auth");
  db.prepare("UPDATE jobs SET status='failed',last_failure_code='AI_PROVIDER_AUTH',last_error='credential rejected' WHERE id=?").run(infra);
  assert.ok(repository.listOperationalExceptions().length>=3);
  const health=repository.listSystemHealthIssues();
  assert.deepEqual(health.map((item) => item.key),[`job:${infra}`]);
  assert.equal(repository.dashboard().totals.exceptions,1);
});

test("repairing the last missing original invalidates recommendations and queues Experience recalculation", (t) => {
  const {db,repository}=repositoryFixture(t);
  const sourceId=saveSource(repository,{externalId:"processed-media-repair",images:[{
    url:"https://sns-img.xhscdn.com/processed-media.jpg",mediaIdentity:"processed-media",aiDerivativeDataUrl:"data:image/jpeg;base64,YQ==",
  }]});
  repository.saveExperienceExtraction(sourceId,{blocks:[]},"test");
  const opportunity=saveRecommendation(repository,sourceId);
  const asset=db.prepare("SELECT id FROM source_assets WHERE source_id=?").get(sourceId);
  repository.saveRecoveredMedia(asset.id,{localPath:"media/repaired.jpg",mimeType:"image/jpeg",sha256:"a".repeat(64),sizeBytes:123});
  const refreshed=db.prepare("SELECT processing_state,inbox_state,recommendation_reconciled_version FROM content_opportunities WHERE id=?").get(opportunity.id);
  assert.equal(refreshed.processing_state,"PROCESSING_GAP");
  assert.equal(refreshed.inbox_state,"INTERNAL");
  assert.equal(refreshed.recommendation_reconciled_version,"");
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM jobs WHERE type='extract_source_experience' AND entity_id=? AND status='queued'`).get(sourceId).n,1);
});

test("Experience backfill waits for original media and detects stale capture versions", (t) => {
  const {db,repository}=repositoryFixture(t);
  const blockedSource=saveSource(repository,{externalId:"experienceblocked",images:[{
    url:"https://sns-img.xhscdn.com/experience-blocked.jpg",mediaIdentity:"experience-blocked",aiDerivativeDataUrl:"data:image/jpeg;base64,YQ==",
  }]});
  db.prepare("UPDATE sources SET completeness_status='complete',status='processed' WHERE id=?").run(blockedSource);
  const currentSource=saveSource(repository,{externalId:"experiencestale"});
  repository.saveExperienceExtraction(currentSource,{blocks:[]},"test");
  db.prepare("UPDATE sources SET capture_version=capture_version+1 WHERE id=?").run(currentSource);

  const preview=repository.runExperienceBackfill({dryRun:true});
  assert.equal(preview.blockedByMedia,1,JSON.stringify(db.prepare("SELECT source_id,durability_status,repair_status FROM source_assets").all()));
  assert.equal(preview.eligible,1,JSON.stringify(db.prepare(`SELECT s.id,s.status,s.capture_version,s.completeness_status,
    er.capture_version AS experience_capture_version,er.status AS experience_status,er.degraded
    FROM sources s LEFT JOIN experience_extraction_runs er ON er.source_id=s.id ORDER BY s.id`).all()));
  assert.deepEqual(preview.sourceIds,[currentSource]);
  assert.equal(preview.sourceIds.includes(blockedSource),false);
});
