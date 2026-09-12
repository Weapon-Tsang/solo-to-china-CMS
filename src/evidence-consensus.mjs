export const EVIDENCE_CONSENSUS_VERSION = "2026-09-12.1";

// The operator explicitly chooses every source that enters this system. Daily
// travel details from those sources are usable by default; dates and a second
// "official" check are not artificial gates. A real mutually-exclusive claim
// comparison still becomes one persisted review decision.
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
  return DYNAMIC_FACT_PATTERN.test(semanticText) ? "TRUSTED_SOURCE_POLICY" : "SEMANTIC_COMPATIBILITY";
}

export function resolveEvidenceConsensus(rows = [], {
  variantKey = defaultVariantKey,
  nowMs = Date.now(),
  staleAfterDays = 90,
} = {}) {
  const mode = evidenceResolutionMode(rows);
  const halfLifeDays = recencyHalfLifeDays(rows);
  const sourceVotes = new Map();
  const independence = buildIndependenceGroups(rows);

  // One author/source family gets one vote for one fact. Repeated posts,
  // extraction duplicates, and multiple Claims from one document must not
  // manufacture a majority.
  for (const row of rows) {
    const group = independence.byRow.get(row);
    const vote = evidenceVote(row, variantKey(row), { nowMs, halfLifeDays, group });
    const current = sourceVotes.get(vote.independenceKey);
    if (!current || vote.timestampMs > current.timestampMs
      || (vote.timestampMs === current.timestampMs && (vote.weight > current.weight
        || (vote.weight === current.weight && String(vote.row.source_id) < String(current.row.source_id))))) {
      sourceVotes.set(vote.independenceKey, vote);
    }
  }

  const allVotes = [...sourceVotes.values()];
  const currentVotes = allVotes.filter((vote) => ["current", "unknown"].includes(vote.validityState));
  const excludedVotes = allVotes.filter((vote) => !["current", "unknown"].includes(vote.validityState));
  const variants = new Map();
  for (const vote of currentVotes) {
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
  const totalSources = currentVotes.length;
  const supportCount = top.votes.length;
  const contradictionCount = Math.max(0, totalSources - supportCount);
  const scoreShare = totalScore ? top.score / totalScore : 0;
  const sourceShare = totalSources ? supportCount / totalSources : 0;
  const leadRatio = runnerUp.score ? top.score / runnerUp.score : Number.POSITIVE_INFINITY;
  const preferredVote = [...top.votes].sort((left, right) => right.timestampMs - left.timestampMs || right.weight - left.weight)[0] || null;
  const latestEvidenceAt = preferredVote?.evidenceTimestampMs ? new Date(preferredVote.evidenceTimestampMs).toISOString() : null;
  const ageDays = preferredVote?.evidenceTimestampMs ? (nowMs - preferredVote.evidenceTimestampMs) / 86_400_000 : Number.POSITIVE_INFINITY;
  const hasWeightedAgreement = supportCount >= 2 && scoreShare >= 0.55 && leadRatio >= 1.15;
  const singleVariant = ranked.length <= 1;
  const excludedState = excludedVotes.some((vote) => vote.validityState === "scheduled") ? "scheduled"
    : excludedVotes.some((vote) => vote.validityState === "historical") ? "historical" : "unknown";
  const method = !currentVotes.length
    ? excludedState === "scheduled" ? "SCHEDULED_ONLY" : excludedState === "historical" ? "HISTORICAL_ONLY" : "UNDATED_ARCHIVE"
    : singleVariant
    ? mode === "TRUSTED_SOURCE_POLICY" ? "TRUSTED_SOURCE_POLICY" : supportCount >= 2 ? "MULTI_SOURCE_AGREEMENT" : "SINGLE_SOURCE_LATEST"
    : mode === "TRUSTED_SOURCE_POLICY" ? "TRUSTED_SOURCE_CONFLICT"
      : hasWeightedAgreement ? "RECENCY_WEIGHTED_CONSENSUS" : "LATEST_WEIGHTED_PROVISIONAL";
  const confidence = clamp(
    0.28 + scoreShare * 0.42 + Math.min(0.18, supportCount * 0.06)
      + (hasWeightedAgreement ? 0.08 : 0) - (ranked.length > 1 && !hasWeightedAgreement ? 0.08 : 0),
    0.2,
    0.98,
  );
  const autoResolved = mode !== "STRICT_SAFETY_REVIEW"
    && (!currentVotes.length || singleVariant || hasWeightedAgreement);
  const resolutionState = !currentVotes.length
    ? excludedState === "scheduled" || excludedState === "historical" ? "AUTO_TEMPORAL" : "PROVISIONAL_CURRENT"
    : singleVariant ? "AUTO_EQUIVALENT"
      : hasWeightedAgreement ? "AUTO_CONSENSUS" : mode === "TRUSTED_SOURCE_POLICY" ? "VERIFICATION_REQUIRED" : "PROVISIONAL_CURRENT";

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
    validityState: preferredVote?.validityState || excludedState,
    dateKind: preferredVote?.dateKind || "unknown",
    dateConfidence: preferredVote?.dateConfidence || "unknown",
    currentEvidenceCount: currentVotes.length,
    scheduledEvidenceCount: excludedVotes.filter((vote) => vote.validityState === "scheduled").length,
    historicalEvidenceCount: excludedVotes.filter((vote) => vote.validityState === "historical").length,
    freshnessState: mode === "TRUSTED_SOURCE_POLICY" ? "current" : ageDays > staleAfterDays ? "stale" : "current",
    autoResolved,
    resolutionState,
    independenceGroups: independence.groups.map((group) => ({
      key: group.key,
      sourceIds: group.sourceIds,
      reasons: group.reasons,
      selectedSourceId: sourceVotes.get(group.key)?.row?.source_id || null,
      foldedSourceIds: group.sourceIds.filter((sourceId) => sourceId !== sourceVotes.get(group.key)?.row?.source_id),
    })),
    variants: ranked.map((item) => ({
      key: item.key,
      score: round(item.score),
      scoreShare: round(totalScore ? item.score / totalScore : 0),
      independentSourceCount: item.votes.length,
      latestEvidenceAt: newestTimestamp(item.votes) ? new Date(newestTimestamp(item.votes)).toISOString() : null,
      sourceIds: item.votes.map((vote) => vote.row.source_id),
      independenceKeys: item.votes.map((vote) => vote.independenceKey),
    })),
    excludedEvidence: excludedVotes.map((vote) => ({ sourceId: vote.row.source_id, variantKey: vote.variantKey,
      validityState: vote.validityState, dateKind: vote.dateKind, dateConfidence: vote.dateConfidence,
      validFrom: vote.validFrom, validTo: vote.validTo })),
  };
}

function evidenceVote(row, variant, { nowMs, halfLifeDays, group }) {
  const temporal = evidenceTemporalState(row, nowMs);
  const timestampMs = temporal.timestampMs;
  const ageDays = timestampMs && timestampMs <= nowMs ? (nowMs - timestampMs) / 86_400_000 : halfLifeDays * 4;
  const recencyWeight = Math.max(0.01, 0.5 ** (ageDays / halfLifeDays));
  const authorityWeight = ({ 1: 1.25, 2: 1.15, 3: 1.07, 4: 1 })[Number(row.source_authority_level || 4)] || 1;
  const extractionConfidence = clamp(Number(row.confidence ?? 0.75), 0, 1);
  const confidenceWeight = 0.7 + extractionConfidence * 0.3;
  const timestampWeight = temporal.dateKind === "verified_at" || temporal.dateKind === "valid_from"
    ? 1.08 : ["observed_at", "published_at"].includes(temporal.dateKind) ? 1 : 0.72;
  const completenessWeight = row.source_completeness_status === "partial_needs_attention" ? 0.72
    : row.source_completeness_status === "partial_retryable" ? 0.86 : 1;
  return {
    row,
    variantKey: variant,
    independenceKey: group?.key || sourceIndependenceKey(row),
    timestampMs,
    evidenceTimestampMs: temporal.evidenceTimestampMs,
    validityState: temporal.validityState,
    dateKind: temporal.dateKind,
    dateConfidence: temporal.dateConfidence,
    validFrom: temporal.validFrom,
    validTo: temporal.validTo,
    weight: recencyWeight * authorityWeight * confidenceWeight * timestampWeight * completenessWeight,
  };
}

function buildIndependenceGroups(rows) {
  const parent = new Map();
  const rowNode = new Map();
  const edges = new Map();
  const ensure = (node) => { if (!parent.has(node)) parent.set(node, node); return node; };
  const find = (node) => {
    const current = ensure(node);
    const next = parent.get(current);
    if (next === current) return current;
    const root = find(next);
    parent.set(current, root);
    return root;
  };
  const union = (left, right) => {
    const a = find(left); const b = find(right);
    if (a === b) return;
    const [root, child] = [a, b].sort();
    parent.set(child, root);
  };
  rows.forEach((row, index) => {
    const sourceNode = ensure(`source:${row.source_id || row.id || index}`);
    rowNode.set(row, sourceNode);
    const related = [];
    for (const family of String(row.source_family_ids || "").split("|").map(normalizeIdentifier).filter(Boolean).sort()) {
      related.push(`family:${family}`);
    }
    const identity = normalizeIdentifier(row.source_identity || "");
    if (identity) related.push(`identity:${identity}`);
    const author = stableAuthorKey(row);
    if (author) related.push(author);
    for (const node of related) {
      ensure(node);
      union(sourceNode, node);
      if (!edges.has(node)) edges.set(node, new Set());
      edges.get(node).add(String(row.source_id || row.id || index));
    }
  });
  const components = new Map();
  for (const row of rows) {
    const root = find(rowNode.get(row));
    const component = components.get(root) || { rows: [], nodes: new Set() };
    component.rows.push(row);
    components.set(root, component);
  }
  for (const node of parent.keys()) {
    const root = find(node);
    if (components.has(root)) components.get(root).nodes.add(node);
  }
  const priority = (node) => node.startsWith("family:") ? 0 : node.startsWith("identity:") ? 1
    : node.startsWith("author:") ? 2 : 3;
  const groups = [...components.values()].map((component) => {
    const candidates = [...component.nodes].sort((left, right) => priority(left) - priority(right) || left.localeCompare(right));
    const sourceIds = [...new Set(component.rows.map((row) => String(row.source_id || row.id || "")).filter(Boolean))].sort();
    const reasons = candidates.filter((node) => !node.startsWith("source:") && (edges.get(node)?.size || 0) > 0)
      .map((node) => ({ type: node.split(":", 1)[0], key: node, sourceIds: [...edges.get(node)].sort() }));
    return { key: candidates[0], rows: component.rows, sourceIds, reasons };
  }).sort((left, right) => left.key.localeCompare(right.key));
  const byRow = new Map();
  for (const group of groups) for (const row of group.rows) byRow.set(row, group);
  return { groups, byRow };
}

function stableAuthorKey(row) {
  const author = normalize(row.source_author_url || row.source_author_name || "");
  if (!author || /^(?:unknown|anonymous|n a|none|人工提交|manual submission|administrator)$/iu.test(author)) return "";
  return `author:${row.source_adapter || "source"}:${author}`;
}

function sourceIndependenceKey(row) {
  const families = String(row.source_family_ids || "").split("|").filter(Boolean).sort();
  if (families.length) return `family:${families.join("|")}`;
  const identity = normalizeIdentifier(row.source_identity || "");
  if (identity) return `identity:${identity}`;
  const author = normalize(row.source_author_url || row.source_author_name || "");
  if (author && !/^(?:unknown|anonymous|n a|none|未知|匿名)$/iu.test(author)) {
    return `author:${row.source_adapter || "source"}:${author}`;
  }
  return `source:${row.source_id}`;
}

export function evidenceTemporalState(row, nowMs = Date.now()) {
  const validFrom = firstDate(row.valid_from, row.source_valid_from, row.effective_from, row.source_effective_from);
  const validTo = firstDate(row.valid_to, row.source_valid_to, row.effective_to, row.source_effective_to);
  if (validFrom && validFrom > nowMs) return temporal("scheduled", validFrom, "valid_from", row.date_confidence || "high", validFrom, validTo, 0);
  if (validTo && validTo < nowMs) return temporal("historical", validTo, "valid_to", row.date_confidence || "high", validFrom, validTo, 0);
  const candidates = [
    [row.verified_at || row.source_verified_at, "verified_at", "high"],
    [validFrom, "valid_from", row.date_confidence || "high"],
    [row.observed_at || row.source_observed_at, "observed_at", row.date_confidence || row.temporal_confidence || "medium"],
    [row.published_at, "published_at", row.date_confidence || "medium"],
  ];
  for (const [value, kind, confidence] of candidates) {
    const parsed = typeof value === "number" ? value : Date.parse(value || "");
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > nowMs) continue;
    return temporal("current", parsed, kind, confidence, validFrom, validTo, parsed);
  }
  const captured = firstDate(row.captured_at);
  return temporal("unknown", captured || 0, captured ? "captured_at" : "unknown", captured ? "low" : "unknown", validFrom, validTo, 0);
}

function firstDate(...values) {
  for (const value of values) {
    const parsed = typeof value === "number" ? value : Date.parse(value || "");
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function temporal(validityState, timestampMs, dateKind, dateConfidence, validFrom, validTo, evidenceTimestampMs) {
  return {
    validityState, timestampMs, evidenceTimestampMs, dateKind, dateConfidence,
    validFrom: validFrom ? new Date(validFrom).toISOString() : null,
    validTo: validTo ? new Date(validTo).toISOString() : null,
  };
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
function normalizeIdentifier(value) { return String(value || "").normalize("NFKC").toLocaleLowerCase("en-US").trim(); }
function normalize(value) { return String(value || "").normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}:]+/gu, " ").trim(); }
function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }
function round(value) { return Math.round(value * 10_000) / 10_000; }
