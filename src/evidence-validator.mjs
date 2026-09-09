import { sha256 } from "./utils.mjs";

export function pageBlockSignature(block) {
  return sha256(JSON.stringify(stableObject({ type: block?.type || "unknown", data: block?.data || {} })));
}

export function extractVisiblePageContent(page) {
  const blocks = (page?.blocks || []).map((block) => ({
    signature: pageBlockSignature(block),
    type: block?.type || "unknown",
    text: visibleValue(block?.data || {}),
    links: collectLinks(block?.data || {}),
  }));
  return { title: String(page?.metadata?.title || "").trim(), blocks,
    text: [String(page?.metadata?.title || ""), ...blocks.map((block) => block.text)].join(" ").replace(/\s+/g, " ").trim() };
}

export function validatePageEvidence(page, contentPackage) {
  const errors = [];
  const visible = extractVisiblePageContent(page);
  const provenance = contentPackage?.frontend_page?.validation?.blockProvenance || [];
  const provenanceBySignature = Map.groupBy(provenance, (entry) => entry.blockSignature);
  const facts = new Map((contentPackage?.facts || []).map((fact) => [fact.normalized_key, fact]));
  const ledger = contentPackage?.draft?.evidence_ledger || [];
  const factual = provenance.filter((entry) => entry.factuality === "factual");
  if (factual.length && !ledger.length) errors.push({ code: "EMPTY_FACTUAL_LEDGER", path: "$.draft.evidence_ledger" });

  visible.blocks.forEach((block, index) => {
    if (String(block.type).startsWith("affiliate_")) return;
    const entry = (provenanceBySignature.get(block.signature) || []).shift();
    if (!entry) {
      errors.push({ code: "BLOCK_PROVENANCE_MISSING", path: `$.blocks[${index}]` });
      return;
    }
    if (entry.factuality === "non_factual") return;
    if (entry.mappingStatus !== "explicit_v2" || !entry.contentNodeId || !entry.claimKeys?.length) {
      errors.push({ code: "FACTUAL_BLOCK_UNMAPPED", path: `$.blocks[${index}]` });
      return;
    }
    const traces = entry.claimTraces || [];
    const traceSources = [...new Set(traces.map((trace) => trace.sourceId).filter(Boolean))].sort();
    if (!traces.length || JSON.stringify(traceSources) !== JSON.stringify([...(entry.sourceIds || [])].sort())) {
      errors.push({ code: "CLAIM_SOURCE_RELATION_INVALID", path: `$.blocks[${index}]` });
    }
    let relevant = false;
    for (const key of entry.claimKeys) {
      const fact = facts.get(key);
      if (!fact) {
        errors.push({ code: "UNKNOWN_BLOCK_CLAIM", path: `$.blocks[${index}]`, claimKey: key });
        continue;
      }
      const validSources = new Set((fact.evidence || []).map((item) => item.source_id));
      if (traces.filter((trace) => trace.claimKey === key).some((trace) => !validSources.has(trace.sourceId))) {
        errors.push({ code: "FORGED_SOURCE_REFERENCE", path: `$.blocks[${index}]`, claimKey: key });
      }
      const anchors = factAnchors(fact);
      if (anchors.some((anchor) => containsPhrase(block.text, anchor))) relevant = true;
      for (const token of protectedTokens(fact)) {
        if (!containsPhrase(block.text, token) && !block.links.includes(token)) {
          errors.push({ code: "EVIDENCE_VALUE_MISMATCH", path: `$.blocks[${index}]`, claimKey: key, expected: token });
        }
      }
      if (isDynamicFact(fact) && fact.latest_evidence_at && !dateVisible(visible.text, fact.latest_evidence_at)) {
        errors.push({ code: "VISIBLE_AS_OF_MISSING", path: `$.blocks[${index}]`, claimKey: key });
      }
    }
    if (!relevant) errors.push({ code: "FACTUAL_ANSWER_MISSING", path: `$.blocks[${index}]`, contentNodeId: entry.contentNodeId });
  });
  return { valid: errors.length === 0, errors, visible };
}

function visibleValue(value, key = "") {
  if (typeof value === "string") return /(?:url|href|src|id|strategy|media)/i.test(key) ? "" : value.replace(/<[^>]+>/g, " ");
  if (Array.isArray(value)) return value.map((item) => visibleValue(item, key)).join(" ");
  if (value && typeof value === "object") return Object.entries(value).map(([childKey, item]) => visibleValue(item, childKey)).join(" ");
  return "";
}

function collectLinks(value, key = "") {
  if (typeof value === "string") return /(?:url|href)$/i.test(key) && /^https?:\/\//i.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => collectLinks(item, key));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([childKey, item]) => collectLinks(item, childKey));
  return [];
}

function factAnchors(fact) {
  const values = [fact.subject, fact.canonical_subject, fact.predicate, fact.preferred_value]
    .flatMap((value) => String(value || "").split(/[|,/;]/)).map(normalize).filter((value) => value.length >= 3);
  return [...new Set(values)];
}

function protectedTokens(fact) {
  const text = [fact.preferred_value, ...(fact.evidence || []).flatMap((item) => item.qualifiers || [])].join(" ");
  const numbers = text.match(/(?<![\p{L}\p{N}])(?:¥|￥|CNY\s*)?\d+(?:[.,:]\d+)?(?:\s*(?:元|rmb|cny|%|am|pm|hours?|minutes?|days?))?/giu) || [];
  const conditions = text.match(/\b(?:only|except|weekday(?:s)?|weekend(?:s)?|student(?:s)?|child(?:ren)?|adult(?:s)?|senior(?:s)?|before|after|until|from)\b/giu) || [];
  const urls = text.match(/https?:\/\/[^\s)]+/giu) || [];
  return [...new Set([...numbers, ...conditions, ...urls].map((item) => item.trim()))];
}

function isDynamicFact(fact) {
  return fact.freshness_state === "time_sensitive" || /RECENCY|LATEST|price|cost|hours?|schedule|booking|reservation|policy|route|metro|train|bus/i
    .test(`${fact.consensus_method || ""} ${fact.normalized_key || ""} ${fact.predicate || ""}`);
}

function dateVisible(text, iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return false;
  const variants = [date.toISOString().slice(0, 10),
    new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(date),
    new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(date)];
  return variants.some((value) => containsPhrase(text, value));
}

function containsPhrase(text, phrase) {
  const haystack = normalize(text); const needle = normalize(phrase);
  if (!needle) return false;
  if (!/\d/.test(needle)) return haystack.includes(needle);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(haystack);
}
function normalize(value) { return String(value || "").normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}:/.%¥￥]+/gu, " ").trim(); }
function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableObject(value[key])]));
  return value;
}
