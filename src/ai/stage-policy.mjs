import crypto from "node:crypto";

export function resolveStagePolicy(stage, config = {}) {
  const catalog = config.stagePolicy || { version: "legacy", stages: {} };
  const reasoningStage = new Set(["content_brief", "article_draft_v2", "quality_review_v2", "frontend_page_plan",
    "frontend_page_payload", "bounded_draft_repair"]).has(stage);
  const selected = catalog.stages?.[stage] || {
    class: "general", requires: ["structured_output"],
    thinking: reasoningStage ? config.reasoningThinkingLevel || "MEDIUM" : config.thinkingLevel || "LOW",
    maxOutputTokens: Number(config.maxCompletionTokens || 16_000),
    timeoutMs: Number(config.requestTimeoutMs || 360_000), maxAttempts: 2,
  };
  const policy = {
    version: catalog.version || "legacy",
    stage: stage || "unknown",
    provider: config.provider || "unknown",
    model: config.model || "unknown",
    class: selected.class || "general",
    requires: [...new Set(selected.requires || ["structured_output"])],
    thinking: selected.thinking || config.thinkingLevel || "LOW",
    maxOutputTokens: Math.max(256, Math.min(Number(config.maxCompletionTokens || 16_000), Number(selected.maxOutputTokens || 16_000))),
    timeoutMs: Math.max(1_000, Number(selected.timeoutMs || config.requestTimeoutMs || 360_000)),
    maxAttempts: Math.max(1, Math.min(3, Number(selected.maxAttempts || 2))),
  };
  return { ...policy, configHash: crypto.createHash("sha256").update(JSON.stringify({
    provider: policy.provider, model: policy.model, location: config.location || null,
    projectId: config.projectId || null, policy,
  })).digest("hex") };
}

export function summarizeModelCostLedger(rows = [], { qualifiedDraftIds = [] } = {}) {
  const attempts = rows.filter((row) => row.request_kind !== "cache_hit");
  const cacheHits = rows.filter((row) => row.request_kind === "cache_hit").length;
  const costs = attempts.map((row) => row.cost_usd).filter((value) => value != null && Number.isFinite(Number(value))).map(Number);
  const unknownCostAttempts = attempts.length - costs.length;
  const qualifiedDrafts = new Set(qualifiedDraftIds).size;
  const totalCostUsd = unknownCostAttempts ? null : costs.reduce((sum, value) => sum + value, 0);
  return {
    requestAttempts: attempts.length,
    completed: attempts.filter((row) => row.attempt_status === "succeeded").length,
    failed: attempts.filter((row) => row.attempt_status === "failed").length,
    cancelled: attempts.filter((row) => row.attempt_status === "cancelled").length,
    cacheHits,
    repairs: attempts.filter((row) => row.stage === "bounded_draft_repair").length,
    inputTokens: nullableSum(attempts, "input_tokens"),
    outputTokens: nullableSum(attempts, "output_tokens"),
    thinkingTokens: nullableSum(attempts, "thinking_tokens"),
    costStatus: unknownCostAttempts ? "unknown" : attempts.some((row) => row.cost_status === "estimated") ? "estimated" : "confirmed",
    totalCostUsd,
    qualifiedDrafts,
    costPerQualifiedDraftUsd: totalCostUsd == null || qualifiedDrafts === 0 ? null : totalCostUsd / qualifiedDrafts,
    unitCostReason: qualifiedDrafts === 0 ? "No qualified draft in the selected run." : totalCostUsd == null ? "At least one request has unknown cost." : null,
  };
}

export function priceModelAttempt(metric, catalog = {}) {
  if (metric.requestKind === "cache_hit") return { ...metric, costUsd: 0, costStatus: "confirmed",
    priceVersion: catalog.version || null, priceSource: "local_response_cache", priceAsOf: catalog.asOf || null };
  const entry = (catalog.entries || []).find((item) => item.provider === metric.provider && item.model === metric.model
    && (!item.effectiveFrom || String(metric.requestCompletedAt || new Date().toISOString()) >= item.effectiveFrom));
  if (!entry || metric.inputTokens == null || metric.outputTokens == null) return { ...metric, costUsd: null, costStatus: "unknown",
    priceVersion: catalog.version || null, priceSource: entry?.source || null, priceAsOf: catalog.asOf || null };
  const inputBillable = Math.max(0, Number(metric.inputTokens) - Number(metric.cachedTokens || 0));
  const cached = Math.max(0, Number(metric.cachedTokens || 0));
  const cost = inputBillable / 1_000_000 * Number(entry.inputUsdPerMillion)
    + cached / 1_000_000 * Number(entry.cachedInputUsdPerMillion ?? entry.inputUsdPerMillion)
    + Number(metric.outputTokens) / 1_000_000 * Number(entry.outputUsdPerMillion);
  return { ...metric, costUsd: Number(cost.toFixed(8)), costStatus: entry.status === "confirmed" ? "confirmed" : "estimated",
    priceVersion: catalog.version || null, priceSource: entry.source, priceAsOf: entry.asOf || catalog.asOf || null };
}

function nullableSum(rows, key) {
  return rows.every((row) => row[key] != null) ? rows.reduce((sum, row) => sum + Number(row[key]), 0) : null;
}
