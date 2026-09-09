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
      images: [],
    }));
    repository.saveExtraction(saved.id, extraction("ticket.price", "ticket", "price", "CNY 40"), "test", "test");
  }
  repository.rebuildKnowledge("beijing");
  const [fact] = repository.knowledgeForDestination("beijing");
  assert.equal(fact.freshness_state, "stale");
  assert.equal(fact.verification_priority, "review");
  assert.equal(fact.consensus_method, "MULTI_SOURCE_AGREEMENT");
  assert.match(fact.latest_evidence_at, /^2024-01-02/);
  assert.equal(repository.listOperationalExceptions().some((item) => item.kind === "knowledge"), false);
  assert.equal(repository.rebuildTopicCandidates("beijing", 1, 1).length, 1);
});

function extraction(key, subject, predicate, value) {
  return {
    source: { language: "zh-CN", summary: "Research", destination_name: "Beijing", destination_slug: "beijing", traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.9 },
    claims: [{ key, subject, predicate, value, qualifiers: [], source_quote: "Quoted evidence", confidence: 0.9 }],
    blueprint: { format: "guide", hook: "Plan", angle: "practical", sections: [], strengths: [], gaps: [] },
  };
}
