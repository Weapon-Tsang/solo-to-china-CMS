import test from "node:test";
import assert from "node:assert/strict";
import { contentCanaryProviderCapacityOutcome } from "../scripts/lib/content-canary-policy.mjs";

test("provider capacity stops a canary flow instead of opening another recovery cycle", () => {
  const outcome = contentCanaryProviderCapacityOutcome({ stage_status: "failed" }, {
    id: "job-capacity", type: "generate_draft", failure_class: "retryable_provider",
    last_failure_code: "PROVIDER_REQUEST_FAILED", last_error: "Vertex returned 429.", attempts: 3, max_attempts: 3,
  });
  assert.deepEqual(outcome, {
    classification: "provider_capacity", jobId: "job-capacity", stage: "generate_draft",
    code: "PROVIDER_REQUEST_FAILED", attempts: 3, maxAttempts: 3, reason: "Vertex returned 429.",
  });
  assert.equal(contentCanaryProviderCapacityOutcome({ stage_status: "failed" }, {
    failure_class: "permanent_input",
  }), null);
  assert.equal(contentCanaryProviderCapacityOutcome({ stage_status: "running" }, {
    failure_class: "retryable_provider",
  }), null);
});
