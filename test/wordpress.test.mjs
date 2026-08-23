import assert from "node:assert/strict";
import test from "node:test";
import { markdownToSafeHtml, WordPressDraftAdapter } from "../src/wordpress.mjs";

test("WordPress adapter always creates a draft with safe content", async () => {
  let request;
  const fetchStub = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ id: 7, status: "draft", link: "https://site.test/?p=7" }), { status: 201, headers: { "content-type": "application/json" } });
  };
  const adapter = new WordPressDraftAdapter({
    siteUrl: "https://site.test", username: "editor", applicationPassword: "app password",
  }, fetchStub);
  const result = await adapter.upsertDraft({
    title: "Guide", slug: "guide", meta_description: "Description",
    body_markdown: "## Plan\n\n<script>alert(1)</script> **safe**",
  });
  assert.equal(request.body.status, "draft");
  assert.equal(request.body.comment_status, "closed");
  assert.match(request.body.content, /&lt;script&gt;/);
  assert.doesNotMatch(request.body.content, /<script>/);
  assert.equal(result.postId, 7);
});

test("WordPress adapter refuses to overwrite a post after a human publishes it", async () => {
  const fetchStub = async () => new Response(JSON.stringify({ id: 7, status: "publish" }), { status: 200, headers: { "content-type": "application/json" } });
  const adapter = new WordPressDraftAdapter({
    siteUrl: "https://site.test", username: "editor", applicationPassword: "app password",
  }, fetchStub);
  await assert.rejects(() => adapter.upsertDraft({ title: "Guide", slug: "guide", meta_description: "", body_markdown: "Text" }, 7), /refuses to overwrite/);
});

test("WordPress inventory sync reads every page without changing posts", async () => {
  const requests = [];
  const fetchStub = async (url, options) => {
    requests.push({ url, options });
    const page = new URL(url).searchParams.get("page");
    const body = page === "1"
      ? [{ id: 7, slug: "beijing-guide", status: "publish", link: "https://site.test/beijing-guide", modified: "2026-08-01T00:00:00", title: { rendered: "Beijing &amp; Solo Guide" } }]
      : [{ id: 8, slug: "draft-guide", status: "draft", link: "https://site.test/?p=8", modified: "2026-08-02T00:00:00", title: { raw: "Draft <em>Guide</em>" } }];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", "x-wp-totalpages": "2" },
    });
  };
  const adapter = new WordPressDraftAdapter({
    siteUrl: "https://site.test", username: "editor", applicationPassword: "app password",
  }, fetchStub);
  const inventory = await adapter.listContentInventory();
  assert.equal(inventory.length, 2);
  assert.equal(inventory[0].title, "Beijing & Solo Guide");
  assert.equal(inventory[1].title, "Draft Guide");
  assert.ok(requests.every((request) => request.options.method === "GET"));
  assert.match(requests[0].url, /status=publish%2Cdraft%2Cpending%2Cprivate%2Cfuture/);
});

test("markdown renderer escapes HTML before adding supported formatting", () => {
  const html = markdownToSafeHtml("## Heading\n\n- **Item**\n- <iframe>bad</iframe>\n\n[Official](https://official.example/info)\n\n[[affiliate:Book|https://example.test/?ref=affiliate]]");
  assert.match(html, /<h2>Heading<\/h2>/);
  assert.match(html, /<strong>Item<\/strong>/);
  assert.match(html, /&lt;iframe&gt;/);
  assert.match(html, /rel="sponsored nofollow noopener"/);
  assert.match(html, /rel="noopener"/);
  assert.equal((html.match(/sponsored/g) || []).length, 1);
});
