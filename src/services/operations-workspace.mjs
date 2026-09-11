import { isOperationalFailureRetryable } from "../job-policy.mjs";
import { explainOperationalFailure, explainQualityIssue, qualityRepairStage } from "./content-recovery-policy.mjs";

const VALID_STATES = new Set(["passed", "warning", "failed", "not_tested"]);

export function normalizeWorkspaceQuery(input = {}, defaults = {}) {
  if (typeof input === "number") return { limit: bounded(input, 1, 500), cursor: "", search: "", status: "" };
  return {
    limit: bounded(input.limit ?? defaults.limit ?? 100, 1, 500),
    cursor: String(input.cursor || "").trim(),
    search: String(input.search || "").trim().toLocaleLowerCase(),
    status: String(input.status || "").trim().toLocaleLowerCase(),
  };
}

export function paginateWorkspace(items, input = {}, { searchable = defaultSearchable, statusOf = defaultStatus } = {}) {
  const query = normalizeWorkspaceQuery(input);
  const filtered = items.filter((item) => (!query.search || searchable(item).toLocaleLowerCase().includes(query.search))
    && (!query.status || statusOf(item).toLocaleLowerCase() === query.status));
  const offset = decodeCursor(query.cursor);
  const page = filtered.slice(offset, offset + query.limit);
  const nextOffset = offset + page.length;
  return {
    items: page,
    totalCount: filtered.length,
    nextCursor: nextOffset < filtered.length ? encodeCursor(nextOffset) : null,
    query: { search: query.search, status: query.status, limit: query.limit },
  };
}

export function buildContentTaskCard(row) {
  const qualityReport = parseJson(row.quality_report_json, {});
  const seo = parseJson(row.seo_json, {});
  const schema = parseJson(row.schema_jsonld, {});
  const ast = parseJson(row.content_ast_json, {});
  const quality = localizedQualityDimension(row, qualityReport);
  const seoTechnical = seoDimension(row, seo, schema);
  const geoConsistency = geoDimension(row, seo, schema, ast);
  const productionCost = costDimension(row);
  const dimensions = {
    content_quality: quality,
    delivery_quality: localizedDeliveryDimension(row, qualityReport),
    seo_technical: seoTechnical,
    geo_content_consistency: geoConsistency,
    production_cost: productionCost,
  };
  const failed = Object.entries(dimensions).filter(([, value]) => value.status === "failed");
  const warnings = Object.entries(dimensions).filter(([, value]) => value.status === "warning");
  const failedJob = row.failed_job_type ? {
    type: row.failed_job_type,
    last_error: row.failed_job_error,
    failure_class: row.failed_job_failure_class,
    last_failure_code: row.failed_job_code,
  } : null;
  const operational = explainOperationalFailure(failedJob);
  const pipelineBlocker = failedJob ? {
    dimension: "pipeline",
    reason: `${operational.headline}：${operational.reason}`,
    target: failedJob.type,
    retryable: isOperationalFailureRetryable(failedJob),
  } : null;
  const stage = retryStage(row, failed, failedJob);
  return {
    status: failed.length || pipelineBlocker ? "failed" : warnings.length ? "warning"
      : Object.values(dimensions).every((item) => item.status === "passed") ? "passed" : "not_tested",
    dimensions,
    blockers: [...failed.map(([key, value]) => ({ dimension: key, reason: value.reason, target: value.target })),
      ...(pipelineBlocker ? [pipelineBlocker] : [])],
    completedArtifacts: completedArtifacts(row, seo, schema, ast),
    nextAction: actionFor(row, stage, failed, pipelineBlocker),
    retry: stage ? { mode: "failed_stage_only", stage, endpoint: `/api/topics/${encodeURIComponent(row.id)}/retry` } : null,
    actions: [
      { id: "continue", mode: "preview_then_execute", previewEndpoint: `/api/topics/${encodeURIComponent(row.id)}/action-preview?action=continue` },
      { id: "retry_failed_stage", mode: "preview_then_execute", previewEndpoint: `/api/topics/${encodeURIComponent(row.id)}/action-preview?action=retry_failed_stage` },
      { id: "narrow_topic", mode: "navigate", workspace: "assignments" },
      { id: "add_evidence", mode: "navigate", workspace: "sources" },
      { id: "cancel", mode: "preview_then_execute", previewEndpoint: `/api/topics/${encodeURIComponent(row.id)}/action-preview?action=cancel`, executeEndpoint: `/api/topics/${encodeURIComponent(row.id)}/cancel` },
      { id: "compare_revisions", mode: "inspect", endpoint: row.draft_id ? `/api/drafts/${encodeURIComponent(row.draft_id)}/revisions` : null },
    ],
    estimatedAdditionalCalls: additionalCalls(stage),
    runVersion: row.draft_strategy_version || row.strategy_version || "unknown",
    disclaimer: "这里只表示技术与内容是否就绪，不预测排名、流量或 AI 引用。",
  };
}

function localizedQualityDimension(row, report) {
  if (!row.draft_id) return dimension("not_tested", "尚无草稿，因此还没有进行正文质量审核。", "draft", "先生成已批准的草稿。", row);
  if (report.content_quality) {
    const result = report.content_quality;
    if (result.passed) return dimension("passed", "当前正文与证据质量审核已通过；图片和页面交付仍单独检查。", "quality_review", "无需因为图片或页面失败而重写正文。", row);
    const explained = explainQualityIssue(result.issues?.find((issue) => issue.severity === "blocker") || result.issues?.[0]);
    return dimension("failed", `${explained.title}：${explained.reason}`, "draft.body_markdown", explained.action, row);
  }
  if (row.qa_passed === 1) return dimension("passed", "当前草稿版本已通过基于证据的正文质量审核。", "quality_review", "无需修订正文。", row);
  if (row.qa_score != null || Object.keys(report).length) {
    const issue = report.issues?.find((item) => item.severity === "blocker") || report.issues?.[0];
    const explained = explainQualityIssue(issue);
    return dimension("failed", `${explained.title}：${explained.reason}`, issue?.path || issue?.field || "draft.body_markdown", explained.action, row);
  }
  return dimension("not_tested", "当前草稿版本尚未完成质量审核。", "quality_review", "运行草稿质量审核。", row);
}

function localizedDeliveryDimension(row, report) {
  if (!row.draft_id || !report.delivery_quality) return dimension("not_tested", "当前版本尚无独立交付质量结论；历史综合分不能当作正文或交付通过证明。", "frontend_page", "完成图片和页面编排后重新质检。", row);
  const result = report.delivery_quality;
  if (result.passed) return dimension("passed", "当前版本的图片和页面校验已通过；线上 HTML 仍需在目标环境验证。", "frontend_page", "无需交付修复。", row);
  const explained = explainQualityIssue(result.issues?.find((issue) => issue.severity === "blocker") || result.issues?.[0]);
  return dimension("failed", `${explained.title}：${explained.reason}`, "frontend_page", explained.action, row);
}

function qualityDimension(row, report) {
  if (!row.draft_id) return dimension("not_tested", "No draft exists, so content quality has not been reviewed.", "draft", "Create the approved draft.", row);
  if (report.content_quality) {
    const result=report.content_quality;
    return dimension(result.passed?'passed':'failed',result.passed?'当前正文与证据审核通过；图片和页面交付另行检查。':result.issues?.find(i=>i.severity==='blocker')?.message || '正文质量审核未通过。','draft.body_markdown',result.passed?'无需因图片或页面失败重写正文。':'修正列出的正文或证据问题，再重新质检。',row);
  }
  if (row.qa_passed === 1) return dimension("passed", "The current draft revision passed its evidence-backed quality review.", "quality_review", "No quality repair is required.", row);
  if (row.qa_score != null || Object.keys(report).length) {
    const issue = report.issues?.find((item) => item.severity === "blocker") || report.issues?.[0];
    return dimension("failed", issue?.message || issue?.reason || "The current draft revision failed content quality review.", issue?.path || issue?.field || "draft.body_markdown", "Repair only the failed draft fields or sections, then rerun quality review.", row);
  }
  return dimension("not_tested", "The current draft revision has no completed quality review.", "quality_review", "Run the draft quality-review stage.", row);
}

function deliveryDimension(row, report) {
  if (!row.draft_id || !report.delivery_quality) return dimension('not_tested','当前版本尚无独立交付检查结论；历史综合评分不能充当正文或交付的单独通过证明。','frontend_page','完成图片、页面编排和最终质检。',row);
  const result=report.delivery_quality;
  return dimension(result.passed?'passed':'failed',result.passed?'当前审核中的图片/页面校验通过；公开HTML仍需目标环境验证。':result.issues?.find(i=>i.severity==='blocker')?.message || '交付检查未通过。','frontend_page',result.passed?'保留交付保护。':'按问题补齐授权媒体或重新编排页面，不重写无关正文。',row);
}

function seoDimension(row, seo, schema) {
  if (!row.draft_id) return dimension("not_tested", "还没有草稿，因此尚未生成或检查 SEO 字段。", "seo", "先生成已批准方案的草稿。", row);
  const missing = [];
  if (!(seo.meta_title || seo.seo_title)) missing.push("页面标题");
  if (!seo.meta_description) missing.push("页面摘要");
  if (!seo.canonical_url || seo.canonical_status === "invalid") missing.push("规范网址");
  if (!Object.keys(schema).length) missing.push("结构化数据");
  if (missing.length) return dimension("failed", `CMS 还缺少：${missing.join("、")}。这表示技术交付字段不完整，不代表正文事实一定有错。`, "seo", "只补齐缺失字段并重新质检，不重写无关正文。", row);
  if (row.wordpress_status !== "synced") return dimension("not_tested", "CMS 内的 SEO 字段已经存在，但最终前端／WordPress HTML、robots 和站点地图尚未在目标环境验证。", "rendered_html", "交付后在目标环境检查最终 HTML、robots 和站点地图。", row);
  return dimension("warning", "CMS 已交付 SEO 字段；真实索引和搜索展示不属于这项本地检查。", "wordpress_publication", "对线上页面运行最终 HTML 和爬虫配置检查。", row);
}

function geoDimension(row, seo, schema, ast) {
  if (!row.draft_id) return dimension("not_tested", "还没有语义化文章产物，因此尚未检查正文与结构化数据是否一致。", "content_ast", "先生成草稿。", row);
  const hasAst = Array.isArray(ast.nodes) && ast.nodes.length > 0;
  const hasGraph = Array.isArray(schema["@graph"]) && schema["@graph"].length > 0;
  if (!hasAst || !hasGraph) return dimension("failed", "可见正文树或与它同步的结构化数据尚未生成完整。", !hasAst ? "content_ast.nodes" : "schema_jsonld.@graph", "重新编排语义页面，不改写已有证据正文。", row);
  if (row.qa_passed !== 1) return dimension("warning", "语义正文和结构化数据已存在，但当前修订的正文质量尚未通过。", "quality_review", "先解决正文质量阻塞，再把 GEO 一致性视为就绪。", row);
  return dimension("passed", "可见正文、FAQ／SEO 元数据和结构化数据来自同一份当前语义产物。", "content_ast", "不需要为 GEO 单独重写正文。", row);
}

function costDimension(row) {
  const calls = Number(row.model_call_count || 0);
  const unknown = Number(row.unknown_cost_count || 0);
  if (!calls) return dimension("not_tested", "没有找到与本次生产关联的模型调用记录；费用是未知，不是 0。", "model_call_metrics", "下次付费调用要保留用量和带日期的定价来源。", row);
  if (unknown) return dimension("warning", `已有 ${calls} 条模型调用记录，其中 ${unknown} 条费用未知。`, "model_call_metrics.cost_usd", "配置带日期的价格来源；不要猜测金额。", row);
  return { ...dimension("passed", `${calls} 条模型调用都已有可归属的费用记录。`, "model_call_metrics.cost_usd", "再次付费重试前查看本次运行账本。", row),
    amountUsd: Number(row.known_cost_usd || 0) };
}

function dimension(status, reason, target, fix, row) {
  return { status: VALID_STATES.has(status) ? status : "not_tested", reason, target, fix,
    runVersion: row.draft_strategy_version || row.strategy_version || "unknown" };
}

function retryStage(row, failed, failedJob = null) {
  if (failedJob) return isOperationalFailureRetryable(failedJob) ? failedJob.type : null;
  if (!row.brief_id) return "plan_content";
  if (!row.draft_id) return "generate_draft";
  if (failed.some(([key]) => key === "content_quality")) return qualityRepairStage(parseJson(row.quality_report_json, {}).issues || []);
  if (failed.some(([key]) => key === "delivery_quality")) return qualityRepairStage(parseJson(row.quality_report_json, {}).delivery_quality?.issues || []);
  if (failed.some(([key]) => key === "seo_technical" || key === "geo_content_consistency")) return "compose_frontend_page";
  if (row.wordpress_status === "failed") return "push_wordpress_draft";
  if (!row.commercial_status && row.qa_passed === 1) return "compose_commercial";
  if (!row.publish_composition_status && row.qa_passed === 1) return "compose_publish_page";
  return null;
}

function actionFor(row, stage, failed, pipelineBlocker = null) {
  if (stage) return { label: stageLabel(stage), stage,
    reason: failed[0]?.[1]?.reason || pipelineBlocker?.reason || "从第一个未完成的生产产物继续。" };
  if (pipelineBlocker && !pipelineBlocker.retryable) return {
    label: "修正失败阶段的输入", stage: "manual_correction",
    reason: pipelineBlocker.reason,
  };
  if (row.wordpress_status === "synced") return { label: "验证最终 HTML", stage: "external_validation", reason: "CMS 交付已完成；线上 HTML 仍需单独检查。" };
  return { label: "查看当前状态", stage: "manual_review", reason: "当前没有需要安全自动重试的阶段。" };
}

function stageLabel(stage) {
  return ({ plan_content:"仅重新准备写作",generate_draft:"仅重新生成草稿",revise_draft:"仅修订失败内容",
    compose_frontend_page:"仅重新编排页面",review_draft:"仅重新质检",push_wordpress_draft:"仅重新投递 WordPress",
    compose_commercial:"仅重新组合商业层",compose_publish_page:"仅重新生成发布包" })[stage] || `仅重试 ${stage}`;
}

function additionalCalls(stage) {
  if (!stage) return { status: "none_expected", stages: [] };
  const modelStages = new Set(["plan_content", "generate_draft", "revise_draft", "compose_frontend_page", "review_draft"]);
  return { status: modelStages.has(stage) ? "bounded_to_named_stage" : "no_model_call_expected", stages: [stage] };
}

function completedArtifacts(row, seo, schema, ast) {
  return [row.brief_id && "brief", row.draft_id && "draft", Object.keys(seo).length && "seo_metadata",
    Object.keys(schema).length && "structured_data", Array.isArray(ast.nodes) && ast.nodes.length && "content_ast",
    row.commercial_status && "commercial_overlay", row.publish_composition_status && "publish_package",
    row.wordpress_status === "synced" && "wordpress_delivery"].filter(Boolean);
}

function defaultSearchable(item) { return JSON.stringify([item.id, item.title, item.subject, item.destination_slug, item.detail]); }
function defaultStatus(item) { return item.status || item.severity || ""; }
function bounded(value, min, max) { return Math.max(min, Math.min(max, Number.parseInt(value, 10) || min)); }
function encodeCursor(offset) { return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url"); }
function decodeCursor(cursor) {
  if (!cursor) return 0;
  try { return Math.max(0, Number.parseInt(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")).offset, 10) || 0); }
  catch { return 0; }
}
function parseJson(value, fallback) { if (value && typeof value === "object") return value; try { return JSON.parse(value || ""); } catch { return fallback; } }
