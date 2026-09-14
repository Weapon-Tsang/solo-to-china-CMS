import assert from "node:assert/strict";
import test from "node:test";
import { buildContentAst, composeFirstTimeGuideFromAst, composePageFromAst, reconcileContentAstLedger, renderContentAstMarkdown } from "../src/content-blocks.mjs";
import { validateJsonSchema } from "../src/frontend-contract.mjs";
import { synchronizeSchemaWithPage } from "../src/publish-page.mjs";
import { synchronizeSeoMetadata, validateSeoGeoArtifact } from "../src/seo-geo.mjs";

const markdown = "## Quick answer\n\nThe museum costs CNY 50 on weekdays.\n\n- Carry the reservation passport\n- Arrive before the timed entry\n\n## Frequently asked questions\n\nCan I buy at the door? Do not rely on same-day availability.";
const draft = {
  title: "Museum first-time guide", slug: "museum-first-time-guide",
  meta_description: "An evidence-bounded guide to the museum ticket and timed entry.",
  body_markdown: markdown,
  evidence_ledger: [
    { section_id: "section_quick", section: "Quick answer", content_node_ids: ["node_quick"], claim_keys: ["museum.ticket.price"], source_ids: ["source-1"] },
    { section_id: "section_faq", section: "Frequently asked questions", content_node_ids: ["node_faq"], claim_keys: ["museum.ticket.availability"], source_ids: ["source-1"] },
  ],
  seo: { meta_title: "Museum first-time guide", canonical_url: "https://solotochina.com/museum-first-time-guide/",
    focus_keyword: "museum first-time guide", faqs: [{ question: "Can I buy at the door?", answer: "Do not rely on same-day availability." }] },
  faqs: [{ question: "Can I buy at the door?", answer: "Do not rely on same-day availability." }],
};
const articleSection = (variants) => ({ id: "articleSection", status: "stable", variants,
  schema: { properties: { heading: { type: "string" }, body: { type: "string" } } } });
const faqList = { id: "faqList", status: "stable", variants: ["default"], schema: { properties: { items: { type: "array" } } } };
const pageSchema = { properties: { metadata: { properties: { title: {}, pageId: {}, slug: {}, contentType: {}, excerpt: {} } } } };

test("first-time guide Content AST freezes visible text, evidence references, FAQ, SEO summary and media references", () => {
  const ast = buildContentAst({ draft, brief: { id: "brief-1", content_type: "first_time_guide" },
    visuals: [{ id: "visual-1", image_role: "evidence", alt_text: "Museum entrance", wordpress_media_id: 71 }] });
  assert.equal(renderContentAstMarkdown(ast), markdown);
  assert.equal(ast.summary, draft.meta_description);
  assert.deepEqual(ast.faq, draft.faqs);
  assert.deepEqual(ast.nodes.find((node) => node.id === "node_quick").fact_refs, ["museum.ticket.price"]);
  assert.equal(ast.media[0].media_id, 71);
  assert.match(ast.content_hash, /^[a-f0-9]{64}$/);
});

test("component variant changes do not rewrite AST facts and FAQ/schema use the same frozen source", () => {
  const ast = buildContentAst({ draft, brief: { id: "brief-1", content_type: "first_time_guide" } });
  const defaultPage = composeFirstTimeGuideFromAst(ast, { components: [articleSection(["default"]), faqList] }, pageSchema);
  const answerPage = composeFirstTimeGuideFromAst(ast, { components: [faqList, articleSection(["answer-first", "default"])] }, pageSchema);
  assert.equal(defaultPage.model, "deterministic-content-ast-compat-1");
  assert.equal(defaultPage.output.blocks[0].data.body, answerPage.output.blocks[0].data.body);
  assert.equal(answerPage.output.blocks[0].variant, "answer-first");
  assert.deepEqual(answerPage.output.blocks.find((block) => block.type === "faqList").data.items, ast.faq);
  const page = synchronizeSeoMetadata(answerPage.output, draft);
  const schema = synchronizeSchemaWithPage({ "@context": "https://schema.org", "@graph": [{ "@type": "Article" }] }, page, draft);
  assert.equal(validateSeoGeoArtifact({ page, draft, schema }).valid, true);
  assert.deepEqual(schema["@graph"].find((node) => node["@type"] === "FAQPage").mainEntity.map((item) => ({
    question: item.name, answer: item.acceptedAnswer.text,
  })), ast.faq);
});

test("unsupported content types or missing Registry capabilities use the existing explicit fallback", () => {
  const ast = buildContentAst({ draft, brief: { id: "brief-1", content_type: "first_time_guide" } });
  assert.equal(composeFirstTimeGuideFromAst(ast, { components: [] }, pageSchema), null);
  assert.equal(composeFirstTimeGuideFromAst({ ...ast, content_type: "itinerary" }, { components: [articleSection(["default"])] }, pageSchema), null);
});

test("production atomic components compose every content type without a model or invented component IDs", () => {
  const ast = buildContentAst({
    draft,
    brief: { id: "brief-itinerary", content_type: "itinerary" },
  });
  const components = [
    { id: "heading", status: "stable", variants: ["section", "subsection"], schema: {
      properties: { text: { type: "string" }, level: { type: "integer" } },
    } },
    { id: "paragraph", status: "stable", variants: ["default"], schema: {
      properties: { content: { type: "string" } },
    } },
    { id: "list", status: "stable", variants: ["unordered", "ordered"], schema: {
      properties: { items: { type: "array" } },
    } },
    { id: "faq", status: "stable", variants: ["default"], schema: {
      properties: { items: { type: "array" } },
    } },
  ];
  const blockSchema = (type, variant, data) => ({
    type: "object", additionalProperties: false, required: ["type", "variant", "data"],
    properties: { type: { const: type }, variant: { enum: variant }, data },
  });
  const productionPageSchema = {
    type: "object", additionalProperties: false, required: ["metadata", "blocks"],
    properties: {
      metadata: { type: "object", additionalProperties: false,
        required: ["pageId", "title", "slug", "contentType"], properties: {
          pageId: { type: "string" }, title: { type: "string" }, slug: { type: "string" },
          contentType: { type: "string" }, excerpt: { type: "string" },
        } },
      blocks: { type: "array", items: { oneOf: [
        blockSchema("heading", ["section", "subsection"], { type: "object", additionalProperties: false,
          required: ["text", "level"], properties: { text: { type: "string" }, level: { type: "integer", enum: [2, 3] } } }),
        blockSchema("paragraph", ["default"], { type: "object", additionalProperties: false,
          required: ["content"], properties: { content: { type: "string", contentMediaType: "text/html" } } }),
        blockSchema("list", ["unordered", "ordered"], { type: "object", additionalProperties: false,
          required: ["items"], properties: { items: { type: "array", minItems: 1, items: { type: "string" } } } }),
        blockSchema("faq", ["default"], { type: "object", additionalProperties: false,
          required: ["items"], properties: { items: { type: "array", minItems: 1, items: { type: "object",
            required: ["question", "answer"], properties: { question: { type: "string" }, answer: { type: "string" } } } } } }),
      ] } },
    },
  };

  const page = composePageFromAst(ast, { components }, productionPageSchema);
  assert.equal(page.model, "deterministic-content-ast-compat-2");
  assert.deepEqual([...new Set(page.output.blocks.map((block) => block.type))], ["heading", "paragraph", "list", "faq"]);
  assert.equal(page.output.blocks.some((block) => block.type === "articleSection"), false);
  assert.equal(page.output.metadata.contentType, "itinerary");
  assert.equal(page.provenance.entries.length, page.output.blocks.length);
  assert.deepEqual(validateJsonSchema(page.output, productionPageSchema), []);
});

test("an unlisted section does not inherit the previous section evidence and ordered lists stay ordered", () => {
  const ast = buildContentAst({
    draft: { ...draft, body_markdown: "## Supported\n\nFact.\n\n## Editorial note\n\n1. First\n2. Second",
      evidence_ledger: [{ section_id: "supported", section: "Supported", claim_keys: ["museum.ticket.price"], source_ids: ["source-1"] }] },
    brief: { id: "brief-no-inheritance", content_type: "first_time_guide" },
  });
  const editorialList = ast.nodes.find((node) => node.type === "list");
  assert.equal(editorialList.ordered, true);
  assert.deepEqual(editorialList.fact_refs, []);
  assert.deepEqual(editorialList.source_section_ids, []);
  assert.match(renderContentAstMarkdown(ast), /1\. First\n2\. Second/);
});

test("media placements become stable AST nodes with retained source references", () => {
  const ast = buildContentAst({ draft, brief: { id: "brief-media", content_type: "first_time_guide" }, visuals: [{
    id: "visual-real", placement: "after_intro", image_role: "evidence", alt_text: "Museum entrance",
    caption: "Entrance sign", source_asset_id: "asset-original", wordpress_media_id: 91, factual_image_required: true,
  }] });
  const mediaNode = ast.nodes.find((node) => node.type === "media");
  assert.equal(mediaNode.source_asset_id, "asset-original");
  assert.equal(mediaNode.media_id, 91);
  assert.deepEqual(mediaNode.media_refs, ["visual-real"]);
  assert.equal(renderContentAstMarkdown(ast), markdown);
});

test("a stable image component consumes AST media without flattening the surrounding article", () => {
  const ast = buildContentAst({ draft, brief: { id: "brief-image-component", content_type: "first_time_guide" }, visuals: [{
    id: "visual-delivered", placement: "after_intro", image_role: "evidence", alt_text: "Museum entrance",
    caption: "Entrance", wordpress_media_id: 88, source_asset_id: "asset-88", factual_image_required: true,
  }] });
  const components = [
    { id: "heading", status: "stable", variants: ["section"], schema: { properties: { text: {}, level: {} } } },
    { id: "paragraph", status: "stable", variants: ["default"], schema: { properties: { content: {} } } },
    { id: "list", status: "stable", variants: ["unordered", "ordered"], schema: { properties: { items: {} } } },
    { id: "image", category: "media", status: "stable", variants: ["evidence", "default"], schema: {
      properties: { media_id: {}, alt: {}, caption: {} },
    } },
  ];
  const page = composePageFromAst(ast, { components }, pageSchema);
  const imageBlock = page.output.blocks.find((block) => block.type === "image");
  assert.equal(imageBlock.data.media_id, 88);
  assert.equal(imageBlock.data.alt, "Museum entrance");
  assert.ok(page.output.blocks.some((block) => block.type === "paragraph"));
});

test("atomic AST assigns a claim only to the block that carries its fact and reconciles ledger node ids", () => {
  const scopedDraft = { ...draft,
    body_markdown: "### Tickets\n\nBuy online before arrival.\n\nAdmission costs CNY 50 on weekdays.\n\nUse the east entrance.",
    evidence_ledger: [{ section_id: "section_ticket", section: "Tickets",
      content_node_ids: ["node_old_one", "node_old_two", "node_unused"],
      claim_keys: ["museum.ticket.price"], source_ids: ["source-1"] }],
  };
  const facts = [{ normalized_key: "museum.ticket.price", subject: "Museum admission",
    preferred_value: "CNY 50", evidence: [{ source_id: "source-1", value: "CNY 50", qualifiers: ["weekdays"] }] }];
  const ast = buildContentAst({ draft: scopedDraft, brief: { id: "brief-scoped" }, facts });
  const prose = ast.nodes.filter((node) => node.type === "paragraph");
  assert.deepEqual(prose.map((node) => node.fact_refs.length), [0, 1, 0]);
  assert.equal(prose[1].fact_refs[0], "museum.ticket.price");
  const reconciled = reconcileContentAstLedger(ast, scopedDraft.evidence_ledger);
  assert.deepEqual(reconciled[0].content_node_ids, [prose[1].id]);
  assert.ok(reconciled[0].content_node_ids.every((id) => ast.nodes.some((node) => node.id === id)));
});

test("compact values and meaningful predicate phrases select the factual paragraph instead of a nearby subject mention", () => {
  const scopedDraft = { ...draft,
    body_markdown: "## Line 1\n\nLine 1 connects Hongyadong with downtown.\n\nHongyadong is open 24/7. Take Metro Line 1 to Xiaoshizi Station.",
    evidence_ledger: [{ section_id:"line-one", section:"Line 1", claim_keys:["hongyadong.hours", "hongyadong.metro"], source_ids:["source-1"] }],
  };
  const facts = [
    { normalized_key:"hongyadong.hours", subject:"Hongyadong", predicate:"opening_hours", preferred_value:"24/7",
      evidence:[{ source_id:"source-1", value:"24/7", qualifiers:[] }] },
    { normalized_key:"hongyadong.metro", subject:"Hongyadong", predicate:"nearest_metro_station", preferred_value:"小什字站 (Line 1)",
      evidence:[{ source_id:"source-1", value:"小什字站", qualifiers:["Line 1"] }] },
  ];
  const ast = buildContentAst({ draft:scopedDraft, brief:{ id:"brief-compact" }, facts });
  const prose = ast.nodes.filter((node) => node.type === "paragraph");
  assert.deepEqual(prose[0].fact_refs, []);
  assert.deepEqual(new Set(prose[1].fact_refs), new Set(["hongyadong.hours", "hongyadong.metro"]));
});

test("generic workflow qualifiers never project an unmatched claim onto an arbitrary paragraph", () => {
  const scopedDraft = { ...draft, body_markdown:"## Day 1\n\nDay 1 stays inside Yuzhong District.",
    evidence_ledger:[{ section_id:"day-one", section:"Day 1", claim_keys:["route.walk.duration"], source_ids:["source-1"] }] };
  const facts = [{ normalized_key:"route.walk.duration", subject:"山城步道到解放碑路线", predicate:"typical_duration_minutes",
    preferred_value:"< 120", evidence:[{ source_id:"source-1", value:"< 120", qualifiers:["walking", "community_estimate"] }] }];
  const ast = buildContentAst({ draft:scopedDraft, brief:{ id:"brief-unmatched" }, facts });
  assert.deepEqual(ast.nodes.find((node) => node.type === "paragraph").fact_refs, []);
  assert.deepEqual(reconcileContentAstLedger(ast, scopedDraft.evidence_ledger)[0].content_node_ids, []);
});

test("draft ledger reconciliation drops planned facts that visible prose never asserts", () => {
  const scopedDraft = { ...draft, body_markdown: "## Tickets\n\nAdmission is free.", evidence_ledger: [{
    section_id: "tickets", section: "Tickets", content_node_ids: [],
    claim_keys: ["museum.fee", "museum.hours"], source_ids: ["fee-source", "hours-source"],
  }] };
  const facts = [
    { normalized_key: "museum.fee", subject: "Museum", predicate: "admission_fee", preferred_value: "CNY 0",
      evidence: [{ source_id: "fee-source", value: "CNY 0" }] },
    { normalized_key: "museum.hours", subject: "Museum", predicate: "opening_hours", preferred_value: "09:00-17:00",
      evidence: [{ source_id: "hours-source", value: "09:00-17:00" }] },
  ];
  const ast = buildContentAst({ draft: scopedDraft, brief: { id: "brief-ledger" }, facts });
  const [entry] = reconcileContentAstLedger(ast, scopedDraft.evidence_ledger);
  assert.deepEqual(entry.claim_keys, ["museum.fee"]);
  assert.deepEqual(entry.source_ids, ["fee-source"]);
  assert.equal(entry.content_node_ids.length, 1);
});

test("answer-first prose before the first H2 belongs to the first planned evidence section", () => {
  const scopedDraft = { ...draft, body_markdown: "Admission is free.\n\n## Route\n\nTake the signed exit.", evidence_ledger: [
    { section_id: "answer", section: "Quick answer", content_node_ids: [], claim_keys: ["museum.fee"], source_ids: ["fee-source"] },
    { section_id: "route", section: "Route", content_node_ids: [], claim_keys: [], source_ids: [] },
  ] };
  const facts = [{ normalized_key: "museum.fee", subject: "Museum", predicate: "admission_fee", preferred_value: "CNY 0",
    evidence: [{ source_id: "fee-source", value: "CNY 0" }] }];
  const ast = buildContentAst({ draft: scopedDraft, brief: { id: "brief-intro" }, facts });
  const [entry] = reconcileContentAstLedger(ast, scopedDraft.evidence_ledger);
  assert.deepEqual(entry.claim_keys, ["museum.fee"]);
  assert.equal(ast.nodes.find((node) => node.type === "paragraph").source_section_ids[0], "answer");
});

test("a subject mention without its protected numeric value does not assert the fee fact", () => {
  const scopedDraft = { ...draft, body_markdown: "## Buses\n\nPublic buses run on surface roads.", evidence_ledger: [{
    section_id: "buses", section: "Buses", content_node_ids: [], claim_keys: ["bus.fare"], source_ids: ["fare-source"],
  }] };
  const facts = [{ normalized_key: "bus.fare", subject: "Public buses", predicate: "fare", preferred_value: "CNY 2",
    evidence: [{ source_id: "fare-source", value: "CNY 2" }] }];
  const ast = buildContentAst({ draft: scopedDraft, brief: { id: "brief-fee" }, facts });
  assert.deepEqual(reconcileContentAstLedger(ast, scopedDraft.evidence_ledger)[0].claim_keys, []);
});
