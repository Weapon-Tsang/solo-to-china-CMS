import crypto from "node:crypto";
import { KimiClient } from "./kimi-client.mjs";
import { validateJsonSchema } from "../frontend-contract.mjs";
import { decodeOpenAiWire, openAiWireSchema, ProviderRequestError, providerReasoningOptions, providerTransportError } from "./provider-schema.mjs";
import { resolveStagePolicy } from "./stage-policy.mjs";

export class OpenAIResponsesClient extends KimiClient {
  async completeJson({ name, schema, instructions, content, timeoutMs = null, signal = null, telemetryContext = null }) {
    if (!this.enabled) throw configuredError("OpenAI");
    const policy = resolveStagePolicy(name, this.config);
    const wireSchema = openAiWireSchema(schema);
    const identity = callIdentity(name, schema, instructions, content);
    const startedAt = Date.now();
    const input = [{ role: "user", content: normalizeParts(content) }];
    for (let attempt = 0; attempt < policy.maxAttempts; attempt += 1) {
      const gateAt = Date.now();
      await this.config.beforeRequest?.({ provider: "openai", model: this.config.model, stage: name, attempt: attempt + 1 });
      const attemptAt = Date.now();
      const body = {
        model: this.config.model,
        store: false,
        instructions,
        input,
        max_output_tokens: policy.maxOutputTokens,
        ...providerReasoningOptions("openai", policy.thinking),
        text: { format: { type: "json_schema", name: safeName(name), strict: true, schema: wireSchema } },
      };
      let response;
      try {
        response = await this.fetch(`${this.config.baseUrl}/responses`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.config.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: combinedSignal(signal, timeoutMs || policy.timeoutMs),
        });
      } catch (error) {
        const wrapped = signal?.aborted ? error : providerTransportError("openai", error);
        this.emitModelCall(metric({ identity, policy, telemetryContext, attempt, gateAt, attemptAt, startedAt,
          status: signal?.aborted ? "cancelled" : "failed", errorCode: wrapped.code || wrapped.name,
          dispatchState: "dispatch_started" }));
        throw wrapped;
      }
      const payload = await response.json().catch(() => ({}));
      const requestId = response.headers.get("x-request-id") || payload?._request_id || null;
      if (!response.ok) {
        this.emitModelCall(metric({ identity, policy, telemetryContext, attempt, gateAt, attemptAt, startedAt,
          status: "failed", errorCode: String(payload?.error?.code || response.status), usage: payload?.usage,
          httpStatus: response.status, requestId, dispatchState: "response_received" }));
        throw new ProviderRequestError("OpenAI", response.status, payload?.error?.message || response.statusText,
          { ...(payload?.error || {}), requestId, retryAfter: response.headers.get("retry-after") });
      }
      const terminal = responseFailure(payload);
      if (terminal) {
        this.emitModelCall(metric({ identity, policy, telemetryContext, attempt, gateAt, attemptAt, startedAt,
          status: "failed", errorCode: terminal.code, usage: payload?.usage, httpStatus: response.status,
          requestId, dispatchState: "response_received" }));
        throw terminal;
      }
      const outputText = responseText(payload);
      let parsed;
      try { parsed = JSON.parse(outputText); } catch { parsed = null; }
      const decoded = parsed == null ? null : decodeOpenAiWire(parsed, schema);
      const errors = decoded == null ? [{ path: "$", message: "invalid or empty JSON" }] : validateJsonSchema(decoded, schema);
      if (!errors.length) {
        this.emitModelCall(metric({ identity, policy, telemetryContext, attempt, gateAt, attemptAt, startedAt,
          status: "succeeded", usage: payload?.usage, model: payload?.model, httpStatus: response.status,
          requestId, dispatchState: "completed" }));
        return { output: decoded, model: payload?.model || this.config.model, usage: payload?.usage || null };
      }
      this.emitModelCall(metric({ identity, policy, telemetryContext, attempt, gateAt, attemptAt, startedAt,
        status: "failed", errorCode: "INVALID_MODEL_OUTPUT", usage: payload?.usage, httpStatus: response.status,
        requestId, dispatchState: "response_received", retryReason: "structured_repair" }));
      input.push({ role: "assistant", content: [{ type: "output_text", text: outputText }] },
        { role: "user", content: [{ type: "input_text", text: `Return the complete corrected JSON only. Errors: ${JSON.stringify(errors.slice(0, 20))}` }] });
    }
    throw Object.assign(new Error("OpenAI returned invalid structured output after bounded repair."), {
      code: "INVALID_MODEL_OUTPUT", provider: "openai", retryable: true,
    });
  }
}

function normalizeParts(content) {
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  return (content || []).map((part) => {
    if (part?.type === "text") return { type: "input_text", text: part.text };
    if (part?.type === "image_url") return { type: "input_image", image_url: part.image_url?.url, detail: part.image_url?.detail || "auto" };
    throw Object.assign(new Error("OpenAI Responses received an unsupported content part."), { code: "UNSUPPORTED_INPUT_PART", retryable: false });
  });
}

function responseFailure(payload) {
  if (payload?.status === "incomplete" || payload?.incomplete_details) return Object.assign(new Error("OpenAI response was incomplete."), {
    code: payload?.incomplete_details?.reason === "max_output_tokens" ? "MODEL_OUTPUT_LIMIT" : "MODEL_RESPONSE_INCOMPLETE",
    provider: "openai", retryable: true,
  });
  const refusal = (payload?.output || []).flatMap((item) => item?.content || []).find((item) => item?.type === "refusal");
  if (refusal) return Object.assign(new Error(`OpenAI refused this extraction: ${String(refusal.refusal || "request refused").slice(0, 500)}`), {
    code: "MODEL_REFUSAL", provider: "openai", retryable: false,
  });
  if (["failed", "cancelled"].includes(payload?.status)) return Object.assign(new Error(payload?.error?.message || `OpenAI response ${payload.status}.`), {
    code: payload?.error?.code || `MODEL_RESPONSE_${String(payload.status).toUpperCase()}`, provider: "openai", retryable: payload.status !== "cancelled",
  });
  return null;
}

function responseText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text.trim();
  return (payload?.output || []).flatMap((item) => item?.content || [])
    .filter((item) => item?.type === "output_text").map((item) => item.text || "").join("").trim();
}

function metric({ identity, policy, telemetryContext, attempt, gateAt, attemptAt, startedAt, status, errorCode = null,
  retryReason = null, usage = null, model = null, httpStatus = null, requestId = null, dispatchState }) {
  return { ...identity, provider: "openai", model: model || policy.model,
    role: telemetryContext?.role || "extraction", requestedModel: policy.model, returnedModel: model || null,
    inputTokens: usage?.input_tokens ?? null, outputTokens: usage?.output_tokens ?? null,
    cachedTokens: usage?.input_tokens_details?.cached_tokens ?? null,
    thinkingTokens: usage?.output_tokens_details?.reasoning_tokens ?? null, providerUsage: usage || null,
    latencyMs: Date.now() - attemptAt, attempts: attempt + 1, attemptNumber: attempt + 1,
    status: status === "succeeded" ? "succeeded" : "failed", attemptStatus: status, errorCode, retryReason,
    requestKind: "provider", policyVersion: policy.version, configHash: policy.configHash,
    runId: telemetryContext?.runId || null, entityId: telemetryContext?.entityId || null,
    sourceRunId: telemetryContext?.sourceRunId || null, articleRevision: telemetryContext?.articleRevision ?? null,
    queueWaitMs: telemetryContext?.queueWaitMs ?? null, providerRequestMs: Date.now() - attemptAt,
    retryWaitMs: Math.max(0, attemptAt - gateAt), totalStageMs: (telemetryContext?.queueWaitMs || 0) + Date.now() - startedAt,
    executionRoute: telemetryContext?.executionRoute || null, httpStatus, providerCode: errorCode,
    providerRequestId: requestId, dispatchState, endpointId: "openai:responses",
    requestStartedAt: new Date(attemptAt).toISOString(), requestCompletedAt: new Date().toISOString(),
    costUsd: null, costStatus: "unknown" };
}

function callIdentity(stage, schema, instructions, content) {
  const digest = (value) => crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
  return { stage: stage || "unknown", substage: stage || "unknown", promptHash: digest(instructions || ""),
    schemaHash: digest(schema || {}), inputHash: digest(content || "") };
}

function configuredError(label) { return Object.assign(new Error(`${label} API key is not configured.`), { code: "AI_NOT_CONFIGURED", retryable: false }); }
function safeName(value) { return String(value || "structured_output").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64); }
function combinedSignal(signal, timeoutMs) { const timeout = AbortSignal.timeout(timeoutMs); return signal ? AbortSignal.any([signal, timeout]) : timeout; }
