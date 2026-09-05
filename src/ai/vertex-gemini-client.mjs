import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { KimiClient } from "./kimi-client.mjs";

const METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const MAX_INLINE_VIDEO_BYTES = 14 * 1024 * 1024;
const SUPPORTED_VIDEO_MIME_TYPES = new Set(["video/mp4", "video/quicktime", "video/mpeg", "video/webm", "video/avi", "video/wmv", "video/flv", "video/3gpp"]);

export class VertexGeminiClient {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.assetClient = new KimiClient({ ...config, apiKey: "asset-loader" }, fetchImpl);
  }

  get enabled() { return Boolean(this.config.projectId && this.config.model); }

  async completeJson({ schema, instructions, content, timeoutMs = this.config.requestTimeoutMs || 360_000 }) {
    if (!this.enabled) throw new Error("Vertex AI requires GOOGLE_CLOUD_PROJECT and a selected Gemini model.");
    const accessToken = await this.accessToken();
    const location = this.config.location || "us-central1";
    const apiHost = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
    const endpoint = `https://${apiHost}/v1/projects/${encodeURIComponent(this.config.projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(this.config.model)}:generateContent`;
    const parts = normalizeVertexParts(content);
    const requestBody = {
      systemInstruction: { parts: [{ text: instructions }] },
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseMimeType: "application/json", responseSchema: schema,
        maxOutputTokens: this.config.maxCompletionTokens || 16_000, temperature: 0.1,
      },
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`Vertex Gemini request failed (${response.status}): ${payload?.error?.message || response.statusText}`);
      const candidate = payload?.candidates?.[0];
      const output = candidate?.content?.parts?.map((part) => part.text || "").join("");
      if (candidate?.finishReason === "MAX_TOKENS") {
        throw new Error("Vertex Gemini structured output reached its token limit; increase VERTEX_AI_MAX_COMPLETION_TOKENS or reduce the input scope.");
      }
      if (!output?.trim()) throw new Error("Vertex Gemini returned no structured output.");
      const parsed = parseStructuredJson(output);
      if (parsed.ok) return { output: parsed.value, model: this.config.model };
    }
    throw new Error("Vertex Gemini returned invalid JSON twice despite structured output mode.");
  }

  async imageParts(assets) {
    const result = await this.assetClient.imageParts(assets);
    return {
      attempted: result.attempted,
      parts: result.parts.map((part) => {
        const match = /^data:([^;]+);base64,(.+)$/s.exec(part.image_url.url);
        return match ? { inlineData: { mimeType: match[1], data: match[2] } } : null;
      }).filter(Boolean),
    };
  }

  async videoParts(assets) {
    const attempted = (assets || []).filter((asset) => asset?.kind === "video").slice(0, 1);
    if (!attempted.length) return { parts: [], attempted: 0, cleanup: async () => {} };
    const asset = attempted[0];
    const uploadRoot = path.resolve(this.config.sourceUploadsDir || "data/source-uploads");
    const filename = path.resolve(String(asset.local_path || ""));
    if (!filename.startsWith(`${uploadRoot}${path.sep}`)) throw new Error("Uploaded source video is outside the configured source directory.");
    const mimeType = String(asset.mime_type || "").toLowerCase();
    if (!SUPPORTED_VIDEO_MIME_TYPES.has(mimeType)) throw new Error("Uploaded source video has an unsupported MIME type.");
    const bytes = await fs.readFile(filename);
    if (!bytes.length) throw new Error("Uploaded source video is empty.");
    const maxInlineVideoBytes = Number(this.config.maxInlineVideoBytes || MAX_INLINE_VIDEO_BYTES);
    if (bytes.length <= maxInlineVideoBytes) {
      return { parts: [{ inlineData: { mimeType, data: bytes.toString("base64") } }], attempted: 1, cleanup: async () => {} };
    }

    const bucket = String(this.config.videoBucket || "").trim();
    if (!/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(bucket)) {
      throw new Error("Uploaded video is too large for inline analysis. Configure MANUAL_SOURCE_GCS_BUCKET and grant the VM service account object create/delete access, then retry extraction.");
    }
    const objectName = `manual-source-input/${crypto.randomUUID()}${path.extname(filename).toLowerCase()}`;
    const accessToken = await this.accessToken();
    const uploadUrl = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`);
    uploadUrl.searchParams.set("uploadType", "media");
    uploadUrl.searchParams.set("name", objectName);
    const uploaded = await this.fetch(uploadUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": mimeType },
      body: bytes,
      signal: AbortSignal.timeout(this.config.requestTimeoutMs || 360_000),
    });
    if (!uploaded.ok) {
      const payload = await uploaded.json().catch(() => ({}));
      throw new Error(`Cloud Storage video staging failed (${uploaded.status}): ${payload?.error?.message || uploaded.statusText}`);
    }
    const cleanup = async () => {
      const deleteUrl = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}`;
      await this.fetch(deleteUrl, { method: "DELETE", headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
    };
    return { parts: [{ fileData: { fileUri: `gs://${bucket}/${objectName}`, mimeType } }], attempted: 1, cleanup };
  }

  async accessToken() {
    if (this.config.accessToken) return this.config.accessToken;
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const response = await this.fetch(METADATA_TOKEN_URL, { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(5_000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) throw new Error("Vertex Gemini could not obtain a Google Compute Engine service-account token.");
    this.token = payload.access_token;
    this.tokenExpiresAt = Date.now() + Math.max(60, Number(payload.expires_in || 300) - 60) * 1_000;
    return this.token;
  }
}

function normalizeVertexParts(content) {
  const parts = typeof content === "string" ? [{ text: content }] : content;
  if (!Array.isArray(parts)) throw new Error("Vertex Gemini content must be text or an array of content parts.");
  return parts.map((part) => {
    if (typeof part?.text === "string") return { text: part.text };
    if (part?.inlineData?.mimeType && part.inlineData.data) return { inlineData: part.inlineData };
    if (part?.fileData?.fileUri && part.fileData.mimeType) return { fileData: part.fileData };
    const dataUrl = part?.type === "image_url" ? part?.image_url?.url : "";
    const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
    if (match) return { inlineData: { mimeType: match[1], data: match[2] } };
    throw new Error("Vertex Gemini received an unsupported content part.");
  });
}

function parseStructuredJson(value) {
  const text = String(value || "").replace(/^\uFEFF/, "").trim();
  const candidates = [text];
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fenced) candidates.push(fenced[1].trim());
  const firstObject = text.indexOf("{");
  const lastObject = text.lastIndexOf("}");
  if (firstObject >= 0 && lastObject > firstObject) candidates.push(text.slice(firstObject, lastObject + 1));
  const firstArray = text.indexOf("[");
  const lastArray = text.lastIndexOf("]");
  if (firstArray >= 0 && lastArray > firstArray) candidates.push(text.slice(firstArray, lastArray + 1));
  for (const candidate of candidates) {
    try { return { ok: true, value: JSON.parse(candidate) }; } catch { /* try the next safe wrapper removal */ }
  }
  return { ok: false, value: null };
}
