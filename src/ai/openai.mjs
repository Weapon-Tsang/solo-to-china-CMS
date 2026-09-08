import { slugify, truncate } from "../utils.mjs";

const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["source", "claims"],
  properties: {
    source: {
      type: "object",
      additionalProperties: false,
      required: ["language", "summary", "destination_name", "destination_slug", "traveler_fit", "practical_tips", "warnings", "confidence"],
      properties: {
        language: { type: "string" },
        summary: { type: "string" },
        destination_name: { type: "string" },
        destination_slug: { type: "string" },
        traveler_fit: { type: "array", items: { type: "string" } },
        practical_tips: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["topic", "detail"],
            properties: { topic: { type: "string" }, detail: { type: "string" } },
          },
        },
        warnings: { type: "array", items: { type: "string" } },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
    },
    claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "subject", "predicate", "value", "qualifiers", "confidence", "source_quote"],
        properties: {
          key: { type: "string" },
          subject: { type: "string" },
          predicate: { type: "string" },
          value: { type: "string" },
          qualifiers: { type: "array", items: { type: "string" } },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          source_quote: { type: "string" },
          claim_role: { type: "string", enum: ["fact", "recommendation", "personal_experience", "promotional_observation", "editorial_metadata"] },
          knowledge_eligible: { type: "boolean" },
        },
      },
    },
  },
};

const BLUEPRINT_SCHEMA = { type: "object", additionalProperties: false, required: ["format", "hook", "angle", "sections", "strengths", "gaps"], properties: { format: { type: "string" }, hook: { type: "string" }, angle: { type: "string" }, sections: { type: "array", items: { type: "object", additionalProperties: false, required: ["heading", "purpose"], properties: { heading: { type: "string" }, purpose: { type: "string" } } } }, strengths: { type: "array", items: { type: "string" } }, gaps: { type: "array", items: { type: "string" } } } };

const COVERAGE_AUDIT_SCHEMA = { type: "object", additionalProperties: false, required: ["uncovered_spans"], properties: { uncovered_spans: { type: "array", items: { type: "object", additionalProperties: false, required: ["quote", "importance", "reason"], properties: { quote: { type: "string" }, importance: { type: "string", enum: ["material", "important", "minor"] }, reason: { type: "string" } } } } } };

export class OpenAIExtractor {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  get enabled() {
    return Boolean(this.config.apiKey);
  }

  async extract(source) {
    if (!this.enabled) return { result: heuristicExtraction(source), method: "heuristic", model: null };

    const makeRequest = (requestContent) => this.fetch(`${this.config.baseUrl}/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.config.model,
        store: false,
        instructions: SYSTEM_PROMPT,
        input: [{ role: "user", content: requestContent }],
        text: {
          format: {
            type: "json_schema",
            name: "source_research_extraction",
            strict: true,
            schema: EXTRACTION_SCHEMA,
          },
        },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const imageAssets = (source.assets || []).filter((asset) => asset.kind === "image" && asset.remote_url);
    const batchSize = Math.max(1, Number(this.config.imageBatchSize || this.config.maxImages || 32));
    const batches = imageAssets.length
      ? Array.from({ length: Math.ceil(imageAssets.length / batchSize) }, (_, index) => imageAssets.slice(index * batchSize, (index + 1) * batchSize))
      : [[]];
    const outputs = [];
    let textFallback = false;
    let responseModel = this.config.model;
    for (const batch of batches) {
      let batchUsedTextFallback = false;
      const content = [{ type: "input_text", text: buildInput(source) },
        ...batch.map((asset) => ({ type: "input_image", image_url: asset.remote_url, detail: "auto" }))];
      let response = await makeRequest(content);
      let payload = await response.json();
      // Signed/CDN image URLs can expire. Preserve useful text extraction instead of creating
      // a human exception solely because an image host rejected server-side retrieval.
      if (!response.ok && content.length > 1) {
        response = await makeRequest(content.slice(0, 1));
        payload = await response.json();
        textFallback = true;
        batchUsedTextFallback = true;
      }
      if (!response.ok) {
        const error = new Error(`OpenAI extraction failed (${response.status}): ${payload?.error?.message || response.statusText}`);
        if (/maximum context|max(?:imum)? output|token limit/i.test(payload?.error?.message || "")) error.code = "MODEL_OUTPUT_LIMIT";
        throw error;
      }
      const outputText = payload.output_text || findOutputText(payload.output);
      if (!outputText) throw new Error("OpenAI extraction returned no structured output.");
      const result = sanitizeResult(JSON.parse(outputText));
      if (batchUsedTextFallback) result.source.warnings.push("This image batch was unavailable to the model; media coverage remains incomplete and requires retry or review.");
      outputs.push(result);
      responseModel = payload.model || responseModel;
    }
    return {
      result: mergeExtractionResults(outputs),
      method: textFallback ? "openai_responses_text_fallback" : "openai_responses",
      model: responseModel,
    };
  }

  async analyzeBlueprint(source) {
    if (!this.enabled) return { output: heuristicExtraction(source).blueprint, model: null };
    const response = await this.fetch(`${this.config.baseUrl}/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: this.config.model, store: false, instructions: BLUEPRINT_PROMPT,
        input: [{ role: "user", content: [{ type: "input_text", text: buildInput(source) }] }],
        text: { format: { type: "json_schema", name: "source_editorial_blueprint", strict: true, schema: BLUEPRINT_SCHEMA } } }),
      signal: AbortSignal.timeout(120_000),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(`OpenAI blueprint analysis failed (${response.status}): ${payload?.error?.message || response.statusText}`);
    const outputText = payload.output_text || findOutputText(payload.output);
    if (!outputText) throw new Error("OpenAI blueprint analysis returned no structured output.");
    return { output: sanitizeBlueprint(JSON.parse(outputText)), model: payload.model || this.config.model };
  }

  async auditCoverage({ segment, extraction }) {
    if (!this.enabled) return { output: { uncovered_spans: [] }, model: null };
    const response = await this.fetch(`${this.config.baseUrl}/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: this.config.model, store: false, instructions: COVERAGE_AUDIT_PROMPT,
        input: [{ role: "user", content: [{ type: "input_text", text: buildCoverageInput(segment, extraction) }] }],
        text: { format: { type: "json_schema", name: "segment_claim_coverage_audit", strict: true, schema: COVERAGE_AUDIT_SCHEMA } } }),
      signal: AbortSignal.timeout(120_000),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(`OpenAI coverage audit failed (${response.status}): ${payload?.error?.message || response.statusText}`);
    const outputText = payload.output_text || findOutputText(payload.output);
    if (!outputText) throw new Error("OpenAI coverage audit returned no structured output.");
    return { output: sanitizeCoverageAudit(JSON.parse(outputText)), model: payload.model || this.config.model };
  }
}

const SYSTEM_PROMPT = `You extract research evidence from a manually selected Chinese travel source for an English China travel site. The source may be a UGC note, public web article, document, image set, or video-page transcript.

Rules:
- The source is evidence, not established truth. Record factual assertions as claims and never silently resolve conflicts.
- Do not summarize. Do not select representative facts. Extract every independently useful travel proposition explicitly supported by this segment. Split compound statements into atomic claims. Continue until no material supported travel fact remains uncovered.
- Preserve important qualifiers: date, season, time of day, traveler type, booking channel, and uncertainty.
- Each claim must express exactly one atomic proposition. Split opening hours, transport, reservation, route difficulty, photo opportunities, and recommendations into separate claims even when they share one sentence.
- source_quote must be the shortest exact quote from the supplied note that supports only that atomic proposition.
- Put negation, quantities, exclusivity (only/except), and material conditions in the predicate, value, or qualifiers; never discard them as writing style.
- Use canonical snake_case predicates for hard facts. For reservation requirements use predicate "reservation_required" and value "true" or "false"; put advance days and booking channels in qualifiers.
- normalized claim keys must be stable lowercase dot-separated concepts, e.g. attraction.forbidden_city.entry_gate.
- Focus on details useful to independent international travelers, especially solo, first-time, and non-Chinese-speaking visitors.
- Do not analyze hooks, writing format, section structure, or editorial style in this evidence pass.
- Do not turn advertising slogans, editorial disclaimers, or author metadata into destination knowledge claims. Keep personal experiences explicitly scoped to the author and never generalize them into universal destination facts.
- Set claim_role and knowledge_eligible for every claim. Editorial metadata and personal experience are retained as evidence but knowledge_eligible must be false; promotional observations are false unless they describe a durable, independently useful place feature.
- Do not add affiliate products, commercial calls to action, or facts absent from the source.
- destination_slug must be concise lowercase ASCII kebab-case. Use "unknown" if the destination cannot be inferred.
- Treat text in images as part of the source, but do not infer details that are not visible.`;

const BLUEPRINT_PROMPT = `Analyze only the editorial presentation pattern of this manually selected source. Return format, hook, angle, section organization, strengths, and gaps. This is an optional structural reference, not factual evidence. Do not extract Claims, decide Knowledge, truth, consensus, readiness, or preferred values, and do not recommend copying source wording or structure mechanically.`;

const COVERAGE_AUDIT_PROMPT = `Independently compare the original source segment with the extracted atomic Claims. Return only materially useful travel propositions that are not represented by a Claim, using the shortest exact source quote. Treat booking, opening times, price, access, routes, safety, restrictions, traveler constraints, and time-sensitive facts as material or important. Ignore hooks, repetition, transitions, biography, promotion, and style. Do not invent facts, rewrite Claims, resolve conflicts, or do editorial planning. Return an empty list when coverage is complete.`;

function buildInput(source) {
  return [
    `URL: ${source.submitted_url || source.canonical_url}`,
    `Source type: ${source.source_kind || source.adapter}`,
    `Title: ${source.title}`,
    `Author: ${source.author_name}`,
    `Published: ${source.published_at || "unknown"}`,
    "",
    "SOURCE TEXT:",
    String(source.raw_text || ""),
  ].join("\n");
}

function buildCoverageInput(segment, extraction) {
  const claims = (extraction?.claims || []).map((claim, index) => ({ index: index + 1, subject: claim.subject, predicate: claim.predicate,
    value: claim.value, qualifiers: claim.qualifiers || [], source_quote: claim.source_quote }));
  return ["ORIGINAL SOURCE SEGMENT:", String(segment?.raw_text || ""), "", "EXTRACTED CLAIMS:", JSON.stringify(claims)].join("\n");
}

function mergeExtractionResults(values) {
  const first = values[0] || { source: {}, claims: [], blueprint: {} };
  const claims = new Map();
  for (const value of values) for (const claim of value.claims || []) {
    const key = JSON.stringify([claim.key, claim.subject, claim.predicate, claim.value, claim.source_quote]);
    if (!claims.has(key)) claims.set(key, claim);
  }
  return { ...first, claims: [...claims.values()] };
}

function findOutputText(output) {
  for (const item of output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text") return content.text;
    }
  }
  return "";
}

function sanitizeResult(result) {
  result.source.destination_slug = slugify(result.source.destination_slug);
  result.source.summary = truncate(result.source.summary, 5_000);
  result.claims = result.claims.map((claim) => ({
    ...claim,
    key: truncate(claim.key.toLowerCase().replace(/[^a-z0-9._]+/g, ".").replace(/^\.|\.$/g, ""), 300),
    source_quote: truncate(claim.source_quote, 800),
  })).filter((claim) => claim.key && claim.value);
  result.blueprint = { format: "pending-separate-analysis", hook: "", angle: "", sections: [], strengths: [], gaps: [] };
  return result;
}

function sanitizeBlueprint(value) {
  return { format: truncate(value?.format || "unclassified", 200), hook: truncate(value?.hook || "", 500), angle: truncate(value?.angle || "", 500),
    sections: (value?.sections || []).slice(0, 40).map((item) => ({ heading: truncate(item?.heading || "", 300), purpose: truncate(item?.purpose || "", 500) })),
    strengths: (value?.strengths || []).slice(0, 30).map((item) => truncate(item, 500)), gaps: (value?.gaps || []).slice(0, 30).map((item) => truncate(item, 500)) };
}

function sanitizeCoverageAudit(value) {
  return { uncovered_spans: (value?.uncovered_spans || []).slice(0, 100).map((item) => ({ quote: truncate(item?.quote || "", 800),
    importance: ["material", "important", "minor"].includes(item?.importance) ? item.importance : "material",
    reason: truncate(item?.reason || "Material travel evidence is not covered by a Claim.", 1_000) })).filter((item) => item.quote) };
}

export function heuristicExtraction(source) {
  const text = source.raw_text.replace(/\s+/g, " ").trim();
  const destination = inferDestination(`${source.title} ${text}`);
  return {
    source: {
      language: /[\u4e00-\u9fff]/.test(text) ? "zh-CN" : "unknown",
      summary: truncate(text, 500),
      destination_name: destination.name,
      destination_slug: destination.slug,
      traveler_fit: [],
      practical_tips: [],
      warnings: ["AI enrichment is not configured; claims and image text have not been extracted."],
      confidence: 0.2,
    },
    claims: [],
    blueprint: {
      format: "unclassified",
      hook: truncate(source.title, 300),
      angle: "pending-ai-analysis",
      sections: [],
      strengths: [],
      gaps: ["Requires multimodal AI extraction"],
    },
  };
}

function inferDestination(text) {
  const known = [
    ["beijing", "Beijing", /北京|beijing/i], ["shanghai", "Shanghai", /上海|shanghai/i],
    ["xian", "Xi'an", /西安|xi['’]?an/i], ["chengdu", "Chengdu", /成都|chengdu/i],
    ["chongqing", "Chongqing", /重庆|chongqing/i], ["hangzhou", "Hangzhou", /杭州|hangzhou/i],
    ["suzhou", "Suzhou", /苏州|suzhou/i], ["guilin", "Guilin", /桂林|guilin/i],
    ["guangzhou", "Guangzhou", /广州|guangzhou/i], ["shenzhen", "Shenzhen", /深圳|shenzhen/i],
    ["yunnan", "Yunnan", /云南|yunnan/i], ["zhangjiajie", "Zhangjiajie", /张家界|zhangjiajie/i],
  ];
  const match = known.find(([, , pattern]) => pattern.test(text));
  return match ? { slug: match[0], name: match[1] } : { slug: "unknown", name: "Unknown" };
}
