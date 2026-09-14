import { sha256 } from "./utils.mjs";

export function pageBlockSignature(block) {
  return sha256(JSON.stringify(stableObject({ type: block?.type || "unknown", data: block?.data || {} })));
}

export function remapBlockProvenanceForDelivery(sourcePage, deliveryPage, validation = {}) {
  const sourceBlocks = Array.isArray(sourcePage?.blocks) ? sourcePage.blocks : [];
  const deliveryBlocks = Array.isArray(deliveryPage?.blocks) ? deliveryPage.blocks : [];
  const provenance = Array.isArray(validation?.blockProvenance) ? validation.blockProvenance : [];
  if (sourceBlocks.length !== deliveryBlocks.length || provenance.length !== sourceBlocks.length) return validation;
  if (!provenance.every((entry, index) => entry?.blockSignature === pageBlockSignature(sourceBlocks[index]))) return validation;
  return { ...validation, blockProvenance:provenance.map((entry, index) => ({
    ...entry,
    blockSignature:pageBlockSignature(deliveryBlocks[index]),
  })) };
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

  const mappedBlocks = visible.blocks.map((block, index) => {
    if (String(block.type).startsWith("affiliate_")) return { block, index, entry: null, commercial: true };
    const entry = (provenanceBySignature.get(block.signature) || []).shift() || null;
    if (!entry) {
      errors.push({ code: "BLOCK_PROVENANCE_MISSING", path: `$.blocks[${index}]` });
      return { block, index, entry };
    }
    return { block, index, entry };
  });

  mappedBlocks.forEach(({ block, index, entry, commercial }) => {
    if (commercial || !entry) return;
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
    const nodeBlocks = mappedBlocks.filter((item) => item.entry?.contentNodeId === entry.contentNodeId);
    const evidenceText = nodeBlocks.map((item) => item.block.text).join(" ");
    const evidenceLinks = nodeBlocks.flatMap((item) => item.block.links);
    for (const key of entry.claimKeys) {
      const frozenFacts = entry.evidenceSnapshots || contentPackage?.writing_packet?.evidence_ledger?.map(item => item.fact_snapshot) || [];
      const fact = frozenFacts.find(item => item?.normalized_key === key) || facts.get(key);
      if (!fact) {
        errors.push({ code: "UNKNOWN_BLOCK_CLAIM", path: `$.blocks[${index}]`, claimKey: key });
        continue;
      }
      const validSources = new Set((fact.evidence || []).map((item) => item.source_id));
      if (traces.filter((trace) => trace.claimKey === key).some((trace) => !validSources.has(trace.sourceId))) {
        errors.push({ code: "FORGED_SOURCE_REFERENCE", path: `$.blocks[${index}]`, claimKey: key });
      }
      const keyTraces = traces.filter((trace) => trace.claimKey === key);
      const identified = (fact.evidence || []).filter((item) => item.claim_id || item.id);
      for (const trace of keyTraces) {
        if (identified.length && !identified.some((item) => (item.claim_id || item.id) === trace.claimId && item.source_id === trace.sourceId)) {
          errors.push({ code: "FORGED_CLAIM_REFERENCE", path: `$.blocks[${index}]`, claimKey: key, contentNodeId: entry.contentNodeId,
            message: "内容节点引用了不属于所选证据的陈述。" });
        }
      }
      const selected = selectedFactEvidence(fact, keyTraces);
      const relevanceText = `${headingContext(mappedBlocks, index)} ${evidenceText}`;
      const relevant = factRelevant(relevanceText, fact);
      for (const token of protectedFactTokens(fact, selected, keyTraces)) {
        if (!containsPhrase(evidenceText, token) && !evidenceLinks.includes(token)) {
          errors.push({ code: "EVIDENCE_VALUE_MISMATCH", path: `$.blocks[${index}]`, claimKey: key, expected: token,
            contentNodeId: entry.contentNodeId, message: `此内容节点未保留采用证据中的“${token}”，请只修复该节点。` });
        }
      }
      // Associate conditional quantities with their own clause. Merely having
      // both numbers and both audiences somewhere in a block is insufficient.
      const requiresPairing = keyTraces.some((trace) => ["historical", "conditional"].includes(trace.evidenceRole))
        || new Set(selected.map((item) => normalize(item.value)).filter(Boolean)).size > 1;
      if (requiresPairing && selected.length > 1) for (const evidence of selected) {
        const condition = (evidence.qualifiers || []).map(normalize).find((item) => /^(adult|student|child|senior|resident)$|\b(?:19|20)\d{2}\b/.test(item));
        if (!condition) continue;
        const clauses = evidenceText.split(/[;；。]|\.(?:\s|$)/u).filter((clause) => containsPhrase(clause, condition));
        const quantities = protectedFactTokens({ preferred_value: evidence.value }, []);
        if (!clauses.some((clause) => quantities.every((token) => containsPhrase(clause, token)))) {
          errors.push({ code: "EVIDENCE_CONDITION_MISMATCH", path: `$.blocks[${index}]`, claimKey: key,
            contentNodeId: entry.contentNodeId, message: "数值与适用人群或时间未在同一陈述中对应。" });
        }
      }
      if (!relevant) errors.push({ code: "FACTUAL_ANSWER_MISSING", path: `$.blocks[${index}]`, claimKey: key,
        contentNodeId: entry.contentNodeId });
    }
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
  const values = [fact.subject, fact.canonical_subject, fact.predicate, fact.preferred_value, keyAnchor(fact.normalized_key),
    ...(fact.evidence || []).flatMap((item) => [item.value, ...(item.qualifiers || [])])]
    .flatMap(anchorParts).map(normalize).filter((value) => value.length >= 3);
  return [...new Set(values)];
}

function anchorParts(value) {
  const text = String(value || "");
  return [text, ...[...text.matchAll(/\(([^)]+)\)/g)].map((match) => match[1]),
    ...text.split(/\s*(?:\||,|;|->|→|—>)\s*/u), ...text.split(/[._]+/)];
}

export function factRelevant(text, fact) {
  const anchors = factAnchors(fact);
  if (anchors.some((anchor) => containsPhrase(text, anchor))) return true;
  const ignored = new Set(["with", "from", "into", "route", "guide", "recommended", "recommendation", "attraction",
    "destination", "chongqing", "itinerary", "transport", "transit", "feature", "value"]);
  const candidate = normalize([fact.subject, fact.canonical_subject, fact.preferred_value, keyAnchor(fact.normalized_key)].filter(Boolean).join(" "))
    .split(/\s+/).filter((token) => token.length >= 4 && !ignored.has(token));
  const hits = [...new Set(candidate)].filter((token) => containsPhrase(text, token));
  return hits.length >= 2;
}

function keyAnchor(key) {
  const generic = new Set(["destination", "attraction", "route", "itinerary", "transport", "transit", "food",
    "dining", "accommodation", "chongqing", "recommendation", "feature", "value"]);
  return String(key || "").split(/[._]+/).filter((part) => part && !generic.has(part.toLowerCase())).join(" ");
}

function headingContext(mappedBlocks, index) {
  const headings = [];
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const item = mappedBlocks[cursor];
    if (item?.block?.type !== "heading") continue;
    headings.unshift(item.block.text);
    if (headings.length >= 2) break;
  }
  return headings.join(" ");
}

export function selectedFactEvidence(fact, traces = []) {
  const explicit = traces.filter((trace) => ["historical", "conditional", "current"].includes(trace.evidenceRole));
  if (explicit.length) return (fact.evidence || []).filter((item) => explicit.some((trace) =>
    trace.claimId === (item.claim_id || item.id) && trace.sourceId === item.source_id));
  if (fact.selection_frozen) return fact.evidence || [];
  return (fact.evidence || []).filter((item) => !item.value || normalize(item.value) === normalize(fact.preferred_value));
}

export function selectedFactSnapshot(fact) {
  const keys = ['normalized_key','subject','canonical_subject','predicate','entity_key','entity_type','entity_location',
    'preferred_value','structured_value','scope','unit','consensus_status','freshness_state','verification_priority',
    'latest_evidence_at','consensus_method','consensus_confidence','validity_state','selection_frozen'];
  return { ...Object.fromEntries(keys.filter(key => fact[key] !== undefined).map(key => [key,fact[key]])),
    evidence: selectedFactEvidence(fact) };
}

export function protectedFactTokens(fact, selected = selectedFactEvidence(fact), traces = []) {
  const preserveEverySurface = traces.some((trace) => ["historical", "conditional"].includes(trace.evidenceRole));
  const canonicalValue = fact.preferred_value || selected.find((item) => item.value)?.value;
  const fields = [
    ...(preserveEverySurface ? selected.map((item) => ({ value:item.value, kind:"value" }))
      : [{ value:canonicalValue, kind:"value" }]),
    ...(preserveEverySurface ? selected.flatMap((item) => item.qualifiers || []) : consensusQualifiers(selected))
      .map((value) => ({ value, kind:"qualifier" })),
  ].map((item) => ({ ...item, value:String(item.value || "").trim() })).filter((item) => item.value);
  const tokens = [];
  for (const field of fields) {
    tokens.push(...protectedQuantities(field.value, fact, field.kind));
    tokens.push(...protectedConditions(field.value, fact, field.kind, preserveEverySurface));
    tokens.push(...(field.value.match(/https?:\/\/[^\s)]+/giu) || []));
    tokens.push(...(field.value.match(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/gu) || []));
    if (preserveEverySurface && field.kind === "qualifier") {
      tokens.push(...(field.value.match(/\b(?:19|20)\d{2}\b/gu) || []));
    }
  }
  return [...new Set(tokens.map((item) => item.trim()).filter(Boolean))];
}

function consensusQualifiers(selected) {
  if (selected.length <= 1) return selected.flatMap((item) => item.qualifiers || []);
  const counts = new Map();
  const originals = new Map();
  for (const item of selected) for (const qualifier of new Set((item.qualifiers || []).map((value) => normalize(value)).filter(Boolean))) {
    counts.set(qualifier, (counts.get(qualifier) || 0) + 1);
    originals.set(qualifier, (item.qualifiers || []).find((value) => normalize(value) === qualifier) || qualifier);
  }
  const threshold = Math.max(2, Math.ceil(selected.length * 0.6));
  return [...counts].filter(([, count]) => count >= threshold).map(([key]) => originals.get(key));
}

function protectedQuantities(value, fact, kind) {
  const text = String(value || "");
  const tokens = [];
  const patterns = [
    /(?<![\p{L}\p{N}])(?:CNY|RMB|¥|￥)\s*\d+(?:[.,]\d+)?|(?<![\p{L}\p{N}])\d+(?:[.,]\d+)?\s*(?:CNY|RMB|元)(?![\p{L}\p{N}])/giu,
    /(?<![\p{L}\p{N}])\d+(?:[.,]\d+)?\s*%(?![\p{L}\p{N}])/gu,
    /\b\d{1,2}:\d{2}\s*(?:[-\u2012-\u2015\u2212]|to)\s*\d{1,2}:\d{2}\b/giu,
    /\b\d+(?::\d{2})?\s*(?:[-\u2012-\u2015\u2212]|to)\s*\d+(?::\d{2})?\b/giu,
    /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/giu,
    /\b\d+\s*\/\s*\d+\b/gu,
    /\b\d+(?:[.,]\d+)?\s*(?:minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|km|kilomet(?:er|re)s?|m|meters?|metres?)\b/giu,
    /\b(?:line|exit|floor|level)\s*#?\s*\d+[a-z]?\b/giu,
    /\b\d+(?:st|nd|rd|th)\s*(?:floor|level)\b/giu,
    /\b\d+\s*f\b/giu,
  ];
  for (const pattern of patterns) tokens.push(...(text.match(pattern) || []));
  const predicate = String(fact?.predicate || "").toLowerCase();
  const numericFact = /(?:price|cost|fee|fare|duration|walking_time|opening_hours|schedule|distance|capacity|limit|frequency|age|count|floor|level|exit)/.test(predicate);
  if (!tokens.length && kind === "value" && numericFact && text.length <= 48) {
    tokens.push(...(text.match(/(?<![\p{L}\p{N}])\d+(?:[.,:]\d+)?(?![\p{L}\p{N}])/gu) || []));
  }
  return tokens;
}

function protectedConditions(value, fact, kind, preserveEverySurface) {
  const text = String(value || "").trim();
  if (!text || text.length > 120) return [];
  const predicate = String(fact?.predicate || "").toLowerCase();
  const policyFact = /(?:price|cost|fee|fare|ticket|reservation|booking|entry|admission|access|eligib|open|schedule|policy|rule|allowed|available)/.test(predicate);
  const audience = /^(?:for\s+)?(?:foreign visitors?|international visitors?|mainland chinese|chinese citizens?|students?|children|adults?|seniors?|residents?)(?:\b|$)/iu.test(text);
  if (audience) return [text];
  if (/^(?:only\b|except\b|unless\b)/iu.test(text) && (policyFact || preserveEverySurface)) return [text];
  if (/^(?:not|no|never)\b/iu.test(text) && (policyFact || preserveEverySurface)) return [text];
  if (kind === "value" && /^(?:not|no|never)\b/iu.test(text)) {
    const words = text.match(/^(?:not|no|never)\s+[\p{L}\p{N}]+/iu);
    return words ? [words[0]] : [];
  }
  return [];
}

// Kept as descriptive metadata for diagnostics and repair selection. Dynamic
// facts no longer require a publication date or a second-source recheck.
export function isDynamicFact(fact = {}) {
  const key = String(fact.normalized_key || `${fact.subject || ""}.${fact.predicate || ""}`).toLowerCase();
  return fact.freshness_state === "stale"
    || /(?:price|cost|fee|ticket|hour|opening|schedule|reservation|booking|access|route|policy|rule)/.test(key);
}

function containsPhrase(text, phrase) {
  const haystack = normalize(text); const needle = normalize(phrase);
  if (!needle) return false;
  if (needle === "0 cny" && /\b(?:free|no admission fee|no entry fee)\b/iu.test(haystack)) return true;
  if (/[^\x00-\x7F]/u.test(needle) && !/[A-Za-z0-9]/u.test(needle)) return haystack.includes(needle);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(haystack);
}

export function evidenceTextContains(text, phrase) {
  return containsPhrase(text, phrase);
}
function normalize(value) {
  return decodeHtml(String(value || "")).normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gu, (_, h, m, period) => `${String(Number(h) % 12 + (period === 'pm' ? 12 : 0)).padStart(2,'0')}:${m || '00'}`)
    .replace(/\b(\d):(?=\d{2}\b)/gu, '0$1:')
    .replace(/\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\b/gu, (_, n) => `${Number(n) * 60} min`)
    .replace(/\bminutes?\b/gu, 'min')
    .replace(/\b(?:floor|level)\s*(\d+)(?:st|nd|rd|th)?\b/gu, 'floor $1')
    .replace(/\b(\d+)(?:st|nd|rd|th)\s*(?:floor|level)\b/gu, 'floor $1')
    .replace(/\b(\d+)\s*f\b/gu, 'floor $1')
    .replace(/\b(\d+)(?:st|nd|rd|th)\b/gu, '$1')
    .replace(/(?<=\d)\s*[-\u2012-\u2015\u2212]\s*(?=\d)/gu, ' to ')
    .replace(/(?:cny|rmb|¥|￥)\s*(\d+(?:\.\d+)?)/gu, '$1 cny')
    .replace(/(\d+(?:\.\d+)?)\s*(?:rmb|元)/gu, '$1 cny')
    .replace(/\b(adult|student|senior|resident)s\b/gu, '$1').replace(/\bchildren\b/gu, 'child')
    .replace(/[^\p{L}\p{N}:/.%¥￥]+/gu, " ").trim();
}
function decodeHtml(value) {
  return value.replace(/&nbsp;/giu, " ").replace(/&amp;/giu, "&").replace(/&quot;/giu, '"')
    .replace(/&#(?:39|x27);/giu, "'").replace(/&lt;/giu, "<").replace(/&gt;/giu, ">");
}
function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableObject(value[key])]));
  return value;
}
