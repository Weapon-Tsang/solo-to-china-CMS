import crypto from "node:crypto";
import { KimiClient } from "./kimi-client.mjs";
import { VertexGeminiClient } from "./vertex-gemini-client.mjs";
import { resolveStagePolicy } from "./stage-policy.mjs";

export function createAiClient(config, fetchImpl = fetch) {
  const clients = new Map();
  const responseCache = new Map();
  const pending = new Map();
  const maxCacheEntries = Math.max(1, Math.min(512, Number(config.aiResponseCacheEntries || 128)));
  const clientFor = (snapshot = null) => {
    const selected = batchClientConfig(config, snapshot);
    const key = JSON.stringify([selected.provider, selected.model, selected.location, selected.projectId, selected.batchBucket]);
    if (!clients.has(key)) clients.set(key, selected.provider === "vertex"
      ? new VertexGeminiClient(selected, fetchImpl)
      : new KimiClient(selected, fetchImpl));
    return clients.get(key);
  };
  const current = () => clientFor();
  const batchClient = (snapshot) => {
    const selected = batchClientConfig(config, snapshot);
    if (selected.provider !== "vertex" || !selected.projectId) {
      throw Object.assign(new Error(`Stored Batch configuration cannot access provider ${selected.provider || "unknown"}; restore its Vertex project credentials to resume.`), {
        code: "BATCH_CREDENTIALS_UNAVAILABLE", retryable: true,
      });
    }
    return clientFor(snapshot);
  };
  return {
    get enabled() { return current().enabled; },
    get batchEnabled() { return Boolean(current().batchEnabled); },
    batchEnabledFor(snapshot) {
      try { return Boolean(batchClient(snapshot).batchEnabled); } catch { return false; }
    },
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
            costStatus: "confirmed",
            requestKind: "cache_hit",
            attemptStatus: "succeeded",
            attemptNumber: 0,
            policyVersion: identity.policy.version,
            configHash: identity.policy.configHash,
            runId: input.telemetryContext?.runId || null,
            entityId: input.telemetryContext?.entityId || null,
            queueWaitMs: input.telemetryContext?.queueWaitMs ?? null,
            providerRequestMs: 0,
            retryWaitMs: 0,
            totalStageMs: input.telemetryContext?.queueWaitMs || 0,
            executionRoute: input.telemetryContext?.executionRoute || null,
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
    imageParts(assets, snapshot = null) { return clientFor(snapshot).imageParts(assets); },
    videoParts(assets, snapshot = null) { return clientFor(snapshot).videoParts(assets); },
    prepareBatchRequest(input, snapshot) { return batchClient(snapshot).prepareBatchRequest(input); },
    createBatch(requests, options = {}, snapshot) { return batchClient(snapshot).createBatch(requests, options); },
    getBatch(name, snapshot) { return batchClient(snapshot).getBatch(name); },
    readBatchOutput(batch, snapshot) { return batchClient(snapshot).readBatchOutput(batch); },
    cleanupBatch(batch, snapshot) { return batchClient(snapshot).cleanupBatch(batch); },
  };
}

function batchClientConfig(config, snapshot) {
  if (!snapshot) return { ...config };
  return {
    ...config,
    provider: snapshot.provider || config.provider,
    model: snapshot.model || config.model,
    location: snapshot.location || config.location,
    projectId: snapshot.projectId || snapshot.project_id || config.projectId,
  };
}

function callIdentity(config, input) {
  const policy = resolveStagePolicy(input.name, config);
  const hashes = {
    promptHash: sha256(input.instructions || ""),
    schemaHash: sha256(JSON.stringify(input.schema || {})),
    inputHash: sha256(typeof input.content === "string" ? input.content : JSON.stringify(input.content || null)),
  };
  return {
    hashes,
    policy,
    key: sha256(JSON.stringify({ provider: config.provider, model: activeModel(config), name: input.name,
      policyVersion: policy.version, configHash: policy.configHash, ...hashes })),
  };
}

function activeModel(config) {
  return config.model || "unknown";
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}
