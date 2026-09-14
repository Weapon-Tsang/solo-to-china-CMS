import test from "node:test";
import assert from "node:assert/strict";
import { contentCanaryProviderCapacityOutcome, resolveContentCanaryModel } from "../scripts/lib/content-canary-policy.mjs";

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

test("a canary may select an explicit audited fallback model without changing production defaults", () => {
  const models = [{ id: "vertex-gemini-3.8-flash" }, { id: "kimi-k3" }];
  assert.equal(resolveContentCanaryModel("kimi-k3", models, "vertex-gemini-3.8-flash"), "kimi-k3");
  assert.equal(resolveContentCanaryModel("", models, "vertex-gemini-3.8-flash"), "vertex-gemini-3.8-flash");
  assert.throws(() => resolveContentCanaryModel("unknown", models, "vertex-gemini-3.8-flash"), /Unsupported/);
});
