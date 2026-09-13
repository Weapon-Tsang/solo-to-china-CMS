import { json, sha256 } from "../utils.mjs";
import { explainOperationalFailure } from "./content-recovery-policy.mjs";

export const PRODUCTION_STATE_VERSION = "1.0";

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
  const jobs = entityIds.length ? db.prepare(`SELECT * FROM jobs WHERE entity_id IN (${placeholders(entityIds)})
    AND type IN (${placeholders(PRODUCTION_JOB_TYPES)}) ORDER BY updated_at,created_at,id`).all(...entityIds, ...PRODUCTION_JOB_TYPES) : [];
  const artifacts = entityIds.length ? db.prepare(`SELECT * FROM pipeline_artifacts WHERE entity_id IN (${placeholders(entityIds)})
    AND stage IN (${placeholders(PRODUCTION_JOB_TYPES)}) ORDER BY updated_at,created_at,id`).all(...entityIds, ...PRODUCTION_JOB_TYPES) : [];
  const receipts = entityIds.length ? db.prepare(`SELECT stage,entity_id,job_id,created_at FROM pipeline_step_receipts
    WHERE entity_id IN (${placeholders(entityIds)}) AND stage IN (${placeholders(PRODUCTION_JOB_TYPES)})
    ORDER BY created_at`).all(...entityIds, ...PRODUCTION_JOB_TYPES) : [];
  const modelCalls = entityIds.length ? db.prepare(`SELECT stage,entity_id,model,provider,request_kind,cache_hit,status,created_at
    FROM model_call_metrics WHERE entity_id IN (${placeholders(entityIds)}) ORDER BY created_at`).all(...entityIds) : [];
  const evidence = persistedStageEvidence(db, row);
  const entries = registry.map((definition) => buildStageEntry(definition, jobs, artifacts, receipts, modelCalls, evidence));
  const completedStages = entries.filter((item) => item.status === "succeeded").map((item) => item.key);
  const pendingStages = entries.filter((item) => item.status !== "succeeded").map((item) => item.key);
  const active = latestActiveJob(jobs, options.now);
  const failed = latestUnresolvedFailure(jobs) || inferredPersistedFailure(row);
  const firstPending = entries.find((item) => item.status !== "succeeded" && item.key !== "revise_draft") || null;
  const completed = completedStages.length;
  const total = registry.filter((item) => item.key !== "revise_draft" || stageEnabled(item, capabilities, db, row)).length;
  const progress = { completed, total, percent: total ? Math.min(100, Math.round(completed / total * 100)) : 0 };
  const readinessValue = parse(row.readiness_json, row.readiness || {});
  const readiness = row.approved_at ? (readinessValue.ready ? "ready" : "waiting_for_evidence") : "not_applicable";
  const control = controlState(db, row.opportunity_id);
  const lastAttemptAt = newestTimestamp([
    row.opportunity_updated_at, row.candidate_updated_at, row.brief_updated_at, row.draft_updated_at,
    ...jobs.map((item) => item.updated_at), ...artifacts.map((item) => item.updated_at), control?.updated_at,
  ]);
  const ageBase = Date.parse(lastAttemptAt || row.approved_at || row.opportunity_updated_at || 0);
  const nowMs = options.now instanceof Date ? options.now.getTime() : Date.parse(options.now || "") || Date.now();
  const graceMs = Math.max(60_000, Number(options.continuityGraceMs || 15 * 60_000));
  const beyondGrace = Number.isFinite(ageBase) && ageBase > 0 && nowMs - ageBase >= graceMs;
  const hasLineage = Boolean(row.candidate_id || row.brief_id || row.draft_id || jobs.length || artifacts.length
    || db.prepare("SELECT 1 FROM production_attempt_archives WHERE opportunity_id=? LIMIT 1").get(row.opportunity_id));

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
  } else if (readiness === "waiting_for_evidence" && !hasLineage) {
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
  } else if (active) {
    lifecycle = "in_progress";
    stageStatus = active.status;
    currentStage = active.type;
    currentStageLabel = productionStageLabel(active.type);
    headline = productionStageActivityLabel(active.type, active.status);
    explanation = active.status === "running" ? "系统正在执行当前步骤，完成后会按流水线依赖自动继续。" : "任务已进入 durable queue，将自动继续。";
    autoContinue = true;
  } else if (failed) {
    const explained = explainOperationalFailure(failed);
    lifecycle = "needs_attention";
    stageStatus = "failed";
    currentStage = failed.type;
    currentStageLabel = productionStageLabel(failed.type);
    headline = `${currentStageLabel}失败，需要处理`;
    explanation = explained?.reason || "这一步没有完成；已有成功产物仍然保留。";
    autoContinue = false;
    needsHuman = true;
    recoverable = !["APPROVED_SCOPE_INVALID", "EVIDENCE_SCOPE_INVALID"].includes(String(failed.last_failure_code || ""));
    latestError = {
      code: failed.last_failure_code || failed.failure_class || "PRODUCTION_FAILED",
      reason: explained?.reason || String(failed.last_error || "这一步没有完成。"),
      stage: failed.type,
      occurred_at: failed.updated_at || failed.completed_at || null,
    };
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
  } else if (firstPending && hasLineage && (beyondGrace || row.candidate_status === "candidate" || ["exception", "qa_failed"].includes(row.brief_status) || ["exception", "qa_failed"].includes(row.draft_status))) {
    lifecycle = "needs_attention";
    stageStatus = "interrupted";
    currentStage = firstPending.key;
    currentStageLabel = firstPending.label;
    const lastComplete = [...entries].reverse().find((item) => item.status === "succeeded");
    headline = row.candidate_status === "candidate"
      ? `生产中断：${currentStageLabel}未完成`
      : `流程中断：${lastComplete?.label || "上一阶段"}已完成，但下一步骤未入队`;
    explanation = `下一步应为“${currentStageLabel}”。恢复只会补这个缺失步骤，不会重跑已完成阶段。`;
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

  const availableActions = actionsFor({ lifecycle, stageStatus, recoverable, hasLineage, row, control });
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
    next_stage: lifecycle === "completed" || lifecycle === "history"
      ? null
      : stageStatus === "failed"
        ? currentStage
        : firstPending?.key || currentStage,
    progress,
    auto_continue: autoContinue,
    needs_human: needsHuman,
    recoverable,
    latest_error: latestError,
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
    if (lifecycle !== "needs_attention" && Object.hasOwn(counts, lifecycle)) counts[lifecycle] += 1;
    if (item.production_state?.needs_human) counts.needs_attention += 1;
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

function persistedStageEvidence(db, row) {
  const briefReady = Boolean(row.brief_id && !["queued", "exception"].includes(row.brief_status));
  const reviewPassed = row.qa_passed === 1 || row.qa_passed === true;
  return {
    assemble_editorial: Boolean(row.editorial_assembly_id || row.brief_id),
    plan_content: briefReady,
    plan_narrative: Boolean(row.narrative_plan_id || row.writing_packet_id || row.draft_id),
    assemble_writing_packet: Boolean(row.writing_packet_id || row.draft_id),
    compose_frontend_page_plan: row.frontend_plan_status === "ready",
    generate_draft: Boolean(row.draft_id),
    generate_visuals: Number(row.visual_total || 0) === 0 ? null : Number(row.visual_pending || 0) === 0 && Number(row.visual_failed || 0) === 0,
    compose_frontend_page: row.frontend_page_status === "valid" && Boolean(row.frontend_page_current),
    review_draft: reviewPassed,
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
  const call = [...modelCalls].reverse().find((item) => item.stage === definition.key) || null;
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
  const hasVisualWork = Boolean(Number(row.visual_total || 0) || (row.draft_id && db.prepare("SELECT 1 FROM jobs WHERE entity_id=? AND type='generate_visuals' LIMIT 1").get(row.draft_id)));
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
  if (definition.required === "whenPresent") return Boolean(row.draft_id && db.prepare("SELECT 1 FROM jobs WHERE entity_id=? AND type='revise_draft' LIMIT 1").get(row.draft_id));
  return false;
}

function latestActiveJob(jobs, nowValue) {
  const nowMs = nowValue instanceof Date ? nowValue.getTime() : Date.parse(nowValue || "") || Date.now();
  const active = [...jobs].reverse().find((item) => ACTIVE_STATUSES.has(item.status));
  if (!active) return null;
  return { ...active, expired: active.status === "running" && active.lease_expires_at && Date.parse(active.lease_expires_at) <= nowMs };
}

function latestUnresolvedFailure(jobs) {
  const failures = jobs.filter((item) => item.status === "failed").reverse();
  return failures.find((failure) => !jobs.some((item) => item.type === failure.type && item.status === "succeeded"
    && String(item.updated_at) >= String(failure.updated_at))) || null;
}

function inferredPersistedFailure(row) {
  if (row.brief_status === "exception") return {
    type: row.draft_id ? "generate_draft" : "plan_content",
    last_error: row.brief_last_error || "写作准备记录处于 exception，但没有关联的失败 Job；请从该阶段恢复。",
    last_failure_code: "BRIEF_EXCEPTION_WITHOUT_JOB",
    failure_class: "permanent_input",
    updated_at: row.brief_updated_at,
  };
  if (["exception", "qa_failed"].includes(row.draft_status)) {
    const report = parse(row.draft_quality_report_json, {});
    const issue = Array.isArray(report.issues) ? report.issues[0] : null;
    return {
      type: row.draft_status === "qa_failed" ? "review_draft" : "generate_draft",
      last_error: issue?.message || issue?.reason || "草稿生产状态显示失败，但没有关联的失败 Job；原始状态已保留。",
      last_failure_code: issue?.code || (row.draft_status === "qa_failed" ? "QUALITY_REVIEW_FAILED" : "DRAFT_EXCEPTION_WITHOUT_JOB"),
      failure_class: "permanent_input",
      updated_at: row.draft_updated_at,
    };
  }
  return null;
}

function controlState(db, opportunityId) {
  return db.prepare("SELECT * FROM production_record_controls WHERE opportunity_id=?").get(opportunityId) || null;
}

function actionsFor({ lifecycle, stageStatus, recoverable, hasLineage, row, control }) {
  const actions = ["view_details"];
  if (lifecycle === "history") {
    actions.push("view_history");
    if (control?.disposition === "archived" && !row.wordpress_post_id) actions.push("restore_archive");
    return actions;
  }
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
function placeholders(values) { return values.map(() => "?").join(","); }
function parse(value, fallback) { return value && typeof value === "object" ? value : json(value, fallback); }
function stage(key, label, order, dependencies, parallelGroup, required) { return Object.freeze({ key, label, order, dependencies, parallel_group: parallelGroup, required }); }
