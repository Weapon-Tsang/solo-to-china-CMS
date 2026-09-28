import crypto from "node:crypto";
import { parseSeoHtml, visibleText, isStaticallyHidden, articleVisibleText, htmlText, elementAttributes } from './seo-html.mjs';
import { inspectIndexDirectives, inspectRobotsTxt, isPublicArtifactUrl, normalizeObservedUrl, structuredDataNodes } from './seo-observation.mjs';
import { inspectSitemap } from './seo-sitemap.mjs';

export function validateRenderedHtmlArtifact({
  html = "", status = "", url = "", httpStatus = 0, headers = {}, robotsTxt = null, sitemapXml = "",
  expectedTitle = "", expectedDescription = "", expectedCommercialSlots = [], expectedMediaIds = [],
  expectedDocumentTitle = expectedTitle, expectedH1 = expectedTitle, crawlerAgent = 'Googlebot', robotsHttpStatus = 200,
  imageObservations = [], lcpObservation = null,
  expectedFacts = [], expectedSchemaEvidence = {}, expectedCanonicalUrl = '',
  sitemapDocuments = {}, checkedAt = new Date().toISOString(), pageRevision = null, evidenceSource = 'provided_artifact',
  authenticated = false, fixture = {}, productionCost = null,
} = {}) {
  const errors = [];
  const warnings = [];
  const pageUrl = publicUrl(url);
  if (!pageUrl || httpStatus !== 200) {
    const unknown = () => ({ status: 'unknown', source: evidenceSource, checkedAt, pageRevision, detail: { httpStatus } });
    return { valid: null, status: 'pending', errors: [], warnings: [{ code: 'PUBLIC_PAGE_UNAVAILABLE', httpStatus }],
      health: Object.fromEntries(['content', 'media', 'canonical', 'indexability', 'schema', 'internal-links', 'sitemap', 'crawler', 'field-data'].map(key => [key, unknown()])),
      dimensions: Object.fromEntries(['content_quality', 'seo_artifact', 'structured_data', 'rendered_html', 'crawler_configuration', 'production_cost', 'lcp'].map(key => [key, unknown()])),
      conclusions: { ranking: 'not_tested', indexing: 'not_tested', aiCitation: 'not_tested' } };
  }
  const document = parseSeoHtml(html);
  const lowerHeaders = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  const robotMeta = [...document.querySelectorAll('meta')].map(elementAttributes);
  const directiveResult = inspectIndexDirectives({ meta: robotMeta, headers, agent: crawlerAgent });
  const metaRobots = robotMeta.filter(item => item.name?.toLowerCase() === 'robots').map(item => item.content || '').join(',');
  const xRobots = String(lowerHeaders["x-robots-tag"] || "").toLowerCase();
  const canonical = [...document.querySelectorAll('link')].find(node => node.rel?.toLowerCase().split(/\s+/).includes('canonical'))?.getAttribute('href') || '';
  const title = document.querySelector('title')?.textContent.trim() || '';
  const description = robotMeta.find(item => item.name?.toLowerCase() === 'description')?.content || '';
  const headMeta = [...document.querySelectorAll('head meta')].map(elementAttributes);
  const headLinks = [...document.querySelectorAll('head link')].map(elementAttributes);
  const outputGroups = {
    title: [...document.querySelectorAll('head title')].map(node => node.textContent.trim()),
    description: headMeta.filter(item => item.name?.toLowerCase() === 'description').map(item => item.content || ''),
    canonical: headLinks.filter(item => item.rel?.toLowerCase().split(/\s+/).includes('canonical')).map(item => item.href || ''),
  };
  for (const item of headMeta) if (item.property?.toLowerCase().startsWith('og:')) {
    (outputGroups[item.property.toLowerCase()] ||= []).push(item.content || '');
  }
  for (const [field, values] of Object.entries(outputGroups)) if (values.length > 1) {
    if (new Set(values).size > 1 && field !== 'og:image') errors.push({ code: 'HTML_HEAD_OUTPUT_CONFLICT', path: `$.seo_artifact.${field}`, values });
    else warnings.push({ code: 'HTML_HEAD_MULTIPLE_OUTPUTS', field, count: values.length });
  }
  const h1s = [...document.querySelectorAll('h1')].filter(node => !isStaticallyHidden(node)).map(visibleText);
  const initialBody = articleText(html);
  const indexable = directiveResult.indexable;
  const sitemapObservation = inspectSitemap(sitemapXml, url, { documents: sitemapDocuments });
  const sitemapIncluded = sitemapObservation.included;
  const robotsObservation = inspectRobotsTxt(robotsTxt, { agent: crawlerAgent, path: pageUrl ? pageUrl.pathname + pageUrl.search : '/', httpStatus: robotsHttpStatus });
  const robotsAllowed = pageUrl ? robotsObservation.allowed : null;

  if (status === "publish") {
    if (authenticated) errors.push({ code: "PUBLISHED_PAGE_REQUIRES_AUTH", path: "$.crawler_configuration" });
    if (!indexable) errors.push({ code: "PUBLISHED_PAGE_NOINDEX", path: "$.seo_artifact.robots" });
    if (robotsAllowed === false) errors.push({ code: "PUBLISHED_PAGE_ROBOTS_BLOCKED", path: "$.crawler_configuration.robots_txt" });
    if (sitemapIncluded === false) errors.push({ code: "PUBLISHED_PAGE_MISSING_FROM_SITEMAP", path: "$.crawler_configuration.sitemap" });
  } else if (status === "draft" || status === "preview") {
    if (indexable) errors.push({ code: "DRAFT_PAGE_INDEXABLE", path: "$.seo_artifact.robots" });
    if (sitemapIncluded) errors.push({ code: "DRAFT_PAGE_IN_SITEMAP", path: "$.crawler_configuration.sitemap" });
  } else errors.push({ code: "PUBLICATION_STATUS_UNKNOWN", path: "$.status" });

  if (h1s.length !== 1) errors.push({ code: "H1_COUNT_INVALID", path: "$.rendered_html.h1", count: h1s.length });
  if (!title || (expectedDocumentTitle && title !== expectedDocumentTitle)) {
    errors.push({ code: "HTML_TITLE_MISMATCH", path: "$.seo_artifact.title" });
  }
  if (expectedH1 && h1s[0] !== expectedH1) errors.push({ code: "HTML_H1_MISMATCH", path: "$.rendered_html.h1" });
  if (directiveResult.conflicts.length) errors.push({ code: 'ROBOTS_DIRECTIVE_CONFLICT', path: '$.seo_artifact.robots', conflicts: directiveResult.conflicts });
  if (!initialBody || (expectedH1 && initialBody === expectedH1) || /^(?:read|show|view) more\.?$/i.test(initialBody)
      || /(?:wp-login\.php|user_login|lost your password|nothing found|page not found)/i.test(`${url} ${html}`)) {
    errors.push({ code: "INITIAL_HTML_BODY_MISSING", path: "$.rendered_html.body" });
  }
  if (/data-(?:lazy|deferred)-content|<template\b[^>]*data-(?:article|content)/i.test(html)) {
    errors.push({ code: "CRITICAL_BODY_DEFERRED", path: "$.rendered_html.body" });
  }
  for (const fact of expectedFacts) if (!initialBody.includes(stripHtml(fact))) errors.push({
    code: 'IMPORTANT_FACT_NOT_VISIBLE', path: '$.rendered_html.body', fact,
  });
  errors.push(...validateHtmlLinks(html, pageUrl));
  errors.push(...validateHtmlImages(html, pageUrl, imageObservations, lcpObservation, warnings));
  errors.push(...validateExpectedMedia(html, expectedMediaIds));
  errors.push(...validateCommercialSlots(html, expectedCommercialSlots));

  if (status === "publish") {
    if (!description || (expectedDescription && description !== expectedDescription)) errors.push({ code: "HTML_DESCRIPTION_MISMATCH", path: "$.seo_artifact.description" });
    if (!pageUrl || canonicalPageUrl(canonical) !== canonicalPageUrl(pageUrl)) errors.push({ code: "HTML_CANONICAL_MISMATCH", path: "$.seo_artifact.canonical" });
  }
  const preview = status === 'draft' || status === 'preview';
  const schemaUrl = preview && expectedCanonicalUrl ? publicUrl(expectedCanonicalUrl) : pageUrl;
  if (preview && expectedCanonicalUrl && (!schemaUrl || !isPublicArtifactUrl(expectedCanonicalUrl) || /[?&](?:preview|preview_id|preview_nonce)=/i.test(expectedCanonicalUrl)))
    errors.push({ code: 'HTML_CANONICAL_EXPECTATION_INVALID', path: '$.seo_artifact.canonical' });
  if (preview && expectedCanonicalUrl && canonical && canonicalPageUrl(canonical) !== canonicalPageUrl(schemaUrl))
    errors.push({ code: 'HTML_CANONICAL_MISMATCH', path: '$.seo_artifact.canonical' });
  errors.push(...validateHtmlSchema(html, schemaUrl, h1s[0] || expectedTitle, status, expectedSchemaEvidence));

  const dimensions = {
    content_quality: dimension(!errors.some((item) => ["H1_COUNT_INVALID", "HTML_H1_MISMATCH", "INITIAL_HTML_BODY_MISSING", "CRITICAL_BODY_DEFERRED", "IMPORTANT_FACT_NOT_VISIBLE"].includes(item.code)), initialBody.length),
    seo_artifact: dimension(!errors.some((item) => item.path?.startsWith("$.seo_artifact")), { title, description, canonical: canonical || null }),
    structured_data: dimension(!errors.some((item) => item.path?.startsWith("$.structured_data")), "visible/schema consistency only"),
    rendered_html: dimension(!errors.some((item) => item.path?.startsWith("$.rendered_html")), fixture),
    crawler_configuration: dimension(!errors.some((item) => item.path?.startsWith("$.crawler_configuration")), {
      metaRobots: metaRobots || null, xRobotsTag: xRobots || null, robotsAllowed, sitemapIncluded, authenticated,
      note: "noindex, robots.txt and authentication are separate controls",
      robotsObservation, directiveResult, sitemapObservation,
    }),
    lcp: lcpObservation ? { status: 'observed', detail: lcpObservation } : { status: 'not_measured', detail: 'Image order and fetchpriority are not LCP measurements.' },
    production_cost: productionCost == null ? { status: "not_tested", value: null } : { status: "measured", value: productionCost },
  };
  const byPath = prefix => dimension(!errors.some(item => item.path?.startsWith(prefix)), null);
  const health = {
    content: dimensions.content_quality,
    media: byPath('$.rendered_html.images'),
    canonical: byPath('$.seo_artifact.canonical'),
    indexability: byPath('$.seo_artifact.robots'),
    schema: dimensions.structured_data,
    'internal-links': byPath('$.rendered_html.links'),
    sitemap: { status: sitemapIncluded == null ? 'unknown' : errors.some(item => item.path === '$.crawler_configuration.sitemap') ? 'failed' : 'passed', detail: sitemapObservation },
    crawler: { status: robotsAllowed == null ? 'unknown' : errors.some(item => item.path?.startsWith('$.crawler_configuration') && item.path !== '$.crawler_configuration.sitemap') ? 'failed' : 'passed', detail: robotsObservation },
    'field-data': { status: 'not_measured', detail: null },
  };
  if (health.media.status === 'passed' && warnings.some(item => item.code === 'HTML_IMAGE_ACCESS_UNKNOWN')) {
    health.media = { status: 'unknown', detail: warnings.filter(item => item.code === 'HTML_IMAGE_ACCESS_UNKNOWN') };
  }
  for (const item of errors) Object.assign(item, { severity: 'blocker', action: 'repair_affected_artifact' });
  for (const item of warnings) Object.assign(item, { severity: item.code.endsWith('_UNKNOWN') ? 'unknown' : 'warning' });
  for (const value of Object.values(health)) Object.assign(value, { source: evidenceSource, checkedAt, pageRevision });
  const pending = Object.values(health).some(item => item.status === 'unknown');
  return { valid: errors.length ? false : pending && status === 'publish' ? null : true, status: errors.length ? 'failed' : pending ? 'pending' : 'passed', errors, warnings, dimensions, health,
    conclusions: { ranking: "not_tested", indexing: "not_tested", aiCitation: "not_tested" } };
}

function validateExpectedMedia(html, expectedMediaIds) {
  const expected=[...new Set((expectedMediaIds || []).map(String).filter(Boolean))];
  const images = [...parseSeoHtml(html).querySelectorAll('img')].filter(node => !isStaticallyHidden(node));
  return expected.filter((mediaId) => !images.some(node => node.classList.contains(`wp-image-${mediaId}`)
    || node.getAttribute('data-media-id') === mediaId || node.getAttribute('data-attachment-id') === mediaId))
    .map((mediaId) => ({ code:"EXPECTED_MEDIA_MISSING", path:"$.rendered_html.images", media_id:mediaId }));
}

function validateCommercialSlots(html, expectedCommercialSlots) {
  const expected=(expectedCommercialSlots || []).map((item) => typeof item === "string" ? { slot_key:item } : item).filter((item) => item?.slot_key);
  const actual=[...String(html).matchAll(/<[^>]+(?:data-stc-slot-key|data-affiliate-slot)=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => ({ slot_key:match[1], asset_id:attributes(match[0])["data-affiliate-asset"] || "" }));
  const errors=[];
  for (const slot of expected) {
    const matches=actual.filter((item) => item.slot_key === slot.slot_key);
    if (matches.length !== 1) errors.push({ code:"COMMERCIAL_SLOT_VISIBLE_COUNT_MISMATCH", path:"$.rendered_html.commercial_slots",
      slot_key:slot.slot_key, expected:1, actual:matches.length });
    else if (slot.affiliate_asset_id && matches[0].asset_id !== slot.affiliate_asset_id) errors.push({
      code:"COMMERCIAL_SLOT_ASSET_MISMATCH", path:"$.rendered_html.commercial_slots", slot_key:slot.slot_key,
      expected_asset_id:slot.affiliate_asset_id, actual_asset_id:matches[0].asset_id,
    });
  }
  for (const slot of actual) if (!expected.some((item) => item.slot_key === slot.slot_key)) errors.push({
    code:"UNPLANNED_COMMERCIAL_SLOT_VISIBLE", path:"$.rendered_html.commercial_slots", slot_key:slot.slot_key,
  });
  return errors;
}

export function compareRenderedVariants(variants = {}) {
  const entries = Object.entries(variants).map(([name, html]) => [name, articleFingerprint(html)]);
  const unique = new Set(entries.map(([, hash]) => hash));
  return { valid: unique.size <= 1, variants: Object.fromEntries(entries),
    errors: unique.size <= 1 ? [] : [{ code: "RENDERED_FACT_VARIANT_MISMATCH", path: "$.rendered_html.variants" }] };
}

function validateHtmlLinks(html, pageUrl) {
  const errors = [];
  for (const node of parseSeoHtml(html).querySelectorAll('a[href]')) {
    const value = node.getAttribute('href');
    if (/^(?:#|mailto:|tel:)/i.test(value)) continue;
    let target;
    try { target = new URL(value, pageUrl); } catch { target = null; }
    if (!target || !/^https?:$/.test(target.protocol) || /preview=true|\/wp-admin(?:\/|$)/i.test(target.toString())) {
      errors.push({ code: "HTML_LINK_INVALID", path: "$.rendered_html.links", url: value });
    }
  }
  return errors;
}

function validateHtmlImages(html, pageUrl, observations = [], lcpObservation = null, warnings = []) {
  const errors = [];
  const images = [...parseSeoHtml(html).querySelectorAll('img')];
  images.forEach((node, index) => {
    const attrs = elementAttributes(node);
    let src;
    try { src = new URL(attrs.src || "", pageUrl); } catch { src = null; }
    if (!attrs.src || !src || !isPublicArtifactUrl(src) || hasSignedQuery(src)) {
      errors.push({ code: "HTML_IMAGE_URL_INVALID", path: `$.rendered_html.images[${index}]` });
    }
    if (!(Number(attrs.width) > 0 && Number(attrs.height) > 0)) errors.push({ code: "HTML_IMAGE_DIMENSIONS_MISSING", path: `$.rendered_html.images[${index}]` });
    const observed = observations.find(item => item.index === index || (src && item.url === src.href));
    const path = `$.rendered_html.images[${index}]`;
    if (attrs.srcset && /\s\d+w(?:\s*,|\s*$)/.test(attrs.srcset) && !attrs.sizes) warnings.push({
      code: 'HTML_IMAGE_SIZES_MISSING', path, url: src?.href, dependency: 'EXT-IMG-LOAD',
    });
    if (!attrs.srcset && Number(attrs.width) > 600) warnings.push({
      code: 'HTML_IMAGE_SRCSET_UNOBSERVED', path, url: src?.href, dependency: 'EXT-IMG-LOAD',
    });
    if (observed?.bytes) {
      const bytes = Buffer.from(observed.bytes);
      const mime = bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp'
        : bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
          : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' : null;
      if (!mime || observed.contentType?.split(';')[0].trim().toLowerCase() !== mime) errors.push({
        code: 'HTML_IMAGE_FORMAT_MISMATCH', path, url: src?.href, detected: mime, declared: observed.contentType || null,
      });
    }
    if (observed?.httpStatus && observed.httpStatus !== 200) warnings.push({
      code: 'HTML_IMAGE_ACCESS_UNKNOWN', path, url: src?.href, httpStatus: observed.httpStatus,
    });
    const measuredLcp = lcpObservation && (lcpObservation.index === index || (src && lcpObservation.url === src.href));
    if ((measuredLcp || observed?.aboveFold === true) && /lazy/i.test(attrs.loading || '')) errors.push({
      code: measuredLcp ? 'LCP_IMAGE_LAZY' : 'ABOVE_FOLD_IMAGE_LAZY', path: `$.rendered_html.images[${index}]`, url: src?.href, evidence: measuredLcp ? lcpObservation : observed,
    });
  });
  return errors;
}

function validateHtmlSchema(html, pageUrl, h1, status, evidence = {}) {
  const errors = [];
  const scripts = [...parseSeoHtml(html).querySelectorAll('script')].filter(node => node.getAttribute('type')?.toLowerCase() === 'application/ld+json');
  const nodes = [];
  for (const [index, match] of scripts.entries()) {
    try {
      const schema = JSON.parse(match.textContent);
      nodes.push(...structuredDataNodes(schema));
    } catch { errors.push({ code: "HTML_SCHEMA_JSON_INVALID", path: `$.structured_data[${index}]` }); }
  }
  const articles = nodes.filter((node) => [node?.["@type"]].flat().some((type) => ["Article", "BlogPosting"].includes(type)));
  if (!articles.length && status === 'publish') errors.push({ code: "HTML_ARTICLE_SCHEMA_MISSING", path: "$.structured_data" });
  const byId = new Map();
  for (const node of nodes) if (node['@id']) {
    const previous = byId.get(node['@id']);
    if (previous) for (const key of ['headline', 'url', 'datePublished', 'dateModified', 'name']) {
      if (previous[key] != null && node[key] != null && JSON.stringify(previous[key]) !== JSON.stringify(node[key])) errors.push({
        code: 'HTML_SCHEMA_ID_CONFLICT', path: '$.structured_data', id: node['@id'], field: key,
      });
    }
    byId.set(node['@id'], { ...previous, ...node });
  }
  for (const article of articles) {
    if (stripHtml(article.headline) !== stripHtml(h1)) errors.push({ code: "HTML_SCHEMA_HEADLINE_MISMATCH", path: "$.structured_data.headline" });
    const pageRef = article.mainEntityOfPage;
    const page = typeof pageRef === 'string' ? byId.get(pageRef) : byId.get(pageRef?.['@id']);
    const urls = [article.url, page?.url || (typeof pageRef === 'string' ? pageRef : pageRef?.["@id"])].filter(Boolean);
    if (urls.some((value) => canonicalPageUrl(value) !== canonicalPageUrl(pageUrl))) errors.push({ code: "HTML_SCHEMA_URL_MISMATCH", path: "$.structured_data.url" });
    if (status !== 'publish' && article.datePublished) errors.push({ code: 'DRAFT_SCHEMA_PUBLICATION_DATE', path: '$.structured_data.datePublished' });
    for (const key of ['datePublished', 'dateModified']) {
      if (article[key] && !Number.isFinite(Date.parse(article[key]))) errors.push({ code: 'HTML_SCHEMA_DATE_INVALID', path: `$.structured_data.${key}` });
      if (Object.hasOwn(evidence, key) && (article[key] || null) !== evidence[key]) errors.push({ code: 'HTML_SCHEMA_DATE_UNSUPPORTED', path: `$.structured_data.${key}` });
    }
    if (Object.hasOwn(evidence, 'authorNames')) for (const ref of [article.author || []].flat()) {
      const author = typeof ref === 'string' ? byId.get(ref) : byId.get(ref?.['@id']) || ref;
      if (!author?.name || !evidence.authorNames.includes(author.name)) errors.push({ code: 'HTML_SCHEMA_AUTHOR_UNSUPPORTED', path: '$.structured_data.author' });
    }
  }
  const visible = articleText(html);
  for (const faq of nodes.filter(node => [node['@type']].flat().includes('FAQPage'))) {
    for (const question of [faq.mainEntity || []].flat()) {
      const answer = question.acceptedAnswer;
      const questionText = stripHtml(question.name), answerText = stripHtml(answer?.text);
      if (!questionText || !answerText || !visible.includes(questionText) || !visible.includes(answerText)) errors.push({
        code: 'HTML_FAQ_NOT_VISIBLE', path: '$.structured_data.faq', question: questionText,
      });
    }
  }
  if (nodes.some((node) => [node?.["@type"]].flat().includes("QAPage"))) errors.push({ code: "HTML_UNSUPPORTED_SCHEMA_TYPE", path: "$.structured_data" });
  return errors;
}

function articleFingerprint(html) { return crypto.createHash("sha256").update(articleText(html).normalize("NFKC").replace(/\s+/g, " ").trim()).digest("hex"); }
function articleText(html) { return articleVisibleText(html); }
function stripHtml(value) { return htmlText(value); }
function attributes(fragment) { return elementAttributes(parseSeoHtml('<html><body><img ' + fragment + '></body></html>').querySelector('img')); }
function publicUrl(value) { try { const url = new URL(String(value || "")); return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url : null; } catch { return null; } }
function canonicalPageUrl(value) { return normalizeObservedUrl(value); }
function hasSignedQuery(url) { return [...url.searchParams.keys()].some((key) => /^(?:token|signature|x-amz-|x-goog-)/i.test(key)); }
function dimension(passed, detail) { return { status: passed ? "passed" : "failed", detail }; }
