import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { validateJsonSchema } from "../frontend-contract.mjs";
import { ProviderRequestError, providerTransportError } from "./provider-schema.mjs";
import { resolveStagePolicy } from "./stage-policy.mjs";

const IMAGE_HOST_SUFFIXES = ["xiaohongshu.com", "xhscdn.com", "xhscdn.net", "xhscdn.cn"];
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;

export class KimiClient {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  get enabled() {
    return Boolean(this.config.apiKey);
  }

  async completeJson({ name, schema, instructions, content, timeoutMs = null, signal = null, telemetryContext = null }) {
    if (!this.enabled) throw new Error("KIMI_API_KEY is required for AI processing.");
    const policy = resolveStagePolicy(name, this.config);
    const effectiveTimeoutMs = timeoutMs || policy.timeoutMs;
    const identity = modelCallIdentity(name, schema, instructions, content);
    const messages = [
      { role: "system", content: instructions },
      { role: "user", content },
    ];
    telemetryContext = { ...(telemetryContext || {}), stageStartedAt: Date.now(), retryWaitMs: 0 };
    for (let attempt = 0; attempt < policy.maxAttempts; attempt += 1) {
      const requestGateStartedAt = Date.now();
      await this.config.beforeRequest?.({ provider: "kimi", model: this.config.model, stage: name, attempt: attempt + 1 });
      const attemptStartedAt = Date.now();
      telemetryContext.retryWaitMs = Math.max(0, attemptStartedAt - requestGateStartedAt);
      const requestStartedAt = new Date(attemptStartedAt).toISOString();
      let response;
      try {
        response = await this.fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.config.model,
        // Long K3 reasoning requests can exceed the provider's documented
        // non-streaming five-minute response window. SSE returns headers and
        // progress while preserving the same final structured JSON contract.
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: policy.maxOutputTokens,
        messages,
        response_format: {
          type: "json_schema",
          json_schema: { name, strict: true, schema },
        },
      }),
      signal: combinedSignal(signal, effectiveTimeoutMs),
        });
      } catch (error) {
        const requestError = signal?.aborted ? error : providerTransportError("kimi", error);
        this.emitModelCall(attemptMetric({ identity, policy, telemetryContext, attempt, attemptStartedAt, requestStartedAt,
          status: signal?.aborted ? "cancelled" : "failed",
          errorCode: requestError?.code || requestError?.name || "REQUEST_FAILED", retryReason: attempt ? "request_retry" : null }));
        throw requestError;
      }
      if (!response.ok) {
        const payload = await jsonPayload(response);
        this.emitModelCall(attemptMetric({ identity, policy, telemetryContext, attempt, attemptStartedAt, requestStartedAt,
          status: "failed", errorCode: String(payload?.error?.code || response.status), retryReason: attempt ? "provider_retry" : null,
          usage: payload?.usage }));
        throw new ProviderRequestError("Kimi", response.status, payload?.error?.message || response.statusText,
          { ...(payload?.error || {}), retryAfter: response.headers.get("retry-after") });
      }
      const payload = /text\/event-stream/i.test(String(response.headers.get("content-type") || ""))
        ? await kimiStreamPayload(response) : await jsonPayload(response);
      const choice = payload?.choices?.[0];
      if (choice?.finish_reason === "length") {
        this.emitModelCall(attemptMetric({ identity, policy, telemetryContext, attempt, attemptStartedAt, requestStartedAt,
          status: "failed", errorCode: "MODEL_OUTPUT_LIMIT", retryReason: attempt ? "structured_repair" : null, usage: payload?.usage }));
        throw Object.assign(new Error("Kimi response reached its output limit; increase KIMI_MAX_COMPLETION_TOKENS."), { code: "MODEL_OUTPUT_LIMIT", retryable: true });
      }
      const output = choice?.message?.content;
      if (typeof output !== "string" || !output.trim()) {
        this.emitModelCall(attemptMetric({ identity, policy, telemetryContext, attempt, attemptStartedAt, requestStartedAt,
          status: "failed", errorCode: "EMPTY_MODEL_OUTPUT", retryReason: attempt ? "structured_repair" : null, usage: payload?.usage }));
        throw Object.assign(new Error("Kimi returned no structured output."), { code: "EMPTY_MODEL_OUTPUT", retryable: true });
      }
      let parsed;
      try { parsed = JSON.parse(output); } catch { parsed = null; }
      const errors = parsed == null ? [{ path: "$", message: "invalid JSON" }] : validateJsonSchema(parsed, schema);
      if (parsed != null && errors.length === 0) {
        this.emitModelCall(attemptMetric({ identity, policy, telemetryContext, attempt, attemptStartedAt, requestStartedAt,
          status: "succeeded", usage: payload?.usage, model: payload.model || this.config.model,
          retryReason: attempt ? "structured_repair" : null }));
        return { output: parsed, model: payload.model || this.config.model, usage: payload.usage || null };
      }
      this.emitModelCall(attemptMetric({ identity, policy, telemetryContext, attempt, attemptStartedAt, requestStartedAt,
        status: "failed", errorCode: "INVALID_MODEL_OUTPUT", retryReason: attempt ? "structured_repair" : "invalid_json_or_schema",
        usage: payload?.usage }));
      messages.push({ role: "assistant", content: output }, { role: "user", content: `Correct the JSON and return the complete object only. Errors: ${JSON.stringify(errors.slice(0, 20))}` });
    }
    throw Object.assign(new Error("Kimi returned invalid structured output after repair."), { code: "INVALID_MODEL_OUTPUT", retryable: true });
  }

  emitModelCall(metric) {
    try { this.config.onModelCall?.(metric); } catch { /* telemetry must never fail production */ }
  }

  async imageParts(assets) {
    const attempted = assets || [];
    const results = await Promise.allSettled(attempted.map(async (asset) => ({
      part: { type: "image_url", image_url: { url: await this.imageDataUrl(asset) } },
      manifest: inputAssetManifest(asset, "image", "submitted", "inline_data"),
    })));
    const parts = results.flatMap((result) => result.status === "fulfilled" ? [result.value.part] : []);
    const manifest = results.map((result, index) => result.status === "fulfilled" ? result.value.manifest
      : inputAssetManifest(attempted[index], "image", "failed", null, result.reason));
    return { parts, attempted: attempted.length, manifest };
  }

  async videoParts(assets) {
    const attemptedAssets = (assets || []).filter((asset) => asset?.kind === "video");
    return { parts: [], attempted: attemptedAssets.length, cleanup: async () => {},
      manifest: attemptedAssets.map((asset) => inputAssetManifest(asset, "video", "failed", null,
        Object.assign(new Error("The selected provider does not support video input."), { code: "VIDEO_INPUT_UNSUPPORTED" }))) };
  }

  async imageDataUrl(asset) {
    if (asset?.ai_derivative_data_url || asset?.aiDerivativeDataUrl) {
      return asset.ai_derivative_data_url || asset.aiDerivativeDataUrl;
    }
    if (asset?.local_path) return this.localImageDataUrl(asset);
    const url = safeXiaohongshuImageUrl(asset?.remote_url);
    if (!url) throw new Error("Captured image URL is not an allowlisted Xiaohongshu HTTPS asset.");
    const response = await this.fetch(url, { signal: AbortSignal.timeout(this.config.imageTimeoutMs || 20_000) });
    if (!response.ok) throw new Error(`Image fetch failed (${response.status}).`);
    const contentType = String(response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (!/^image\/(?:jpeg|jpg|png|webp|gif)$/.test(contentType)) throw new Error("Captured asset is not a supported image.");
    const declaredBytes = Number.parseInt(response.headers.get("content-length") || "", 10);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_IMAGE_BYTES) {
      throw Object.assign(new Error("Captured image exceeds the provider inline limit and has no AI derivative."), { code: "AI_DERIVATIVE_REQUIRED", retryable: false });
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length) throw new Error("Captured image is empty.");
    if (bytes.length > MAX_IMAGE_BYTES) throw Object.assign(new Error("Captured image exceeds the provider inline limit and has no AI derivative."), { code: "AI_DERIVATIVE_REQUIRED", retryable: false });
    return `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
  }

  async localImageDataUrl(asset) {
    const uploadRoot = path.resolve(this.config.sourceUploadsDir || "data/source-uploads");
    const filename = path.resolve(String(asset.local_path || ""));
    if (!filename.startsWith(`${uploadRoot}${path.sep}`)) throw new Error("Uploaded source image is outside the configured source directory.");
    const contentType = String(asset.mime_type || "").toLowerCase();
    const pdfVisual = contentType === "application/pdf" && asset?.provenance?.documentKind === "pdf";
    if (pdfVisual && this.config.provider !== "vertex") {
      throw Object.assign(new Error("PDF visual evidence requires the Vertex multimodal provider."), { code: "PDF_VISUAL_INPUT_UNSUPPORTED", retryable: false });
    }
    if (!pdfVisual && !/^image\/(?:jpeg|jpg|png|webp|gif)$/.test(contentType)) throw new Error("Uploaded source asset is not a supported image.");
    const bytes = await fs.readFile(filename);
    if (!bytes.length) throw new Error("Uploaded source image is empty.");
    const byteLimit = pdfVisual ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
    if (bytes.length > byteLimit) throw Object.assign(new Error("Uploaded source asset exceeds the provider inline limit and needs a derived vision copy; the original remains stored."), { code: "AI_DERIVATIVE_REQUIRED", retryable: false });
    return `data:${contentType};base64,${bytes.toString("base64")}`;
  }
}

async function kimiStreamPayload(response) {
  if (!response.body) throw Object.assign(new Error("Kimi streaming response has no body."), {
    code:"EMPTY_MODEL_OUTPUT",provider:"kimi",retryable:true,
  });
  const reader=response.body.getReader();
  const decoder=new TextDecoder();
  let buffer="";
  let content="";
  let model="";
  let finishReason=null;
  let usage=null;
  const consume=(frame)=>{
    const data=String(frame || "").split(/\r?\n/).filter((line)=>line.startsWith("data:"))
      .map((line)=>line.slice(5).trimStart()).join("\n").trim();
    if (!data || data==="[DONE]") return;
    let chunk;
    try { chunk=JSON.parse(data); } catch {
      throw Object.assign(new Error("Kimi returned an invalid SSE data frame."), {
        code:"INVALID_MODEL_OUTPUT",provider:"kimi",retryable:true,
      });
    }
    if (chunk?.error) throw new ProviderRequestError("Kimi",Number(chunk.error.status || 500),chunk.error.message || "Streaming request failed.",chunk.error);
    model=chunk?.model || model;
    usage=chunk?.usage || usage;
    const choice=(chunk?.choices || [])[0];
    if (!choice) return;
    finishReason=choice.finish_reason || finishReason;
    const delta=choice.delta?.content ?? choice.message?.content;
    if (typeof delta==="string") content+=delta;
  };
  while (true) {
    const {done,value}=await reader.read();
    buffer+=decoder.decode(value || new Uint8Array(),{stream:!done});
    const frames=buffer.split(/\r?\n\r?\n/);
    buffer=frames.pop() || "";
    for (const frame of frames) consume(frame);
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  return {model,choices:[{finish_reason:finishReason,message:{content}}],usage};
}

function attemptMetric({ identity, policy, telemetryContext, attempt, attemptStartedAt, requestStartedAt, status, errorCode = null,
  retryReason = null, usage = null, model = null }) {
  return { ...identity, provider: "kimi", model: model || policy.model,
    role: telemetryContext?.role || "unknown", requestedModel: policy.model, returnedModel: model || null,
    inputTokens: usage?.prompt_tokens ?? null, outputTokens: usage?.completion_tokens ?? null,
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? null,
    thinkingTokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
    providerUsage: usage || null, latencyMs: Date.now() - attemptStartedAt, attempts: attempt + 1, attemptNumber: attempt + 1,
    status: status === "succeeded" ? "succeeded" : "failed", attemptStatus: status, errorCode, retryReason,
    requestKind: "provider", policyVersion: policy.version, configHash: policy.configHash,
    runId: telemetryContext?.runId || null, entityId: telemetryContext?.entityId || null,
    sourceRunId: telemetryContext?.sourceRunId || null, articleRevision: telemetryContext?.articleRevision ?? null,
    queueWaitMs:telemetryContext?.queueWaitMs??null,providerRequestMs:Date.now()-attemptStartedAt,
    retryWaitMs:telemetryContext?.retryWaitMs??0,
    totalStageMs:(telemetryContext?.queueWaitMs||0)+Math.max(0,Date.now()-(telemetryContext?.stageStartedAt||attemptStartedAt)),
    executionRoute:telemetryContext?.executionRoute||null,
    requestStartedAt, requestCompletedAt: new Date().toISOString(), costUsd: null, costStatus: "unknown" };
}

function combinedSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function modelCallIdentity(stage, schema, instructions, content) {
  const digest = (value) => crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
  return { stage: stage || "unknown", promptHash: digest(instructions || ""), schemaHash: digest(schema || {}), inputHash: digest(content || "") };
}

function safeXiaohongshuImageUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const approved = IMAGE_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
    return url.protocol === "https:" && approved ? url.toString() : null;
  } catch {
    return null;
  }
}

async function jsonPayload(response) {
  try { return await response.json(); } catch { return {}; }
}

function inputAssetManifest(asset, kind, status, requestReference, error = null) {
  return {
    assetId: asset?.id || null,
    hash: asset?.original_sha256 || asset?.originalSha256 || asset?.ai_derivative_sha256 || asset?.aiDerivativeSha256 || null,
    kind,
    status,
    requestReference,
    failureCode: error?.code ? String(error.code) : null,
    failureReason: error ? String(error?.message || error).slice(0, 1_000) : null,
  };
}
