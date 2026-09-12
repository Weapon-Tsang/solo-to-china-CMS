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
    let relevant = false;
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
      const anchors = factAnchors(fact);
      if (anchors.some((anchor) => containsPhrase(evidenceText, anchor))) relevant = true;
      for (const token of protectedFactTokens(fact, selected)) {
        if (!containsPhrase(evidenceText, token) && !evidenceLinks.includes(token)) {
          errors.push({ code: "EVIDENCE_VALUE_MISMATCH", path: `$.blocks[${index}]`, claimKey: key, expected: token,
            contentNodeId: entry.contentNodeId, message: `此内容节点未保留采用证据中的“${token}”，请只修复该节点。` });
        }
      }
      // Associate conditional quantities with their own clause. Merely having
      // both numbers and both audiences somewhere in a block is insufficient.
      if (selected.length > 1) for (const evidence of selected) {
        const condition = (evidence.qualifiers || []).map(normalize).find((item) => /^(adult|student|child|senior|resident)$|\b(?:19|20)\d{2}\b/.test(item));
        if (!condition) continue;
        const clauses = evidenceText.split(/[;；。]|\.(?:\s|$)/u).filter((clause) => containsPhrase(clause, condition));
        const quantities = protectedFactTokens({ preferred_value: evidence.value }, []);
        if (!clauses.some((clause) => quantities.every((token) => containsPhrase(clause, token)))) {
          errors.push({ code: "EVIDENCE_CONDITION_MISMATCH", path: `$.blocks[${index}]`, claimKey: key,
            contentNodeId: entry.contentNodeId, message: "数值与适用人群或时间未在同一陈述中对应。" });
        }
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

export function protectedFactTokens(fact, selected = selectedFactEvidence(fact)) {
  const fields = [selected.some(item => item.value) ? null : fact.preferred_value, ...selected.flatMap((item) => [item.value, ...(item.qualifiers || [])])]
    .map((value) => String(value || "").trim()).filter(Boolean);
  const text = fields.join(" ");
  const numbers = fields.flatMap((field) => field.match(/(?<![\p{L}\p{N}])(?:(?:¥|￥|CNY|RMB)\s*)?\d+(?:[.,:]\d+)?(?:[A-Z](?![\p{L}\p{N}]))?(?:\s*(?:元|%|(?:rmb|cny|am|pm|hours?|minutes?|days?)(?![\p{L}\p{N}])))?/giu) || []);
  const dates = fields.flatMap((field) => field.match(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/gu) || []);
  const conditions = fields.flatMap((field) => {
    const protectedQualifier = /^(?:except|unless|not|no|never|only\b|after\b|before\b|from\b|until\b|students?\b|children\b|adults?\b|seniors?\b|foreign visitors?\b|international visitors?\b|mainland chinese\b|chinese citizens?\b|residents?\b)/iu.test(field);
    if (protectedQualifier && field.length <= 120) return [field];
    return [...field.matchAll(/\b(?:except|unless|not|no|never)\s+[^,.;:]{1,60}/giu),
      ...field.matchAll(/\bonly\s+(?:for|on|available|valid|open|accepted|allowed|applies?|runs?|operates?)\s+[\p{L}\p{N}'’-]+/giu),
      ...field.matchAll(/\b(?:foreign visitors?|international visitors?|mainland chinese|chinese citizens?|students?|children|adults?|seniors?|residents?)\b/giu)]
      .map((match) => match[0].trim());
  });
  const ranges = fields.flatMap(field => field.match(/\b\d+(?::\d{2})?\s*(?:-|–|—|to)\s*\d+(?::\d{2})?\b/giu) || []);
  const urls = text.match(/https?:\/\/[^\s)]+/giu) || [];
  return [...new Set([...numbers, ...dates, ...conditions, ...ranges, ...urls].map((item) => item.trim()))];
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
  if (/[^\x00-\x7F]/u.test(needle) && !/[A-Za-z0-9]/u.test(needle)) return haystack.includes(needle);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(haystack);
}
function normalize(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gu, (_, h, m, period) => `${String(Number(h) % 12 + (period === 'pm' ? 12 : 0)).padStart(2,'0')}:${m || '00'}`)
    .replace(/\b(\d):(?=\d{2}\b)/gu, '0$1:')
    .replace(/\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\b/gu, (_, n) => `${Number(n) * 60} min`)
    .replace(/\bminutes?\b/gu, 'min')
    .replace(/(?<=\d)\s*[-–—]\s*(?=\d)/gu, ' to ')
    .replace(/(?:cny|rmb|¥|￥)\s*(\d+(?:\.\d+)?)/gu, '$1 cny')
    .replace(/(\d+(?:\.\d+)?)\s*(?:rmb|元)/gu, '$1 cny')
    .replace(/\b(adult|student|senior|resident)s\b/gu, '$1').replace(/\bchildren\b/gu, 'child')
    .replace(/[^\p{L}\p{N}:/.%¥￥]+/gu, " ").trim();
}
function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableObject(value[key])]));
  return value;
}
