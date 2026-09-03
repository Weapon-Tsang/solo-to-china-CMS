import { id, now, slugify, truncate } from "./utils.mjs";
import { markdownToContentBlocks } from "./content-blocks.mjs";

export const ASSET_TYPES = new Set(["DEEP_LINK", "CATEGORY_LINK", "SEARCH_BOX", "STATIC_BANNER", "DYNAMIC_BANNER", "PROMOTION"]);
export const PRODUCT_CATEGORIES = new Set(["HOTEL", "FLIGHT", "TRAIN", "ATTRACTION", "TOUR_ACTIVITY", "FLIGHT_HOTEL", "CAR_RENTAL", "AIRPORT_TRANSFER", "PLANNER"]);
export const SCOPE_TYPES = new Set(["ENTITY", "ROUTE", "AREA", "DESTINATION", "COUNTRY", "CATEGORY", "GLOBAL"]);
export const CONNECTION_MODES = new Set(["MANUAL", "OFFICIAL_API", "FEED"]);
export const OFFER_CATEGORIES = new Set(["hotels", "attraction_tickets", "trains", "flights", "tours_activities", "airport_transfer", "planner"]);

const CATEGORY_COMPATIBILITY = new Map([
  ["hotels", "HOTEL"], ["attraction_tickets", "ATTRACTION"], ["trains", "TRAIN"],
  ["flights", "FLIGHT"], ["tours_activities", "TOUR_ACTIVITY"],
  ["airport_transfer", "AIRPORT_TRANSFER"], ["planner", "PLANNER"],
]);
const LEGACY_CATEGORY = new Map([...CATEGORY_COMPATIBILITY].map(([legacy, product]) => [product, legacy]));
const COMPONENT_BY_ASSET = {
  DEEP_LINK: "affiliate_booking_card", CATEGORY_LINK: "affiliate_booking_card",
  SEARCH_BOX: "affiliate_search_card", STATIC_BANNER: "affiliate_banner",
  DYNAMIC_BANNER: "affiliate_banner", PROMOTION: "affiliate_promotion_card",
};

export function normalizeAffiliateProviderAccount(input) {
  if (!input || typeof input !== "object") throw new CommercialValidationError("Provider account must be an object.");
  const providerKey = slugify(requiredSingleLine(input.providerKey || input.provider_key, "providerKey", 100));
  return {
    id: input.id || id("provider"), providerKey,
    displayName: requiredSingleLine(input.displayName || input.display_name, "displayName", 160),
    connectionMode: enumValue(input.connectionMode || input.connection_mode || "MANUAL", CONNECTION_MODES, "connectionMode"),
    siteName: singleLine(truncate(input.siteName || input.site_name, 200)),
    defaultLanguage: singleLine(truncate(input.defaultLanguage || input.default_language || "en", 30)),
    defaultDisclosure: truncate(input.defaultDisclosure || input.default_disclosure, 1_000),
    status: enumValue(input.status || "CONFIGURED", new Set(["CONFIGURED", "DISABLED", "NEEDS_CONFIGURATION"]), "status"),
  };
}

export function normalizeAffiliateAsset(input, providerAccount = null) {
  if (!input || typeof input !== "object") throw new CommercialValidationError("Affiliate asset must be an object.");
  const assetType = enumValue(input.assetType || input.asset_type, ASSET_TYPES, "assetType");
  const productCategory = enumValue(input.productCategory || input.product_category, PRODUCT_CATEGORIES, "productCategory");
  const scopeType = enumValue(input.scopeType || input.scope_type, SCOPE_TYPES, "scopeType");
  const provider = requiredSingleLine(input.provider || providerAccount?.displayName, "provider", 100);
  const targetUrl = input.targetUrl || input.target_url ? safeAffiliateUrl(input.targetUrl || input.target_url) : "";
  const embedConfig = normalizeEmbedConfig(input.embedConfig || input.embed_config || input.embed_config_json, assetType, provider);
  if (["DEEP_LINK", "CATEGORY_LINK", "STATIC_BANNER", "PROMOTION"].includes(assetType) && !targetUrl) throw new CommercialValidationError(`${assetType} requires an official HTTPS targetUrl.`);
  if (["SEARCH_BOX", "DYNAMIC_BANNER"].includes(assetType) && !targetUrl && !Object.keys(embedConfig).length) throw new CommercialValidationError(`${assetType} requires a safe official URL or embed configuration.`);
  return {
    id: input.id || id("asset"), providerAccountId: requiredSingleLine(input.providerAccountId || input.provider_account_id || providerAccount?.id, "providerAccountId", 200),
    provider, assetType, productCategory, scopeType,
    scopeKey: singleLine(truncate(input.scopeKey || input.scope_key, 300)),
    destinationSlug: slugify(input.destinationSlug || input.destination_slug || ""), areaKey: singleLine(truncate(input.areaKey || input.area_key, 300)),
    routeKey: singleLine(truncate(input.routeKey || input.route_key, 300)), entityKey: singleLine(truncate(input.entityKey || input.entity_key, 300)),
    entityName: singleLine(truncate(input.entityName || input.entity_name, 300)), providerEntityId: singleLine(truncate(input.providerEntityId || input.provider_entity_id, 300)),
    title: requiredSingleLine(input.title, "title", 500), description: truncate(input.description, 1_000),
    ctaLabel: singleLine(truncate(input.ctaLabel || input.cta_label || "View option", 100)).replaceAll("|", " "),
    targetUrl, embedConfig, language: singleLine(truncate(input.language || "en", 30)), priority: boundedInteger(input.priority, -100, 100), active: input.active !== false,
    validFrom: safeDate(input.validFrom || input.valid_from), validUntil: safeDate(input.validUntil || input.valid_until),
    sourceUpdatedAt: safeDate(input.sourceUpdatedAt || input.source_updated_at) || now(), legacyOfferId: input.legacyOfferId || input.legacy_offer_id || null,
  };
}

export function normalizeCommercialOffer(input) {
  if (!input || typeof input !== "object") throw new CommercialValidationError("Offer must be an object.");
  const provider = requiredSingleLine(input.provider, "provider", 100);
  const externalId = requiredSingleLine(input.externalId, "externalId", 200);
  const category = requiredSingleLine(input.category, "category", 50);
  if (!OFFER_CATEGORIES.has(category)) throw new CommercialValidationError(`Unsupported offer category: ${category}`);
  const destinationSlug = slugify(required(input.destinationSlug, "destinationSlug", 200));
  return {
    id: id("offer"), offerKey: `${slugify(provider)}:${externalId}`, provider, externalId, category, destinationSlug,
    title: requiredSingleLine(input.title, "title", 500), targetUrl: safeAffiliateUrl(input.targetUrl),
    ctaLabel: singleLine(truncate(input.ctaLabel || "View option", 100)).replaceAll("|", " "), description: truncate(input.description, 1_000),
    priceText: truncate(input.priceText, 100), validUntil: safeDate(input.validUntil), priority: boundedInteger(input.priority, -100, 100),
    active: input.active !== false, sourceUpdatedAt: safeDate(input.sourceUpdatedAt) || now(),
  };
}

export function legacyOfferToAsset(offer, providerAccountId) {
  return normalizeAffiliateAsset({
    id: `asset_${offer.id}`, providerAccountId, provider: offer.provider, assetType: "CATEGORY_LINK",
    productCategory: CATEGORY_COMPATIBILITY.get(offer.category) || "PLANNER", scopeType: "DESTINATION",
    scopeKey: offer.destinationSlug, destinationSlug: offer.destinationSlug, title: offer.title,
    description: offer.description, ctaLabel: offer.ctaLabel, targetUrl: offer.targetUrl,
    priority: offer.priority, active: offer.active, validUntil: offer.validUntil,
    sourceUpdatedAt: offer.sourceUpdatedAt, legacyOfferId: offer.id,
  });
}

export class CommercialComposer {
  constructor(config = {}) {
    this.config = {
      maxOffersPerDraft: 3, maxContextualUnits: 2, maxEndResourceUnits: 1,
      minBlockDistance: 3, minimumContentBlocks: 2, opportunityThreshold: 70,
      disclosure: "SoloToChina may earn a commission from eligible bookings, at no extra cost to you.", ...config,
    };
  }

  compose(contentPackage, assets) {
    const researchBody = contentPackage.draft.body_markdown;
    const researchBlocks = Array.isArray(contentPackage.draft.content_blocks) && contentPackage.draft.content_blocks.length
      ? contentPackage.draft.content_blocks : markdownToContentBlocks(researchBody);
    const intents = detectCommercialIntents(contentPackage, researchBlocks);
    const allResolutions = intents.map((intent) => resolveAffiliateAsset(intent, assets));
    const selected = applyDensityGuard(allResolutions.filter((item) => item.asset), researchBlocks.length, this.config);
    const opportunities = dedupeOpportunities(intents.map((intent, index) => buildOpportunity(intent, allResolutions[index], this.config.opportunityThreshold)).filter(Boolean));
    if (!selected.length) return {
      publishableBodyMarkdown: researchBody, contentBlocks: researchBlocks, commercialBlocks: [], intents, slots: [], offerIds: [], assetIds: [],
      disclosureText: "", requiredComponents: [], opportunities, status: "no_offers",
    };
    const commercialBlocks = selected.map(({ intent, asset, placement }, index) => commercialBlock(intent, asset, placement, index, this.config.disclosure));
    const contentBlocks = insertCommercialBlocks(researchBlocks, commercialBlocks);
    const slots = commercialBlocks.map((block) => ({
      slot_key: block.slot_key, category: LEGACY_CATEGORY.get(block.data.product_category) || block.data.product_category.toLowerCase(),
      product_category: block.data.product_category, affiliate_asset_id: block.data.affiliate_asset_id, offer_id: block.data.legacy_offer_id || null,
      provider: block.data.provider, component_type: block.component, placement: block.placement, block_index: block.after_block_index,
    }));
    const endBlocks = commercialBlocks.filter((block) => block.placement === "end_resource");
    const publishableBodyMarkdown = endBlocks.length
      ? `${researchBody.trim()}\n\n---\n\n## Optional booking resources\n\n*${this.config.disclosure}*\n\n${endBlocks.map(markdownCommercialBlock).join("\n\n")}` : researchBody;
    return {
      publishableBodyMarkdown, contentBlocks, commercialBlocks, intents, slots,
      offerIds: selected.map(({ asset }) => asset.legacy_offer_id || (asset.category ? asset.id : null)).filter(Boolean), assetIds: selected.map(({ asset }) => asset.id),
      disclosureText: this.config.disclosure, requiredComponents: [...new Set(commercialBlocks.map((block) => block.component))], opportunities, status: "composed",
    };
  }
}

export function detectCommercialIntents(contentPackage, blocks) {
  const destination = contentPackage.brief?.destination_slug || contentPackage.candidate?.destination_slug
    || String(contentPackage.candidate?.topic_key || "").split(":", 1)[0] || "";
  const canonical = contentPackage.brief?.canonical || {};
  const output = [];
  blocks.forEach((block, blockIndex) => {
    const text = blockText(block);
    const context = `${blockIndex ? blockText(blocks[blockIndex - 1]) : ""} ${text}`.toLowerCase();
    for (const [productCategory, pattern] of Object.entries(INTENT_PATTERNS)) {
      if (!pattern.test(context)) continue;
      const veryHigh = /how to (?:book|buy|visit)|tickets?|booking|reserve|train from|train to/i.test(context);
      const high = veryHigh || /where to stay|compare|search|schedule|airport transfer/i.test(context);
      const scope = inferIntentScope(productCategory, context, destination, canonical);
      output.push({
        id: id("intent"), blockIndex, blockKey: `block-${blockIndex}`, intentType: scope.intentType,
        productCategory, destinationSlug: destination, areaKey: scope.areaKey, routeKey: scope.routeKey, entityKey: scope.entityKey,
        scopeType: scope.scopeType, scopeKey: scope.scopeKey, intentStrength: veryHigh ? "VERY_HIGH" : high ? "HIGH" : "MEDIUM",
        decisionStage: veryHigh ? "TRANSACTION" : high ? "COMPARISON" : "DISCOVERY",
        recommendedComponent: recommendedComponent(productCategory, veryHigh, context), reason: `Block ${blockIndex + 1} contains ${productCategory.toLowerCase()} decision language.`,
      });
    }
  });
  {
    const articleContext = `${contentPackage.candidate?.topic_key || ""} ${contentPackage.brief?.topic || ""} ${contentPackage.draft.title}`.toLowerCase();
    const detectedCategories = new Set(output.map((item) => item.productCategory));
    for (const [productCategory, pattern] of Object.entries(INTENT_PATTERNS)) {
      if (detectedCategories.has(productCategory) || !pattern.test(articleContext)) continue;
      output.push({
        id: id("intent"), blockIndex: Math.max(0, blocks.length - 1), blockKey: "article-fallback", intentType: "DESTINATION_GUIDE",
        productCategory, destinationSlug: destination, areaKey: "", routeKey: "", entityKey: "", scopeType: "DESTINATION", scopeKey: destination,
        intentStrength: "MEDIUM", decisionStage: "DISCOVERY", recommendedComponent: "affiliate_banner", reason: "Article-level context supports only a final utility fallback.",
      });
    }
  }
  return dedupeIntents(output);
}

export function resolveAffiliateAsset(intent, assets, clock = new Date()) {
  const active = (assets || []).filter((asset) => isAssetActive(asset, clock) && canonicalCategory(asset) === intent.productCategory);
  const preference = scopePreference(intent);
  let best = null;
  for (const asset of active) {
    const scopeType = String(asset.scope_type || asset.scopeType || (asset.category ? "DESTINATION" : "")).toUpperCase();
    const index = preference.indexOf(scopeType);
    if (index < 0 || !scopeMatches(intent, asset, scopeType)) continue;
    const score = (preference.length - index) * 100 + Number(asset.priority || 0) + landingSpecificity(asset);
    if (!best || score > best.score) best = { asset, score, matchedScope: scopeType, exact: index === 0 };
  }
  return { intent, asset: best?.asset || null, matchedScope: best?.matchedScope || null, exact: best?.exact || false, score: best?.score || 0 };
}

export function normalizeCommercialEvent(input, strategyVersion) {
  const eventType = enumValue(input?.eventType || input?.event_type, new Set(["impression", "click", "booking", "commission"]), "eventType", false);
  return {
    id: id("commercial_event"), eventType, articleId: singleLine(truncate(input.articleId || input.article_id, 300)) || null,
    draftId: singleLine(truncate(input.draftId || input.draft_id, 300)) || null, offerId: singleLine(truncate(input.offerId || input.offer_id, 300)) || null,
    affiliateAssetId: singleLine(truncate(input.affiliateAssetId || input.affiliate_asset_id, 300)) || null,
    provider: requiredSingleLine(input.provider, "provider", 100), category: requiredSingleLine(input.category, "category", 80),
    slotKey: requiredSingleLine(input.slotKey || input.slot_key, "slotKey", 200), componentVariant: singleLine(truncate(input.componentVariant || input.component_variant, 100)),
    placement: singleLine(truncate(input.placement, 100)), entityKey: singleLine(truncate(input.entity || input.entityKey || input.entity_key, 300)),
    routeKey: singleLine(truncate(input.route || input.routeKey || input.route_key, 300)), destinationSlug: slugify(input.destination || input.destinationSlug || input.destination_slug || ""),
    device: singleLine(truncate(input.device, 100)), locale: singleLine(truncate(input.locale, 30)), strategyVersion,
    valueAmount: Number.isFinite(Number(input.valueAmount || input.value_amount)) ? Number(input.valueAmount || input.value_amount) : null,
    occurredAt: safeDate(input.timestamp || input.occurredAt || input.occurred_at) || now(),
  };
}

export function normalizeCommissionRule(input) {
  const productCategory = enumValue(input?.productCategory || input?.product_category, PRODUCT_CATEGORIES, "productCategory");
  const effectiveRate = input?.effectiveRate ?? input?.effective_rate;
  const promotionMultiplier = Number(input?.promotionMultiplier ?? input?.promotion_multiplier ?? 1);
  if (effectiveRate != null && (!Number.isFinite(Number(effectiveRate)) || Number(effectiveRate) < 0)) throw new CommercialValidationError("effectiveRate must be a non-negative number or null.");
  if (!Number.isFinite(promotionMultiplier) || promotionMultiplier <= 0) throw new CommercialValidationError("promotionMultiplier must be positive.");
  return {
    id: input.id || id("commission_rule"), provider: requiredSingleLine(input.provider, "provider", 100), productCategory,
    commissionModel: requiredSingleLine(input.commissionModel || input.commission_model, "commissionModel", 100),
    effectiveRate: effectiveRate == null ? null : Number(effectiveRate), validFrom: safeDate(input.validFrom || input.valid_from),
    validUntil: safeDate(input.validUntil || input.valid_until), promotionMultiplier,
    sourceUpdatedAt: safeDate(input.sourceUpdatedAt || input.source_updated_at) || now(),
  };
}

function applyDensityGuard(resolutions, blockCount, config) {
  const selected = [];
  const categories = new Set();
  for (const resolution of resolutions.sort((a, b) => intentRank(b.intent) - intentRank(a.intent) || b.score - a.score)) {
    if (selected.length >= Math.min(config.maxOffersPerDraft, config.maxContextualUnits + config.maxEndResourceUnits)) break;
    if (categories.has(resolution.intent.productCategory)) continue;
    const contextual = blockCount >= config.minimumContentBlocks && resolution.intent.intentStrength !== "MEDIUM";
    const placement = contextual && selected.filter((item) => item.placement === "contextual").length < config.maxContextualUnits ? "contextual" : "end_resource";
    if (placement === "end_resource" && selected.some((item) => item.placement === "end_resource")) continue;
    if (placement === "contextual" && selected.some((item) => Math.abs(item.intent.blockIndex - resolution.intent.blockIndex) < config.minBlockDistance)) continue;
    selected.push({ ...resolution, placement }); categories.add(resolution.intent.productCategory);
  }
  return selected;
}

function buildOpportunity(intent, resolution, threshold) {
  if (resolution.exact || !["HIGH", "VERY_HIGH"].includes(intent.intentStrength)) return null;
  const factors = {
    trafficPotential: intent.trafficPotential || (["ENTITY", "ROUTE"].includes(intent.scopeType) ? 80 : 40), commercialIntent: intent.intentStrength === "VERY_HIGH" ? 95 : 75,
    frequency: intent.frequency || (["ENTITY", "ROUTE"].includes(intent.scopeType) ? 75 : 40), expectedBookingValue: intent.productCategory === "HOTEL" ? 70 : 65,
    landingPageMismatch: resolution.asset ? 60 : 85, expectedRevenueUplift: intent.intentStrength === "VERY_HIGH" ? 80 : 60,
  };
  const values = Object.values(factors);
  const score = Math.pow(values.reduce((total, value) => total * (value / 100), 1), 1 / values.length) * 100;
  if (score < threshold) return null;
  return {
    id: id("affiliate_opportunity"), intentId: intent.id, provider: resolution.asset?.provider || "trip.com",
    productCategory: intent.productCategory, scopeType: intent.scopeType, scopeKey: intent.scopeKey, score: Math.min(100, Math.round(score)), factors,
    reason: "A high-intent block has a material landing-page precision gap; manual official-link creation may justify its cost.",
  };
}

function commercialBlock(intent, asset, placement, index, disclosure) {
  const component = COMPONENT_BY_ASSET[asset.asset_type || asset.assetType] || intent.recommendedComponent;
  return {
    type: "commercial", component, placement, after_block_index: intent.blockIndex, slot_key: `${placement}:${intent.productCategory.toLowerCase()}:${index + 1}`,
    data: {
      affiliate_asset_id: asset.id, legacy_offer_id: asset.legacy_offer_id || (asset.category ? asset.id : null), provider: asset.provider,
      asset_type: asset.asset_type || asset.assetType, product_category: canonicalCategory(asset), title: asset.title, description: asset.description || "",
      cta_label: asset.cta_label || asset.ctaLabel, target_url: asset.target_url || asset.targetUrl || "", embed_config: parseEmbed(asset.embed_config_json || asset.embedConfig),
      disclosure, scope_type: asset.scope_type || asset.scopeType, scope_key: asset.scope_key || asset.scopeKey || "",
    },
  };
}

function insertCommercialBlocks(researchBlocks, commercialBlocks) {
  const output = [...researchBlocks];
  for (const block of [...commercialBlocks].sort((a, b) => b.after_block_index - a.after_block_index)) {
    const index = block.placement === "end_resource" ? output.length : Math.min(output.length, block.after_block_index + 1);
    output.splice(index, 0, block);
  }
  return output;
}

function markdownCommercialBlock(block) { const data = block.data; return [`### ${data.title}`, data.description, data.target_url ? `[[affiliate:${data.cta_label}|${data.target_url}]]` : ""].filter(Boolean).join("\n\n"); }

function inferIntentScope(productCategory, context, destination, canonical) {
  const entityKey = canonical.entity_key || canonical.primary_entity?.key || "";
  const routeKey = canonical.route_key || canonical.route?.key || "";
  const areaKey = canonical.area_key || canonical.area?.key || "";
  if (productCategory === "TRAIN" && routeKey) return { intentType: "INTERCITY_TRANSPORT", scopeType: "ROUTE", scopeKey: routeKey, routeKey, areaKey: "", entityKey: "" };
  if (productCategory === "HOTEL" && /hotel review|review of|staying at/i.test(context) && entityKey) return { intentType: "HOTEL_REVIEW", scopeType: "ENTITY", scopeKey: entityKey, entityKey, routeKey: "", areaKey: "" };
  if (productCategory === "HOTEL" && areaKey) return { intentType: "WHERE_TO_STAY", scopeType: "AREA", scopeKey: areaKey, areaKey, routeKey: "", entityKey: "" };
  if (["ATTRACTION", "TOUR_ACTIVITY"].includes(productCategory) && entityKey) return { intentType: "ATTRACTION_GUIDE", scopeType: "ENTITY", scopeKey: entityKey, entityKey, routeKey: "", areaKey: "" };
  return { intentType: "DESTINATION_GUIDE", scopeType: "DESTINATION", scopeKey: destination, entityKey: "", routeKey: "", areaKey: "" };
}

function scopePreference(intent) {
  if (intent.intentType === "HOTEL_REVIEW") return ["ENTITY", "AREA", "DESTINATION", "COUNTRY", "CATEGORY", "GLOBAL"];
  if (intent.intentType === "WHERE_TO_STAY") return ["AREA", "DESTINATION", "COUNTRY", "CATEGORY", "GLOBAL"];
  if (intent.intentType === "ATTRACTION_GUIDE") return ["ENTITY", "DESTINATION", "COUNTRY", "CATEGORY", "GLOBAL"];
  if (intent.intentType === "INTERCITY_TRANSPORT") return ["ROUTE", "DESTINATION", "COUNTRY", "CATEGORY", "GLOBAL"];
  return ["DESTINATION", "COUNTRY", "CATEGORY", "GLOBAL"];
}

function scopeMatches(intent, asset, scopeType) {
  const key = asset.scope_key || asset.scopeKey || asset.entity_key || asset.route_key || asset.area_key || asset.destination_slug || "";
  if (scopeType === "GLOBAL") return true;
  if (scopeType === "CATEGORY") return canonicalCategory(asset) === intent.productCategory;
  if (scopeType === "DESTINATION") return !key || key === intent.destinationSlug || asset.destination_slug === intent.destinationSlug;
  const intended = scopeType === "ENTITY" ? intent.entityKey : scopeType === "ROUTE" ? intent.routeKey : scopeType === "AREA" ? intent.areaKey : intent.scopeKey;
  return Boolean(intended && key === intended);
}

function isAssetActive(asset, clock) {
  if (asset.active === false || asset.active === 0) return false;
  const nowValue = clock.valueOf(); const starts = Date.parse(asset.valid_from || asset.validFrom || ""); const ends = Date.parse(asset.valid_until || asset.validUntil || "");
  return (!Number.isFinite(starts) || starts <= nowValue) && (!Number.isFinite(ends) || ends > nowValue);
}

function canonicalCategory(asset) { return String(asset.product_category || asset.productCategory || CATEGORY_COMPATIBILITY.get(asset.category) || "").toUpperCase(); }
function landingSpecificity(asset) { return ({ ENTITY: 30, ROUTE: 28, AREA: 20, DESTINATION: 15, COUNTRY: 10, CATEGORY: 5, GLOBAL: 0 })[asset.scope_type || asset.scopeType] || 0; }
function intentRank(intent) { return ({ VERY_HIGH: 4, HIGH: 3, MEDIUM: 2, LOW: 1 })[intent.intentStrength] || 0; }
function recommendedComponent(productCategory, veryHigh, context) { if (veryHigh) return "affiliate_booking_card"; if (productCategory === "HOTEL" || /compare|search/i.test(context)) return "affiliate_search_card"; return "affiliate_banner"; }
function blockText(block) { return block?.type === "list" ? (block.items || []).join(" ") : block?.text || ""; }
function dedupeIntents(items) { const seen = new Set(); return items.filter((item) => { const key = `${item.blockKey}:${item.productCategory}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
function dedupeOpportunities(items) { const best = new Map(); for (const item of items) { const key = `${item.productCategory}:${item.scopeType}:${item.scopeKey}`; if (!best.has(key) || best.get(key).score < item.score) best.set(key, item); } return [...best.values()]; }
function parseEmbed(value) { if (!value) return {}; if (typeof value === "object") return value; try { return JSON.parse(value); } catch { return {}; } }

const INTENT_PATTERNS = {
  HOTEL: /hotel|accommodation|where to stay|first.time|solo guide|住宿|酒店/i, ATTRACTION: /ticket|attraction|museum|palace|temple|entry|visit|门票|景点|入场/i,
  TRAIN: /train|railway|intercity|station|high.speed rail|火车|高铁|铁路/i, FLIGHT: /flight|fly|airfare|航班|机票/i,
  TOUR_ACTIVITY: /tour|activity|day trip|experience|旅行团|一日游|体验/i, AIRPORT_TRANSFER: /airport transfer|airport pickup|机场接送|接机/i,
  PLANNER: /planner|itinerary|行程规划/i,
};

function normalizeEmbedConfig(value, assetType, provider) {
  if (!value) return {};
  let config = value;
  if (typeof value === "string") {
    if (/<\/?(?:script|iframe|object|embed|style)|javascript:/iu.test(value)) throw new CommercialValidationError("Raw HTML or script is not allowed in embed configuration.");
    try { config = JSON.parse(value); } catch { throw new CommercialValidationError("embedConfig must be structured JSON, not HTML."); }
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new CommercialValidationError("embedConfig must be an object.");
  const prohibited = Object.keys(config).find((key) => /html|script|markup|onload|onclick/i.test(key));
  if (prohibited) throw new CommercialValidationError(`embedConfig field '${prohibited}' is not allowed.`);
  const allowedTypes = { SEARCH_BOX: "search_box", STATIC_BANNER: "static_banner", DYNAMIC_BANNER: "dynamic_banner" };
  if (config.embedType && config.embedType !== allowedTypes[assetType]) throw new CommercialValidationError("embedConfig.embedType does not match assetType.");
  if (config.src) {
    const url = new URL(config.src);
    if (url.protocol !== "https:" || url.username || url.password) throw new CommercialValidationError("embedConfig.src must be a credential-free HTTPS URL.");
    if (/trip/i.test(provider) && !["trip.com", "tripcdn.com", "ctrip.com"].some((suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`))) throw new CommercialValidationError("Trip.com embed sources must use an allowlisted official domain.");
    config = { ...config, src: url.toString() };
  }
  return config;
}

function required(value, field, max) { const text = truncate(value, max).trim(); if (!text) throw new CommercialValidationError(`${field} is required.`); return text; }
function requiredSingleLine(value, field, max) { return singleLine(required(value, field, max)); }
function singleLine(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
function safeAffiliateUrl(value) { try { const url = new URL(value); if (url.protocol !== "https:" || url.username || url.password) throw new Error("unsafe"); return truncate(url.toString(), 4_000); } catch { throw new CommercialValidationError("targetUrl must be a credential-free HTTPS URL."); } }
function safeDate(value) { if (!value) return null; const date = new Date(value); if (Number.isNaN(date.valueOf())) throw new CommercialValidationError("Date fields must be valid ISO dates."); return date.toISOString(); }
function boundedInteger(value, min, max) { return Math.max(min, Math.min(max, Number.parseInt(value || "0", 10) || 0)); }
function enumValue(value, allowed, field, uppercase = true) { const normalized = uppercase ? String(value || "").toUpperCase() : String(value || "").toLowerCase(); if (!allowed.has(normalized)) throw new CommercialValidationError(`Unsupported ${field}: ${value}`); return normalized; }

export class CommercialValidationError extends Error { constructor(message) { super(message); this.name = "CommercialValidationError"; } }
