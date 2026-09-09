import crypto from "node:crypto";

export function validateRenderedHtmlArtifact({
  html = "", status = "", url = "", httpStatus = 0, headers = {}, robotsTxt = "", sitemapXml = "",
  expectedTitle = "", expectedDescription = "", authenticated = false, fixture = {}, productionCost = null,
} = {}) {
  const errors = [];
  const pageUrl = publicUrl(url);
  const lowerHeaders = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  const metaRobots = metaContent(html, "robots").toLowerCase();
  const xRobots = String(lowerHeaders["x-robots-tag"] || "").toLowerCase();
  const canonical = linkHref(html, "canonical");
  const title = tagText(html, "title");
  const description = metaContent(html, "description");
  const h1s = [...String(html).matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((match) => stripHtml(match[1]));
  const initialBody = articleText(html);
  const indexable = !/\bnoindex\b/.test(`${metaRobots} ${xRobots}`);
  const sitemapIncluded = Boolean(pageUrl && normalizeXml(sitemapXml).includes(pageUrl.toString()));
  const robotsAllowed = pageUrl ? robotsAllows(robotsTxt, pageUrl.pathname) : false;

  if (!pageUrl || httpStatus !== 200) errors.push({ code: "PUBLIC_PAGE_UNAVAILABLE", path: "$.rendered_html" });
  if (status === "publish") {
    if (authenticated) errors.push({ code: "PUBLISHED_PAGE_REQUIRES_AUTH", path: "$.crawler_configuration" });
    if (!indexable) errors.push({ code: "PUBLISHED_PAGE_NOINDEX", path: "$.seo_artifact.robots" });
    if (!robotsAllowed) errors.push({ code: "PUBLISHED_PAGE_ROBOTS_BLOCKED", path: "$.crawler_configuration.robots_txt" });
    if (!sitemapIncluded) errors.push({ code: "PUBLISHED_PAGE_MISSING_FROM_SITEMAP", path: "$.crawler_configuration.sitemap" });
  } else if (status === "draft" || status === "preview") {
    if (indexable) errors.push({ code: "DRAFT_PAGE_INDEXABLE", path: "$.seo_artifact.robots" });
    if (sitemapIncluded) errors.push({ code: "DRAFT_PAGE_IN_SITEMAP", path: "$.crawler_configuration.sitemap" });
  } else errors.push({ code: "PUBLICATION_STATUS_UNKNOWN", path: "$.status" });

  if (status === "publish") {
    if (h1s.length !== 1) errors.push({ code: "H1_COUNT_INVALID", path: "$.rendered_html.h1", count: h1s.length });
    if (!title || (expectedTitle && title !== expectedTitle)) errors.push({ code: "HTML_TITLE_MISMATCH", path: "$.seo_artifact.title" });
    if (!description || (expectedDescription && description !== expectedDescription)) errors.push({ code: "HTML_DESCRIPTION_MISMATCH", path: "$.seo_artifact.description" });
    if (!pageUrl || canonicalPageUrl(canonical) !== canonicalPageUrl(pageUrl)) errors.push({ code: "HTML_CANONICAL_MISMATCH", path: "$.seo_artifact.canonical" });
    if (initialBody.length < 120 || /^(?:read|show|view) more\.?$/i.test(initialBody)) errors.push({ code: "INITIAL_HTML_BODY_MISSING", path: "$.rendered_html.body" });
    if (/data-(?:lazy|deferred)-content|<template\b[^>]*data-(?:article|content)/i.test(html)) errors.push({ code: "CRITICAL_BODY_DEFERRED", path: "$.rendered_html.body" });
    errors.push(...validateHtmlLinks(html, pageUrl));
    errors.push(...validateHtmlImages(html, pageUrl));
    errors.push(...validateHtmlSchema(html, pageUrl, h1s[0] || expectedTitle));
  }

  const dimensions = {
    content_quality: dimension(!errors.some((item) => ["H1_COUNT_INVALID", "INITIAL_HTML_BODY_MISSING", "CRITICAL_BODY_DEFERRED"].includes(item.code)), initialBody.length),
    seo_artifact: dimension(!errors.some((item) => item.path?.startsWith("$.seo_artifact")), { title, description, canonical: canonical || null }),
    structured_data: dimension(!errors.some((item) => item.path?.startsWith("$.structured_data")), "visible/schema consistency only"),
    rendered_html: dimension(!errors.some((item) => item.path?.startsWith("$.rendered_html")), fixture),
    crawler_configuration: dimension(!errors.some((item) => item.path?.startsWith("$.crawler_configuration")), {
      metaRobots: metaRobots || null, xRobotsTag: xRobots || null, robotsAllowed, sitemapIncluded, authenticated,
      note: "noindex, robots.txt and authentication are separate controls",
    }),
    production_cost: productionCost == null ? { status: "not_tested", value: null } : { status: "measured", value: productionCost },
  };
  return { valid: errors.length === 0, errors, dimensions,
    conclusions: { ranking: "not_tested", indexing: "not_tested", aiCitation: "not_tested" } };
}

export function compareRenderedVariants(variants = {}) {
  const entries = Object.entries(variants).map(([name, html]) => [name, articleFingerprint(html)]);
  const unique = new Set(entries.map(([, hash]) => hash));
  return { valid: unique.size <= 1, variants: Object.fromEntries(entries),
    errors: unique.size <= 1 ? [] : [{ code: "RENDERED_FACT_VARIANT_MISMATCH", path: "$.rendered_html.variants" }] };
}

function validateHtmlLinks(html, pageUrl) {
  const errors = [];
  for (const match of String(html).matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)) {
    const value = match[1];
    if (/^(?:#|mailto:|tel:)/i.test(value)) continue;
    let target;
    try { target = new URL(value, pageUrl); } catch { target = null; }
    if (!target || !/^https?:$/.test(target.protocol) || /preview=true|\/wp-admin(?:\/|$)/i.test(target.toString())) {
      errors.push({ code: "HTML_LINK_INVALID", path: "$.rendered_html.links", url: value });
    }
  }
  return errors;
}

function validateHtmlImages(html, pageUrl) {
  const errors = [];
  const images = [...String(html).matchAll(/<img\b([^>]*)>/gi)];
  images.forEach((match, index) => {
    const attrs = attributes(match[1]);
    let src;
    try { src = new URL(attrs.src || "", pageUrl); } catch { src = null; }
    if (!src || !/^https?:$/.test(src.protocol) || /^data:/i.test(attrs.src || "") || hasSignedQuery(src)) {
      errors.push({ code: "HTML_IMAGE_URL_INVALID", path: `$.rendered_html.images[${index}]` });
    }
    if (!(Number(attrs.width) > 0 && Number(attrs.height) > 0)) errors.push({ code: "HTML_IMAGE_DIMENSIONS_MISSING", path: `$.rendered_html.images[${index}]` });
    if (index === 0 && /lazy/i.test(attrs.loading || "")) errors.push({ code: "LCP_IMAGE_LAZY", path: `$.rendered_html.images[0]` });
    if (index > 0 && attrs.loading !== "lazy") errors.push({ code: "NON_LCP_IMAGE_NOT_LAZY", path: `$.rendered_html.images[${index}]` });
  });
  return errors;
}

function validateHtmlSchema(html, pageUrl, h1) {
  const errors = [];
  const scripts = [...String(html).matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const nodes = [];
  for (const [index, match] of scripts.entries()) {
    try {
      const schema = JSON.parse(match[1]);
      nodes.push(...(Array.isArray(schema["@graph"]) ? schema["@graph"] : [schema]));
    } catch { errors.push({ code: "HTML_SCHEMA_JSON_INVALID", path: `$.structured_data[${index}]` }); }
  }
  const article = nodes.find((node) => [node?.["@type"]].flat().some((type) => ["Article", "BlogPosting"].includes(type)));
  if (!article) errors.push({ code: "HTML_ARTICLE_SCHEMA_MISSING", path: "$.structured_data" });
  else {
    if (stripHtml(article.headline) !== stripHtml(h1)) errors.push({ code: "HTML_SCHEMA_HEADLINE_MISMATCH", path: "$.structured_data.headline" });
    const urls = [article.url, article.mainEntityOfPage?.["@id"]].filter(Boolean);
    if (urls.some((value) => canonicalPageUrl(value) !== canonicalPageUrl(pageUrl))) errors.push({ code: "HTML_SCHEMA_URL_MISMATCH", path: "$.structured_data.url" });
  }
  if (nodes.some((node) => [node?.["@type"]].flat().includes("QAPage"))) errors.push({ code: "HTML_UNSUPPORTED_SCHEMA_TYPE", path: "$.structured_data" });
  return errors;
}

function articleFingerprint(html) { return crypto.createHash("sha256").update(articleText(html).normalize("NFKC").replace(/\s+/g, " ").trim()).digest("hex"); }
function articleText(html) { const match = String(html).match(/<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)>/i); return stripHtml(match?.[1] || ""); }
function stripHtml(value) { return String(value || "").replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim(); }
function tagText(html, tag) { return stripHtml(String(html).match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1] || ""); }
function metaContent(html, name) { for (const match of String(html).matchAll(/<meta\b([^>]*)>/gi)) { const attrs = attributes(match[1]); if (String(attrs.name || "").toLowerCase() === name) return attrs.content || ""; } return ""; }
function linkHref(html, rel) { for (const match of String(html).matchAll(/<link\b([^>]*)>/gi)) { const attrs = attributes(match[1]); if (String(attrs.rel || "").toLowerCase().split(/\s+/).includes(rel)) return attrs.href || ""; } return ""; }
function attributes(fragment) { return Object.fromEntries([...String(fragment).matchAll(/([:\w-]+)\s*=\s*["']([^"']*)["']/g)].map((match) => [match[1].toLowerCase(), match[2]])); }
function publicUrl(value) { try { const url = new URL(String(value || "")); return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url : null; } catch { return null; } }
function canonicalPageUrl(value) { const url = value instanceof URL ? new URL(value) : publicUrl(value); if (!url) return ""; url.search = ""; url.hash = ""; url.pathname = url.pathname.replace(/\/+$/, "") + "/"; return url.toString(); }
function normalizeXml(value) { return String(value || "").replace(/&amp;/g, "&"); }
function robotsAllows(value, pathname) { const lines = String(value || "").split(/\r?\n/).map((line) => line.replace(/#.*/, "").trim()); const disallowed = lines.filter((line) => /^disallow\s*:/i.test(line)).map((line) => line.split(":").slice(1).join(":").trim()).filter(Boolean); return !disallowed.some((route) => route === "/" || pathname.startsWith(route)); }
function hasSignedQuery(url) { return [...url.searchParams.keys()].some((key) => /^(?:token|signature|x-amz-|x-goog-)/i.test(key)); }
function dimension(passed, detail) { return { status: passed ? "passed" : "failed", detail }; }
