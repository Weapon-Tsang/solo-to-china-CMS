import { id, now, slugify, truncate } from "./utils.mjs";

export const OFFER_CATEGORIES = new Set([
  "hotels", "attraction_tickets", "trains", "flights", "tours_activities", "airport_transfer", "planner",
]);

export function normalizeCommercialOffer(input) {
  if (!input || typeof input !== "object") throw new CommercialValidationError("Offer must be an object.");
  const provider = requiredSingleLine(input.provider, "provider", 100);
  const externalId = requiredSingleLine(input.externalId, "externalId", 200);
  const category = requiredSingleLine(input.category, "category", 50);
  if (!OFFER_CATEGORIES.has(category)) throw new CommercialValidationError(`Unsupported offer category: ${category}`);
  const destinationSlug = slugify(required(input.destinationSlug, "destinationSlug", 200));
  const targetUrl = safeAffiliateUrl(input.targetUrl);
  return {
    id: id("offer"),
    offerKey: `${slugify(provider)}:${externalId}`,
    provider,
    externalId,
    category,
    destinationSlug,
    title: requiredSingleLine(input.title, "title", 500),
    targetUrl,
    ctaLabel: singleLine(truncate(input.ctaLabel || "View option", 100)).replaceAll("|", " "),
    description: truncate(input.description, 1_000),
    priceText: truncate(input.priceText, 100),
    validUntil: safeDate(input.validUntil),
    priority: Math.max(-100, Math.min(100, Number.parseInt(input.priority || "0", 10) || 0)),
    active: input.active !== false,
    sourceUpdatedAt: safeDate(input.sourceUpdatedAt) || now(),
  };
}

export class CommercialComposer {
  constructor(config) {
    this.config = config;
  }

  compose(contentPackage, offers) {
    const researchBody = contentPackage.draft.body_markdown;
    const selected = selectRelevantOffers(contentPackage, offers, this.config.maxOffersPerDraft);
    if (!selected.length) {
      return { publishableBodyMarkdown: researchBody, slots: [], offerIds: [], disclosureText: "", status: "no_offers" };
    }
    const slots = selected.map((offer) => ({
      slot_key: `end-resource:${offer.category}`,
      category: offer.category,
      offer_id: offer.id,
      provider: offer.provider,
    }));
    const modules = selected.map((offer) => [
      `### ${offer.title}`,
      offer.description,
      offer.price_text ? `Indicative offer information: ${offer.price_text}` : "",
      `[[affiliate:${offer.cta_label}|${offer.target_url}]]`,
    ].filter(Boolean).join("\n\n"));
    return {
      publishableBodyMarkdown: `${researchBody.trim()}\n\n---\n\n## Optional booking resources\n\n*${this.config.disclosure}*\n\n${modules.join("\n\n")}`,
      slots,
      offerIds: selected.map((offer) => offer.id),
      disclosureText: this.config.disclosure,
      status: "composed",
    };
  }
}

function selectRelevantOffers(contentPackage, offers, limit) {
  const context = `${contentPackage.candidate?.topic_key || ""} ${contentPackage.brief?.topic || ""} ${contentPackage.draft.title} ${contentPackage.draft.body_markdown}`.toLowerCase();
  const seenCategories = new Set();
  return offers
    .map((offer) => ({ ...offer, relevance: offer.priority + keywordScore(offer.category, context) }))
    .filter((offer) => offer.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance || a.title.localeCompare(b.title))
    .filter((offer) => {
      if (seenCategories.has(offer.category)) return false;
      seenCategories.add(offer.category);
      return true;
    })
    .slice(0, Math.max(0, limit));
}

function keywordScore(category, context) {
  const patterns = {
    hotels: /hotel|accommodation|where to stay|first.time|solo.guide/,
    attraction_tickets: /ticket|attraction|museum|palace|temple|entry|visit/,
    trains: /train|railway|intercity|station/,
    flights: /flight|fly|airfare/,
    tours_activities: /tour|activity|day trip|experience/,
    airport_transfer: /airport|transfer|arrival|departure/,
    planner: /plan|planner|itinerary|first.time|solo.guide/,
  };
  return patterns[category]?.test(context) ? 20 : 0;
}

function required(value, field, max) {
  const text = truncate(value, max).trim();
  if (!text) throw new CommercialValidationError(`${field} is required.`);
  return text;
}

function requiredSingleLine(value, field, max) {
  return singleLine(required(value, field, max));
}

function singleLine(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function safeAffiliateUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error("protocol");
    return truncate(url.toString(), 4_000);
  } catch {
    throw new CommercialValidationError("targetUrl must be a valid HTTPS URL.");
  }
}

function safeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new CommercialValidationError("Date fields must be valid ISO dates.");
  return date.toISOString();
}

export class CommercialValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CommercialValidationError";
  }
}
