import assert from "node:assert/strict";
import test from "node:test";
import { buildPublishPackage, synchronizeSchemaWithPage } from "../src/publish-page.mjs";
import {
  affectedInternalLinkBlocks, buildSeoPreview, duplicateContentRisks, inventoryTargetChanges,
  inventoryVersion, resolveCanonicalUrl, selectInternalLinks,
  synchronizeSeoMetadata, titlePromiseRisks, validateSeoGeoArtifact,
} from "../src/seo-geo.mjs";

const canonical = "https://solotochina.com/chongqing-night-guide/";
const baseDraft = {
  id: "draft-1", title: "Chongqing night guide", slug: "chongqing-night-guide",
  meta_description: "A focused guide to one evidence-backed Chongqing evening route.",
  seo: { meta_title: "Chongqing night guide for first-time visitors", canonical_url: canonical,
    focus_keyword: "Chongqing night guide", secondary_keywords: [], search_intent: "informational" },
  strategy_version: "1.8",
};
const basePage = { metadata: { pageId: "draft-1", title: baseDraft.title, slug: baseDraft.slug, contentType: "itinerary" },
  blocks: [{ type: "paragraph", variant: "default", data: { content: "A focused evening route." } }] };

test("SEO preview preserves long editorial fields and makes no display or CTR promise", () => {
  const longTitle = "A precise Chongqing evening route for independent first-time visitors who want a slower riverside walk";
  const preview = buildSeoPreview({ title: longTitle, meta_description: "Specific summary.", seo: { meta_title: longTitle } });
  assert.equal(preview.title, longTitle);
  assert.equal(preview.titleGuidance, "long");
  assert.match(preview.disclaimer, /may rewrite or truncate/i);
  assert.match(preview.disclaimer, /no CTR/i);
});

test("inventory route or status changes identify only page blocks that reference the changed target", () => {
  const changes = inventoryTargetChanges([
    { post_id: 7, status: "publish", post_url: "https://solotochina.com/chongqing-transport/" },
    { post_id: 8, status: "publish", post_url: "https://solotochina.com/beijing-food/" },
  ], [
    { postId: 7, status: "draft", postUrl: "https://solotochina.com/?p=7&preview=true" },
    { postId: 8, status: "publish", postUrl: "https://solotochina.com/beijing-food/" },
  ]);
  assert.deepEqual(changes.map((item) => item.post_id), [7]);
  assert.deepEqual(affectedInternalLinkBlocks({ blocks: [
    { type: "paragraph", data: { content: '<a href="https://solotochina.com/chongqing-transport/">Chongqing transport</a>' } },
    { type: "paragraph", data: { content: '<a href="https://solotochina.com/beijing-food/">Beijing food</a>' } },
  ] }, changes), [0]);
});

test("canonical URL is emitted only from a configured public route or verified published URL", () => {
  assert.equal(resolveCanonicalUrl({ siteUrl: "", slug: "guide" }).status, "unverified");
  assert.equal(resolveCanonicalUrl({ siteUrl: "https://solotochina.com", slug: "guide" }).url, "https://solotochina.com/guide/");
  const published = resolveCanonicalUrl({ siteUrl: "https://solotochina.com", slug: "old",
    publishedStatus: "publish", publishedUrl: "https://solotochina.com/confirmed-guide/?utm_source=test" });
  assert.equal(published.url, "https://solotochina.com/confirmed-guide/");
  assert.equal(resolveCanonicalUrl({ siteUrl: "https://solotochina.com", slug: "old",
    publishedStatus: "publish", publishedUrl: "https://solotochina.com/?p=7&preview=true" }).status, "configured_route");
});

test("unsupported title promises are rejected without treating length as a hard limit", () => {
  assert.deepEqual(titlePromiseRisks("The complete hidden Chongqing guide", { topic: "One night route" }, []), ["complete", "hidden"]);
  assert.deepEqual(titlePromiseRisks("A complete Chongqing guide", { topic: "A complete Chongqing guide" }, []), []);
});

test("SEO and structured data stay synchronized with visible page content", () => {
  const page = synchronizeSeoMetadata(basePage, baseDraft);
  const schema = synchronizeSchemaWithPage({ "@context": "https://schema.org", "@graph": [
    { "@type": "Article", headline: "Old" }, { "@type": "WebPage", "@id": "https://old.test/" },
  ] }, page, baseDraft);
  const checked = validateSeoGeoArtifact({ page, draft: baseDraft, schema });
  assert.equal(checked.valid, true);
  const article = schema["@graph"].find((node) => node["@type"] === "Article");
  assert.equal(article.headline, baseDraft.title);
  assert.equal(article.url, canonical);
  assert.equal(article.mainEntityOfPage["@id"], canonical);
  assert.equal(page.metadata.seo.robots, "noindex,nofollow");

  const bad = structuredClone(schema);
  bad["@graph"].find((node) => node["@type"] === "Article").headline = "All tickets are free";
  assert.ok(validateSeoGeoArtifact({ page, draft: baseDraft, schema: bad }).errors.some((item) => item.code === "SCHEMA_HEADLINE_MISMATCH"));
});

test("FAQ schema is optional and must exactly match the visible FAQ when present", () => {
  const noFaqPage = synchronizeSeoMetadata(basePage, baseDraft);
  const noFaqSchema = synchronizeSchemaWithPage({ "@context": "https://schema.org", "@graph": [{ "@type": "Article" }] }, noFaqPage, baseDraft);
  assert.equal(validateSeoGeoArtifact({ page: noFaqPage, draft: baseDraft, schema: noFaqSchema }).valid, true);
  const faqPage = { ...basePage, blocks: [...basePage.blocks, { type: "faq", variant: "default", data: {
    items: [{ question: "When should I go?", answer: "Go after sunset." }],
  } }] };
  const synchronizedPage = synchronizeSeoMetadata(faqPage, baseDraft);
  const schema = synchronizeSchemaWithPage(noFaqSchema, synchronizedPage, baseDraft);
  assert.equal(validateSeoGeoArtifact({ page: synchronizedPage, draft: baseDraft, schema }).valid, true);
  schema["@graph"].find((node) => node["@type"] === "FAQPage").mainEntity[0].acceptedAnswer.text = "Any time.";
  assert.ok(validateSeoGeoArtifact({ page: synchronizedPage, draft: baseDraft, schema }).errors.some((item) => item.code === "FAQ_SCHEMA_VISIBLE_MISMATCH"));
});

test("internal links use only relevant public inventory and invalid targets fail final checks", () => {
  const inventory = [
    { post_id: 7, status: "publish", title: "Chongqing transport", slug: "chongqing-transport", post_url: "https://solotochina.com/chongqing-transport", modified_at: "2026-01-01" },
    { post_id: 8, status: "draft", title: "Chongqing draft", slug: "chongqing-draft", post_url: "https://solotochina.com/?p=8&preview=true" },
    { post_id: 9, status: "publish", title: "Beijing food", slug: "beijing-food", post_url: "https://solotochina.com/beijing-food" },
  ];
  const links = selectInternalLinks(inventory, { siteUrl: "https://solotochina.com", topic: "Chongqing transport route" });
  assert.deepEqual(links.map((item) => item.post_id), [7]);
  assert.deepEqual(selectInternalLinks(inventory.filter((item) => item.status === "draft"), {
    siteUrl: "https://solotochina.com", topic: "Chongqing transport route",
  }), [], "an all-draft inventory is valid but produces no formal links");
  assert.match(inventoryVersion(inventory, "2026-09-10").hash, /^[a-f0-9]{64}$/);
  const page = synchronizeSeoMetadata({ ...basePage, blocks: [{ type: "paragraph", variant: "default",
    data: { content: '<a href="https://solotochina.com/missing/">Wrong target</a>' } }] }, baseDraft);
  assert.ok(validateSeoGeoArtifact({ page, draft: baseDraft,
    schema: synchronizeSchemaWithPage({ "@context": "https://schema.org", "@graph": [{ "@type": "Article" }] }, page, baseDraft),
    internalLinks: links }).errors.some((item) => item.code === "UNVERIFIED_INTERNAL_LINK"));

  const badAnchorPage = synchronizeSeoMetadata({ ...basePage, blocks: [{ type: "paragraph", variant: "default",
    data: { content: '<a href="https://solotochina.com/chongqing-transport/">click here</a>' } }] }, baseDraft);
  assert.ok(validateSeoGeoArtifact({ page: badAnchorPage, draft: baseDraft,
    schema: synchronizeSchemaWithPage({ "@context": "https://schema.org", "@graph": [{ "@type": "Article" }] }, badAnchorPage, baseDraft),
    internalLinks: links }).errors.some((item) => item.code === "INTERNAL_LINK_ANCHOR_MISMATCH"));

  const goodAnchorPage = synchronizeSeoMetadata({ ...basePage, blocks: [{ type: "paragraph", variant: "default",
    data: { content: '<a href="/chongqing-transport/">Chongqing transport options</a>' } }] }, baseDraft);
  assert.equal(validateSeoGeoArtifact({ page: goodAnchorPage, draft: baseDraft,
    schema: synchronizeSchemaWithPage({ "@context": "https://schema.org", "@graph": [{ "@type": "Article" }] }, goodAnchorPage, baseDraft),
    internalLinks: links }).valid, true);
});

test("duplicate inventory creates an editorial risk, never an automatic merge or canonical instruction", () => {
  const risks = duplicateContentRisks([{ post_id: 7, status: "publish", title: "Chongqing night guide", slug: "chongqing-night-guide",
    post_url: canonical }], { title: "Chongqing night route guide", entities: ["Chongqing"] });
  assert.equal(risks.length, 1);
  assert.match(risks[0].reason, /Editorial review is required/);
  assert.doesNotMatch(risks[0].reason, /delete|set canonical/i);
  assert.deepEqual(duplicateContentRisks([{ post_id: 8, status: "publish", title: "Chongqing hotpot ordering",
    slug: "chongqing-hotpot-ordering", post_url: "https://solotochina.com/chongqing-hotpot-ordering/" }],
  { title: "Chongqing night transport", entities: ["Chongqing"] }), [],
  "sharing an entity without the same topic does not trigger an automatic duplicate action");
});

test("Publish Package overwrites conflicting model metadata from one deterministic source", () => {
  const pkg = buildPublishPackage({ pagePayload: { ...basePage, metadata: { ...basePage.metadata,
    seo: { title: "Wrong", description: "Wrong", canonicalUrl: "https://wrong.test/" } } }, draft: baseDraft,
    contract: { contractVersion: "1.3.0", pageSchemaContractVersion: "1.3.0", checksum: "a".repeat(64) } });
  assert.equal(pkg.page.metadata.title, baseDraft.title);
  assert.equal(pkg.page.metadata.seo.title, baseDraft.seo.meta_title);
  assert.equal(pkg.page.metadata.seo.canonicalUrl, canonical);
  assert.equal(pkg.schema_jsonld["@graph"].some((node) => node["@type"] === "FAQPage"), false);
});
