import crypto from "node:crypto";
import { slugify, truncate } from "../utils.mjs";
import { createAiClient } from "./client.mjs";
import { validateJsonSchema } from "../frontend-contract.mjs";
import { resolveStagePolicy } from "./stage-policy.mjs";

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
        language: { type: "string" }, summary: { type: "string" }, destination_name: { type: "string" }, destination_slug: { type: "string" },
        traveler_fit: { type: "array", items: { type: "string" } },
        practical_tips: { type: "array", items: { type: "object", additionalProperties: false, required: ["topic", "detail"], properties: { topic: { type: "string" }, detail: { type: "string" } } } },
        warnings: { type: "array", items: { type: "string" } }, confidence: { type: "number", minimum: 0, maximum: 1 },
      },
    },
    claims: { type: "array", items: { type: "object", additionalProperties: false, required: ["key", "subject", "predicate", "value", "qualifiers", "confidence", "source_quote"], properties: { key: { type: "string" }, subject: { type: "string" }, predicate: { type: "string" }, value: { type: "string" }, qualifiers: { type: "array", items: { type: "string" } }, confidence: { type: "number", minimum: 0, maximum: 1 }, source_quote: { type: "string" }, asset_id: { type: "string" }, segment_id: { type: "string" }, observed_at: { type: "string" }, valid_from: { type: "string" }, valid_to: { type: "string" }, date_confidence: { type: "string", enum: ["low", "medium", "high"] }, claim_role: { type: "string", enum: ["fact", "recommendation", "personal_experience", "promotional_observation", "editorial_metadata"] }, knowledge_eligible: { type: "boolean" } } } },
  },
};

const BLUEPRINT_SCHEMA = { type: "object", additionalProperties: false, required: ["format", "hook", "angle", "sections", "strengths", "gaps"], properties: { format: { type: "string" }, hook: { type: "string" }, angle: { type: "string" }, sections: { type: "array", items: { type: "object", additionalProperties: false, required: ["heading", "purpose"], properties: { heading: { type: "string" }, purpose: { type: "string" } } } }, strengths: { type: "array", items: { type: "string" } }, gaps: { type: "array", items: { type: "string" } } } };

const COVERAGE_AUDIT_SCHEMA = { type: "object", additionalProperties: false, required: ["uncovered_spans"], properties: { uncovered_spans: { type: "array", items: { type: "object", additionalProperties: false, required: ["quote", "importance", "reason"], properties: { quote: { type: "string" }, importance: { type: "string", enum: ["material", "important", "minor"] }, reason: { type: "string" } } } } } };

export class KimiExtractor {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.client = createAiClient(config, fetchImpl);
  }

  get enabled() {
    return this.client.enabled;
  }

  get batchEnabled() {
    return this.config.provider === "vertex" && this.client.batchEnabled;
  }

  async testConnection({signal=null}={}) {
    if(!this.enabled)throw Object.assign(new Error("AI provider is not configured."),{code:"AI_NOT_CONFIGURED",retryable:false});
    const started=Date.now();
    const completion=await this.client.completeJson({name:"manual_provider_connection_test",
      schema:{type:"object",additionalProperties:false,required:["ok"],properties:{ok:{type:"boolean"}}},
      instructions:"Return JSON with ok=true. This is an operator-requested provider connection test.",
      content:[{type:"text",text:"connection test"}],signal,telemetryContext:{runId:`connection-test-${started}`,entityId:"manual"}});
    return {ok:completion.output?.ok===true,model:completion.model,latencyMs:Date.now()-started,testedAt:new Date().toISOString()};
  }

  artifactContract(stage) {
    if (stage === 'analyze_source_blueprint') return { name: 'source_blueprint', schema: BLUEPRINT_SCHEMA, prompt: BLUEPRINT_PROMPT };
    return { name: stage === 'audit_segment_coverage' ? 'segment_claim_coverage_audit' : 'source_research_extraction',
      ...this.batchConfigSnapshot(stage) };
  }

  batchConfigSnapshot(operation = "extract_segment_claims") {
    const coverage = operation === "audit_segment_coverage";
    const snapshot = {
      provider: this.config.provider || "vertex",
      model: this.config.model || "",
      location: this.config.location || "global",
      projectId: this.config.projectId || "",
      schemaHash: digest(JSON.stringify(coverage ? COVERAGE_AUDIT_SCHEMA : EXTRACTION_SCHEMA)),
      promptHash: digest(coverage ? COVERAGE_AUDIT_PROMPT : SYSTEM_PROMPT),
      configVersion: "batch-request-v1",
    };
    return { ...snapshot, configDigest: digest(JSON.stringify(snapshot)) };
  }

  async prepareBatchExtraction(source, batchItemId, runConfig = null) {
    if (!this.client.batchEnabledFor(runConfig)) throw Object.assign(new Error("Stored Vertex Batch extraction configuration is unavailable."), { code: "BATCH_CREDENTIALS_UNAVAILABLE", retryable: true });
    if ((source.assets || []).some((asset) => asset.kind === "video") || source.source_kind === "video_url") {
      throw new Error("Video segments remain on the realtime Vertex path.");
    }
    const images = await this.client.imageParts(source.assets || [], runConfig);
    const prepared = this.client.prepareBatchRequest({
      id: batchItemId,
      name: "source_research_extraction",
      schema: EXTRACTION_SCHEMA,
      instructions: SYSTEM_PROMPT,
      content: [{ type: "text", text: buildInput(source) }, ...images.parts],
    }, runConfig);
    const provider = runConfig?.provider || "vertex";
    const model = runConfig?.model || this.config.model;
    return { ...prepared, attemptedImages: images.attempted, suppliedImages: images.parts.length,
      inputManifest: extractionInputManifest({ source, provider, model, batch: true, images }) };
  }

  async prepareBatchCoverage({ segment, extraction, expectedModality = "text" }, batchItemId, runConfig = null) {
    if (!this.client.batchEnabledFor(runConfig)) throw Object.assign(new Error("Stored Vertex Batch coverage configuration is unavailable."), { code: "BATCH_CREDENTIALS_UNAVAILABLE", retryable: true });
    if (expectedModality !== "text") throw new Error("Only text coverage audits use Vertex Batch.");
    return this.client.prepareBatchRequest({
      id: batchItemId,
      name: "segment_claim_coverage_audit",
      schema: COVERAGE_AUDIT_SCHEMA,
      instructions: COVERAGE_AUDIT_PROMPT,
      content: [{ type: "text", text: buildCoverageInput(segment, extraction) }],
    }, runConfig);
  }

  createExtractionBatch(requests, options = {}) { return this.client.createBatch(requests, options, options.runConfig); }
  getExtractionBatch(name, runConfig) { return this.client.getBatch(name, runConfig); }
  readExtractionBatch(batch) { return this.client.readBatchOutput(batch, batch); }
  cleanupExtractionBatch(batch) { return this.client.cleanupBatch(batch, batch); }

  parseBatchExtraction(item, { inputManifest = null, runConfig = null, telemetryContext = null } = {}) {
    const context = telemetryContext || { runId: runConfig?.id || null, entityId: item?.jobId || item?.job_id || null };
    if (item?.error) {
      this.recordBatchAttempt("source_research_extraction", item, runConfig, context, "failed", item.code || "VERTEX_BATCH_ITEM_FAILED");
      throw Object.assign(new Error(item.error), { retryable: true, code: item.code || "VERTEX_BATCH_ITEM_FAILED" });
    }
    const errors = validateJsonSchema(item?.output, EXTRACTION_SCHEMA);
    if (errors.length) {
      this.recordBatchAttempt("source_research_extraction", item, runConfig, context, "failed", "INVALID_MODEL_OUTPUT", "schema_validation");
      throw Object.assign(new Error(`Vertex Batch returned invalid extraction JSON: ${JSON.stringify(errors.slice(0, 10))}`),
        { retryable: true, code: "INVALID_MODEL_OUTPUT" });
    }
    this.recordBatchAttempt("source_research_extraction", item, runConfig, context, "succeeded");
    return { result: sanitizeResult(item.output), method: "vertex_batch", model: runConfig?.model || this.config.model,
      inputManifest: inputManifest || item?.inputManifest || null };
  }

  parseBatchCoverage(item, { runConfig = null, telemetryContext = null } = {}) {
    const context = telemetryContext || { runId: runConfig?.id || null, entityId: item?.jobId || item?.job_id || null };
    if (item?.error) {
      this.recordBatchAttempt("segment_claim_coverage_audit", item, runConfig, context, "failed", item.code || "VERTEX_BATCH_ITEM_FAILED");
      throw Object.assign(new Error(item.error), { retryable: true, code: item.code || "VERTEX_BATCH_ITEM_FAILED" });
    }
    const errors = validateJsonSchema(item?.output, COVERAGE_AUDIT_SCHEMA);
    if (errors.length) {
      this.recordBatchAttempt("segment_claim_coverage_audit", item, runConfig, context, "failed", "INVALID_MODEL_OUTPUT", "schema_validation");
      throw Object.assign(new Error(`Vertex Batch returned invalid coverage-audit JSON: ${JSON.stringify(errors.slice(0, 10))}`),
        { retryable: true, code: "INVALID_MODEL_OUTPUT" });
    }
    this.recordBatchAttempt("segment_claim_coverage_audit", item, runConfig, context, "succeeded");
    return { output: { ...sanitizeCoverageAudit(item.output), modality: {
      expected: "text", received: "text", attempted: 0,
    } }, model: runConfig?.model || this.config.model };
  }

  recordBatchAttempt(stage, item, runConfig, context, status, errorCode = null, retryReason = null) {
    const policy = resolveStagePolicy(stage, { ...this.config, ...runConfig });
    const usage = item?.usage || {};
    try {
      this.config.onModelCall?.({ stage, provider: runConfig?.provider || "vertex", model: runConfig?.model || this.config.model,
        inputTokens: usage.promptTokenCount ?? null, outputTokens: usage.candidatesTokenCount ?? null,
        cachedTokens: usage.cachedContentTokenCount ?? null, thinkingTokens: usage.thoughtsTokenCount ?? null,
        providerUsage: usage, latencyMs: null, attempts: 1, attemptNumber: 1, status,
        attemptStatus: status, requestKind: "batch_result", errorCode, retryReason,
        policyVersion: policy.version, configHash: policy.configHash,
        runId: context.runId, entityId: context.entityId,
        requestCompletedAt: new Date().toISOString() });
    } catch { /* telemetry must never fail batch ingestion */ }
  }

  async extract(source, { signal = null, telemetryContext = null } = {}) {
    if (!this.enabled) return { result: heuristicExtraction(source), method: "heuristic", model: null };
    const videoSource = source.source_kind === "video" || (source.source_kind === "video_url" && isYoutubeUrl(source.submitted_url));
    if (videoSource && this.config.provider !== "vertex" && !source.submission_metadata?.operatorNotesProvided) {
      throw new Error("Video extraction requires a Vertex Gemini model with video input, or an operator-supplied transcript in the source notes.");
    }
    const assets = source.assets || [];
    const imageAssets = assets.filter((asset) => asset.kind !== "video");
    const videoAssets = assets.filter((asset) => asset.kind === "video");
    const imageBatchSize = Math.max(1, Number(this.config.imageBatchSize || this.config.maxImages || 32));
    const batches = [];
    for (let index = 0; index < imageAssets.length; index += imageBatchSize) {
      batches.push({ images: imageAssets.slice(index, index + imageBatchSize), videos: [] });
    }
    for (const video of videoAssets) batches.push({ images: [], videos: [video] });
    if (!batches.length) batches.push({ images: [], videos: [] });

    const outputs = [];
    const methods = new Set();
    const inputManifests = [];
    let model = null;
    for (const batch of batches) {
      const images = await this.client.imageParts(batch.images);
      const videos = await prepareVideoParts({ ...source, assets: batch.videos }, this.config.provider, this.client);
      let completion;
      try {
        completion = await this.client.completeJson({
          name: "source_research_extraction",
          schema: EXTRACTION_SCHEMA,
          instructions: SYSTEM_PROMPT,
          content: [{ type: "text", text: buildInput(source) }, ...videos.parts, ...images.parts],
          signal, telemetryContext,
        });
      } finally {
        await videos.cleanup();
      }
      const result = sanitizeResult(completion.output);
      if (images.attempted > images.parts.length) result.source.warnings.push("Some captured image assets were unavailable to the vision model; completeness remains blocked until they are processed.");
      if (batch.videos.length && videos.parts.length < batch.videos.length) result.source.warnings.push("One or more captured videos were unavailable to the selected model; completeness remains blocked until they are processed.");
      outputs.push(result);
      inputManifests.push(extractionInputManifest({ source: { ...source, assets: [...batch.images, ...batch.videos] },
        provider: this.config.provider || "kimi", model: completion.model || this.config.model, batch: false, images, videos }));
      methods.add(videos.parts.length ? "video" : images.parts.length ? "multimodal" : "text");
      model ||= completion.model;
    }
    return { result: mergeExtractionResults(outputs), method: `${this.config.provider || "kimi"}_${[...methods].join("+")}`, model,
      inputManifest: mergeInputManifests(inputManifests) };
  }

  async analyzeBlueprint(source, { signal = null, telemetryContext = null } = {}) {
    if (!this.enabled) return { output: heuristicExtraction(source).blueprint, model: null };
    const completion = await this.client.completeJson({
      name: "source_editorial_blueprint",
      schema: BLUEPRINT_SCHEMA,
      instructions: BLUEPRINT_PROMPT,
      content: [{ type: "text", text: buildInput(source) }],
      signal, telemetryContext,
    });
    return { output: sanitizeBlueprint(completion.output), model: completion.model };
  }

  async auditCoverage({ segment, extraction, source, expectedModality = "text" }, { signal = null, telemetryContext = null } = {}) {
    if (!this.enabled) return { output: { uncovered_spans: [] }, model: null };
    const images = expectedModality === "image" ? await this.client.imageParts(source?.assets || []) : { parts: [], attempted: 0 };
    const videos = expectedModality === "video" ? await prepareVideoParts(source, this.config.provider, this.client)
      : { parts: [], attempted: 0, cleanup: async () => {} };
    try {
      const completion = await this.client.completeJson({
        name: "segment_claim_coverage_audit",
        schema: COVERAGE_AUDIT_SCHEMA,
        instructions: COVERAGE_AUDIT_PROMPT,
        content: [{ type: "text", text: buildCoverageInput(segment, extraction) }, ...videos.parts, ...images.parts],
        signal, telemetryContext,
      });
      return {
        output: { ...sanitizeCoverageAudit(completion.output), modality: {
          expected: expectedModality,
          received: videos.parts.length ? "video" : images.parts.length ? "image" : "text",
          attempted: videos.attempted || images.attempted || 0,
        } },
        model: completion.model,
      };
    } finally {
      await videos.cleanup();
    }
  }
}

async function prepareVideoParts(source, provider, client) {
  const empty = { parts: [], attempted: 0, manifest: [], cleanup: async () => {} };
  if (provider !== "vertex") return empty;
  if ((source?.assets || []).some((asset) => asset?.kind === "video")) return client.videoParts(source.assets || []);
  if (source?.source_kind !== "video_url" || !isYoutubeUrl(source.submitted_url)) return empty;
  try {
    const url = new URL(source.submitted_url || "");
    return { parts: [{ fileData: { fileUri: url.toString(), mimeType: "video/mp4" } }], attempted: 1,
      manifest: [{ assetId: null, hash: null, kind: "video", status: "submitted", requestReference: "public_url",
        failureCode: null, failureReason: null }], cleanup: async () => {} };
  } catch {
    return empty;
  }
}

function extractionInputManifest({ source, provider, model, batch, images = {}, videos = {} }) {
  const assets = [...(images.manifest || []), ...(videos.manifest || [])];
  const expectedKinds = new Set((source?.assets || []).map((asset) => asset?.kind === "video" ? "video" : "image"));
  if (source?.source_kind === "video_url") expectedKinds.add("video");
  const submittedKinds = new Set(assets.filter((asset) => asset.status === "submitted").map((asset) => asset.kind));
  return {
    version: 1,
    expectedModality: manifestModality(expectedKinds),
    receivedModality: manifestModality(submittedKinds),
    provider,
    model,
    capabilities: { text: true, image: true, video: provider === "vertex", batch: Boolean(batch) },
    assets,
  };
}

function mergeInputManifests(manifests) {
  const values = (manifests || []).filter((item) => item?.version);
  if (!values.length) return null;
  const expected = new Set(values.map((item) => item.expectedModality).filter((item) => item !== "text"));
  const received = new Set(values.map((item) => item.receivedModality).filter((item) => item !== "text"));
  return {
    ...values[0],
    expectedModality: manifestModality(expected),
    receivedModality: manifestModality(received),
    assets: values.flatMap((item) => item.assets || []),
  };
}

function manifestModality(kinds) {
  const values = new Set();
  for (const item of kinds) {
    if (item === "mixed") { values.add("image"); values.add("video"); }
    else if (item === "image" || item === "video") values.add(item);
  }
  if (values.size > 1) return "mixed";
  return values.values().next().value || "text";
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function mergeExtractionResults(results) {
  const source = results.map((item) => item.source).filter(Boolean)
    .sort((left, right) => Number(right.confidence || 0) - Number(left.confidence || 0))[0]
    || heuristicExtraction({ raw_text: "", title: "", assets: [] }).source;
  source.warnings = [...new Set(results.flatMap((item) => item.source?.warnings || []))];
  const claims = [];
  const seen = new Set();
  for (const claim of results.flatMap((item) => item.claims || [])) {
    const key = [claim.key, claim.subject, claim.predicate, claim.value, claim.source_quote].join("\u0000").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    claims.push(claim);
  }
  return { source, claims, blueprint: emptyBlueprint() };
}

function isYoutubeUrl(value) {
  try {
    const url = new URL(value || "");
    const host = url.hostname.toLowerCase();
    const segments = url.pathname.split("/").filter(Boolean);
    if (host === "youtu.be") return Boolean(segments[0]);
    if (!(host === "youtube.com" || host.endsWith(".youtube.com"))) return false;
    return Boolean(url.searchParams.get("v") || (["shorts", "live", "embed"].includes(segments[0]) && segments[1]));
  } catch {
    return false;
  }
}

const SYSTEM_PROMPT = `You extract research evidence from a manually selected Chinese travel source for an English China travel site. The source may be a UGC note, public web article, document, image set, or video-page transcript.

Rules:
- The source is evidence, not established truth. Record factual assertions as claims and never silently resolve conflicts.
- Do not summarize. Do not select representative facts. Extract every independently useful travel proposition explicitly supported by this segment. Split compound statements into atomic claims. Continue until no material supported travel fact remains uncovered.
- Preserve important qualifiers: date, season, time of day, traveler type, booking channel, and uncertainty.
- When the source explicitly states an observation date or validity window, use ISO 8601 in observed_at/valid_from/valid_to and set date_confidence. Omit these fields when the date is unknown; never use the capture date as an observation date.
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
- Treat supplied images as part of the source, but do not infer details that are not visible.
- When multiple images are supplied, use the exact assetId and segmentId from the input manifest on every image-derived Claim. Never assign one image's evidence to another image.`;

const BLUEPRINT_PROMPT = `Analyze only the editorial presentation pattern of this manually selected source.
- Return format, hook, angle, section organization, strengths, and gaps.
- This is an optional structural reference for a future planner, not factual evidence.
- Do not extract or restate factual Claims.
- Do not decide Knowledge, truth, consensus, readiness, or preferred values.
- Do not copy source wording or recommend mechanically reproducing its structure.`;

const COVERAGE_AUDIT_PROMPT = `Independently audit whether the extracted atomic Claims cover all materially useful travel evidence in the original source segment.
- Compare the original segment against the supplied Claims; do not trust the extraction's completeness.
- Return only source spans that contain an independently useful proposition not already represented by a Claim.
- Use the shortest exact source quote that identifies the gap.
- Mark booking rules, operating times, prices, access, route steps, safety, restrictions, traveler constraints, and time-sensitive facts as material or important.
- Do not flag hooks, repetition, transitions, author biography, promotional language, or purely stylistic wording.
- Do not invent facts, rewrite Claims, resolve conflicts, or perform editorial planning.
- Return an empty uncovered_spans array when all material evidence is covered.`;

function buildInput(source) {
  const mediaManifest=(source.assets || []).map((asset)=>({assetId:asset.id,segmentId:asset.segment_id || source.submission_metadata?.asset_segment_ids?.[asset.id] || null,
    kind:asset.kind,position:asset.position,altText:asset.alt_text || asset.alt || "",nearbyText:asset.nearby_text || ""}));
  return [`URL: ${source.submitted_url || source.canonical_url}`, `Source type: ${source.source_kind || source.adapter}`, `Title: ${source.title}`, `Author: ${source.author_name}`, `Published: ${source.published_at || "unknown"}`, `MEDIA MANIFEST: ${JSON.stringify(mediaManifest)}`, "", "SOURCE TEXT:", String(source.raw_text || "")].join("\n");
}

function buildCoverageInput(segment, extraction) {
  const claims = (extraction?.claims || []).map((claim, index) => ({ index: index + 1, subject: claim.subject, predicate: claim.predicate,
    value: claim.value, qualifiers: claim.qualifiers || [], source_quote: claim.source_quote }));
  return ["ORIGINAL SOURCE SEGMENT:", String(segment?.raw_text || ""), "", "EXTRACTED CLAIMS:", JSON.stringify(claims)].join("\n");
}

function sanitizeResult(result) {
  result.source.destination_slug = slugify(result.source.destination_slug);
  result.source.summary = truncate(result.source.summary, 5_000);
  result.source.warnings = Array.isArray(result.source.warnings) ? result.source.warnings.slice(0, 50) : [];
  result.claims = result.claims.map((claim) => ({ ...claim, key: truncate(claim.key.toLowerCase().replace(/[^a-z0-9._]+/g, ".").replace(/^\.|\.$/g, ""), 300), source_quote: truncate(claim.source_quote, 800) })).filter((claim) => claim.key && claim.value);
  result.blueprint = emptyBlueprint();
  return result;
}

function sanitizeBlueprint(value) {
  return {
    format: truncate(value?.format || "unclassified", 200), hook: truncate(value?.hook || "", 500), angle: truncate(value?.angle || "", 500),
    sections: (value?.sections || []).slice(0, 40).map((item) => ({ heading: truncate(item?.heading || "", 300), purpose: truncate(item?.purpose || "", 500) })),
    strengths: (value?.strengths || []).slice(0, 30).map((item) => truncate(item, 500)), gaps: (value?.gaps || []).slice(0, 30).map((item) => truncate(item, 500)),
  };
}

function sanitizeCoverageAudit(value) {
  return { uncovered_spans: (value?.uncovered_spans || []).slice(0, 100).map((item) => ({
    quote: truncate(item?.quote || "", 800), importance: ["material", "important", "minor"].includes(item?.importance) ? item.importance : "material",
    reason: truncate(item?.reason || "Material travel evidence is not covered by a Claim.", 1_000),
  })).filter((item) => item.quote) };
}

function emptyBlueprint() { return { format: "pending-separate-analysis", hook: "", angle: "", sections: [], strengths: [], gaps: [] }; }

export function heuristicExtraction(source) {
  const text = source.raw_text.replace(/\s+/g, " ").trim();
  const destination = inferDestination(`${source.title} ${text}`);
  return { source: { language: /[\u4e00-\u9fff]/.test(text) ? "zh-CN" : "unknown", summary: truncate(text, 500), destination_name: destination.name, destination_slug: destination.slug, traveler_fit: [], practical_tips: [], warnings: ["Kimi enrichment is not configured; claims and image text have not been extracted."], confidence: 0.2 }, claims: [], blueprint: { format: "unclassified", hook: truncate(source.title, 300), angle: "pending-ai-analysis", sections: [], strengths: [], gaps: ["Requires multimodal AI extraction"] } };
}

function inferDestination(text) {
  const known = [["beijing", "Beijing", /北京|beijing/i], ["shanghai", "Shanghai", /上海|shanghai/i], ["xian", "Xi'an", /西安|xi['’]?an/i], ["chengdu", "Chengdu", /成都|chengdu/i], ["chongqing", "Chongqing", /重庆|chongqing/i], ["hangzhou", "Hangzhou", /杭州|hangzhou/i], ["suzhou", "Suzhou", /苏州|suzhou/i], ["guilin", "Guilin", /桂林|guilin/i], ["guangzhou", "Guangzhou", /广州|guangzhou/i], ["shenzhen", "Shenzhen", /深圳|shenzhen/i], ["yunnan", "Yunnan", /云南|yunnan/i], ["zhangjiajie", "Zhangjiajie", /张家界|zhangjiajie/i]];
  const match = known.find(([, , pattern]) => pattern.test(text));
  return match ? { slug: match[0], name: match[1] } : { slug: "unknown", name: "Unknown" };
}
