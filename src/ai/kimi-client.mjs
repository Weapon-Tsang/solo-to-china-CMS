import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { validateJsonSchema } from "../frontend-contract.mjs";
import { ProviderRequestError } from "./provider-schema.mjs";

const IMAGE_HOST_SUFFIXES = ["xiaohongshu.com", "xhscdn.com", "xhscdn.net", "xhscdn.cn"];
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

export class KimiClient {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  get enabled() {
    return Boolean(this.config.apiKey);
  }

  async completeJson({ name, schema, instructions, content, timeoutMs = this.config.requestTimeoutMs || 360_000 }) {
    if (!this.enabled) throw new Error("KIMI_API_KEY is required for AI processing.");
    const startedAt = Date.now();
    const identity = modelCallIdentity(name, schema, instructions, content);
    const messages = [
      { role: "system", content: instructions },
      { role: "user", content },
    ];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.config.beforeRequest?.({ provider: "kimi", model: this.config.model, stage: name, attempt: attempt + 1 });
      const response = await this.fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.config.model,
        stream: false,
        max_completion_tokens: this.config.maxCompletionTokens,
        messages,
        response_format: {
          type: "json_schema",
          json_schema: { name, strict: true, schema },
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
      });
      const payload = await jsonPayload(response);
      if (!response.ok) {
        this.emitModelCall({ ...identity, provider: "kimi", model: this.config.model, latencyMs: Date.now() - startedAt,
          attempts: attempt + 1, status: "failed", errorCode: String(payload?.error?.code || response.status) });
        throw new ProviderRequestError("Kimi", response.status, payload?.error?.message || response.statusText,
          { ...(payload?.error || {}), retryAfter: response.headers.get("retry-after") });
      }
      const choice = payload?.choices?.[0];
      if (choice?.finish_reason === "length") throw Object.assign(new Error("Kimi response reached its output limit; increase KIMI_MAX_COMPLETION_TOKENS."), { code: "MODEL_OUTPUT_LIMIT", retryable: true });
      const output = choice?.message?.content;
      if (typeof output !== "string" || !output.trim()) throw Object.assign(new Error("Kimi returned no structured output."), { code: "EMPTY_MODEL_OUTPUT", retryable: true });
      let parsed;
      try { parsed = JSON.parse(output); } catch { parsed = null; }
      const errors = parsed == null ? [{ path: "$", message: "invalid JSON" }] : validateJsonSchema(parsed, schema);
      if (parsed != null && errors.length === 0) {
        this.emitModelCall({ ...identity, provider: "kimi", model: payload.model || this.config.model,
          inputTokens: payload.usage?.prompt_tokens ?? null, outputTokens: payload.usage?.completion_tokens ?? null,
          cachedTokens: payload.usage?.prompt_tokens_details?.cached_tokens ?? null,
          latencyMs: Date.now() - startedAt, attempts: attempt + 1, status: "succeeded" });
        return { output: parsed, model: payload.model || this.config.model, usage: payload.usage || null };
      }
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
    if (!/^image\/(?:jpeg|jpg|png|webp|gif)$/.test(contentType)) throw new Error("Uploaded source asset is not a supported image.");
    const bytes = await fs.readFile(filename);
    if (!bytes.length) throw new Error("Uploaded source image is empty.");
    if (bytes.length > MAX_IMAGE_BYTES) throw Object.assign(new Error("Uploaded source image exceeds the provider inline limit and needs a derived vision copy; the original remains stored."), { code: "AI_DERIVATIVE_REQUIRED", retryable: false });
    return `data:${contentType};base64,${bytes.toString("base64")}`;
  }
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
