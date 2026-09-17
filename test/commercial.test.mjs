import assert from "node:assert/strict";
import test from "node:test";
import {
  CommercialComposer, CommercialValidationError, normalizeAffiliateAsset,
  normalizeAffiliateProviderAccount, normalizeCommercialEvent, normalizeCommercialOffer,
  normalizeCommissionRule, resolveAffiliateAsset,
  detectCommercialIntents, normalizeCountryCode, projectVisibleBlockText,
} from "../src/commercial.mjs";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";
import { loadConfig } from "../src/config.mjs";

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

test("a destination-planning demand with no configured asset is reported explicitly", () => {
  const contentPackage = {
    candidate: { topic_key: "beijing:food" }, brief: { topic: "Beijing food" },
    draft: { title: "Where to eat", body_markdown: "Research body" },
  };
  const composition = new CommercialComposer({ maxOffersPerDraft: 3, disclosure: "Disclosure" }).compose(contentPackage, []);
  assert.equal(composition.status, "no_offers");
  assert.equal(composition.publishableBodyMarkdown, "Research body");
  assert.equal(composition.outcome, "asset_not_configured");
});

test("a city guide can use one real destination planning resource without booking words or a link-task score", () => {
  const contentPackage = {
    candidate:{ destination_slug:"chongqing", topic_key:"chongqing:three-day-itinerary" },
    brief:{ destination_slug:"chongqing", content_type:"itinerary", canonical:{ country_code:"CN" } },
    draft:{ id:"draft-plan", title:"Three days in Chongqing", body_markdown:"## Day one\n\nStart downtown and keep the route compact." },
  };
  const asset = {
    id:"planner-chongqing", provider:"Trip.com", asset_type:"CATEGORY_LINK", product_category:"PLANNER",
    scope_type:"DESTINATION", scope_key:"chongqing", destination_slug:"chongqing", active:1,
    provider_status:"CONFIGURED", lifecycle_state:"operational", language:"en",
    target_url:"https://www.trip.com/guide/destination/chongqing-158/", title:"Plan a Chongqing trip",
    cta_label:"Explore planning resources",
  };
  const configured = loadConfig({}).commercial;
  assert.equal(configured.policy.version, "2.1");
  assert.equal(configured.linkTaskThreshold, 70);
  const composition = new CommercialComposer(configured).compose(contentPackage, [asset]);
  assert.equal(composition.outcome, "inserted");
  assert.equal(composition.slots.length, 1);
  assert.equal(composition.slots[0].placement, "end_resource");
  assert.equal(composition.slots[0].affiliate_asset_id, "planner-chongqing");
});

test("destination planning intent persists when its explanation is carried by relevanceReason", (t) => {
  const { repository, db } = repositoryFixture(t);
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at)
    VALUES ('brief-planner-persist','chongqing','Three days in Chongqing','[]','informational','ready','now','now')`).run();
  db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at,revision,content_hash)
    VALUES ('draft-planner-persist','brief-planner-persist','Three days in Chongqing','three-days-chongqing','Body','{}','ready_for_wordpress','now','now',1,'planner-hash')`).run();
  const composition = new CommercialComposer().compose({
    candidate:{ destination_slug:"chongqing", topic_key:"chongqing:essentials" },
    brief:{ destination_slug:"chongqing", content_type:"city_guide", canonical:{ country_code:"CN" } },
    draft:{ id:"draft-planner-persist", title:"Chongqing essentials", body_markdown:"## Start downtown\n\nKeep the route compact." },
  }, []);
  assert.doesNotThrow(() => repository.saveCommercialComposition("draft-planner-persist", composition));
  const saved = db.prepare("SELECT reason FROM commercial_intents WHERE draft_id=? AND block_key='destination-planning-resource'").get("draft-planner-persist");
  assert.match(saved.reason, /destination-level planning resource/i);
});

test("visible-text projection reads Contract list.data.items without scanning URLs or metadata", () => {
  const block = { type:"list", variant:"unordered", data:{ items:["Book a train from Chongqing to Chengdu"],
    target_url:"https://example.test/hotel", internal_id:"attraction-ticket" } };
  assert.equal(projectVisibleBlockText(block), "Book a train from Chongqing to Chengdu");
  const intents = detectCommercialIntents({ candidate:{ destination_slug:"chongqing" }, brief:{ canonical:{ country_code:"CN" } },
    draft:{ id:"draft-list", title:"Rail guide" }, frontend_page:{ provenance:{ entries:[{ contentNodeId:"node-rail" }] } } }, [block]);
  assert.deepEqual(intents.map((item) => item.productCategory), ["TRAIN","PLANNER"]);
  assert.equal(intents[0].blockKey, "node:node-rail");
});

test("COUNTRY fallback compares normalized country codes rather than a city scope key", () => {
  assert.equal(normalizeCountryCode("Mainland China"), "CN");
  const intent = { intentType:"DESTINATION_GUIDE", productCategory:"HOTEL", destinationSlug:"chongqing",
    countryCode:"CN", scopeType:"DESTINATION", scopeKey:"chongqing" };
  const china = { id:"china", product_category:"HOTEL", scope_type:"COUNTRY", scope_key:"China", country_code:"CN",
    provider_status:"CONFIGURED", lifecycle_state:"operational", active:1, target_url:"https://www.trip.com/hotels/" };
  const us = { ...china, id:"us", scope_key:"US", country_code:"US" };
  assert.equal(resolveAffiliateAsset(intent, [us, china]).asset.id, "china");
});

test("a real commercial demand with no eligible asset is asset_not_configured, not a successful insertion", () => {
  const composition = new CommercialComposer().compose({ candidate:{ destination_slug:"chongqing" },
    brief:{ destination_slug:"chongqing", canonical:{ country_code:"CN" } },
    draft:{ id:"draft-gap", title:"Where to stay", body_markdown:"## Where to stay\n\nCompare hotel areas before booking." } }, []);
  assert.equal(composition.status, "no_offers");
  assert.equal(composition.outcome, "asset_not_configured");
  assert.equal(composition.reasonCode, "ASSET_NOT_CONFIGURED");
  assert.equal(composition.manifest.slots.length, 0);
});

test("commercial empty outcomes distinguish no demand, rejected inventory, and density suppression", () => {
  const noDemand=new CommercialComposer().compose({candidate:{destination_slug:"chongqing"},brief:{destination_slug:"chongqing"},
    draft:{id:"draft-none",title:"A historical essay",body_markdown:"## Context\n\nA purely historical discussion."}},[]);
  assert.equal(noDemand.outcome,"intentional_noop");

  const base={id:"planner",provider:"Trip.com",asset_type:"CATEGORY_LINK",product_category:"PLANNER",scope_type:"DESTINATION",
    scope_key:"chongqing",destination_slug:"chongqing",target_url:"https://www.trip.com/guide/destination/chongqing-158/",
    title:"Plan Chongqing",cta_label:"Plan",active:1,lifecycle_state:"operational",language:"en"};
  const pack={candidate:{destination_slug:"chongqing",topic_key:"chongqing:guide"},brief:{destination_slug:"chongqing",content_type:"city_guide"},
    draft:{id:"draft-outcomes",title:"Chongqing guide",body_markdown:"## Start\n\nUse this guide."}};
  assert.equal(new CommercialComposer().compose(pack,[{...base,provider_status:"DISABLED"}]).outcome,"eligibility_rejected");
  assert.equal(new CommercialComposer({maxEndResourceUnits:0}).compose(pack,[{...base,provider_status:"CONFIGURED"}]).outcome,
    "density_or_duplicate_suppressed");
});

test("metro station wording alone does not create an intercity train intent", () => {
  const intents = detectCommercialIntents({ candidate:{ destination_slug:"chongqing" }, brief:{},
    draft:{ id:"draft-metro", title:"Metro exits" } }, [{ type:"paragraph", data:{ content:"Use Xiaoshizi metro station Exit 9." } }]);
  assert.equal(intents.some((item) => item.productCategory === "TRAIN"), false);
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

test("destination inventory recalls an operational asset through active mappings and provider state", (t) => {
  const { repository, db } = repositoryFixture(t);
  const provider = repository.upsertAffiliateProviderAccount(normalizeAffiliateProviderAccount({
    providerKey:"trip-com", displayName:"Trip.com", status:"CONFIGURED",
  }));
  const asset = repository.upsertAffiliateAsset(normalizeAffiliateAsset({ providerAccountId:provider.id, provider:"Trip.com",
    assetType:"CATEGORY_LINK", productCategory:"HOTEL", scopeType:"COUNTRY", scopeKey:"China", countryCode:"CN",
    title:"China hotels", targetUrl:"https://www.trip.com/hotels/" }));
  db.prepare("UPDATE affiliate_asset_mappings SET destination_slug='chongqing' WHERE affiliate_asset_id=?").run(asset.id);
  const inventory = repository.activeOffersForDestination("chongqing");
  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].scope_key, "CN");
  assert.equal(inventory[0].provider_status, "CONFIGURED");
});

test("destination scope_key without destinationSlug is normalized and recalled", (t) => {
  const { repository } = repositoryFixture(t);
  const provider = repository.upsertAffiliateProviderAccount(normalizeAffiliateProviderAccount({
    providerKey:"trip-destination", displayName:"Trip.com", status:"CONFIGURED",
  }));
  const normalized=normalizeAffiliateAsset({ providerAccountId:provider.id,provider:"Trip.com",assetType:"CATEGORY_LINK",
    productCategory:"HOTEL",scopeType:"DESTINATION",scopeKey:"Chongqing",title:"Chongqing hotels",
    targetUrl:"https://www.trip.com/hotels/chongqing" });
  assert.equal(normalized.destinationSlug,"chongqing");
  const asset=repository.upsertAffiliateAsset(normalized);
  assert.deepEqual(repository.activeOffersForDestination("chongqing").map((item)=>item.id),[asset.id]);
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
  assert.ok(highValue.opportunities[0].score >= 70);
  assert.equal(highValue.opportunities[0].queueEligible, true);

  const lowValue = composer.compose({ candidate: { topic_key: "guangzhou:food" }, brief: { destination_slug: "guangzhou", topic: "Guangzhou food" }, draft: { title: "What to eat", body_markdown: "## Local food\n\nTry local dishes." } }, []);
  assert.equal(lowValue.opportunities.length, 0);
});

test("cold-start destination gaps use observed intent signals and keep 70 as only the link-task threshold", () => {
  const pack={candidate:{topic_key:"chongqing:where-to-stay"},
    brief:{destination_slug:"chongqing",topic:"Where to stay in Chongqing"},
    draft:{id:"draft-cold-start",title:"Where to stay in Chongqing",body_markdown:"## Where to stay\n\nCompare hotel areas before booking."}};
  const composition=new CommercialComposer({linkTaskThreshold:70}).compose(pack,[]);
  assert.equal(composition.opportunities.length,1);
  assert.ok(composition.opportunities[0].score>=70);
  assert.equal(composition.opportunities[0].queueEligible,true);
  assert.equal(composition.opportunities[0].factors.trafficPotential,null);
  assert.equal(composition.opportunities[0].factors.expectedRevenueUplift,null);

  const visibleBelowTaskThreshold=new CommercialComposer({linkTaskThreshold:100}).compose(pack,[]);
  assert.equal(visibleBelowTaskThreshold.opportunities.length,1,
    "an asset gap remains visible even when it does not qualify for an automatic link task");
  assert.equal(visibleBelowTaskThreshold.opportunities[0].queueEligible,false);
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
