import test from 'node:test';
import assert from 'node:assert/strict';
import { explainQualityIssue, qualityRepairStage, recoveryDiagnosis } from '../src/services/content-recovery-policy.mjs';
import { buildContentTaskCard } from '../src/services/operations-workspace.mjs';
import { isDynamicFact, protectedFactTokens } from '../src/evidence-validator.mjs';
import { repositoryFixture } from '../test-support/repository-fixture.mjs';
import { contentRecoveryReport, executeContentRecovery } from '../src/services/content-recovery.mjs';
import { normalizeXiaohongshuCapture } from '../src/adapters/xiaohongshu.mjs';
import { transaction } from '../src/db.mjs';
import { dependencyHash } from '../src/pipeline-contract.mjs';

function fixture(t, contentConfig = {}) {
  const {db,repository}=repositoryFixture(t, contentConfig);
  db.prepare(`INSERT INTO topic_candidates(id,destination_slug,topic_key,proposed_title,rationale,coverage_score,evidence_count,conflict_count,status,created_at,updated_at)
    VALUES ('topic-r','chongqing','r','Chongqing guide','fixture',80,0,0,'drafted','now','now')`).run();
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at,candidate_id)
    VALUES ('brief-r','chongqing','Guide','[]','informational','drafted','now','now','topic-r')`).run();
  db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at,revision,content_hash)
    VALUES ('draft-r','brief-r','Guide','guide','Intro.\n\n## Visit\n\nBody.','{}','qa_failed','now','now',1,'hash-1')`).run();
  db.prepare(`INSERT INTO content_opportunities(id,destination_slug,topic_key,strategy_version,candidate_id,title,content_type,
    readiness_score,readiness_json,coverage_json,status,approved_at,created_at,updated_at,lifecycle_state,processing_state,
    canonical_intent_key,inbox_state,seo_action)
    VALUES ('opportunity-r','chongqing','r:approved','3.3','topic-r','Chongqing guide','practical_guide',100,
      '{"ready":true,"score":100}','{"publicationMode":"multi_source_synthesis","proposal":{"readerPromise":"Guide the reader."}}',
      'producing','now','now','now','producing','CURRENT','r:approved','ACTIONABLE','NEW')`).run();
  return {db,repository};
}

test('draft detail reuses its evidence hash without rebuilding the entire content workspace', t=>{
  const {db,repository}=fixture(t);
  repository.saveReview('draft-r',{passed:false,score:30,issues:[],checks:[],unsupported_claims:[]},'fixture');
  const original=repository.getBriefPackage.bind(repository);
  let loads=0;
  repository.getBriefPackage=(...args)=>{ loads++; return original(...args); };
  repository.getDraftPackage('draft-r');
  assert.equal(loads,1,'detail must load its brief once, not recompute workspace evidence');
  assert.deepEqual(repository.listContent({candidateId:'unrelated-topic'}),[]);
});

test('recovery report is read-only and targeted compose continues from the selected stage', t=>{
  const {db,repository}=fixture(t);
  const before=db.prepare('SELECT count(*) n FROM jobs').get().n;
  const report=contentRecoveryReport(repository,'topic-r');
  assert.equal(report.draftId,'draft-r');
  assert.equal(report.localCheck.diagnosticOnly,true);
  assert.equal(db.prepare('SELECT count(*) n FROM jobs').get().n,before);
  const result=executeContentRecovery(repository,'topic-r',{action:'compose_frontend_page',revision:1});
  assert.equal(result.stageOnly,false);
  const jobs=db.prepare('SELECT type,dedupe_key FROM jobs').all();
  assert.deepEqual(jobs.map(j=>j.type),['compose_frontend_page']);
  assert.match(jobs[0].dedupe_key,/^recovery-stage:/);
  assert.throws(()=>executeContentRecovery(repository,'topic-r',{action:'revise_draft',revision:1}),/已经有排队/);
  assert.equal(repository.listContent()[0].workflow_status,'compose_frontend_page_queued');
});
test('recovery detail preserves the current independent review instead of inventing unaudited brief failures',t=>{
  const {repository}=fixture(t);
  repository.saveReview('draft-r',{passed:false,score:72,
    checks:[{name:'brief-adaptation-1',passed:true,detail:'The required adaptation is present.'}],
    issues:[{code:'UNSUPPORTED_ASSERTION',severity:'blocker',message:'Great Hall opening hours are outside this article evidence scope.'}],
    unsupported_claims:['The Great Hall is open 09:00 to 18:00.']},'fixture');
  const report=contentRecoveryReport(repository,'opportunity-r');
  assert.equal(report.localCheck.diagnosticOnly,false);
  assert.equal(report.localCheck.source,'persisted_current_review');
  assert.equal(report.localCheck.issues.some((issue)=>issue.code==='mandatory_brief_requirement_missing'),false);
  assert.equal(report.diagnosis.headline,'正文包含当前证据范围外的事实');
  assert.equal(report.diagnosis.recommendedAction.id,'revise_draft');
});
test('legacy provider aliases are normalized consistently in recovery detail and production state',t=>{
  const {repository}=fixture(t);
  repository.saveReview('draft-r',{passed:false,score:62,
    checks:[{name:'brief-conflict-2',passed:false,detail:'The required hours are missing.'}],
    issues:[
      {code:'NO_TRAVELER_DECISION',severity:'blocker',message:'The draft does not satisfy brief-conflict-2.'},
      {code:'mandatory_brief_requirement_missing',severity:'blocker',message:'brief-conflict-2 is missing.'},
    ],unsupported_claims:[]},'legacy-provider');
  const report=contentRecoveryReport(repository,'opportunity-r');
  assert.deepEqual(report.localCheck.issues.map((issue)=>issue.code),['mandatory_brief_requirement_missing']);
  assert.deepEqual(report.latestReview.issues.map((issue)=>issue.code),['mandatory_brief_requirement_missing']);
  assert.equal(report.diagnosis.recommendedAction.id,'revise_draft');
  const state=repository.listContentWorkspace({productionOnly:true}).items[0].production_state;
  assert.equal(state.latest_error.code,'mandatory_brief_requirement_missing');
  assert.equal(state.recovery_target,'revise_draft');
});
test('a genuine traveler-decision issue remains distinct when it does not reference a Brief requirement',t=>{
  const {repository}=fixture(t);
  repository.saveReview('draft-r',{passed:false,score:62,checks:[],issues:[
    {code:'NO_TRAVELER_DECISION',severity:'blocker',message:'The route gives facts but no choice or next step.'},
  ],unsupported_claims:[]},'provider');
  const report=contentRecoveryReport(repository,'opportunity-r');
  assert.equal(report.localCheck.issues[0].code,'NO_TRAVELER_DECISION');
  assert.equal(repository.listContentWorkspace({productionOnly:true}).items[0].production_state.latest_error.code,
    'NO_TRAVELER_DECISION');
});
test('recovery refuses stale revisions, unknown images and existing-brief destination mutation while allowing independent QA',t=>{
  const {db,repository}=fixture(t);
  assert.throws(()=>executeContentRecovery(repository,'topic-r',{action:'compose_frontend_page',revision:0}),/其他任务更新/);
  assert.throws(()=>executeContentRecovery(repository,'topic-r',{action:'bind_asset',revision:1,assetId:'fake'}),/授权/);
  assert.equal(executeContentRecovery(repository,'topic-r',{action:'review_draft',revision:1}).action,'review_draft');
  db.prepare("DELETE FROM jobs").run();
  assert.throws(()=>executeContentRecovery(repository,'topic-r',{action:'correct_destination',revision:1,destination:'beijing'}),/写作准备/);
});
test('manual correction preserves revisions and queues independent QA plus page composition',t=>{
  const {db,repository}=fixture(t);
  executeContentRecovery(repository,'topic-r',{action:'save_editorial_correction',revision:1,body:'Corrected intro.\n\n## Visit\n\nSupported prose.',evidenceLedger:[],verificationNotes:[]});
  assert.equal(db.prepare('SELECT revision FROM article_drafts').get().revision,2);
  assert.equal(db.prepare('SELECT count(*) n FROM jobs').get().n,2);
  assert.deepEqual(db.prepare('SELECT type FROM jobs ORDER BY type').all().map((row)=>row.type),['compose_frontend_page','review_draft']);
  assert.equal(repository.listDraftRevisions('draft-r').length,2);
});
test('frozen revision rollback restores the exact passed body without replacing repaired media',t=>{
  const {db,repository}=fixture(t);
  db.prepare(`INSERT INTO article_visuals(id,draft_id,slot,placement,purpose,alt_text,generation_prompt,status,created_at,updated_at)
    VALUES ('visual-restored','draft-r',0,'hero','Keep','Keep','Keep','generated','now','now')`).run();
  repository.saveReview('draft-r',{passed:true,score:95,checks:[],issues:[],unsupported_claims:[]},'fixture');
  repository.recordDraftRevision('draft-r','before-repair');
  db.prepare("UPDATE article_drafts SET revision=2,body_markdown='Unwanted rewrite',content_hash='hash-2'").run();
  repository.recordDraftRevision('draft-r','bad-repair');
  const result=repository.restoreFrozenDraftRevision('draft-r',{
    targetRevision:1,expectedCurrentRevision:2,expectedContentHash:'hash-1',actor:'release-test',
  });
  const restored=db.prepare('SELECT revision,body_markdown,content_hash FROM article_drafts WHERE id=?').get('draft-r');
  assert.equal(restored.revision,1);
  assert.equal(restored.body_markdown,'Intro.\n\n## Visit\n\nBody.');
  assert.equal(restored.content_hash,'hash-1');
  assert.equal(db.prepare("SELECT COUNT(*) count FROM article_visuals WHERE id='visual-restored'").get().count,1);
  const job=db.prepare("SELECT type,dedupe_key,workload_class FROM jobs WHERE id=?").get(result.job_id);
  assert.equal(job.type,'compose_frontend_page');
  assert.match(job.dedupe_key,/^delivery-refresh:presentation:/);
  assert.equal(job.workload_class,'historical_recovery');
  assert.equal(result.preserved_wordpress_post,true);
  assert.equal(repository.getDraftPackage('draft-r').review.passed,true);
});
test('old revision QA cannot masquerade as current QA on content list',t=>{
  const {db,repository}=fixture(t);
  repository.saveReview('draft-r',{passed:false,score:30,issues:[{code:'bad',severity:'blocker',message:'Old issue'}],checks:[],unsupported_claims:[]},'fixture');
  db.prepare("UPDATE article_drafts SET revision=2,content_hash='hash-2',quality_report_json='{}',status='qa_queued'").run();
  const row=repository.listContent()[0];
  assert.equal(row.qa_score,null);
  assert.equal(row.operation.dimensions.content_quality.status,'not_tested');
  assert.equal(row.workflow_status,'awaiting_review');
});

test('a changed frontend page invalidates the reusable review artifact input',t=>{
  const {db,repository}=fixture(t);
  const job={type:'review_draft',entity_id:'draft-r',production_owner_opportunity_id:'opportunity-r'};
  const before=dependencyHash(repository.pipelineDependencyMaterial(job));
  db.prepare(`INSERT INTO frontend_contract_snapshots(id,source_repository,registry_source,page_schema_source,
    contract_version,schema_version,checksum,registry_json,page_schema_json,diff_json,status,synced_at,
    publish_package_schema_source,publish_package_version,publish_package_schema_json,artifact_checksum)
    VALUES ('snapshot-r','repo','registry','schema','1.4.0','1.0.0','checksum-r','{}','{}','{}','active','now','','','{}','')`).run();
  db.prepare(`INSERT INTO frontend_page_compositions(id,draft_id,snapshot_id,contract_version,schema_version,
    contract_checksum,payload_json,validation_json,status,model,generated_at,updated_at,draft_revision,draft_content_hash)
    VALUES ('page-r','draft-r','snapshot-r','1.4.0','1.0.0','checksum-r','{"metadata":{"title":"Guide"},"blocks":[]}',
      '{"valid":true,"blockProvenance":[]}','valid','deterministic','now','now',1,'hash-1')`).run();
  const after=dependencyHash(repository.pipelineDependencyMaterial(job));
  assert.notEqual(after,before);
  db.prepare("UPDATE frontend_page_compositions SET payload_json='{" + '"metadata":{"title":"Changed"},"blocks":[]}' + "' WHERE id='page-r'").run();
  assert.notEqual(dependencyHash(repository.pipelineDependencyMaterial(job)),after);
});
test('image recovery returns its exact source link and binds only retained authorized data',t=>{
  const {db,repository}=fixture(t);
  const saved=repository.saveCapture(normalizeXiaohongshuCapture({url:'https://www.xiaohongshu.com/explore/recoverysource',title:'Exact original note',text:'A captured source containing specific evidence about this scene.',images:[{url:'https://example.test/photo.jpg'}]}));
  const asset=db.prepare('SELECT id FROM source_assets WHERE source_id=?').get(saved.id);
  db.prepare("UPDATE sources SET authorization_status='owner_confirmed',publishable=1 WHERE id=?").run(saved.id);
  db.prepare("UPDATE source_assets SET authorization_status='owner_confirmed',publishable=1,ai_derivative_data_url='data:image/png;base64,iVBORw0KGgo=' WHERE id=?").run(asset.id);
  db.prepare(`INSERT INTO article_visuals(id,draft_id,slot,placement,purpose,alt_text,generation_prompt,created_at,updated_at,source_asset_id)
    VALUES ('visual-r','draft-r',0,'hero','Place view','View','','now','now',?)`).run(asset.id);
  const report=contentRecoveryReport(repository,'topic-r');
  assert.equal(report.visuals[0].source,saved.id);
  assert.equal(report.sources.find(s=>s.id===saved.id).url,'https://www.xiaohongshu.com/explore/recoverysource');
  assert.equal(report.assets[0].has_bytes,true);
  assert.equal(JSON.stringify(report).includes('iVBORw0KGgo='),false);
  executeContentRecovery(repository,'topic-r',{action:'bind_asset',revision:1,visualId:'visual-r',assetId:asset.id});
  assert.equal(db.prepare('SELECT revision FROM article_drafts').get().revision,2);
  assert.equal(db.prepare('SELECT source_asset_id FROM article_visuals').get().source_asset_id,asset.id);
});
test('nested transaction failure rolls back both child and parent writes',t=>{
  const {db}=fixture(t);
  assert.throws(()=>transaction(db,()=>{db.prepare("UPDATE topic_candidates SET coverage_score=1").run();transaction(db,()=>{db.prepare("UPDATE topic_candidates SET coverage_score=2").run();});throw new Error('abort');}),/abort/);
  assert.equal(db.prepare('SELECT coverage_score FROM topic_candidates').get().coverage_score,80);
});

test('media/page blockers do not automatically rewrite otherwise valid text', () => {
  assert.equal(qualityRepairStage([{code:'required_visual_missing',severity:'blocker'}]), null);
  assert.equal(qualityRepairStage([{code:'final_page_invalid',severity:'blocker'}]), 'compose_frontend_page');
  assert.equal(qualityRepairStage([{code:'WORD_COUNT_BELOW_TARGET',severity:'warning'}]), null);
  assert.equal(qualityRepairStage([{code:'UNSUPPORTED_FACTUAL_CLAIMS',severity:'blocker'}]), 'revise_draft');
  assert.equal(qualityRepairStage([{code:'UNSUPPORTED_FACTUAL_CLAIMS',severity:'blocker'},
    {code:'EVIDENCE_LEDGER_EVASION',severity:'blocker'}]), 'generate_draft');
  assert.equal(qualityRepairStage([{code:'confirmed_topic_coverage_missing',severity:'blocker',affected_count:4}]), 'generate_draft');
  assert.equal(qualityRepairStage([{code:'confirmed_topic_coverage_missing',severity:'blocker',affected_count:2}]), 'revise_draft');
  assert.equal(qualityRepairStage([{code:'planned_body_sections_missing',severity:'blocker',affected_count:1}]), 'generate_draft');
  assert.equal(qualityRepairStage([{code:'DATABASE_DUMP',severity:'blocker'}]), 'generate_draft');
  assert.equal(qualityRepairStage([{code:'NO_CAUSAL_FLOW',severity:'blocker'},
    {code:'UNIFORM_SECTION_RHYTHM',severity:'blocker'}]), 'generate_draft');
  assert.equal(qualityRepairStage([{code:'INVALID_DRAFT_REPAIR_SCOPE',severity:'blocker'}]), 'generate_draft');
  assert.equal(qualityRepairStage([{code:'mandatory_brief_requirement_missing',severity:'blocker',affected_count:4}]), 'generate_draft');
  assert.equal(qualityRepairStage([{code:'mandatory_brief_requirement_missing',severity:'blocker',affected_count:2}]), 'revise_draft');
  assert.equal(qualityRepairStage([{code:'confirmed_topic_coverage_missing',severity:'blocker',affected_count:1}],
    {repeatedBlockerCodes:['CONFIRMED_TOPIC_COVERAGE_MISSING']}), 'generate_draft');
  assert.equal(qualityRepairStage([{code:'final_page_invalid',severity:'blocker'}],
    {repeatedBlockerCodes:['FINAL_PAGE_INVALID']}), 'compose_frontend_page');
});

test('global evidence-ledger evasion regenerates only the draft from its existing writing packet',t=>{
  const {db,repository}=fixture(t);
  const issues=[{code:'EVIDENCE_LEDGER_EVASION',severity:'blocker',message:'widespread unsupported prose'}];
  const result=repository.automaticQualityRepairState('draft-r',issues,{enqueue:true,productionOwnerOpportunityId:'opportunity-r'});
  assert.equal(result.queued,true);
  assert.equal(result.stage,'generate_draft');
  const job=db.prepare("SELECT type,entity_id,production_owner_opportunity_id FROM jobs WHERE type='generate_draft'").get();
  assert.equal(job.entity_id,'brief-r');
  assert.equal(job.production_owner_opportunity_id,'opportunity-r');
});
test('quality regeneration feedback makes the failed review part of the reusable stage identity',t=>{
  const {db,repository}=fixture(t);
  const issues=[{code:'DATABASE_DUMP',severity:'blocker',message:'Unsupported fare and disconnected facts.'},
    {code:'readability_suggestion',severity:'warning',message:'One long sentence.'}];
  repository.saveReview('draft-r',{passed:false,score:38,issues,checks:[],unsupported_claims:[]},'fixture',
    {revision:1,contentHash:'hash-1',productionOwnerOpportunityId:'opportunity-r'});
  const feedback=repository.qualityRegenerationFeedback('brief-r');
  assert.equal(feedback.base_content_hash,'hash-1');
  assert.equal(feedback.quality_score,38);
  assert.deepEqual(feedback.blockers.map((item)=>item.code),['DATABASE_DUMP']);
  const repairJob={type:'generate_draft',entity_id:'brief-r',production_owner_opportunity_id:'opportunity-r',
    dedupe_key:'recovery-stage:opportunity-r:generate_draft:brief-r:manual:g2'};
  const before=dependencyHash(repository.pipelineDependencyMaterial(repairJob));
  db.prepare("UPDATE article_drafts SET revision=2,content_hash='hash-2'").run();
  repository.saveReview('draft-r',{passed:false,score:50,issues:[{code:'NO_CAUSAL_FLOW',severity:'blocker',message:'No trade-offs.'}],checks:[],unsupported_claims:[]},'fixture',
    {revision:2,contentHash:'hash-2',productionOwnerOpportunityId:'opportunity-r'});
  assert.notEqual(dependencyHash(repository.pipelineDependencyMaterial({...repairJob,dedupe_key:'recovery-stage:opportunity-r:generate_draft:brief-r:manual:g3'})),before);
  const accumulated=repository.qualityRegenerationFeedback('brief-r');
  assert.deepEqual(accumulated.blockers.map((item)=>item.code),['NO_CAUSAL_FLOW','DATABASE_DUMP']);
});
test('legacy plan and frozen packet scope mismatch recovers from editorial assembly instead of rewriting the draft',t=>{
  const {db,repository}=fixture(t);
  db.prepare(`UPDATE content_briefs SET plan_json=? WHERE id='brief-r'`).run(JSON.stringify({outline:[
    {section_id:'one',heading:'One',claim_keys:['fact.one']},{section_id:'two',heading:'Two',claim_keys:['fact.two']},
  ]}));
  db.prepare(`INSERT INTO editorial_assemblies(id,candidate_id,opportunity_id,input_hash,selected_fact_keys_json,created_at,updated_at)
    VALUES ('assembly-r','topic-r','opportunity-r','hash','["fact.one"]','now','now')`).run();
  db.prepare(`INSERT INTO narrative_plans(id,brief_id,created_at,updated_at) VALUES ('narrative-r','brief-r','now','now')`).run();
  db.prepare(`INSERT INTO writing_packets(id,brief_id,narrative_plan_id,packet_text,selected_fact_keys_json,input_hash,created_at,updated_at)
    VALUES ('packet-r','brief-r','narrative-r','legacy','["fact.one"]','hash','now','now')`).run();
  const state=repository.listContentWorkspace({productionOnly:true}).items[0].production_state;
  assert.equal(state.version,'2.0');
  assert.equal(state.stage_status,'failed');
  assert.equal(state.recovery_target,'assemble_editorial');
  assert.equal(state.latest_error.code,'FROZEN_WRITING_SCOPE_INVALID');
  const result=executeContentRecovery(repository,'opportunity-r',{action:'retry_failed_stage',revision:1,idempotencyKey:'scope-recovery'});
  assert.equal(result.resolvedStage,'assemble_editorial');
  assert.equal(db.prepare("SELECT type FROM jobs WHERE id=?").get(result.jobId).type,'assemble_editorial');
});
test('automatic quality repair is deduplicated per revision and stops after two attempts',t=>{
  const {db,repository}=fixture(t);
  const issues=[{code:'confirmed_topic_coverage_missing',severity:'blocker',message:'missing'}];
  repository.saveReview('draft-r',{passed:false,score:40,issues,checks:[],unsupported_claims:[]},'fixture');
  const listed=repository.listContent()[0];
  assert.equal(listed.operation.automaticRepair.reason,'ready_to_queue');
  assert.equal(listed.operation.automaticRepair.maxAttempts,2);
  const first=repository.automaticQualityRepairState('draft-r',issues,{enqueue:true});
  assert.equal(first.queued,true);assert.equal(first.attempts,1);
  const active=repository.automaticQualityRepairState('draft-r',issues,{enqueue:true});
  assert.equal(active.reason,'job_already_active');assert.equal(active.attempts,1);
  db.prepare("UPDATE jobs SET status='failed'").run();
  assert.equal(repository.automaticQualityRepairState('draft-r',issues,{enqueue:true}).reason,'revision_already_attempted');
  db.prepare("UPDATE article_drafts SET revision=2,content_hash='hash-2'").run();
  assert.equal(repository.automaticQualityRepairState('draft-r',issues,{enqueue:true}).attempts,2);
  db.prepare("UPDATE jobs SET status='failed'").run();
  db.prepare("UPDATE article_drafts SET revision=3,content_hash='hash-3'").run();
  assert.equal(repository.automaticQualityRepairState('draft-r',issues,{enqueue:true}).reason,'attempt_limit_reached');
});
test('a new explicit recovery run receives a fresh bounded quality-repair budget',t=>{
  const {db,repository}=fixture(t);
  const issues=[{code:'mandatory_brief_requirement_missing',severity:'blocker',message:'brief-conflict-2 is missing',affected_count:1}];
  repository.saveReview('draft-r',{passed:false,score:62,issues,checks:[],unsupported_claims:[]},'fixture');
  for (let revision=1; revision<=2; revision+=1) {
    const old=repository.automaticQualityRepairState('draft-r',issues,{enqueue:true});
    assert.equal(old.queued,true);
    db.prepare("UPDATE jobs SET status='failed'").run();
    db.prepare("UPDATE article_drafts SET revision=revision+1,content_hash=? WHERE id='draft-r'").run(`old-${revision}`);
  }
  assert.equal(repository.automaticQualityRepairState('draft-r',issues,{enqueue:false}).reason,'attempt_limit_reached');

  const recoveryRunId='recovery_run_current';
  const current=repository.automaticQualityRepairState('draft-r',issues,{enqueue:true,recoveryRunId,
    productionOwnerOpportunityId:'opportunity-r'});
  assert.equal(current.queued,true);
  assert.equal(current.attempts,1);
  assert.equal(db.prepare("SELECT recovery_run_id FROM jobs WHERE id=?").get(current.jobId).recovery_run_id,recoveryRunId);
  assert.match(db.prepare("SELECT dedupe_key FROM jobs WHERE id=?").get(current.jobId).dedupe_key,/recovery_run_current/);
  db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(current.jobId);
  db.prepare("UPDATE article_drafts SET revision=revision+1,content_hash='current-2' WHERE id='draft-r'").run();
  const second=repository.automaticQualityRepairState('draft-r',issues,{enqueue:true,recoveryRunId,
    productionOwnerOpportunityId:'opportunity-r'});
  assert.equal(second.queued,true);
  assert.equal(second.attempts,2);
  db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(second.jobId);
  db.prepare("UPDATE article_drafts SET revision=revision+1,content_hash='current-3' WHERE id='draft-r'").run();
  assert.equal(repository.automaticQualityRepairState('draft-r',issues,{enqueue:false,recoveryRunId}).reason,'attempt_limit_reached');
});
test('recovery diagnosis reports the current recovery run budget instead of historical attempts',t=>{
  const {db,repository}=fixture(t);
  const issues=[{code:'mandatory_brief_requirement_missing',severity:'blocker',message:'brief-conflict-2 is missing',affected_count:1}];
  repository.saveReview('draft-r',{passed:false,score:62,issues,checks:[],unsupported_claims:[]},'fixture',
    {revision:1,contentHash:'hash-1',productionOwnerOpportunityId:'opportunity-r'});
  for (let revision=1;revision<=2;revision+=1) {
    repository.automaticQualityRepairState('draft-r',issues,{enqueue:true,productionOwnerOpportunityId:'opportunity-r'});
    db.prepare("UPDATE jobs SET status='failed'").run();
    db.prepare("UPDATE article_drafts SET revision=revision+1,content_hash=? WHERE id='draft-r'").run(`old-${revision}`);
  }
  repository.enqueue('revise_draft','draft-r',{dedupeKey:'recovery-stage:current',recoveryRunId:'recovery_run_current',
    interactive:true,productionOwnerOpportunityId:'opportunity-r'});
  db.prepare("UPDATE jobs SET status='succeeded' WHERE recovery_run_id='recovery_run_current'").run();
  const report=contentRecoveryReport(repository,'opportunity-r');
  assert.equal(report.diagnosis.automatic.attempts,0);
  assert.equal(report.diagnosis.automatic.reason,'ready_to_queue');
});
test('a blocker repeated after one bounded repair escalates to full Draft regeneration',t=>{
  const {db,repository}=fixture(t);
  const issues=[{code:'confirmed_topic_coverage_missing',severity:'blocker',message:'Orientation remains ungrounded.',affected_count:1}];
  repository.saveReview('draft-r',{passed:false,score:70,issues,checks:[],unsupported_claims:[]},'fixture',
    {revision:1,contentHash:'hash-1',productionOwnerOpportunityId:'opportunity-r'});
  assert.equal(repository.automaticQualityRepairState('draft-r',issues,{enqueue:true,
    productionOwnerOpportunityId:'opportunity-r'}).stage,'revise_draft');
  db.prepare("UPDATE jobs SET status='succeeded'").run();
  db.prepare("UPDATE article_drafts SET revision=2,content_hash='hash-2'").run();
  repository.saveReview('draft-r',{passed:false,score:72,issues,checks:[],unsupported_claims:[]},'fixture',
    {revision:2,contentHash:'hash-2',productionOwnerOpportunityId:'opportunity-r'});
  const escalated=repository.automaticQualityRepairState('draft-r',issues,{enqueue:true,
    productionOwnerOpportunityId:'opportunity-r'});
  assert.equal(escalated.stage,'generate_draft');
  assert.equal(db.prepare("SELECT entity_id FROM jobs WHERE type='generate_draft'").get().entity_id,'brief-r');
});
test('the running review job does not block its own targeted repair enqueue',t=>{
  const {db,repository}=fixture(t);
  const reviewJob=repository.enqueue('review_draft','draft-r',{dedupeKey:'running-review',productionOwnerOpportunityId:'opportunity-r'});
  db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(reviewJob);
  const result=repository.automaticQualityRepairState('draft-r',
    [{code:'protected_evidence_mismatch',severity:'blocker',message:'mismatch'}],
    {enqueue:true,productionOwnerOpportunityId:'opportunity-r',ignoreActiveJobId:reviewJob});
  assert.equal(result.queued,true);
  assert.equal(result.stage,'revise_draft');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type='revise_draft'").get().count,1);
});
test('a parallel page failure cannot overwrite failed QA and terminal reconciliation queues one repair',t=>{
  const {db,repository}=fixture(t);
  repository.configureProductionCapabilities({frontendContract:true,visuals:true,wordpress:false});
  const issues=[{code:'protected_evidence_mismatch',severity:'blocker',message:'Changed protected facts'}];
  repository.saveReview('draft-r',{passed:false,score:70,issues,checks:[],unsupported_claims:[]},'fixture',
    {revision:1,contentHash:'hash-1',productionOwnerOpportunityId:'opportunity-r'});
  const pageJobId=repository.enqueue('compose_frontend_page','draft-r',{
    dedupeKey:'parallel-page',productionOwnerOpportunityId:'opportunity-r',
  });
  const pageJob=repository.claimJob();
  assert.equal(pageJob.id,pageJobId);
  assert.equal(repository.automaticQualityRepairState('draft-r',issues,{enqueue:true,
    productionOwnerOpportunityId:'opportunity-r'}).reason,'job_already_active');
  db.prepare(`UPDATE jobs SET status='failed',last_error='Frontend page payload is invalid: UNTRACEABLE_FACTUAL_BLOCK',
    last_failure_code='FINAL_PAGE_INVALID',failure_class='permanent_input',updated_at='now' WHERE id=?`).run(pageJobId);
  db.prepare("UPDATE article_drafts SET status='exception' WHERE id='draft-r'").run();

  const state=repository.listContentWorkspace({productionOnly:true}).items[0].production_state;
  assert.equal(state.version,'2.0');
  assert.equal(state.stage_status,'failed');
  assert.equal(state.current_stage,'review_draft');
  assert.equal(state.recovery_target,'revise_draft');
  assert.equal(state.next_stage,'revise_draft');
  assert.equal(state.completed_stages.includes('review_draft'),true);
  assert.equal(state.pending_stages.includes('revise_draft'),true);
  const reconciled=repository.reconcileDeferredQualityRepair(pageJob);
  assert.equal(reconciled.queued,true);
  const repairs=db.prepare("SELECT * FROM jobs WHERE type='revise_draft'").all();
  assert.equal(repairs.length,1);
  assert.equal(repairs[0].status,'queued');
  assert.equal(repository.reconcileDeferredQualityRepair(pageJob).reason,'job_already_active');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type='revise_draft'").get().count,1);

  const report=contentRecoveryReport(repository,'opportunity-r');
  assert.equal(report.failedJob,null);
  assert.equal(report.nonBlockingFailedJob.id,pageJobId);
  assert.equal(report.diagnosis.category,'content');
  assert.equal(report.diagnosis.recommendedAction.id,'revise_draft');
});
test('a parallel branch that finishes after failed QA releases the deferred repair join',t=>{
  const {db,repository}=fixture(t);
  const issues=[{code:'confirmed_topic_coverage_missing',severity:'blocker',message:'missing'}];
  repository.saveReview('draft-r',{passed:false,score:55,issues,checks:[],unsupported_claims:[]},'fixture',
    {revision:1,contentHash:'hash-1',productionOwnerOpportunityId:'opportunity-r'});
  const visualJobId=repository.enqueue('generate_visuals','draft-r',{
    dedupeKey:'parallel-visual',productionOwnerOpportunityId:'opportunity-r',
  });
  const visualJob=repository.claimJob();
  assert.equal(visualJob.id,visualJobId);
  assert.equal(repository.automaticQualityRepairState('draft-r',issues,{enqueue:true,
    productionOwnerOpportunityId:'opportunity-r'}).reason,'job_already_active');
  assert.equal(repository.finishPipelineJob(visualJob,null),true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type='revise_draft' AND status='queued'").get().count,1);
});
test('a terminal parallel-branch failure also releases the deferred repair join',t=>{
  const {db,repository}=fixture(t);
  const issues=[{code:'protected_evidence_mismatch',severity:'blocker',message:'mismatch'}];
  repository.saveReview('draft-r',{passed:false,score:60,issues,checks:[],unsupported_claims:[]},'fixture',
    {revision:1,contentHash:'hash-1',productionOwnerOpportunityId:'opportunity-r'});
  const visualJobId=repository.enqueue('generate_visuals','draft-r',{
    dedupeKey:'parallel-visual-failure',productionOwnerOpportunityId:'opportunity-r',
  });
  const visualJob=repository.claimJob();
  assert.equal(visualJob.id,visualJobId);
  assert.equal(repository.failJob(visualJob,Object.assign(new Error('legacy WebP rejection'),{
    retryable:false,code:'SOURCE_IMAGE_FORMAT_UNSUPPORTED',
  })),true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type='revise_draft' AND status='queued'").get().count,1);
});
test('an explicit visual-stage retry includes a previously failed visual slot',t=>{
  const {db,repository}=fixture(t);
  repository.replaceDraftVisuals('draft-r',[{
    placement:'hero',purpose:'Show the retained source',alt_text:'Chongqing source photo',caption:'',generation_prompt:'',
    aspect_ratio:'16:9',image_type:'real_world_photo',image_role:'hero',image_subject:'Chongqing',
    acquisition_strategy:'localize_source_image',factual_image_required:true,source_asset_id:null,status:'planned',
  }],'3.3');
  db.prepare("UPDATE article_visuals SET status='failed',last_error='legacy WebP rejection'").run();
  assert.equal(repository.plannedVisuals('draft-r').length,1);
  assert.equal(repository.plannedVisuals('draft-r')[0].status,'failed');
});
test('photo-overlay generation persists derivative proof used by final media validation',t=>{
  const {db,repository}=fixture(t);
  db.prepare(`INSERT INTO sources(id,adapter,canonical_url,captured_at,raw_text,raw_html,raw_payload_json,content_hash,created_at,updated_at)
    VALUES ('source-overlay','manual','manual-source://overlay','now','Evidence','','{}','overlay-hash','now','now')`).run();
  db.prepare(`INSERT INTO source_assets(id,source_id,kind,remote_url,position,local_path,mime_type,original_filename)
    VALUES ('source-photo','source-overlay','image','manual-asset://overlay/0',0,'source.jpg','image/jpeg','source.jpg')`).run();
  repository.replaceDraftVisuals('draft-r',[{
    placement:'hero',purpose:'Localize the retained overlay',alt_text:'Chongqing food collage',caption:'',generation_prompt:'',
    aspect_ratio:'3:4',image_type:'real_world_photo',image_role:'hero',image_subject:'Chongqing food',
    acquisition_strategy:'localize_photo_overlay',factual_image_required:true,source_asset_id:'source-photo',status:'planned',
  }],'3.5');
  const visual=db.prepare("SELECT id FROM article_visuals WHERE draft_id='draft-r'").get();
  repository.saveGeneratedVisual(visual.id,{mediaPath:'/generated/localized-overlay.png',mediaUrl:'https://engine.test/overlay.png',
    provider:'fixture',model:'fixture',metadata:{binary_qa:{status:'passed'}}});
  const metadata=JSON.parse(db.prepare("SELECT media_metadata_json FROM article_visuals WHERE id=?").get(visual.id).media_metadata_json);
  assert.equal(metadata.localized_file,true);
  assert.equal(metadata.localized_from_source_asset_id,'source-photo');
});
test('strategy startup rechecks a historical failure only once per draft revision',t=>{
  const {db,repository}=fixture(t,{productionStartupResumeEnabled:true});
  repository.saveReview('draft-r',{passed:false,score:40,issues:[{code:'protected_evidence_mismatch',severity:'blocker',message:'mismatch'}],checks:[],unsupported_claims:[]},'fixture');
  repository.enqueueStartupReconciliation();
  repository.enqueueStartupReconciliation();
  assert.equal(db.prepare("SELECT count(*) n FROM jobs WHERE dedupe_key LIKE 'strategy-quality-recheck:%'").get().n,1);
});
test('strategy startup does not retry a media-only failure before retained bytes are restored',t=>{
  const {db,repository}=fixture(t,{productionStartupResumeEnabled:true});
  repository.saveReview('draft-r',{passed:false,score:40,issues:[{code:'required_visual_missing',severity:'blocker',message:'missing'}],checks:[],unsupported_claims:[]},'fixture');
  repository.enqueueStartupReconciliation();
  assert.equal(db.prepare("SELECT count(*) n FROM jobs WHERE dedupe_key LIKE 'strategy-quality-recheck:%'").get().n,0);
});
test('operator diagnosis is concise Chinese and hides long code lists behind technical detail',()=>{
  const issue=explainQualityIssue({code:'protected_evidence_mismatch',severity:'blocker',message:`Changed: ${Array.from({length:30},(_,i)=>`claim.${i}`).join(', ')}`});
  assert.match(issue.title,/关键事实/);assert.match(issue.action,/修订/);assert.match(issue.technicalDetail,/另有/);
  const diagnosis=recoveryDiagnosis({review:{issues:[{code:'required_visual_missing',severity:'blocker',message:'missing'}]}});
  assert.match(diagnosis.headline,/实景图/);assert.equal(diagnosis.recommendedAction.id,null);
  const configuration=recoveryDiagnosis({failedJob:{type:'compose_frontend_page',last_error:'Content production requires a configured Kimi key or Vertex AI project.'}});
  assert.match(configuration.headline,/模型尚未配置/);assert.equal(configuration.automatic.reason,'operation_must_be_resolved_first');
  assert.match(configuration.recommendedAction.why,/重复点击仍会失败/);
  const repairScope=recoveryDiagnosis({failedJob:{type:'revise_draft',last_failure_code:'INVALID_DRAFT_REPAIR_SCOPE',
    last_error:'Draft repair cannot replace unknown section.'}});
  assert.match(repairScope.headline,/没有命中/);
  assert.equal(repairScope.recommendedAction.id,'generate_draft');
  const model403=recoveryDiagnosis({failedJob:{type:'compose_frontend_page',last_error:'Vertex Gemini request failed (403): permission denied'}});
  assert.match(model403.headline,/模型服务/);
  assert.doesNotMatch(model403.headline,/图片/);
  assert.match(model403.reason,/不代表来源图片失效/);
  const source403=recoveryDiagnosis({failedJob:{type:'compose_frontend_page',last_error:'Authorized source image download failed (403).'}});
  assert.match(source403.headline,/图片/);
  const media403=recoveryDiagnosis({failedJob:{type:'backfill_media_asset',last_failure_code:'REMOTE_MEDIA_403',last_error:'Remote media returned HTTP 403.'}});
  assert.match(media403.headline,/原件.*浏览器修复/);
  assert.doesNotMatch(`${media403.headline} ${media403.reason}`,/模型服务拒绝/);
  assert.equal(media403.recommendedAction.id,'recapture_media');
  const media503=recoveryDiagnosis({failedJob:{type:'backfill_media_asset',last_failure_code:'REMOTE_MEDIA_503',last_error:'Remote media returned HTTP 503.'}});
  assert.match(media503.headline,/自动保存没有完成/);
  assert.doesNotMatch(media503.recommendedAction.label,/浏览器/);
  const webp=recoveryDiagnosis({failedJob:{type:'generate_visuals',last_failure_code:'SOURCE_IMAGE_FORMAT_UNSUPPORTED',last_error:'原图格式不受图片翻译模型支持。'}});
  assert.match(webp.headline,/WebP/);
  assert.match(webp.reason,/已经留存/);
  assert.equal(webp.recommendedAction.id,'generate_visuals');
});
test('single-source stable photo descriptions do not require a fabricated as-of date', () => {
  assert.equal(isDynamicFact({normalized_key:'attraction.station.photo_spot_metro',consensus_method:'SINGLE_SOURCE_LATEST',freshness_state:'current'}), false);
  assert.equal(isDynamicFact({normalized_key:'attraction.museum.ticket_price',freshness_state:'current'}), true);
  assert.equal(isDynamicFact({normalized_key:'x.name',freshness_state:'stale'}), true);
  assert.equal(protectedFactTokens({preferred_value:'CNY 10 daytime'}).includes('CNY 10 day'), false);
});
test('next action prioritizes blockers over length warnings', () => {
  const card = buildContentTaskCard({id:'t',brief_id:'b',draft_id:'d',qa_score:50,qa_passed:0,
    quality_report_json:JSON.stringify({issues:[{severity:'warning',message:'Short'},{severity:'blocker',code:'required_visual_missing',message:'Missing factual photo'}]})});
  assert.match(card.dimensions.content_quality.reason, /缺少可交付的实景图/);
  assert.notEqual(card.retry?.stage, 'revise_draft');
});
