import assert from "node:assert/strict";
import test from "node:test";
import { markdownToSafeHtml, markdownToWordPressBlocks, WordPressDraftAdapter } from "../src/wordpress.mjs";

test("WordPress adapter always creates a draft with safe content", async () => {
  let request;
  const fetchStub = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ id: 7, status: "draft", link: "https://site.test/?p=7" }), { status: 201, headers: { "content-type": "application/json" } });
  };
  const adapter = new WordPressDraftAdapter({
    siteUrl: "https://site.test", username: "editor", applicationPassword: "app password",
    authorId: 12, categoryIds: [3], tagIds: [7, 8],
    featuredMediaId: 44, template: "templates/travel.php", contentFormat: "blocks",
    seoTitleMetaKey: "seo_title", seoDescriptionMetaKey: "seo_description", schemaJsonldMetaKey: "seo_schema",
  }, fetchStub);
  const result = await adapter.upsertDraft({
    title: "Guide", slug: "guide", meta_description: "Description", seo: { meta_title: "SEO Guide" },
    schema_jsonld: { "@context": "https://schema.org", "@graph": [{ "@type": "Article" }] },
    body_markdown: "## Plan\n\n<script>alert(1)</script> **safe**",
  });
  assert.equal(request.body.status, "draft");
  assert.equal(request.body.comment_status, "closed");
  assert.equal(request.body.author, 12);
  assert.deepEqual(request.body.categories, [3]);
  assert.deepEqual(request.body.tags, [7, 8]);
  assert.equal(request.body.featured_media, 44);
  assert.equal(request.body.template, "templates/travel.php");
  assert.deepEqual(request.body.meta, {
    seo_title: "SEO Guide", seo_description: "Description",
    seo_schema: JSON.stringify({ "@context": "https://schema.org", "@graph": [{ "@type": "Article" }] }),
  });
  assert.match(request.body.content, /<!-- wp:heading/);
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

test("WordPress adapter renders persisted structured blocks instead of reparsing draft Markdown", async () => {
  let request;
  const fetchStub = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ id: 9, status: "draft", link: "https://site.test/?p=9" }), { status: 201, headers: { "content-type": "application/json" } });
  };
  const adapter = new WordPressDraftAdapter({ siteUrl: "https://site.test", username: "editor", applicationPassword: "app password", contentFormat: "blocks" }, fetchStub);
  await adapter.upsertDraft({
    title: "Guide", slug: "guide", meta_description: "", body_markdown: "## Ignore this Markdown source",
    content_blocks: [{ type: "heading", level: 2, text: "Canonical plan" }, { type: "paragraph", text: "Structured reader guidance." }],
  });
  assert.match(request.body.content, /Canonical plan/);
  assert.match(request.body.content, /Structured reader guidance/);
  assert.doesNotMatch(request.body.content, /Ignore this Markdown source/);
});

test("WordPress adapter uploads an authorized evidence-linked Xiaohongshu source photo", async () => {
  const requests = [];
  const fetchStub = async (url, options = {}) => {
    requests.push({ url, options });
    if (url === "https://ci.xhscdn.com/beijing-view.jpg") {
      return new Response(Buffer.from("authorized-source-image"), { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    if (url.endsWith("/wp-json/wp/v2/media")) {
      assert.equal(options.headers["content-type"], "image/jpeg");
      assert.equal(Buffer.from(options.body).toString(), "authorized-source-image");
      return new Response(JSON.stringify({ id: 13, source_url: "https://site.test/uploads/beijing-view.jpg" }), { status: 201, headers: { "content-type": "application/json" } });
    }
    assert.equal(url, "https://site.test/wp-json/wp/v2/posts");
    return new Response(JSON.stringify({ id: 14, status: "draft", link: "https://site.test/?p=14" }), { status: 201, headers: { "content-type": "application/json" } });
  };
  const adapter = new WordPressDraftAdapter({ siteUrl: "https://site.test", username: "editor", applicationPassword: "app password", contentFormat: "blocks" }, fetchStub);
  const result = await adapter.upsertDraft({
    title: "Beijing Guide", slug: "beijing-guide", meta_description: "", body_markdown: "## Plan\n\nEvidence-led guidance.",
    visuals: [{ id: "visual_source_1", status: "generated", source_asset_id: "asset_1", source_remote_url: "https://ci.xhscdn.com/beijing-view.jpg", alt_text: "Beijing travel scene", caption: "Authorized source photo" }],
  });
  assert.equal(result.visuals[0].id, 13);
  assert.equal(requests.length, 3);
  const postBody = JSON.parse(requests[2].options.body);
  assert.equal(postBody.featured_media, 13);
  assert.match(postBody.content, /wp-image-13/);
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

test("WordPress block renderer emits native Gutenberg blocks without weakening HTML escaping", () => {
  const blocks = markdownToWordPressBlocks("## Plan\n\nText <script>bad</script>\n\n- One\n- Two");
  assert.match(blocks, /<!-- wp:heading/);
  assert.match(blocks, /<!-- wp:paragraph -->/);
  assert.match(blocks, /<!-- wp:list -->/);
  assert.doesNotMatch(blocks, /<script>/);
  assert.match(blocks, /&lt;script&gt;/);
});

test("WordPress renderers place generated visual media safely within the article", () => {
  const visuals = [{ id: 12, url: "https://site.test/uploads/guide.png", alt: "Beijing skyline", caption: "An original editorial visual" }];
  const html = markdownToSafeHtml("## Plan\n\nParagraph", visuals);
  const blocks = markdownToWordPressBlocks("## Plan\n\nParagraph", visuals);
  assert.match(html, /<figure><img src="https:\/\/site\.test\/uploads\/guide\.png" alt="Beijing skyline"\/>/);
  assert.match(blocks, /<!-- wp:image \{\"id\":12/);
  assert.match(blocks, /wp-element-caption/);
});
