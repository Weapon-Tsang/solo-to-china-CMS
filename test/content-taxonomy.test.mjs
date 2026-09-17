import assert from "node:assert/strict";
import test from "node:test";
import { FRONTEND_GUIDE_TYPES, isFrontendGuideType, normalizeFrontendPageForDelivery,
  normalizeFrontendPageTaxonomy, normalizeWordPressInlineHtml, toFrontendGuideType } from "../src/content-taxonomy.mjs";

const INTERNAL_TYPES = [
  "city_guide", "itinerary", "attraction_guide", "food_guide", "transport_guide",
  "neighborhood_guide", "hotel_area_guide", "shopping_guide", "practical_guide",
  "first_time_guide", "comparison", "listicle", "how_to",
];

test("every supported CMS content type maps to the WordPress guide taxonomy", () => {
  assert.deepEqual(FRONTEND_GUIDE_TYPES, ["survival-kit", "city-guide", "attraction-guide", "travel-guide"]);
  for (const type of INTERNAL_TYPES) assert.equal(isFrontendGuideType(toFrontendGuideType(type)), true, type);
  assert.equal(toFrontendGuideType("itinerary"), "travel-guide");
  assert.equal(toFrontendGuideType("food_guide"), "city-guide");
  assert.equal(toFrontendGuideType("unknown_type"), "unknown_type");
});

test("delivery normalization uses the exact safe entity form preserved by WordPress", () => {
  const page = { metadata:{ title:"Traveler&#39;s route", contentType:"itinerary" },
    blocks:[{ type:"paragraph", data:{ content:"Traveler&#39;s route" } }] };
  const normalized = normalizeFrontendPageForDelivery(page);
  assert.equal(normalized.metadata.title, "Traveler&#039;s route");
  assert.equal(normalized.blocks[0].data.content, "Traveler&#039;s route");
  assert.equal(normalized.metadata.contentType, "travel-guide");
  assert.equal(page.blocks[0].data.content, "Traveler&#39;s route");
  assert.equal(normalizeWordPressInlineHtml("Traveler&apos;s route"), "Traveler&#039;s route");
});

test("page taxonomy normalization preserves the stored artifact and uses its canonical fallback", () => {
  const stored = { metadata:{ title:"Route", contentType:"itinerary" }, blocks:[{ type:"paragraph", data:{ content:"Answer" } }] };
  const normalized = normalizeFrontendPageTaxonomy(stored);
  assert.notEqual(normalized, stored);
  assert.equal(normalized.metadata.contentType, "travel-guide");
  assert.equal(stored.metadata.contentType, "itinerary");

  const missing = normalizeFrontendPageTaxonomy({ metadata:{ title:"Route" }, blocks:[] }, "transport_guide");
  assert.equal(missing.metadata.contentType, "survival-kit");
});
