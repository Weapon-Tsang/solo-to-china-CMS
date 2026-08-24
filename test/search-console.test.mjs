import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { Pipeline } from "../src/pipeline.mjs";
import { SearchConsoleAdapter } from "../src/search-console.mjs";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";

test("Search Console adapter authenticates with a service account and paginates read-only query inventory", async () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const requests = [];
  const fetchStub = async (url, options) => {
    requests.push({ url, options });
    if (url.includes("oauth2.googleapis.com")) {
      const form = new URLSearchParams(options.body);
      assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      assert.equal(form.get("assertion").split(".").length, 3);
      return Response.json({ access_token: "read-token" });
    }
    assert.equal(options.method, "POST");
    assert.equal(options.headers.authorization, "Bearer read-token");
    const request = JSON.parse(options.body);
    const rows = request.startRow === 0 ? [
      { keys: ["beijing solo guide", "https://site.test/beijing"], clicks: 8, impressions: 80, ctr: 0.1, position: 3.2 },
      { keys: ["forbidden city tickets", "https://site.test/forbidden-city"], clicks: 4, impressions: 50, ctr: 0.08, position: 5.1 },
    ] : [];
    return Response.json({ rows });
  };
  const adapter = new SearchConsoleAdapter({
    siteUrl: "sc-domain:site.test",
    clientEmail: "search-reader@project.iam.gserviceaccount.com",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
    rowLimit: 2,
    lookbackDays: 28,
  }, fetchStub);
  const result = await adapter.listQueryInventory(new Date("2026-08-25T00:00:00.000Z"));
  assert.equal(result.rows.length, 2);
  assert.equal(result.startDate, "2026-07-28");
  assert.equal(result.endDate, "2026-08-23");
  assert.equal(requests.length, 3);
  assert.ok(requests.slice(1).every((request) => request.url.includes("searchAnalytics/query")));
});

test("Search Console adapter rejects unsafe property identifiers before authentication", async () => {
  const adapter = new SearchConsoleAdapter({ siteUrl: "http://site.test", clientEmail: "reader@test", privateKey: "invalid" });
  await assert.rejects(() => adapter.listQueryInventory(), /HTTPS URL-prefix property/);
});

test("Search Console inventory runs through the durable job pipeline", async (t) => {
  const { repository } = repositoryFixture(t);
  const searchConsole = {
    enabled: true,
    config: { siteUrl: "sc-domain:site.test" },
    async listQueryInventory() {
      return { startDate: "2026-07-28", endDate: "2026-08-23", rows: [{
        query: "beijing solo travel", pageUrl: "https://site.test/beijing", clicks: 5, impressions: 50, ctr: 0.1, position: 4,
      }] };
    },
  };
  const pipeline = new Pipeline(repository, {}, { searchConsole });
  repository.enqueueSearchConsoleSync(searchConsole.config.siteUrl, 24, true);
  assert.equal(await pipeline.runOne(), true);
  assert.equal(repository.listSearchConsoleInventory().length, 1);
  assert.equal(repository.getSearchConsoleSyncState(searchConsole.config.siteUrl).status, "succeeded");
});
