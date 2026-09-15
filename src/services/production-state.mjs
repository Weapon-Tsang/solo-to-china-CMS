import { json, sha256 } from "../utils.mjs";
import { validatePlanningDestination } from "../destination-consistency.mjs";
import { normalizeQualityReviewIssues } from "../ai/content-engine.mjs";
import { explainOperationalFailure, qualityRepairStage } from "./content-recovery-policy.mjs";

export const PRODUCTION_STATE_VERSION = "2.0";

export const PRODUCTION_STAGE_REGISTRY = Object.freeze([
  stage("assemble_editorial", "素材组装", 10, [], "editorial", "always"),
  stage("plan_content", "写作准备", 20, ["assemble_editorial"], "planning", "always"),
  stage("plan_narrative", "叙事规划", 30, ["plan_content"], "planning", "always"),
  stage("assemble_writing_packet", "Writing Packet", 40, ["plan_narrative"], "planning", "always"),
  stage("compose_frontend_page_plan", "页面规划", 50, ["assemble_writing_packet"], "page-plan", "frontendContract"),
  stage("generate_draft", "正文生成", 60, ["assemble_writing_packet"], "draft", "always"),
  stage("generate_visuals", "图片处理", 70, ["generate_draft"], "post-draft", "visuals"),
  stage("compose_frontend_page", "页面编排", 70, ["generate_draft"], "post-draft", "frontendContract"),
  stage("review_draft", "质量审核", 80, ["generate_draft"], "quality", "always"),
  stage("revise_draft", "定向修订", 85, ["review_draft"], "quality-repair", "whenPresent"),
  stage("compose_commercial", "商业内容组合", 90, ["review_draft"], "delivery", "always"),
  stage("compose_publish_page", "发布页面组合", 100, ["compose_commercial"], "delivery", "frontendAndWordpress"),
  stage("push_wordpress_draft", "WordPress 草稿投递", 110, ["compose_commercial"], "delivery", "wordpress"),
]);

export const PRODUCTION_JOB_TYPES = Object.freeze(PRODUCTION_STAGE_REGISTRY.map((item) => item.key));

const ACTIVE_STATUSES = new Set(["queued", "running"]);
// A passing QA receipt is bound to the current Draft revision/content/evidence
// and current Frontend Page.  It therefore proves that failures from an older
// prerequisite attempt are audit history, even when recovery used a previously
// persisted prerequisite to continue.  Media processing is deliberately not
// included: a parallel required-visual failure can still block final delivery.
const QA_SUPERSEDED_FAILURE_STAGES = new Set([
  "assemble_editorial", "plan_content", "plan_narrative", "assemble_writing_packet",
  "compose_frontend_page_plan", "generate_draft", "compose_frontend_page",
  "review_draft", "revise_draft",
]);

export function productionStageLabel(value) {
  return PRODUCTION_STAGE_REGISTRY.find((item) => item.key === value)?.label || String(value || "未知阶段");
}

export function productionStageActivityLabel(value, status) {
  const labels = {
    assemble_editorial: ["素材组装 · 排队中", "正在组装已批准素材"],
    plan_content: ["写作准备 · 排队中", "正在准备文章结构"],
    plan_narrative: ["叙事规划 · 排队中", "正在规划文章叙事"],
    assemble_writing_packet: ["Writing Packet · 排队中", "正在整理写作上下文"],
    compose_frontend_page_plan: ["页面规划 · 排队中", "正在规划页面组件"],
    generate_draft: ["正文生成 · 排队中", "正在生成正文"],
    generate_visuals: ["图片处理 · 排队中", "正在处理文章图片"],
    review_draft: ["质量审核 · 排队中", "正在进行质量审核"],
    revise_draft: ["定向修订 · 排队中", "正在定向修订正文"],
    compose_frontend_page: ["页面编排 · 排队中", "正在编排页面"],
    compose_commercial: ["商业内容 · 排队中", "正在组合商业内容"],
    compose_publish_page: ["发布页面 · 排队中", "正在生成最终发布页面"],
    push_wordpress_draft: ["WordPress 投递 · 排队中", "正在发送到 WordPress 草稿箱"],
  };
  const pair = labels[value];
  return pair ? pair[status === "running" ? 1 : 0] : `${productionStageLabel(value)} · ${status === "running" ? "执行中" : "排队中"}`;
}

export function buildProductionState(db, row, options = {}) {
  const capabilities = resolveCapabilities(db, row, options);
  const registry = PRODUCTION_STAGE_REGISTRY.filter((item) => stageEnabled(item, capabilities, db, row));
  const entityIds = [row.candidate_id, row.brief_id, row.draft_id].filter(Boolean);
  const legacyOwnerIsUnique = Boolean(row.approved_at && Number(row.approved_owner_count || 0) === 1);
  const jobs = entityIds.length ? db.prepare(`SELECT * FROM jobs WHERE entity_id IN (${placeholders(entityIds)})
    AND type IN (${placeholders(PRODUCTION_JOB_TYPES)})
    AND (production_owner_opportunity_id=? OR (production_owner_opportunity_id IS NULL AND ?=1))
    ORDER BY updated_at,created_at,id`).all(...entityIds, ...PRODUCTION_JOB_TYPES, row.opportunity_id, legacyOwnerIsUnique ? 1 : 0) : [];
  const scopeResetAt=db.prepare(`SELECT created_at FROM content_operation_history WHERE opportunity_id=?
    AND action='correct_destination' AND status='completed' ORDER BY created_at DESC,id DESC LIMIT 1`).get(row.opportunity_id)?.created_at || null;
  const currentJobs=scopeResetAt ? jobs.filter((item)=>String(item.updated_at)>String(scopeResetAt)) : jobs;
  const jobIds=currentJobs.map((item)=>item.id);
  const receipts = jobIds.length ? db.prepare(`SELECT stage,entity_id,job_id,created_at FROM pipeline_step_receipts
    WHERE job_id IN (${placeholders(jobIds)}) AND stage IN (${placeholders(PRODUCTION_JOB_TYPES)})
    ORDER BY created_at`).all(...jobIds,...PRODUCTION_JOB_TYPES) : [];
  const artifacts = entityIds.length && currentJobs.length ? db.prepare(`SELECT * FROM pipeline_artifacts
    WHERE entity_id IN (${placeholders(entityIds)}) AND stage IN (${placeholders(PRODUCTION_JOB_TYPES)})
    ORDER BY updated_at,created_at,id`).all(...entityIds,...PRODUCTION_JOB_TYPES)
    .filter((artifact)=>currentJobs.some((job)=>job.type===artifact.stage && job.entity_id===artifact.entity_id)) : [];
  const allJobIds=jobs.map((item)=>item.id);
  const allModelCalls = allJobIds.length ? db.prepare(`SELECT id,stage,entity_id,run_id,model,provider,request_kind,cache_hit,status,
    attempt_number,error_code,input_tokens,output_tokens,request_started_at,request_completed_at,created_at
    FROM model_call_metrics WHERE run_id IN (${placeholders(allJobIds)}) ORDER BY created_at,id`).all(...allJobIds) : [];
  const currentJobIds=new Set(jobIds);
  const modelCalls=allModelCalls.filter((item)=>currentJobIds.has(item.run_id));
  const evidence = persistedStageEvidence(db, row, { scopeResetAt });
  const initialEntries = registry.map((definition) => buildStageEntry(definition, currentJobs, artifacts, receipts, modelCalls, evidence));
  const destinationCheck = validatePlanningDestination({ candidate:{
    destination_slug:row.destination_slug,
    proposed_title:row.title || row.proposed_title,
  } });
  const scopeFailure = !row.brief_id && !destinationCheck.valid ? {
    type:"plan_content", last_error:`DESTINATION_TOPIC_MISMATCH: ${destinationCheck.message}`,
    last_failure_code:"DESTINATION_TOPIC_MISMATCH", failure_class:"permanent_input",
    updated_at:row.opportunity_updated_at, id:null,
  } : null;
  const frozenScopeFailure = frozenProductionScopeFailure(db,row);
  const truncatedDraftFailure = historicalDraftStructureFailure(db,row,currentJobs);
  const supersededRegenerationFailure = latestRegenerationSupersededRepair(currentJobs);
  const latestJobFailure=decorateDeliveryFailure(latestUnresolvedFailure(currentJobs));
  // A current passing review proves that its exact Draft revision, content hash,
  // evidence hash and Frontend Page made it through the quality gate. Older
  // failures in that same quality chain are audit history, even when no later
  // Job of the *same* type exists (for example, a full regeneration supersedes
  // an earlier bounded revise_draft failure).
  const supersededQualityFailure=Boolean(row.qa_passed) && QA_SUPERSEDED_FAILURE_STAGES.has(latestJobFailure?.type)
    && String(row.qa_created_at || "") >= String(latestJobFailure?.updated_at || "")
    ? latestJobFailure : null;
  const currentJobFailure=supersededQualityFailure ? null : latestJobFailure;
  const persistedFailure=inferredPersistedFailure(row);
  const resolvedDestinationFailure=!scopeFailure && destinationCheck.valid
    && String(currentJobFailure?.last_failure_code || '').toUpperCase()==='DESTINATION_TOPIC_MISMATCH' ? currentJobFailure : null;
  // A completed failing review is the authoritative content gate even when a
  // parallel image/page branch fails a few seconds later and marks the Draft
  // as exception.  A failed revise_draft attempt remains more specific than
  // that persisted review and therefore stays the active recovery target.
  const currentRepairFailure=currentJobFailure?.type === "revise_draft" ? currentJobFailure : null;
  const persistedQualityFailure=persistedFailure?.type === "review_draft" ? persistedFailure : null;
  const unresolvedFailure = scopeFailure || frozenScopeFailure || truncatedDraftFailure || (resolvedDestinationFailure ? null
    : currentRepairFailure || persistedQualityFailure || currentJobFailure || persistedFailure);
  const unresolvedDefinition = registry.find((item) => item.key === unresolvedFailure?.type) || null;
  const initiallyCompleted = new Set(initialEntries.filter((item) => item.status === "succeeded").map((item) => item.key));
  const missingFailureDependencies = unresolvedDefinition?.dependencies.filter((dependency) => !initiallyCompleted.has(dependency)) || [];
  const dependencyBrokenFailure = !scopeFailure && unresolvedFailure
    && (!unresolvedDefinition || missingFailureDependencies.length) ? unresolvedFailure : null;
  const entries = dependencyBrokenFailure ? initialEntries.map((entry) => entry.key === dependencyBrokenFailure.type
    ? { ...entry, status:"waiting", historical_failure:entry.error, error:null, blocks_current_flow:false }
    : entry) : initialEntries;
  const completedStages = entries.filter((item) => item.status === "succeeded").map((item) => item.key);
  const pendingStages = entries.filter((item) => item.status !== "succeeded").map((item) => item.key);
  const active = latestActiveJob(currentJobs, options.now);
  const failed = dependencyBrokenFailure ? null : unresolvedFailure;
  const firstPending = entries.find((item) => item.status !== "succeeded" && item.key !== "revise_draft") || null;
  const completed = completedStages.length;
  const total = registry.filter((item) => item.key !== "revise_draft" || stageEnabled(item, capabilities, db, row)).length;
  const progress = { completed, total, percent: total ? Math.min(100, Math.round(completed / total * 100)) : 0 };
  const readinessValue = parse(row.readiness_json, row.readiness || {});
  const readiness = row.approved_at ? (readinessValue.ready ? "ready" : "waiting_for_evidence") : "not_applicable";
  const control = controlState(db, row.opportunity_id);
  const lastAttemptAt = newestTimestamp([
    row.opportunity_updated_at, row.brief_updated_at, row.draft_updated_at,
    ...jobs.map((item) => item.updated_at), ...artifacts.map((item) => item.updated_at), control?.updated_at,
  ]);
  const ageBase = Date.parse(lastAttemptAt || row.approved_at || row.opportunity_updated_at || 0);
  const nowMs = options.now instanceof Date ? options.now.getTime() : Date.parse(options.now || "") || Date.now();
  const retryJob = active?.failure_class === "retryable_provider" ? active
    : failed?.failure_class === "retryable_provider" ? failed : null;
  const retryAttempts=Number(retryJob?.attempts || 0);
  const retryMaximum=Number(retryJob?.max_attempts || 0);
  const retryState = retryJob ? {
    reason:"provider_backoff",
    attempt:Math.min(retryAttempts,retryMaximum),
    max_attempts:retryMaximum,
    ...(retryAttempts>retryMaximum ? { attempts_total:retryAttempts } : {}),
    remaining_auto_attempts:Math.max(0,retryMaximum-retryAttempts),
    resume_at:retryJob.status === "queued" ? retryJob.next_eligible_at || retryJob.available_at || null : null,
  } : null;
  const graceMs = Math.max(60_000, Number(options.continuityGraceMs || 15 * 60_000));
  const beyondGrace = Number.isFinite(ageBase) && ageBase > 0 && nowMs - ageBase >= graceMs;
  const hasLineage = Boolean(row.approved_at || row.editorial_assembly_id || row.brief_id || row.narrative_plan_id
    || row.writing_packet_id || row.frontend_plan_status || row.draft_id || row.wordpress_status || jobs.length || artifacts.length
    || control || db.prepare("SELECT 1 FROM production_attempt_archives WHERE opportunity_id=? LIMIT 1").get(row.opportunity_id)
    || db.prepare("SELECT 1 FROM production_record_audit WHERE opportunity_id=? LIMIT 1").get(row.opportunity_id));
  const hasExecutionEvidence=Boolean(row.editorial_assembly_id || row.brief_id || row.narrative_plan_id
    || row.writing_packet_id || row.frontend_plan_status || row.draft_id || row.wordpress_status || jobs.length || artifacts.length
    || db.prepare("SELECT 1 FROM production_attempt_archives WHERE opportunity_id=? LIMIT 1").get(row.opportunity_id));
  const scopeConfirmationRequired=row.suppression_reason === "destination_recovery_requires_confirmation" && currentJobs.length === 0;

  let lifecycle = "pending_start";
  let stageStatus = "waiting";
  let currentStage = firstPending?.key || null;
  let currentStageLabel = currentStage ? productionStageLabel(currentStage) : "等待开始";
  let headline = readiness === "waiting_for_evidence" ? "已批准 · 等待补充证据" : "已批准 · 可以开始生产";
  let explanation = readiness === "waiting_for_evidence"
    ? "当前尚未进入正文生产；这是系统等待，不是错误，也不需要重复批准。证据满足后会自动继续。"
    : "创作方向和证据已经满足，可以进入生产队列。";
  let autoContinue = readiness === "waiting_for_evidence" || readiness === "ready";
  let needsHuman = false;
  let recoverable = false;
  let latestError = null;
  const scopeHistoricalFailure=scopeResetAt ? latestUnresolvedFailure(jobs.filter((item)=>String(item.updated_at)<=String(scopeResetAt))) : resolvedDestinationFailure;
  const latestHistoricalError = dependencyBrokenFailure
    ? failureAttribution(dependencyBrokenFailure, modelCalls, { blocksCurrentFlow:false })
    : scopeHistoricalFailure ? failureAttribution(scopeHistoricalFailure, allModelCalls, { blocksCurrentFlow:false })
      : supersededQualityFailure ? failureAttribution(supersededQualityFailure, allModelCalls, { blocksCurrentFlow:false })
        : supersededRegenerationFailure ? failureAttribution(supersededRegenerationFailure, allModelCalls, { blocksCurrentFlow:false }) : null;

  if (control?.disposition === "archived" || control?.disposition === "deleted") {
    lifecycle = "history";
    stageStatus = control.disposition === "deleted" ? "succeeded" : "interrupted";
    currentStage = null;
    currentStageLabel = control.disposition === "deleted" ? "生产记录已删除" : "已归档";
    headline = currentStageLabel;
    explanation = control.disposition === "deleted"
      ? "本次派生生产数据已清理；原始来源、证据、知识、审批和审计记录仍然保留。"
      : "这次生产尝试已归档，不再计入活跃工作台。";
    autoContinue = false;
  } else if (scopeConfirmationRequired) {
    lifecycle = "pending_start";
    stageStatus = "waiting";
    currentStage = null;
    currentStageLabel = "等待确认更正后的生产范围";
    headline = "目的地已更正 · 等待重新确认生产范围";
    explanation = "旧目的地下的失败和素材组装已移入历史；确认后会按重庆范围重新组装素材并自动继续。";
    autoContinue = false;
    needsHuman = true;
    recoverable = false;
  } else if (readiness === "waiting_for_evidence" && !hasExecutionEvidence) {
    currentStage = null;
    currentStageLabel = "等待补充证据";
  } else if (active?.expired) {
    lifecycle = "needs_attention";
    stageStatus = "interrupted";
    currentStage = active.type;
    currentStageLabel = productionStageLabel(active.type);
    headline = `流程中断：${currentStageLabel}的执行租约已失效`;
    explanation = "任务超过 durable job 租约且仍未恢复进度，需要从这一阶段安全继续。";
    autoContinue = false;
    needsHuman = true;
    recoverable = true;
  } else if (active?.retry_exhausted) {
    const explained = explainOperationalFailure(active);
    lifecycle = "needs_attention";
    stageStatus = "failed";
    currentStage = active.type;
    currentStageLabel = productionStageLabel(active.type);
    headline = `${currentStageLabel}失败：自动重试次数已用完`;
    explanation = explained?.reason || "模型服务多次拒绝或限流，系统已停止自动重试；已有成功产物仍然保留。";
    autoContinue = false;
    needsHuman = true;
    recoverable = true;
    latestError = failureAttribution(active, modelCalls, { explanation:explained });
  } else if (active) {
    lifecycle = "in_progress";
    stageStatus = active.status;
    currentStage = active.type;
    currentStageLabel = productionStageLabel(active.type);
    const providerCooling = active.status === "queued" && retryState?.remaining_auto_attempts > 0;
    headline = providerCooling ? `${currentStageLabel} · 等待模型配额恢复` : productionStageActivityLabel(active.type, active.status);
    explanation = providerCooling
      ? `Vertex 返回限流或配额不足，任务正在退避；系统还会自动尝试 ${retryState.remaining_auto_attempts} 次，不会重跑已完成步骤。`
      : active.status === "running" ? "系统正在执行当前步骤，完成后会按流水线依赖自动继续。" : "任务已进入 durable queue，将自动继续。";
    autoContinue = true;
  } else if (dependencyBrokenFailure && firstPending) {
    const firstPendingIndex = entries.findIndex((entry) => entry.key === firstPending.key);
    const lastComplete = entries.slice(0, Math.max(0, firstPendingIndex)).reverse().find((item) => item.status === "succeeded");
    lifecycle = "needs_attention";
    stageStatus = "interrupted";
    currentStage = lastComplete?.key || null;
    currentStageLabel = lastComplete ? `${lastComplete.label}后` : "尚未开始";
    headline = `流程断链：${firstPending.label}尚未完成`;
    explanation = unresolvedDefinition
      ? `历史的“${productionStageLabel(dependencyBrokenFailure.type)}”失败记录缺少当前流水线要求的前置步骤（${missingFailureDependencies.map(productionStageLabel).join("、")}）。恢复会先执行“${firstPending.label}”，不会跳过依赖或重跑已完成阶段。`
      : `历史的“${productionStageLabel(dependencyBrokenFailure.type)}”已不属于当前启用的生产路径。恢复会执行当前路径的第一个缺失步骤“${firstPending.label}”，不会重跑已完成阶段。`;
    autoContinue = false;
    needsHuman = true;
    recoverable = true;
  } else if (failed) {
    const explained = explainOperationalFailure(failed);
    lifecycle = "needs_attention";
    stageStatus = "failed";
    currentStage = failed.type;
    currentStageLabel = productionStageLabel(failed.type);
    headline = explained?.headline ? `${currentStageLabel}失败：${explained.headline}` : `${currentStageLabel}失败，需要处理`;
    explanation = explained?.reason || "这一步没有完成；已有成功产物仍然保留。";
    autoContinue = false;
    needsHuman = true;
    recoverable = !["APPROVED_SCOPE_INVALID", "EVIDENCE_SCOPE_INVALID", "DESTINATION_TOPIC_MISMATCH",
      "EDITORIAL_ASSEMBLY_INPUT_BUDGET_EXCEEDED", "PLAN_INPUT_BUDGET_EXCEEDED"]
      .includes(String(failed.last_failure_code || ""));
    latestError = failureAttribution(failed, modelCalls, { explanation:explained });
  } else if (row.wordpress_status === "synced") {
    lifecycle = "completed";
    stageStatus = "succeeded";
    currentStage = "push_wordpress_draft";
    currentStageLabel = productionStageLabel(currentStage);
    headline = "已生成 WordPress 草稿";
    explanation = row.wordpress_preview_url ? "可以直接预览最终页面，也可以进入 WordPress 编辑。" : "WordPress 已确认草稿，但没有返回可用的预览地址，需要检查投递响应。";
    autoContinue = false;
    if (!row.wordpress_preview_url) {
      lifecycle = "needs_attention";
      stageStatus = "blocked";
      needsHuman = true;
      recoverable = false;
      latestError = { code: "WORDPRESS_PREVIEW_URL_MISSING", reason: "WordPress 草稿已创建，但预览地址没有保存。", stage: "push_wordpress_draft", occurred_at: row.wordpress_updated_at || lastAttemptAt };
    }
  } else if (firstPending && hasLineage && (beyondGrace || ["exception", "qa_failed"].includes(row.brief_status) || ["exception", "qa_failed"].includes(row.draft_status))) {
    lifecycle = "needs_attention";
    stageStatus = "interrupted";
    const lastComplete = [...entries].reverse().find((item) => item.status === "succeeded");
    currentStage = lastComplete?.key || null;
    currentStageLabel = lastComplete ? `${lastComplete.label}后` : "尚未开始";
    headline = lastComplete ? `流程中断：${lastComplete.label}后停止，${firstPending.label}未入队`
      : `流程中断：生产尚未开始，${firstPending.label}未入队`;
    explanation = `下一步应为“${firstPending.label}”。恢复只会补这个缺失步骤，不会重跑已完成阶段。`;
    autoContinue = false;
    needsHuman = true;
    recoverable = true;
  } else if (!firstPending && hasLineage) {
    lifecycle = "completed";
    stageStatus = "succeeded";
    currentStage = entries.at(-1)?.key || null;
    currentStageLabel = currentStage ? productionStageLabel(currentStage) : "生产完成";
    headline = row.draft_id ? "内容生产已完成" : "生产准备已完成";
    explanation = "当前配置要求的生产阶段均已完成。";
    autoContinue = false;
  } else if (readiness === "ready" && beyondGrace) {
    lifecycle = "needs_attention";
    stageStatus = "interrupted";
    currentStage = "assemble_editorial";
    currentStageLabel = productionStageLabel(currentStage);
    headline = "流程中断：已批准但生产任务未启动";
    explanation = "证据已满足且超过启动宽限期，但 durable queue 中没有生产入口任务。";
    autoContinue = false;
    needsHuman = true;
    recoverable = true;
  }

  const recoveryTarget = stageStatus === "failed" ? failed?.recovery_type || currentStage
    : stageStatus === "interrupted" ? firstPending?.key || (active?.expired ? active.type : null) : null;
  const nextStage = lifecycle === "completed" || lifecycle === "history" ? null
    : stageStatus === "interrupted" ? recoveryTarget
      : ["queued","running","failed"].includes(stageStatus) ? followingStage(registry,currentStage)?.key || null
        : firstPending?.key || null;
  const availableActions = actionsFor({ lifecycle, stageStatus, recoverable, hasLineage, row, control, scopeConfirmationRequired });
  return {
    version: PRODUCTION_STATE_VERSION,
    lifecycle,
    readiness,
    headline,
    explanation,
    blocking_requirements: readiness === "waiting_for_evidence" ? (readinessValue.blockingRequirements || []) : [],
    current_stage: currentStage,
    current_stage_label: currentStageLabel,
    stage_status: stageStatus,
    completed_stages: completedStages,
    pending_stages: pendingStages,
    production_instance_id: row.opportunity_id,
    production_owner_opportunity_id: row.opportunity_id,
    owner_resolution: Number(row.approved_owner_count || 0) > 1 ? "explicit_job_owner_required" : "canonical",
    recovery_target: recoveryTarget,
    recovery_target_label: recoveryTarget ? productionStageLabel(recoveryTarget) : null,
    next_stage: nextStage,
    next_stage_label: nextStage ? productionStageLabel(nextStage) : null,
    progress,
    auto_continue: autoContinue,
    needs_human: needsHuman,
    recoverable,
    retry_state: retryState,
    latest_error: latestError,
    latest_historical_error: latestHistoricalError,
    last_attempt_at: lastAttemptAt,
    available_actions: availableActions,
    stage_registry: registry,
    timeline: entries,
    disposition: control?.disposition || "active",
    has_production_lineage: hasLineage,
  };
}

export function summarizeProductionSections(items = []) {
  const counts = { pending_start: 0, in_progress: 0, needs_attention: 0, completed: 0, history: 0, generated_body: 0 };
  for (const item of items) {
    const lifecycle = item.production_state?.lifecycle;
    if (Object.hasOwn(counts, lifecycle)) counts[lifecycle] += 1;
    if (item.draft_id) counts.generated_body += 1;
  }
  return counts;
}

export function buildPageCompositionPreview(row) {
  const plan = parse(row.frontend_page_plan_json, {});
  const page = parse(row.frontend_page_payload_json, {});
  const publish = parse(row.publish_package_json, {});
  const payload = publish.page?.blocks?.length ? publish.page : page;
  const blocks = Array.isArray(payload?.blocks) ? payload.blocks : Array.isArray(plan?.blocks) ? plan.blocks : [];
  return {
    kind: publish.page?.blocks?.length ? "publish_package" : page?.blocks?.length ? "frontend_page_payload" : plan?.blocks?.length ? "page_plan" : "unavailable",
    notice: "页面结构预览，不代表 WordPress 最终主题视觉。组件渲染、JSX 和 CSS 由 Frontend Contract / WordPress 主题负责。",
    contract_version: row.publish_contract_version || row.frontend_contract_version || row.frontend_plan_contract_version || null,
    schema_version: row.publish_schema_version || row.frontend_schema_version || row.frontend_plan_schema_version || null,
    contract_checksum: row.publish_contract_checksum || row.frontend_contract_checksum || row.frontend_plan_contract_checksum || null,
    payload_hash: row.page_content_hash || (blocks.length ? sha256(JSON.stringify(payload)) : null),
    validation: parse(row.publish_validation_json, parse(row.frontend_page_validation_json, parse(row.frontend_plan_validation_json, {}))),
    blocks: blocks.map((block, index) => ({
      order: index + 1,
      component: block.type || block.component || "unknown",
      variant: block.variant || null,
      heading: block.data?.title || block.data?.heading || block.heading || block.purpose || null,
      content_node_id: block.content_node_id || block.data?.contentNodeId || null,
      source_section_ids: block.source_section_ids || [],
      claim_keys: block.claim_keys || block.data?.claim_keys || [],
      image: block.data?.url || block.data?.src || block.data?.image_url || block.media_url || null,
      commercial: String(block.type || block.component || "").startsWith("affiliate_"),
      internal_links: collectLinks(block.data),
    })),
    seo: { present: Boolean(publish.seo || payload?.metadata?.seo), value: publish.seo || payload?.metadata?.seo || null },
    schema: { present: Boolean(publish.schema_jsonld), graph_count: Array.isArray(publish.schema_jsonld?.["@graph"]) ? publish.schema_jsonld["@graph"].length : 0 },
  };
}

function persistedStageEvidence(db, row, { scopeResetAt = null } = {}) {
  const briefReady = Boolean(row.brief_id);
  const reviewCompleted = row.qa_passed != null;
  return {
    assemble_editorial: scopeResetAt && !row.brief_id ? false : Boolean(row.editorial_assembly_id || row.brief_id),
    plan_content: briefReady,
    plan_narrative: Boolean(row.narrative_plan_id || row.writing_packet_id || row.draft_id),
    assemble_writing_packet: Boolean(row.writing_packet_id || row.draft_id),
    compose_frontend_page_plan: row.frontend_plan_status === "ready",
    generate_draft: Boolean(row.draft_id),
    generate_visuals: Number(row.visual_total || 0) === 0 ? null : Number(row.visual_pending || 0) === 0 && Number(row.visual_failed || 0) === 0,
    compose_frontend_page: row.frontend_page_status === "valid" && Boolean(row.frontend_page_current),
    review_draft: reviewCompleted,
    revise_draft: null,
    compose_commercial: Boolean(row.commercial_status),
    compose_publish_page: ["valid", "delivered", "delivery_failed"].includes(row.publish_composition_status) && Boolean(row.publish_composition_current),
    push_wordpress_draft: row.wordpress_status === "synced",
  };
}

function buildStageEntry(definition, jobs, artifacts, receipts, modelCalls, evidence) {
  const stageJobs = jobs.filter((item) => item.type === definition.key);
  const stageArtifacts = artifacts.filter((item) => item.stage === definition.key);
  const active = [...stageJobs].reverse().find((item) => ACTIVE_STATUSES.has(item.status));
  const failed = [...stageJobs].reverse().find((item) => item.status === "failed");
  const succeeded = [...stageJobs].reverse().find((item) => item.status === "succeeded");
  const persisted = evidence[definition.key];
  let status = persisted === true ? "succeeded" : "waiting";
  if (active) status = active.status;
  else if (failed && (!succeeded || String(failed.updated_at) > String(succeeded.updated_at))) status = "failed";
  else if (succeeded || stageArtifacts.some((item) => item.status === "succeeded") || receipts.some((item) => item.stage === definition.key)) status = persisted === false ? "waiting" : "succeeded";
  const latestJob = stageJobs.at(-1) || null;
  const latestArtifact = stageArtifacts.at(-1) || null;
  const call = [...modelCalls].reverse().find((item) => item.run_id === latestJob?.id)
    || [...modelCalls].reverse().find((item) => item.stage === definition.key) || null;
  return {
    ...definition,
    status,
    started_at: active?.started_at || latestJob?.started_at || latestArtifact?.started_at || null,
    completed_at: status === "succeeded" ? latestJob?.completed_at || latestArtifact?.completed_at || latestJob?.updated_at || null : null,
    attempts: stageJobs.reduce((sum, item) => sum + Number(item.attempts || 0), 0),
    latest_job_id: latestJob?.id || null,
    model: call?.model || null,
    provider: call?.provider || null,
    reused: Boolean((latestArtifact?.status === "succeeded" && !latestJob) || call?.cache_hit || call?.request_kind === "cache_hit"),
    error: status === "failed" ? { code: failed?.last_failure_code || failed?.failure_class || "PRODUCTION_FAILED", reason: failed?.last_error || "" } : null,
  };
}

function resolveCapabilities(db, row, options) {
  const configured = options.capabilities || {};
  const hasVisualWork = Boolean(Number(row.visual_total || 0) || (row.draft_id && db.prepare(`SELECT 1 FROM jobs
    WHERE entity_id=? AND type='generate_visuals' AND production_owner_opportunity_id=? LIMIT 1`).get(row.draft_id,row.opportunity_id)));
  return {
    frontendContract: configured.frontendContract ?? Boolean(row.frontend_plan_status || row.frontend_page_status || row.publish_composition_status
      || db.prepare("SELECT 1 FROM frontend_contract_state WHERE singleton=1 AND active_snapshot_id IS NOT NULL").get()),
    visuals: configured.visuals === false ? false : hasVisualWork,
    wordpress: configured.wordpress ?? Boolean(row.wordpress_status || row.publish_composition_status),
  };
}

function stageEnabled(definition, capabilities, db, row) {
  if (definition.required === "always") return true;
  if (definition.required === "frontendContract") return capabilities.frontendContract;
  if (definition.required === "visuals") return capabilities.visuals;
  if (definition.required === "wordpress") return capabilities.wordpress;
  if (definition.required === "frontendAndWordpress") return capabilities.frontendContract && capabilities.wordpress;
  if (definition.required === "whenPresent") {
    const report = parse(row.draft_quality_report_json, {});
    const qualityRepair = row.qa_passed != null && !Boolean(row.qa_passed)
      ? qualityRepairStage(normalizeQualityReviewIssues(report.issues)) : null;
    return qualityRepair === "revise_draft" || Boolean(row.draft_id && db.prepare(`SELECT 1 FROM jobs
      WHERE entity_id=? AND type='revise_draft' AND production_owner_opportunity_id=? LIMIT 1`).get(row.draft_id,row.opportunity_id));
  }
  return false;
}

function latestActiveJob(jobs, nowValue) {
  const nowMs = nowValue instanceof Date ? nowValue.getTime() : Date.parse(nowValue || "") || Date.now();
  const active = [...jobs].reverse().find((item) => ACTIVE_STATUSES.has(item.status));
  if (!active) return null;
  return { ...active,
    expired: active.status === "running" && active.lease_expires_at && Date.parse(active.lease_expires_at) <= nowMs,
    retry_exhausted: active.status === "queued" && active.next_eligible_at != null
      && Number(active.attempts || 0) >= Number(active.max_attempts || 0),
  };
}

function latestUnresolvedFailure(jobs) {
  const failures = jobs.filter((item) => item.status === "failed").reverse();
  return failures.find((failure) => !jobs.some((item) => item.type === failure.type && item.status === "succeeded"
    && String(item.updated_at) >= String(failure.updated_at))
    && !(failure.type === "revise_draft" && jobs.some((item) => item.type === "generate_draft" && item.status === "succeeded"
      && String(item.updated_at) >= String(failure.updated_at)))) || null;
}

function latestRegenerationSupersededRepair(jobs) {
  return jobs.filter((item) => item.type === "revise_draft" && item.status === "failed").reverse()
    .find((failure) => jobs.some((item) => item.type === "generate_draft" && item.status === "succeeded"
      && String(item.updated_at) >= String(failure.updated_at))) || null;
}

function decorateDeliveryFailure(failure) {
  if (!failure) return null;
  const code = String(failure.last_failure_code || failure.code || "").toUpperCase();
  if (failure.type === "push_wordpress_draft" && ["INVALID_PAGE_SCHEMA", "INVALID_COMPONENT_DATA"].includes(code)) {
    return { ...failure, recovery_type:"compose_publish_page" };
  }
  // A bounded repair that cannot express the required change must not be
  // retried indefinitely. Preserve the frozen Writing Packet and promote the
  // recovery target to a full draft regeneration only.
  if (failure.type === "revise_draft" && ["INVALID_DRAFT_REPAIR_SCOPE", "DRAFT_EVIDENCE_VALUE_INVALID", "MODEL_OUTPUT_LIMIT"].includes(code)) {
    return { ...failure, recovery_type:"generate_draft" };
  }
  return failure;
}

function inferredPersistedFailure(row) {
  if (row.brief_status === "exception") return {
    type: row.draft_id ? "generate_draft" : "plan_content",
    last_error: row.brief_last_error || "写作准备记录处于 exception，但没有关联的失败 Job；请从该阶段恢复。",
    last_failure_code: "BRIEF_EXCEPTION_WITHOUT_JOB",
    failure_class: "permanent_input",
    updated_at: row.brief_updated_at,
  };
  if (row.qa_passed != null && !Boolean(row.qa_passed)) {
    const report = parse(row.draft_quality_report_json, {});
    const issues = normalizeQualityReviewIssues(report.issues);
    const issue = issues.find((item) => item?.severity !== "warning") || issues[0] || null;
    return {
      type: "review_draft",
      recovery_type: qualityRepairStage(issues),
      last_error: issue?.message || issue?.reason || "当前版本的质量审核未通过；审核结果和原始草稿均已保留。",
      last_failure_code: issue?.code || "QUALITY_REVIEW_FAILED",
      failure_class: "permanent_input",
      updated_at: row.draft_updated_at,
    };
  }
  if (row.draft_status === "exception") return {
    type: "generate_draft",
    last_error: "草稿生产状态显示失败，但没有关联的失败 Job；原始状态已保留。",
    last_failure_code: "DRAFT_EXCEPTION_WITHOUT_JOB",
    failure_class: "permanent_input",
    updated_at: row.draft_updated_at,
  };
  return null;
}

function frozenProductionScopeFailure(db,row) {
  if (!row.brief_id || !row.writing_packet_id) return null;
  const chain=db.prepare(`SELECT cb.plan_json,wp.selected_fact_keys_json,wp.updated_at AS packet_updated_at,
    ea.updated_at AS assembly_updated_at,cb.updated_at AS brief_updated_at,np.updated_at AS narrative_updated_at
    FROM content_briefs cb JOIN writing_packets wp ON wp.brief_id=cb.id
    LEFT JOIN editorial_assemblies ea ON ea.candidate_id=cb.candidate_id
    LEFT JOIN narrative_plans np ON np.brief_id=cb.id WHERE cb.id=?`).get(row.brief_id);
  if (!chain) return null;
  const selected=new Set(parse(chain.selected_fact_keys_json,[]));
  const outline=parse(chain.plan_json,{}).outline || [];
  const unavailable=[...new Set(outline.flatMap((section)=>section.claim_keys || []))].filter((key)=>!selected.has(key));
  const uncovered=outline.filter((section)=>(section.claim_keys || []).length
    && !(section.claim_keys || []).some((key)=>selected.has(key))).map((section)=>section.section_id || section.heading);
  if (!unavailable.length && !uncovered.length) return null;
  return {
    type:"assemble_editorial",recovery_type:"assemble_editorial",last_failure_code:"FROZEN_WRITING_SCOPE_INVALID",
    failure_class:"permanent_input",updated_at:chain.packet_updated_at || chain.brief_updated_at,
    last_error:`Frozen Writing Packet 与页面计划不一致：${unavailable.length} 个计划事实未冻结，${uncovered.length} 个章节没有可用证据。`,
  };
}

function historicalDraftStructureFailure(db,row,currentJobs) {
  if (!row.brief_id || !row.draft_id || currentJobs.some((job)=>ACTIVE_STATUSES.has(job.status))) return null;
  if (Boolean(row.qa_passed) || !["qa_failed","exception"].includes(String(row.draft_status || ""))) return null;
  const record=db.prepare(`SELECT cb.plan_json,ad.body_markdown,ad.updated_at
    FROM content_briefs cb JOIN article_drafts ad ON ad.brief_id=cb.id
    WHERE cb.id=? AND ad.id=?`).get(row.brief_id,row.draft_id);
  if (!record?.body_markdown) return null;
  const outline=parse(record.plan_json,{}).outline || [];
  const planned=outline.map((section)=>String(section.heading || "").trim()).filter(Boolean);
  if (planned.length < 2) return null;
  const actual=String(record.body_markdown).split(/\r?\n/)
    .map((line)=>line.match(/^#{2,6}\s+(.+?)\s*$/)?.[1] || "")
    .map(normalizeHeadingIdentity).filter(Boolean);
  const missing=planned.filter((heading)=>{
    const expected=normalizeHeadingIdentity(heading);
    return expected && !actual.some((value)=>value === expected || value.includes(expected) || expected.includes(value));
  });
  if (!missing.length) return null;
  const present=planned.length-missing.length;
  if (present / planned.length >= 0.75) return null;
  return {
    type:"review_draft",recovery_type:"generate_draft",last_failure_code:"PLANNED_BODY_SECTIONS_MISSING",
    failure_class:"permanent_input",updated_at:record.updated_at,
    last_error:`当前草稿缺少 ${missing.length}/${planned.length} 个页面计划章节，不能继续做局部修订；系统将从已保留的 Writing Packet 重新生成正文。`,
  };
}

function normalizeHeadingIdentity(value) {
  return String(value || "").normalize("NFKC").toLowerCase()
    .replace(/[*_`~]/g,"").replace(/[^\p{L}\p{N}]+/gu," ").trim();
}

function failureAttribution(failed, modelCalls, { explanation = null, blocksCurrentFlow = true } = {}) {
  const explained = explanation || explainOperationalFailure(failed);
  const failedCall = [...modelCalls].reverse().find((item) => item.run_id === failed.id) || null;
  const providerRequestSent = Boolean(failedCall && failedCall.request_kind !== "cache_hit");
  const hasUsage = failedCall?.input_tokens != null || failedCall?.output_tokens != null;
  const modelExecution = !providerRequestSent ? "not_requested"
    : failedCall.status === "succeeded" || hasUsage ? "confirmed"
      : ["SCHEMA_MODE_UNSUPPORTED", "400", "INVALID_ARGUMENT"].includes(String(failedCall.error_code || "").toUpperCase())
        ? "rejected_before_generation" : "unknown";
  return {
    code: failed.last_failure_code || failed.failure_class || "PRODUCTION_FAILED",
    reason: explained?.reason || String(failed.last_error || "这一步没有完成。"),
    stage: failed.type,
    stage_label: productionStageLabel(failed.type),
    occurred_at: failed.updated_at || failed.completed_at || null,
    job_id: failed.id || null,
    request_id: failedCall?.id || null,
    attempt: Number(failedCall?.attempt_number || failed.attempts || 0),
    failure_class: failed.failure_class || null,
    provider: failedCall?.provider || null,
    model: failedCall?.model || null,
    provider_request_sent: providerRequestSent,
    model_execution: modelExecution,
    model_called: modelExecution === "confirmed",
    blocks_current_flow: blocksCurrentFlow,
  };
}

function controlState(db, opportunityId) {
  return db.prepare("SELECT * FROM production_record_controls WHERE opportunity_id=?").get(opportunityId) || null;
}

function actionsFor({ lifecycle, stageStatus, recoverable, hasLineage, row, control, scopeConfirmationRequired }) {
  const actions = ["view_details"];
  if (lifecycle === "history") {
    actions.push("view_history");
    if (control?.disposition === "archived" && !row.wordpress_post_id) actions.push("restore_archive");
    return actions;
  }
  if (scopeConfirmationRequired) actions.push("confirm_destination_scope");
  if (stageStatus === "failed" && recoverable) actions.push("retry_failed_stage");
  if (stageStatus === "interrupted" && recoverable) actions.push("recover_next_stage");
  if (hasLineage) actions.push("archive");
  if (hasLineage && !row.wordpress_post_id && row.wordpress_status !== "synced") actions.push("delete_production_record");
  if (row.frontend_plan_status || row.frontend_page_status || row.publish_composition_status) actions.push("preview_page_structure");
  if (row.wordpress_preview_url) actions.push("preview_final_page");
  if (row.wordpress_edit_url) actions.push("edit_wordpress");
  actions.push("view_history");
  return [...new Set(actions)];
}

function collectLinks(data) {
  if (!data || typeof data !== "object") return [];
  return [...new Set(Object.entries(data).filter(([key, value]) => /(?:url|href|link)$/i.test(key) && typeof value === "string" && /^https?:\/\//i.test(value)).map(([, value]) => value))];
}

function newestTimestamp(values) { return values.filter(Boolean).sort((a, b) => String(b).localeCompare(String(a)))[0] || null; }
function followingStage(registry,current) {
  if (!current) return registry[0] || null;
  const index=registry.findIndex((item)=>item.key===current);
  return index>=0 ? registry[index+1] || null : null;
}
function placeholders(values) { return values.map(() => "?").join(","); }
function parse(value, fallback) { return value && typeof value === "object" ? value : json(value, fallback); }
function stage(key, label, order, dependencies, parallelGroup, required) { return Object.freeze({ key, label, order, dependencies, parallel_group: parallelGroup, required }); }
