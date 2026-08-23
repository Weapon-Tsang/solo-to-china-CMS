import assert from "node:assert/strict";
import test from "node:test";
import { normalizeXiaohongshuCapture } from "../src/adapters/xiaohongshu.mjs";
import { Pipeline } from "../src/pipeline.mjs";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";
import { CommercialComposer, normalizeCommercialOffer } from "../src/commercial.mjs";

test("evidence threshold automatically drives brief, draft, QA, and WordPress draft delivery", async (t) => {
  const { db, repository } = repositoryFixture(t);
  const sourceExtractor = {
    async extract(source) {
      return {
        method: "test", model: "source-model",
        result: {
          source: { language: "zh-CN", summary: "Research", destination_name: "Beijing", destination_slug: "beijing", traveler_fit: ["solo"], practical_tips: [], warnings: [], confidence: 0.9 },
          claims: Array.from({ length: 5 }, (_, index) => ({
            key: `beijing.fact.${index}`, subject: `Travel detail ${index}`, predicate: "guidance", value: `Value ${index}`,
            qualifiers: [], confidence: 0.85, source_quote: `${source.title} evidence ${index}`,
          })),
          blueprint: { format: "guide", hook: "First trip", angle: "solo first visit", sections: [], strengths: ["specific"], gaps: [] },
        },
      };
    },
  };
  const contentEngine = {
    enabled: true,
    async plan() {
      return { model: "planner-model", output: {
        title: "First-Time Beijing Solo Travel Guide", primary_keyword: "beijing solo travel", search_intent: "informational",
        audience: ["solo travelers"], angle: "first visit", reader_promise: "Plan with confidence",
        outline: [{ heading: "Plan", purpose: "Practical steps", claim_keys: ["beijing.fact.0", "beijing.fact.1"] }],
        adaptation_requirements: ["language"], conflict_instructions: [],
      } };
    },
    async draft() {
      return { model: "writer-model", output: {
        title: "First-Time Beijing Solo Travel Guide", slug: "beijing-solo-guide", meta_description: "A practical first-time Beijing guide.",
        body_markdown: "## Plan\n\nEvidence-backed practical guidance for independent visitors.",
        evidence_ledger: [{ section: "Plan", claim_keys: ["beijing.fact.0", "beijing.fact.1"], source_ids: [] }],
        unresolved_conflicts: [],
      } };
    },
    async review() {
      return { model: "reviewer-model", output: { passed: true, score: 92, checks: [], issues: [], unsupported_claims: [] } };
    },
  };
  const wordpress = {
    enabled: true,
    config: { siteUrl: "https://example.test" },
    calls: [],
    async upsertDraft(draft, postId) {
      this.calls.push({ draft, postId });
      return { postId: 42, postUrl: "https://example.test/?p=42", status: "draft" };
    },
  };
  const pipeline = new Pipeline(repository, sourceExtractor, {
    contentEngine, wordpress,
    commercialComposer: new CommercialComposer({ maxOffersPerDraft: 3, disclosure: "Affiliate disclosure." }),
    contentConfig: { minFacts: 5, maxPerDestination: 1 },
  });

  for (const [externalId, title] of [["autoA", "Source A"], ["autoB", "Source B"]]) {
    repository.saveCapture(normalizeXiaohongshuCapture({
      url: `https://www.xiaohongshu.com/explore/${externalId}`, title,
      text: `This manually selected Beijing source contains enough useful travel evidence: ${title}.`, images: [],
    }));
  }
  repository.upsertCommercialOffer(normalizeCommercialOffer({
    provider: "Trip.com", externalId: "hotel-search-beijing", category: "hotels", destinationSlug: "beijing",
    title: "Browse Beijing hotels", targetUrl: "https://example.test/affiliate/hotels?city=beijing",
    ctaLabel: "Check hotel options", description: "Compare available stays for your dates.", priority: 10,
  }));

  for (let index = 0; index < 30; index += 1) await pipeline.runOne();

  const content = repository.listContent();
  assert.equal(content.length, 1);
  assert.equal(content[0].draft_status, "wordpress_draft");
  assert.equal(content[0].qa_passed, 1);
  assert.equal(content[0].wordpress_post_id, 42);
  assert.equal(wordpress.calls.length, 1);
  assert.match(wordpress.calls[0].draft.body_markdown, /Optional booking resources/);
  assert.match(wordpress.calls[0].draft.body_markdown, /Affiliate disclosure/);
  const researchDraft = repository.getDraftPackage(content[0].draft_id).draft.body_markdown;
  assert.doesNotMatch(researchDraft, /Trip\.com|Optional booking resources/);
  assert.equal(JSON.stringify(repository.getTopicPackage(content[0].id)).includes("Trip.com"), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status='failed'").get().count, 0);
});
