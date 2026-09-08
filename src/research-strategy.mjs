import { sha256, slugify } from "./utils.mjs";

export const SOURCE_FAMILY_RELATIONS = Object.freeze([
  "EXACT_DUPLICATE", "NEAR_DUPLICATE", "DERIVED_FROM", "PARTIAL_OVERLAP", "INDEPENDENT",
]);

export const COVERAGE_REQUIREMENTS = Object.freeze({
  city_guide: slots(["orientation", "transport", "where_to_stay", "top_attractions"], ["cost", "booking", "food", "safety", "timing"]),
  itinerary: slots(["route", "duration", "transport", "timing"], ["booking", "cost", "food", "alternatives"]),
  attraction_guide: slots(["entry", "opening_time", "reservation", "transport"], ["cost", "visit_duration", "accessibility", "warnings"]),
  food_guide: slots(["what_to_eat", "where_to_eat", "cost"], ["ordering", "dietary", "hours", "warnings"]),
  transport_guide: slots(["route", "station", "schedule", "payment"], ["cost", "duration", "accessibility", "warnings"]),
  neighborhood_guide: slots(["orientation", "transport", "character"], ["food", "hotels", "attractions", "safety"]),
  hotel_area_guide: slots(["area", "transport", "traveler_fit"], ["cost", "tradeoffs", "food", "attractions"]),
  shopping_guide: slots(["what_to_buy", "where_to_buy", "payment"], ["hours", "price", "tax", "warnings"]),
  practical_guide: slots(["core_answer", "steps", "requirements"], ["cost", "timing", "alternatives", "warnings"]),
  first_time_guide: slots(["orientation", "transport", "booking", "payment"], ["cost", "safety", "connectivity", "etiquette", "timing"]),
  comparison: slots(["options", "differences", "traveler_fit"], ["cost", "timing", "tradeoffs"]),
  listicle: slots(["selection_basis", "items"], ["transport", "cost", "timing", "booking"]),
  how_to: slots(["goal", "steps", "requirements"], ["cost", "timing", "alternatives", "warnings"]),
});

export function segmentSource(source, { maxChars = 6_000 } = {}) {
  const segmentMaxChars = Math.max(2_000, Math.min(250_000, Number(maxChars || 6_000)));
  const pieces = source.source_kind === "pdf"
    ? splitPdfText(source.raw_text, segmentMaxChars)
    : splitText(source.raw_text, segmentMaxChars);
  const segments = pieces.map((piece, index) => makeSegment(source.id, piece, index));
  for (const [index, asset] of (source.assets || []).entries()) {
    if (!asset || !["image", "video_cover", "video"].includes(asset.kind)) continue;
    const type = asset.kind === "video" ? "video_chapter" : "image";
    const sequence = segments.length;
    segments.push(makeSegment(source.id, {
      type, text: asset.alt_text || asset.original_filename || "", title: asset.original_filename || `Asset ${index + 1}`,
      assetId: asset.id, imageIndex: asset.kind === "video" ? null : index + 1,
    }, sequence));
  }
  if (!segments.length) segments.push(makeSegment(source.id, { type: "other", text: "", title: source.title || "Source" }, 0));
  return segments;
}

export function evaluateCoverage({ topicKey, contentType = "practical_guide", facts = [], sourceFamilyCount = 0 }) {
  const requirements = COVERAGE_REQUIREMENTS[contentType] || COVERAGE_REQUIREMENTS.practical_guide;
  const rows = [...requirements.required.map((key) => requirement(key, "required", facts)),
    ...requirements.important.map((key) => requirement(key, "important", facts)),
    ...requirements.optional.map((key) => requirement(key, "optional", facts))];
  const required = rows.filter((item) => item.priority === "required");
  const important = rows.filter((item) => item.priority === "important");
  const requiredCovered = required.filter((item) => item.state === "covered").length;
  const importantCovered = important.filter((item) => item.state === "covered").length;
  const staleCount = rows.filter((item) => item.state === "stale").length;
  const conflictedCount = rows.filter((item) => item.state === "conflicted").length;
  const requiresOfficialCount = rows.filter((item) => item.state === "requires_verification").length;
  const requiredRatio = required.length ? requiredCovered / required.length : 1;
  const importantRatio = important.length ? importantCovered / important.length : 1;
  const coverage = Math.round((requiredRatio * 0.75 + importantRatio * 0.25) * 100);
  const blockingRequirements = required.filter((item) => item.state !== "covered").map((item) => item.key);
  return {
    topicKey, contentType, requirements: rows,
    readiness: {
      ready: requiredRatio === 1 && sourceFamilyCount >= 2 && conflictedCount === 0 && requiresOfficialCount === 0,
      score: Math.max(0, Math.min(100, coverage + Math.min(10, facts.length) - staleCount * 3 - conflictedCount * 8 - requiresOfficialCount * 5)),
      coverage, requiredCovered, requiredTotal: required.length,
      importantCovered, importantTotal: important.length, factCount: facts.length, sourceFamilyCount,
      staleCount, conflictedCount, requiresOfficialCount,
      missingRequirements: rows.filter((item) => item.state === "missing").map((item) => item.key),
      blockingRequirements,
    },
  };
}

export function classifySourceFamily(left, right) {
  if (!left || !right) return { relation: "INDEPENDENT", overlapScore: 0, incrementalRatio: 1 };
  if (left.content_hash && left.content_hash === right.content_hash) return { relation: "EXACT_DUPLICATE", overlapScore: 1, incrementalRatio: 0 };
  const a = tokens(left.raw_text || left.summary || "");
  const b = tokens(right.raw_text || right.summary || "");
  const overlapScore = jaccard(a, b);
  const incrementalRatio = b.size ? [...b].filter((item) => !a.has(item)).length / b.size : 0;
  const derived = sameAuthor(left, right) && overlapScore >= 0.55;
  return {
    relation: derived ? "DERIVED_FROM" : overlapScore >= 0.85 ? "NEAR_DUPLICATE" : overlapScore >= 0.25 ? "PARTIAL_OVERLAP" : "INDEPENDENT",
    overlapScore, incrementalRatio,
  };
}

export function stableOpportunityKey(destinationSlug, topic, contentType = "practical_guide") {
  const topicSlug = slugify(topic) || sha256(String(topic || "travel-topic")).slice(0, 12);
  return `${slugify(destinationSlug) || "unknown"}:${contentType}:${topicSlug}`;
}

function slots(required, important = [], optional = []) { return Object.freeze({ required, important, optional }); }

function splitPdfText(text, maxChars) {
  return String(text || "").split(/\f|\n\s*\n(?=(?:page\s*)?\d+\b)/iu)
    .flatMap((value, index) => splitText(value, maxChars).map((piece) => ({ ...piece, type: "pdf_page_group", pageStart: index + 1, pageEnd: index + 1 })));
}

function splitText(text, maxChars) {
  const paragraphs = String(text || "").split(/\n\s*\n+/u).map((item) => item.trim()).filter(Boolean);
  const output = [];
  let buffer = [];
  let length = 0;
  for (const paragraph of paragraphs.flatMap((value) => hardSplitParagraph(value, maxChars))) {
    if (length + paragraph.length > maxChars && buffer.length) {
      output.push({ type: "paragraph_group", text: buffer.join("\n\n"), title: "" });
      buffer = []; length = 0;
    }
    buffer.push(paragraph); length += paragraph.length;
  }
  if (buffer.length) output.push({ type: "paragraph_group", text: buffer.join("\n\n"), title: "" });
  return output;
}

function hardSplitParagraph(paragraph, maxLength = 6_000, overlap = 240) {
  if (paragraph.length <= maxLength) return [paragraph];
  const chunks = [];
  let start = 0;
  while (start < paragraph.length) {
    let end = Math.min(paragraph.length, start + maxLength);
    if (end < paragraph.length) {
      const boundary = Math.max(paragraph.lastIndexOf("。", end), paragraph.lastIndexOf("！", end),
        paragraph.lastIndexOf("？", end), paragraph.lastIndexOf(". ", end), paragraph.lastIndexOf("\n", end));
      if (boundary > start + Math.floor(maxLength * 0.65)) end = boundary + 1;
    }
    chunks.push(paragraph.slice(start, end));
    if (end >= paragraph.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

function makeSegment(sourceId, piece, sequence) {
  const text = String(piece.text || "");
  return {
    id: `segment_${sha256(`${sourceId}:${sequence}:${text}`).slice(0, 24)}`, sourceId,
    segmentType: piece.type || "paragraph_group", sequence, title: piece.title || "", rawText: text,
    pageStart: piece.pageStart ?? null, pageEnd: piece.pageEnd ?? null, assetId: piece.assetId || null,
    imageIndex: piece.imageIndex ?? null, destinationScopes: [], topicScopes: [],
    contentHash: sha256(text), semanticHash: sha256(normalize(text)), status: "pending",
  };
}

function requirement(key, priority, facts) {
  const matching = facts.filter((fact) => matchesRequirement(key, fact));
  let state = "missing";
  if (matching.some((fact) => fact.consensus_status === "conflicted")) state = "conflicted";
  else if (matching.some((fact) => fact.verification_priority === "requires_official")) state = "requires_verification";
  else if (matching.length && matching.every((fact) => fact.freshness_state === "stale")) state = "stale";
  else if (matching.length) state = "covered";
  return { key, priority, state, factKeys: matching.map((fact) => fact.normalized_key).filter(Boolean) };
}

const MATCHERS = {
  orientation: /location|district|area|orientation|address/i, transport: /transport|metro|train|bus|station|airport|route/i,
  route: /route|sequence|itinerary|travel.?between/i, station: /station|metro|train|bus/i, schedule: /schedule|departure|frequency/i,
  timing: /time|hour|duration|season|schedule/i, opening_time: /opening|hours|close/i, reservation: /reserv|book/i,
  booking: /reserv|book|ticket/i, entry: /entry|entrance|gate|admission|ticket/i, cost: /cost|price|fee|budget|fare/i,
  price: /cost|price|fee/i, payment: /payment|cash|card|alipay|wechat/i, safety: /safety|risk|warning|scam/i,
  warnings: /warning|avoid|closed|restriction|risk/i, accessibility: /accessible|wheelchair|stairs|elderly|child/i,
  food: /food|restaurant|eat|dish/i, what_to_eat: /food|dish|snack|eat/i, where_to_eat: /restaurant|market|street|where.*eat/i,
  where_to_stay: /hotel|stay|accommodation|area/i, hotels: /hotel|stay|accommodation/i, attractions: /attraction|museum|temple|park|street/i,
  top_attractions: /attraction|museum|temple|park|street/i, visit_duration: /duration|hour|day/i, alternatives: /alternative|instead|option/i,
  steps: /step|process|how|first|then/i, requirements: /require|need|passport|id|visa/i, core_answer: /answer|recommend|require|how/i,
  traveler_fit: /solo|family|child|elderly|first.time|traveler/i, tradeoffs: /tradeoff|but|however|advantage|disadvantage/i,
  connectivity: /internet|sim|wifi|vpn/i, etiquette: /etiquette|custom|behavior|respect/i, character: /atmosphere|character|vibe/i,
  area: /area|district|neighborhood/i, options: /option|alternative|versus|compare/i, differences: /difference|versus|compare/i,
  selection_basis: /best|top|selection|recommend/i, items: /attraction|place|spot|restaurant|hotel/i, goal: /how|goal|result/i,
  what_to_buy: /buy|souvenir|shopping|product/i, where_to_buy: /shop|mall|market|street/i, tax: /tax|refund/i,
  hours: /opening|hours|close/i, dietary: /vegetarian|vegan|halal|allergy|diet/i, ordering: /order|menu|app/i,
};

function matchesRequirement(key, fact) {
  const text = `${fact.normalized_key || ""} ${fact.subject || ""} ${fact.predicate || ""}`;
  return (MATCHERS[key] || new RegExp(key.replaceAll("_", ".?"), "i")).test(text);
}
function normalize(value) { return String(value || "").toLowerCase().replace(/\s+/g, " ").trim(); }
function tokens(value) {
  const normalized = normalize(value);
  const words = normalized.split(/[^\p{L}\p{N}]+/u).filter((item) => item.length > 1);
  const hanRuns = normalized.match(/[\p{Script=Han}]+/gu) || [];
  const hanNgrams = hanRuns.flatMap((run) => {
    const values = [];
    for (const size of [2, 3]) for (let index = 0; index <= run.length - size; index += 1) values.push(run.slice(index, index + size));
    return values;
  });
  return new Set([...words, ...hanNgrams]);
}
function jaccard(a, b) { const union = new Set([...a, ...b]); return union.size ? [...a].filter((item) => b.has(item)).length / union.size : 0; }
function sameAuthor(a, b) { return Boolean(a.author_name && b.author_name && normalize(a.author_name) === normalize(b.author_name)); }
