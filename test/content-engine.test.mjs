import assert from "node:assert/strict";
import test from "node:test";
import { ContentEngine } from "../src/ai/content-engine.mjs";

test("independent QA cannot approve deterministic evidence or commercial violations", async () => {
  const modelReview = { passed: true, score: 98, checks: [], issues: [], unsupported_claims: [] };
  const fetchStub = async () => new Response(JSON.stringify({ model: "review-model", output_text: JSON.stringify(modelReview) }), {
    status: 200, headers: { "content-type": "application/json" },
  });
  const engine = new ContentEngine({ apiKey: "key", model: "model", baseUrl: "https://api.example.test/v1" }, fetchStub);
  const reviewed = await engine.review({
    facts: [
      { normalized_key: "valid.fact", consensus_status: "corroborated", freshness_state: "stale", verification_priority: "review" },
      { normalized_key: "timed.fact", consensus_status: "corroborated", freshness_state: "time_sensitive", verification_priority: "requires_official" },
    ],
    draft: {
      body_markdown: "Book this affiliate deal on Trip.com.",
      evidence_ledger: [{ section: "Test", claim_keys: ["missing.fact", "valid.fact", "timed.fact"], source_ids: [] }],
      unresolved_conflicts: [],
      verification_notes: [],
    },
  });
  assert.equal(reviewed.output.passed, false);
  assert.ok(reviewed.output.issues.some((issue) => issue.code === "commercial_contamination"));
  assert.ok(reviewed.output.issues.some((issue) => issue.code === "invalid_evidence_key"));
  assert.ok(reviewed.output.issues.some((issue) => issue.code === "draft_too_short"));
  assert.ok(reviewed.output.issues.some((issue) => issue.code === "stale_evidence_used"));
  assert.ok(reviewed.output.issues.some((issue) => issue.code === "missing_verification_note"));
});
