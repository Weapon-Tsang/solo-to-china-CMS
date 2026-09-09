export const EVIDENCE_CONSENSUS_VERSION = "2026-09-09.1";

// Dynamic travel facts are not editorial emergencies. They are observations
// made at different times by sources with different independence and quality.
// The current working value is therefore selected from the evidence set, not
// delegated to an operator or made dependent on one permanently-official URL.
const DYNAMIC_FACT_PATTERN = /(?:^|_)(?:price|cost|fees?|fares?|ticket|admission|opening|hours?|schedule|timetable|booking|reservation|appointment|policy|rules?|closure|closed|availability|address|location|entrance|exit|metro|subway|station|train|bus|ferry|route|payment)(?:_|$)|(?:price|cost|ticket|opening|hours?|schedule|booking|reservation|metro|subway|station)/iu;
const SAFETY_CRITICAL_PATTERN = /(?:^|[\s._])(?:emergency|evacuation|allergen(?:_warning)?|medical|fire|disaster|prohibited|legal_requirement|visa_requirement|safety_hazard)(?=$|[\s._])/iu;

export function evidenceResolutionMode(rows = []) {
  const semanticText = rows.map((row) => `${row.normalized_key || ""} ${row.subject || ""} ${row.predicate || ""} ${row.structured_value?.canonical_predicate || ""}`).join(" ");
  if (SAFETY_CRITICAL_PATTERN.test(semanticText)) return "STRICT_SAFETY_REVIEW";
  // A word such as "route", "location", or "time" is not enough to make a
  // property single-valued. If semantic normalization has classified every
  // Claim as a recommendation/contextual observation, preserve the variants
  // as parallel viewpoints instead of ranking one as the current truth.
  const semanticallyMultiValue = rows.length > 0 && rows.every((row) => row.structured_value?.claim_kind
    && (row.structured_value.claim_kind !== "HARD_FACT" || row.structured_value.cardinality !== "SINGLE_VALUE"));
  if (semanticallyMultiValue) return "SEMANTIC_COMPATIBILITY";
  return DYNAMIC_FACT_PATTERN.test(semanticText) ? "RECENCY_WEIGHTED" : "SEMANTIC_COMPATIBILITY";
}

export function resolveEvidenceConsensus(rows = [], {
  variantKey = defaultVariantKey,
  nowMs = Date.now(),
  staleAfterDays = 90,
} = {}) {
  const mode = evidenceResolutionMode(rows);
  const halfLifeDays = recencyHalfLifeDays(rows);
  const sourceVotes = new Map();

  // One author/source family gets one vote for one fact. Repeated posts,
  // extraction duplicates, and multiple Claims from one document must not
  // manufacture a majority.
  for (const row of rows) {
    const vote = evidenceVote(row, variantKey(row), { nowMs, halfLifeDays });
    const current = sourceVotes.get(vote.independenceKey);
    if (!current || vote.timestampMs > current.timestampMs
      || (vote.timestampMs === current.timestampMs && vote.weight > current.weight)) {
      sourceVotes.set(vote.independenceKey, vote);
    }
  }

  const variants = new Map();
  for (const vote of sourceVotes.values()) {
    const bucket = variants.get(vote.variantKey) || { key: vote.variantKey, score: 0, votes: [] };
    bucket.score += vote.weight;
    bucket.votes.push(vote);
    variants.set(vote.variantKey, bucket);
  }
  const ranked = [...variants.values()].sort((left, right) => right.score - left.score
    || right.votes.length - left.votes.length
    || newestTimestamp(right.votes) - newestTimestamp(left.votes));
  const top = ranked[0] || { key: "", score: 0, votes: [] };
  const runnerUp = ranked[1] || { score: 0, votes: [] };
  const totalScore = ranked.reduce((sum, item) => sum + item.score, 0);
  const totalSources = sourceVotes.size;
  const supportCount = top.votes.length;
  const contradictionCount = Math.max(0, totalSources - supportCount);
  const scoreShare = totalScore ? top.score / totalScore : 0;
  const sourceShare = totalSources ? supportCount / totalSources : 0;
  const leadRatio = runnerUp.score ? top.score / runnerUp.score : Number.POSITIVE_INFINITY;
  const preferredVote = [...top.votes].sort((left, right) => right.timestampMs - left.timestampMs || right.weight - left.weight)[0] || null;
  const latestEvidenceAt = preferredVote?.timestampMs ? new Date(preferredVote.timestampMs).toISOString() : null;
  const ageDays = preferredVote?.timestampMs ? Math.max(0, (nowMs - preferredVote.timestampMs) / 86_400_000) : Number.POSITIVE_INFINITY;
  const hasWeightedAgreement = supportCount >= 2 && scoreShare >= 0.55 && leadRatio >= 1.15;
  const singleVariant = ranked.length <= 1;
  const method = singleVariant
    ? supportCount >= 2 ? "MULTI_SOURCE_AGREEMENT" : "SINGLE_SOURCE_LATEST"
    : hasWeightedAgreement ? "RECENCY_WEIGHTED_CONSENSUS" : "LATEST_WEIGHTED_PROVISIONAL";
  const confidence = clamp(
    0.28 + scoreShare * 0.42 + Math.min(0.18, supportCount * 0.06)
      + (hasWeightedAgreement ? 0.08 : 0) - (ranked.length > 1 && !hasWeightedAgreement ? 0.08 : 0),
    0.2,
    0.98,
  );

  return {
    mode,
    method,
    confidence,
    preferredValue: preferredVote?.row?.value_text || "",
    preferredVariantKey: top.key,
    supportCount,
    contradictionCount,
    independentSourceCount: totalSources,
    scoreShare,
    sourceShare,
    leadRatio: Number.isFinite(leadRatio) ? leadRatio : null,
    latestEvidenceAt,
    freshnessState: ageDays > staleAfterDays ? "stale" : mode === "RECENCY_WEIGHTED" ? "time_sensitive" : "current",
    autoResolved: mode === "RECENCY_WEIGHTED",
    variants: ranked.map((item) => ({
      key: item.key,
      score: round(item.score),
      scoreShare: round(totalScore ? item.score / totalScore : 0),
      independentSourceCount: item.votes.length,
      latestEvidenceAt: newestTimestamp(item.votes) ? new Date(newestTimestamp(item.votes)).toISOString() : null,
      sourceIds: item.votes.map((vote) => vote.row.source_id),
      independenceKeys: item.votes.map((vote) => vote.independenceKey),
    })),
  };
}

function evidenceVote(row, variant, { nowMs, halfLifeDays }) {
  const timestampMs = evidenceTimestampMs(row);
  const ageDays = timestampMs ? Math.max(0, (nowMs - timestampMs) / 86_400_000) : halfLifeDays * 4;
  const recencyWeight = Math.max(0.01, 0.5 ** (ageDays / halfLifeDays));
  const authorityWeight = ({ 1: 1.25, 2: 1.15, 3: 1.07, 4: 1 })[Number(row.source_authority_level || 4)] || 1;
  const extractionConfidence = clamp(Number(row.confidence ?? 0.75), 0, 1);
  const confidenceWeight = 0.7 + extractionConfidence * 0.3;
  const timestampWeight = row.verified_at || row.source_verified_at || row.effective_from || row.source_effective_from
    ? 1.08 : row.observed_at || row.source_observed_at || row.published_at ? 1 : 0.88;
  const completenessWeight = row.source_completeness_status === "partial_needs_attention" ? 0.72
    : row.source_completeness_status === "partial_retryable" ? 0.86 : 1;
  return {
    row,
    variantKey: variant,
    independenceKey: sourceIndependenceKey(row),
    timestampMs,
    weight: recencyWeight * authorityWeight * confidenceWeight * timestampWeight * completenessWeight,
  };
}

function sourceIndependenceKey(row) {
  const families = String(row.source_family_ids || "").split("|").filter(Boolean).sort();
  if (families.length) return `family:${families.join("|")}`;
  const author = normalize(row.source_author_url || row.source_author_name || "");
  if (author && !/^(?:unknown|anonymous|n a|none|未知|匿名)$/iu.test(author)) {
    return `author:${row.source_adapter || "source"}:${author}`;
  }
  return `source:${row.source_id}`;
}

function evidenceTimestampMs(row) {
  for (const value of [row.verified_at, row.source_verified_at, row.effective_from, row.source_effective_from,
    row.observed_at, row.source_observed_at, row.published_at, row.captured_at]) {
    const parsed = Date.parse(value || "");
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function recencyHalfLifeDays(rows) {
  const text = rows.map((row) => `${row.normalized_key || ""} ${row.predicate || ""}`).join(" ");
  if (/opening|hours?|closure|closed|booking|reservation|appointment|schedule|timetable/iu.test(text)) return 30;
  if (/price|cost|fees?|fares?|ticket|admission|availability/iu.test(text)) return 45;
  if (/metro|subway|station|train|bus|ferry|route|address|location|entrance|exit/iu.test(text)) return 90;
  return 120;
}

function defaultVariantKey(row) { return normalize(row.value_text); }
function newestTimestamp(votes) { return Math.max(0, ...votes.map((vote) => vote.timestampMs || 0)); }
function normalize(value) { return String(value || "").normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}:]+/gu, " ").trim(); }
function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }
function round(value) { return Math.round(value * 10_000) / 10_000; }
