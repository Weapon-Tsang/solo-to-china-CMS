import { isOperationalFailureRetryable } from "../job-policy.mjs";
import { qualityRepairStage } from "./content-recovery-policy.mjs";

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
  const quality = qualityDimension(row, qualityReport);
  const seoTechnical = seoDimension(row, seo, schema);
  const geoConsistency = geoDimension(row, seo, schema, ast);
  const productionCost = costDimension(row);
  const dimensions = {
    content_quality: quality,
    delivery_quality: deliveryDimension(row, qualityReport),
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
  const pipelineBlocker = failedJob ? {
    dimension: "pipeline",
    reason: failedJob.last_error || `The ${failedJob.type} stage failed.`,
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
    disclaimer: "Technical and content readiness only; this does not predict rankings, traffic, or AI citations.",
  };
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
  if (!row.draft_id) return dimension("not_tested", "SEO fields do not exist until a draft is created.", "seo", "Create the draft.", row);
  const missing = [];
  if (!(seo.meta_title || seo.seo_title)) missing.push("meta title");
  if (!seo.meta_description) missing.push("meta description");
  if (!seo.canonical_url || seo.canonical_status === "invalid") missing.push("validated canonical");
  if (!Object.keys(schema).length) missing.push("structured data");
  if (missing.length) return dimension("failed", `CMS SEO artifact is missing: ${missing.join(", ")}.`, `seo.${missing[0].replaceAll(" ", "_")}`, "Edit the named SEO field and rerun QA only.", row);
  if (row.wordpress_status !== "synced") return dimension("not_tested", "CMS SEO artifacts are present, but final Frontend/WordPress HTML and crawler behavior have not been verified.", "rendered_html", "Validate the delivered HTML, robots rules, and sitemap in the target environment.", row);
  return dimension("warning", "CMS SEO artifacts were delivered; live indexing and search display remain outside this check.", "wordpress_publication", "Run a live rendered-HTML and crawler check.", row);
}

function geoDimension(row, seo, schema, ast) {
  if (!row.draft_id) return dimension("not_tested", "No semantic article artifact exists yet.", "content_ast", "Create the draft.", row);
  const hasAst = Array.isArray(ast.nodes) && ast.nodes.length > 0;
  const hasGraph = Array.isArray(schema["@graph"]) && schema["@graph"].length > 0;
  if (!hasAst || !hasGraph) return dimension("failed", "The frozen visible-content tree or synchronized schema is missing.", !hasAst ? "content_ast.nodes" : "schema_jsonld.@graph", "Recompose the semantic page artifact without rewriting evidence text.", row);
  if (row.qa_passed !== 1) return dimension("warning", "Semantic text and schema exist, but content quality has not passed for this revision.", "quality_review", "Resolve content-quality failures before treating GEO consistency as ready.", row);
  return dimension("passed", "Visible text, FAQ/SEO metadata, and schema derive from the current frozen semantic artifact.", "content_ast", "No GEO-specific model rewrite is required.", row);
}

function costDimension(row) {
  const calls = Number(row.model_call_count || 0);
  const unknown = Number(row.unknown_cost_count || 0);
  if (!calls) return dimension("not_tested", "No run-linked model cost records were found; amount is unknown, not zero.", "model_call_metrics", "Retain provider usage and dated pricing provenance on the next paid run.", row);
  if (unknown) return dimension("warning", `${calls} model call records exist, but ${unknown} have unknown cost.`, "model_call_metrics.cost_usd", "Configure dated pricing provenance; do not infer a monetary amount.", row);
  return { ...dimension("passed", `${calls} model call records have attributable cost metadata.`, "model_call_metrics.cost_usd", "Review the run ledger before another paid retry.", row),
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
  if (stage) return { label: `Retry ${stage} only`, stage,
    reason: failed[0]?.[1]?.reason || pipelineBlocker?.reason || "Continue from the first incomplete production artifact." };
  if (pipelineBlocker && !pipelineBlocker.retryable) return {
    label: `Correct ${pipelineBlocker.target} input`, stage: "manual_correction",
    reason: pipelineBlocker.reason,
  };
  if (row.wordpress_status === "synced") return { label: "Verify final HTML", stage: "external_validation", reason: "CMS delivery is complete; production HTML remains a separate check." };
  return { label: "Review current state", stage: "manual_review", reason: "No safe automatic retry is currently required." };
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
