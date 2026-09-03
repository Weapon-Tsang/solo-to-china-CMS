export const ENTITY_TYPES = new Set([
  "place", "attraction", "restaurant", "hotel", "transport_hub", "route", "city", "district",
  "region", "country", "organization", "government_agency", "event", "category", "collection",
  "topic", "policy", "rule", "procedure", "product_or_service", "other",
]);

export const ENTITY_GRANULARITIES = new Set([
  "specific_entity", "collection", "category", "route", "area", "city_level", "regional",
  "national", "general_topic",
]);

export const ENTITY_RELATION_TYPES = new Set([
  "same_as", "alias_of", "member_of", "part_of", "located_in", "applies_to", "related_to",
  "supports", "contradicts", "generalizes", "specializes", "derived_from", "example_of",
]);

const SPECIFIC_TYPES = new Set(["place", "attraction", "restaurant", "hotel", "transport_hub", "organization", "government_agency", "event", "product_or_service"]);
const COLLECTION_PATTERN = /\b(?:several|multiple|listed|popular|top|best|various|attractions|hotels|restaurants|places|things to do)\b|若干|多个|热门景点|景点集合|酒店推荐|餐厅合集/iu;
const CLAIM_LIKE_PATTERN = /\b(?:advance reservation|require[sd]? reservation|opening hours?|ticket price|how to book|booking rule)\b|提前预约|需要预约|开放时间|门票价格|如何预订/iu;

export function normalizeEntityType(value, fallback = "other") {
  const normalized = String(value || "").trim().toLowerCase();
  return ENTITY_TYPES.has(normalized) ? normalized : fallback;
}

export function normalizeGranularity(value, fallback = "general_topic") {
  const normalized = String(value || "").trim().toLowerCase();
  return ENTITY_GRANULARITIES.has(normalized) ? normalized : fallback;
}

export function inferEntityMetadata(name, entityKey = "", supplied = {}) {
  const cleanName = String(name || "").replace(/\s+/g, " ").trim();
  let entityType = normalizeEntityType(supplied.entityType || supplied.entity_type);
  let granularity = normalizeGranularity(supplied.granularity);
  const prefix = String(entityKey || "").split(".", 1)[0];
  if (ENTITY_TYPES.has(prefix) && entityType === "other") entityType = prefix;
  if (COLLECTION_PATTERN.test(cleanName)) {
    entityType = entityType === "category" ? "category" : "collection";
    granularity = entityType === "category" ? "category" : "collection";
  } else if (CLAIM_LIKE_PATTERN.test(cleanName)) {
    entityType = ["policy", "rule", "procedure"].includes(entityType) ? entityType : "topic";
    granularity = "general_topic";
  } else if (entityType === "route") granularity = "route";
  else if (entityType === "city") granularity = "city_level";
  else if (["district", "region"].includes(entityType)) granularity = entityType === "district" ? "area" : "regional";
  else if (entityType === "country") granularity = "national";
  else if (["category", "collection", "topic"].includes(entityType)) granularity = entityType === "topic" ? "general_topic" : entityType;
  else if (SPECIFIC_TYPES.has(entityType)) granularity = "specific_entity";
  return { entityType, granularity, location: safeLocation(supplied.location) };
}

export function assessEntityIdentity(candidate) {
  const alias = inferEntityMetadata(candidate.alias, candidate.candidateEntityKey || candidate.candidate_entity_key, {
    entityType: candidate.candidateEntityType || candidate.candidate_entity_type,
    granularity: candidate.candidateGranularity || candidate.candidate_granularity,
    location: candidate.candidateLocation || candidate.location,
  });
  const target = inferEntityMetadata(candidate.proposedCanonicalSubject || candidate.proposed_canonical_subject,
    candidate.proposedEntityKey || candidate.proposed_entity_key, {
      entityType: candidate.proposedEntityType || candidate.proposed_entity_type,
      granularity: candidate.proposedGranularity || candidate.proposed_granularity,
      location: candidate.proposedLocation || candidate.location,
    });
  const reasons = [];
  if (!typesCompatible(alias.entityType, target.entityType)) reasons.push(`entity_type mismatch (${alias.entityType} vs ${target.entityType})`);
  if (!granularityCompatible(alias.granularity, target.granularity)) reasons.push(`granularity mismatch (${alias.granularity} vs ${target.granularity})`);
  if (!geographyCompatible(alias.location, target.location)) reasons.push("geographic identity mismatch");
  if (looksGenericOrClaimLike(candidate.alias) || looksGenericOrClaimLike(candidate.proposedCanonicalSubject || candidate.proposed_canonical_subject)) {
    reasons.push("generic collection/category or claim-like wording is not a plausible alias identity");
  }
  if (reasons.length) {
    return {
      decision: "DO_NOT_MERGE", reasons,
      suggestedRelation: suggestRelation(alias, target), alias, target,
    };
  }
  const confidence = Number(candidate.confidence || 0);
  return {
    decision: confidence >= 0.85 ? "MERGE" : "UNCERTAIN",
    reasons: confidence >= 0.85 ? ["type, granularity, geography, and alias plausibility constraints passed"] : ["identity remains plausible but evidence is insufficient"],
    suggestedRelation: confidence >= 0.85 ? "alias_of" : null,
    alias, target,
  };
}

export function typesCompatible(left, right) {
  if (left === right) return true;
  if (left === "other" || right === "other") return true;
  if ([left, right].every((item) => ["place", "attraction"].includes(item))) return true;
  return false;
}

export function granularityCompatible(left, right) {
  if (left === right) return true;
  if (left === "general_topic" || right === "general_topic") return false;
  return false;
}

function geographyCompatible(left, right) {
  const keys = ["country", "region", "city", "district", "latitude", "longitude"];
  for (const key of keys) {
    if (left?.[key] != null && right?.[key] != null && normalize(left[key]) !== normalize(right[key])) return false;
  }
  return true;
}

function suggestRelation(alias, target) {
  if (alias.granularity === "specific_entity" && ["collection", "category"].includes(target.granularity)) return "member_of";
  if (["collection", "category"].includes(alias.granularity) && target.granularity === "specific_entity") return "generalizes";
  if (alias.entityType === "topic" || target.entityType === "topic") return "related_to";
  return "related_to";
}

function looksGenericOrClaimLike(value) {
  const text = String(value || "");
  return !text.trim() || COLLECTION_PATTERN.test(text) || CLAIM_LIKE_PATTERN.test(text);
}

function safeLocation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => ["country", "region", "city", "district", "latitude", "longitude"].includes(key) && item != null));
}

function normalize(value) { return String(value).normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim(); }
