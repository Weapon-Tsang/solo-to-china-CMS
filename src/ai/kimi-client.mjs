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
    const response = await this.fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.config.model,
        stream: false,
        max_completion_tokens: this.config.maxCompletionTokens,
        messages: [
          { role: "system", content: instructions },
          { role: "user", content },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name, strict: true, schema },
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await jsonPayload(response);
    if (!response.ok) throw new Error(`Kimi request failed (${response.status}): ${payload?.error?.message || response.statusText}`);
    const choice = payload?.choices?.[0];
    if (choice?.finish_reason === "length") throw new Error("Kimi response reached its output limit; increase KIMI_MAX_COMPLETION_TOKENS.");
    const output = choice?.message?.content;
    if (typeof output !== "string" || !output.trim()) throw new Error("Kimi returned no structured output.");
    try {
      return { output: JSON.parse(output), model: payload.model || this.config.model };
    } catch {
      throw new Error("Kimi returned invalid JSON despite structured output mode.");
    }
  }

  async imageParts(assets) {
    const attempted = (assets || []).slice(0, this.config.maxImages || 0);
    const results = await Promise.allSettled(attempted.map(async (asset) => ({
      type: "image_url",
      image_url: { url: await this.imageDataUrl(asset.remote_url) },
    })));
    const parts = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    return { parts, attempted: attempted.length };
  }

  async imageDataUrl(value) {
    const url = safeXiaohongshuImageUrl(value);
    if (!url) throw new Error("Captured image URL is not an allowlisted Xiaohongshu HTTPS asset.");
    const response = await this.fetch(url, { signal: AbortSignal.timeout(this.config.imageTimeoutMs || 20_000) });
    if (!response.ok) throw new Error(`Image fetch failed (${response.status}).`);
    const contentType = String(response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (!/^image\/(?:jpeg|jpg|png|webp|gif)$/.test(contentType)) throw new Error("Captured asset is not a supported image.");
    const declaredBytes = Number.parseInt(response.headers.get("content-length") || "", 10);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_IMAGE_BYTES) throw new Error("Captured image is too large for Kimi vision input.");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("Captured image is empty or too large for Kimi vision input.");
    return `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
  }
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
