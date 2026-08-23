import assert from "node:assert/strict";
import test from "node:test";
import { normalizeXiaohongshuCapture } from "../src/adapters/xiaohongshu.mjs";
import { Pipeline } from "../src/pipeline.mjs";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";

test("topic discovery can add an attraction how-to when multiple sources cover one subject", async (t) => {
  const { repository } = repositoryFixture(t);
  const extractor = {
    async extract(source) {
      return {
        method: "test", model: "model",
        result: {
          source: { language: "zh-CN", summary: "Forbidden City research", destination_name: "Beijing", destination_slug: "beijing", traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.9 },
          claims: Array.from({ length: 5 }, (_, index) => ({
            key: `forbidden-city.fact.${index}`, subject: "the Forbidden City", predicate: `detail ${index}`,
            value: `value ${index}`, qualifiers: [], source_quote: `${source.title} quote ${index}`, confidence: 0.8,
          })),
          blueprint: { format: "how-to", hook: "Avoid mistakes", angle: "independent visit", sections: [], strengths: [], gaps: [] },
        },
      };
    },
  };
  const pipeline = new Pipeline(repository, extractor, { contentConfig: { minFacts: 5, maxPerDestination: 2 } });
  for (const id of ["topicA", "topicB"]) {
    repository.saveCapture(normalizeXiaohongshuCapture({
      url: `https://www.xiaohongshu.com/explore/${id}`, title: `Source ${id}`,
      text: `A manually selected source with detailed Forbidden City information ${id}.`, images: [],
    }));
  }
  for (let index = 0; index < 15; index += 1) await pipeline.runOne();
  const topics = repository.listContent();
  assert.equal(topics.length, 2);
  assert.ok(topics.some((topic) => topic.topic_key === "beijing:first-time-solo-guide"));
  assert.ok(topics.some((topic) => topic.topic_key === "beijing:visit:the-forbidden-city"));
});
