export const AI_JOB_TYPES = new Set([
  "extract_segment_claims",
  "extract_media_batch",
  "audit_segment_coverage",
  "retry_segment_extraction",
  "analyze_source_blueprint",
  "analyze_source_diagnostic",
  "extract_source_experience",
  "resolve_entities",
  "analyze_intake",
  "plan_content",
  "assemble_editorial",
  "plan_narrative",
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

export const BATCH_FAILURE_CLASSES = new Set([
  "permanent_input",
  "retryable_provider",
  "input_too_large",
  "capacity",
  "batch_incompatible",
]);

export function classifyBatchFailure(error, { phase = "result" } = {}) {
  if (BATCH_FAILURE_CLASSES.has(error?.failureClass)) return error.failureClass;
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || error || "");
  if (["VERTEX_BATCH_INPUT_TOO_LARGE", "BATCH_INPUT_TOO_LARGE"].includes(code)
    || /input.*too large|exceeds.*input|too large.*batch/i.test(message)) return "input_too_large";
  if (["VERTEX_BATCH_CAPACITY", "BATCH_CAPACITY"].includes(code)
    || /batch (?:queue|job).*capacity|concurrent batch|batch.*(?:queue|job).*limit/i.test(message)) return "capacity";
  if (["MODEL_OUTPUT_LIMIT", "VERTEX_BATCH_DUPLICATE_CORRELATION", "VERTEX_BATCH_OUTPUT_MISSING", "INVALID_MODEL_OUTPUT"].includes(code)) {
    return "batch_incompatible";
  }
  if (isProviderPressure(error) || (phase !== "prepare" && error?.retryable === true)) return "retryable_provider";
  return "permanent_input";
}

export function isOperationalFailureRetryable(row = {}) {
  if (["permanent_input", "input_too_large"].includes(row.failure_class)) return false;
  if (["retryable_provider", "capacity", "batch_incompatible"].includes(row.failure_class)) return true;
  const detail = String(row.last_error || row.failed_job_error || "");
  if (/\b(?:400|401|403|404|405|409|410|413|422)\b|invalid argument|not an allowlisted|unsupported image|image.*too large|output.*token limit|structured output reached its token limit/i.test(detail)) return false;
  return true;
}
