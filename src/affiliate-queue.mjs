import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { id, sha256, slugify, truncate } from "./utils.mjs";
import {
  ASSET_TYPES, CommercialValidationError, PRODUCT_CATEGORIES, SCOPE_TYPES,
  normalizeAffiliateAsset, normalizeEmbedConfig, validateProviderAffiliateUrl,
} from "./commercial.mjs";

export const AFFILIATE_QUEUE_STATUSES = new Set(["PENDING", "READY_FOR_MANUAL", "COMPLETED", "SKIPPED", "INVALID"]);
export const TRIP_TOOL_TYPES = new Set(["HOTELS", "FLIGHTS", "TRAINS", "CUSTOM_LINK", "SEARCH_BOX"]);
export const AFFILIATE_QUEUE_EXPORT_FIELDS = [
  "task_id", "task_key", "status", "provider", "product_category", "asset_type", "scope_type", "scope_key",
  "destination_slug", "area_key", "route_key", "entity_key", "entity_name", "trip_tool_type", "trip_destination",
  "trip_property", "trip_departure", "trip_arrival", "source_trip_url", "trip_sub1", "suggested_title", "priority",
  "opportunity_id", "score", "reason", "affiliate_url",
];

const SCOPE_PRIORITY = { GLOBAL: 0, CATEGORY: 5, COUNTRY: 10, DESTINATION: 20, AREA: 28, ROUTE: 30, ENTITY: 35 };
const INTENT_PRIORITY = { LOW: 0, MEDIUM: 5, HIGH: 15, VERY_HIGH: 25 };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function affiliateQueueTaskKey(input) {
  const provider = providerToken(input.provider || "Trip.com");
  const category = enumValue(input.productCategory || input.product_category, PRODUCT_CATEGORIES, "productCategory").toLowerCase();
  const scope = enumValue(input.scopeType || input.scope_type, SCOPE_TYPES, "scopeType").toLowerCase();
  const key = semanticTaskKey(input, category, scope);
  return `${provider}:${category}:${scope}:${key}`;
}

export function affiliateQueueSub1(input) {
  const category = enumValue(input.productCategory || input.product_category, PRODUCT_CATEGORIES, "productCategory").toLowerCase();
  const scope = enumValue(input.scopeType || input.scope_type, SCOPE_TYPES, "scopeType").toLowerCase();
  const key = semanticTaskKey(input, category, scope).replaceAll("-", "_").replace(/[^a-z0-9_]/g, "");
  return `stc_${category}_${key || "global"}`.slice(0, 100).replace(/_+$/g, "");
}

export function normalizeAffiliateQueueTask(input, { sourceType = "SEED" } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AffiliateQueueValidationError("Affiliate queue task must be an object.");
  const productCategory = enumValue(input.productCategory || input.product_category, PRODUCT_CATEGORIES, "productCategory");
  const scopeType = enumValue(input.scopeType || input.scope_type, SCOPE_TYPES, "scopeType");
  const provider = singleLine(input.provider || "Trip.com", 100);
  if (!isTripProvider(provider)) throw new AffiliateQueueValidationError("V1 setup queue supports the MANUAL Trip.com provider only.");
  const scopeKey = singleLine(input.scopeKey || input.scope_key || queueScopeKey(input), 300);
  if (!scopeKey && !["GLOBAL", "CATEGORY"].includes(scopeType)) throw new AffiliateQueueValidationError("scopeKey is required for this scope.");
  const assetType = enumValue(input.assetType || input.asset_type || defaultAssetType(productCategory, scopeType), ASSET_TYPES, "assetType");
  const tripToolType = enumValue(input.tripToolType || input.trip_tool_type || defaultTripTool(productCategory, scopeType, assetType), TRIP_TOOL_TYPES, "tripToolType");
  if (assetType === "SEARCH_BOX" && tripToolType !== "SEARCH_BOX") throw new AffiliateQueueValidationError("SEARCH_BOX tasks must use the SEARCH_BOX Trip tool type.");
  const sourceTripUrl = input.sourceTripUrl || input.source_trip_url
    ? validateProviderAffiliateUrl(input.sourceTripUrl || input.source_trip_url, provider, { field: "sourceTripUrl" }) : "";
  const intentStrength = String(input.intentStrength || input.intent_strength || "").toUpperCase();
  if (intentStrength && !Object.hasOwn(INTENT_PRIORITY, intentStrength)) throw new AffiliateQueueValidationError("Unsupported intentStrength.");
  const score = number(input.score, 0, 100, 0);
  const precisionUplift = number(input.precisionUplift || input.precision_uplift, 0, 100, scopeType === "ENTITY" || scopeType === "ROUTE" ? 80 : 55);
  const computedPriority = Math.round(score * 0.45 + (INTENT_PRIORITY[intentStrength] || 0) + SCOPE_PRIORITY[scopeType] * 0.45 + precisionUplift * 0.15);
  const status = enumValue(input.status || "READY_FOR_MANUAL", AFFILIATE_QUEUE_STATUSES, "status");
  const taskKey = affiliateQueueTaskKey({ ...input, provider, productCategory, scopeType, scopeKey });
  const suggestedTitle = singleLine(input.suggestedTitle || input.suggested_title || defaultTitle(productCategory, scopeType, scopeKey, input.entityName || input.entity_name), 500);
  const normalized = {
    id: singleLine(input.id || input.taskId || input.task_id || id("affiliate_task"), 200),
    taskKey: singleLine(taskKey, 500), providerAccountId: singleLine(input.providerAccountId || input.provider_account_id, 200), provider, status,
    productCategory, assetType, scopeType, scopeKey,
    destinationSlug: slugifyOrEmpty(input.destinationSlug || input.destination_slug),
    areaKey: singleLine(input.areaKey || input.area_key, 300), routeKey: singleLine(input.routeKey || input.route_key, 300),
    entityKey: singleLine(input.entityKey || input.entity_key, 300), entityName: singleLine(input.entityName || input.entity_name, 300),
    tripToolType, tripDestination: singleLine(input.tripDestination || input.trip_destination || input.destinationSlug || input.destination_slug, 300),
    tripProperty: singleLine(input.tripProperty || input.trip_property || (scopeType === "ENTITY" && productCategory === "HOTEL" ? input.entityName || input.entity_name : ""), 300),
    tripDeparture: singleLine(input.tripDeparture || input.trip_departure || (scopeType === "ROUTE" ? routeParts(input.routeKey || input.route_key || scopeKey)[0] : ""), 300),
    tripArrival: singleLine(input.tripArrival || input.trip_arrival || (scopeType === "ROUTE" ? routeParts(input.routeKey || input.route_key || scopeKey)[1] : ""), 300),
    sourceTripUrl, tripSub1: affiliateQueueSub1({ productCategory, scopeType, scopeKey }),
    suggestedTitle, suggestedDescription: truncate(input.suggestedDescription || input.suggested_description || "", 1_000),
    suggestedCtaLabel: singleLine(input.suggestedCtaLabel || input.suggested_cta_label || defaultCta(productCategory), 100),
    priority: input.priority == null ? Math.max(-100, Math.min(100, computedPriority)) : integer(input.priority, -100, 100),
    opportunityId: singleLine(input.opportunityId || input.opportunity_id, 200) || null,
    reason: truncate(input.reason || (sourceType === "SEED" ? "Explicit operator-maintained initial seed task." : "High-value affiliate opportunity needs a more precise official link."), 2_000),
    score, intentStrength, precisionUplift, sourceType,
    affiliateUrl: input.affiliateUrl || input.affiliate_url ? validateProviderAffiliateUrl(input.affiliateUrl || input.affiliate_url, provider) : "",
    embedConfig: input.embedConfig || input.embed_config || {}, validFrom: isoDateOrNull(input.validFrom || input.valid_from), validUntil: isoDateOrNull(input.validUntil || input.valid_until),
  };
  if (!/^[a-z0-9_]+$/.test(normalized.tripSub1)) throw new AffiliateQueueValidationError("trip_sub1 may contain lowercase a-z, 0-9, and underscore only.");
  if (!normalized.tripSub1.startsWith("stc_")) throw new AffiliateQueueValidationError("trip_sub1 must use the stc_ prefix.");
  if (assetType === "PROMOTION" && (!normalized.validFrom || !normalized.validUntil)) throw new AffiliateQueueValidationError("PROMOTION tasks require validFrom and validUntil.");
  if (normalized.validFrom && normalized.validUntil && normalized.validFrom >= normalized.validUntil) throw new AffiliateQueueValidationError("validUntil must be later than validFrom.");
  return normalized;
}

export function queueTaskFromOpportunity(opportunity, intent, { threshold = 70, providerAccountId = "" } = {}) {
  if (!opportunity || !intent) return null;
  const strength = String(intent.intentStrength || intent.intent_strength || "").toUpperCase();
  if (!["HIGH", "VERY_HIGH"].includes(strength) || Number(opportunity.score || 0) < threshold) return null;
  return normalizeAffiliateQueueTask({
    providerAccountId, provider: opportunity.provider || "Trip.com", productCategory: opportunity.productCategory || opportunity.product_category,
    scopeType: opportunity.scopeType || opportunity.scope_type, scopeKey: opportunity.scopeKey || opportunity.scope_key,
    destinationSlug: intent.destinationSlug || intent.destination_slug, areaKey: intent.areaKey || intent.area_key,
    routeKey: intent.routeKey || intent.route_key, entityKey: intent.entityKey || intent.entity_key,
    entityName: intent.entityName || intent.entity_name, opportunityId: opportunity.id, score: opportunity.score,
    reason: opportunity.reason, intentStrength: strength, precisionUplift: opportunity.factors?.landingPageMismatch || 70,
  }, { sourceType: "OPPORTUNITY" });
}

export function affiliateAssetFromQueueTask(task, completion, providerAccount) {
  const rawAffiliateUrl = completion?.affiliateUrl || completion?.affiliate_url || task.affiliate_url || "";
  const affiliateUrl = rawAffiliateUrl ? validateProviderAffiliateUrl(rawAffiliateUrl, task.provider) : "";
  const embedConfig = completion?.embedConfig || completion?.embed_config || {};
  if (!affiliateUrl && task.asset_type !== "SEARCH_BOX") throw new AffiliateQueueValidationError("affiliateUrl is required.");
  if (task.asset_type === "SEARCH_BOX" && !affiliateUrl && !Object.keys(embedConfig || {}).length) throw new AffiliateQueueValidationError("SEARCH_BOX completion requires affiliateUrl or structured embedConfig.");
  if (task.asset_type === "PROMOTION" && (!task.valid_from || !task.valid_until)) throw new AffiliateQueueValidationError("PROMOTION tasks require validFrom and validUntil.");
  return normalizeAffiliateAsset({
    id: task.affiliate_asset_id || `asset_${sha256(task.task_key).slice(0, 24)}`,
    providerAccountId: task.provider_account_id, provider: task.provider, assetType: task.asset_type,
    productCategory: task.product_category, scopeType: task.scope_type, scopeKey: task.scope_key,
    destinationSlug: task.destination_slug, areaKey: task.area_key, routeKey: task.route_key,
    entityKey: task.entity_key, entityName: task.entity_name, title: task.suggested_title,
    description: task.suggested_description, ctaLabel: task.suggested_cta_label, targetUrl: affiliateUrl,
    embedConfig, priority: task.priority, validFrom: task.valid_from, validUntil: task.valid_until,
  }, { id: providerAccount.id, displayName: providerAccount.display_name });
}

export function loadAffiliateQueueSeeds(filename = path.join(root, "config", "affiliate-queue-seeds.json")) {
  const parsed = JSON.parse(fs.readFileSync(filename, "utf8"));
  if (!Array.isArray(parsed)) throw new AffiliateQueueValidationError("Affiliate queue seed file must contain a JSON array.");
  return parsed.map((item) => normalizeAffiliateQueueTask(item, { sourceType: "SEED" }));
}

export function exportAffiliateQueue(items, format = "json") {
  const rows = items.map(exportRow);
  if (String(format).toLowerCase() === "json") return JSON.stringify(rows, null, 2);
  if (String(format).toLowerCase() !== "csv") throw new AffiliateQueueValidationError("Export format must be csv or json.");
  return [AFFILIATE_QUEUE_EXPORT_FIELDS.join(","), ...rows.map((row) => AFFILIATE_QUEUE_EXPORT_FIELDS.map((field) => csvCell(row[field])).join(","))].join("\r\n");
}

export function parseAffiliateQueueImport(payload, format = "json") {
  let rows;
  if (Array.isArray(payload)) rows = payload;
  else if (payload && typeof payload === "object" && Array.isArray(payload.items)) rows = payload.items;
  else {
    const text = String(payload || "");
    if (String(format).toLowerCase() === "json") {
      try { rows = JSON.parse(text); } catch { throw new AffiliateQueueValidationError("Import JSON is invalid."); }
    } else if (String(format).toLowerCase() === "csv") rows = parseCsv(text);
  }
  if (rows && !Array.isArray(rows) && Array.isArray(rows.items)) rows = rows.items;
  if (!Array.isArray(rows)) throw new AffiliateQueueValidationError("Import must contain an array of queue rows.");
  if (rows.length > 500) throw new AffiliateQueueValidationError("Import may contain at most 500 rows.");
  return rows;
}

export class AffiliateQueueValidationError extends CommercialValidationError {
  constructor(message) { super(message); this.name = "AffiliateQueueValidationError"; }
}

function exportRow(item) {
  const row = {};
  for (const field of AFFILIATE_QUEUE_EXPORT_FIELDS) row[field] = field === "task_id" ? item.id : item[field] ?? "";
  return row;
}

function parseCsv(text) {
  const records = []; let row = []; let cell = ""; let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n") { row.push(cell.replace(/\r$/, "")); records.push(row); row = []; cell = ""; }
    else cell += char;
  }
  if (quoted) throw new AffiliateQueueValidationError("Import CSV contains an unterminated quoted field.");
  if (cell || row.length) { row.push(cell.replace(/\r$/, "")); records.push(row); }
  const [headers = [], ...values] = records.filter((record) => record.some((entry) => entry !== ""));
  if (!headers.includes("task_id") || !headers.includes("task_key") || !headers.includes("affiliate_url")) throw new AffiliateQueueValidationError("Import CSV requires task_id, task_key, and affiliate_url columns.");
  return values.map((record) => Object.fromEntries(headers.map((header, index) => [header.trim(), record[index] || ""])));
}

function csvCell(value) { const text = String(value ?? ""); return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
function providerToken(value) { return isTripProvider(value) ? "trip" : slugify(value); }
function isTripProvider(value) { return /^(?:trip|trip\.com|trip-com)(?:\s+affiliate)?$/i.test(String(value || "").trim()); }
function semanticTaskKey(input, category, scope) {
  const key = slugify(queueScopeKey(input));
  return scope === "entity" && key.startsWith(`${category}-`) ? key.slice(category.length + 1) || "unknown" : key;
}
function queueScopeKey(input) {
  const scope = String(input.scopeType || input.scope_type || "").toUpperCase();
  return input.scopeKey || input.scope_key || (scope === "ENTITY" ? input.entityKey || input.entity_key || input.entityName || input.entity_name
    : scope === "ROUTE" ? input.routeKey || input.route_key : scope === "AREA" ? input.areaKey || input.area_key
      : scope === "DESTINATION" ? input.destinationSlug || input.destination_slug : scope === "CATEGORY" ? input.productCategory || input.product_category : "global");
}
function defaultAssetType(category, scope) { return ["DESTINATION", "COUNTRY", "CATEGORY", "GLOBAL"].includes(scope) ? "CATEGORY_LINK" : "DEEP_LINK"; }
function defaultTripTool(category, scope, assetType) {
  if (assetType === "SEARCH_BOX") return "SEARCH_BOX";
  if (category === "HOTEL") return "HOTELS";
  if (category === "FLIGHT" && scope === "ROUTE") return "FLIGHTS";
  if (category === "TRAIN" && scope === "ROUTE") return "TRAINS";
  return "CUSTOM_LINK";
}
function defaultTitle(category, scope, scopeKey, entityName) {
  const subject = entityName || String(scopeKey || "China").split(/[-_.]/).filter(Boolean).map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
  const prefix = ({ HOTEL: "Hotels in", FLIGHT: "Flights for", TRAIN: "Trains for", ATTRACTION: "Tickets and attractions for", TOUR_ACTIVITY: "Tours and activities for", AIRPORT_TRANSFER: "Airport transfers for", PLANNER: "Travel planning for" })[category] || `${category} for`;
  return `${prefix} ${subject}`.trim();
}
function defaultCta(category) { return ({ HOTEL: "View hotels", FLIGHT: "View flights", TRAIN: "View trains", ATTRACTION: "View tickets", TOUR_ACTIVITY: "View activities", AIRPORT_TRANSFER: "View transfers" })[category] || "View option"; }
function routeParts(value) { const parts = String(value || "").split(/(?:-|\s*(?:to|→|>)\s*)/i).filter(Boolean); return [parts[0] || "", parts.slice(1).join("-") || ""]; }
function slugifyOrEmpty(value) { return value ? slugify(value) : ""; }
function singleLine(value, max) { return truncate(value, max).replace(/\s+/g, " ").trim(); }
function number(value, min, max, fallback) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback; }
function integer(value, min, max) { return Math.max(min, Math.min(max, Number.parseInt(value || "0", 10) || 0)); }
function isoDateOrNull(value) { if (!value) return null; const date = new Date(value); if (Number.isNaN(date.valueOf())) throw new AffiliateQueueValidationError("Date fields must be valid ISO dates."); return date.toISOString(); }
function enumValue(value, allowed, field) { const normalized = String(value || "").toUpperCase(); if (!allowed.has(normalized)) throw new AffiliateQueueValidationError(`Unsupported ${field}: ${value}`); return normalized; }
