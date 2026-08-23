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
  assert.equal(repository.getEditorialBlueprints()[0].sample_count, 2);
  assert.equal(repository.getKnowledge()[0].evidence.length, 2);
});
