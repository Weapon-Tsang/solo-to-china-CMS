import crypto from "node:crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_ROOT = "https://searchconsole.googleapis.com/webmasters/v3";
const READONLY_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

export class SearchConsoleAdapter {
  constructor(config = {}, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  get enabled() {
    return Boolean(this.config.siteUrl && this.config.clientEmail && this.config.privateKey);
  }

  async listQueryInventory(now = new Date()) {
    if (!this.enabled) throw new Error("Search Console sync is not configured.");
    assertProperty(this.config.siteUrl);
    const endDate = isoDate(new Date(now.getTime() - 2 * 86_400_000));
    const startDate = isoDate(new Date(now.getTime() - Math.max(3, this.config.lookbackDays || 28) * 86_400_000));
    const accessToken = await this.createAccessToken();
    const rows = [];
    const rowLimit = Math.max(1, Math.min(25_000, this.config.rowLimit || 5_000));
    let startRow = 0;
    const maximumRows = 25_000;
    while (rows.length < maximumRows) {
      const requestLimit = Math.min(rowLimit, maximumRows - rows.length);
      const response = await this.fetch(`${API_ROOT}/sites/${encodeURIComponent(this.config.siteUrl)}/searchAnalytics/query`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ startDate, endDate, dimensions: ["query", "page"], dataState: "final", rowLimit: requestLimit, startRow }),
        signal: AbortSignal.timeout(60_000),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(`Search Console API failed (${response.status}): ${body?.error?.message || response.statusText}`);
      const page = Array.isArray(body.rows) ? body.rows : [];
      rows.push(...page.map(normalizeRow).filter(Boolean));
      if (page.length < requestLimit) break;
      startRow += page.length;
    }
    return { startDate, endDate, rows };
  }

  async createAccessToken() {
    const issuedAt = Math.floor(Date.now() / 1_000);
    const assertion = signJwt({
      iss: this.config.clientEmail,
      scope: READONLY_SCOPE,
      aud: TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + 3_600,
    }, normalizePrivateKey(this.config.privateKey));
    const response = await this.fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json();
    if (!response.ok || !body.access_token) throw new Error(`Google OAuth failed (${response.status}): ${body?.error_description || body?.error || response.statusText}`);
    return body.access_token;
  }
}

function normalizeRow(row) {
  const [query, pageUrl] = Array.isArray(row?.keys) ? row.keys : [];
  if (!String(query || "").trim() || !isHttpsUrl(pageUrl)) return null;
  return {
    query: String(query).trim().slice(0, 1_000),
    pageUrl: String(pageUrl).slice(0, 2_000),
    clicks: finite(row.clicks),
    impressions: finite(row.impressions),
    ctr: finite(row.ctr),
    position: finite(row.position),
  };
}

function signJwt(payload, privateKey) {
  const encodedHeader = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function normalizePrivateKey(value) {
  return String(value || "").replace(/\\n/g, "\n");
}

function assertProperty(value) {
  if (String(value).startsWith("sc-domain:") && /^sc-domain:[a-z0-9.-]+$/i.test(value)) return;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("SEARCH_CONSOLE_SITE_URL must be an HTTPS URL-prefix property or sc-domain property.");
  }
}

function isHttpsUrl(value) {
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function isoDate(value) {
  return value.toISOString().slice(0, 10);
}
