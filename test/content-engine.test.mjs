import assert from "node:assert/strict";
import test from "node:test";
import { ContentEngine, draftInputDto } from "../src/ai/content-engine.mjs";

test("writer receives bounded image subjects without resending full media and source context",()=>{
  const asset={id:"photo-1",source_id:"source-1",asset_kind:"documentary_photo",
    alt_text:"Chongqing street",primary_subjects:["Chongqing street"],
    original_bytes_status:"saved_original",durability_status:"ORIGINAL_STORED",
    local_photo_audit:{status:"eligible"},nearby_text:"unrelated context ".repeat(3000),
    preview_url:"data:image/png;base64,"+"x".repeat(10000),source_provenance:{opaque:"y".repeat(10000)}};
  const result=draftInputDto({brief:{plan:{outline:[]}},writing_packet:{selected_fact_keys:[],
    evidence_ledger:[],context:{version:2,authorized_source_assets:[asset]}},facts:[]});
  assert.equal(result.authorized_source_assets[0].id,"photo-1");
  assert.equal(result.authorized_source_assets[0].locally_audited_photo,true);
  assert.equal(result.authorized_source_assets[0].original_stored,true);
  assert.equal(JSON.stringify(result.authorized_source_assets).includes("unrelated context"),false);
  assert.ok(JSON.stringify(result.authorized_source_assets).length<500);
});
import { pageBlockSignature } from "../src/evidence-validator.mjs";

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
      id: "draft-internal-id",
      body_markdown: "Book this affiliate deal on Trip.com.",
      evidence_ledger: [{ section: "Test", claim_keys: ["missing.fact", "valid.fact", "timed.fact"], source_ids: [] }],
      unresolved_conflicts: [],
      verification_notes: [],
    },
    frontend_page: { payload:{metadata:{title:"Large internal payload"},blocks:Array(20).fill({type:"paragraph",data:{content:"internal"}})},
      validation:{valid:true,internal_diagnostics:Array(20).fill("not for the editor")},current:true,status:"valid" },
  });
  assert.equal(reviewed.output.passed, false);
  assert.ok(reviewed.output.issues.some((issue) => issue.code === "commercial_contamination"));
  assert.ok(reviewed.output.issues.some((issue) => issue.code === "invalid_evidence_key"));
  assert.ok(reviewed.output.issues.some((issue) => issue.code === "draft_below_suggested_length" && issue.severity === "warning"));
  assert.equal(reviewed.output.issues.some((issue) => issue.code === "stale_evidence_used"), false);
  assert.equal(reviewed.output.issues.some((issue) => issue.code === "missing_temporal_disclosure"), false);
  assert.equal(request.url, "https://api.example.test/v1/chat/completions");
  assert.equal(request.body.response_format.type, "json_schema");
  const reviewInput=JSON.parse(request.body.messages[1].content);
  assert.equal("id" in reviewInput.draft,false);
  assert.deepEqual(reviewInput.frontend_page,{current:true,status:"valid",valid:true});
});

test("page composition extracts CMS node references before Frontend validation", async () => {
  const block = { type: "articleSection", data: { heading: "Plan", body: "Use Traveler&#39;s metro." },
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
  assert.equal(result.output.blocks[0].data.body, "Use Traveler&#039;s metro.");
  assert.equal(result.provenance.valid, true);
  assert.equal(result.provenance.entries[0].blockSignature, pageBlockSignature(result.output.blocks[0]));
  assert.deepEqual(result.provenance.entries[0].claimKeys, ["transport.metro"]);
  assert.ok(requestBody.response_format.json_schema.schema.properties.blocks.items.required.includes("_cms_content_node_id"));
});

test("page composition augments every oneOf component variant with CMS provenance", async () => {
  let requestBody;
  const output = {
    metadata: { title: "Guide" },
    blocks: [{ type: "paragraph", data: { html: "Use the metro." },
      _cms_content_node_id: "node_transport", _cms_source_section_ids: ["section_plan"],
      _cms_claim_keys: ["transport.metro"], _cms_factuality: "factual" }],
  };
  const fetchStub = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ model: "page-model", choices: [{ finish_reason: "stop",
      message: { content: JSON.stringify(output) } }] }),
    { status: 200, headers: { "content-type": "application/json" } });
  };
  const engine = new ContentEngine({ apiKey: "key", model: "model", baseUrl: "https://api.example.test/v1" }, fetchStub);
  const variant = (type, data) => ({ type: "object", additionalProperties: false, required: ["type", "data"], properties: {
    type: { type: "string", enum: [type] }, data,
  } });
  const pageSchema = { type: "object", additionalProperties: false, required: ["metadata", "blocks"], properties: {
    metadata: { type: "object", additionalProperties: false, required: ["title"], properties: { title: { type: "string" } } },
    blocks: { type: "array", items: { oneOf: [
      variant("heading", { type: "object", properties: { text: { type: "string" } } }),
      variant("paragraph", { type: "object", properties: { html: { type: "string" } } }),
    ] } },
  } };
  const result = await engine.composeFrontendPage({ frontend_page_plan: { plan: { blocks: [{
    content_node_id: "node_transport", source_section_ids: ["section_plan"], claim_keys: ["transport.metro"], factuality: "factual",
  }] } }, brief: { strategy_version: "1.8", canonical: {} }, draft: {} }, { components: [] }, pageSchema);
  const variants = requestBody.response_format.json_schema.schema.properties.blocks.items.oneOf;
  assert.equal(variants.length, 2);
  assert.ok(variants.every((item) => item.required.includes("_cms_content_node_id")));
  assert.ok(variants.every((item) => item.properties._cms_claim_keys.type === "array"));
  assert.equal(result.provenance.valid, true);
  assert.equal("_cms_content_node_id" in result.output.blocks[0], false);
});
