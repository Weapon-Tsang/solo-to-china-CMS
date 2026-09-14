export const FRONTEND_GUIDE_TYPES = Object.freeze([
  "survival-kit",
  "city-guide",
  "attraction-guide",
  "travel-guide",
]);

const FRONTEND_GUIDE_TYPE_SET = new Set(FRONTEND_GUIDE_TYPES);

const INTERNAL_TO_FRONTEND_GUIDE_TYPE = Object.freeze({
  city_guide: "city-guide",
  first_time_guide: "city-guide",
  food_guide: "city-guide",
  neighborhood_guide: "city-guide",
  hotel_area_guide: "city-guide",
  shopping_guide: "city-guide",
  attraction_guide: "attraction-guide",
  practical_guide: "survival-kit",
  transport_guide: "survival-kit",
  how_to: "survival-kit",
  itinerary: "travel-guide",
  comparison: "travel-guide",
  listicle: "travel-guide",
});

export function isFrontendGuideType(value) {
  return FRONTEND_GUIDE_TYPE_SET.has(String(value || "").trim());
}

export function toFrontendGuideType(value, fallback = null) {
  const normalized = String(value || "").trim();
  if (isFrontendGuideType(normalized)) return normalized;
  if (INTERNAL_TO_FRONTEND_GUIDE_TYPE[normalized]) return INTERNAL_TO_FRONTEND_GUIDE_TYPE[normalized];
  const normalizedFallback = String(fallback || "").trim();
  if (isFrontendGuideType(normalizedFallback)) return normalizedFallback;
  if (INTERNAL_TO_FRONTEND_GUIDE_TYPE[normalizedFallback]) return INTERNAL_TO_FRONTEND_GUIDE_TYPE[normalizedFallback];
  return normalized;
}

export function normalizeFrontendPageTaxonomy(pagePayload, fallbackContentType = null) {
  if (!pagePayload || typeof pagePayload !== "object" || Array.isArray(pagePayload)) return pagePayload;
  const page = structuredClone(pagePayload);
  page.metadata = page.metadata && typeof page.metadata === "object" && !Array.isArray(page.metadata)
    ? page.metadata : {};
  const contentType = toFrontendGuideType(page.metadata.contentType, fallbackContentType);
  if (contentType) page.metadata.contentType = contentType;
  return page;
}
