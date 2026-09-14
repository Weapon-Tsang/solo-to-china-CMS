import assert from "node:assert/strict";
import test from "node:test";
import { createAiClient } from "../src/ai/client.mjs";
import { applyBoundedDraftRepair, applyDeterministicGates, ContentEngine, normalizeDraftHeadingHierarchy } from "../src/ai/content-engine.mjs";
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
  assert.equal(policy.version, "model-stage-policy-1.0.2");
});

test("quality review reserves its structured output budget with low thinking", () => {
  const policy = resolveStagePolicy("quality_review_v2", { provider: "vertex", model: "gemini-3.8-flash",
    maxCompletionTokens: 16_000, stagePolicy });
  assert.equal(policy.thinking, "LOW");
  assert.equal(policy.maxOutputTokens, 12_000);
  assert.equal(policy.version, "model-stage-policy-1.0.2");
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

test("Kimi transport failures remain provider-attributed and retryable", async () => {
  const metrics=[];
  const client=createAiClient({provider:"kimi",apiKey:"test",model:"kimi-k3",baseUrl:"https://example.test/v1",
    stagePolicy:{version:"policy-test",stages:{test_stage:{maxAttempts:1,maxOutputTokens:1000,timeoutMs:5000}}},
    onModelCall:(metric)=>metrics.push(metric)},async()=>{throw new TypeError("fetch failed",{cause:{code:"UND_ERR_SOCKET"}});});
  await assert.rejects(client.completeJson({name:"test_stage",schema,instructions:"Return JSON",content:"input"}),
    (error)=>error.code==="PROVIDER_TRANSPORT_FAILED"&&error.provider==="kimi"&&error.retryable===true);
  assert.equal(metrics[0].errorCode,"PROVIDER_TRANSPORT_FAILED");
});

test("Kimi streams a long structured completion and retains final usage", async () => {
  let request;
  const metrics=[];
  const client=createAiClient({provider:"kimi",apiKey:"test",model:"kimi-k3",baseUrl:"https://example.test/v1",
    stagePolicy:{version:"policy-test",stages:{test_stage:{maxAttempts:1,maxOutputTokens:1000,timeoutMs:5000}}},
    onModelCall:(metric)=>metrics.push(metric)},async(_url,options)=>{
      request=JSON.parse(options.body);
      const frames=[
        {model:"kimi-k3",choices:[{delta:{reasoning_content:"private reasoning"},finish_reason:null}]},
        {model:"kimi-k3",choices:[{delta:{content:'{"answer":'},finish_reason:null}]},
        {model:"kimi-k3",choices:[{delta:{content:'"ok"}'},finish_reason:"stop"}]},
        {model:"kimi-k3",choices:[],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}},
      ].map((item)=>`data: ${JSON.stringify(item)}\n\n`).join("")+"data: [DONE]\n\n";
      return new Response(frames,{status:200,headers:{"content-type":"text/event-stream"}});
    });
  const result=await client.completeJson({name:"test_stage",schema,instructions:"Return JSON",content:"input"});
  assert.equal(request.stream,true);
  assert.deepEqual(request.stream_options,{include_usage:true});
  assert.deepEqual(result.output,{answer:"ok"});
  assert.equal(result.usage.total_tokens,15);
  assert.equal(metrics[0].inputTokens,10);
  assert.equal(metrics[0].outputTokens,5);
});

test("a locally rejected structured completion is never retained in the response cache", async () => {
  const metrics = [];
  let requestCount = 0;
  const client = createAiClient({ provider: "kimi", apiKey: "test", model: "fixed-model", baseUrl: "https://example.test/v1",
    stagePolicy: { version: "policy-test", stages: { test_stage: { maxAttempts: 1, maxOutputTokens: 1000, timeoutMs: 5000 } } },
    onModelCall: (metric) => metrics.push(metric),
  }, async () => {
    requestCount += 1;
    const answer = requestCount === 1 ? "missing-required-section" : "accepted";
    return new Response(JSON.stringify({ model: "fixed-model", choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ answer }) } }],
      usage: { prompt_tokens: 5, completion_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const request = { name: "test_stage", schema, instructions: "Return JSON", content: "same input",
    validateOutput: (output) => {
      if (output.answer !== "accepted") throw Object.assign(new Error("Local content contract rejected output."), { code:"LOCAL_OUTPUT_INVALID" });
    } };
  await assert.rejects(client.completeJson(request), (error) => error.code === "LOCAL_OUTPUT_INVALID"
    && error.rejectedCompletion?.output?.answer === "missing-required-section");
  const accepted = await client.completeJson(request);
  const reused = await client.completeJson(request);
  assert.equal(accepted.output.answer, "accepted");
  assert.equal(reused.output.answer, "accepted");
  assert.equal(requestCount, 2);
  assert.equal(metrics.filter((item) => item.requestKind === "cache_hit").length, 1);
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

test("bounded repair accepts punctuation-equivalent headings without renaming the persisted section", () => {
  const draft = { content_hash:"punctuation",title:"Guide",meta_description:"Desc",seo:{meta_title:"Guide"},
    body_markdown:"## Day 1 Evening: Raffles City, Hongyadong, and River Views\n\nOld route.",
    evidence_ledger:[],unresolved_conflicts:[],verification_notes:[],visuals:[] };
  const repaired=applyBoundedDraftRepair(draft,{base_content_hash:"punctuation",replacement_sections:[{
    heading:"Day 1 Evening — Raffles City, Hongyadong & River Views",body_markdown:"A clearer route decision.",
  }],metadata:{}},[{code:"NO_CAUSAL_FLOW"}]);
  assert.match(repaired.body_markdown,/^## Day 1 Evening: Raffles City, Hongyadong, and River Views$/m);
  assert.match(repaired.body_markdown,/A clearer route decision/);
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

test("draft normalization promotes exact planned labels and removes duplicate article titles", () => {
  const normalized=normalizeDraftHeadingHierarchy([
    "## Chongqing Metro Guide",
    "",
    "Arriving by Rail",
    "",
    "Use Line 10, then transfer.",
    "",
    "## Existing Heading",
    "",
    "Keep this section.",
  ].join("\n"),"Chongqing Metro Guide",["Arriving by Rail","Existing Heading"]);
  assert.doesNotMatch(normalized,/^#{1,6}\s+Chongqing Metro Guide$/m);
  assert.match(normalized,/^## Arriving by Rail$/m);
  assert.match(normalized,/^## Existing Heading$/m);
});

test("draft request sends each frozen fact once with bounded evidence while retaining its authorized scope", async () => {
  let requestBody;
  const fact={normalized_key:"place.hours",subject:"Place",predicate:"opening_hours",preferred_value:"09:00-17:00",
    consensus_status:"corroborated",freshness_state:"current",evidence:Array.from({length:8},(_,index)=>({
      claim_id:`claim-${index}`,source_id:`source-${index}`,value:"09:00-17:00",quote:"Detailed authorized evidence ".repeat(100),
      qualifiers:Array(20).fill("daily"),coverage_limitations:Array(20).fill("seasonal exception"),source_title:"Official source",
    }))};
  const output={title:"Chongqing Metro Guide",slug:"chongqing-metro-guide",meta_description:"A practical metro guide.",
    body_markdown:"Chongqing Metro Guide\n\nArriving by Rail\n\nPlace opens from 09:00 to 17:00.",
    evidence_ledger:[{section_id:"arrival",section:"Arriving by Rail",content_node_ids:["arrival_body"],claim_keys:["place.hours"],source_ids:["source-0"]}],
    unresolved_conflicts:[],verification_notes:[],seo:{meta_title:"Chongqing Metro Guide",focus_keyword:"Chongqing metro guide",secondary_keywords:[],search_intent:"informational",key_takeaways:[]},faqs:[],visuals:[]};
  const engine=new ContentEngine({apiKey:"key",model:"model",baseUrl:"https://api.example.test/v1"},async(_url,options)=>{
    requestBody=JSON.parse(options.body);
    return Response.json({model:"model",choices:[{finish_reason:"stop",message:{content:JSON.stringify(output)}}]});
  });
  const result=await engine.draft({
    brief:{plan:{title:"Chongqing Metro Guide",outline:[{section_id:"arrival",heading:"Arriving by Rail",claim_keys:["place.hours"]}]}},
    writing_packet:{selected_fact_keys:["place.hours"],evidence_ledger:[{fact_snapshot:fact}],context:{version:2,
      content_policy:{maximum_words:1000,faq:{maximum:0},visuals:{maximum:0}},experiences:[],reader_sources:[],authorized_source_assets:[]}},
  });
  const input=JSON.parse(requestBody.messages[1].content);
  assert.equal("evidence_ledger" in input.writing_packet,false);
  assert.deepEqual(input.writing_packet.evidence_scope,[{normalized_key:"place.hours",source_ids:["source-0","source-1","source-2"]}]);
  assert.equal(input.evidence_ledger_facts[0].evidence.length,3);
  assert.ok(input.evidence_ledger_facts[0].evidence.every((item)=>item.quote.length<=900 && item.qualifiers.length===8));
  assert.doesNotMatch(result.output.body_markdown,/Chongqing Metro Guide/);
  assert.match(result.output.body_markdown,/^## Arriving by Rail$/m);
});

test("draft generation repairs a missing protected duration before saving downstream work", async () => {
  const requests=[];
  const fact={normalized_key:"route.station.to_food_street",subject:"Station Exit 7 to food street",predicate:"walking_time",
    preferred_value:"3 minutes",consensus_status:"corroborated",freshness_state:"current",
    evidence:[{claim_id:"claim-duration",source_id:"source-duration",value:"3 minutes",quote:"Walk about three minutes.",qualifiers:[]}]};
  const base={title:"Chongqing route",slug:"chongqing-route",meta_description:"A practical route.",
    evidence_ledger:[{section_id:"route",section:"Route",content_node_ids:["route-body"],
      claim_keys:[fact.normalized_key],source_ids:["source-duration"]}],unresolved_conflicts:[],verification_notes:[],
    seo:{meta_title:"Chongqing route",focus_keyword:"Chongqing route",secondary_keywords:[],search_intent:"informational",key_takeaways:[]},faqs:[],visuals:[]};
  let attempt=0;
  const engine=new ContentEngine({apiKey:"key",model:"model",baseUrl:"https://api.example.test/v1"},async(_url,options)=>{
    requests.push(JSON.parse(options.body));
    attempt+=1;
    const body=attempt===1 ? "## Route\n\nLeave Exit 7 and walk to the food street." : "## Route\n\nLeave Exit 7 and walk 3 minutes to the food street.";
    return Response.json({model:"model",choices:[{finish_reason:"stop",message:{content:JSON.stringify({...base,body_markdown:body})}}]});
  });
  const result=await engine.draft({brief:{plan:{title:"Chongqing route",outline:[{section_id:"route",heading:"Route",claim_keys:[fact.normalized_key]}]}},
    writing_packet:{selected_fact_keys:[fact.normalized_key],evidence_ledger:[{fact_snapshot:fact}],context:{version:2,
      content_policy:{maximum_words:1000,faq:{maximum:0},visuals:{maximum:0}},experiences:[],reader_sources:[],authorized_source_assets:[]}}});
  assert.equal(requests.length,2);
  const correction=JSON.parse(requests[1].messages[1].content).revision_feedback;
  assert.deepEqual(correction.missing_protected_values,[{claim_key:fact.normalized_key,required_value:"3 minutes"}]);
  assert.match(result.output.body_markdown,/3 minutes/);
});

test("draft request preserves mandatory adaptations, conflicts, and verification notes from the approved brief", async () => {
  let requestBody;
  const output={title:"Chongqing guide",slug:"chongqing-guide",meta_description:"A practical guide.",body_markdown:"A grounded introduction.",
    evidence_ledger:[],unresolved_conflicts:[],verification_notes:[],seo:{meta_title:"Chongqing guide",focus_keyword:"Chongqing guide",secondary_keywords:[],search_intent:"informational",key_takeaways:[]},faqs:[],visuals:[]};
  const engine=new ContentEngine({apiKey:"key",model:"model",baseUrl:"https://api.example.test/v1"},async(_url,options)=>{
    requestBody=JSON.parse(options.body);
    return Response.json({model:"model",choices:[{finish_reason:"stop",message:{content:JSON.stringify(output)}}]});
  });
  await engine.draft({brief:{strategy_version:"3.3",plan:{outline:[],
    adaptation_requirements:["Show Hongyadong (洪崖洞) for navigation."],
    conflict_instructions:["Explain that lighting time varies by season."],
    verification_instructions:["Confirm current opening hours."]}},
    writing_packet:{selected_fact_keys:[],evidence_ledger:[],context:{version:2,content_policy:{faq:{maximum:0},visuals:{maximum:0}},
      experiences:[],reader_sources:[],authorized_source_assets:[],internal_link_inventory:[]}}});
  const input=JSON.parse(requestBody.messages[1].content);
  assert.deepEqual(input.brief.adaptation_requirements,["Show Hongyadong (洪崖洞) for navigation."]);
  assert.deepEqual(input.brief.conflict_instructions,["Explain that lighting time varies by season."]);
  assert.deepEqual(input.brief.verification_instructions,["Confirm current opening hours."]);
  assert.match(input.writing_packet.text,/MANDATORY TRAVELER ADAPTATIONS[\s\S]*洪崖洞/);
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

test("bounded repair corrects a missing protected duration before downstream work", async () => {
  const requests=[];
  const fact={normalized_key:"route.station.to_food_street",subject:"Station Exit 7 to food street",predicate:"walking_time",
    preferred_value:"3 minutes",evidence:[{claim_id:"claim-duration",source_id:"source-duration",value:"3 minutes",qualifiers:[]}]};
  const draft={content_hash:"duration-hash",title:"Guide",meta_description:"A practical guide.",seo:{meta_title:"Guide"},
    body_markdown:"## Route\n\nExit 7 leads to the food street.",evidence_ledger:[{section_id:"route",section:"Route",
      content_node_ids:["route-body"],claim_keys:[fact.normalized_key],source_ids:["source-duration"]}],verification_notes:[],visuals:[]};
  let attempt=0;
  const engine=new ContentEngine({apiKey:"key",model:"model",baseUrl:"https://api.example.test/v1"},async(_url,options)=>{
    requests.push(JSON.parse(options.body)); attempt+=1;
    const body=attempt===1 ? "Exit 7 leads to the food street." : "Walk 3 minutes from Exit 7 to the food street.";
    return Response.json({model:"model",choices:[{finish_reason:"stop",message:{content:JSON.stringify({
      base_content_hash:"duration-hash",replacement_sections:[{heading:"Route",body_markdown:body}],
    })}}]});
  });
  const result=await engine.repairDraft({draft,facts:[fact],brief:{plan:{outline:[{section_id:"route",heading:"Route",claim_keys:[fact.normalized_key]}]}}},[
    {code:"protected_evidence_mismatch",severity:"blocker",message:"Preserve 3 minutes."},
  ]);
  assert.equal(requests.length,2);
  const correction=JSON.parse(requests[1].messages[1].content);
  assert.deepEqual(correction.missing_protected_values,[{claim_key:fact.normalized_key,required_value:"3 minutes"}]);
  assert.match(result.output.body_markdown,/3 minutes/);
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

test("bounded repair retains mandatory brief constraints and prior blockers as regression guardrails", async () => {
  let requestBody;
  const draft={content_hash:"constraints",title:"Hongyadong guide",meta_description:"Practical guide",seo:{meta_title:"Hongyadong guide"},
    body_markdown:"## Visit\n\nOld copy.",evidence_ledger:[],verification_notes:[],visuals:[]};
  const engine=new ContentEngine({apiKey:"key",model:"model",baseUrl:"https://api.example.test/v1"},async(_url,options)=>{
    requestBody=JSON.parse(options.body);
    return Response.json({model:"model",choices:[{finish_reason:"stop",message:{content:JSON.stringify({
      base_content_hash:"constraints",replacement_sections:[{heading:"Visit",body_markdown:"Use Hongyadong (洪崖洞) and confirm seasonal lighting times."}],
    })}}]});
  });
  await engine.repairDraft({draft,facts:[],brief:{plan:{outline:[{section_id:"visit",heading:"Visit",claim_keys:[]}],
    adaptation_requirements:["Show simplified Chinese beside navigation names."],
    conflict_instructions:["Explain that lighting time varies by season."],verification_instructions:["Confirm current hours."]}},
    review_history:[{issues:[{code:"MISLEADING_CERTAINTY",severity:"blocker",message:"Do not state one fixed lighting time."}]}]},[
    {code:"MISSING_CHINESE_SCRIPT",severity:"blocker",message:"Add Chinese navigation names."},
  ]);
  const input=JSON.parse(requestBody.messages[1].content);
  assert.deepEqual(input.brief.adaptation_requirements,["Show simplified Chinese beside navigation names."]);
  assert.deepEqual(input.brief.conflict_instructions,["Explain that lighting time varies by season."]);
  assert.deepEqual(input.brief.verification_instructions,["Confirm current hours."]);
  assert.deepEqual(input.regression_guardrails,[{code:"MISLEADING_CERTAINTY",message:"Do not state one fixed lighting time."}]);
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

test("mandatory brief requirements are audited explicitly and cannot be downgraded to warnings", () => {
  const result=applyDeterministicGates({passed:true,score:90,issues:[
    {code:"MISSING_MANDATORY_ADAPTATION",severity:"warning",message:"The brief requires Chinese navigation labels."}],
  checks:[{name:"brief-adaptation-1",passed:false,detail:"Chinese labels are absent."}],unsupported_claims:[]},{
    draft:{title:"Route guide",body_markdown:"## Route\n\nChoose the signed route because it avoids backtracking.",
      meta_description:"A practical signed route.",seo:{meta_title:"Route guide",focus_keyword:"route guide",secondary_keywords:[],search_intent:"informational",key_takeaways:[],faqs:[]},
      evidence_ledger:[],unresolved_conflicts:[],verification_notes:[],visuals:[],faqs:[],strategy_version:"3.3",schema_jsonld:{"@graph":[{"@type":"Article"}] }},
    facts:[],brief:{strategy_version:"3.3",canonical:{quick_answer:"Use the signed route.",answer_blocks:[]},plan:{outline:[],
      adaptation_requirements:["Show simplified Chinese beside navigation names."],conflict_instructions:[]}},
    content_policy:{minimum_words:0,faq:{allowed:false},visuals:{minimum:0,maximum:0}},reader_sources:[],
  });
  assert.equal(result.passed,false);
  assert.equal(result.issues.find((issue)=>issue.code==="MISSING_MANDATORY_ADAPTATION").severity,"blocker");
  assert.equal(result.issues.some((issue)=>issue.code==="mandatory_brief_requirement_missing"),true);
});

test("quality review input keeps promised evidence once and bounds the provider response", async () => {
  let requestBody;
  const facts=Array.from({length:60},(_,index)=>({
    normalized_key:`place.fact_${index}`,subject:`Place ${index}`,predicate:"visitor_detail",preferred_value:`Value ${index}`,
    consensus_status:"corroborated",freshness_state:"current",validity_state:"current",
    evidence:Array.from({length:3},(__,evidenceIndex)=>({source_id:`source-${evidenceIndex}`,value:`Value ${index}`,
      quote:"Authorized evidence ".repeat(100),qualifiers:["visitor context"],coverage_limitations:[],canonical_url:"https://example.test/source"})),
  }));
  const output={passed:true,score:95,checks:[],issues:[],unsupported_claims:[]};
  const engine=new ContentEngine({apiKey:"key",model:"model",baseUrl:"https://api.example.test/v1"},async(_url,options)=>{
    requestBody=JSON.parse(options.body);
    return Response.json({model:"model",choices:[{finish_reason:"stop",message:{content:JSON.stringify(output)}}]});
  });
  await engine.review({
    brief:{strategy_version:"3.3",plan:{title:"Guide",outline:[
      {section_id:"one",heading:"One",claim_keys:["place.fact_0","place.fact_1"]},
      {section_id:"two",heading:"Two",claim_keys:["place.fact_2"]},
    ],canonical:{quick_answer:"Duplicated canonical content must not be repeated in QA input."}}},
    facts,content_policy:{minimum_words:0,faq:{allowed:false},visuals:{minimum:0,maximum:0}},reader_sources:[],
    draft:{title:"Guide",slug:"guide",meta_description:"Useful guide",body_markdown:"## One\n\nValue 0.\n\n## Two\n\nValue 2.",
      evidence_ledger:[{section_id:"one",claim_keys:["place.fact_0"]},{section_id:"two",claim_keys:["place.fact_2"]}],
      unresolved_conflicts:[],verification_notes:[],seo:{meta_title:"Guide",focus_keyword:"guide",secondary_keywords:[],search_intent:"informational",key_takeaways:[]},faqs:[],visuals:[]},
  });
  const input=JSON.parse(requestBody.messages[1].content);
  assert.deepEqual(input.facts.map((fact)=>fact.normalized_key),["place.fact_0","place.fact_1","place.fact_2"]);
  assert.ok(input.facts.every((fact)=>fact.evidence.length===2
    && fact.evidence.every((entry)=>entry.quote.length<=500 && !("canonical_url" in entry))));
  assert.equal("plan" in input.brief,false);
  const reviewSchema=requestBody.response_format.json_schema.schema;
  assert.equal(reviewSchema.properties.checks.maxItems,24);
  assert.equal(reviewSchema.properties.issues.maxItems,16);
  assert.equal(reviewSchema.properties.unsupported_claims.maxItems,12);
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
