import test from 'node:test';
import assert from 'node:assert/strict';
import { explainQualityIssue, qualityRepairStage, recoveryDiagnosis } from '../src/services/content-recovery-policy.mjs';
import { buildContentTaskCard } from '../src/services/operations-workspace.mjs';
import { isDynamicFact, protectedFactTokens } from '../src/evidence-validator.mjs';
import { repositoryFixture } from '../test-support/repository-fixture.mjs';
import { contentRecoveryReport, executeContentRecovery } from '../src/services/content-recovery.mjs';
import { normalizeXiaohongshuCapture } from '../src/adapters/xiaohongshu.mjs';
import { transaction } from '../src/db.mjs';

function fixture(t) {
  const {db,repository}=repositoryFixture(t);
  db.prepare(`INSERT INTO topic_candidates(id,destination_slug,topic_key,proposed_title,rationale,coverage_score,evidence_count,conflict_count,status,created_at,updated_at)
    VALUES ('topic-r','chongqing','r','Chongqing guide','fixture',80,0,0,'drafted','now','now')`).run();
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at,candidate_id)
    VALUES ('brief-r','chongqing','Guide','[]','informational','drafted','now','now','topic-r')`).run();
  db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at,revision,content_hash)
    VALUES ('draft-r','brief-r','Guide','guide','Intro.\n\n## Visit\n\nBody.','{}','qa_failed','now','now',1,'hash-1')`).run();
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
test('old revision QA cannot masquerade as current QA on content list',t=>{
  const {db,repository}=fixture(t);
  repository.saveReview('draft-r',{passed:false,score:30,issues:[{code:'bad',severity:'blocker',message:'Old issue'}],checks:[],unsupported_claims:[]},'fixture');
  db.prepare("UPDATE article_drafts SET revision=2,content_hash='hash-2',quality_report_json='{}',status='qa_queued'").run();
  const row=repository.listContent()[0];
  assert.equal(row.qa_score,null);
  assert.equal(row.operation.dimensions.content_quality.status,'not_tested');
  assert.equal(row.workflow_status,'awaiting_review');
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
test('strategy startup rechecks a historical failure only once per draft revision',t=>{
  const {db,repository}=fixture(t);
  repository.saveReview('draft-r',{passed:false,score:40,issues:[{code:'protected_evidence_mismatch',severity:'blocker',message:'mismatch'}],checks:[],unsupported_claims:[]},'fixture');
  repository.enqueueStartupReconciliation();
  repository.enqueueStartupReconciliation();
  assert.equal(db.prepare("SELECT count(*) n FROM jobs WHERE dedupe_key LIKE 'strategy-quality-recheck:%'").get().n,1);
});
test('strategy startup does not retry a media-only failure before retained bytes are restored',t=>{
  const {db,repository}=fixture(t);
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
  const model403=recoveryDiagnosis({failedJob:{type:'compose_frontend_page',last_error:'Vertex Gemini request failed (403): permission denied'}});
  assert.match(model403.headline,/模型服务/);
  assert.doesNotMatch(model403.headline,/图片/);
  assert.match(model403.reason,/不代表来源图片失效/);
  const source403=recoveryDiagnosis({failedJob:{type:'compose_frontend_page',last_error:'Authorized source image download failed (403).'}});
  assert.match(source403.headline,/图片/);
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
