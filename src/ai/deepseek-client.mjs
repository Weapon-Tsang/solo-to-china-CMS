import crypto from "node:crypto";
import { KimiClient } from "./kimi-client.mjs";
import { validateJsonSchema } from "../frontend-contract.mjs";
import { ProviderRequestError, providerReasoningOptions, providerTransportError } from "./provider-schema.mjs";
import { resolveStagePolicy } from "./stage-policy.mjs";

export class DeepSeekClient extends KimiClient {
  async completeJson({ name, schema, instructions, content, timeoutMs = null, signal = null, telemetryContext = null }) {
    if (!this.enabled) throw Object.assign(new Error("DeepSeek API key is not configured."), { code: "AI_NOT_CONFIGURED", retryable: false });
    const policy = resolveStagePolicy(name, this.config);
    const identity = callIdentity(name, schema, instructions, content);
    const messages = [{ role: "system", content: `${instructions}\nReturn JSON only. Match this JSON shape and do not omit required evidence: ${JSON.stringify(schemaExample(schema))}` },
      { role: "user", content }];
    const startedAt = Date.now();
    for (let attempt = 0; attempt < policy.maxAttempts; attempt += 1) {
      const gateAt = Date.now();
      await this.config.beforeRequest?.({ provider: "deepseek", model: this.config.model, stage: name, attempt: attempt + 1 });
      const attemptAt = Date.now();
      let response;
      try {
        response = await this.fetch(`${this.config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.config.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: this.config.model, messages, max_tokens: policy.maxOutputTokens,
            response_format: { type: "json_object" }, ...providerReasoningOptions("deepseek", policy.thinking) }),
          signal: combinedSignal(signal, timeoutMs || policy.timeoutMs),
        });
      } catch (error) {
        const wrapped = signal?.aborted ? error : providerTransportError("deepseek", error);
        this.emitModelCall(metric({ identity, policy, telemetryContext, attempt, gateAt, attemptAt, startedAt,
          status: signal?.aborted ? "cancelled" : "failed", errorCode: wrapped.code || wrapped.name, dispatchState: "dispatch_started" }));
        throw wrapped;
      }
      const payload = await response.json().catch(() => ({}));
      const requestId = response.headers.get("x-request-id") || payload?.id || null;
      if (!response.ok) {
        this.emitModelCall(metric({ identity, policy, telemetryContext, attempt, gateAt, attemptAt, startedAt,
          status: "failed", errorCode: String(payload?.error?.code || response.status), usage: payload?.usage,
          httpStatus: response.status, requestId, dispatchState: "response_received" }));
        throw new ProviderRequestError("DeepSeek", response.status, payload?.error?.message || response.statusText,
          { ...(payload?.error || {}), requestId, retryAfter: response.headers.get("retry-after") });
      }
      const choice = payload?.choices?.[0];
      if (["length", "max_tokens"].includes(choice?.finish_reason)) throw Object.assign(new Error("DeepSeek output reached its token limit."), {
        code: "MODEL_OUTPUT_LIMIT", provider: "deepseek", retryable: true,
      });
      const output = choice?.message?.content;
      let parsed;
      try { parsed = typeof output === "string" && output.trim() ? JSON.parse(output) : null; } catch { parsed = null; }
      const errors = parsed == null ? [{ path: "$", message: "invalid or empty JSON" }] : validateJsonSchema(parsed, schema);
      if (!errors.length) {
        this.emitModelCall(metric({ identity, policy, telemetryContext, attempt, gateAt, attemptAt, startedAt,
          status: "succeeded", usage: payload?.usage, model: payload?.model, httpStatus: response.status,
          requestId, dispatchState: "completed" }));
        return { output: parsed, model: payload?.model || this.config.model, usage: payload?.usage || null };
      }
      this.emitModelCall(metric({ identity, policy, telemetryContext, attempt, gateAt, attemptAt, startedAt,
        status: "failed", errorCode: "INVALID_MODEL_OUTPUT", usage: payload?.usage, httpStatus: response.status,
        requestId, dispatchState: "response_received", retryReason: "structured_repair" }));
      messages.push({ role: "assistant", content: typeof output === "string" ? output : "" },
        { role: "user", content: `Correct the JSON and return the complete object only. Errors: ${JSON.stringify(errors.slice(0, 20))}` });
    }
    throw Object.assign(new Error("DeepSeek returned invalid structured output after bounded repair."), {
      code: "INVALID_MODEL_OUTPUT", provider: "deepseek", retryable: true,
    });
  }
}

function schemaExample(schema) {
  if (!schema || typeof schema !== "object") return null;
  const type = Array.isArray(schema.type) ? schema.type.find((item) => item !== "null") : schema.type;
  if (type === "object" || schema.properties) return Object.fromEntries(Object.entries(schema.properties || {})
    .filter(([key]) => (schema.required || []).includes(key)).map(([key, child]) => [key, schemaExample(child)]));
  if (type === "array") return [];
  if (schema.enum?.length) return schema.enum[0];
  if (type === "boolean") return false;
  if (["number", "integer"].includes(type)) return 0;
  return "";
}

function metric({ identity, policy, telemetryContext, attempt, gateAt, attemptAt, startedAt, status, errorCode = null,
  retryReason = null, usage = null, model = null, httpStatus = null, requestId = null, dispatchState }) {
  return { ...identity, provider: "deepseek", model: model || policy.model,
    role: telemetryContext?.role || "extraction", requestedModel: policy.model, returnedModel: model || null,
    inputTokens: usage?.prompt_tokens ?? null, outputTokens: usage?.completion_tokens ?? null,
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? null,
    thinkingTokens: usage?.completion_tokens_details?.reasoning_tokens ?? null, providerUsage: usage || null,
    latencyMs: Date.now() - attemptAt, attempts: attempt + 1, attemptNumber: attempt + 1,
    status: status === "succeeded" ? "succeeded" : "failed", attemptStatus: status, errorCode, retryReason,
    requestKind: "provider", policyVersion: policy.version, configHash: policy.configHash,
    runId: telemetryContext?.runId || null, entityId: telemetryContext?.entityId || null,
    sourceRunId: telemetryContext?.sourceRunId || null, articleRevision: telemetryContext?.articleRevision ?? null,
    queueWaitMs: telemetryContext?.queueWaitMs ?? null, providerRequestMs: Date.now() - attemptAt,
    retryWaitMs: Math.max(0, attemptAt - gateAt), totalStageMs: (telemetryContext?.queueWaitMs || 0) + Date.now() - startedAt,
    executionRoute: telemetryContext?.executionRoute || null, httpStatus, providerCode: errorCode,
    providerRequestId: requestId, dispatchState, endpointId: "deepseek:chat_completions",
    requestStartedAt: new Date(attemptAt).toISOString(), requestCompletedAt: new Date().toISOString(),
    costUsd: null, costStatus: "unknown" };
}

function callIdentity(stage, schema, instructions, content) {
  const digest = (value) => crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
  return { stage: stage || "unknown", substage: stage || "unknown", promptHash: digest(instructions || ""),
    schemaHash: digest(schema || {}), inputHash: digest(content || "") };
}
function combinedSignal(signal, timeoutMs) { const timeout = AbortSignal.timeout(timeoutMs); return signal ? AbortSignal.any([signal, timeout]) : timeout; }
