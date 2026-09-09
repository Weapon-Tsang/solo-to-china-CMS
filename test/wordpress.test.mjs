import assert from "node:assert/strict";
import test from "node:test";
import { markdownToSafeHtml, markdownToWordPressBlocks, WordPressApiError, WordPressDraftAdapter } from "../src/wordpress.mjs";

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

test("media progress is persisted per image and retry skips an already uploaded asset", async () => {
  let mediaCalls = 0;
  const fetchStub = async (url) => {
    if (String(url).includes("xhscdn.com")) return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } });
    mediaCalls += 1;
    if (mediaCalls === 2) return new Response(JSON.stringify({ message: "temporary" }), { status: 503, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ id: 100 + mediaCalls, source_url: `https://site.test/media/${100 + mediaCalls}.jpg` }), { status: 201, headers: { "content-type": "application/json" } });
  };
  const adapter = new WordPressDraftAdapter({ siteUrl: "https://site.test", username: "editor", applicationPassword: "password" }, fetchStub);
  const visuals = [1, 2].map((index) => ({ id: `visual-${index}`, status: "generated", source_asset_id: `asset-${index}`,
    source_remote_url: `https://ci.xhscdn.com/${index}.jpg`, alt_text: `Image ${index}`, caption: "Evidence" }));
  const persisted = [];
  await assert.rejects(() => adapter.resolveVisualMedia(visuals, (media) => {
    persisted.push(media.visualId);
    const visual = visuals.find((item) => item.id === media.visualId);
    visual.wordpress_media_id = media.id;
    visual.wordpress_media_url = media.url;
  }), /503/);
  assert.deepEqual(persisted, ["visual-1"]);
  const retried = await adapter.resolveVisualMedia(visuals);
  assert.deepEqual(retried.map((item) => item.visualId), ["visual-1", "visual-2"]);
  assert.equal(mediaCalls, 3, "retry uploads only the previously failed image");
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

test("WordPress renders validated commercial blocks with sponsored attributes and rejects unsafe embeds", async () => {
  let request;
  const fetchStub = async (url, options) => {
    request = { url, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ id: 10, status: "draft", link: "https://site.test/?p=10" }), { status: 201, headers: { "content-type": "application/json" } });
  };
  const adapter = new WordPressDraftAdapter({ siteUrl: "https://site.test", username: "editor", applicationPassword: "app password", contentFormat: "blocks" }, fetchStub);
  await adapter.upsertDraft({
    title: "Guide", slug: "guide", meta_description: "", body_markdown: "Research body",
    content_blocks: [{ type: "paragraph", text: "Research body" }, {
      type: "commercial", component: "affiliate_booking_card", slot_key: "contextual:attraction:1", placement: "contextual",
      data: { affiliate_asset_id: "asset-1", provider: "Trip.com", product_category: "ATTRACTION", title: "Forbidden City tickets", description: "Official booking option.", cta_label: "View tickets", target_url: "https://www.trip.com/tickets", disclosure: "Affiliate disclosure." },
    }, {
      type: "commercial", component: "affiliate_search_card", slot_key: "contextual:hotel:2", placement: "contextual",
      data: { affiliate_asset_id: "asset-2", provider: "Trip.com", product_category: "HOTEL", title: "Unsafe", embed_config: { src: "https://evil.example/widget" } },
    }],
  });
  assert.match(request.body.content, /wp:group/);
  assert.match(request.body.content, /data-affiliate-asset="asset-1"/);
  assert.match(request.body.content, /rel="sponsored nofollow noopener"/);
  assert.doesNotMatch(request.body.content, /evil\.example/);
  assert.doesNotMatch(request.body.content, /<script/);
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

test("Contract-aware adapter sends the exact Publish Package to the STC CMS Article API", async () => {
  const calls = [];
  const adapter = new WordPressDraftAdapter({
    siteUrl: "https://site.test", username: "editor", applicationPassword: "app-password",
  }, async (url, options) => {
    calls.push({ url: String(url), options });
    return Response.json({ post_id: 71, status: "draft", preview_url: "https://site.test/?p=71&preview=true", edit_url: "https://site.test/wp-admin/post.php?post=71", slug: "guide", contract_version: "1.1.0", updated: false }, { status: 201 });
  });
  const publishPackage = {
    contract: { componentContractVersion: "1.1.0", pageSchemaVersion: "1.1.0", contractChecksum: "a".repeat(64) },
    page: { metadata: { pageId: "draft-1", title: "Guide", slug: "guide", contentType: "city-guide" }, blocks: [{ type: "quick_answer", variant: "default", data: { content: "Answer" } }] },
    seo: { meta_title: "Guide", meta_description: "Description" }, schema_jsonld: {}, media: [],
    publication: { status: "draft", existing_post_id: null, cms_draft_id: "draft-1" },
  };
  const result = await adapter.upsertContractDraft(publishPackage);
  assert.equal(calls[0].url, "https://site.test/wp-json/stc/v1/cms-articles");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), publishPackage);
  assert.equal(calls[0].options.body.includes("body_markdown"), false);
  assert.equal(result.postId, 71);
  assert.equal(result.previewUrl, "https://site.test/?p=71&preview=true");
});

test("Contract-aware adapter uses explicit PUT and surfaces non-retryable Frontend validation errors", async () => {
  const methods = [];
  const adapter = new WordPressDraftAdapter({ siteUrl: "https://site.test", username: "editor", applicationPassword: "app-password" }, async (url, options) => {
    methods.push([String(url), options.method]);
    return Response.json({ code: "POST_NOT_DRAFT", message: "Published posts cannot be overwritten.", data: { status: 409 } }, { status: 409 });
  });
  await assert.rejects(() => adapter.upsertContractDraft({ publication: { existing_post_id: 71 } }), (error) => {
    assert.ok(error instanceof WordPressApiError);
    assert.equal(error.code, "POST_NOT_DRAFT");
    assert.equal(error.retryable, false);
    return true;
  });
  assert.deepEqual(methods[0], ["https://site.test/wp-json/stc/v1/cms-articles/71", "PUT"]);
});

test("WordPress renderers place generated visual media safely within the article", () => {
  const visuals = [{ id: 12, url: "https://site.test/uploads/guide.png", alt: "Beijing skyline", caption: "An original editorial visual" }];
  const html = markdownToSafeHtml("## Plan\n\nParagraph", visuals);
  const blocks = markdownToWordPressBlocks("## Plan\n\nParagraph", visuals);
  assert.match(html, /<figure><img src="https:\/\/site\.test\/uploads\/guide\.png" alt="Beijing skyline" fetchpriority="high" decoding="async"\/>/);
  assert.match(blocks, /<!-- wp:image \{\"id\":12/);
  assert.match(blocks, /wp-element-caption/);
});
