import assert from "node:assert/strict";
import test from "node:test";
import { evidenceResolutionMode, evidenceTemporalState, resolveEvidenceConsensus } from "../src/evidence-consensus.mjs";

const nowMs = Date.parse("2026-09-10T00:00:00.000Z");

test("operator-selected daily facts remain usable without a date gate while conflicts stay explicit", () => {
  const rows = [
    row("recent-a", "CNY 50", "2026-09-08", "author-a"),
    row("recent-b", "CNY 50", "2026-09-09", "author-b"),
    row("old-a", "CNY 40", "2026-02-01", "author-c"),
    row("old-b", "CNY 40", "2026-02-02", "author-d"),
    row("old-c", "CNY 40", "2026-02-03", "author-e"),
  ];
  const result = resolveEvidenceConsensus(rows, { nowMs, variantKey: (item) => item.value_text });
  assert.equal(result.mode, "TRUSTED_SOURCE_POLICY");
  assert.equal(result.method, "TRUSTED_SOURCE_CONFLICT");
  assert.equal(result.preferredValue, "CNY 50");
  assert.equal(result.supportCount, 2);
  assert.equal(result.contradictionCount, 3);
  assert.ok(result.confidence > 0.7);
  assert.equal(result.latestEvidenceAt, null);
  assert.equal(result.dateKind, "captured_at");
  assert.equal(result.dateConfidence, "low");
  assert.equal(result.freshnessState, "current");
  assert.equal(result.autoResolved, false);
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
  assert.equal(result.method, "TRUSTED_SOURCE_CONFLICT");
});

test("manual submitter identity never merges distinct sources while repeated originals deduplicate", () => {
  const rows = [
    { ...row("manual-a", "CNY 50", "2026-09-09", "Writer A"), source_adapter: "manual", submitted_by: "administrator", source_identity: "url:https example com a" },
    { ...row("manual-b", "CNY 50", "2026-09-09", "Writer B"), source_adapter: "manual", submitted_by: "administrator", source_identity: "url:https example com b" },
    { ...row("manual-a-copy", "CNY 50", "2026-09-09", "Writer A"), source_adapter: "manual", submitted_by: "administrator", source_identity: "url:https example com a" },
  ];
  const result = resolveEvidenceConsensus(rows, { nowMs, variantKey: (item) => item.value_text });
  assert.equal(result.independentSourceCount, 2);
  assert.deepEqual(result.variants[0].independenceKeys.sort(), ["identity:url:https example com a", "identity:url:https example com b"]);
});

test("overlapping duplicate families form one transitive independence component", () => {
  const rows = [
    { ...row("copy-a", "CNY 50", "2026-09-09", "writer-a"), source_family_ids: "F1|F2" },
    { ...row("copy-b", "CNY 50", "2026-09-09", "writer-b"), source_family_ids: "F1|F3" },
    { ...row("independent", "CNY 60", "2026-09-09", "writer-c"), source_family_ids: "F4" },
  ];
  const result = resolveEvidenceConsensus(rows, { nowMs, variantKey: (item) => item.value_text });
  assert.equal(result.independentSourceCount, 2);
  assert.deepEqual(result.independenceGroups.find((group) => group.key === "family:f1").sourceIds, ["copy-a", "copy-b"]);
  assert.deepEqual(result.independenceGroups.find((group) => group.key === "family:f1").foldedSourceIds, ["copy-b"]);
});

test("stable author joins cross-family copies without merging unrelated authors", () => {
  const rows = [
    { ...row("trip-one", "CNY 50", "2026-09-08", "same-writer"), source_family_ids: "trip-one-family" },
    { ...row("trip-one-copy", "CNY 50", "2026-09-09", "same-writer"), source_family_ids: "trip-copy-family" },
    { ...row("different-work", "CNY 50", "2026-09-09", "different-writer"), source_family_ids: "different-family" },
  ];
  const result = resolveEvidenceConsensus(rows, { nowMs, variantKey: (item) => item.value_text });
  assert.equal(result.independentSourceCount, 2);
  assert.deepEqual(result.independenceGroups.map((group) => group.sourceIds), [["different-work"], ["trip-one", "trip-one-copy"]]);
});

test("independence closure and selected observation are invariant to input order", () => {
  const rows = [
    { ...row("b", "CNY 50", "2026-09-09", "writer-b"), source_family_ids: "F1|F3" },
    { ...row("a", "CNY 50", "2026-09-09", "writer-a"), source_family_ids: "F1|F2" },
    { ...row("z", "CNY 60", "2026-09-08", "writer-z"), source_family_ids: "F9" },
  ];
  const summarize = (items) => {
    const result = resolveEvidenceConsensus(items, { nowMs, variantKey: (item) => item.value_text });
    return { preferredValue: result.preferredValue, independentSourceCount: result.independentSourceCount,
      groups: result.independenceGroups, variants: result.variants };
  };
  assert.deepEqual(summarize(rows), summarize([...rows].reverse()));
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

test("capture time is only a low-confidence archive clue, never a factual observation date", () => {
  const result = resolveEvidenceConsensus([
    row("saved-today", "CNY 50", "2026-09-10", "author-a"),
  ], { nowMs, variantKey: (item) => item.value_text });
  assert.equal(result.preferredValue, "CNY 50");
  assert.equal(result.latestEvidenceAt, null);
  assert.equal(result.dateKind, "captured_at");
  assert.equal(result.dateConfidence, "low");
  assert.equal(result.validityState, "unknown");
});

test("future effective prices are scheduled and cannot replace the current price", () => {
  const rows = [
    { ...row("current", "CNY 50", "2026-09-01", "author-a"), published_at: "2026-09-01T00:00:00.000Z" },
    { ...row("future", "CNY 60", "2026-09-09", "author-b"), valid_from: "2027-01-01T00:00:00.000Z" },
  ];
  const result = resolveEvidenceConsensus(rows, { nowMs, variantKey: (item) => item.value_text });
  assert.equal(result.preferredValue, "CNY 50");
  assert.equal(result.scheduledEvidenceCount, 1);
  assert.equal(result.currentEvidenceCount, 1);
  assert.equal(result.validityState, "current");
  const scheduledOnly = resolveEvidenceConsensus([rows[1]], { nowMs, variantKey: (item) => item.value_text });
  assert.equal(scheduledOnly.method, "SCHEDULED_ONLY");
  assert.equal(scheduledOnly.preferredValue, "");
});

test("expired rules remain historical with their scope and without a fabricated current date", () => {
  const item = { ...row("seasonal", "CNY 30", "2026-09-09", "author-a"),
    valid_from: "2025-06-01T00:00:00.000Z", valid_to: "2025-08-31T23:59:59.000Z",
    qualifiers_json: JSON.stringify(["summer", "student ticket"]) };
  const temporal = evidenceTemporalState(item, nowMs);
  assert.equal(temporal.validityState, "historical");
  assert.equal(temporal.dateKind, "valid_to");
  const result = resolveEvidenceConsensus([item], { nowMs, variantKey: (entry) => entry.value_text });
  assert.equal(result.method, "HISTORICAL_ONLY");
  assert.equal(result.preferredValue, "");
  assert.equal(JSON.parse(item.qualifiers_json).join("|"), "summer|student ticket");
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
