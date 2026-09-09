import crypto from "node:crypto";

const PROMISE_TERMS = ["ultimate", "complete", "comprehensive", "all-inclusive", "cheapest", "secret", "hidden"];

export function resolveCanonicalUrl({ siteUrl = "", slug = "", publishedUrl = "", publishedStatus = "" } = {}) {
  const site = safePublicUrl(siteUrl);
  if (!site) return { url: null, status: "unverified", reason: "PUBLIC_CONTENT_SITE_URL is not a valid public HTTP(S) origin." };
  if (publishedStatus === "publish" && publishedUrl) {
    const published = safePublicUrl(publishedUrl, site.origin);
    if (published && !isPreviewUrl(published)) return { url: canonicalPageUrl(published), status: "verified_published_url", reason: null };
  }
  const normalizedSlug = String(slug || "").trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalizedSlug)) {
    return { url: null, status: "unverified", reason: "The public slug is missing or invalid." };
  }
  const url = new URL(`${normalizedSlug}/`, `${site.origin}${site.pathname.replace(/\/?$/, "/")}`);
  return { url: canonicalPageUrl(url), status: "configured_route", reason: "Derived from the configured public site and validated slug; final theme routing remains a Frontend check." };
}

export function buildSeoPreview(draft = {}) {
  const title = String(draft.seo?.meta_title || draft.title || "").trim();
  const description = String(draft.meta_description || draft.seo?.meta_description || "").trim();
  return {
    title, description,
    titleCharacters: [...title].length,
    descriptionCharacters: [...description].length,
    titleGuidance: [...title].length > 60 ? "long" : "within_editorial_guidance",
    descriptionGuidance: [...description].length > 160 ? "long" : "within_editorial_guidance",
    disclaimer: "Editing preview only. Search engines may rewrite or truncate titles and descriptions; no CTR or display is promised.",
  };
}

export function titlePromiseRisks(title, brief = {}, facts = []) {
  const normalizedTitle = normalize(title);
  const support = normalize([brief.topic, brief.plan?.title, brief.plan?.reader_promise,
    ...facts.map((fact) => `${fact.subject || ""} ${fact.predicate || ""} ${fact.preferred_value || ""}`)].join(" "));
  return PROMISE_TERMS.filter((term) => normalizedTitle.includes(term) && !support.includes(term));
}

export function synchronizeSeoMetadata(pagePayload, draft, { supportedMetadataFields = null } = {}) {
  const page = structuredClone(pagePayload || {});
  page.metadata ||= {};
  const supports = (field) => supportedMetadataFields == null || supportedMetadataFields.has(field);
  const canonical = safePublicUrl(draft?.seo?.canonical_url)?.toString() || null;
  const title = String(draft?.seo?.meta_title || draft?.title || "").trim();
  const description = String(draft?.meta_description || draft?.seo?.meta_description || "").trim();
  page.metadata.title = String(draft?.title || page.metadata.title || "").trim();
  if (supports("excerpt")) page.metadata.excerpt = description;
  if (supports("seo")) page.metadata.seo = { title, description, robots: "noindex,nofollow", ...(canonical ? { canonicalUrl: canonical } : {}) };
  if (supports("canonicalUrl")) {
    if (canonical) page.metadata.canonicalUrl = canonical;
    else delete page.metadata.canonicalUrl;
  }
  return page;
}

export function validateSeoGeoArtifact({ page, draft, schema, internalLinks = [] } = {}) {
  const errors = [];
  const title = String(draft?.title || "").trim();
  const metaTitle = String(draft?.seo?.meta_title || title).trim();
  const description = String(draft?.meta_description || "").trim();
  const metadata = page?.metadata || {};
  const canonical = safePublicUrl(draft?.seo?.canonical_url)?.toString() || null;
  if (!title || metadata.title !== title) errors.push({ code: "SEO_TITLE_MISMATCH", path: "$.page.metadata.title" });
  if (!description || metadata.seo?.description !== description || metadata.excerpt !== description) {
    errors.push({ code: "SEO_DESCRIPTION_MISMATCH", path: "$.page.metadata.seo.description" });
  }
  if (metadata.seo?.title !== metaTitle) errors.push({ code: "SEO_META_TITLE_MISMATCH", path: "$.page.metadata.seo.title" });
  if (normalize(metaTitle) === normalize(description)) errors.push({ code: "SEO_TITLE_DESCRIPTION_DUPLICATE", path: "$.seo" });
  if ("keywords" in (metadata.seo || {}) || "meta_keywords" in (metadata.seo || {})) errors.push({ code: "META_KEYWORDS_FORBIDDEN", path: "$.page.metadata.seo" });
  const canonicalValues = [metadata.canonicalUrl, metadata.seo?.canonicalUrl, ...schemaCanonicalUrls(schema)].filter(Boolean);
  if (canonical && canonicalValues.some((value) => canonicalPageUrl(value) !== canonicalPageUrl(canonical))) {
    errors.push({ code: "CANONICAL_CONFLICT", path: "$.schema_jsonld" });
  }
  if (canonicalValues.some((value) => isPreviewUrl(value) || /(?:^|\/)wp-admin(?:\/|$)/i.test(String(value)))) {
    errors.push({ code: "CANONICAL_NOT_PUBLIC", path: "$.page.metadata.canonicalUrl" });
  }
  errors.push(...validateStructuredData(schema, page, draft));
  errors.push(...validateInternalLinks(page, internalLinks));
  return { valid: errors.length === 0, errors };
}

export function selectInternalLinks(inventory = [], { siteUrl = "", topic = "", entities = [], limit = 12 } = {}) {
  const site = safePublicUrl(siteUrl);
  if (!site) return [];
  const contextTokens = tokens(`${topic} ${(entities || []).join(" ")}`);
  return inventory.map((item) => {
    const url = safePublicUrl(item.post_url || item.postUrl, site.origin);
    if (!isPublicInventoryItem(item) || !url || isPreviewUrl(url)) return null;
    const itemTokens = tokens(`${item.title || ""} ${item.slug || ""}`);
    const overlap = [...itemTokens].filter((token) => contextTokens.has(token));
    if (!overlap.length) return null;
    return { post_id: Number(item.post_id || item.postId), status: "publish", public_accessibility: "inventory_confirmed",
      title: String(item.title || ""), url: canonicalPageUrl(url),
      slug: String(item.slug || ""), modified_at: item.modified_at || item.modifiedAt || null,
      relationship: overlap.slice(0, 5), score: overlap.length / Math.max(1, Math.min(itemTokens.size, contextTokens.size)) };
  }).filter(Boolean).sort((a, b) => b.score - a.score || a.post_id - b.post_id).slice(0, limit);
}

export function inventoryVersion(items = [], syncedAt = null) {
  return { synced_at: syncedAt || null, hash: crypto.createHash("sha256").update(JSON.stringify(items.map((item) => [
    item.post_id || item.postId, item.status, item.post_url || item.postUrl, item.modified_at || item.modifiedAt,
  ]))).digest("hex") };
}

export function inventoryTargetChanges(previous = [], next = []) {
  const nextById = new Map(next.map((item) => [Number(item.post_id || item.postId), item]));
  return previous.filter((item) => item.status === "publish").map((item) => {
    const current = nextById.get(Number(item.post_id || item.postId));
    const oldUrl = canonicalPageUrl(item.post_url || item.postUrl);
    const newUrl = current ? canonicalPageUrl(current.post_url || current.postUrl) : "";
    if (current?.status === "publish" && oldUrl === newUrl) return null;
    return { post_id: Number(item.post_id || item.postId), old_url: oldUrl || null,
      new_url: newUrl || null, old_status: item.status, new_status: current?.status || "removed" };
  }).filter(Boolean);
}

export function affectedInternalLinkBlocks(page, changes = []) {
  const targets = changes.map((item) => item.old_url).filter(Boolean);
  return (page?.blocks || []).flatMap((block, index) => {
    let affected = false;
    visitStrings(block, (text) => { if (targets.some((url) => String(text).includes(url) || String(text).includes(url.replace(/\/$/, "")))) affected = true; });
    return affected ? [index] : [];
  });
}

export function duplicateContentRisks(inventory = [], { title = "", entities = [], currentPostId = null } = {}) {
  const target = tokens(`${title} ${(entities || []).join(" ")}`);
  return inventory.filter((item) => item.status === "publish" && Number(item.post_id) !== Number(currentPostId)).map((item) => {
    const candidate = tokens(`${item.title || ""} ${item.slug || ""}`);
    const shared = [...target].filter((token) => candidate.has(token));
    const similarity = shared.length / Math.max(1, Math.min(target.size, candidate.size));
    return similarity >= 0.6 ? { post_id: item.post_id, title: item.title, url: item.post_url, similarity,
      reason: `Shared topic/entity terms: ${shared.join(", ")}. Editorial review is required and no automatic action is taken.` } : null;
  }).filter(Boolean).sort((a, b) => b.similarity - a.similarity);
}

function validateStructuredData(schema, page, draft) {
  const errors = [];
  const nodes = schemaNodes(schema);
  const article = nodes.find((node) => types(node).some((type) => ["Article", "BlogPosting"].includes(type)));
  if (!article) errors.push({ code: "ARTICLE_SCHEMA_MISSING", path: "$.schema_jsonld" });
  else if (String(article.headline || "").trim() !== String(page?.metadata?.title || "").trim()) {
    errors.push({ code: "SCHEMA_HEADLINE_MISMATCH", path: "$.schema_jsonld.headline" });
  }
  if (nodes.some((node) => types(node).some((type) => ["Product", "QAPage"].includes(type)))) {
    errors.push({ code: "UNSUPPORTED_SCHEMA_TYPE", path: "$.schema_jsonld" });
  }
  const visibleFaq = (page?.blocks || []).filter((block) => block?.type === "faq")
    .flatMap((block) => block.data?.items || []).map((item) => [normalize(item.question), normalize(stripHtml(item.answer))]);
  const faqNode = nodes.find((node) => types(node).includes("FAQPage"));
  const schemaFaq = (faqNode?.mainEntity || []).map((item) => [normalize(item.name), normalize(stripHtml(item.acceptedAnswer?.text))]);
  if (JSON.stringify(visibleFaq) !== JSON.stringify(schemaFaq)) errors.push({ code: "FAQ_SCHEMA_VISIBLE_MISMATCH", path: "$.schema_jsonld" });
  if (draft?.published_at == null && nodes.some((node) => node.datePublished)) errors.push({ code: "DRAFT_DATE_PUBLISHED_FORGED", path: "$.schema_jsonld.datePublished" });
  return errors;
}

function validateInternalLinks(page, inventory) {
  const allowed = new Map((inventory || []).filter(isPublicInventoryItem)
    .map((item) => [canonicalPageUrl(item.url || item.post_url), item]));
  const pageOrigin = safePublicUrl(page?.metadata?.canonicalUrl || page?.metadata?.seo?.canonicalUrl)?.origin;
  const origins = new Set([...allowed.keys()].map((url) => safePublicUrl(url)?.origin).filter(Boolean));
  if (pageOrigin) origins.add(pageOrigin);
  const links = [];
  visitStrings(page?.blocks || [], (text) => {
    for (const match of text.matchAll(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      links.push({ href: match[1], anchor: stripHtml(match[2]) });
    }
  });
  const errors = [];
  const anchorCounts = new Map();
  for (const { href, anchor } of links) {
    const url = safePublicUrl(href) || (pageOrigin ? safePublicUrl(new URL(href, pageOrigin)) : null);
    if (!url || !origins.has(url.origin)) continue;
    const canonical = canonicalPageUrl(url);
    const target = allowed.get(canonical);
    if (!target) {
      errors.push({ code: "UNVERIFIED_INTERNAL_LINK", path: "$.page.blocks", url: canonical });
      continue;
    }
    const anchorTokens = tokens(anchor);
    const targetTokens = tokens(`${target.title || ""} ${target.slug || ""}`);
    const relevant = [...anchorTokens].some((token) => targetTokens.has(token));
    if (!anchor || !relevant || /^(?:click here|read more|learn more)$/i.test(anchor.trim())) {
      errors.push({ code: "INTERNAL_LINK_ANCHOR_MISMATCH", path: "$.page.blocks", url: canonical, anchor });
    }
    const key = normalize(anchor);
    anchorCounts.set(key, (anchorCounts.get(key) || 0) + 1);
  }
  for (const [anchor, count] of anchorCounts) {
    if (anchor && count > 2) errors.push({ code: "INTERNAL_LINK_ANCHOR_STUFFING", path: "$.page.blocks", anchor, count });
  }
  return errors;
}

function isPublicInventoryItem(item) {
  const accessibility = String(item?.public_accessibility || item?.accessibility || "").toLowerCase();
  return item?.status === "publish" && !["404", "broken", "cancelled", "canceled", "redirect", "private", "unavailable"].includes(accessibility);
}

function schemaCanonicalUrls(schema) {
  return schemaNodes(schema).filter((node) => types(node).some((type) => ["Article", "BlogPosting", "WebPage"].includes(type)))
    .flatMap((node) => [node?.url, types(node).includes("WebPage") ? node?.["@id"] : null, node?.mainEntityOfPage?.["@id"]])
    .filter((value) => typeof value === "string" && /^https?:/i.test(value));
}

function schemaNodes(schema) {
  if (!schema || typeof schema !== "object") return [];
  return [...(Array.isArray(schema["@graph"]) ? schema["@graph"] : []), ...(schema["@type"] ? [schema] : [])];
}

function types(node) { return (Array.isArray(node?.["@type"]) ? node["@type"] : [node?.["@type"]]).filter(Boolean); }
function stripHtml(value) { return String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }
function normalize(value) { return stripHtml(value).normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }
function tokens(value) { return new Set(normalize(value).split(" ").filter((token) => token.length > 2 && !["the", "and", "for", "guide", "travel", "china"].includes(token))); }
function isPreviewUrl(value) { const url = value instanceof URL ? value : safePublicUrl(value); return Boolean(url && (/preview=true/i.test(url.search) || /(?:^|\/)(?:preview|wp-admin)(?:\/|$)/i.test(url.pathname))); }
function canonicalPageUrl(value) { const url = value instanceof URL ? new URL(value) : safePublicUrl(value); if (!url) return ""; url.hash = ""; url.search = ""; url.pathname = url.pathname.replace(/\/+$/, "") + "/"; return url.toString(); }
function safePublicUrl(value, requiredOrigin = null) {
  try {
    const url = value instanceof URL ? new URL(value) : new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || (requiredOrigin && url.origin !== requiredOrigin)) return null;
    return url;
  } catch { return null; }
}

function visitStrings(value, callback) {
  if (typeof value === "string") callback(value);
  else if (Array.isArray(value)) value.forEach((item) => visitStrings(item, callback));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => visitStrings(item, callback));
}
