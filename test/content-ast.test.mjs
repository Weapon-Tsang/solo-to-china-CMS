import assert from "node:assert/strict";
import test from "node:test";
import { buildContentAst, composeFirstTimeGuideFromAst, composePageFromAst, renderContentAstMarkdown } from "../src/content-blocks.mjs";
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
