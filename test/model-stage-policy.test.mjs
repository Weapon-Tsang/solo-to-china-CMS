import assert from "node:assert/strict";
import test from "node:test";
import { createAiClient } from "../src/ai/client.mjs";
import { applyBoundedDraftRepair, applyDeterministicGates } from "../src/ai/content-engine.mjs";
import { priceModelAttempt, resolveStagePolicy, summarizeModelCostLedger } from "../src/ai/stage-policy.mjs";

const schema = { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "string" } } };

test("stage policy freezes capability and retry limits into a stable configuration hash", () => {
  const config = { provider: "vertex", model: "gemini-test", maxCompletionTokens: 20_000,
    stagePolicy: { version: "policy-test", stages: { quality_review_v2: {
      class: "qa", requires: ["structured_output", "independent_review"], thinking: "HIGH",
      maxOutputTokens: 4_000, timeoutMs: 12_000, maxAttempts: 2,
    } } } };
  const first = resolveStagePolicy("quality_review_v2", config);
  const second = resolveStagePolicy("quality_review_v2", config);
  assert.deepEqual(first.requires, ["structured_output", "independent_review"]);
  assert.equal(first.maxOutputTokens, 4_000);
  assert.equal(first.configHash, second.configHash);
});

test("every provider attempt is metered, including structured-output repair retries", async () => {
  const metrics = [];
  let requestCount = 0;
  const client = createAiClient({ provider: "kimi", apiKey: "test", model: "fixed-model", baseUrl: "https://example.test/v1",
    stagePolicy: { version: "policy-test", stages: { test_stage: { maxAttempts: 2, maxOutputTokens: 1000, timeoutMs: 5000 } } },
    onModelCall: (metric) => metrics.push(metric),
  }, async () => {
    requestCount += 1;
    const content = requestCount === 1 ? "not json" : '{"answer":"ok"}';
    return new Response(JSON.stringify({ model: "fixed-model", choices: [{ finish_reason: "stop", message: { content } }],
      usage: { prompt_tokens: 5, completion_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const result = await client.completeJson({ name: "test_stage", schema, instructions: "Return JSON", content: "input",
    telemetryContext: { runId: "job-1", entityId: "entity-1" } });
  assert.equal(result.output.answer, "ok");
  assert.equal(metrics.length, 2);
  assert.deepEqual(metrics.map((item) => item.attemptStatus), ["failed", "succeeded"]);
  assert.equal(metrics[0].retryReason, "invalid_json_or_schema");
  assert.ok(metrics.every((item) => item.runId === "job-1" && item.configHash));
});

test("cost ledger retains unknown prices and uses unique qualified drafts as denominator", () => {
  const unknown = priceModelAttempt({ provider: "vertex", model: "unlisted", inputTokens: 10, outputTokens: 5,
    requestCompletedAt: "2026-09-10T00:00:00.000Z" }, { version: "prices-1", asOf: "2026-09-10", entries: [] });
  assert.equal(unknown.costUsd, null);
  assert.equal(unknown.costStatus, "unknown");
  const report = summarizeModelCostLedger([
    { request_kind: "provider", attempt_status: "failed", stage: "article_draft_v2", input_tokens: 10, output_tokens: null, thinking_tokens: null, cost_usd: null },
    { request_kind: "provider", attempt_status: "succeeded", stage: "bounded_draft_repair", input_tokens: 8, output_tokens: 3, thinking_tokens: 1, cost_usd: null },
    { request_kind: "cache_hit", attempt_status: "succeeded", cost_usd: 0 },
  ], { qualifiedDraftIds: ["draft-1", "draft-1"] });
  assert.equal(report.requestAttempts, 2);
  assert.equal(report.failed, 1);
  assert.equal(report.repairs, 1);
  assert.equal(report.qualifiedDrafts, 1);
  assert.equal(report.totalCostUsd, null);
  assert.equal(report.costPerQualifiedDraftUsd, null);
});

test("bounded repair rejects stale revisions and preserves every untouched section", () => {
  const draft = { content_hash: "current", title: "Guide", meta_description: "Desc", seo: { meta_title: "Guide" },
    body_markdown: "Intro.\n\n## Tickets\n\nOld ticket copy.\n\n## Transport\n\nKeep this exact copy.",
    evidence_ledger: [], unresolved_conflicts: [], verification_notes: [], visuals: [] };
  assert.throws(() => applyBoundedDraftRepair(draft, { base_content_hash: "stale", replacement_sections: [], metadata: {} }), /base hash/i);
  const repaired = applyBoundedDraftRepair(draft, { base_content_hash: "current",
    replacement_sections: [{ heading: "Tickets", body_markdown: "Corrected ticket copy." }], metadata: {} },
  [{ code: "unsupported_claim" }]);
  assert.match(repaired.body_markdown, /Corrected ticket copy/);
  assert.match(repaired.body_markdown, /Keep this exact copy/);
  assert.equal(repaired.title, "Guide");
});

test("evidence repair may update only bounded known claim keys", () => {
  const draft = { content_hash:"current",title:"Guide",meta_description:"Desc",seo:{meta_title:"Guide"},
    body_markdown:"Intro.\n\n## Visit\n\nSupported body.",evidence_ledger:[],verification_notes:[],visuals:[] };
  const patch = { base_content_hash:"current",replacement_sections:[],metadata:{},
    evidence_ledger:[{section_id:"visit",claim_keys:["place.hours"]}],verification_notes:["place.hours: as of 2026-09-10"] };
  const repaired = applyBoundedDraftRepair(draft,patch,[{code:"confirmed_topic_coverage_missing"}],{validFactKeys:["place.hours"]});
  assert.deepEqual(repaired.evidence_ledger,patch.evidence_ledger);
  assert.throws(()=>applyBoundedDraftRepair(draft,{...patch,evidence_ledger:[{section_id:"visit",claim_keys:["invented.fact"]}]},
    [{code:"confirmed_topic_coverage_missing"}],{validFactKeys:["place.hours"]}),/unknown fact/i);
});

test("non-evidence repair may echo an unchanged ledger but cannot alter it", () => {
  const draft = { content_hash:"current",title:"Guide",meta_description:"Desc",seo:{meta_title:"Guide"},
    body_markdown:"Intro.\n\n## Visit\n\nSupported body.",evidence_ledger:[{section_id:"visit",claim_keys:["place.hours"]}],
    verification_notes:["Checked"],visuals:[] };
  const patch = { base_content_hash:"current",replacement_sections:[],metadata:{meta_description:"A clearer summary."},
    evidence_ledger:draft.evidence_ledger,verification_notes:draft.verification_notes };
  assert.equal(applyBoundedDraftRepair(draft,patch,[{code:"seo_description_missing"}]).meta_description,"A clearer summary.");
  assert.throws(()=>applyBoundedDraftRepair(draft,{...patch,evidence_ledger:[]},[{code:"seo_description_missing"}]),/not authorized/i);
});

test("quality coverage checks each promised section instead of exhausting every available fact", () => {
  const facts=Array.from({length:100},(_,index)=>({normalized_key:`place.fact_${index}`,preferred_value:`description ${index}`,evidence:[]}));
  const result=applyDeterministicGates({passed:true,score:90,issues:[],checks:[],unsupported_claims:[]},{
    brief:{plan:{title:"Guide",outline:[
      {section_id:"one",heading:"One",claim_keys:facts.slice(0,50).map(f=>f.normalized_key)},
      {section_id:"two",heading:"Two",claim_keys:facts.slice(50).map(f=>f.normalized_key)},
    ]}},facts,content_policy:{minimum_words:1,faq:{allowed:false},visuals:{minimum:0,maximum:0}},
    draft:{title:"Guide",body_markdown:"Useful description for a reader.",meta_description:"What this useful guide covers.",
      seo:{meta_title:"Guide",focus_keyword:"guide",secondary_keywords:[],search_intent:"informational",takeaways:[],faqs:[]},
      evidence_ledger:[{section_id:"one",claim_keys:["place.fact_0"]},{section_id:"two",claim_keys:["place.fact_50"]}],
      verification_notes:[],unresolved_conflicts:[],visuals:[],faqs:[]},
  });
  assert.equal(result.checks.find(check=>check.name==='confirmed-topic-coverage').passed,true);
  assert.equal(result.issues.some(issue=>issue.code==='confirmed_topic_coverage_missing'),false);
});
