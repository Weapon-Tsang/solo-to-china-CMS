import crypto from "node:crypto";

export function wordpressMediaMetadata(body = {}, asset = {}) {
  const sourceUrl = publicMediaUrl(body.source_url || body.guid?.rendered);
  const details = body.media_details || {};
  const width = positiveInteger(details.width || body.width);
  const height = positiveInteger(details.height || body.height);
  const mime = String(body.mime_type || asset.contentType || "").toLowerCase();
  const bytes = Buffer.isBuffer(asset.bytes) ? asset.bytes.length : positiveInteger(body.filesize);
  const sha256 = Buffer.isBuffer(asset.bytes) ? crypto.createHash("sha256").update(asset.bytes).digest("hex") : null;
  const derivatives = Object.entries(details.sizes || {}).map(([name, item]) => ({
    name, url: publicMediaUrl(item?.source_url), width: positiveInteger(item?.width),
    height: positiveInteger(item?.height), mime: String(item?.mime_type || mime).toLowerCase(),
  })).filter((item) => item.url && item.width && item.height).sort((a, b) => a.width - b.width);
  return { url: sourceUrl, width, height, mime, bytes, sha256, derivatives,
    reusable: Boolean(sourceUrl && width && height && mime && bytes && sha256) };
}

export function parseMediaMetadata(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try { return JSON.parse(value || "{}"); } catch { return {}; }
}

export function validateMediaDelivery(visuals = [], { requireMetadata = true } = {}) {
  const errors = [];
  const hashes = new Map();
  for (const [index, visual] of visuals.entries()) {
    const mediaId = positiveInteger(visual.wordpress_media_id || visual.media_id || visual.id);
    if (!mediaId) continue;
    const path = `$.media[${index}]`;
    const url = publicMediaUrl(visual.wordpress_media_url || visual.url || visual.media_url);
    const metadata = parseMediaMetadata(visual.media_metadata || visual.media_metadata_json || visual.metadata);
    const role = String(visual.image_role || visual.role || "context").toLowerCase();
    const alt = String(visual.alt_text ?? visual.alt ?? "").trim();
    if (!url) errors.push({ code: "MEDIA_URL_NOT_PUBLIC", path: `${path}.url` });
    if (role === "decorative" ? alt !== "" : alt === "") errors.push({ code: "MEDIA_ALT_ROLE_MISMATCH", path: `${path}.alt` });
    if (alt && keywordStuffed(alt)) errors.push({ code: "MEDIA_ALT_KEYWORD_STUFFING", path: `${path}.alt` });
    if (Boolean(visual.factual_image_required) && visual.image_type === "illustration") {
      errors.push({ code: "FACTUAL_SCENE_CANNOT_USE_ILLUSTRATION", path });
    }
    if (visual.image_type === "real_world_photo"
      && !["use_authorized_source_image", "search_real_image"].includes(visual.acquisition_strategy)) {
      errors.push({ code: "REAL_SCENE_REQUIRES_EVIDENCE_MEDIA", path });
    }
    if (requireMetadata) {
      if (!positiveInteger(metadata.width) || !positiveInteger(metadata.height)) errors.push({ code: "MEDIA_DIMENSIONS_MISSING", path });
      if (!/^image\/(?:jpeg|png|webp|avif|gif)$/i.test(String(metadata.mime || ""))) errors.push({ code: "MEDIA_MIME_INVALID", path });
      if (!positiveInteger(metadata.bytes) || !/^[a-f0-9]{64}$/i.test(String(metadata.sha256 || ""))) errors.push({ code: "MEDIA_HASH_OR_SIZE_MISSING", path });
    }
    if (metadata.url && publicMediaUrl(metadata.url) !== url) errors.push({ code: "MEDIA_FINAL_URL_MISMATCH", path });
    for (const derivative of metadata.derivatives || []) {
      if (!publicMediaUrl(derivative.url) || !positiveInteger(derivative.width) || !positiveInteger(derivative.height)) {
        errors.push({ code: "MEDIA_DERIVATIVE_INVALID", path });
      }
    }
    if (metadata.sha256) {
      const prior = hashes.get(metadata.sha256);
      if (prior && prior !== mediaId) errors.push({ code: "MEDIA_DUPLICATE_UPLOAD", path, mediaIds: [prior, mediaId] });
      else hashes.set(metadata.sha256, mediaId);
    }
  }
  return { valid: errors.length === 0, errors, checked: visuals.length };
}

export function responsiveImageAttributes(metadataValue, { featured = false } = {}) {
  const metadata = parseMediaMetadata(metadataValue);
  const derivatives = (metadata.derivatives || []).filter((item) => publicMediaUrl(item.url) && positiveInteger(item.width));
  return {
    ...(positiveInteger(metadata.width) ? { width: metadata.width } : {}),
    ...(positiveInteger(metadata.height) ? { height: metadata.height } : {}),
    ...(derivatives.length ? { srcset: derivatives.map((item) => `${publicMediaUrl(item.url)} ${item.width}w`).join(", "),
      sizes: `(max-width: ${metadata.width || derivatives.at(-1).width}px) 100vw, ${metadata.width || derivatives.at(-1).width}px` } : {}),
    ...(featured ? { fetchpriority: "high" } : { loading: "lazy" }), decoding: "async",
  };
}

export function publicMediaUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!/^https?:$/.test(url.protocol) || url.username || url.password
      || /(?:^|[?&])(?:token|signature|x-amz-|x-goog-)/i.test(url.search)) return null;
    return url.toString();
  } catch { return null; }
}

function keywordStuffed(alt) {
  const counts = new Map();
  for (const token of alt.toLowerCase().match(/[a-z0-9]+/g) || []) counts.set(token, (counts.get(token) || 0) + 1);
  return [...counts.entries()].some(([token, count]) => token.length > 3 && count > 3);
}
function positiveInteger(value) { const parsed = Number.parseInt(value, 10); return Number.isInteger(parsed) && parsed > 0 ? parsed : null; }
