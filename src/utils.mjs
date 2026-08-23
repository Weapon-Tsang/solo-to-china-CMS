import crypto from "node:crypto";

export function id(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
export function now() {
  return new Date().toISOString();
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function slugify(value) {
  return String(value || "unknown")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-|-$/g, "") || "unknown";
}

export function json(value, fallback = null) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function canonicalizeUrl(input) {
  const url = new URL(input);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|source$|share_|xsec_|xhsshare|appuid$)/i.test(key)) {
      url.searchParams.delete(key);
    }
  }
  const entries = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  url.search = "";
  for (const [key, value] of entries) url.searchParams.append(key, value);
  return url.toString();
}

export function truncate(value, max) {
  const text = String(value || "");
  return text.length <= max ? text : text.slice(0, max);
}
