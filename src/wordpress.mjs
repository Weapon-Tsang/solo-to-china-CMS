import fs from "node:fs";
import path from "node:path";
import { markdownToContentBlocks } from "./content-blocks.mjs";

const SOURCE_IMAGE_HOST_SUFFIXES = ["xiaohongshu.com", "xhscdn.com", "xhscdn.net", "xhscdn.cn"];
const MAX_SOURCE_IMAGE_BYTES = 12 * 1024 * 1024;

export class WordPressDraftAdapter {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  get enabled() {
    return Boolean(this.config.siteUrl && this.config.username && this.config.applicationPassword);
  }

  async listContentInventory() {
    if (!this.enabled) throw new Error("WordPress inventory sync is not configured.");
    assertSafeSiteUrl(this.config.siteUrl);
    const inventory = [];
    let page = 1;
    let totalPages = 1;
    do {
      const params = new URLSearchParams({
        context: "edit",
        status: "publish,draft,pending,private,future",
        per_page: "100",
        page: String(page),
        _fields: "id,slug,status,link,modified,title",
      });
      const { body, response } = await this.requestWithResponse(`/wp-json/wp/v2/posts?${params}`, { method: "GET" });
      if (!Array.isArray(body)) throw new Error("WordPress inventory response must be an array.");
      inventory.push(...body.map((post) => ({
        postId: post.id,
        slug: String(post.slug || ""),
        title: plainText(post.title?.raw || post.title?.rendered || ""),
        status: String(post.status || ""),
        postUrl: post.link || null,
        modifiedAt: post.modified || null,
      })));
      totalPages = Math.max(1, Number.parseInt(response.headers.get("x-wp-totalpages") || "1", 10) || 1);
      page += 1;
    } while (page <= totalPages);
    return inventory;
  }

  async upsertDraft(draft, existingPostId = null) {
    if (!this.enabled) throw new Error("WordPress draft delivery is not configured.");
    assertSafeSiteUrl(this.config.siteUrl);
    if (existingPostId) {
      const current = await this.request(`/wp-json/wp/v2/posts/${existingPostId}?context=edit`, { method: "GET" });
      if (current.status !== "draft") {
        throw new Error(`WordPress post ${existingPostId} is '${current.status}', so the engine refuses to overwrite it.`);
      }
    }
    const visuals = await this.resolveVisualMedia(draft.visuals || []);
    const contentBlocks = Array.isArray(draft.content_blocks) && draft.content_blocks.length
      ? draft.content_blocks : markdownToContentBlocks(draft.body_markdown);
    const post = {
      title: draft.title,
      slug: draft.slug,
      content: this.config.contentFormat === "html" ? contentBlocksToSafeHtml(contentBlocks, visuals) : contentBlocksToWordPressBlocks(contentBlocks, visuals),
      excerpt: draft.meta_description,
      status: "draft",
      comment_status: "closed",
      ping_status: "closed",
    };
    if (this.config.authorId > 0) post.author = this.config.authorId;
    if (this.config.categoryIds?.length) post.categories = this.config.categoryIds;
    if (this.config.tagIds?.length) post.tags = this.config.tagIds;
    if (this.config.featuredMediaId > 0) post.featured_media = this.config.featuredMediaId;
    else if (visuals[0]?.id) post.featured_media = visuals[0].id;
    if (this.config.template) post.template = this.config.template;
    const meta = {};
    if (this.config.seoTitleMetaKey) meta[this.config.seoTitleMetaKey] = draft.seo?.meta_title || draft.title;
    if (this.config.seoDescriptionMetaKey) meta[this.config.seoDescriptionMetaKey] = draft.meta_description;
    if (this.config.schemaJsonldMetaKey && draft.schema_jsonld) meta[this.config.schemaJsonldMetaKey] = JSON.stringify(draft.schema_jsonld);
    if (this.config.strategyVersionMetaKey && draft.strategy_version) meta[this.config.strategyVersionMetaKey] = draft.strategy_version;
    if (Object.keys(meta).length) post.meta = meta;
    const result = await this.request(`/wp-json/wp/v2/posts${existingPostId ? `/${existingPostId}` : ""}`, {
      method: "POST",
      body: JSON.stringify(post),
    });
    if (result.status !== "draft") throw new Error("WordPress did not confirm draft status; refusing to record the sync.");
    return {
      postId: result.id, postUrl: result.link || null, status: result.status, strategyVersion: draft.strategy_version || null,
      visuals: visuals.map((item) => ({ visualId: item.visualId, id: item.id, url: item.url })),
    };
  }

  async resolveVisualMedia(visuals) {
    const output = [];
    for (const visual of visuals.filter((item) => (
      item.status === "generated" && (item.media_path || (item.source_asset_id && item.source_remote_url))
    ))) {
      if (visual.wordpress_media_id && visual.wordpress_media_url) {
        output.push({ visualId: visual.id, id: visual.wordpress_media_id, url: visual.wordpress_media_url, alt: visual.alt_text, caption: visual.caption });
        continue;
      }
      const media = await this.uploadMedia(visual);
      output.push({ visualId: visual.id, ...media, alt: visual.alt_text, caption: visual.caption });
    }
    return output;
  }

  async uploadMedia(visual) {
    const asset = visual.media_path
      ? { filename: path.basename(visual.media_path), contentType: mimeForFilename(visual.media_path), bytes: fs.readFileSync(visual.media_path) }
      : await this.downloadAuthorizedSourceAsset(visual);
    const response = await this.fetch(`${this.config.siteUrl}/wp-json/wp/v2/media`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.applicationPassword}`).toString("base64")}`,
        "content-type": asset.contentType,
        "content-disposition": `attachment; filename=\"${asset.filename}\"`,
      },
      body: asset.bytes,
      signal: AbortSignal.timeout(60_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.id) throw new Error(`WordPress media upload failed (${response.status}): ${body?.message || response.statusText}`);
    return { id: body.id, url: body.source_url || body.guid?.rendered || "" };
  }

  async downloadAuthorizedSourceAsset(visual) {
    const sourceUrl = safeAuthorizedSourceImageUrl(visual.source_remote_url);
    if (!sourceUrl) throw new Error("Authorized source image URL is not an allowlisted Xiaohongshu HTTPS asset.");
    const response = await this.fetch(sourceUrl, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Authorized source image download failed (${response.status}).`);
    const contentType = String(response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (!/^image\/(?:jpeg|jpg|png|webp)$/.test(contentType)) throw new Error("Authorized source asset is not a supported image.");
    const declaredBytes = Number.parseInt(response.headers.get("content-length") || "", 10);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_SOURCE_IMAGE_BYTES) throw new Error("Authorized source asset is too large for WordPress upload.");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_SOURCE_IMAGE_BYTES) throw new Error("Authorized source asset is empty or too large for WordPress upload.");
    return {
      bytes,
      contentType: contentType === "image/jpg" ? "image/jpeg" : contentType,
      filename: `source-${visual.id}.${extensionForContentType(contentType)}`,
    };
  }

  async request(pathname, options) {
    const { body } = await this.requestWithResponse(pathname, options);
    return body;
  }

  async requestWithResponse(pathname, options) {
    const response = await this.fetch(`${this.config.siteUrl}${pathname}`, {
      ...options,
      headers: {
        authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.applicationPassword}`).toString("base64")}`,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(60_000),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`WordPress API failed (${response.status}): ${body?.message || response.statusText}`);
    return { body, response };
  }
}

export function markdownToSafeHtml(markdown, visuals = []) {
  return contentBlocksToSafeHtml(markdownToContentBlocks(markdown), visuals);
}

export function markdownToWordPressBlocks(markdown, visuals = []) {
  return contentBlocksToWordPressBlocks(markdownToContentBlocks(markdown), visuals);
}

function contentBlocksToSafeHtml(contentBlocks, visuals = []) {
  return injectVisuals(renderContentBlocks(contentBlocks).map((block) => block.html), visuals, htmlVisual).join("\n");
}

function contentBlocksToWordPressBlocks(contentBlocks, visuals = []) {
  const blocks = renderContentBlocks(contentBlocks).map((block) => {
    if (block.type === "heading") return `<!-- wp:heading {"level":${block.level}} -->\n${block.html}\n<!-- /wp:heading -->`;
    if (block.type === "list") return `<!-- wp:list -->\n${block.html}\n<!-- /wp:list -->`;
    return `<!-- wp:paragraph -->\n${block.html}\n<!-- /wp:paragraph -->`;
  });
  return injectVisuals(blocks, visuals, wordpressVisual).join("\n\n");
}

function injectVisuals(blocks, visuals, renderer) {
  const output = [...blocks];
  const ordered = [...visuals].filter((item) => item.id && item.url);
  ordered.forEach((visual, index) => {
    const position = Math.min(output.length, Math.max(1, Math.round((index + 1) * output.length / (ordered.length + 1)) + index));
    output.splice(position, 0, renderer(visual));
  });
  return output;
}

function wordpressVisual(visual) {
  const caption = visual.caption ? `\n<figcaption class=\"wp-element-caption\">${escapeHtml(visual.caption)}</figcaption>` : "";
  return `<!-- wp:image {"id":${visual.id},"sizeSlug":"large","linkDestination":"none"} -->\n<figure class=\"wp-block-image size-large\"><img src=\"${escapeHtml(visual.url)}\" alt=\"${escapeHtml(visual.alt || "")}\" class=\"wp-image-${visual.id}\"/>${caption}</figure>\n<!-- /wp:image -->`;
}

function htmlVisual(visual) {
  const caption = visual.caption ? `<figcaption>${escapeHtml(visual.caption)}</figcaption>` : "";
  return `<figure><img src=\"${escapeHtml(visual.url)}\" alt=\"${escapeHtml(visual.alt || "")}\"/>${caption}</figure>`;
}

function mimeForFilename(filename) {
  return /\.jpe?g$/i.test(filename) ? "image/jpeg" : /\.webp$/i.test(filename) ? "image/webp" : "image/png";
}

function extensionForContentType(contentType) {
  return contentType === "image/webp" ? "webp" : contentType === "image/png" ? "png" : "jpg";
}

function safeAuthorizedSourceImageUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const approved = SOURCE_IMAGE_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
    return url.protocol === "https:" && approved ? url.toString() : null;
  } catch {
    return null;
  }
}

function renderContentBlocks(contentBlocks) {
  return contentBlocks.map((block) => {
    if (block.type === "heading") return { ...block, html: `<h${block.level}>${inline(block.text)}</h${block.level}>` };
    if (block.type === "list") return { ...block, html: `<ul>${block.items.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>` };
    return { ...block, html: `<p>${inline(block.text)}</p>` };
  });
}

function inline(text) {
  return escapeHtml(text)
    .replace(/\[\[affiliate:([^|\]]+)\|(https:\/\/[^\]\s]+)\]\]/g, '<a href="$2" rel="sponsored nofollow noopener" target="_blank">$1</a>')
    .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener" target="_blank">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function plainText(value) {
  return String(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function assertSafeSiteUrl(value) {
  const url = new URL(value);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !local) throw new Error("WordPress Application Passwords require HTTPS outside localhost.");
  if (url.username || url.password || url.search || url.hash) throw new Error("WORDPRESS_SITE_URL must be a clean site origin/path without credentials or query parameters.");
}
