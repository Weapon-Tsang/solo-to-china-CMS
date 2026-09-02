import assert from "node:assert/strict";
import test from "node:test";
import { normalizeXiaohongshuCapture } from "../src/adapters/xiaohongshu.mjs";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";

test("multilingual place aliases retain source claims while merging into one canonical knowledge entity", (t) => {
  const { repository } = repositoryFixture(t);
  const chinese = saveSource(repository, "zhongsi-cn", "中四路", "Walk this street after dinner.");
  const english = saveSource(repository, "zhongshan-en", "Zhongshan 4th Road", "Walk this street after dinner.");
  const claims = repository.db.prepare("SELECT id FROM claims ORDER BY source_id").all();

  repository.applyEntityResolution("chongqing", {
    entities: [{
      entity_key: "attraction.zhongshan_4th_road", canonical_subject: "Zhongshan 4th Road",
      aliases: ["Zhongshan 4th Road", "中四路"], confidence: 0.96,
    }],
    claim_updates: claims.map((claim) => ({
      claim_id: claim.id, entity_key: "attraction.zhongshan_4th_road", canonical_subject: "Zhongshan 4th Road",
      canonical_key: "attraction.zhongshan_4th_road.visit_time", confidence: 0.96,
    })),
    candidates: [],
  }, "fixture-model");
  repository.rebuildKnowledge("chongqing");

  const [fact] = repository.knowledgeForDestination("chongqing");
  assert.equal(fact.subject, "Zhongshan 4th Road");
  assert.equal(fact.entity_key, "attraction.zhongshan_4th_road");
  assert.deepEqual(new Set(fact.entity_aliases), new Set(["Zhongshan 4th Road", "中四路"]));
  assert.equal(fact.support_count, 2);
  assert.equal(fact.consensus_status, "corroborated");
  assert.equal(fact.evidence.length, 2);
  assert.ok(fact.evidence.some((item) => item.source_subject === "中四路"));
  assert.ok(fact.evidence.some((item) => item.source_subject === "Zhongshan 4th Road"));
  assert.equal(repository.getSource(chinese.id).claims[0].canonical_subject, "Zhongshan 4th Road");
  assert.equal(repository.getSource(english.id).claims[0].entity_resolution_status, "resolved");
});

test("uncertain multilingual aliases stay pending until an operator accepts or rejects them", (t) => {
  const { repository } = repositoryFixture(t);
  saveSource(repository, "candidate", "中四路小吃街", "A food stop.");
  repository.applyEntityResolution("chongqing", {
    entities: [], claim_updates: [],
    candidates: [{
      alias: "中四路小吃街", proposed_entity_key: "attraction.zhongshan_4th_road",
      proposed_canonical_subject: "Zhongshan 4th Road", confidence: 0.72,
      rationale: "The note may refer to a food area on the same road, but the boundary is unclear.",
    }],
  }, "fixture-model");
  const [candidate] = repository.listEntityMergeCandidates();
  assert.equal(candidate.status, "pending");
  assert.ok(repository.listOperationalExceptions().some((item) => item.kind === "entity_alias" && item.entity_alias?.id === candidate.id));
  const accepted = repository.decideEntityMergeCandidate(candidate.id, "accepted");
  assert.equal(accepted.status, "accepted");
  const alias = repository.listEntityAliases("chongqing").find((item) => item.alias_normalized.includes("中四路小吃街"));
  assert.equal(alias.canonical_subject, "Zhongshan 4th Road");
});

function saveSource(repository, externalId, subject, value) {
  const capture = repository.saveCapture(normalizeXiaohongshuCapture({
    url: `https://www.xiaohongshu.com/explore/${externalId}`,
    title: subject,
    text: `A manually selected Chongqing travel note about ${subject}.`,
    images: [],
  }));
  repository.saveExtraction(capture.id, {
    source: { language: /[\u4e00-\u9fff]/.test(subject) ? "zh-CN" : "en", summary: "Research", destination_name: "Chongqing", destination_slug: "chongqing", traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.9 },
    claims: [{ key: "attraction.zhongshan_4th_road.visit_time", subject, predicate: "visit time", value, qualifiers: [], source_quote: value, confidence: 0.9 }],
    blueprint: { format: "guide", hook: "Walk", angle: "local", sections: [], strengths: [], gaps: [] },
  }, "test", "fixture-model");
  return capture;
}
