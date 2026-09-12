import { evidenceResolutionMode, evidenceTemporalState } from "./evidence-consensus.mjs";
import { stableCanonicalSerialize, structureClaim } from "./claim-resolution.mjs";

export const KNOWLEDGE_RESOLUTION_VERSION = "2026-09-12.1";

export const RESOLUTION_STATES = new Set([
  "AUTO_EQUIVALENT",
  "AUTO_REPAIRED",
  "AUTO_SCOPE_SPLIT",
  "AUTO_TEMPORAL",
  "AUTO_CONSENSUS",
  "PROVISIONAL_CURRENT",
  "AUTO_VERIFIED",
  "VERIFICATION_REQUIRED",
  "REPAIR_REQUIRED",
  "HUMAN_REQUIRED",
]);

export function canonicalClaimIdentity(row = {}) {
  const structured = row.structured_value || structureClaim({
    predicate: row.predicate,
    value: row.value_text ?? row.value,
    qualifiers: row.qualifiers || parseArray(row.qualifiers_json),
    sourceQuote: row.source_quote || "",
  });
  return [
    row.entity_key || row.canonical_subject || row.subject || "unknown",
    structured.canonical_predicate || row.predicate || "unknown",
    structured.typed_value == null ? normalize(row.value_text ?? row.value) : stableCanonicalSerialize(structured.typed_value),
    stableCanonicalSerialize(normalizeScope(structured.scope || row.scope || parseObject(row.scope_json))),
  ].join("|");
}

export function decideKnowledgeResolution({ comparison, left = {}, right = {}, consensus = {}, nowMs = Date.now() } = {}) {
  const a = hydrate(left);
  const b = hydrate(right);
  const compatibility = [a.structured.compatibility, b.structured.compatibility].filter(Boolean);
  const mismatch = compatibility.find((item) => item.code === "PREDICATE_VALUE_MISMATCH");
  if (mismatch?.repairedPredicate) return decision("AUTO_REPAIRED", true, false,
    "The predicate/value mismatch has a deterministic local repair.", { repair: mismatch });
  if (mismatch) return decision("REPAIR_REQUIRED", true, false,
    "The Claim needs a bounded local repair before it can join a fact group.", { repair: mismatch });

  const temporalA = evidenceTemporalState(a, nowMs);
  const temporalB = evidenceTemporalState(b, nowMs);
  const differentTemporalState = temporalA.validityState !== temporalB.validityState
    || disjointValidity(temporalA, temporalB);
  const typedEqual = a.structured.canonical_predicate === b.structured.canonical_predicate
    && a.structured.typed_value != null && b.structured.typed_value != null
    && stableCanonicalSerialize(a.structured.typed_value) === stableCanonicalSerialize(b.structured.typed_value);
  const sameScope = scopesCompatible(a.structured.scope, b.structured.scope);
  const mode = evidenceResolutionMode([a, b]);
  if (mode === "STRICT_SAFETY_REVIEW" && !typedEqual) return decision("HUMAN_REQUIRED", false, true,
    "A high-consequence safety, medical, legal, visa, or emergency conflict requires an operator decision.");

  if (comparison?.canCoexist) {
    if (!sameScope) return decision("AUTO_SCOPE_SPLIT", true, false,
      "The values apply to different products, services, places, audiences, or travel conditions.");
    if (differentTemporalState) return decision("AUTO_TEMPORAL", true, false,
      "Current, scheduled, and historical observations are retained separately.");
    if (typedEqual) return decision("AUTO_EQUIVALENT", true, false,
      "Canonical typed values are equal even though the source wording differs.");
    return decision("AUTO_EQUIVALENT", true, false,
      "The semantic relation allows both observations to coexist.");
  }

  if (differentTemporalState) return decision("AUTO_TEMPORAL", true, false,
    "The values belong to different validity periods and do not compete as the current fact.");
  if (!sameScope) return decision("AUTO_SCOPE_SPLIT", true, false,
    "The values belong to distinct scopes and are preserved as parallel facts.");
  if (mode === "TRUSTED_SOURCE_POLICY") {
    if (consensus.autoResolved) return decision("AUTO_CONSENSUS", true, false,
      "Independent-source, authority, completeness, and recency weighting produced a current working value.");
    return decision("VERIFICATION_REQUIRED", true, false,
      "The ordinary dynamic fact remains ambiguous and is queued for targeted verification before human review.");
  }
  return decision("HUMAN_REQUIRED", false, true,
    "The same entity, predicate, scope, and validity period contain a material hard-fact contradiction.");
}

export function summarizeResolutionDecisions(items = []) {
  const counts = Object.fromEntries([...RESOLUTION_STATES].map((state) => [state, 0]));
  for (const item of items) if (counts[item?.state] != null) counts[item.state] += 1;
  const automated = items.filter((item) => item?.autoResolved).length;
  return { total: items.length, counts, automated,
    projectedHumanRequired: counts.HUMAN_REQUIRED,
    projectedAutoResolutionPercentage: items.length ? Math.round((automated / items.length) * 10_000) / 100 : 100 };
}

function decision(state, autoResolved, humanRequired, reason, detail = {}) {
  return { state, autoResolved, humanRequired, verificationRequired: state === "VERIFICATION_REQUIRED",
    repairRequired: state === "REPAIR_REQUIRED", reason, ...detail };
}

function hydrate(row) {
  const structured = row.structured_value || structureClaim({ predicate: row.predicate,
    value: row.value_text ?? row.value, qualifiers: row.qualifiers || parseArray(row.qualifiers_json),
    sourceQuote: row.source_quote || "" });
  return { ...row, structured_value: structured, structured };
}

function normalizeScope(scope = {}) {
  return Object.fromEntries(Object.entries(scope).filter(([, value]) => Array.isArray(value) ? value.length : value != null && value !== "")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, Array.isArray(value) ? [...new Set(value.map(normalize).filter(Boolean))].sort() : normalize(value)]));
}

function scopesCompatible(left = {}, right = {}) {
  const a = normalizeScope(left);
  const b = normalizeScope(right);
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[key] == null || b[key] == null) continue;
    const leftValues = Array.isArray(a[key]) ? a[key] : [a[key]];
    const rightValues = Array.isArray(b[key]) ? b[key] : [b[key]];
    if (!leftValues.some((value) => rightValues.includes(value))) return false;
  }
  return true;
}

function disjointValidity(left, right) {
  if (left.validTo && right.validFrom && Date.parse(left.validTo) < Date.parse(right.validFrom)) return true;
  return Boolean(right.validTo && left.validFrom && Date.parse(right.validTo) < Date.parse(left.validFrom));
}

function parseArray(value) { try { const parsed = JSON.parse(value || "[]"); return Array.isArray(parsed) ? parsed : []; } catch { return []; } }
function parseObject(value) { try { const parsed = JSON.parse(value || "{}"); return parsed && typeof parsed === "object" ? parsed : {}; } catch { return {}; } }
function normalize(value) { return String(value ?? "").normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}:]+/gu, " ").trim(); }
