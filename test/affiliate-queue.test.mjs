import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  affiliateAssetFromQueueTask, affiliateQueueSub1, affiliateQueueTaskKey, exportAffiliateQueue,
  loadAffiliateQueueSeeds, normalizeAffiliateQueueTask, parseAffiliateQueueImport, queueTaskFromOpportunity,
} from "../src/affiliate-queue.mjs";
import { normalizeAffiliateAsset, normalizeEmbedConfig } from "../src/commercial.mjs";
import { loadConfig } from "../src/config.mjs";
import { openDatabase } from "../src/db.mjs";
import { Repository } from "../src/repository.mjs";
import { createApplication } from "../src/server.mjs";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "affiliate-queue-"));
  const db = openDatabase(path.join(directory, "queue.sqlite"));
  const repository = new Repository(db, { affiliateOpportunityThreshold: 70 });
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return repository;
}

function taskInput(overrides = {}) {
  return {
    provider: "Trip.com", productCategory: "HOTEL", assetType: "CATEGORY_LINK", scopeType: "DESTINATION",
    scopeKey: "beijing", destinationSlug: "beijing", tripToolType: "HOTELS", tripDestination: "Beijing",
    suggestedTitle: "Hotels in Beijing", ...overrides,
  };
}

function createTask(repository, overrides = {}) {
  return repository.createAffiliateQueueTask(taskInput(overrides), { sourceType: overrides.sourceType || "SEED" }).task;
}

test("task_key is stable and follows provider/category/scope/key", () => {
  const input = taskInput();
  assert.equal(affiliateQueueTaskKey(input), "trip:hotel:destination:beijing");
  assert.equal(affiliateQueueTaskKey(input), affiliateQueueTaskKey({ ...input }));
});

test("category-prefixed canonical entity keys produce readable stable keys and sub IDs", () => {
  const input = { provider: "Trip.com", productCategory: "ATTRACTION", scopeType: "ENTITY", scopeKey: "attraction.forbidden_city" };
  assert.equal(affiliateQueueTaskKey(input), "trip:attraction:entity:forbidden-city");
  assert.equal(affiliateQueueSub1(input), "stc_attraction_forbidden_city");
});

test("trip_sub1 is stable, lowercase, and independent of database or article IDs", () => {
  const one = affiliateQueueSub1(taskInput({ id: "db-1", articleId: "article-1" }));
  const two = affiliateQueueSub1(taskInput({ id: "db-2", articleId: "article-2" }));
  assert.equal(one, "stc_hotel_beijing");
  assert.equal(one, two);
  assert.match(one, /^[a-z0-9_]+$/);
});

test("trip_sub1 collisions get deterministic task-key hash suffixes", (t) => {
  const repository = fixture(t);
  const destination = createTask(repository);
  const entity = createTask(repository, { scopeType: "ENTITY", scopeKey: "beijing", entityKey: "beijing", assetType: "DEEP_LINK" });
  assert.equal(destination.trip_sub1, "stc_hotel_beijing");
  assert.match(entity.trip_sub1, /^stc_hotel_beijing_[a-f0-9]{8}$/);
});

test("task_key uniqueness deduplicates repeated creation", (t) => {
  const repository = fixture(t);
  const first = repository.createAffiliateQueueTask(taskInput());
  const second = repository.createAffiliateQueueTask(taskInput());
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.reason, "task_exists");
  assert.equal(repository.listAffiliateQueueTasks().length, 1);
});

test("an existing task keeps its immutable trip_sub1", (t) => {
  const repository = fixture(t);
  const first = repository.createAffiliateQueueTask(taskInput()).task;
  const second = repository.createAffiliateQueueTask(taskInput({ tripSub1: "stc_changed" })).task;
  assert.equal(second.trip_sub1, first.trip_sub1);
});

test("initial tasks come only from the explicit small seed file", () => {
  const seeds = loadAffiliateQueueSeeds();
  assert.equal(seeds.length, 4);
  assert.deepEqual(new Set(seeds.map((item) => item.destinationSlug)), new Set(["beijing", "shanghai"]));
});

test("seeding is idempotent and does not expand combinations", (t) => {
  const repository = fixture(t);
  assert.equal(repository.seedAffiliateQueue().created, 4);
  assert.equal(repository.seedAffiliateQueue().existing, 4);
  assert.equal(repository.listAffiliateQueueTasks().length, 4);
});

test("an exact active Affiliate Asset suppresses an equivalent queue task", (t) => {
  const repository = fixture(t); const provider = repository.ensureTripManualProvider();
  repository.upsertAffiliateAsset(normalizeAffiliateAsset({ ...taskInput(), providerAccountId: provider.id, provider: provider.display_name, title: "Existing", targetUrl: "https://www.trip.com/hotels/beijing" }));
  const result = repository.createAffiliateQueueTask(taskInput());
  assert.equal(result.created, false);
  assert.equal(result.reason, "active_asset_exists");
});

test("a broad destination fallback does not suppress a high-value entity task", (t) => {
  const repository = fixture(t); const provider = repository.ensureTripManualProvider();
  repository.upsertAffiliateAsset(normalizeAffiliateAsset({ ...taskInput(), providerAccountId: provider.id, provider: provider.display_name, title: "Beijing hotels", targetUrl: "https://www.trip.com/hotels/beijing" }));
  const result = repository.enqueueAffiliateQueueFromComposition({ intents: [{ id: "intent-1", intentStrength: "VERY_HIGH", destinationSlug: "beijing", entityKey: "hotel.example" }], opportunities: [{ id: "opp-1", intentId: "intent-1", provider: "Trip.com", productCategory: "HOTEL", scopeType: "ENTITY", scopeKey: "hotel.example", score: 88, factors: { landingPageMismatch: 80 }, reason: "Exact property link missing." }] });
  assert.equal(result.created, 1);
  assert.equal(repository.listAffiliateQueueTasks()[0].scope_type, "ENTITY");
});

test("LOW and MEDIUM intent never create queue tasks", () => {
  const opportunity = { id: "opp", provider: "Trip.com", productCategory: "HOTEL", scopeType: "DESTINATION", scopeKey: "beijing", score: 95, factors: {} };
  assert.equal(queueTaskFromOpportunity(opportunity, { intentStrength: "LOW" }), null);
  assert.equal(queueTaskFromOpportunity(opportunity, { intentStrength: "MEDIUM" }), null);
});

test("opportunities below the configured score threshold do not create tasks", () => {
  const opportunity = { id: "opp", provider: "Trip.com", productCategory: "HOTEL", scopeType: "DESTINATION", scopeKey: "beijing", score: 69, factors: {} };
  assert.equal(queueTaskFromOpportunity(opportunity, { intentStrength: "VERY_HIGH" }, { threshold: 70 }), null);
});

test("opportunity priority reflects intent, specificity, score, and precision uplift", () => {
  const opportunity = { id: "opp", provider: "Trip.com", productCategory: "ATTRACTION", scopeType: "ENTITY", scopeKey: "forbidden-city", score: 90, factors: { landingPageMismatch: 90 }, reason: "Exact link missing." };
  const high = queueTaskFromOpportunity(opportunity, { intentStrength: "VERY_HIGH", entityKey: "forbidden-city", destinationSlug: "beijing" });
  const lower = queueTaskFromOpportunity({ ...opportunity, score: 72 }, { intentStrength: "HIGH", entityKey: "forbidden-city", destinationSlug: "beijing" });
  assert.ok(high.priority > lower.priority);
});

test("completing a task creates a linked Affiliate Asset from task metadata", (t) => {
  const repository = fixture(t); const task = createTask(repository, { opportunityId: "opp-123", score: 82 });
  const result = repository.completeAffiliateQueueTask(task.id, { affiliateUrl: "https://www.trip.com/t/example?sub1=stc_hotel_beijing" });
  assert.equal(result.created, true);
  assert.equal(result.task.status, "COMPLETED");
  assert.equal(result.task.affiliate_asset_id, result.asset.id);
  assert.equal(result.asset.product_category, "HOTEL");
  assert.equal(result.asset.scope_key, "beijing");
});

test("completing an already completed task is idempotent", (t) => {
  const repository = fixture(t); const task = createTask(repository);
  const first = repository.completeAffiliateQueueTask(task.id, { affiliateUrl: "https://www.trip.com/t/first" });
  const second = repository.completeAffiliateQueueTask(task.id, { affiliateUrl: "https://www.trip.com/t/second" });
  assert.equal(second.idempotent, true);
  assert.equal(second.asset.id, first.asset.id);
  assert.equal(repository.listAffiliateAssets().length, 1);
  assert.equal(second.asset.target_url, "https://www.trip.com/t/first");
});

test("official Affiliate URL is validated without rewriting", (t) => {
  const repository = fixture(t); const task = createTask(repository);
  const url = "https://www.trip.com/t/link?sub1=stc_hotel_beijing&utm_source=operator";
  const result = repository.completeAffiliateQueueTask(task.id, { affiliateUrl: url });
  assert.equal(result.asset.target_url, url);
});

test("unsafe and off-provider URLs are rejected", (t) => {
  const repository = fixture(t); const task = createTask(repository);
  for (const affiliateUrl of ["javascript:alert(1)", "data:text/html,bad", "https://user:pass@trip.com/x", "https://evil.example/x"]) {
    assert.throws(() => repository.completeAffiliateQueueTask(task.id, { affiliateUrl }));
  }
  assert.equal(repository.listAffiliateAssets().length, 0);
});

test("raw HTML and script cannot enter source URLs or embed configuration", () => {
  assert.throws(() => normalizeAffiliateQueueTask(taskInput({ sourceTripUrl: "<script src=https://trip.com/x></script>" })));
  assert.throws(() => normalizeEmbedConfig("<script>alert(1)</script>", "SEARCH_BOX", "Trip.com"), /Raw HTML/);
});

test("SEARCH_BOX supports structured official embed config", (t) => {
  const repository = fixture(t);
  const task = createTask(repository, { assetType: "SEARCH_BOX", tripToolType: "SEARCH_BOX" });
  const result = repository.completeAffiliateQueueTask(task.id, { embedConfig: { embedType: "search_box", src: "https://affiliate.trip.com/search-box", width: 400 } });
  assert.equal(result.asset.asset_type, "SEARCH_BOX");
  assert.equal(result.asset.embed_config.src, "https://affiliate.trip.com/search-box");
});

test("SEARCH_BOX rejects arbitrary HTML even during completion", (t) => {
  const repository = fixture(t);
  const task = createTask(repository, { assetType: "SEARCH_BOX", tripToolType: "SEARCH_BOX" });
  assert.throws(() => repository.completeAffiliateQueueTask(task.id, { embedConfig: "<iframe src='https://trip.com'></iframe>" }), /Raw HTML/);
});

test("PROMOTION tasks require an explicit validity window", () => {
  assert.throws(() => normalizeAffiliateQueueTask(taskInput({ assetType: "PROMOTION" })), /validFrom and validUntil/);
  assert.doesNotThrow(() => normalizeAffiliateQueueTask(taskInput({ assetType: "PROMOTION", validFrom: "2026-09-01", validUntil: "2026-10-01" })));
});

test("CSV export includes stable identifiers and quotes multiline fields", (t) => {
  const repository = fixture(t); createTask(repository, { reason: "one, two\nthree" });
  const csv = repository.exportAffiliateQueue({ format: "csv" });
  assert.match(csv, /^task_id,task_key,status,/);
  assert.match(csv, /"one, two\nthree"/);
  assert.equal(parseAffiliateQueueImport(csv, "csv")[0].task_key, "trip:hotel:destination:beijing");
});

test("JSON export is a portable array with task_id and task_key", (t) => {
  const repository = fixture(t); createTask(repository);
  const rows = JSON.parse(repository.exportAffiliateQueue({ format: "json" }));
  assert.equal(rows[0].task_key, "trip:hotel:destination:beijing");
  assert.match(rows[0].task_id, /^affiliate_task_/);
});

test("dry-run validates imports without creating assets or completing tasks", (t) => {
  const repository = fixture(t); const task = createTask(repository);
  const report = repository.importAffiliateQueue([{ task_id: task.id, task_key: task.task_key, affiliate_url: "https://www.trip.com/t/preview" }], { dryRun: true });
  assert.equal(report.valid, 1);
  assert.equal(repository.listAffiliateAssets().length, 0);
  assert.equal(repository.getAffiliateQueueTask(task.id).status, "READY_FOR_MANUAL");
});

test("import detects duplicate task identity rows", (t) => {
  const repository = fixture(t); const task = createTask(repository);
  const row = { task_id: task.id, task_key: task.task_key, affiliate_url: "https://www.trip.com/t/duplicate" };
  const report = repository.importAffiliateQueue([row, row], { dryRun: true });
  assert.equal(report.valid, 1);
  assert.equal(report.failed, 1);
  assert.match(report.results[1].error, /Duplicate/);
});

test("import reports partial failures while completing valid rows", (t) => {
  const repository = fixture(t); const valid = createTask(repository); const invalid = createTask(repository, { scopeKey: "shanghai", destinationSlug: "shanghai", tripDestination: "Shanghai" });
  const report = repository.importAffiliateQueue([
    { task_id: valid.id, task_key: valid.task_key, affiliate_url: "https://www.trip.com/t/valid" },
    { task_id: invalid.id, task_key: invalid.task_key, affiliate_url: "https://evil.example/not-trip" },
  ]);
  assert.equal(report.completed, 1);
  assert.equal(report.failed, 1);
  assert.equal(repository.getAffiliateQueueTask(valid.id).status, "COMPLETED");
  assert.equal(repository.getAffiliateQueueTask(invalid.id).status, "INVALID");
});

test("completed task import protection prevents replacement", (t) => {
  const repository = fixture(t); const task = createTask(repository);
  repository.completeAffiliateQueueTask(task.id, { affiliateUrl: "https://www.trip.com/t/original" });
  const report = repository.importAffiliateQueue([{ task_id: task.id, task_key: task.task_key, affiliate_url: "https://www.trip.com/t/replacement" }]);
  assert.equal(report.protected, 1);
  assert.equal(repository.getAffiliateAsset(repository.getAffiliateQueueTask(task.id).affiliate_asset_id).target_url, "https://www.trip.com/t/original");
});

test("skip is idempotent and completed tasks cannot be skipped", (t) => {
  const repository = fixture(t); const skipped = createTask(repository);
  assert.equal(repository.skipAffiliateQueueTask(skipped.id).status, "SKIPPED");
  assert.equal(repository.skipAffiliateQueueTask(skipped.id).status, "SKIPPED");
  const completed = createTask(repository, { scopeKey: "shanghai", destinationSlug: "shanghai" });
  repository.completeAffiliateQueueTask(completed.id, { affiliateUrl: "https://www.trip.com/t/shanghai" });
  assert.throws(() => repository.skipAffiliateQueueTask(completed.id), /cannot be skipped/);
});

test("repository queue filters status, category, and scope", (t) => {
  const repository = fixture(t); createTask(repository); createTask(repository, { productCategory: "TRAIN", scopeType: "ROUTE", scopeKey: "beijing-xian", routeKey: "beijing-xian", assetType: "DEEP_LINK", tripToolType: "TRAINS" });
  assert.equal(repository.listAffiliateQueueTasks({ productCategory: "TRAIN" }).length, 1);
  assert.equal(repository.listAffiliateQueueTasks({ scopeType: "ROUTE" }).length, 1);
  assert.equal(repository.listAffiliateQueueTasks({ status: "COMPLETED" }).length, 0);
});

test("asset construction preserves opportunity linkage on task and uses existing performance asset identity", (t) => {
  const repository = fixture(t); const task = createTask(repository, { opportunityId: "opp-linked" });
  const provider = repository.getAffiliateProviderAccount(task.provider_account_id);
  const asset = affiliateAssetFromQueueTask(task, { affiliateUrl: "https://www.trip.com/t/linked" }, provider);
  assert.match(asset.id, /^asset_/);
  assert.equal(task.opportunity_id, "opp-linked");
  assert.equal(asset.productCategory, "HOTEL");
});

test("export helper rejects unsupported formats", () => {
  assert.throws(() => exportAffiliateQueue([], "xml"), /csv or json/);
});

test("affiliate queue write APIs require admin auth and expose the manual workflow", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "affiliate-queue-api-"));
  const config = loadConfig({ HOST: "127.0.0.1", PORT: "0", DATABASE_PATH: path.join(directory, "api.sqlite"), ADMIN_TOKEN: "queue-admin", MAINTENANCE_ENABLED: "false", LOG_LEVEL: "error" });
  const app = createApplication(config); await app.start();
  t.after(async () => { await app.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const denied = await fetch(`${base}/api/commercial/affiliate-queue/seed`, { method: "POST" });
  assert.equal(denied.status, 401);
  const seeded = await fetch(`${base}/api/commercial/affiliate-queue/seed`, { method: "POST", headers: { authorization: "Bearer queue-admin" } });
  assert.equal(seeded.status, 200);
  assert.equal((await seeded.json()).created, 4);
  const listed = await (await fetch(`${base}/api/commercial/affiliate-queue?product_category=HOTEL`)).json();
  assert.equal(listed.items.length, 2);
  const task = listed.items[0];
  const completed = await fetch(`${base}/api/commercial/affiliate-queue/${task.id}/complete`, {
    method: "POST", headers: { authorization: "Bearer queue-admin", "content-type": "application/json" },
    body: JSON.stringify({ affiliateUrl: "https://www.trip.com/t/api-test" }),
  });
  assert.equal(completed.status, 200);
  assert.equal((await completed.json()).task.status, "COMPLETED");
});
