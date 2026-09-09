import crypto from "node:crypto";
import { KimiClient } from "./kimi-client.mjs";
import { VertexGeminiClient } from "./vertex-gemini-client.mjs";

export function createAiClient(config, fetchImpl = fetch) {
  let client = null;
  let provider = "";
  const responseCache = new Map();
  const pending = new Map();
  const maxCacheEntries = Math.max(1, Math.min(512, Number(config.aiResponseCacheEntries || 128)));
  const current = () => {
    if (!client || provider !== config.provider) {
      provider = config.provider;
      client = provider === "vertex" ? new VertexGeminiClient(config, fetchImpl) : new KimiClient(config, fetchImpl);
    }
    return client;
  };
  return {
    get enabled() { return current().enabled; },
    get batchEnabled() { return Boolean(current().batchEnabled); },
    async completeJson(input) {
      const identity = callIdentity(config, input);
      if (responseCache.has(identity.key)) {
        const cached = responseCache.get(identity.key);
        responseCache.delete(identity.key);
        responseCache.set(identity.key, cached);
        try {
          config.onModelCall?.({
            stage: input.name || "structured_completion",
            provider: config.provider || "kimi",
            model: activeModel(config),
            ...identity.hashes,
            inputTokens: null,
            outputTokens: null,
            cachedTokens: null,
            latencyMs: 0,
            attempts: 0,
            status: "succeeded",
            errorCode: null,
            costUsd: 0,
          });
        } catch { /* cache telemetry must never fail production */ }
        return structuredClone(cached);
      }
      if (pending.has(identity.key)) return structuredClone(await pending.get(identity.key));
      const completion = current().completeJson(input);
      pending.set(identity.key, completion);
      try {
        const value = await completion;
        responseCache.set(identity.key, structuredClone(value));
        while (responseCache.size > maxCacheEntries) responseCache.delete(responseCache.keys().next().value);
        return value;
      } finally {
        pending.delete(identity.key);
      }
    },
    imageParts(assets) { return current().imageParts(assets); },
    videoParts(assets) { return current().videoParts(assets); },
    prepareBatchRequest(input) { return current().prepareBatchRequest(input); },
    createBatch(requests) { return current().createBatch(requests); },
    getBatch(name) { return current().getBatch(name); },
    readBatchOutput(batch) { return current().readBatchOutput(batch); },
    cleanupBatch(batch) { return current().cleanupBatch(batch); },
  };
}

function callIdentity(config, input) {
  const hashes = {
    promptHash: sha256(input.instructions || ""),
    schemaHash: sha256(JSON.stringify(input.schema || {})),
    inputHash: sha256(typeof input.content === "string" ? input.content : JSON.stringify(input.content || null)),
  };
  return {
    hashes,
    key: sha256(JSON.stringify({ provider: config.provider, model: activeModel(config), name: input.name, ...hashes })),
  };
}

function activeModel(config) {
  return config.model || "unknown";
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}
