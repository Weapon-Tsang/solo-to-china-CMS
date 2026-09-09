const HARD_FACT_PREDICATES = new Set([
  "opening_time", "ticket_price", "reservation_required", "address", "station", "schedule",
]);

// Bump this only when a classifier change can alter persisted Claim relations.
// Startup reconciliation uses it to rebuild destinations with pending reviews,
// so a deploy can remove newly-recognized false positives without an operator
// clicking through every old review card.
export const CLAIM_RESOLUTION_VERSION = "2026-09-09.1";

const SOFT_PREDICATES = new Set([
  "recommended_visit_time", "best_time_to_visit", "good_for", "photography_spot",
  "recommended_for", "worth_visiting",
]);

// These Claims describe an author's selection, sequence, menu, or useful set.
// They are intentionally multi-valued: two good itineraries or two dishes can
// both be true even when their values differ. Treating them as a single official
// fact creates an O(n²) wall of false conflicts as more travel notes arrive.
const ALTERNATIVE_PREDICATE_PATTERN = /(?:^|_)(?:itinerary|route|stops?|sequence|recommended_day|suggested_route|walking_route|recommended_visit_window|recommended_visit_time|visit_time|serves?_dish|serves?_food|serves?_cuisine|cuisine_type|dish_(?:type|category)|specialty_dish|signature_dish|recommended_dish|must_try_food|food_specialty|associated_food|complimentary_items|features?|has_feature|architectural_(?:style|features?)|photo(?:graphy)?_(?:spots?|locations?|perspectives?|composition|opportunit(?:y|ies))|shooting_locations?|viewpoints?|viewing_framing|viewed_through|viewable_through|offers?_view|photo_spot_for|located_(?:near|adjacent_to|in|at)|displays?_(?:text|signage|illuminated_text|led_greeting)|led_display_text|features?_led_display|safety_(?:precaution|hazard)|tourist_trap_warning|shopping_warning|quality_warning|navigation_caution|crowd_(?:condition|level|density)|crowding|crowdedness|busy_period|aliases?|alternate_name|local_name|former_name)(?:_|$)/iu;
const MULTI_NAME_PREDICATE_PATTERN = /^(?:name|alias|aliases|alternate_name|local_name|former_name)$/iu;
const DURATION_ESTIMATE_PREDICATE_PATTERN = /(?:^|_)(?:walking|transit|travel|ride|light_rail)_(?:time|duration)(?:_minutes)?(?:_|$)/iu;
const METRO_EXIT_PREDICATE_PATTERN = /(?:^|_)(?:(?:nearest_)?(?:metro|subway|underground|rail_transit)(?:_station)?_(?:exit|entrance)|(?:metro|subway)_access_exit)(?:_|$)|(?:最近|邻近)?(?:地铁|轨道交通|轻轨)(?:站)?(?:出口|出入口|口)/iu;

// These patterns describe proposition polarity and material limits. Contrastive
// wording (for example “different from daytime”) and colloquial intensifiers are
// not logical negation and must not create review noise.
const NEGATION_PATTERN = /\b(?:not|never|no|avoid|without|unable|false|optional|isn['’]?t|aren['’]?t|doesn['’]?t|don['’]?t|cannot|can['’]?t)\b|(?:无须|无需|不用|不需要|不要|不能|不可|无法|没法|未能|避免|不值得|不开放|不收费|不适合|不推荐|不接受|不提供|不允许|不包含|不支持|不营业|没有预约|没有预订|没有预定|并非|不是|非必要|非唯一|免预约)/iu;
const LIMITER_PATTERN = /\b(?:only|except|unless|but only|at most|at least)\b|(?:仅限|只有|只能|只可|只允许|只需|只在|仅在|仅可|除了|除非|例外|最多|至少|至多|唯有)/iu;
const NO_CONTACT_SOURCE_PATTERN = /(?:0|零)\s*打扰|不打扰|无需接触|无接触/iu;
const NO_CONTACT_CLAIM_PATTERN = /\b(?:contactless|no[-\s]?contact|without contact|zero disturbance|no disturbance)\b|(?:0|零)\s*打扰|不打扰|无需接触|无接触/iu;
const ONLY_GLASS_SOURCE_PATTERN = /(?:只有|全是|全部是|都是)\s*玻璃/iu;
const ONLY_GLASS_CLAIM_PATTERN = /\b(?:full|all|entirely|exclusively)[-\s]*(?:glass|glazed)|\bglass[-\s]*only\b|(?:devoid of|without|no)\b[^.]{0,80}\b(?:wall|walls|pillar|pillars)\b/iu;
const PROCEDURAL_CONVENIENCE_PATTERN = /(?:你|您)?只(?:需|需要)(?=[\p{Script=Han}\p{L}\p{N}])/gu;
const FEATURE_DESCRIPTOR_PATTERN = /(?:^|_)(?:feature|features|view|views|scenery|appearance|illumination|lighting|vegetation|amenity|amenities)(?:_|$)/iu;

const TIME_TERMS = new Map([
  ["morning", "morning"], ["上午", "morning"], ["early morning", "morning"],
  ["afternoon", "afternoon"], ["下午", "afternoon"],
  ["evening", "evening"], ["傍晚", "evening"], ["dusk", "evening"],
  ["blue hour", "blue_hour"], ["蓝调时刻", "blue_hour"],
  ["night", "night"], ["夜晚", "night"], ["夜间", "night"],
]);

export const CLAIM_RELATION_TYPES = new Set([
  "EXACT_MATCH", "PARAPHRASE", "REFINEMENT", "ENRICHMENT", "GENERALIZATION",
  "COMPATIBLE", "OVERLAPPING", "COMPLEMENTARY", "CONFLICT", "UNCERTAIN",
]);

export function structureClaim({ predicate, value, qualifiers = [], sourceQuote = "" }) {
  const rawValue = clean(value);
  const qualifierValues = cleanList(qualifiers);
  const parenthetical = rawValue.match(/^(.+?)\s*\((.+)\)\s*$/u);
  const normalizedPredicate = normalizePredicate(predicate);
  const primaryValue = canonicalPrimaryValue(clean(parenthetical?.[1] || rawValue), normalizedPredicate);
  const rationale = cleanList([
    ...qualifierValues,
    ...(parenthetical ? parenthetical[2].split(/[,;；，]/u) : []),
  ]);
  const claimKind = SOFT_PREDICATES.has(normalizedPredicate)
    ? "SOFT_RECOMMENDATION"
    : HARD_FACT_PREDICATES.has(normalizedPredicate) ? "HARD_FACT" : inferClaimKind(normalizedPredicate, rawValue);
  const cardinality = claimKind === "SOFT_RECOMMENDATION"
    ? "MULTI_VALUE" : claimKind === "CONTEXT_DEPENDENT" ? "CONTEXT_DEPENDENT" : "SINGLE_VALUE";
  const canonical = canonicalFactSemantics(predicate, rawValue, qualifierValues);
  return {
    value: primaryValue,
    normalized_value: normalizeText(primaryValue),
    canonical_predicate: canonical.predicate,
    typed_value: canonical.value,
    polarity: canonical.polarity,
    qualifiers: rationale,
    rationale,
    scope: inferScope([...qualifierValues, sourceQuote]),
    claim_kind: claimKind,
    cardinality,
  };
}

export function classifyClaimPair(left, right) {
  const a = hydrate(left);
  const b = hydrate(right);
  const extractionError = detectExtractionError(a, b);
  if (extractionError) {
    return {
      relation: "UNCERTAIN", canCoexist: true, reviewType: extractionError,
      reason: extractionError === "NEGATION_EXTRACTION_ERROR"
        ? "A source sentence contains negation that is absent from its normalized value."
        : "A source sentence contains a limiting qualifier that is absent from its normalized value.",
      scope: mergeScope(a.structured.scope, b.structured.scope),
    };
  }

  const sameScope = scopesCompatible(a.structured.scope, b.structured.scope);
  const sameCanonicalPredicate = a.structured.canonical_predicate
    && a.structured.canonical_predicate === b.structured.canonical_predicate;
  const typedA = a.structured.typed_value;
  const typedB = b.structured.typed_value;
  if (sameCanonicalPredicate && typedA != null && typedB != null) {
    if (canonicalTypedEqual(typedA, typedB)) {
      return result("PARAPHRASE", true,
        "The claims use different wording for the same canonical typed fact.", a, b);
    }
    if (a.structured.canonical_predicate === "nearest_metro_exit" && sameTransitStation(typedA, typedB)
      && (!typedA.exit || !typedB.exit)) {
      return result("REFINEMENT", true,
        "Both claims identify the same metro station; one additionally specifies the exit.", a, b);
    }
    if (sameScope) {
      return result("CONFLICT", false,
        "The claims assign opposing typed values to the same canonical fact under a compatible scope.", a, b, "SOURCE_CONFLICT");
    }
  }
  const aValue = a.structured.normalized_value;
  const bValue = b.structured.normalized_value;
  const exactRaw = normalizeText(a.value_text) === normalizeText(b.value_text);
  if (exactRaw) return result("EXACT_MATCH", true, "The normalized claim values are identical.", a, b);
  if (aValue === bValue) {
    const richer = a.structured.qualifiers.length !== b.structured.qualifiers.length
      || String(a.value_text).length !== String(b.value_text).length;
    return result(richer ? "ENRICHMENT" : "PARAPHRASE", true,
      richer ? "Both claims share the same primary value; one adds rationale or qualifiers." : "The claims express the same primary value in different wording.", a, b);
  }

  const featurePair = isFeatureClaim(a) && isFeatureClaim(b);
  const sameEvidence = normalizeText(a.source_quote) && normalizeText(a.source_quote) === normalizeText(b.source_quote);
  if (featurePair && sameEvidence && a.structured.polarity === b.structured.polarity) {
    const timedEnrichment = hasSameTimeEvidence(a, b)
      && normalizeText(a.value_text) !== normalizeText(b.value_text);
    return result(timedEnrichment ? "ENRICHMENT" : "PARAPHRASE", true,
      timedEnrichment
        ? "The feature claims share the same time evidence; one adds descriptive detail."
        : "The feature claims normalize the same source evidence in different languages or wording.", a, b);
  }
  if (featurePair && sameScope && a.structured.polarity === "positive" && b.structured.polarity === "positive"
    && (isPositiveBoolean(aValue) !== isPositiveBoolean(bValue))) {
    return result("ENRICHMENT", true,
      "A positive boolean feature flag confirms the more descriptive feature value.", a, b);
  }
  if (featurePair && sameScope && a.structured.polarity === "positive" && b.structured.polarity === "positive"
    && sameDecisionConcept(a, b) && !hasMaterialLimiter(claimSemanticText(a)) && !hasMaterialLimiter(claimSemanticText(b))) {
    return result("ENRICHMENT", true,
      "Positive descriptions of the same feature can coexist; they provide different wording or additional detail.", a, b);
  }

  // A normalized knowledge key is an indexing hint, not proof that two
  // differently-shaped predicates assert the same fact. Entity resolution may
  // intentionally group related facts such as "located_at" and "located_in",
  // or "photo_composition" and "viewed_through". Only canonical aliases (price,
  // hours, reservation, and future typed facts) are allowed to cross predicate
  // boundaries and conflict. Everything else remains complementary.
  if (!sameCanonicalPredicate) {
    const bothRecommendations = a.structured.claim_kind === "SOFT_RECOMMENDATION"
      && b.structured.claim_kind === "SOFT_RECOMMENDATION";
    return result(bothRecommendations ? "COMPATIBLE" : "COMPLEMENTARY", true,
      "The claims describe related but different properties and may coexist; a shared knowledge key alone is not a contradiction.", a, b);
  }

  const opposingPolarity = hasNegation(a.value_text) !== hasNegation(b.value_text);
  if (sameScope && opposingPolarity && sameDecisionConcept(a, b)) {
    return result("CONFLICT", false, "The claims make opposite assertions under a compatible scope.", a, b, "CLAIM_CONFLICT");
  }

  if (!sameScope) return result("COMPATIBLE", true, "The values apply under different scope, time, audience, season, or conditions.", a, b);

  const kind = strongestKind(a.structured.claim_kind, b.structured.claim_kind);
  if (kind === "HARD_FACT" && hasSameTimeEvidence(a, b)) {
    return result("ENRICHMENT", true,
      "Both hard-fact claims contain the same time evidence; the longer wording adds description rather than a conflicting value.", a, b);
  }
  if (kind === "HARD_FACT") {
    return result("CONFLICT", false, "Different single-value hard facts cannot both be used under the same scope.", a, b,
      hasTemporalScope(a, b) ? "TEMPORAL_CONFLICT" : "SOURCE_CONFLICT");
  }

  const aTimes = timeTerms(a.structured.value, a.structured.qualifiers);
  const bTimes = timeTerms(b.structured.value, b.structured.qualifiers);
  if (aTimes.size && bTimes.size) {
    const overlap = [...aTimes].some((item) => bTimes.has(item));
    return result(overlap ? "OVERLAPPING" : "COMPATIBLE", true,
      overlap ? "The recommended time ranges overlap and can coexist." : "Soft visit-time recommendations may coexist as alternatives.", a, b);
  }

  if (aValue.includes(bValue) || bValue.includes(aValue)) {
    return result("REFINEMENT", true, "One claim is a more specific expression of the other.", a, b);
  }
  return result(kind === "SOFT_RECOMMENDATION" ? "COMPATIBLE" : "COMPLEMENTARY", true,
    kind === "SOFT_RECOMMENDATION" ? "Soft or multi-value recommendations may coexist." : "The claims add different compatible information.", a, b);
}

export function detectClaimExtractionIssue(claim, siblingClaims = []) {
  const quote = String(claim?.source_quote || claim?.sourceQuote || "");
  const sameQuoteClaims = [claim, ...siblingClaims].filter((candidate, index, items) => {
    const candidateQuote = String(candidate?.source_quote || candidate?.sourceQuote || "");
    const identity = candidate?.id || candidate;
    return normalizeText(candidateQuote) === normalizeText(quote)
      && items.findIndex((item) => (item?.id || item) === identity) === index;
  });
  const normalized = sameQuoteClaims.map(claimSemanticText).join(" ");
  if (NO_CONTACT_SOURCE_PATTERN.test(quote) && !NO_CONTACT_CLAIM_PATTERN.test(normalized)) return "NEGATION_EXTRACTION_ERROR";
  if (hasNegation(quote) && !hasNegation(normalized) && !semanticNegationCovered(quote, normalized, claim)) return "NEGATION_EXTRACTION_ERROR";
  if (hasMaterialLimiter(quote) && !hasMaterialLimiter(normalized) && !semanticLimiterCovered(quote, normalized)) return "QUALIFIER_EXTRACTION_ERROR";
  return null;
}

function hydrate(claim) {
  const computed = structureClaim({ predicate: claim.predicate, value: claim.value_text, qualifiers: claim.qualifiers, sourceQuote: claim.source_quote });
  const saved = claim.structured_value && typeof claim.structured_value === "object" ? claim.structured_value : {};
  const structured = {
    ...computed, ...saved, canonical_predicate: computed.canonical_predicate,
    typed_value: computed.typed_value, polarity: computed.polarity,
  };
  structured.scope ||= claim.scope || {};
  return { ...claim, structured };
}

function detectExtractionError(a, b) {
  for (const claim of [a, b]) {
    const issue = detectClaimExtractionIssue(claim);
    if (issue) return issue;
  }
  return null;
}

function result(relation, canCoexist, reason, a, b, reviewType = null) {
  return { relation, canCoexist, reason, reviewType, scope: mergeScope(a.structured.scope, b.structured.scope) };
}

function inferClaimKind(predicate, value) {
  const normalizedPredicate = normalizePredicate(predicate);
  if (ALTERNATIVE_PREDICATE_PATTERN.test(normalizedPredicate) || MULTI_NAME_PREDICATE_PATTERN.test(normalizedPredicate)) return "SOFT_RECOMMENDATION";
  if (DURATION_ESTIMATE_PREDICATE_PATTERN.test(normalizedPredicate)) return "CONTEXT_DEPENDENT";
  if (/recommend|best|good|worth|photo|visit.?time|体验|推荐|适合|值得/iu.test(`${predicate} ${value}`)) return "SOFT_RECOMMENDATION";
  if (isFeaturePredicate(predicate)) return "CONTEXT_DEPENDENT";
  if (/depend|season|audience|condition|视情况|取决于/iu.test(`${predicate} ${value}`)) return "CONTEXT_DEPENDENT";
  return "HARD_FACT";
}

function inferScope(values) {
  const text = values.join(" ");
  return {
    time: matching(text, /\b(?:morning|afternoon|evening|night|weekday|weekend|\d{1,2}:\d{2})\b|上午|下午|傍晚|夜间|工作日|周末/giu),
    season: matching(text, /\b(?:spring|summer|autumn|fall|winter)\b|春季|夏季|秋季|冬季/giu),
    visitor_type: matching(text, /\b(?:solo|family|families|children|senior|first.time|photographer)\b|独自|亲子|儿童|老人|首次|摄影/giu),
    ticket_type: matching(text, /\b(?:adult|child|student|senior|standard|discount)\s+(?:ticket|fare)\b|成人票|儿童票|学生票|优惠票/giu),
    conditions: cleanList(values.filter((item) => /\b(?:if|when|unless|except|during|because)\b|如果|当|除非|期间|因为/iu.test(item))),
  };
}

function scopesCompatible(a = {}, b = {}) {
  for (const key of ["time", "season", "visitor_type", "ticket_type"]) {
    const left = new Set(a[key] || []);
    const right = new Set(b[key] || []);
    if (left.size && right.size && ![...left].some((item) => right.has(item))) return false;
  }
  return true;
}

function mergeScope(a = {}, b = {}) {
  return Object.fromEntries(["time", "season", "visitor_type", "ticket_type", "conditions"]
    .map((key) => [key, cleanList([...(a[key] || []), ...(b[key] || [])])]));
}

function timeTerms(value, qualifiers) {
  const text = normalizeText([value, ...(qualifiers || [])].join(" "));
  const terms = new Set();
  for (const [term, canonical] of TIME_TERMS) if (text.includes(term)) terms.add(canonical);
  if (terms.has("blue_hour")) { terms.add("evening"); terms.add("night"); }
  return terms;
}

function strongestKind(a, b) {
  if (a === "HARD_FACT" || b === "HARD_FACT") return "HARD_FACT";
  if (a === "CONTEXT_DEPENDENT" || b === "CONTEXT_DEPENDENT") return "CONTEXT_DEPENDENT";
  return "SOFT_RECOMMENDATION";
}

function sameDecisionConcept(a, b) {
  const keyA = normalizeText(a.normalized_key);
  const keyB = normalizeText(b.normalized_key);
  const predicateA = a.structured.canonical_predicate || normalizePredicate(a.predicate);
  const predicateB = b.structured.canonical_predicate || normalizePredicate(b.predicate);
  return Boolean(keyA && keyA === keyB) || predicateA === predicateB || tokenOverlap(a.value_text, b.value_text) >= 0.35;
}

function isFeatureClaim(claim) {
  return isFeaturePredicate(claim?.predicate)
    || FEATURE_DESCRIPTOR_PATTERN.test(normalizePredicate(claim?.normalized_key));
}

function isFeaturePredicate(value) {
  const normalized = normalizePredicate(value);
  return /^(?:feature|features(?:_|$)|has_|offers?_|includes?_|visual_appearance|illuminated(?:_|$)|(?:is_)?visible_from|can_be_seen_from|viewed_from|viewpoint(?:_|$)|serves_as_viewpoint_for)/iu.test(normalized)
    || FEATURE_DESCRIPTOR_PATTERN.test(normalized);
}

function isPositiveBoolean(value) {
  return /^(?:true|yes|present|available|provided|有|是|存在|提供)$/iu.test(String(value || "").trim());
}

function hasTemporalScope(a, b) {
  return /time|schedule|opening|season|date|时|日期|季节/iu.test(`${a.predicate} ${b.predicate}`);
}

function hasSameTimeEvidence(a, b) {
  const left = timePoints(claimSemanticText(a));
  const right = timePoints(claimSemanticText(b));
  if (!left.size || left.size !== right.size) return false;
  return [...left].every((value) => right.has(value));
}

function timePoints(value) {
  return new Set(String(value || "").match(/\b\d{1,2}:\d{2}\b/gu) || []);
}

function tokenOverlap(a, b) {
  const left = new Set(normalizeText(a).split(" ").filter(Boolean));
  const right = new Set(normalizeText(b).split(" ").filter(Boolean));
  const union = new Set([...left, ...right]);
  return union.size ? [...left].filter((item) => right.has(item)).length / union.size : 0;
}

function normalizePredicate(value) {
  return normalizeText(value).replace(/\s+/g, "_");
}

function canonicalPrimaryValue(value, predicate) {
  if (["recommended_visit_time", "best_time_to_visit"].includes(predicate)) return value.replace(/\s+visit$/iu, "").trim();
  return value;
}

function canonicalFactSemantics(predicate, value, qualifiers = []) {
  const normalizedPredicate = normalizeText(predicate);
  const normalizedValue = normalizeText(value);
  const text = `${normalizedPredicate} ${normalizedValue} ${qualifiers.map(normalizeText).join(" ")}`;
  if (METRO_EXIT_PREDICATE_PATTERN.test(normalizePredicate(predicate))) {
    const location = canonicalMetroExit(value);
    if (location) return { predicate: "nearest_metro_exit", value: location, polarity: "positive" };
  }
  if (/\b(?:reservation|booking|appointment)\b|预约/iu.test(text)) {
    // An explicit negative value wins over an awkward positive predicate such as
    // “requires reservation = no reservation required”. This keeps model wording
    // out of the knowledge identity and compares the actual boolean assertion.
    const explicitlyFalse = /\b(?:false|optional|not required|no reservation required|without reservation)\b|(?:无需预约|无须预约|不需要预约|不用预约|免预约)/iu.test(normalizedValue)
      || /\b(?:does not require|doesn['’]?t require|not require)\b|(?:无需|无须|不需要|不用|免)/iu.test(normalizedPredicate);
    const explicitlyTrue = /^(?:true|yes|required|reservation required|advance reservation required|需要预约|须预约|必须预约)$/iu.test(normalizedValue)
      || /\b(?:requires reservation|reservation is required|advance reservation required)\b|(?:需要预约|须预约|必须预约)/iu.test(normalizedPredicate);
    return {
      predicate: "reservation_required",
      value: explicitlyFalse ? false : explicitlyTrue ? true : null,
      polarity: explicitlyFalse ? "negative" : explicitlyTrue ? "positive" : "unknown",
    };
  }
  if (/(?:^|_)(?:ticket_price|ticket_price_cny|admission_fee|entry_fee|fare|cost)(?:_|$)/iu.test(normalizePredicate(predicate))) {
    const money = canonicalMoney(value);
    if (money) return { predicate: "price", value: money, polarity: "positive" };
  }
  if (/(?:^|_)(?:opening_hours?|opening_time|operating_hours?)(?:_|$)/iu.test(normalizePredicate(predicate))) {
    const hours = canonicalOpeningHours(value, qualifiers);
    if (hours) return { predicate: "opening_hours", value: hours, polarity: "positive" };
  }
  return {
    predicate: normalizePredicate(predicate), value: null,
    polarity: hasNegation(`${predicate} ${value}`) ? "negative" : "positive",
  };
}

function canonicalMoney(value) {
  const text = normalizeText(value);
  if (/^(?:free|free admission|no charge|0(?:\s*(?:rmb|cny|yuan))?|免费|免票|零元)$/iu.test(text)) {
    return { amount: 0, currency: "CNY" };
  }
  const amount = /(?:rmb|cny|yuan|元|￥|¥)?\s*(\d+(?:\.\d+)?)\s*(?:rmb|cny|yuan|元)?/iu.exec(text)?.[1];
  return amount == null ? null : { amount: Number(amount), currency: "CNY" };
}

function canonicalOpeningHours(value, qualifiers = []) {
  const text = normalizeText([value, ...(qualifiers || [])].join(" "));
  if (/\b(?:24\s*7|24\s*hours?|open\s*24\s*hours?|all\s*day)\b|全天|二十四小时/iu.test(text)) return "24/7";
  const times = [...String(value || "").matchAll(/\b(\d{1,2}):(\d{2})\b/gu)]
    .map((match) => `${String(Number(match[1])).padStart(2, "0")}:${match[2]}`);
  return times.length ? times.join("-") : null;
}

function normalizeText(value) {
  return clean(value).normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}:]+/gu, " ").trim().replace(/\s+/g, " ");
}

function claimSemanticText(claim) {
  const structured = claim?.structured_value && typeof claim.structured_value === "object"
    ? claim.structured_value : parseObject(claim?.structured_value_json);
  const qualifiers = Array.isArray(claim?.qualifiers)
    ? claim.qualifiers : parseArray(claim?.qualifiers_json);
  return flattenText([
    claim?.predicate,
    claim?.value_text || claim?.value,
    qualifiers,
    structured,
  ]).join(" ");
}

function flattenText(value) {
  if (value == null) return [];
  if (["string", "number", "boolean"].includes(typeof value)) return [String(value)];
  if (Array.isArray(value)) return value.flatMap(flattenText);
  if (typeof value === "object") return Object.values(value).flatMap(flattenText);
  return [];
}

function parseArray(value) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function hasMaterialLimiter(value) {
  return LIMITER_PATTERN.test(String(value || "").replace(PROCEDURAL_CONVENIENCE_PATTERN, ""));
}
function semanticLimiterCovered(source, normalizedClaim) {
  const sourceText = String(source || "");
  const normalized = normalizeText(normalizedClaim);
  if (ONLY_GLASS_SOURCE_PATTERN.test(sourceText) && ONLY_GLASS_CLAIM_PATTERN.test(String(normalizedClaim || ""))) return true;
  if (/\b(?:only|except|unless|at most|at least|maximum|minimum|highest|most complete|few|when|condition)\b/iu.test(normalized)) return true;
  if (/\d/u.test(normalized) && /\b(?:minutes?|hours?|days?|meters?|kilometers?|stops?|rmb|cny|yuan)\b/iu.test(normalized)) return true;
  if (/除了.+还/iu.test(sourceText)) return true;
  const sourceNumbers = new Set(sourceText.match(/\d+(?:\.\d+)?/gu) || []);
  return sourceNumbers.size > 0 && [...sourceNumbers].every((number) => normalized.includes(number));
}

function semanticNegationCovered(source, normalizedClaim, claim) {
  const sourceText = String(source || "");
  const normalized = normalizeText(normalizedClaim);
  const predicate = normalizePredicate(claim?.predicate);
  if (/\b(?:not|never|no|without|avoid|avoids|distrust|unnecessary|unsuitable|inaccessible|difficulty|prohibit|against|rather than|sensitive|non spicy)\b/iu.test(normalized)) return true;
  if (/(?:^|_)(?:avoid|avoidance|recommended_against|difficulty|risk|warning|caution|hazard|tourist_trap|time_to_avoid|crowd_advantage|crowd_condition|photo_fee_charged|cost_estimate|complimentary_items)(?:_|$)/iu.test(predicate)) return true;
  if (ALTERNATIVE_PREDICATE_PATTERN.test(predicate) && /\b(?:save|before|after|instead|rather|outside|end)\b/iu.test(normalized)) return true;
  if (/\b(?:free of charge|complimentary|comfortable flat (?:walking )?shoes?|fewer crowds?|overcrowd(?:ed|ing)?|expensive|low quality|correct direction)\b/iu.test(normalized)) return true;
  if (/不是浪得虚名|不是.{0,8}(?:广告|广)|不用去.+也(?:能|可)|最难的不是.+而是|不要走错/iu.test(sourceText)) return true;
  if (/不是免费/iu.test(sourceText) && /(?:^|_)(?:ticket_price|admission_fee|fare|cost)(?:_|$)/iu.test(predicate) && /\d/u.test(normalized)) return true;
  return false;
}

function canonicalTypedEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalMetroExit(value) {
  let text = clean(value).normalize("NFKC").toLocaleLowerCase("en-US");
  if (!text) return null;
  const exitMatch = text.match(/(?:\bexit\s*(?:no\.?\s*)?([0-9]+|[一二三四五六七八九十]+)\b)|(?:([0-9]+|[一二三四五六七八九十]+)\s*号?\s*(?:出入口|出口|口))/iu);
  const exit = canonicalOrdinal(exitMatch?.[1] || exitMatch?.[2]);
  if (exitMatch) text = text.replace(exitMatch[0], " ");
  const station = normalizeText(text
    .replace(/\b(?:nearest|closest|nearby|the|to|from|at|of)\b/giu, " ")
    .replace(/\b(?:metro|subway|underground|rail transit|light rail)\s*(?:station)?\b/giu, " ")
    .replace(/(?:最近的?|邻近的?|附近的?)(?:地铁|轨道交通|轻轨)?(?:站)?/gu, " ")
    .replace(/(?:地铁|轨道交通|轻轨)(?:车)?站/gu, " ")
    .replace(/站\s*$/u, " "))
    .replace(/\s+/gu, "");
  if (!station) return null;
  return { station, exit: exit || null };
}

function canonicalOrdinal(value) {
  const text = String(value || "").normalize("NFKC").trim();
  if (/^\d+$/u.test(text)) return String(Number(text));
  if (!/^[一二三四五六七八九十]+$/u.test(text)) return null;
  const digits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (text === "十") return "10";
  const [tens, ones] = text.split("十");
  if (text.includes("十")) return String((tens ? digits[tens] : 1) * 10 + (ones ? digits[ones] : 0));
  return String(digits[text] || "");
}

function sameTransitStation(left, right) {
  return Boolean(left && right && typeof left === "object" && typeof right === "object"
    && left.station && left.station === right.station);
}

function hasNegation(value) {
  // "No. 2 Factory" is a proper-name ordinal, not the English negation "no".
  const text = String(value || "").replace(/\bno\s*[.．#]?\s*\d+/giu, "numbered-place");
  return NEGATION_PATTERN.test(text);
}
function matching(text, pattern) { return cleanList(String(text || "").match(pattern) || []).map(normalizeText); }
function clean(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
function cleanList(values) { return [...new Set((values || []).map(clean).filter(Boolean))].slice(0, 24); }
