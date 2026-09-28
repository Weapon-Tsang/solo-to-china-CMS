import assert from "node:assert/strict";
import test from "node:test";
import { buildPublishPackage, synchronizeSchemaWithPage } from "../src/publish-page.mjs";
import {
  affectedInternalLinkBlocks, buildSeoPreview, duplicateContentRisks, inventoryTargetChanges,
  inventoryVersion, resolveCanonicalUrl, selectInternalLinks,
  synchronizeSeoMetadata, titlePromiseRisks, validateSeoGeoArtifact, suggestContentDisposition,
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
    { post_id: 7, status: "publish", title: "Chongqing transport", slug: "chongqing-transport", post_url: "https://solotochina.com/chongqing-transport/", modified_at: "2026-01-01" },
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
    internalLinks: links }).warnings.some((item) => item.code === "UNVERIFIED_INTERNAL_LINK"));

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

test('T03-12 visible FAQ is valid without optional markup, later conflicting markup fails', () => {
  const page = synchronizeSeoMetadata({ ...basePage, blocks: [{ type: 'faq', data: { items: [{ question: 'When?', answer: 'At sunset.' }] } }] }, baseDraft);
  const schema = [{ '@type': 'Article', headline: baseDraft.title }];
  assert.equal(validateSeoGeoArtifact({ page, draft: baseDraft, schema }).valid, true);
  const faq = { '@type': 'FAQPage', mainEntity: [{ name: 'When?', acceptedAnswer: { text: 'At sunset.' } }] };
  assert.equal(validateSeoGeoArtifact({ page, draft: baseDraft, schema: [...schema, faq] }).valid, true);
  assert.ok(validateSeoGeoArtifact({ page, draft: baseDraft, schema: [...schema, faq, { ...faq, mainEntity: [] }] }).errors.some(item => item.code === 'FAQ_SCHEMA_VISIBLE_MISMATCH'));
});

test('T03-08/10/13 query identities, later Article and local anchors remain distinct', () => {
  assert.equal(resolveCanonicalUrl({ siteUrl: 'https://solotochina.com', publishedStatus: 'publish', publishedUrl: 'https://solotochina.com/?p=73&page=2' }).url, 'https://solotochina.com/?p=73&page=2');
  const page = synchronizeSeoMetadata({ ...basePage, blocks: [{ type: 'paragraph', data: { content: '<a href="#transport">Transport</a>' } }] }, baseDraft);
  const schema = [{ '@type': 'Article', headline: baseDraft.title }];
  assert.equal(validateSeoGeoArtifact({ page, draft: baseDraft, schema }).valid, true);
  assert.ok(validateSeoGeoArtifact({ page, draft: baseDraft, schema: [...schema, { '@type': 'Article', headline: 'False' }] }).errors.some(item => item.code === 'SCHEMA_HEADLINE_MISMATCH'));
});

test('T03-13 unknown links are pending diagnostics, confirmed broken targets fail, contextual Read guide is valid', () => {
  const target = { post_id: 1, status: 'publish', title: 'Chongqing transport', url: 'https://solotochina.com/transport/', public_accessibility: 'confirmed' };
  const run = (content, inventory) => {
    const page = synchronizeSeoMetadata({ ...basePage, blocks: [{ type: 'paragraph', data: { content } }] }, baseDraft);
    return validateSeoGeoArtifact({ page, draft: baseDraft, schema: [{ '@type': 'Article', headline: baseDraft.title }], internalLinks: inventory });
  };
  assert.equal(run('<section><h2>Chongqing transport</h2><a href=/transport/>Read guide</a></section>', [target]).valid, true);
  assert.ok(run('<a href=/transport/>Read guide</a>', [target]).errors.some(item => item.code === 'INTERNAL_LINK_ANCHOR_MISMATCH'));
  const pending = run('<a href=/unknown/>Another guide</a>', []);
  assert.equal(pending.valid, true);
  assert.ok(pending.warnings.some(item => item.code === 'UNVERIFIED_INTERNAL_LINK'));
  assert.ok(run('<a href=/transport/>Chongqing transport</a>', [{ ...target, public_accessibility: 'broken' }]).errors.some(item => item.code === 'INTERNAL_LINK_TARGET_UNAVAILABLE'));
});

test('T03-13 entity identity ranks above title overlap and explicit unknown access is not selected', () => {
  const inventory = [
    { post_id: 1, status: 'publish', title: 'Airport rail', entities: ['airport-ckg'], post_url: 'https://solotochina.com/rail/' },
    { post_id: 2, status: 'publish', title: 'Chongqing transport route', post_url: 'https://solotochina.com/route/' },
    { post_id: 3, status: 'publish', title: 'Chongqing transport route', entities: ['airport-ckg'], public_accessibility: 'unknown', post_url: 'https://solotochina.com/unknown/' },
  ];
  const result = selectInternalLinks(inventory, { siteUrl: 'https://solotochina.com', topic: 'Chongqing transport route', entities: ['airport-ckg'] });
  assert.deepEqual(result.map(item => item.post_id), [1, 2]);
  assert.deepEqual(result[0].relationship.entity_ids, ['airport-ckg']);
});

test('T03-14 entity plus independent question controls advisory new/update/merge/claim decisions', () => {
  const article = { post_id: 1, status: 'publish', title: 'Almost identical title', entities: ['entity-1'], question: 'How to book?', post_url: canonical };
  const context = { entities: ['entity-1'], question: 'How to book?' };
  assert.equal(suggestContentDisposition([article], context).action, 'update');
  assert.equal(suggestContentDisposition([article, { ...article, post_id: 2 }], context).action, 'merge');
  assert.equal(suggestContentDisposition([article], { ...context, question: 'How to get there?' }).action, 'new');
  assert.equal(suggestContentDisposition([article], { ...context, evidenceSufficient: false }).action, 'keep-as-claim');
  assert.equal(suggestContentDisposition([article], { ...context, question: '' }).action, 'needs-review');
  assert.equal(suggestContentDisposition([article], context).automatic, false);
});

test('T03-08/15 internal CMS origins and private literal addresses cannot become public canonical metadata', () => {
  for (const siteUrl of ['http://localhost:3000', 'https://127.0.0.1', 'https://[::1]', 'https://10.1.2.3', 'https://cms.internal']) {
    assert.equal(resolveCanonicalUrl({ siteUrl, slug: 'guide' }).url, null, siteUrl);
  }
});

test('T03-09/10 schema arrays and nested BlogPosting consume CMS metadata without inventing author or time',()=>{
  const page=synchronizeSeoMetadata(basePage,baseDraft);
  const schema=synchronizeSchemaWithPage([{ '@graph':[{ '@type':['BlogPosting','Article'],'@id':'https://wrong.test/#article',headline:'Wrong',url:'https://wrong.test/' },
    {'@type':'WebPage','@id':'https://wrong.test/','mainEntity':{'@id':'https://wrong.test/#article'}}] },
    {'@type':'Organization','@id':'https://solotochina.com/#organization',name:'SoloToChina'}],page,baseDraft);
  const article=schema['@graph'][0]['@graph'][0];
  assert.equal(article.headline,baseDraft.title);assert.equal(article.url,canonical);
  assert.equal(article.author,undefined);assert.equal(article.datePublished,undefined);assert.equal(article.dateModified,undefined);
  assert.equal(schema['@graph'][0]['@graph'][1].mainEntity['@id'],`${canonical}#article`);
  assert.equal(schema['@graph'][1].name,'SoloToChina');
  assert.equal(validateSeoGeoArtifact({page,draft:baseDraft,schema}).valid,true);
});
