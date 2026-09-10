import fs from 'node:fs';
import { id, json, now } from '../utils.mjs';
import { transaction } from '../db.mjs';
import { validatePlanningDestination } from '../destination-consistency.mjs';
import { applyDeterministicGates } from '../ai/content-engine.mjs';
import { validatePageEvidence } from '../evidence-validator.mjs';
import { evaluateCoverage } from '../research-strategy.mjs';

function conflict(message) { throw Object.assign(new Error(message), { statusCode: 409 }); }
function context(repo, candidateId) {
  const candidate = repo.db.prepare('SELECT * FROM topic_candidates WHERE id=?').get(candidateId);
  if (!candidate) return null;
  const brief = repo.db.prepare('SELECT * FROM content_briefs WHERE candidate_id=?').get(candidateId);
  const draft = brief && repo.db.prepare('SELECT id,revision,content_hash FROM article_drafts WHERE brief_id=?').get(brief.id);
  const activeJobs = repo.db.prepare("SELECT id,type,status FROM jobs WHERE entity_id IN (?,?,?) AND status IN ('queued','running')")
    .all(candidateId, brief?.id || '', draft?.id || '');
  return { candidate, brief, draft, activeJobs };
}
function assetsFor(repo, ctx) {
  const facts = repo.getTopicPackage(ctx.candidate.id)?.facts || [];
  const ids = new Set(facts.flatMap(f => (f.evidence || []).map(e => e.source_id)));
  if (ctx.draft) for (const row of repo.db.prepare(`SELECT sa.source_id FROM article_visuals av JOIN source_assets sa ON sa.id=av.source_asset_id WHERE av.draft_id=?`).all(ctx.draft.id)) ids.add(row.source_id);
  if (!ids.size) return [];
  return repo.db.prepare(`SELECT sa.id,sa.source_id,sa.position,sa.alt_text,sa.remote_url,
    sa.local_path,CASE WHEN sa.ai_derivative_data_url IS NOT NULL AND sa.ai_derivative_data_url<>'' THEN 1 ELSE 0 END AS has_bytes,
    sa.authorization_status,sa.publishable,s.authorization_status AS source_authorization,s.publishable AS source_publishable,
    s.title AS source_title,s.canonical_url,s.submitted_url,s.captured_at
    FROM source_assets sa JOIN sources s ON s.id=sa.source_id WHERE sa.kind='image' AND sa.source_id IN (${[...ids].map(()=>'?').join(',')}) ORDER BY s.captured_at DESC,sa.position`)
    .all(...ids).map(({local_path,...row}) => ({...row,has_bytes:Boolean(row.has_bytes || (local_path && fs.existsSync(local_path))),
      authorized:row.authorization_status==='owner_confirmed' && row.publishable===1 && row.source_authorization==='owner_confirmed' && row.source_publishable===1}));
}
export function contentRecoveryReport(repo, candidateId) {
  const ctx = context(repo,candidateId);
  if (!ctx) return null;
  const pkg = ctx.draft ? repo.getDraftPackage(ctx.draft.id) : repo.getTopicPackage(candidateId);
  const assets = assetsFor(repo,ctx);
  const sources = new Map();
  for (const fact of pkg.facts || []) for (const e of fact.evidence || []) if (e.source_id) sources.set(e.source_id,{id:e.source_id,title:e.source_title || e.title || e.source_id,url:e.canonical_url});
  for (const asset of assets) sources.set(asset.source_id,{id:asset.source_id,title:asset.source_title,url:asset.submitted_url || asset.canonical_url});
  return { candidateId, title:ctx.candidate.proposed_title, destination:ctx.candidate.destination_slug,
    destinationCheck:validatePlanningDestination(pkg), canCorrectDestination:!ctx.brief,
    destinations:repo.db.prepare('SELECT slug,name FROM destinations ORDER BY name').all(),
    draftId:ctx.draft?.id || null, revision:ctx.draft?.revision || null, activeJobs:ctx.activeJobs,
    coverage:{score:ctx.candidate.coverage_score,explanation:'选题所需素材的准备度，不是文章质量、事实准确率或完成进度。'},
    sources:[...sources.values()], assets,
    visuals:(pkg.draft?.visuals || []).map(v=>({id:v.id,slot:v.slot,alt:v.alt_text,status:v.status,assetId:v.source_asset_id,
      source:assets.find(a=>a.id===v.source_asset_id)?.source_id || null, acquisition:v.acquisition_strategy,
      delivered:Boolean(v.wordpress_media_id && v.wordpress_media_url)})),
    latestReview:pkg.review ? {score:pkg.review.score,passed:pkg.review.passed,issues:pkg.review.issues} : null,
    editorial:ctx.draft ? {body:pkg.draft.body_markdown,evidenceLedger:pkg.draft.evidence_ledger,verificationNotes:pkg.draft.verification_notes} : null,
    localCheck:ctx.draft ? { ...applyDeterministicGates({passed:true,score:100,issues:[],checks:[]},pkg), diagnosticOnly:true } : null,
    pageEvidenceErrors:ctx.draft && pkg.frontend_page?.payload ? validatePageEvidence(pkg.frontend_page.payload,pkg).errors : [],
    recaptureMessage:'打开对应原文，用采集扩展重新采集并确认真实授权；回到此处刷新，选择对应图片并绑定。重采集可能触发来源提取/知识更新，但不会自动恢复这篇失败草稿；绑定后手动执行页面编排，再单独质检。',
  };
}
export function executeContentRecovery(repo,candidateId,input,actor='administrator') {
  return transaction(repo.db,()=>{
    const ctx=context(repo,candidateId);
    if (!ctx) return null;
    if(ctx.activeJobs.length) conflict('该选题已有排队或运行任务，请等待完成；不会重复启动或覆盖正在处理的内容。');
    if(ctx.draft && input.revision!==ctx.draft.revision) conflict('草稿已变更，请刷新恢复面板后再操作。');
    if(ctx.candidate.status==='dismissed') conflict('已取消或抑制的选题不能从恢复入口绕过确认。');
    let result;
    if(input.action==='correct_destination') {
      if(ctx.brief) conflict('已有规划/草稿时不能直接改归属；请保留原稿并通过人工命题创建正确归属的任务。');
      const destination=repo.db.prepare('SELECT slug FROM destinations WHERE slug=?').get(String(input.destination || ''));
      if(!destination) conflict('请选择已有目的地。');
      const topic=repo.getTopicPackage(candidateId);
      const check=validatePlanningDestination({...topic,candidate:{...ctx.candidate,destination_slug:destination.slug}});
      if(!check.valid) conflict(check.message);
      const opportunities=repo.db.prepare('SELECT * FROM content_opportunities WHERE candidate_id=?').all(candidateId);
      repo.db.prepare("UPDATE topic_candidates SET destination_slug=?,coverage_score=0,status='candidate',updated_at=? WHERE id=?").run(destination.slug,now(),candidateId);
      for(const o of opportunities) {
        // Reset the wrong-city selection before recomputing; preserve original data in history below.
        repo.db.prepare("UPDATE content_opportunities SET destination_slug=?,coverage_json=?,updated_at=? WHERE id=?")
          .run(destination.slug,JSON.stringify({...json(o.coverage_json,{}),selectedFactKeys:[]}),now(),o.id);
        const facts=repo.getTopicPackage(candidateId).facts;
        const mode=json(o.coverage_json,{}).publicationMode;
        const matrix=evaluateCoverage({topicKey:o.topic_key,contentType:o.content_type,facts,sourceFamilyCount:repo.independentSourceFamilyCountForFacts(facts),publicationMode:mode});
        const readiness=matrix.readiness;
        repo.db.prepare('UPDATE content_opportunities SET coverage_json=?,readiness_json=?,readiness_score=?,status=?,suppression_reason=?,updated_at=? WHERE id=?')
          .run(JSON.stringify({...matrix,publicationMode:mode,selectedFactKeys:facts.map(f=>f.normalized_key)}),JSON.stringify(readiness),readiness.score,
            o.approved_at?'suppressed':o.status,o.approved_at?'destination_recovery_requires_confirmation':o.suppression_reason,now(),o.id);
        repo.db.prepare('UPDATE topic_candidates SET coverage_score=?,evidence_count=?,conflict_count=? WHERE id=?')
          .run(readiness.score,readiness.sourceFamilyCount || 0,readiness.conflictedCount || 0,candidateId);
      }
      result={action:input.action,previousDestination:ctx.candidate.destination_slug,destination:destination.slug,previousOpportunities:opportunities,queued:false};
    } else if(input.action==='save_editorial_correction') {
      if(!ctx.draft) conflict('没有可编辑的草稿。');
      const pkg=repo.getDraftPackage(ctx.draft.id);
      if(typeof input.body!=='string' || !input.body.trim() || input.body.length>150000) conflict('正文必须非空且不超过 150000 字符。');
      if(!Array.isArray(input.evidenceLedger) || !Array.isArray(input.verificationNotes)
        || input.verificationNotes.some(n=>typeof n!=='string')) conflict('证据台账和核验备注必须是 JSON 数组。');
      const keys=new Set(pkg.facts.map(f=>f.normalized_key));
      if(input.evidenceLedger.some(e=>!e || typeof e.section!=='string' || !Array.isArray(e.claim_keys) || e.claim_keys.some(k=>!keys.has(k)))) conflict('台账必须含 section 和 claim_keys，且只能引用本篇已有证据编号。');
      repo.recordDraftRevision(ctx.draft.id,actor);
      repo.saveDraft(ctx.brief.id,{...pkg.draft,body_markdown:input.body,evidence_ledger:input.evidenceLedger,verification_notes:input.verificationNotes},'human-correction',{deferReview:true});
      repo.db.prepare("UPDATE article_drafts SET status='drafted' WHERE id=?").run(ctx.draft.id);
      result={action:input.action,queued:false,requiresRecomposition:true};
    } else if(input.action==='bind_asset') {
      if(!ctx.draft) conflict('没有可绑定图片的草稿。');
      const asset=assetsFor(repo,ctx).find(a=>a.id===input.assetId);
      if(!asset?.authorized || !asset.has_bytes) conflict('图片必须来自关联证据，已确认发布授权，并有已采集的图片字节；仅过期远程链接不可绑定。');
      const visual=repo.db.prepare('SELECT * FROM article_visuals WHERE id=? AND draft_id=?').get(input.visualId,ctx.draft.id);
      if(!visual) conflict('图片槽位不存在。');
      repo.recordDraftRevision(ctx.draft.id,actor);
      repo.db.prepare(`UPDATE article_visuals SET source_asset_id=?,source_remote_url=?,acquisition_strategy='use_authorized_source_image',
        status='generated',media_path=NULL,media_url=NULL,wordpress_media_id=NULL,wordpress_media_url=NULL,updated_at=? WHERE id=?`)
        .run(asset.id,asset.remote_url,now(),visual.id);
      repo.db.prepare("UPDATE article_drafts SET revision=revision+1,quality_report_json='{}',status='drafted',updated_at=? WHERE id=?").run(now(),ctx.draft.id);
      repo.invalidateDraftDependents(ctx.draft.id);
      repo.recordDraftRevision(ctx.draft.id,actor);
      result={action:input.action,visualId:visual.id,previousAssetId:visual.source_asset_id,assetId:asset.id,queued:false};
    } else {
      const stage=String(input.action || '');
      if(!['compose_frontend_page','review_draft','revise_draft','plan_content'].includes(stage)) conflict('不支持的恢复操作。');
      if(stage==='plan_content') {
        if(ctx.brief) conflict('已有规划不会被重新覆盖。');
        const check=validatePlanningDestination(repo.getTopicPackage(candidateId));
        if(!check.valid) conflict(check.message);
        const approved=repo.db.prepare(`SELECT id,readiness_json FROM content_opportunities WHERE candidate_id=? AND
          (status IN ('approved_ready','producing') OR (status='suppressed' AND suppression_reason='destination_recovery_requires_confirmation' AND approved_at IS NOT NULL))`).get(candidateId);
        if(!approved) conflict('请先在建议/人工命题中确认创作并补齐证据。');
        if(!json(approved.readiness_json,{}).ready) conflict('修正目的地后的素材仍未准备好，请先补齐证据。');
        repo.db.prepare("UPDATE content_opportunities SET status='producing',suppression_reason=NULL,updated_at=? WHERE id=?").run(now(),approved.id);
      } else if(!ctx.draft) conflict('请先完成规划和草稿。');
      if(stage==='review_draft' && !repo.getFrontendPageComposition(ctx.draft.id)?.current) conflict('当前版本页面尚未编排完成，请先编排页面。');
      if(stage==='compose_frontend_page') {
        const report=contentRecoveryReport(repo,candidateId);
        if(report.visuals.some(v=>v.assetId && !v.delivered && !report.assets.find(a=>a.id===v.assetId)?.has_bytes)) conflict('仍有图片只有远程链接；请先重新采集并绑定对应原图。');
      }
      const entityId=stage==='plan_content'?candidateId:ctx.draft.id;
      const jobId=repo.enqueue(stage,entityId,{dedupeKey:`manual-stage:${stage}:${entityId}`});
      result={action:stage,jobId,queued:true,stageOnly:stage!=='plan_content'};
    }
    repo.db.prepare(`INSERT INTO content_operation_history(id,candidate_id,action,status,preview_json,result_json,actor,created_at)
      VALUES (?,?,?,'completed',?,?,?,?)`).run(id('recovery'),candidateId,input.action,JSON.stringify({revision:ctx.draft?.revision}),JSON.stringify(result),String(actor).slice(0,200),now());
    return {...result,previousOpportunities:undefined};
  });
}
