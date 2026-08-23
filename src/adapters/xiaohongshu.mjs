import { canonicalizeUrl, truncate } from "../utils.mjs";

const ALLOWED_HOSTS = new Set(["www.xiaohongshu.com", "xiaohongshu.com"]);

export function normalizeXiaohongshuCapture(input) {
  if (!input || typeof input !== "object") throw new ValidationError("Capture payload must be an object.");

  let url;
  try {
    url = new URL(input.url);
  } catch {
    throw new ValidationError("A valid Xiaohongshu note URL is required.");
  }
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase()) || !url.pathname.includes("/explore/")) {
    throw new ValidationError("Only an explicitly opened xiaohongshu.com/explore note can be captured.");
  }

  const rawText = truncate(input.text, 250_000).trim();
  if (rawText.length < 20) throw new ValidationError("The current page did not expose enough note text to save.");

  const canonicalUrl = canonicalizeUrl(url.toString());
  const externalId = url.pathname.match(/\/explore\/([a-zA-Z0-9]+)/)?.[1] || null;
  const assets = Array.isArray(input.images)
    ? input.images
        .slice(0, 80)
        .map((asset, index) => ({
          kind: "image",
          url: truncate(asset?.url, 4_000),
          alt: truncate(asset?.alt, 500),
          position: index,
        }))
        .filter((asset) => /^https?:\/\//.test(asset.url))
    : [];

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
    rawHtml: truncate(input.html, 1_500_000),
    assets,
    client: {
      extensionVersion: truncate(input.client?.extensionVersion, 50),
      pageLocale: truncate(input.client?.pageLocale, 50),
    },
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
