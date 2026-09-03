import assert from "node:assert/strict";
import test from "node:test";
import {
  CommercialComposer, CommercialValidationError, normalizeAffiliateAsset,
  normalizeAffiliateProviderAccount, normalizeCommercialEvent, normalizeCommercialOffer,
  normalizeCommissionRule, resolveAffiliateAsset,
} from "../src/commercial.mjs";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";

test("commercial composition is a separate overlay and leaves the Research Draft unchanged", () => {
  const researchBody = "## Plan your visit\n\nUse the evidence-backed itinerary.";
  const contentPackage = {
    candidate: { topic_key: "beijing:first-time-solo-guide" },
    brief: { topic: "First-Time Beijing Solo Travel Guide" },
    draft: { title: "Beijing Solo Guide", body_markdown: researchBody },
  };
  const offer = normalizeCommercialOffer({
    provider: "Provider", externalId: "hotel-1", category: "hotels", destinationSlug: "beijing",
    title: "Beijing hotel options", targetUrl: "https://affiliate.example/hotels?city=beijing",
    description: "Compare stays for your dates.", ctaLabel: "View hotels",
  });
  const composition = new CommercialComposer({ maxOffersPerDraft: 3, disclosure: "Affiliate disclosure." }).compose(contentPackage, [{
    id: offer.id, provider: offer.provider, category: offer.category, title: offer.title,
    target_url: offer.targetUrl, cta_label: offer.ctaLabel, description: offer.description,
    price_text: offer.priceText, priority: offer.priority,
  }]);

  assert.equal(contentPackage.draft.body_markdown, researchBody);
  assert.equal(composition.status, "composed");
  assert.match(composition.publishableBodyMarkdown, /Optional booking resources/);
  assert.equal(composition.offerIds.length, 1);
});

test("commercial composer is a no-op when no relevant active offer exists", () => {
  const contentPackage = {
    candidate: { topic_key: "beijing:food" }, brief: { topic: "Beijing food" },
    draft: { title: "Where to eat", body_markdown: "Research body" },
  };
  const composition = new CommercialComposer({ maxOffersPerDraft: 3, disclosure: "Disclosure" }).compose(contentPackage, []);
  assert.equal(composition.status, "no_offers");
  assert.equal(composition.publishableBodyMarkdown, "Research body");
});

test("typed offer validation rejects unsafe links and unsupported categories", () => {
  assert.throws(() => normalizeCommercialOffer({
    provider: "Provider", externalId: "1", category: "hotels", destinationSlug: "beijing",
    title: "Hotel", targetUrl: "javascript:alert(1)",
  }), CommercialValidationError);
  assert.throws(() => normalizeCommercialOffer({
    provider: "Provider", externalId: "1", category: "casino", destinationSlug: "beijing",
    title: "Offer", targetUrl: "https://example.test",
  }), /Unsupported offer category/);
});

test("manual provider and asset registry keep display type separate from product category", (t) => {
  const { repository } = repositoryFixture(t);
  const provider = repository.upsertAffiliateProviderAccount(normalizeAffiliateProviderAccount({
    providerKey: "trip-com", displayName: "Trip.com", connectionMode: "MANUAL",
    siteName: "SoloToChina", defaultLanguage: "en", defaultDisclosure: "Affiliate disclosure.",
  }));
  const asset = repository.upsertAffiliateAsset(normalizeAffiliateAsset({
    providerAccountId: provider.id, provider: "Trip.com", assetType: "SEARCH_BOX", productCategory: "HOTEL",
    scopeType: "DESTINATION", scopeKey: "chongqing", destinationSlug: "chongqing", title: "Search Chongqing hotels",
    embedConfig: { embedType: "search_box", src: "https://affiliate.trip.com/search-box" },
  }));
  assert.equal(asset.asset_type, "SEARCH_BOX");
  assert.equal(asset.product_category, "HOTEL");
  assert.equal(repository.listAffiliateProviderAccounts()[0].active_asset_count, 1);
});

test("affiliate asset validation rejects unsafe URLs and arbitrary embed HTML", () => {
  const base = { providerAccountId: "provider-1", provider: "Trip.com", productCategory: "HOTEL", scopeType: "DESTINATION", scopeKey: "beijing", destinationSlug: "beijing", title: "Hotels" };
  assert.throws(() => normalizeAffiliateAsset({ ...base, assetType: "CATEGORY_LINK", targetUrl: "javascript:alert(1)" }), CommercialValidationError);
  assert.throws(() => normalizeAffiliateAsset({ ...base, assetType: "SEARCH_BOX", embedConfig: "<script>alert(1)</script>" }), /Raw HTML/);
  assert.throws(() => normalizeAffiliateAsset({ ...base, assetType: "DYNAMIC_BANNER", embedConfig: { embedType: "dynamic_banner", src: "https://evil.example/banner" } }), /allowlisted official domain/);
});

test("resolver follows intent specificity and falls back without creating low-value work", () => {
  const destinationHotel = { id: "asset-hotel", provider: "Trip.com", asset_type: "CATEGORY_LINK", product_category: "HOTEL", scope_type: "DESTINATION", scope_key: "chongqing", destination_slug: "chongqing", target_url: "https://trip.com/hotels/chongqing", active: 1, priority: 5 };
  const hotelReview = { intentType: "HOTEL_REVIEW", productCategory: "HOTEL", destinationSlug: "chongqing", entityKey: "hotel.example", areaKey: "", routeKey: "", scopeType: "ENTITY", scopeKey: "hotel.example" };
  const fallback = resolveAffiliateAsset(hotelReview, [destinationHotel]);
  assert.equal(fallback.matchedScope, "DESTINATION");
  assert.equal(fallback.exact, false);

  const routeAsset = { id: "asset-route", provider: "Trip.com", asset_type: "DEEP_LINK", product_category: "TRAIN", scope_type: "ROUTE", scope_key: "beijing-xian", route_key: "beijing-xian", target_url: "https://trip.com/trains/beijing-xian", active: 1 };
  const route = resolveAffiliateAsset({ intentType: "INTERCITY_TRANSPORT", productCategory: "TRAIN", destinationSlug: "beijing", routeKey: "beijing-xian", entityKey: "", areaKey: "" }, [routeAsset]);
  assert.equal(route.matchedScope, "ROUTE");
  assert.equal(route.exact, true);

  const attractionAsset = { id: "asset-attraction", provider: "Trip.com", asset_type: "DEEP_LINK", product_category: "ATTRACTION", scope_type: "ENTITY", scope_key: "attraction.forbidden_city", entity_key: "attraction.forbidden_city", target_url: "https://trip.com/attractions/forbidden-city", active: 1 };
  const attraction = resolveAffiliateAsset({ intentType: "ATTRACTION_GUIDE", productCategory: "ATTRACTION", destinationSlug: "beijing", entityKey: "attraction.forbidden_city", routeKey: "", areaKey: "" }, [attractionAsset]);
  assert.equal(attraction.matchedScope, "ENTITY");
  assert.equal(attraction.exact, true);
});

test("only high-value precision gaps create opportunities and density remains bounded", () => {
  const composer = new CommercialComposer({ maxOffersPerDraft: 3, maxContextualUnits: 2, maxEndResourceUnits: 1, minBlockDistance: 1, opportunityThreshold: 70, disclosure: "Disclosure" });
  const highValue = composer.compose({
    candidate: { topic_key: "beijing:forbidden-city-tickets" },
    brief: { destination_slug: "beijing", topic: "How to visit the Forbidden City", canonical: { entity_key: "attraction.forbidden_city" } },
    draft: { title: "How to visit the Forbidden City", body_markdown: "## Tickets\n\nHow to buy tickets and reserve your entry." },
  }, []);
  assert.equal(highValue.status, "no_offers");
  assert.equal(highValue.opportunities.length, 1);

  const lowValue = composer.compose({ candidate: { topic_key: "guangzhou:food" }, brief: { destination_slug: "guangzhou", topic: "Guangzhou food" }, draft: { title: "What to eat", body_markdown: "## Local food\n\nTry local dishes." } }, []);
  assert.equal(lowValue.opportunities.length, 0);
});

test("commercial event schema supports impression and click attribution", () => {
  for (const eventType of ["impression", "click"]) {
    const event = normalizeCommercialEvent({ eventType, provider: "Trip.com", category: "HOTEL", slotKey: "contextual:hotel:1", affiliateAssetId: "asset-1", destination: "chongqing", device: "mobile", locale: "en" }, "1.3");
    assert.equal(event.eventType, eventType);
    assert.equal(event.strategyVersion, "1.3");
  }
});

test("commission metadata is configurable commercial data rather than scoring code", (t) => {
  const { repository } = repositoryFixture(t);
  repository.upsertCommissionRule(normalizeCommissionRule({
    provider: "Trip.com", productCategory: "HOTEL", commissionModel: "percentage",
    effectiveRate: 0.04, validFrom: "2026-09-01T00:00:00.000Z", promotionMultiplier: 1.25,
  }));
  const rules = repository.listCommissionRules();
  assert.equal(rules.length, 1);
  assert.equal(rules[0].product_category, "HOTEL");
  assert.equal(rules[0].effective_rate, 0.04);
  assert.equal(rules[0].promotion_multiplier, 1.25);
});
