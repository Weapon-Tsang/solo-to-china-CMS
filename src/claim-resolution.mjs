const HARD_FACT_PREDICATES = new Set([
  "opening_time", "ticket_price", "reservation_required", "address", "station", "schedule",
]);

const SOFT_PREDICATES = new Set([
  "recommended_visit_time", "best_time_to_visit", "good_for", "photography_spot",
  "recommended_for", "worth_visiting",
]);

const NEGATION_PATTERN = /\b(?:not|never|no|avoid|without|isn['’]?t|aren['’]?t|doesn['’]?t|don['’]?t|cannot|can['’]?t)\b|不|无需|不要|避免|不可|不能|并非|不是/iu;
const LIMITER_PATTERN = /\b(?:only|except|unless|but only|at most|at least)\b|仅|只|除非|例外|至少|最多/iu;
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
  return {
    value: primaryValue,
    normalized_value: normalizeText(primaryValue),
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

  const opposingPolarity = hasNegation(a.value_text) !== hasNegation(b.value_text);
  if (sameScope && opposingPolarity && sameDecisionConcept(a, b)) {
    return result("CONFLICT", false, "The claims make opposite assertions under a compatible scope.", a, b, "CLAIM_CONFLICT");
  }

  if (!sameScope) return result("COMPATIBLE", true, "The values apply under different scope, time, audience, season, or conditions.", a, b);

  const kind = strongestKind(a.structured.claim_kind, b.structured.claim_kind);
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

export function detectClaimExtractionIssue(claim) {
  const quote = String(claim?.source_quote || claim?.sourceQuote || "");
  const normalized = String(claim?.value_text || claim?.value || "");
  if (hasNegation(quote) && !hasNegation(normalized)) return "NEGATION_EXTRACTION_ERROR";
  if (LIMITER_PATTERN.test(quote) && !LIMITER_PATTERN.test(normalized)) return "QUALIFIER_EXTRACTION_ERROR";
  return null;
}

function hydrate(claim) {
  const structured = claim.structured_value && typeof claim.structured_value === "object"
    ? claim.structured_value
    : structureClaim({ predicate: claim.predicate, value: claim.value_text, qualifiers: claim.qualifiers, sourceQuote: claim.source_quote });
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
  if (/recommend|best|good|worth|photo|visit.?time|体验|推荐|适合|值得/iu.test(`${predicate} ${value}`)) return "SOFT_RECOMMENDATION";
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
  const predicateA = normalizePredicate(a.predicate);
  const predicateB = normalizePredicate(b.predicate);
  return predicateA === predicateB || tokenOverlap(a.value_text, b.value_text) >= 0.35;
}

function hasTemporalScope(a, b) {
  return /time|schedule|opening|season|date|时|日期|季节/iu.test(`${a.predicate} ${b.predicate}`);
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

function normalizeText(value) {
  return clean(value).normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}:]+/gu, " ").trim().replace(/\s+/g, " ");
}

function hasNegation(value) { return NEGATION_PATTERN.test(String(value || "")); }
function matching(text, pattern) { return cleanList(String(text || "").match(pattern) || []); }
function clean(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
function cleanList(values) { return [...new Set((values || []).map(clean).filter(Boolean))].slice(0, 24); }
