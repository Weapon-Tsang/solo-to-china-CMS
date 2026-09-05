import assert from "node:assert/strict";
import test from "node:test";
import { normalizeXiaohongshuCapture } from "../src/adapters/xiaohongshu.mjs";
import { Pipeline } from "../src/pipeline.mjs";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";

test("pipeline separates extraction, claims, knowledge conflict detection, and editorial patterns", async (t) => {
  const { repository } = repositoryFixture(t);
  const extractor = {
    async extract(source) {
      const value = source.title.includes("A") ? "East Gate" : "South Gate";
      return {
        method: "test",
        model: "fixture-model",
        result: {
          source: {
            language: "zh-CN", summary: "A source summary", destination_name: "Beijing", destination_slug: "beijing",
            traveler_fit: ["solo"], practical_tips: [], warnings: [], confidence: 0.9,
          },
          claims: [{
            key: "attraction.example.entry_gate", subject: "Example attraction", predicate: "entry gate", value,
            qualifiers: [], confidence: 0.8, source_quote: `Use the ${value}`,
          }],
          blueprint: {
            format: "practical guide", hook: "save time", angle: "first visit",
            sections: [{ heading: "Before you go", purpose: "Preparation" }], strengths: ["specific"], gaps: ["accessibility"],
          },
        },
      };
    },
  };
  const pipeline = new Pipeline(repository, extractor);

  for (const [id, title] of [["sourceA", "Guide A"], ["sourceB", "Guide B"]]) {
    repository.saveCapture(normalizeXiaohongshuCapture({
      url: `https://www.xiaohongshu.com/explore/${id}`,
      title,
      text: `This is source ${id} with a sufficiently long practical travel description.`,
      images: [],
    }));
  }

  for (let index = 0; index < 8; index += 1) await pipeline.runOne();

  const dashboard = repository.dashboard();
  assert.equal(dashboard.totals.sources, 2);
  assert.equal(dashboard.totals.claims, 2);
  assert.equal(dashboard.totals.knowledgeFacts, 1);
  assert.equal(dashboard.totals.conflicts, 1);
  assert.equal(dashboard.actionCounts.exceptions, 1);
  assert.equal(dashboard.actionCounts.recommendations, 0);
  assert.equal(repository.getEditorialBlueprints()[0].sample_count, 2);
  assert.equal(repository.getKnowledge()[0].evidence.length, 2);
});

test("re-extraction versions derived claims instead of erasing their audit history", (t) => {
  const { db, repository } = repositoryFixture(t);
  const source = repository.saveCapture(normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/versioned-extraction",
    title: "Versioned extraction",
    text: "A manually selected Chongqing travel note with enough text for extraction version testing.",
    images: [],
  }));
  const result = (value) => ({
    source: {
      language: "zh-CN", summary: "A source summary", destination_name: "Chongqing", destination_slug: "chongqing",
      traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.9,
    },
    claims: [{
      key: "attraction.example.reservation_required", subject: "Example attraction",
      predicate: "reservation_required", value, qualifiers: [], confidence: 0.9,
      source_quote: value === "true" ? "需要预约" : "无需预约", claim_role: "fact", knowledge_eligible: true,
    }],
    blueprint: { format: "guide", hook: "Plan ahead", angle: "practical", sections: [], strengths: [], gaps: [] },
  });

  repository.saveExtraction(source.id, result("true"), "test", "model-a");
  const firstClaim = db.prepare("SELECT * FROM claims WHERE source_id=?").get(source.id);
  repository.saveExtraction(source.id, result("false"), "test", "model-b");

  const current = db.prepare("SELECT * FROM claims WHERE source_id=?").get(source.id);
  const history = db.prepare("SELECT * FROM claim_history WHERE source_id=?").all(source.id);
  const runs = db.prepare("SELECT * FROM extraction_runs WHERE source_id=? ORDER BY revision").all(source.id);
  assert.equal(current.extraction_revision, 2);
  assert.equal(current.value_text, "false");
  assert.equal(history.length, 1);
  assert.equal(history[0].claim_id, firstClaim.id);
  assert.equal(JSON.parse(history[0].snapshot_json).value_text, "true");
  assert.deepEqual(runs.map((run) => run.status), ["superseded", "active"]);
  const hydrated = repository.getSource(source.id);
  assert.equal(hydrated.extraction_runs.length, 2);
  assert.equal(hydrated.claim_history[0].snapshot.value_text, "true");
});

test("editorial metadata and personal experience remain as claims but stay out of knowledge", (t) => {
  const { db, repository } = repositoryFixture(t);
  const source = repository.saveCapture(normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/knowledge-admission",
    title: "Knowledge admission",
    text: "A manually selected Chongqing note containing a place fact and an author disclaimer for testing.",
    images: [],
  }));
  repository.saveExtraction(source.id, {
    source: {
      language: "zh-CN", summary: "Mixed source", destination_name: "Chongqing", destination_slug: "chongqing",
      traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.9,
    },
    claims: [
      { key: "attraction.example.opening_time", subject: "Example attraction", predicate: "opening_time", value: "09:00", qualifiers: [], confidence: 0.9, source_quote: "09:00开放", claim_role: "fact", knowledge_eligible: true },
      { key: "source.recommendations.disclaimer", subject: "recommendations", predicate: "stated as", value: "作者主观体验，非唯一答案", qualifiers: [], confidence: 0.9, source_quote: "只是作者主观体验，并非唯一答案", claim_role: "editorial_metadata", knowledge_eligible: false },
    ],
    blueprint: { format: "guide", hook: "Plan ahead", angle: "practical", sections: [], strengths: [], gaps: [] },
  }, "test", "fixture-model");

  repository.rebuildKnowledge("chongqing");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM claims WHERE source_id=?").get(source.id).count, 2);
  assert.equal(repository.knowledgeForDestination("chongqing").length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM claim_review_cases").get().count, 0);
});

test("equivalent reservation wording produces one corroborated canonical Knowledge fact", (t) => {
  const { db, repository } = repositoryFixture(t);
  const assertions = [
    { id: "6a0000000000000000000001", predicate: "does not require", value: "advance reservation", quote: "无需预约" },
    { id: "6a0000000000000000000002", predicate: "requires reservation", value: "no reservation required", quote: "无需预约" },
  ];
  for (const assertion of assertions) {
    const source = repository.saveCapture(normalizeXiaohongshuCapture({
      url: `https://www.xiaohongshu.com/explore/${assertion.id}`,
      title: assertion.id,
      text: "A manually selected Chongqing note containing a reservation assertion for canonicalization testing.",
      images: [],
    }));
    repository.saveExtraction(source.id, {
      source: {
        language: "zh-CN", summary: "Reservation", destination_name: "Chongqing", destination_slug: "chongqing",
        traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.9,
      },
      claims: [{
        key: "attraction.hongyadong.reservation_required", subject: "Hongyadong",
        predicate: assertion.predicate, value: assertion.value, qualifiers: [], confidence: 0.9,
        source_quote: assertion.quote, claim_role: "fact", knowledge_eligible: true,
      }],
      blueprint: { format: "guide", hook: "Plan ahead", angle: "practical", sections: [], strengths: [], gaps: [] },
    }, "test", "fixture-model");
  }

  repository.rebuildKnowledge("chongqing");
  const [fact] = repository.knowledgeForDestination("chongqing");
  assert.equal(fact.predicate, "reservation_required");
  assert.equal(fact.preferred_value, "false");
  assert.equal(fact.consensus_status, "corroborated");
  assert.equal(fact.support_count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM claim_review_cases").get().count, 0);
});
