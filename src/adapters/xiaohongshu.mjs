import { canonicalizeUrl, sha256, truncate } from "../utils.mjs";

const ALLOWED_HOSTS = new Set(["www.xiaohongshu.com", "xiaohongshu.com"]);
const AUTHORIZED_ORIGINS = new Set(["xhs_manual_extension", "xhs_favorites_sync"]);

export function normalizeXiaohongshuCapture(input) {
  if (!input || typeof input !== "object") throw new ValidationError("Capture payload must be an object.");

  let url;
  try {
    url = new URL(input.url);
  } catch {
    throw new ValidationError("A valid Xiaohongshu note URL is required.");
  }
  const externalId = url.pathname.match(/\/(?:explore|discovery\/item)\/([a-zA-Z0-9]+)/)?.[1]
    || url.pathname.match(/\/board\/[a-zA-Z0-9]+\/([a-zA-Z0-9]+)/)?.[1]
    || null;
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase()) || !externalId) {
    throw new ValidationError("Only a Xiaohongshu note detail page can be captured.");
  }

  const rawText = String(input.text || "").trim();
  if (rawText.length < 20) throw new ValidationError("The current page did not expose enough note text to save.");

  const canonicalUrl = canonicalizeUrl(url.pathname.startsWith("/board/")
    ? `https://www.xiaohongshu.com/explore/${externalId}`
    : url.toString());
  const acquisitionOrigin = AUTHORIZED_ORIGINS.has(input.acquisitionOrigin || input.client?.acquisitionOrigin)
    ? (input.acquisitionOrigin || input.client?.acquisitionOrigin)
    : "xhs_manual_extension";
  const assets = normalizeAssets([
    ...(Array.isArray(input.images) ? input.images.map((asset) => ({ ...asset, kind: "image" })) : []),
    ...(Array.isArray(input.videos) ? input.videos.map((asset) => ({ ...asset, kind: "video" })) : []),
  ]);
  const rawHtml = String(input.html || "");
  const completeness = normalizeCompleteness(input.completeness, { rawText, rawHtml, assets });
  const rights = authorizedRights(acquisitionOrigin);

  return {
    adapter: "xiaohongshu",
    externalId,
    canonicalUrl,
    title: truncate(input.title, 1_000).trim(),
    authorName: truncate(input.author?.name, 500).trim(),
    authorUrl: safeHttpUrl(input.author?.url),
    publishedAt: safeDate(input.publishedAt),
    capturedAt: safeDate(input.capturedAt) || new Date().toISOString(),
    rawText,
    rawHtml,
    assets,
    completeness,
    acquisitionOrigin,
    syncScopeKey: truncate(input.syncScopeKey || input.client?.syncScopeKey, 500),
    rights,
    client: {
      extensionVersion: truncate(input.client?.extensionVersion, 50),
      pageLocale: truncate(input.client?.pageLocale, 50),
      acquisitionOrigin,
      syncScopeKey: truncate(input.syncScopeKey || input.client?.syncScopeKey, 500),
    },
  };
}

function normalizeAssets(values) {
  const seen = new Set();
  const assets = [];
  for (const value of values) {
    const url = safeHttpUrl(value?.url);
    const identity = truncate(value?.mediaIdentity || value?.identity || url, 4_000);
    if (!url || seen.has(identity)) continue;
    seen.add(identity);
    const kind = value?.kind === "video" ? "video" : "image";
    assets.push({
      kind,
      url,
      alt: truncate(value?.alt, 500),
      position: Number.isInteger(value?.position) ? value.position : assets.length,
      width: nonNegativeInteger(value?.width),
      height: nonNegativeInteger(value?.height),
      duration: finiteNumber(value?.duration),
      mediaIdentity: identity,
      originalSha256: validSha256(value?.originalSha256),
      aiDerivativeDataUrl: safeImageDataUrl(value?.aiDerivativeDataUrl),
      aiDerivativeSha256: validSha256(value?.aiDerivativeSha256),
      provenance: value?.provenance && typeof value.provenance === "object" ? value.provenance : {},
    });
  }
  return assets;
}

function normalizeCompleteness(value, { rawText, rawHtml, assets }) {
  const input = value && typeof value === "object" ? value : {};
  const imageCount = assets.filter((asset) => asset.kind === "image").length;
  const videoCount = assets.filter((asset) => asset.kind === "video").length;
  const text = completenessPart(input.text, {
    complete: true, chars: rawText.length, hash: sha256(rawText), detectionMethod: "detail_dom_text",
  });
  const dom = completenessPart(input.dom, {
    complete: true, bytes: Buffer.byteLength(rawHtml), chunks: rawHtml ? 1 : 0, hash: sha256(rawHtml), detectionMethod: "detail_dom_snapshot",
  });
  const images = mediaCompleteness(input.images, imageCount, "detail_carousel_traversal");
  const videos = mediaCompleteness(input.videos, videoCount, "detail_video_elements");
  const complete = text.complete && dom.complete && images.complete && videos.complete;
  const requested = String(input.overall || "");
  const overall = complete ? "complete" : requested === "partial_needs_attention" ? requested : "partial_retryable";
  return { text, dom, images, videos, overall };
}

function completenessPart(value, fallback) {
  const input = value && typeof value === "object" ? value : {};
  return {
    complete: input.complete !== false,
    ...(fallback.chars != null ? { chars: fallback.chars } : {}),
    ...(fallback.bytes != null ? { bytes: fallback.bytes } : {}),
    ...(fallback.chunks != null ? { chunks: Math.max(0, nonNegativeInteger(input.chunks) ?? fallback.chunks) } : {}),
    hash: fallback.hash,
    detectionMethod: truncate(input.detectionMethod || fallback.detectionMethod, 120),
  };
}

function mediaCompleteness(value, captured, fallbackMethod) {
  const input = value && typeof value === "object" ? value : {};
  const expected = nonNegativeInteger(input.expected);
  const traversed = input.traversed !== false;
  const complete = input.complete !== false && traversed && (expected == null || captured >= expected);
  return {
    expected,
    captured,
    complete,
    traversed,
    detectionMethod: truncate(input.detectionMethod || fallbackMethod, 120),
  };
}

function authorizedRights(origin) {
  return {
    authorizationStatus: "owner_confirmed",
    authorizationOrigin: origin,
    commercialUseAllowed: true,
    editingAllowed: true,
    redistributionAllowed: true,
    publishable: true,
    licenseScope: ["research", "copy", "download", "edit", "crop", "compress", "format_convert", "resize", "translate", "adapt", "redistribute", "commercial_publish", "wordpress_media", "social_media"],
  };
}
function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? truncate(url.toString(), 4_000) : "";
  } catch {
    return "";
  }
}

function safeImageDataUrl(value) {
  const text = String(value || "");
  return /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(text) && text.length <= 8_000_000 ? text : "";
}

function validSha256(value) { return /^[a-f0-9]{64}$/i.test(String(value || "")) ? String(value).toLowerCase() : ""; }
function nonNegativeInteger(value) { const parsed = Number(value); return Number.isInteger(parsed) && parsed >= 0 ? parsed : null; }
function finiteNumber(value) { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? parsed : null; }

function safeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}
