import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ProviderRequestError } from "../ai/provider-schema.mjs";

const METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

export class VertexImagen {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  get enabled() {
    return this.config.enabled && ["vertex_imagen", "vertex_gemini"].includes(this.config.provider) && Boolean(this.config.projectId && this.config.publicBaseUrl);
  }

  async generate(visual, draft, options = {}) {
    if (!this.enabled) throw new Error("Visual generation is not configured.");
    if (visual.image_type !== "illustration" || visual.acquisition_strategy !== "generate_illustration" || visual.factual_image_required) {
      throw new Error("The visual generator may generate only non-factual illustrations, never real-world photos, maps, or infographics.");
    }
    if (this.config.provider === "vertex_gemini") return this.generateGeminiImage(visual, draft, options);
    if (this.config.provider === "vertex_imagen") return this.generateImagenImage(visual, draft, options);
    throw new Error("The selected visual provider cannot generate image files.");
  }

  async localizeSourceImage(visual, draft, options = {}) {
    if (!this.enabled || this.config.provider !== "vertex_gemini") {
      throw Object.assign(new Error("中文图片翻译需要已配置的 Vertex Gemini 图片模型。"), { retryable: false, code: "IMAGE_LOCALIZATION_NOT_CONFIGURED" });
    }
    if (visual.image_type !== "real_world_photo" || visual.acquisition_strategy !== "localize_source_image"
        || !visual.source_asset_id) {
      throw Object.assign(new Error("图片翻译只接受已授权并已保存的实景原图。"), { retryable: false, code: "INVALID_IMAGE_LOCALIZATION_SOURCE" });
    }
    const source = readSourceImage(visual);
    const accessToken = await this.accessToken();
    const location = this.config.location || "global";
    const host = location === "global" ? "https://aiplatform.googleapis.com" : `https://${location}-aiplatform.googleapis.com`;
    const endpoint = `${host}/v1/projects/${encodeURIComponent(this.config.projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(this.config.model)}:generateContent`;
    const prompt = `Translate only clearly readable Chinese text in this authorized source photo into concise English for international travelers.
Preserve the photographed reality exactly: do not alter the scene, people, objects, buildings, food, route geometry, crop, perspective, lighting, colors, logos, or non-Chinese labels. Do not invent, remove, beautify, or reconstruct any object. Keep uncertain or unreadable text unchanged. Return the edited image.`;
    await this.config.beforeRequest?.({ provider: "vertex_gemini", model: this.config.model, stage: "localize_source_image", attempt: 1 });
    const response = await this.fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        contents: { role: "USER", parts: [{ text: prompt }, { inlineData: { mimeType: source.mimeType, data: source.base64 } }] },
        generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: visual.aspect_ratio } },
      }),
      signal: combinedSignal(options.signal, this.config.requestTimeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new ProviderRequestError("Vertex Gemini 图片翻译", response.status, payload?.error?.message || response.statusText,
      { ...(payload?.error || {}), retryAfter: response.headers.get("retry-after") });
    const part = payload?.candidates?.flatMap((candidate) => candidate?.content?.parts || []).find((item) => item?.inlineData?.data);
    if (!part) throw new Error("图片模型没有返回可用的翻译图片。");
    return this.storeImage({ base64: part.inlineData.data, mimeType: part.inlineData.mimeType, visual, draft,
      provider: "vertex_gemini", model: this.config.model });
  }

  async generateImagenImage(visual, draft, options = {}) {
    const accessToken = await this.accessToken();
    const endpoint = `https://${this.config.location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(this.config.projectId)}/locations/${encodeURIComponent(this.config.location)}/publishers/google/models/${encodeURIComponent(this.config.model)}:predict`;
    await this.config.beforeRequest?.({ provider: "vertex_imagen", model: this.config.model, stage: "generate_visual", attempt: 1 });
    const response = await this.fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        instances: [{ prompt: visual.generation_prompt }],
        parameters: {
          sampleCount: 1,
          aspectRatio: visual.aspect_ratio,
          sampleImageSize: visual.image_role === "hero" ? this.config.coverQuality : this.config.inlineQuality,
          addWatermark: true,
          personGeneration: "dont_allow",
          safetyFilterLevel: "block_medium_and_above",
        },
      }),
      signal: combinedSignal(options.signal, this.config.requestTimeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new ProviderRequestError("Vertex Imagen", response.status, payload?.error?.message || response.statusText,
      { ...(payload?.error || {}), retryAfter: response.headers.get("retry-after") });
    const prediction = payload?.predictions?.find((item) => item?.bytesBase64Encoded);
    if (!prediction) throw new Error("Vertex Imagen returned no renderable image bytes.");
    return this.storeImage({
      base64: prediction.bytesBase64Encoded,
      mimeType: prediction.mimeType,
      visual,
      draft,
      provider: "vertex_imagen",
      model: this.config.model,
    });
  }

  async generateGeminiImage(visual, draft, options = {}) {
    const accessToken = await this.accessToken();
    const location = this.config.location || "global";
    const host = location === "global" ? "https://aiplatform.googleapis.com" : `https://${location}-aiplatform.googleapis.com`;
    const endpoint = `${host}/v1/projects/${encodeURIComponent(this.config.projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(this.config.model)}:generateContent`;
    const prompt = `${visual.generation_prompt}\n\nCreate an original editorial illustration only. Do not depict people, logos, watermarks, readable text, or a documentary-style real place.`;
    await this.config.beforeRequest?.({ provider: "vertex_gemini", model: this.config.model, stage: "generate_visual", attempt: 1 });
    const response = await this.fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        contents: { role: "USER", parts: [{ text: prompt }] },
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: { aspectRatio: visual.aspect_ratio },
        },
        safetySettings: [{
          method: "PROBABILITY",
          category: "HARM_CATEGORY_DANGEROUS_CONTENT",
          threshold: "BLOCK_MEDIUM_AND_ABOVE",
        }],
      }),
      signal: combinedSignal(options.signal, this.config.requestTimeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new ProviderRequestError("Gemini 3.1 Flash Image", response.status, payload?.error?.message || response.statusText,
      { ...(payload?.error || {}), retryAfter: response.headers.get("retry-after") });
    const part = payload?.candidates?.flatMap((candidate) => candidate?.content?.parts || []).find((item) => item?.inlineData?.data);
    if (!part) throw new Error("Gemini 3.1 Flash Image returned no renderable image bytes.");
    return this.storeImage({
      base64: part.inlineData.data,
      mimeType: part.inlineData.mimeType,
      visual,
      draft,
      provider: "vertex_gemini",
      model: this.config.model,
    });
  }

  storeImage({ base64, mimeType: suppliedMimeType, visual, draft, provider, model }) {
    const mimeType = normalizeMime(suppliedMimeType);
    const extension = mimeType === "image/jpeg" ? "jpg" : "png";
    const checksum = crypto.createHash("sha256").update(`${draft.id}:${visual.id}:${visual.generation_prompt}`).digest("hex").slice(0, 18);
    const filename = `${draft.id}-${String(visual.slot).padStart(2, "0")}-${checksum}.${extension}`;
    fs.mkdirSync(this.config.mediaDir, { recursive: true });
    const mediaPath = path.join(this.config.mediaDir, filename);
    fs.writeFileSync(mediaPath, Buffer.from(base64, "base64"), { mode: 0o640 });
    return {
      mediaPath,
      mediaUrl: `${this.config.publicBaseUrl}/media/${filename}`,
      provider,
      model,
      mimeType,
    };
  }

  async accessToken() {
    if (this.config.accessToken) return this.config.accessToken;
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const response = await this.fetch(METADATA_TOKEN_URL, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(5_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) throw new Error("Vertex Imagen could not obtain a Google Compute Engine service-account token.");
    this.token = payload.access_token;
    this.tokenExpiresAt = Date.now() + Math.max(60, Number(payload.expires_in || 300) - 60) * 1_000;
    return this.token;
  }
}

function combinedSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function normalizeMime(value) {
  return ["image/png", "image/jpeg"].includes(value) ? value : "image/png";
}

function readSourceImage(visual) {
  if (visual.source_asset_local_path) {
    const bytes = fs.readFileSync(visual.source_asset_local_path);
    if (!bytes.length) throw Object.assign(new Error("已保存的原图为空，无法翻译。"), { retryable: false });
    return { base64: bytes.toString("base64"), mimeType: normalizeSourceMime(visual.source_asset_mime_type, bytes) };
  }
  const match = String(visual.source_asset_data_url || "").match(/^data:(image\/(?:png|jpeg));base64,(.+)$/is);
  if (match) return { mimeType: match[1].toLowerCase(), base64: match[2] };
  throw Object.assign(new Error("没有找到已保存的原图文件，无法翻译。"), { retryable: false, code: "SOURCE_IMAGE_BYTES_MISSING" });
}

function normalizeSourceMime(supplied, bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (["image/png", "image/jpeg"].includes(supplied)) return supplied;
  throw Object.assign(new Error("原图格式不受图片翻译模型支持。"), { retryable: false, code: "SOURCE_IMAGE_FORMAT_UNSUPPORTED" });
}
