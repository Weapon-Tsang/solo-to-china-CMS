import assert from "node:assert/strict";
import test from "node:test";
import { normalizeXiaohongshuCapture } from "../src/adapters/xiaohongshu.mjs";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";

test("knowledge aggregation classifies volatile and stale evidence", (t) => {
  const { repository } = repositoryFixture(t, { staleAfterDays: 365, volatileStaleAfterDays: 90 });
  for (const [externalId, capturedAt] of [["freshnessolda", "2024-01-01"], ["freshnessoldb", "2024-01-02"]]) {
    const saved = repository.saveCapture(normalizeXiaohongshuCapture({
      url: `https://www.xiaohongshu.com/explore/${externalId}`,
      title: externalId,
      text: "A manually selected source containing enough detailed travel research.",
      capturedAt,
      publishedAt: capturedAt,
      images: [],
    }));
    repository.saveExtraction(saved.id, extraction("ticket.price", "ticket", "price", "CNY 40"), "test", "test");
  }
  repository.rebuildKnowledge("beijing");
  const [fact] = repository.knowledgeForDestination("beijing");
  assert.equal(fact.freshness_state, "current");
  assert.equal(fact.verification_priority, "normal");
  assert.equal(fact.consensus_method, "TRUSTED_SOURCE_POLICY");
  assert.match(fact.latest_evidence_at, /^2024-01-02/);
  assert.equal(repository.listOperationalExceptions().some((item) => item.kind === "knowledge"), false);
  assert.equal(repository.rebuildTopicCandidates("beijing", 1, 1).length, 1);
});

test("knowledge keeps future and expired evidence but excludes it from the current conclusion", (t) => {
  const { repository } = repositoryFixture(t);
  for (const [externalId, value, dates] of [
    ["temporalcurrent", "CNY 50", { observed_at: "2026-09-01T00:00:00.000Z" }],
    ["temporalfuture", "CNY 60", { valid_from: "2027-01-01T00:00:00.000Z", date_confidence: "high" }],
    ["temporalhistory", "CNY 40", { valid_from: "2025-06-01T00:00:00.000Z", valid_to: "2025-08-31T00:00:00.000Z", date_confidence: "high" }],
  ]) {
    const saved = repository.saveCapture(normalizeXiaohongshuCapture({
      url: `https://www.xiaohongshu.com/explore/${externalId}`,
      title: externalId,
      text: "A manually selected source containing enough dated ticket evidence.",
      capturedAt: "2026-09-10",
      images: [],
    }));
    const result = extraction("ticket.price", "ticket", "price", value);
    Object.assign(result.claims[0], dates, { qualifiers: ["student ticket", "summer season"] });
    repository.saveExtraction(saved.id, result, "test", "test");
  }
  repository.rebuildKnowledge("beijing");
  const [fact] = repository.knowledgeForDestination("beijing");
  assert.equal(fact.preferred_value, "CNY 50");
  assert.equal(fact.validity_state, "current");
  assert.equal(fact.consensus_detail.scheduledEvidenceCount, 1);
  assert.equal(fact.consensus_detail.historicalEvidenceCount, 1);
  assert.deepEqual(fact.evidence.find((item) => item.value === "CNY 60").qualifiers, ["student ticket", "summer season"]);
  repository.db.prepare("UPDATE knowledge_facts SET consensus_detail_json=? WHERE destination_id=(SELECT id FROM destinations WHERE slug='beijing')")
    .run(JSON.stringify({ independentSourceCount: 3, variants: [{ independenceKeys: ["legacy:a", "legacy:b", "legacy:c"] }] }));
  const preview = repository.rebuildEvidenceIndependence("beijing");
  assert.equal(preview.dryRun, true);
  assert.equal(preview.affectedCount, 1);
  const rebuilt = repository.rebuildEvidenceIndependence("beijing", { dryRun: false });
  assert.equal(rebuilt.rebuilt, true);
  assert.ok(repository.knowledgeForDestination("beijing")[0].consensus_detail.independenceGroups.length >= 1);
});

function extraction(key, subject, predicate, value) {
  return {
    source: { language: "zh-CN", summary: "Research", destination_name: "Beijing", destination_slug: "beijing", traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.9 },
    claims: [{ key, subject, predicate, value, qualifiers: [], source_quote: "Quoted evidence", confidence: 0.9 }],
    blueprint: { format: "guide", hook: "Plan", angle: "practical", sections: [], strengths: [], gaps: [] },
  };
}
