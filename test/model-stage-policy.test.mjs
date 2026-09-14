import assert from "node:assert/strict";
import test from "node:test";
import { createAiClient } from "../src/ai/client.mjs";
import { applyBoundedDraftRepair, applyDeterministicGates, ContentEngine } from "../src/ai/content-engine.mjs";
import { priceModelAttempt, resolveStagePolicy, summarizeModelCostLedger } from "../src/ai/stage-policy.mjs";
import stagePolicy from "../config/model-stage-policy.json" with { type: "json" };

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

test("bounded draft repair reserves JSON output budget instead of medium reasoning", () => {
  const policy = resolveStagePolicy("bounded_draft_repair", { provider: "vertex", model: "gemini-3.8-flash",
    maxCompletionTokens: 16_000, stagePolicy });
  assert.equal(policy.thinking, "LOW");
  assert.equal(policy.maxOutputTokens, 12_000);
  assert.equal(policy.version, "model-stage-policy-1.0.1");
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
  assert.ok(metrics.every((item) => item.providerRequestMs >= 0 && item.retryWaitMs >= 0 && item.totalStageMs >= item.providerRequestMs));
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

test("bounded repair normalizes a legacy H3-only document to an accessible H2 section hierarchy", () => {
  const draft = { content_hash: "legacy", title: "Guide", meta_description: "Desc", seo: { meta_title: "Guide" },
    body_markdown: "Intro.\n\n### Day 1\n\nOld route.\n\n### Day 2\n\nKeep this route.",
    evidence_ledger: [], unresolved_conflicts: [], verification_notes: [], visuals: [] };
  const repaired = applyBoundedDraftRepair(draft, { base_content_hash: "legacy",
    replacement_sections: [{ heading: "Day 1", body_markdown: "Corrected route." }], metadata: {} },
  [{ code: "NO_TRAVELER_DECISION" }]);
  assert.match(repaired.body_markdown, /## Day 1\n+Corrected route\./);
  assert.match(repaired.body_markdown, /## Day 2\n\nKeep this route\./);
});

test("bounded repair removes a duplicated title H1 and normalizes skipped heading levels", () => {
  const draft = { content_hash:"heading",title:"Chongqing Guide",meta_description:"Desc",seo:{meta_title:"Chongqing Guide"},
    body_markdown:"# Chongqing Guide\n\n### Route\n\nGrounded route.\n\n##### Details\n\nGrounded details.",
    evidence_ledger:[],unresolved_conflicts:[],verification_notes:[],visuals:[] };
  const repaired=applyBoundedDraftRepair(draft,{base_content_hash:"heading",replacement_sections:[],metadata:{}},
    [{code:"heading_hierarchy_invalid"}]);
  assert.doesNotMatch(repaired.body_markdown,/^#\s/m);
  assert.match(repaired.body_markdown,/^## Route$/m);
  assert.match(repaired.body_markdown,/^### Details$/m);
});

test("bounded repair promotes every planned article section to H2 before calculating replacement boundaries", () => {
  const draft={content_hash:"sections",title:"Route",meta_description:"Desc",seo:{meta_title:"Route"},
    body_markdown:"## Orientation\n\nIntro.\n\n### Day 1\n\nKeep day one.\n\n### Day 2\n\nKeep day two.",
    evidence_ledger:[],unresolved_conflicts:[],verification_notes:[],visuals:[]};
  const repaired=applyBoundedDraftRepair(draft,{base_content_hash:"sections",replacement_sections:[
    {heading:"Orientation",body_markdown:"Short orientation."}],metadata:{}},[{code:"NO_TRAVELER_DECISION"}],
  {sectionHeadings:["Orientation","Day 1","Day 2"]});
  assert.match(repaired.body_markdown,/^## Orientation$/m);
  assert.match(repaired.body_markdown,/^## Day 1\n\nKeep day one\.$/m);
  assert.match(repaired.body_markdown,/^## Day 2\n\nKeep day two\.$/m);
});

test("bounded repair applies different-length multi-section edits without shifting later section offsets", () => {
  const draft = { content_hash: "base", title: "Guide", meta_description: "Desc", seo: { meta_title: "Guide" },
    body_markdown: "Intro.\n\n## First\n\nOriginal first paragraph.\n\n## Second\n\nOriginal second paragraph.\n\n## Third\n\nOriginal third paragraph.",
    evidence_ledger: [], unresolved_conflicts: [], verification_notes: [], visuals: [] };
  const repaired = applyBoundedDraftRepair(draft, { base_content_hash: "base", replacement_sections: [
    { heading: "First", body_markdown: "A much longer replacement for the first section that deliberately changes every later character offset." },
    { heading: "Third", body_markdown: "Short third." },
  ], metadata: {} }, [{ code: "NO_CAUSAL_FLOW" }]);
  assert.match(repaired.body_markdown, /## First\n+A much longer replacement/);
  assert.match(repaired.body_markdown, /## Second\n\nOriginal second paragraph\./);
  assert.match(repaired.body_markdown, /## Third\n+Short third\./);
  assert.doesNotMatch(repaired.body_markdown, /Original first paragraph|Original third paragraph/);
});

test("repair request enumerates only headings present in the current draft", async () => {
  let requestBody;
  const draft = { content_hash:"current",title:"Guide",meta_description:"Desc",seo:{meta_title:"Guide"},
    body_markdown:"Intro.\n\n### Actual route\n\nOld prose.",evidence_ledger:[],verification_notes:[],visuals:[] };
  const engine = new ContentEngine({apiKey:"key",model:"model",baseUrl:"https://api.example.test/v1"},async(_url,options)=>{
    requestBody=JSON.parse(options.body);
    return Response.json({model:"model",choices:[{finish_reason:"stop",message:{content:JSON.stringify({
      base_content_hash:"current",replacement_sections:[{heading:"Actual route",body_markdown:"Useful route."}],
    })}}]});
  });
  await engine.repairDraft({draft,facts:[],brief:{plan:{outline:[]}}},[
    {code:"NO_TRAVELER_DECISION",severity:"blocker",message:"Add a decision."},
  ]);
  const input=JSON.parse(requestBody.messages[1].content);
  assert.deepEqual(input.allowed_replacement_headings,["Actual route"]);
  assert.deepEqual(requestBody.response_format.json_schema.schema.properties.replacement_sections.items.properties.heading.enum,["Actual route"]);
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

test("repair requests omit warnings and page-only issues, cap evidence payloads, and allow the saved ledger to remain unchanged", async () => {
  let requestBody;
  const draft = { content_hash:"current",title:"Guide",meta_description:"Desc",seo:{meta_title:"Guide"},
    body_markdown:"Intro.\n\n## Visit\n\nOld prose.",evidence_ledger:[{section_id:"visit",section:"Visit",content_node_ids:[],claim_keys:["place.fact_49"],source_ids:[]}],
    verification_notes:[],visuals:[] };
  const facts = Array.from({length:50},(_,index)=>({normalized_key:`place.fact_${index}`,subject:`Place ${index}`,predicate:"detail",
    preferred_value:`Value ${index}`,consensus_status:"corroborated",freshness_state:"current",evidence:Array.from({length:5},(_item,evidenceIndex)=>({
      source_id:`source-${evidenceIndex}`,value:`Value ${index}`,quote:"Grounded evidence ".repeat(100),qualifiers:[],coverage_limitations:[],captured_at:"2026-09-14",
    }))}));
  const namedFacts = facts.slice(0,40).map((fact)=>fact.normalized_key).join(", ");
  const output = {base_content_hash:"current",replacement_sections:[{heading:"Visit",body_markdown:"Clear traveler decision."}]};
  const engine = new ContentEngine({apiKey:"key",model:"model",baseUrl:"https://api.example.test/v1"},async(_url,options)=>{
    requestBody=JSON.parse(options.body);
    return Response.json({model:"model",choices:[{finish_reason:"stop",message:{content:JSON.stringify(output)}}]});
  });
  const result=await engine.repairDraft({draft,facts,brief:{plan:{outline:[{section_id:"visit",heading:"Visit",claim_keys:["place.fact_49"]}]}}},[
    {code:"protected_evidence_mismatch",severity:"blocker",message:`Affected: ${namedFacts}`},
    {code:"readability_suggestion",severity:"warning",message:"Long sentence"},
    {code:"final_page_invalid",severity:"blocker",message:"Page contract"},
  ]);
  const input=JSON.parse(requestBody.messages[1].content);
  assert.deepEqual(input.issues.map((issue)=>issue.code),["protected_evidence_mismatch"]);
  assert.equal(input.facts.length,36);
  assert.ok(input.facts.every((fact)=>fact.evidence.length===2 && fact.evidence.every((entry)=>entry.quote.length<=700)));
  assert.deepEqual(requestBody.response_format.json_schema.schema.required,["base_content_hash","replacement_sections"]);
  assert.deepEqual(result.output.evidence_ledger,draft.evidence_ledger);
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

test("a warning-only provider review cannot leave production failed without a blocker", () => {
  const result=applyDeterministicGates({passed:false,score:74,issues:[
    {code:"UNIFORM_SECTION_RHYTHM",severity:"warning",message:"Vary section rhythm."}],checks:[],unsupported_claims:[]},{
    draft:{title:"Route guide",body_markdown:"## Route\n\nChoose the signed route because it avoids backtracking.",
      meta_description:"A practical signed route.",seo:{meta_title:"Route guide",focus_keyword:"route guide",secondary_keywords:[],search_intent:"informational",key_takeaways:[],faqs:[]},
      evidence_ledger:[],unresolved_conflicts:[],verification_notes:[],visuals:[],faqs:[],strategy_version:"3.3",schema_jsonld:{"@graph":[{"@type":"Article"}] }},
    facts:[],brief:{strategy_version:"3.3",canonical:{quick_answer:"Use the signed route.",answer_blocks:[]},plan:{outline:[]}},
    content_policy:{minimum_words:0,faq:{allowed:false},visuals:{minimum:0,maximum:0}},reader_sources:[],
  });
  assert.equal(result.issues.some((issue)=>issue.severity==="blocker"),false);
  assert.equal(result.passed,true);
  assert.equal(result.content_quality.passed,true);
});

test("an Affiliated Hospital name is not mistaken for affiliate commerce", () => {
  const result = applyDeterministicGates({ passed: true, score: 100, issues: [], checks: [], unsupported_claims: [] }, {
    draft: { title: "Route guide", body_markdown: "Take the exit beside the Second Affiliated Hospital.",
      evidence_ledger: [], unresolved_conflicts: [], seo: { meta_title: "Route guide", focus_keyword: "route guide" },
      meta_description: "A practical route guide.", visuals: [], strategy_version: "3.3", schema_jsonld: { "@graph": [{ "@type": "Article" }] } },
    facts: [], brief: { strategy_version: "3.3", canonical: { quick_answer: "Use the signed exit.", answer_blocks: [] }, plan: { outline: [] } },
    content_policy: { minimum_words: 0, faq: { allowed: false }, visuals: { minimum: 0, maximum: 5 } }, reader_sources: [],
  });
  assert.equal(result.issues.some((issue) => issue.code === "commercial_contamination"), false);
});
