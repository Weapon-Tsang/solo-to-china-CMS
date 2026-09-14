export function contentCanaryProviderCapacityOutcome(state, job) {
  if (!["failed", "interrupted"].includes(state?.stage_status)) return null;
  if (!job || !["retryable_provider", "capacity"].includes(job.failure_class)) return null;
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
