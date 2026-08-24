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

test("WordPress inventory suppresses an overlapping topic before content planning", (t) => {
  const { db, repository } = repositoryFixture(t);
  seedKnowledge(db, { factCount: 5 });
  repository.replaceWordPressInventory("https://site.test", [{
    postId: 42,
    slug: "first-time-beijing-solo-travel-guide",
    title: "First-Time Beijing Solo Travel Guide",
    status: "publish",
    postUrl: "https://site.test/first-time-beijing-solo-travel-guide",
    modifiedAt: "2026-08-01T00:00:00",
  }]);
  const generated = repository.rebuildTopicCandidates("beijing", 5, 1);
  assert.equal(generated.length, 0);
  const [topic] = repository.listContent();
  assert.equal(topic.status, "dismissed");
  assert.match(topic.suppression_reason, /^wordpress:42:/);
  assert.equal(repository.queueCandidate(topic.id), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type='plan_content'").get().count, 0);
  repository.replaceWordPressInventory("https://site.test", []);
  const restored = repository.rebuildTopicCandidates("beijing", 5, 1);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].status, "candidate");
  assert.equal(restored[0].suppression_reason, null);
});

test("itinerary discovery requires route evidence from multiple sources and never displaces the core guide", (t) => {
  const { db, repository } = repositoryFixture(t);
  seedKnowledge(db, { factCount: 6, routeFacts: true });
  const one = repository.rebuildTopicCandidates("beijing", 5, 1);
  assert.equal(one.length, 1);
  assert.equal(one[0].topic_key, "beijing:first-time-solo-guide");
  const expanded = repository.rebuildTopicCandidates("beijing", 5, 3);
  assert.ok(expanded.some((topic) => topic.topic_key === "beijing:practical-solo-itinerary"));
});

test("Search Console query inventory suppresses and restores overlapping topics automatically", (t) => {
  const { db, repository } = repositoryFixture(t);
  seedKnowledge(db, { factCount: 5 });
  repository.replaceSearchConsoleInventory("sc-domain:site.test", {
    startDate: "2026-07-28", endDate: "2026-08-23", rows: [{
      query: "first time beijing solo travel guide",
      pageUrl: "https://site.test/existing-beijing-guide",
      clicks: 12, impressions: 120, ctr: 0.1, position: 4,
    }],
  });
  assert.equal(repository.rebuildTopicCandidates("beijing", 5, 1).length, 0);
  const [suppressed] = repository.listContent();
  assert.match(suppressed.suppression_reason, /^search_console:gsc_/);
  repository.replaceSearchConsoleInventory("sc-domain:site.test", { startDate: "2026-07-28", endDate: "2026-08-23", rows: [] });
  const restored = repository.rebuildTopicCandidates("beijing", 5, 1);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].suppression_reason, null);
});

function seedKnowledge(db, { factCount, routeFacts = false }) {
  const timestamp = "2026-08-23T00:00:00.000Z";
  db.prepare("INSERT INTO destinations(id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run("dst_beijing", "beijing", "Beijing", timestamp, timestamp);
  const insert = db.prepare(`
    INSERT INTO knowledge_facts(id, destination_id, normalized_key, subject, predicate, consensus_status,
      preferred_value, support_count, contradiction_count, evidence_json, updated_at)
    VALUES (?, ?, ?, ?, ?, 'corroborated', ?, 2, 0, ?, ?)
  `);
  for (let index = 0; index < factCount; index += 1) {
    const subject = routeFacts ? `Route segment ${index}` : `Practical detail ${index}`;
    const predicate = routeFacts ? `metro travel time order ${index}` : `detail ${index}`;
    insert.run(`fact_${index}`, "dst_beijing", `${routeFacts ? "route" : "detail"}.${index}`, subject, predicate,
      `value ${index}`, JSON.stringify([{ source_id: "source_a" }, { source_id: "source_b" }]), timestamp);
  }
}
