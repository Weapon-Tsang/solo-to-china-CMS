import assert from "node:assert/strict";
import test from "node:test";
import { buildPublishPackage, mediaReferences, mergeCommercialOverlay } from "../src/publish-page.mjs";

function commercial(component, placement, afterBlockIndex, assetType = "DEEP_LINK") {
  return {
    component, placement, after_block_index: afterBlockIndex, slot_key: `${placement}:${component}`,
    data: {
      affiliate_asset_id: `asset-${component}`, provider: "Trip.com", asset_type: assetType,
      product_category: "ATTRACTION", title: "Check current options", description: "Review current availability.",
      cta_label: "View options", target_url: "https://www.trip.com/", disclosure: "Affiliate link disclosure.",
      scope_type: "DESTINATION", scope_key: "chongqing",
    },
  };
}

test("commercial overlay preserves editorial blocks and exact Page Payload order", () => {
  const editorial = {
    metadata: { pageId: "draft-1", title: "Guide", slug: "guide", contentType: "city-guide" },
    blocks: [
      { type: "quick_answer", variant: "default", data: { answer: "Answer" } },
      { type: "warning", variant: "default", data: { title: "Warning", content: "Check access." } },
      { type: "faq", variant: "default", data: { items: [{ question: "When?", answer: "Before arrival." }] } },
      { type: "comparison_table", variant: "default", data: { caption: "Options", columns: ["Option", "Use"], rows: [["A", "B"]] } },
    ],
  };
  const before = structuredClone(editorial);
  const composition = {
    strategy_version: "1.3",
    commercial_blocks: [
      commercial("affiliate_booking_card", "contextual", 0),
      commercial("affiliate_promotion_card", "end_resource", 1, "PROMOTION"),
    ],
  };
  const merged = mergeCommercialOverlay(editorial, composition);
  assert.deepEqual(editorial, before);
  assert.deepEqual(merged.blocks.map((block) => block.type), [
    "quick_answer", "affiliate_booking_card", "warning", "faq", "comparison_table", "affiliate_promotion_card",
  ]);
  assert.deepEqual(merged.blocks.filter((block) => !block.type.startsWith("affiliate_")), before.blocks);
  assert.equal(merged.blocks[1].data.strategy_version, "1.3");
  assert.equal(merged.blocks[5].variant, "default");
});

test("structured affiliate search uses exactly one Frontend delivery representation", () => {
  const editorial = {
    metadata: { pageId: "draft-search", title: "Guide", slug: "guide", contentType: "city-guide" },
    blocks: [{ type: "paragraph", variant: "default", data: { content: "Editorial body." } }],
  };
  const search = commercial("affiliate_search_card", "contextual", 0, "SEARCH_BOX");
  search.data.target_url = "https://www.trip.com/hotels/";
  search.data.embed_config = {
    embed_type: "search_box", src: "https://www.trip.com/partners/search", width: 600, height: 240,
    language: "en", theme: "light", variant: "standard",
  };
  const result = mergeCommercialOverlay(editorial, { strategy_version: "1.3", commercial_blocks: [search] });
  assert.equal(result.blocks[1].variant, "search_box");
  assert.equal(result.blocks[1].data.target_url, undefined);
  assert.equal(result.blocks[1].data.embed_config.embed_type, "search_box");
});

test("Publish Package carries presentation, semantic SEO/GEO, JSON-LD, and WordPress media references", () => {
  const page = {
    metadata: {
      pageId: "draft-7", title: "Chongqing Guide", slug: "chongqing-guide", contentType: "city-guide",
      presentation: { article_hero: { variant: "attraction" }, share_this_page: true, table_of_contents: true },
    },
    blocks: [{ type: "paragraph", variant: "default", data: { content: "Editorial body." } }],
  };
  const draft = {
    id: "draft-7", title: "Chongqing Guide", meta_description: "Practical guide.", strategy_version: "1.3",
    seo: { meta_title: "Chongqing travel", focus_keyword: "Chongqing", secondary_keywords: ["China"], search_intent: "informational", ignored: "not sent" },
    schema_jsonld: { "@context": "https://schema.org", "@type": "Article" },
  };
  const media = mediaReferences([{
    id: "visual-1", wordpress_media_id: 41, wordpress_media_url: "https://solotochina.com/uploads/hero.jpg",
    alt_text: "Chongqing skyline", caption: "City view", placement: "hero", image_role: "hero",
  }]);
  const pkg = buildPublishPackage({
    pagePayload: page, draft, contract: { contractVersion: "1.1.0", pageSchemaContractVersion: "1.1.0", checksum: "a".repeat(64) }, media,
  });
  assert.deepEqual(Object.keys(pkg), ["contract", "page", "seo", "schema_jsonld", "media", "publication"]);
  assert.deepEqual(pkg.page.metadata.presentation, page.metadata.presentation);
  assert.equal(pkg.page.metadata.featuredMediaId, 41);
  assert.equal(pkg.seo.meta_title, "Chongqing travel");
  assert.equal("ignored" in pkg.seo, false);
  assert.equal(pkg.schema_jsonld["@type"], "Article");
  assert.deepEqual(pkg.media[0], {
    media_id: 41, url: "https://solotochina.com/uploads/hero.jpg", alt: "Chongqing skyline",
    caption: "City view", role: "featured", placement: "hero",
  });
  assert.deepEqual(pkg.publication, { status: "draft", existing_post_id: null, cms_draft_id: "draft-7" });
});
