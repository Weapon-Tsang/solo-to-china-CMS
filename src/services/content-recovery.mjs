import fs from 'node:fs';
import { id, json, now } from '../utils.mjs';
import { transaction } from '../db.mjs';
import { validatePlanningDestination } from '../destination-consistency.mjs';
import { applyDeterministicGates } from '../ai/content-engine.mjs';
import { validatePageEvidence } from '../evidence-validator.mjs';
import { evaluateCoverage } from '../research-strategy.mjs';
import { recoveryDiagnosis } from './content-recovery-policy.mjs';

function conflict(message) { throw Object.assign(new Error(message), { statusCode: 409 }); }

function context(repo, candidateId) {
  const candidate = repo.db.prepare('SELECT * FROM topic_candidates WHERE id=?').get(candidateId);
  if (!candidate) return null;
  const brief = repo.db.prepare('SELECT * FROM content_briefs WHERE candidate_id=?').get(candidateId);
  const draft = brief && repo.db.prepare('SELECT id,revision,content_hash FROM article_drafts WHERE brief_id=?').get(brief.id);
  const activeJobs = repo.db.prepare("SELECT id,type,status FROM jobs WHERE entity_id IN (?,?,?) AND status IN ('queued','running')")
    .all(candidateId, brief?.id || '', draft?.id || '');
  const failedJob = repo.db.prepare(`SELECT id,type,status,last_error,entity_id,updated_at FROM jobs
    WHERE entity_id IN (?,?,?) AND status='failed'
      AND NOT EXISTS (SELECT 1 FROM jobs ok WHERE ok.entity_id=jobs.entity_id AND ok.type=jobs.type
        AND ok.status='succeeded' AND ok.updated_at>=jobs.updated_at)
    ORDER BY updated_at DESC LIMIT 1`).get(candidateId, brief?.id || '', draft?.id || '');
  return { candidate, brief, draft, activeJobs, failedJob };
}

function assetsFor(repo, ctx, packageFacts = null) {
  const facts = packageFacts ?? repo.getTopicPackage(ctx.candidate.id)?.facts ?? [];
  const ids = new Set(facts.flatMap((fact) => (fact.evidence || []).map((evidence) => evidence.source_id)));
  if (ctx.draft) {
    for (const row of repo.db.prepare(`SELECT sa.source_id FROM article_visuals av
      JOIN source_assets sa ON sa.id=av.source_asset_id WHERE av.draft_id=?`).all(ctx.draft.id)) ids.add(row.source_id);
  }
  if (!ids.size) return [];
  return repo.db.prepare(`SELECT sa.id,sa.source_id,sa.position,sa.alt_text,sa.remote_url,sa.language_status,
    sa.local_path,CASE WHEN sa.ai_derivative_data_url IS NOT NULL AND sa.ai_derivative_data_url<>'' THEN 1 ELSE 0 END AS has_bytes,
    sa.authorization_status,sa.publishable,s.authorization_status AS source_authorization,s.publishable AS source_publishable,
    s.title AS source_title,s.canonical_url,s.submitted_url,s.captured_at
    FROM source_assets sa JOIN sources s ON s.id=sa.source_id WHERE sa.kind='image'
      AND sa.source_id IN (${[...ids].map(() => '?').join(',')}) ORDER BY s.captured_at DESC,sa.position`)
    .all(...ids).map(({ local_path, ...row }) => ({
      ...row,
      has_bytes: Boolean(row.has_bytes || (local_path && fs.existsSync(local_path))),
      authorized: row.authorization_status === 'owner_confirmed' && row.publishable === 1
        && row.source_authorization === 'owner_confirmed' && row.source_publishable === 1,
    }));
}

export function contentRecoveryReport(repo, candidateId) {
  const ctx = context(repo, candidateId);
  if (!ctx) return null;
  const pkg = ctx.draft ? repo.getDraftPackage(ctx.draft.id) : repo.getTopicPackage(candidateId);
  const assets = assetsFor(repo, ctx, pkg.facts || []);
  const sources = new Map();
  for (const fact of pkg.facts || []) {
    for (const evidence of fact.evidence || []) if (evidence.source_id) sources.set(evidence.source_id, {
      id: evidence.source_id,
      title: evidence.source_title || evidence.title || evidence.source_id,
      url: evidence.final_url || evidence.canonical_url || evidence.original_url,
    });
  }
  for (const asset of assets) sources.set(asset.source_id, {
    id: asset.source_id, title: asset.source_title, url: asset.submitted_url || asset.canonical_url,
  });
  const localCheck = ctx.draft ? { ...applyDeterministicGates({ passed:true,score:100,issues:[],checks:[] },pkg), diagnosticOnly:true } : null;
  const automaticRepair = ctx.draft && (localCheck || pkg.review)
    ? repo.automaticQualityRepairState(ctx.draft.id, (localCheck || pkg.review).issues, { enqueue: false })
    : { eligible:false,queued:false,stage:null,attempts:0,maxAttempts:2,reason:'review_not_available' };
  const diagnosis = recoveryDiagnosis({ review:localCheck || pkg.review, failedJob:ctx.failedJob, automaticRepair });
  return {
    candidateId, title:ctx.candidate.proposed_title, destination:ctx.candidate.destination_slug,
    destinationCheck:validatePlanningDestination(pkg), canCorrectDestination:!ctx.brief,
    destinations:repo.db.prepare('SELECT slug,name FROM destinations ORDER BY name').all(),
    draftId:ctx.draft?.id || null, revision:ctx.draft?.revision || null, activeJobs:ctx.activeJobs,
    failedJob:ctx.failedJob || null, diagnosis,
    coverage:{ score:ctx.candidate.coverage_score, explanation:'选题所需素材的准备度，不是文章质量、事实准确率或完成进度。' },
    sources:[...sources.values()], assets,
    visuals:(pkg.draft?.visuals || []).map((visual) => ({
      id:visual.id, slot:visual.slot, alt:visual.alt_text, status:visual.status, assetId:visual.source_asset_id,
      source:assets.find((asset) => asset.id === visual.source_asset_id)?.source_id || null,
      acquisition:visual.acquisition_strategy,
      delivered:Boolean(visual.wordpress_media_id && visual.wordpress_media_url),
    })),
    latestReview:pkg.review ? { score:pkg.review.score, passed:pkg.review.passed, issues:pkg.review.issues } : null,
    editorial:ctx.draft ? { body:pkg.draft.body_markdown, evidenceLedger:pkg.draft.evidence_ledger, verificationNotes:pkg.draft.verification_notes } : null,
    localCheck,
    pageEvidenceErrors:ctx.draft && pkg.frontend_page?.payload ? validatePageEvidence(pkg.frontend_page.payload,pkg).errors : [],
    recaptureMessage:'打开下方对应原文，用新版采集扩展重新采集并确认真实授权。即使正文没有变化，新版也会补回原图文件；系统检测到该草稿已引用这张图后，会只从页面编排自动续跑并重新质检。若尚未选择图片槽位，再回到此处绑定对应图片。',
  };
}

export function executeContentRecovery(repo, candidateId, input, actor = 'administrator') {
  return transaction(repo.db, () => {
    const ctx = context(repo, candidateId);
    if (!ctx) return null;
    if (ctx.activeJobs.length) conflict('该选题已经有排队或运行中的任务，请等待完成，避免重复执行。');
    if (ctx.draft && input.revision !== ctx.draft.revision) conflict('草稿已被其他任务更新，请刷新后再操作。');
    if (ctx.candidate.status === 'dismissed') conflict('已移除的选题不能从恢复入口绕过确认。');
    let result;
    if (input.action === 'correct_destination') {
      if (ctx.brief) conflict('已有写作准备记录或草稿时不能直接改归属；请保留原稿并从内容建议创建正确版本。');
      const destination = repo.db.prepare('SELECT slug FROM destinations WHERE slug=?').get(String(input.destination || ''));
      if (!destination) conflict('请选择有效目的地。');
      const topic = repo.getTopicPackage(candidateId);
      const check = validatePlanningDestination({ ...topic,candidate:{ ...ctx.candidate,destination_slug:destination.slug } });
      if (!check.valid) conflict(check.message);
      const opportunities = repo.db.prepare('SELECT * FROM content_opportunities WHERE candidate_id=?').all(candidateId);
      repo.db.prepare("UPDATE topic_candidates SET destination_slug=?,coverage_score=0,status='candidate',updated_at=? WHERE id=?")
        .run(destination.slug, now(), candidateId);
      for (const opportunity of opportunities) {
        repo.db.prepare("UPDATE content_opportunities SET destination_slug=?,coverage_json=?,updated_at=? WHERE id=?")
          .run(destination.slug, JSON.stringify({ ...json(opportunity.coverage_json,{}),selectedFactKeys:[] }), now(), opportunity.id);
        const facts = repo.getTopicPackage(candidateId).facts;
        const mode = json(opportunity.coverage_json,{}).publicationMode;
        const matrix = evaluateCoverage({ topicKey:opportunity.topic_key,contentType:opportunity.content_type,facts,
          sourceFamilyCount:repo.independentSourceFamilyCountForFacts(facts),publicationMode:mode });
        const readiness = matrix.readiness;
        repo.db.prepare('UPDATE content_opportunities SET coverage_json=?,readiness_json=?,readiness_score=?,status=?,suppression_reason=?,updated_at=? WHERE id=?')
          .run(JSON.stringify({ ...matrix,publicationMode:mode,selectedFactKeys:facts.map((fact) => fact.normalized_key) }),
            JSON.stringify(readiness),readiness.score,opportunity.approved_at ? 'suppressed' : opportunity.status,
            opportunity.approved_at ? 'destination_recovery_requires_confirmation' : opportunity.suppression_reason,now(),opportunity.id);
        repo.db.prepare('UPDATE topic_candidates SET coverage_score=?,evidence_count=?,conflict_count=? WHERE id=?')
          .run(readiness.score,readiness.sourceFamilyCount || 0,readiness.conflictedCount || 0,candidateId);
      }
      result = { action:input.action,previousDestination:ctx.candidate.destination_slug,destination:destination.slug,previousOpportunities:opportunities,queued:false };
    } else if (input.action === 'save_editorial_correction') {
      if (!ctx.draft) conflict('没有可编辑的草稿。');
      const pkg = repo.getDraftPackage(ctx.draft.id);
      if (typeof input.body !== 'string' || !input.body.trim() || input.body.length > 150000) conflict('正文不能为空且不能超过 150000 字符。');
      if (!Array.isArray(input.evidenceLedger) || !Array.isArray(input.verificationNotes)
        || input.verificationNotes.some((note) => typeof note !== 'string')) conflict('证据台账和核验备注必须是 JSON 数组。');
      const keys = new Set(pkg.facts.map((fact) => fact.normalized_key));
      if (input.evidenceLedger.some((entry) => !entry || typeof entry.section !== 'string' || !Array.isArray(entry.claim_keys)
        || entry.claim_keys.some((key) => !keys.has(key)))) conflict('台账必须包含 section 和 claim_keys，且只能引用本篇已有证据编号。');
      repo.recordDraftRevision(ctx.draft.id, actor);
      repo.saveDraft(ctx.brief.id, { ...pkg.draft,body_markdown:input.body,evidence_ledger:input.evidenceLedger,
        verification_notes:input.verificationNotes }, 'human-correction');
      repo.db.prepare("UPDATE article_drafts SET status='drafted' WHERE id=?").run(ctx.draft.id);
      const jobId = repo.enqueue('compose_frontend_page', ctx.draft.id, { dedupeKey:`recovery-stage:compose_frontend_page:${ctx.draft.id}:r${ctx.draft.revision + 1}` });
      result = { action:input.action,jobId,queued:Boolean(jobId),requiresRecomposition:true };
    } else if (input.action === 'bind_asset') {
      if (!ctx.draft) conflict('没有可绑定图片的草稿。');
      const asset = assetsFor(repo,ctx).find((item) => item.id === input.assetId);
      if (!asset?.authorized || !asset.has_bytes) conflict('图片必须同时具备发布授权和已留存的文件，只有远程链接不能绑定。');
      const visual = repo.db.prepare('SELECT * FROM article_visuals WHERE id=? AND draft_id=?').get(input.visualId,ctx.draft.id);
      if (!visual) conflict('图片槽位不存在。');
      repo.recordDraftRevision(ctx.draft.id,actor);
      const localize = ['chinese','mixed'].includes(asset.language_status);
      repo.db.prepare(`UPDATE article_visuals SET source_asset_id=?,source_remote_url=?,acquisition_strategy=?,
        status=?,media_path=NULL,media_url=NULL,wordpress_media_id=NULL,wordpress_media_url=NULL,updated_at=? WHERE id=?`)
        .run(asset.id,asset.remote_url,localize ? 'localize_source_image' : 'use_authorized_source_image',
          localize ? 'planned' : 'generated',now(),visual.id);
      repo.db.prepare("UPDATE article_drafts SET revision=revision+1,quality_report_json='{}',status='drafted',updated_at=? WHERE id=?")
        .run(now(),ctx.draft.id);
      repo.invalidateDraftDependents(ctx.draft.id);
      repo.recordDraftRevision(ctx.draft.id,actor);
      const nextStage = localize ? 'generate_visuals' : 'compose_frontend_page';
      const jobId = repo.enqueue(nextStage,ctx.draft.id,{ dedupeKey:`recovery-stage:${nextStage}:${ctx.draft.id}:r${ctx.draft.revision + 1}` });
      result = { action:input.action,visualId:visual.id,previousAssetId:visual.source_asset_id,assetId:asset.id,jobId,queued:Boolean(jobId) };
    } else {
      const stage = String(input.action || '');
      if (!['compose_frontend_page','review_draft','revise_draft','plan_content'].includes(stage)) conflict('不支持的恢复操作。');
      if (stage === 'plan_content') {
        if (ctx.brief) conflict('已有写作准备记录，不会被重新覆盖。');
        const check = validatePlanningDestination(repo.getTopicPackage(candidateId));
        if (!check.valid) conflict(check.message);
        const approved = repo.db.prepare(`SELECT id,readiness_json FROM content_opportunities WHERE candidate_id=? AND
          (status IN ('approved_ready','producing') OR (status='suppressed' AND suppression_reason='destination_recovery_requires_confirmation' AND approved_at IS NOT NULL))`).get(candidateId);
        if (!approved) conflict('请先在内容建议中确认文章方案。');
        if (!json(approved.readiness_json,{}).ready) conflict('更正目的地后素材仍未准备好，请先补充证据。');
        repo.db.prepare("UPDATE content_opportunities SET status='producing',suppression_reason=NULL,updated_at=? WHERE id=?")
          .run(now(),approved.id);
      } else if (!ctx.draft) conflict('请先完成写作准备并生成草稿。');
      if (stage === 'compose_frontend_page') {
        const report = contentRecoveryReport(repo,candidateId);
        if (report.visuals.some((visual) => visual.assetId && !visual.delivered
          && !report.assets.find((asset) => asset.id === visual.assetId)?.has_bytes)) conflict('所选图片只有失效远程链接，请从下方原文重新采集并绑定。');
      }
      const entityId = stage === 'plan_content' ? candidateId : ctx.draft.id;
      const jobId = repo.enqueue(stage,entityId,{ dedupeKey:`recovery-stage:${stage}:${entityId}` });
      result = { action:stage,jobId,queued:Boolean(jobId),stageOnly:false };
    }
    repo.db.prepare(`INSERT INTO content_operation_history(id,candidate_id,action,status,preview_json,result_json,actor,created_at)
      VALUES (?,?,?,'completed',?,?,?,?)`).run(id('recovery'),candidateId,input.action,
        JSON.stringify({revision:ctx.draft?.revision}),JSON.stringify(result),String(actor).slice(0,200),now());
    return { ...result,previousOpportunities:undefined };
  });
}
