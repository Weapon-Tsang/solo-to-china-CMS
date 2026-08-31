import { KimiClient } from "./kimi-client.mjs";

const METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

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
    const endpoint = `https://${this.config.location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(this.config.projectId)}/locations/${encodeURIComponent(this.config.location)}/publishers/google/models/${encodeURIComponent(this.config.model)}:generateContent`;
    const parts = typeof content === "string" ? [{ text: content }] : content;
    const response = await this.fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: instructions }] },
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json", responseSchema: schema, maxOutputTokens: this.config.maxCompletionTokens || 16_000 },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Vertex Gemini request failed (${response.status}): ${payload?.error?.message || response.statusText}`);
    const output = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("");
    if (!output?.trim()) throw new Error("Vertex Gemini returned no structured output.");
    try { return { output: JSON.parse(output), model: this.config.model }; } catch { throw new Error("Vertex Gemini returned invalid JSON despite structured output mode."); }
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
