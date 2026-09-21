import fs from "node:fs";
import path from "node:path";
import { markdownToContentBlocks } from "./content-blocks.mjs";
import { parseMediaMetadata, responsiveImageAttributes, wordpressMediaMetadata } from "./media-delivery.mjs";

const SOURCE_IMAGE_HOST_SUFFIXES = ["xiaohongshu.com", "xhscdn.com", "xhscdn.net", "xhscdn.cn"];
const MAX_SOURCE_IMAGE_BYTES = 12 * 1024 * 1024;

export class WordPressApiError extends Error {
  constructor(code, message, { status = 0, details = null } = {}) {
    super(`${code}: ${message}`);
    this.name = "WordPressApiError";
    this.code = code;
    this.statusCode = status;
    this.details = details;
    this.retryable = status === 429 || status >= 500 || status === 0;
  }
}

export class WordPressDraftAdapter {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  get enabled() {
    return Boolean(this.config.siteUrl && this.config.username && this.config.applicationPassword);
  }

  async listContentInventory(options = {}) {
    if (!this.enabled) throw new Error("WordPress inventory sync is not configured.");
    assertSafeSiteUrl(this.config.siteUrl);
    const inventory = new Map();
    // Some WordPress installations report published posts in an edit-context
    // collection's total while omitting them from its body. Read public posts
    // through view context and private editorial states through edit context.
    for (const { context, status } of [
      { context: "view", status: "publish" },
      { context: "edit", status: "draft,pending,private,future" },
    ]) {
      let page = 1;
      let totalPages = 1;
      do {
        const params = new URLSearchParams({
          context, status, per_page: "100", page: String(page),
          _fields: "id,slug,status,link,modified,modified_gmt,title",
        });
        const { body, response } = await this.requestWithResponse(`/wp-json/wp/v2/posts?${params}`, { method: "GET", signal: options.signal });
        if (!Array.isArray(body)) throw new Error("WordPress inventory response must be an array.");
        for (const post of body) inventory.set(Number(post.id), {
          postId: post.id,
          slug: String(post.slug || ""),
          title: plainText(post.title?.raw || post.title?.rendered || ""),
          status: String(post.status || ""),
          postUrl: post.link || null,
          modifiedAt: post.modified_gmt ? `${String(post.modified_gmt).replace(/Z$/i, "")}Z` : post.modified || null,
        });
        totalPages = Math.max(1, Number.parseInt(response.headers.get("x-wp-totalpages") || "1", 10) || 1);
        page += 1;
      } while (page <= totalPages);
    }
    return [...inventory.values()];
  }

  async getPost(postId, options = {}) {
    if (!this.enabled || !Number.isSafeInteger(Number(postId)) || Number(postId) <= 0) {
      throw new WordPressApiError('INVALID_POST_ID', 'A configured WordPress post ID is required.', { status: 400 });
    }
    assertSafeSiteUrl(this.config.siteUrl);
    return this.request(`/wp-json/wp/v2/posts/${Number(postId)}?context=edit`,
      { method: 'GET', signal: options.signal });
  }

  async getCmsArticleReceipt(postId, options = {}) {
    if (!this.enabled || !Number.isSafeInteger(Number(postId)) || Number(postId) <= 0) {
      throw new WordPressApiError('INVALID_POST_ID', 'A configured WordPress post ID is required.', { status: 400 });
    }
    assertSafeSiteUrl(this.config.siteUrl);
    return this.request(`/wp-json/stc/v1/cms-articles/${Number(postId)}/receipt`,
      { method:'GET', signal:options.signal });
  }

  async publishPost(postId, options = {}) {
    const result = await this.request(`/wp-json/wp/v2/posts/${Number(postId)}`, {
      method: 'POST', body: JSON.stringify({ status: 'publish' }), signal: options.signal,
      idempotencyKey: options.idempotencyKey,
    });
    if (Number(result.id) !== Number(postId) || result.status !== 'publish') {
      throw new WordPressApiError('WORDPRESS_PUBLISH_UNCONFIRMED',
        'WordPress did not confirm the requested post as published.', { status: 502 });
    }
    return result;
  }

  async upsertDraft(draft, existingPostId = null, options = {}) {
    if (!this.enabled) throw new Error("WordPress draft delivery is not configured.");
    this.deliveryGuard?.(options.draftId, { phase: 'delivery' });
    assertSafeSiteUrl(this.config.siteUrl);
    if (existingPostId) {
      const current = await this.request(`/wp-json/wp/v2/posts/${existingPostId}?context=edit`, { method: "GET", signal: options.signal });
      if (current.status !== "draft") {
        throw new Error(`WordPress post ${existingPostId} is '${current.status}', so the engine refuses to overwrite it.`);
      }
    }
    const visuals = await this.resolveVisualMedia(draft.visuals || [], null, options);
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
      signal: options.signal,
      idempotencyKey: options.idempotencyKey,
    });
    if (result.status !== "draft") throw new Error("WordPress did not confirm draft status; refusing to record the sync.");
    return {
      postId: result.id, postUrl: result.link || null, status: result.status, strategyVersion: draft.strategy_version || null,
      visuals: visuals.map((item) => ({ visualId: item.visualId, id: item.id, url: item.url })),
    };
  }

  async upsertContractDraft(publishPackage, options = {}) {
    if (!this.enabled) throw new Error("WordPress draft delivery is not configured.");
    this.deliveryGuard?.(options.draftId, { phase: 'delivery', pagePayload: options.pagePayload || publishPackage?.page });
    assertSafeSiteUrl(this.config.siteUrl);
    const configuredEndpoint = String(this.config.cmsArticleEndpoint || "").trim();
    const endpoint = configuredEndpoint || `${this.config.siteUrl}/wp-json/stc/v1/cms-articles`;
    const url = new URL(endpoint, `${this.config.siteUrl}/`);
    const site = new URL(this.config.siteUrl);
    if (url.origin !== site.origin || url.username || url.password) {
      throw new WordPressApiError("UNSAFE_CMS_ARTICLE_ENDPOINT", "The CMS Article endpoint must use the configured WordPress origin.", { status: 400 });
    }
    const existingPostId = Number.parseInt(publishPackage?.publication?.existing_post_id || "", 10);
    const expectedStatus = publishPackage?.publication?.status === 'publish' ? 'publish' : 'draft';
    if (expectedStatus === 'publish' && !(Number.isInteger(existingPostId) && existingPostId > 0)) {
      throw new WordPressApiError('PUBLISHED_REFRESH_TARGET_MISSING',
        'A published media refresh requires an existing post ID.', { status:409 });
    }
    if (Number.isInteger(existingPostId) && existingPostId > 0) url.pathname = `${url.pathname.replace(/\/$/, "")}/${existingPostId}`;
    const serializedPackage = JSON.stringify(publishPackage);
    if (Buffer.byteLength(serializedPackage, "utf8") > 1024 * 1024) {
      throw new WordPressApiError("INVALID_PAGE_SCHEMA", "The Publish Package exceeds the Frontend 1 MiB limit.", { status: 413 });
    }
    const response = await this.fetch(url, {
      method: Number.isInteger(existingPostId) && existingPostId > 0 ? "PUT" : "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.applicationPassword}`).toString("base64")}`,
        "content-type": "application/json",
        accept: "application/json",
        ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
      },
      body: serializedPackage,
      signal: combinedSignal(options.signal, 60_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = String(body?.code || "WORDPRESS_API_FAILED");
      throw new WordPressApiError(code, body?.message || response.statusText || "WordPress rejected the Publish Package.", {
        status: response.status, details: body?.data || null,
      });
    }
    if (body?.status !== expectedStatus || !Number.isInteger(body?.post_id)) {
      throw new WordPressApiError("INVALID_WORDPRESS_RESPONSE", "WordPress did not confirm the requested post status and post_id.", { status: 502, details: body });
    }
    const expectedSlots = (publishPackage?.page?.blocks || []).filter((block) => String(block?.type || "").startsWith("affiliate_"))
      .map((block) => ({ slot_key:block.data?.slot_key, affiliate_asset_id:block.data?.affiliate_asset_id,
        component_type:block.type, placement:block.data?.placement })).filter((item) => item.slot_key);
    const deliveredSlots = Array.isArray(body.commercial_slots) ? body.commercial_slots : null;
    if (expectedSlots.length && !deliveredSlots) {
      throw new WordPressApiError("COMMERCIAL_DELIVERY_RECEIPT_MISSING",
        "WordPress did not return the commercial slot delivery receipt.", { status: 502, details: { expectedSlots } });
    }
    if (deliveredSlots) {
      const delivered = new Map(deliveredSlots.map((item) => [item.slot_key, item]));
      const mismatches = expectedSlots.filter((item) => {
        const actual = delivered.get(item.slot_key);
        return !actual || actual.affiliate_asset_id !== item.affiliate_asset_id
          || actual.component_type !== item.component_type || actual.placement !== item.placement;
      });
      if (mismatches.length || delivered.size !== expectedSlots.length) {
        throw new WordPressApiError("COMMERCIAL_DELIVERY_MISMATCH",
          "WordPress stored a commercial slot manifest that differs from the selected Publish Package.",
          { status: 502, details: { expectedSlots, deliveredSlots, mismatches } });
      }
    }
    return {
      postId: body.post_id,
      postUrl: body.preview_url || null,
      previewUrl: body.preview_url || null,
      editUrl: body.edit_url || null,
      slug: body.slug || publishPackage.page?.metadata?.slug || "",
      status: body.status,
      contractVersion: body.contract_version || null,
      updated: Boolean(body.updated),
      deliveryManifest: { commercial_slots: deliveredSlots || [], page_payload_hash: body.page_payload_hash || "" },
      visuals: [],
    };
  }

  async createScopedPreviewTicket({ postId, draftId, revision, pagePayloadHash }, options = {}) {
    if (!this.enabled) throw new Error("WordPress draft preview is not configured.");
    assertSafeSiteUrl(this.config.siteUrl);
    const endpoint=new URL(`/wp-json/stc/v1/cms-articles/${Number(postId)}/preview-ticket`,`${this.config.siteUrl}/`);
    const response=await this.fetch(endpoint,{
      method:"POST",headers:{authorization:`Basic ${Buffer.from(`${this.config.username}:${this.config.applicationPassword}`).toString("base64")}`,
        "content-type":"application/json",accept:"application/json"},
      body:JSON.stringify({cms_draft_id:String(draftId || ""),cms_revision:Number(revision || 0),page_payload_hash:String(pagePayloadHash || "")}),
      signal:combinedSignal(options.signal,30_000),
    });
    const body=await response.json().catch(()=>({}));
    if (!response.ok) throw new WordPressApiError(String(body?.code || "PREVIEW_TICKET_FAILED"),
      body?.message || "WordPress could not create a scoped preview ticket.",{status:response.status,details:body?.data || null});
    let preview;
    try { preview=new URL(String(body?.preview_url || "")); } catch { preview=null; }
    const site=new URL(this.config.siteUrl);
    if (!preview || preview.origin !== site.origin || !body?.expires_at) throw new WordPressApiError("INVALID_PREVIEW_TICKET_RESPONSE",
      "WordPress returned an invalid scoped preview URL.",{status:502,details:body});
    return { mode:"scoped_preview_ticket",url:preview.toString(),postId:Number(postId),draftId:String(draftId),
      revision:Number(revision || 0),expiresAt:String(body.expires_at) };
  }

  async resolveVisualMedia(visuals, onUploaded = null, options = {}) {
    const output = [];
    const reusable = new Map();
    for (const visual of visuals.filter((item) => (
      item.status === "generated" && (item.media_path
        || (item.source_asset_id && (item.source_asset_data_url || item.source_remote_url)))
    ))) {
      const assetKey = visual.asset_fingerprint
        ? `derivative:${visual.asset_fingerprint}`
        : visual.source_asset_id ? `source:${visual.source_asset_id}`
          : visual.media_path ? `file:${path.resolve(visual.media_path)}` : null;
      if (assetKey && reusable.has(assetKey)) {
        const resolved = { visualId: visual.id, ...reusable.get(assetKey), alt: visual.alt_text, caption: visual.caption,
          role: visual.image_role, imageType: visual.image_type, acquisitionStrategy: visual.acquisition_strategy };
        output.push(resolved);
        if (onUploaded) await onUploaded(resolved);
        continue;
      }
      if (visual.wordpress_media_id && visual.wordpress_media_url) {
        const media = { id: visual.wordpress_media_id, url: visual.wordpress_media_url,
          metadata: parseMediaMetadata(visual.media_metadata || visual.media_metadata_json) };
        if (assetKey) reusable.set(assetKey, media);
        output.push({ visualId: visual.id, ...media, alt: visual.alt_text, caption: visual.caption,
          role: visual.image_role, imageType: visual.image_type, acquisitionStrategy: visual.acquisition_strategy });
        continue;
      }
      const media = await this.uploadMedia(visual, options);
      if (assetKey) reusable.set(assetKey, media);
      const resolved = { visualId: visual.id, ...media, alt: visual.alt_text, caption: visual.caption,
        role: visual.image_role, imageType: visual.image_type, acquisitionStrategy: visual.acquisition_strategy };
      output.push(resolved);
      if (onUploaded) await onUploaded(resolved);
    }
    return output;
  }

  async uploadMedia(visual, options = {}) {
    const asset = visual.media_path
      ? { filename: path.basename(visual.media_path), contentType: mimeForFilename(visual.media_path), bytes: fs.readFileSync(visual.media_path) }
      : storedAuthorizedSourceAsset(visual) || await this.downloadAuthorizedSourceAsset(visual, options);
    const response = await this.fetch(`${this.config.siteUrl}/wp-json/wp/v2/media`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.applicationPassword}`).toString("base64")}`,
        "content-type": asset.contentType,
        "content-disposition": `attachment; filename=\"${asset.filename}\"`,
        ...(options.idempotencyKey ? { "idempotency-key": `${options.idempotencyKey}:${visual.id}` } : {}),
      },
      body: asset.bytes,
      signal: combinedSignal(options.signal, 60_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.id) throw new Error(`WordPress media upload failed (${response.status}): ${body?.message || response.statusText}`);
    // WordPress owns the public derivative metadata, but it does not know the
    // CMS Source lineage. Preserve the authoritative input metadata so a media
    // upload cannot erase authorization, original-byte, or localization proof.
    const metadata = {
      ...parseMediaMetadata(visual.media_metadata || visual.media_metadata_json),
      ...wordpressMediaMetadata(body, asset),
    };
    return { id: body.id, url: metadata.url || "", metadata };
  }

  async downloadAuthorizedSourceAsset(visual, options = {}) {
    const sourceUrl = safeAuthorizedSourceImageUrl(visual.source_remote_url);
    if (!sourceUrl) throw authorizedSourceError("AUTHORIZED_SOURCE_IMAGE_INVALID", "Authorized source image URL is not an allowlisted Xiaohongshu HTTPS asset.");
    const response = await this.fetch(sourceUrl, { signal: combinedSignal(options.signal, 30_000) });
    if (!response.ok) throw authorizedSourceError("AUTHORIZED_SOURCE_IMAGE_UNAVAILABLE",
      `Authorized source image download failed (${response.status}).`, response.status);
    const contentType = String(response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (!/^image\/(?:jpeg|jpg|png|webp)$/.test(contentType)) throw authorizedSourceError("AUTHORIZED_SOURCE_IMAGE_INVALID", "Authorized source asset is not a supported image.");
    const declaredBytes = Number.parseInt(response.headers.get("content-length") || "", 10);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_SOURCE_IMAGE_BYTES) throw authorizedSourceError("AUTHORIZED_SOURCE_IMAGE_TOO_LARGE", "Authorized source asset is too large for WordPress upload.");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_SOURCE_IMAGE_BYTES) throw authorizedSourceError("AUTHORIZED_SOURCE_IMAGE_INVALID", "Authorized source asset is empty or too large for WordPress upload.");
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
        ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
      },
      signal: combinedSignal(options.signal, 60_000),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`WordPress API failed (${response.status}): ${body?.message || response.statusText}`);
    return { body, response };
  }
}

function storedAuthorizedSourceAsset(visual) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/u
    .exec(String(visual.source_asset_data_url || ""));
  if (!match) return null;
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > MAX_SOURCE_IMAGE_BYTES) {
    throw authorizedSourceError("AUTHORIZED_SOURCE_IMAGE_INVALID", "Stored authorized source image is empty or too large for WordPress upload.");
  }
  const contentType = match[1];
  return { bytes, contentType, filename: `source-${visual.id}.${extensionForContentType(contentType)}` };
}

function authorizedSourceError(code, message, status = 0) {
  return Object.assign(new Error(message), {
    code,
    status,
    retryable: status === 408 || status === 425 || status === 429 || status >= 500,
  });
}

function combinedSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
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
    if (block.type === "commercial") return `<!-- wp:group {"className":"solotochina-affiliate","metadata":{"name":"Affiliate booking resource"}} -->\n<div class="wp-block-group solotochina-affiliate">${block.html}</div>\n<!-- /wp:group -->`;
    return `<!-- wp:paragraph -->\n${block.html}\n<!-- /wp:paragraph -->`;
  });
  return injectVisuals(blocks, visuals, wordpressVisual).join("\n\n");
}

function injectVisuals(blocks, visuals, renderer) {
  const output = [...blocks];
  const ordered = [...visuals].filter((item) => item.id && item.url);
  ordered.forEach((visual, index) => {
    const position = Math.min(output.length, Math.max(1, Math.round((index + 1) * output.length / (ordered.length + 1)) + index));
    output.splice(position, 0, renderer(visual, index));
  });
  return output;
}

function wordpressVisual(visual, index = 0) {
  const caption = visual.caption ? `\n<figcaption class=\"wp-element-caption\">${escapeHtml(visual.caption)}</figcaption>` : "";
  return `<!-- wp:image {"id":${visual.id},"sizeSlug":"large","linkDestination":"none"} -->\n<figure class=\"wp-block-image size-large\"><img src=\"${escapeHtml(visual.url)}\" alt=\"${escapeHtml(visual.alt || "")}\" class=\"wp-image-${visual.id}\"${imageAttributes(visual, index === 0)}/>${caption}</figure>\n<!-- /wp:image -->`;
}

function htmlVisual(visual, index = 0) {
  const caption = visual.caption ? `<figcaption>${escapeHtml(visual.caption)}</figcaption>` : "";
  return `<figure><img src=\"${escapeHtml(visual.url)}\" alt=\"${escapeHtml(visual.alt || "")}\"${imageAttributes(visual, index === 0)}/>${caption}</figure>`;
}

function imageAttributes(visual, featured) {
  return Object.entries(responsiveImageAttributes(visual.metadata, { featured }))
    .map(([name, value]) => ` ${name}=\"${escapeHtml(value)}\"`).join("");
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
  let relationshipShown = false;
  return contentBlocks.map((block) => {
    if (block.type === "heading") return { ...block, html: `<h${block.level}>${inline(block.text)}</h${block.level}>` };
    if (block.type === "list") return { ...block, html: `<ul>${block.items.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>` };
    if (block.type === "commercial") {
      const html = commercialBlockHtml(block);
      if (!html) return { ...block, html };
      const notice = relationshipShown ? "" : '<p class="stc-affiliate-relationship">We may earn a commission from bookings through these links. <a href="/affiliate-disclosure/">How affiliate links work</a></p>';
      relationshipShown = true;
      return { ...block, html: `${notice}${html}` };
    }
    return { ...block, html: `<p>${inline(block.text)}</p>` };
  });
}

function commercialBlockHtml(block) {
  const allowedComponents = new Set(["affiliate_booking_card", "affiliate_product_card", "affiliate_search_card", "affiliate_comparison_card", "affiliate_banner", "affiliate_promotion_card"]);
  if (!allowedComponents.has(block.component) || !block.data || typeof block.data !== "object") return "";
  const data = block.data;
  const targetUrl = safeCommercialUrl(data.target_url);
  const embedUrl = safeCommercialEmbedUrl(data.embed_config?.src, data.provider);
  const attributes = [
    ["data-affiliate-asset", data.affiliate_asset_id], ["data-affiliate-provider", data.provider],
    ["data-affiliate-category", data.product_category], ["data-affiliate-slot", block.slot_key],
    ["data-affiliate-component", block.component],
  ].filter(([, value]) => value).map(([key, value]) => `${key}="${escapeHtml(value)}"`).join(" ");
  const action = targetUrl
    ? `<a class="stc-button stc-dynamic-component__action" href="${escapeHtml(targetUrl)}" rel="sponsored nofollow noopener" target="_blank">${escapeHtml(data.cta_label || "View option")}</a>`
    : embedUrl ? `<iframe src="${escapeHtml(embedUrl)}" title="${escapeHtml(data.title || "Booking search")}" loading="lazy" sandbox="allow-forms allow-popups allow-scripts" referrerpolicy="strict-origin-when-cross-origin"></iframe>` : "";
  if (!action) return "";
  const labels = {HOTEL:"Hotels & Homes",FLIGHT:"Flights",TRAIN:"Trains",ATTRACTION:"Attractions & Tickets",TOUR_ACTIVITY:"Tours & Tickets",AIRPORT_TRANSFER:"Airport Transfers",PLANNER:"Trip Planning"};
  const category = labels[data.product_category] || String(data.product_category || "Travel booking").replaceAll("_", " ");
  const offer = /\b(?:up to\s+)?\d{1,2}%\s+off\b/i.test(String(data.price_text || "")) ? String(data.price_text) : "";
  return `<aside class="solotochina-commercial stc-dynamic-component stc-commercial-component ${escapeHtml(block.component)}" ${attributes}><div class="stc-dynamic-component__body"><p class="stc-dynamic-component__eyebrow">${escapeHtml(data.provider)}</p><p class="stc-commercial-component__category">${escapeHtml(category)}</p><h3>${escapeHtml(offer || data.title || "Booking resource")}</h3>${data.description ? `<p class="stc-commercial-component__detail">${escapeHtml(data.description)}</p>` : ""}</div>${action}</aside>`;
}

function safeCommercialUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : "";
  } catch { return ""; }
}

function safeCommercialEmbedUrl(value, provider) {
  const url = safeCommercialUrl(value);
  if (!url) return "";
  const host = new URL(url).hostname.toLowerCase();
  if (/trip/i.test(String(provider || "")) && !["trip.com", "tripcdn.com", "ctrip.com"].some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return "";
  return url;
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
