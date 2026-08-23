import assert from "node:assert/strict";
import test from "node:test";
import { CommercialComposer, CommercialValidationError, normalizeCommercialOffer } from "../src/commercial.mjs";

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
