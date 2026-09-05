import { slugify, truncate } from "../utils.mjs";
import { createAiClient } from "./client.mjs";

const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["source", "claims", "blueprint"],
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
    claims: { type: "array", items: { type: "object", additionalProperties: false, required: ["key", "subject", "predicate", "value", "qualifiers", "confidence", "source_quote"], properties: { key: { type: "string" }, subject: { type: "string" }, predicate: { type: "string" }, value: { type: "string" }, qualifiers: { type: "array", items: { type: "string" } }, confidence: { type: "number", minimum: 0, maximum: 1 }, source_quote: { type: "string" }, claim_role: { type: "string", enum: ["fact", "recommendation", "personal_experience", "promotional_observation", "editorial_metadata"] }, knowledge_eligible: { type: "boolean" } } } },
    blueprint: { type: "object", additionalProperties: false, required: ["format", "hook", "angle", "sections", "strengths", "gaps"], properties: { format: { type: "string" }, hook: { type: "string" }, angle: { type: "string" }, sections: { type: "array", items: { type: "object", additionalProperties: false, required: ["heading", "purpose"], properties: { heading: { type: "string" }, purpose: { type: "string" } } } }, strengths: { type: "array", items: { type: "string" } }, gaps: { type: "array", items: { type: "string" } } } },
  },
};

export class KimiExtractor {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.client = createAiClient(config, fetchImpl);
  }

  get enabled() {
    return this.client.enabled;
  }

  async extract(source) {
    if (!this.enabled) return { result: heuristicExtraction(source), method: "heuristic", model: null };
    if (source.source_kind === "video_url" && isYoutubeUrl(source.submitted_url) && this.config.provider !== "vertex" && !source.submission_metadata?.operatorNotesProvided) {
      throw new Error("YouTube video extraction requires a Vertex Gemini model with video input, or an operator-supplied transcript in the source notes.");
    }
    const images = await this.client.imageParts(source.assets);
    const videoParts = vertexVideoParts(source, this.config.provider);
    const completion = await this.client.completeJson({
      name: "source_research_extraction",
      schema: EXTRACTION_SCHEMA,
      instructions: SYSTEM_PROMPT,
      content: [{ type: "text", text: buildInput(source) }, ...videoParts, ...images.parts],
    });
    const result = sanitizeResult(completion.output);
    if (images.attempted > images.parts.length) result.source.warnings.push("Some captured image assets were unavailable to the vision model; verify image-only details against the raw source.");
    if (source.source_kind === "video_url" && videoParts.length === 0) result.source.warnings.push("The video frames and audio were not available to the selected model; extraction used only the public page text and operator-supplied transcript.");
    const mode = videoParts.length ? "video" : images.parts.length ? "multimodal" : "text";
    return { result, method: `${this.config.provider || "kimi"}_${mode}`, model: completion.model };
  }
}

function vertexVideoParts(source, provider) {
  if (provider !== "vertex" || source?.source_kind !== "video_url" || !isYoutubeUrl(source.submitted_url)) return [];
  try {
    const url = new URL(source.submitted_url || "");
    return [{ fileData: { fileUri: url.toString(), mimeType: "video/mp4" } }];
  } catch {
    return [];
  }
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

const SYSTEM_PROMPT = `You extract research evidence and editorial structure from a manually selected Chinese travel source for an English China travel site. The source may be a UGC note, public web article, document, image set, or video-page transcript.

Rules:
- The source is evidence, not established truth. Record factual assertions as claims and never silently resolve conflicts.
- Preserve important qualifiers: date, season, time of day, traveler type, booking channel, and uncertainty.
- Each claim must express exactly one atomic proposition. Split opening hours, transport, reservation, route difficulty, photo opportunities, and recommendations into separate claims even when they share one sentence.
- source_quote must be the shortest exact quote from the supplied note that supports only that atomic proposition.
- Put negation, quantities, exclusivity (only/except), and material conditions in the predicate, value, or qualifiers; never discard them as writing style.
- Use canonical snake_case predicates for hard facts. For reservation requirements use predicate "reservation_required" and value "true" or "false"; put advance days and booking channels in qualifiers.
- normalized claim keys must be stable lowercase dot-separated concepts, e.g. attraction.forbidden_city.entry_gate.
- Focus on details useful to independent international travelers, especially solo, first-time, and non-Chinese-speaking visitors.
- Separate content facts from editorial analysis. The blueprint describes why the source communicates well; it is not evidence.
- Do not turn advertising slogans, editorial disclaimers, or author metadata into destination knowledge claims. Keep personal experiences explicitly scoped to the author and never generalize them into universal destination facts.
- Set claim_role and knowledge_eligible for every claim. Editorial metadata and personal experience are retained as evidence but knowledge_eligible must be false; promotional observations are false unless they describe a durable, independently useful place feature.
- Do not add affiliate products, commercial calls to action, or facts absent from the source.
- destination_slug must be concise lowercase ASCII kebab-case. Use "unknown" if the destination cannot be inferred.
- Treat supplied images as part of the source, but do not infer details that are not visible.`;

function buildInput(source) {
  return [`URL: ${source.submitted_url || source.canonical_url}`, `Source type: ${source.source_kind || source.adapter}`, `Title: ${source.title}`, `Author: ${source.author_name}`, `Published: ${source.published_at || "unknown"}`, "", "SOURCE TEXT:", truncate(source.raw_text, 120_000)].join("\n");
}

function sanitizeResult(result) {
  result.source.destination_slug = slugify(result.source.destination_slug);
  result.source.summary = truncate(result.source.summary, 5_000);
  result.source.warnings = Array.isArray(result.source.warnings) ? result.source.warnings.slice(0, 50) : [];
  result.claims = result.claims.slice(0, 100).map((claim) => ({ ...claim, key: truncate(claim.key.toLowerCase().replace(/[^a-z0-9._]+/g, ".").replace(/^\.|\.$/g, ""), 300), source_quote: truncate(claim.source_quote, 800) })).filter((claim) => claim.key && claim.value);
  return result;
}

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
