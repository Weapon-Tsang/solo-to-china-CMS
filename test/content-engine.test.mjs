import assert from "node:assert/strict";
import test from "node:test";
import { ContentEngine } from "../src/ai/content-engine.mjs";

test("Kimi-backed independent QA cannot approve deterministic evidence or commercial violations", async () => {
  const modelReview = { passed: true, score: 98, checks: [], issues: [], unsupported_claims: [] };
  let request;
  const fetchStub = async (url, options) => {
    request = { url, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ model: "review-model", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(modelReview) } }] }), {
    status: 200, headers: { "content-type": "application/json" },
    });
  };
  const engine = new ContentEngine({ apiKey: "key", model: "model", baseUrl: "https://api.example.test/v1", maxCompletionTokens: 16000 }, fetchStub);
  const reviewed = await engine.review({
    facts: [
      { normalized_key: "valid.fact", consensus_status: "corroborated", freshness_state: "stale", verification_priority: "review" },
      { normalized_key: "timed.fact", consensus_status: "corroborated", freshness_state: "time_sensitive", verification_priority: "normal", consensus_method: "RECENCY_WEIGHTED_CONSENSUS" },
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
  assert.ok(reviewed.output.issues.some((issue) => issue.code === "draft_below_suggested_length" && issue.severity === "warning"));
  assert.equal(reviewed.output.issues.some((issue) => issue.code === "stale_evidence_used"), false);
  assert.ok(reviewed.output.issues.some((issue) => issue.code === "missing_temporal_disclosure"));
  assert.equal(request.url, "https://api.example.test/v1/chat/completions");
  assert.equal(request.body.response_format.type, "json_schema");
});

test("page composition extracts CMS node references before Frontend validation", async () => {
  const block = { type: "articleSection", data: { heading: "Plan", body: "Use the metro." },
    _cms_content_node_id: "node_transport", _cms_source_section_ids: ["section_plan"],
    _cms_claim_keys: ["transport.metro"], _cms_factuality: "factual" };
  let requestBody;
  const fetchStub = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ model: "page-model", choices: [{ finish_reason: "stop",
      message: { content: JSON.stringify({ metadata: { title: "Guide" }, blocks: [block] }) } }] }),
    { status: 200, headers: { "content-type": "application/json" } });
  };
  const engine = new ContentEngine({ apiKey: "key", model: "model", baseUrl: "https://api.example.test/v1" }, fetchStub);
  const pageSchema = { type: "object", additionalProperties: false, required: ["metadata", "blocks"], properties: {
    metadata: { type: "object", additionalProperties: false, required: ["title"], properties: { title: { type: "string" } } },
    blocks: { type: "array", items: { type: "object", additionalProperties: false, required: ["type", "data"], properties: {
      type: { type: "string" }, data: { type: "object" },
    } } },
  } };
  const result = await engine.composeFrontendPage({ frontend_page_plan: { plan: { blocks: [{
    content_node_id: "node_transport", source_section_ids: ["section_plan"], claim_keys: ["transport.metro"], factuality: "factual",
  }] } }, brief: { strategy_version: "1.8", canonical: {} }, draft: {} }, { components: [] }, pageSchema);
  assert.equal("_cms_content_node_id" in result.output.blocks[0], false);
  assert.equal(result.provenance.valid, true);
  assert.deepEqual(result.provenance.entries[0].claimKeys, ["transport.metro"]);
  assert.ok(requestBody.response_format.json_schema.schema.properties.blocks.items.required.includes("_cms_content_node_id"));
});
