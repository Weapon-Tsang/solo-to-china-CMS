import assert from "node:assert/strict";
import test from "node:test";
import { classifyClaimPair, detectClaimExtractionIssue, structureClaim } from "../src/claim-resolution.mjs";
import { normalizeXiaohongshuCapture } from "../src/adapters/xiaohongshu.mjs";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";

const claim = (value, options = {}) => ({
  predicate: options.predicate || "recommended_visit_time", value_text: value,
  qualifiers: options.qualifiers || [], source_quote: options.sourceQuote || value,
});

test("more detailed visit-time wording enriches rather than conflicts", () => {
  for (const [plain, detailed] of [
    ["afternoon visit", "afternoon (old residential buildings, daily life, cableway-through-building photo spot)"],
    ["evening/night visit", "evening/night (stroll from dusk to dark, pleasant night tour)"],
    ["morning visit", "morning (comfortable tree-lined road, suitable for walking)"],
  ]) {
    const result = classifyClaimPair(claim(plain), claim(detailed));
    assert.equal(result.relation, "ENRICHMENT");
    assert.equal(result.canCoexist, true);
  }
});

test("a narrower compatible expression is stored as refinement", () => {
  const refined = classifyClaimPair(
    claim("photography", { predicate: "good_for" }),
    claim("night photography", { predicate: "good_for" }),
  );
  assert.equal(refined.relation, "REFINEMENT");
  assert.equal(refined.canCoexist, true);
});

test("overlapping soft recommendations coexist while a real contradiction is reviewed", () => {
  const overlap = classifyClaimPair(claim("evening/blue hour"), claim("evening/night (blue hour very beautiful)"));
  assert.equal(overlap.relation, "OVERLAPPING");
  assert.equal(overlap.canCoexist, true);

  const conflict = classifyClaimPair(
    claim("Liziba is worth a special trip", { predicate: "worth_visiting" }),
    claim("Liziba is not worth a special trip", { predicate: "worth_visiting" }),
  );
  assert.equal(conflict.relation, "CONFLICT");
  assert.equal(conflict.canCoexist, false);
  assert.equal(conflict.reviewType, "CLAIM_CONFLICT");
});

test("hard facts use scope-aware conflict rules and extraction errors are separated", () => {
  const conflict = classifyClaimPair(
    claim("1 day", { predicate: "reservation_required" }),
    claim("2 days", { predicate: "reservation_required" }),
  );
  assert.equal(conflict.relation, "CONFLICT");
  assert.equal(conflict.reviewType, "SOURCE_CONFLICT");

  const scoped = classifyClaimPair(
    { ...claim("08:00", { predicate: "opening_time" }), structured_value: { ...structureClaim({ predicate: "opening_time", value: "08:00", qualifiers: [] }), scope: { season: ["summer"] } } },
    { ...claim("09:00", { predicate: "opening_time" }), structured_value: { ...structureClaim({ predicate: "opening_time", value: "09:00", qualifiers: [] }), scope: { season: ["winter"] } } },
  );
  assert.equal(scoped.relation, "COMPATIBLE");

  const extraction = classifyClaimPair(
    claim("worth a special trip", { predicate: "worth_visiting", sourceQuote: "not worth a special trip; only good for a photo" }),
    claim("worth a special trip", { predicate: "worth_visiting" }),
  );
  assert.equal(extraction.reviewType, "NEGATION_EXTRACTION_ERROR");
});

test("extraction review checks the complete Claim semantics instead of value text alone", () => {
  assert.equal(detectClaimExtractionIssue({
    source_quote: "重庆动物园 25r 8:00-18:00 无需预约 2号线动物园",
    predicate: "does not require",
    value_text: "advance reservation",
  }), null);
  assert.equal(detectClaimExtractionIssue({
    source_quote: "景区里的网红餐厅不要去",
    predicate: "should avoid",
    value_text: "internet-famous restaurants in touristy areas",
  }), null);
  assert.equal(detectClaimExtractionIssue({
    source_quote: "只是作者主观体验，并非唯一答案",
    predicate: "stated as",
    value_text: "作者主观体验，非唯一答案",
  }), null);
  assert.equal(detectClaimExtractionIssue({
    source_quote: "无需提前预约",
    predicate: "reservation information",
    value_text: "advance reservation",
  }), "NEGATION_EXTRACTION_ERROR");
  assert.equal(detectClaimExtractionIssue({
    source_quote: "only good for a photo",
    predicate: "good for",
    value_text: "photography",
    qualifiers: ["only good for a photo"],
  }), null);
});

test("contrastive and quoted slogan wording is not treated as logical negation", () => {
  assert.equal(detectClaimExtractionIssue({
    source_quote: "夜游磁器口和白天不一样的感觉，建议晚上去",
    predicate: "recommended_visit_time",
    value_text: "evening/night",
  }), null);
  assert.equal(detectClaimExtractionIssue({
    source_quote: "海报上‘热得遭不住了’简直是我的心声",
    predicate: "features",
    value_text: "Midea branded melting billboard installation",
  }), null);
});

test("claims sharing an exact quote satisfy negation and limiter coverage together", () => {
  const quote = "整条路线全程下坡，几乎不用爬坡，带老人小孩出行都很友好";
  const suitable = { id: "suitable", source_quote: quote, predicate: "suitable_for", value_text: "elderly travelers and children" };
  const terrain = { id: "terrain", source_quote: quote, predicate: "requires_climbing", value_text: "false" };
  assert.equal(detectClaimExtractionIssue(suitable, [terrain]), null);
});

test("reservation wording is compared as a canonical boolean fact", () => {
  assert.equal(structureClaim({ predicate: "预约要求", value: "需要预约" }).typed_value, true);
  assert.equal(structureClaim({ predicate: "预约要求", value: "无需预约" }).typed_value, false);
  const noReservationA = claim("advance reservation", { predicate: "does not require", sourceQuote: "" });
  const noReservationB = claim("no reservation required", { predicate: "requires reservation", sourceQuote: "" });
  const equivalent = classifyClaimPair(noReservationA, noReservationB);
  assert.equal(equivalent.relation, "PARAPHRASE");
  assert.equal(equivalent.canCoexist, true);
  assert.equal(equivalent.reviewType, null);

  const required = claim("true", { predicate: "reservation_required", sourceQuote: "" });
  const notRequired = claim("false", { predicate: "reservation_required", sourceQuote: "" });
  const conflict = classifyClaimPair(required, notRequired);
  assert.equal(conflict.relation, "CONFLICT");
  assert.equal(conflict.reviewType, "SOURCE_CONFLICT");
});

test("matching time evidence with richer description is enrichment, not a hard-fact conflict", () => {
  const enriched = classifyClaimPair(
    claim("20:00-23:00", { predicate: "has evening lighting during", sourceQuote: "洪崖洞晚上20:00-23:00亮灯" }),
    claim("lit from 20:00-23:00 and looks like the real-life Spirited Away", { predicate: "has evening lighting during", sourceQuote: "洪崖洞晚上20:00-23:00亮灯" }),
  );
  assert.equal(enriched.relation, "ENRICHMENT");
  assert.equal(enriched.canCoexist, true);
  assert.equal(enriched.reviewType, null);
});

test("knowledge aggregation persists enrichment relations without creating an exception", (t) => {
  const { repository } = repositoryFixture(t);
  for (const [externalId, value] of [["claima", "afternoon visit"], ["claimb", "afternoon (old residential buildings, daily life, cableway-through-building photo spot)"]]) {
    const source = repository.saveCapture(normalizeXiaohongshuCapture({ url: `https://www.xiaohongshu.com/explore/${externalId}`, title: externalId, text: "A manually selected Chongqing note with practical visit timing details.", images: [] }));
    repository.saveExtraction(source.id, {
      source: { language: "en", summary: "Timing", destination_name: "Chongqing", destination_slug: "chongqing", traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.9 },
      claims: [{ key: "attraction.baixiangju.recommended_visit_time", subject: "Baixiangju", predicate: "recommended_visit_time", value, qualifiers: [], source_quote: value, confidence: 0.9 }],
      blueprint: { format: "guide", hook: "Timing", angle: "practical", sections: [], strengths: [], gaps: [] },
    }, "test", "fixture-model");
  }
  repository.rebuildKnowledge("chongqing");
  const fact = repository.knowledgeForDestination("chongqing")[0];
  assert.equal(fact.consensus_status, "corroborated");
  assert.equal(fact.contradiction_count, 0);
  assert.equal(fact.claim_relations[0].relation, "ENRICHMENT");
  assert.equal(repository.listOperationalExceptions().some((item) => item.kind === "claim_conflict"), false);
});
