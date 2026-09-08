export const AI_JOB_TYPES = new Set([
  "extract_segment_claims",
  "audit_segment_coverage",
  "retry_segment_extraction",
  "analyze_source_blueprint",
  "analyze_source_diagnostic",
  "resolve_entities",
  "analyze_intake",
  "plan_content",
  "compose_frontend_page_plan",
  "generate_draft",
  "generate_visuals",
  "review_draft",
  "revise_draft",
  "compose_frontend_page",
]);

export function isAiJobType(type) {
  return AI_JOB_TYPES.has(String(type || ""));
}

export function isProviderPressure(error) {
  const status = Number(error?.status || 0);
  const message = String(error?.message || "");
  return status === 429 || (Boolean(error?.provider) && [500, 503].includes(status))
    || /resource exhausted|quota|rate.?limit|temporarily overloaded/i.test(message);
}
