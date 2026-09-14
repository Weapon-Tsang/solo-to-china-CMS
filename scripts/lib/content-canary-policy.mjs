export function contentCanaryProviderCapacityOutcome(state, job) {
  if (!["failed", "interrupted"].includes(state?.stage_status)) return null;
  if (!job || !["retryable_provider", "capacity"].includes(job.failure_class)) return null;
  if (state?.current_stage && state.current_stage !== job.type) return null;
  return {
    classification: "provider_capacity",
    jobId: job.id,
    stage: job.type,
    code: job.last_failure_code || job.failure_class,
    attempts: Number(job.attempts || 0),
    maxAttempts: Number(job.max_attempts || 0),
    reason: String(job.last_error || "Provider capacity was unavailable.").slice(0, 1_000),
  };
}

export function resolveContentCanaryModel(requestedModel, models, defaultModel) {
  const requested = String(requestedModel || "").trim();
  const selected = requested || defaultModel;
  if (!(models || []).some((item) => item.id === selected)) {
    throw new Error(`Unsupported content canary model: ${selected || "empty"}.`);
  }
  return selected;
}

export function flashImageCanaryEvidence(visuals = [], inspectFile = () => null) {
  return visuals.filter((visual) => visual?.status === "generated"
    && visual?.provider === "vertex_gemini"
    && visual?.model === "gemini-3.1-flash-image")
    .map((visual) => {
      const file = visual.media_path ? inspectFile(visual.media_path) : null;
      return {
        visualId: visual.id,
        slot: Number(visual.slot || 0),
        mediaPath: visual.media_path || null,
        bytes: Number(file?.bytes || 0),
        sha256: file?.sha256 || null,
        valid: Number(file?.bytes || 0) > 0 && /^[a-f0-9]{64}$/i.test(String(file?.sha256 || "")),
      };
    });
}
