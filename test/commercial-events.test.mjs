import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeAffiliateAsset, normalizeAffiliateProviderAccount, normalizeCommercialEvent, CommercialValidationError,
} from "../src/commercial.mjs";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";

test("clicks cannot carry revenue and unknown conversion data stays unknown", (t) => {
  assert.throws(() => normalizeCommercialEvent({
    eventType: "click", provider: "Trip.com", category: "HOTEL", slotKey: "hotel:1", valueAmount: 18,
  }, "1.4"), CommercialValidationError);
  const { repository } = repositoryFixture(t);
  const click = normalizeCommercialEvent({
    eventType: "click", provider: "Trip.com", category: "HOTEL", slotKey: "hotel:1",
  }, "1.4");
  const saved = repository.recordCommercialEvent(click);
  assert.equal(saved.valueAmount, null);
  assert.equal(saved.attributionStatus, "unknown");
  const report = repository.commercialPerformance()[0];
  assert.equal(report.clicks, 1);
  assert.equal(report.bookings, null);
  assert.equal(report.commission, null);
  assert.equal(report.conversion_data_status, "unknown");
});

test("confirmed zero conversion differs from missing conversion data", (t) => {
  const { repository } = repositoryFixture(t);
  repository.recordCommercialEvent(normalizeCommercialEvent({
    eventType: "click", provider: "Trip.com", category: "HOTEL", slotKey: "hotel:2",
    conversionDataStatus: "confirmed", eventSource: "offline-provider-fixture",
  }, "1.4"));
  const report = repository.commercialPerformance()[0];
  assert.equal(report.conversion_data_status, "confirmed");
  assert.equal(report.bookings, 0);
  assert.equal(report.commission, 0);
});

test("event attribution rejects a mismatched article revision before insertion", (t) => {
  const { db, repository } = repositoryFixture(t);
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at)
    VALUES ('brief-event','beijing','Guide','[]','informational','ready','now','now')`).run();
  db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at,revision,content_hash)
    VALUES ('draft-event','brief-event','Guide','guide','Body','{}','ready_for_wordpress','now','now',3,'hash-3')`).run();
  assert.throws(() => repository.recordCommercialEvent(normalizeCommercialEvent({
    eventType: "click", provider: "Trip.com", category: "HOTEL", slotKey: "hotel:3",
    draftId: "draft-event", articleRevision: 2, eventSource: "offline-provider-fixture",
  }, "1.4")), /articleRevision does not match/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM commercial_events").get().count, 0);
});

test("a traceable event retains article revision, asset, overlay, and real fixture source", (t) => {
  const { db, repository } = repositoryFixture(t);
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at)
    VALUES ('brief-trace','beijing','Guide','[]','informational','ready','now','now')`).run();
  db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at,revision,content_hash)
    VALUES ('draft-trace','brief-trace','Guide','guide','Body','{}','ready_for_wordpress','now','now',4,'hash-4')`).run();
  const provider = repository.upsertAffiliateProviderAccount(normalizeAffiliateProviderAccount({
    providerKey: "trip-trace", displayName: "Trip.com", connectionMode: "MANUAL",
  }));
  const asset = repository.upsertAffiliateAsset(normalizeAffiliateAsset({
    providerAccountId: provider.id, provider: "Trip.com", assetType: "CATEGORY_LINK", productCategory: "HOTEL",
    scopeType: "DESTINATION", scopeKey: "beijing", destinationSlug: "beijing", title: "Hotels",
    targetUrl: "https://trip.com/hotels/beijing",
  }));
  repository.saveCommercialComposition("draft-trace", {
    publishableBodyMarkdown: "Body", slots: [{ slot_key: "hotel:trace", affiliate_asset_id: asset.id,
      component_type: "affiliate_booking_card", placement: "end_resource", block_index: 0, product_category: "HOTEL" }],
    offerIds: [], assetIds: [asset.id], commercialBlocks: [], contentBlocks: [], intents: [], opportunities: [],
    disclosureText: "Disclosure", status: "composed",
  });
  const overlayVersion = db.prepare("SELECT overlay_version FROM commercial_compositions WHERE draft_id='draft-trace'").get().overlay_version;
  const saved = repository.recordCommercialEvent(normalizeCommercialEvent({
    eventType: "click", provider: "Trip.com", category: "HOTEL", slotKey: "hotel:trace",
    draftId: "draft-trace", articleRevision: 4, affiliateAssetId: asset.id, overlayVersion,
    eventSource: "offline-provider-fixture", conversionDataStatus: "unknown",
  }, "1.4"));
  assert.equal(saved.attributionStatus, "traceable");
  assert.equal(saved.overlayVersion, overlayVersion);
  const performance = repository.commercialPerformance()[0];
  assert.equal(performance.attribution_status, "traceable");
  assert.deepEqual(performance.trace, { articleRevisions: 1, overlayVersions: 1, affiliateAssets: 1, unknownEvents: 0 });
});
