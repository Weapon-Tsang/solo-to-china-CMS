import assert from "node:assert/strict";
import test from "node:test";
import { evidenceResolutionMode, resolveEvidenceConsensus } from "../src/evidence-consensus.mjs";

const nowMs = Date.parse("2026-09-10T00:00:00.000Z");

test("recent independent evidence can supersede a larger but materially older cluster", () => {
  const rows = [
    row("recent-a", "CNY 50", "2026-09-08", "author-a"),
    row("recent-b", "CNY 50", "2026-09-09", "author-b"),
    row("old-a", "CNY 40", "2026-02-01", "author-c"),
    row("old-b", "CNY 40", "2026-02-02", "author-d"),
    row("old-c", "CNY 40", "2026-02-03", "author-e"),
  ];
  const result = resolveEvidenceConsensus(rows, { nowMs, variantKey: (item) => item.value_text });
  assert.equal(result.mode, "RECENCY_WEIGHTED");
  assert.equal(result.method, "RECENCY_WEIGHTED_CONSENSUS");
  assert.equal(result.preferredValue, "CNY 50");
  assert.equal(result.supportCount, 2);
  assert.equal(result.contradictionCount, 3);
  assert.ok(result.confidence > 0.7);
});

test("posts in one source family or by one author count as one independent vote", () => {
  const rows = [
    { ...row("copy-a", "08:00-22:00", "2026-09-09", "same-author"), source_family_ids: "family-copy" },
    { ...row("copy-b", "08:00-22:00", "2026-09-09", "same-author"), source_family_ids: "family-copy" },
    row("independent", "09:00-21:00", "2026-09-09", "other-author"),
  ];
  const result = resolveEvidenceConsensus(rows, { nowMs, variantKey: (item) => item.value_text });
  assert.equal(result.independentSourceCount, 2);
  assert.deepEqual(result.variants.flatMap((variant) => variant.independenceKeys).sort(), ["author:xiaohongshu:other author", "family:family-copy"]);
  assert.equal(result.supportCount, 1);
  assert.equal(result.method, "LATEST_WEIGHTED_PROVISIONAL");
});

test("safety-critical disagreements remain strict instead of being auto-resolved", () => {
  const rows = [
    { ...row("safe-a", "true", "2026-09-09", "author-a"), predicate: "allergen_warning" },
    { ...row("safe-b", "false", "2026-09-09", "author-b"), predicate: "allergen_warning" },
  ];
  assert.equal(evidenceResolutionMode(rows), "STRICT_SAFETY_REVIEW");
  assert.equal(resolveEvidenceConsensus(rows, { nowMs }).autoResolved, false);
});

test("dynamic-looking recommendations remain parallel viewpoints instead of competing truth values", () => {
  const rows = [
    { ...row("route-a", "Hongyadong then Liziba", "2026-09-09", "author-a"),
      normalized_key: "chongqing.itinerary.route", predicate: "route",
      structured_value: { claim_kind: "SOFT_RECOMMENDATION", cardinality: "MULTI_VALUE" } },
    { ...row("route-b", "Shibati then Jiefangbei", "2026-09-09", "author-b"),
      normalized_key: "chongqing.itinerary.route", predicate: "route",
      structured_value: { claim_kind: "SOFT_RECOMMENDATION", cardinality: "MULTI_VALUE" } },
  ];
  assert.equal(evidenceResolutionMode(rows), "SEMANTIC_COMPATIBILITY");
  assert.equal(resolveEvidenceConsensus(rows, { nowMs }).autoResolved, false);
});

function row(sourceId, value, capturedAt, author) {
  return {
    source_id: sourceId,
    normalized_key: "attraction.test.ticket_price",
    subject: "Test attraction",
    predicate: "ticket_price",
    value_text: value,
    confidence: 0.9,
    captured_at: `${capturedAt}T00:00:00.000Z`,
    source_author_name: author,
    source_adapter: "xiaohongshu",
    source_authority_level: 4,
    source_completeness_status: "complete",
    structured_value: { canonical_predicate: "price" },
  };
}
