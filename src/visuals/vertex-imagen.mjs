import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

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

  async generate(visual, draft) {
    if (!this.enabled) throw new Error("Visual generation is not configured.");
    if (visual.image_type !== "illustration" || visual.acquisition_strategy !== "generate_illustration" || visual.factual_image_required) {
      throw new Error("The visual generator may generate only non-factual illustrations, never real-world photos, maps, or infographics.");
    }
    if (this.config.provider === "vertex_gemini") return this.generateGeminiImage(visual, draft);
    if (this.config.provider === "vertex_imagen") return this.generateImagenImage(visual, draft);
    throw new Error("The selected visual provider cannot generate image files.");
  }

  async generateImagenImage(visual, draft) {
    const accessToken = await this.accessToken();
    const endpoint = `https://${this.config.location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(this.config.projectId)}/locations/${encodeURIComponent(this.config.location)}/publishers/google/models/${encodeURIComponent(this.config.model)}:predict`;
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
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Vertex Imagen request failed (${response.status}): ${payload?.error?.message || response.statusText}`);
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

  async generateGeminiImage(visual, draft) {
    const accessToken = await this.accessToken();
    const location = this.config.location || "global";
    const host = location === "global" ? "https://aiplatform.googleapis.com" : `https://${location}-aiplatform.googleapis.com`;
    const endpoint = `${host}/v1/projects/${encodeURIComponent(this.config.projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(this.config.model)}:generateContent`;
    const prompt = `${visual.generation_prompt}\n\nCreate an original editorial illustration only. Do not depict people, logos, watermarks, readable text, or a documentary-style real place.`;
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
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Gemini 3.1 Flash Image request failed (${response.status}): ${payload?.error?.message || response.statusText}`);
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

function normalizeMime(value) {
  return ["image/png", "image/jpeg"].includes(value) ? value : "image/png";
}
