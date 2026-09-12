import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { KimiClient } from "./kimi-client.mjs";
import { validateJsonSchema } from "../frontend-contract.mjs";
import { ProviderRequestError, vertexStructuredOutput } from "./provider-schema.mjs";
import { resolveStagePolicy } from "./stage-policy.mjs";

const METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const MAX_INLINE_VIDEO_BYTES = 14 * 1024 * 1024;
const MAX_REMOTE_VIDEO_BYTES = 256 * 1024 * 1024;
const SUPPORTED_VIDEO_MIME_TYPES = new Set(["video/mp4", "video/quicktime", "video/mpeg", "video/webm", "video/avi", "video/wmv", "video/flv", "video/3gpp"]);
const REASONING_STAGES = new Set(["content_brief", "article_draft_v2", "quality_review_v2", "frontend_page_plan", "frontend_page_payload"]);

export class VertexGeminiClient {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.assetClient = new KimiClient({ ...config, apiKey: "asset-loader" }, fetchImpl);
  }

  get enabled() { return Boolean(this.config.projectId && this.config.model); }

  get batchEnabled() {
    return this.enabled && this.config.batchEnabled !== false
      && /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(String(this.config.batchBucket || "").trim())
      && String(this.config.location || "global") === "global";
  }

  async completeJson({ name, schema, instructions, content, timeoutMs = null, signal = null, telemetryContext = null }) {
    if (!this.enabled) throw new Error("Vertex AI requires GOOGLE_CLOUD_PROJECT and a selected Gemini model.");
    const accessToken = await this.accessToken();
    const location = this.config.location || "us-central1";
    const apiHost = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
    const endpoint = `https://${apiHost}/v1/projects/${encodeURIComponent(this.config.projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(this.config.model)}:generateContent`;
    const parts = normalizeVertexParts(content);
    const policy = resolveStagePolicy(name, this.config);
    const effectiveTimeoutMs = timeoutMs || policy.timeoutMs;
    const identity = modelCallIdentity(name, schema, instructions, content);
    let schemaMode = this.config.structuredSchemaMode || "json_schema";
    const requestBody = {
      systemInstruction: { parts: [{ text: instructions }] },
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseMimeType: "application/json", ...vertexStructuredOutput(schema, schemaMode),
        maxOutputTokens: policy.maxOutputTokens,
        ...(String(this.config.model).startsWith("gemini-3")
          ? { thinkingConfig: { thinkingLevel: policy.thinking } }
          : { temperature: 0.1 }),
      },
    };
    let correction = "";
    telemetryContext = { ...(telemetryContext || {}), stageStartedAt: Date.now(), retryWaitMs: 0 };
    for (let attempt = 0; attempt < policy.maxAttempts; attempt += 1) {
      requestBody.contents[0].parts = correction ? [...parts, { text: correction }] : parts;
      const requestGateStartedAt = Date.now();
      await this.config.beforeRequest?.({ provider: "vertex", model: this.config.model, stage: name, attempt: attempt + 1 });
      const attemptStartedAt = Date.now();
      telemetryContext.retryWaitMs = Math.max(0, attemptStartedAt - requestGateStartedAt);
      const requestStartedAt = new Date(attemptStartedAt).toISOString();
      let response;
      try {
        response = await this.fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: combinedSignal(signal, effectiveTimeoutMs),
        });
      } catch (error) {
        this.emitModelCall(vertexAttemptMetric({ identity, policy, telemetryContext, attempt, attemptStartedAt, requestStartedAt,
          status: error?.name === "AbortError" || error?.name === "TimeoutError" ? "cancelled" : "failed",
          errorCode: error?.name || "REQUEST_FAILED", retryReason: attempt ? "request_retry" : null }));
        throw error;
      }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = payload?.error?.message || response.statusText;
        if (response.status === 400 && schemaMode === "json_schema") {
          this.emitModelCall(vertexAttemptMetric({ identity, policy, telemetryContext, attempt, attemptStartedAt, requestStartedAt,
            status: "failed", errorCode: "SCHEMA_MODE_UNSUPPORTED", retryReason: "schema_transport_fallback", usage: payload?.usageMetadata }));
          schemaMode = "openapi";
          delete requestBody.generationConfig.responseJsonSchema;
          Object.assign(requestBody.generationConfig, vertexStructuredOutput(schema, schemaMode));
          continue;
        }
        this.emitModelCall(vertexAttemptMetric({ identity, policy, telemetryContext, attempt, attemptStartedAt, requestStartedAt,
          status: "failed", errorCode: String(payload?.error?.code || response.status), retryReason: attempt ? "provider_retry" : null,
          usage: payload?.usageMetadata }));
        throw new ProviderRequestError("Vertex Gemini", response.status, message,
          { ...(payload?.error || {}), retryAfter: response.headers.get("retry-after") });
      }
      const candidate = payload?.candidates?.[0];
      const output = candidate?.content?.parts?.map((part) => part.text || "").join("");
      if (candidate?.finishReason === "MAX_TOKENS") {
        this.emitModelCall(vertexAttemptMetric({ identity, policy, telemetryContext, attempt, attemptStartedAt, requestStartedAt,
          status: "failed", errorCode: "MODEL_OUTPUT_LIMIT", retryReason: attempt ? "structured_repair" : null, usage: payload?.usageMetadata }));
        throw outputLimitError(name);
      }
      if (!output?.trim()) {
        this.emitModelCall(vertexAttemptMetric({ identity, policy, telemetryContext, attempt, attemptStartedAt, requestStartedAt,
          status: "failed", errorCode: "EMPTY_MODEL_OUTPUT", retryReason: attempt ? "structured_repair" : null, usage: payload?.usageMetadata }));
        throw new Error("Vertex Gemini returned no structured output.");
      }
      const parsed = parseStructuredJson(output);
      const errors = parsed.ok ? validateJsonSchema(parsed.value, schema) : [{ path: "$", message: "invalid JSON" }];
      if (parsed.ok && errors.length === 0) {
        this.emitModelCall(vertexAttemptMetric({ identity, policy, telemetryContext, attempt, attemptStartedAt, requestStartedAt,
          status: "succeeded", retryReason: attempt ? "structured_repair" : null, usage: payload?.usageMetadata }));
        return { output: parsed.value, model: this.config.model,
          ...(payload.usageMetadata ? { usage: payload.usageMetadata } : {}) };
      }
      this.emitModelCall(vertexAttemptMetric({ identity, policy, telemetryContext, attempt, attemptStartedAt, requestStartedAt,
        status: "failed", errorCode: "INVALID_MODEL_OUTPUT", retryReason: attempt ? "structured_repair" : "invalid_json_or_schema",
        usage: payload?.usageMetadata }));
      correction = `The previous structured output was invalid. Return the complete corrected JSON only. Errors: ${JSON.stringify(errors.slice(0, 20))}`;
    }
    throw Object.assign(new Error("Vertex Gemini returned invalid structured output after repair attempts."), { code: "INVALID_MODEL_OUTPUT", retryable: true });
  }

  prepareBatchRequest({ id, name, schema, instructions, content }) {
    if (!this.batchEnabled) throw new Error("Vertex Batch requires the global endpoint and VERTEX_AI_BATCH_BUCKET.");
    const batchSchema = {
      ...schema,
      required: [...new Set([...(schema?.required || []), "batch_item_id"])],
      properties: { ...(schema?.properties || {}), batch_item_id: { type: "string", enum: [id] } },
    };
    const request = vertexRequestBody({
      name, schema: batchSchema,
      instructions: `${instructions}\n- Batch processing identifier: return batch_item_id exactly as ${id}.`,
      content, config: this.config,
    });
    return { id, transportKey: id, request };
  }

  async createBatch(requests, { operation = "extract_segment_claims", idempotencyKey = "", signal = null } = {}) {
    if (!this.batchEnabled) throw new Error("Vertex Batch is not configured.");
    if (!Array.isArray(requests) || !requests.length) throw new Error("Vertex Batch requires at least one request.");
    const accessToken = await this.accessToken();
    const bucket = String(this.config.batchBucket).trim();
    const batchId = String(idempotencyKey || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 96);
    const objectPrefix = `vertex-batch/${batchId}`;
    const inputObject = `${objectPrefix}/input.jsonl`;
    const outputObjectPrefix = `${objectPrefix}/output/`;
    const input = `${requests.map((item) => JSON.stringify({ transport_key: item.transportKey || item.id, request: item.request })).join("\n")}\n`;
    const maximumBytes = Number(this.config.batchMaxInputBytes || 900 * 1024 * 1024);
    if (Buffer.byteLength(input) > maximumBytes) throw new Error("Vertex Batch input exceeds the configured safe Cloud Storage limit.");
    await this.uploadObject(bucket, inputObject, input, "application/jsonl", accessToken);
    const endpoint = `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(this.config.projectId)}/locations/global/batchPredictionJobs`;
    const response = await this.fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        displayName: `solo-${String(operation).replace(/[^a-z0-9_-]+/giu, "-").slice(0, 40)}-${batchId.slice(0, 8)}`,
        model: `publishers/google/models/${this.config.model}`,
        inputConfig: { instancesFormat: "jsonl", gcsSource: { uris: [`gs://${bucket}/${inputObject}`] } },
        instanceConfig: { instanceType: "object", keyField: "transport_key" },
        outputConfig: { predictionsFormat: "jsonl", gcsDestination: { outputUriPrefix: `gs://${bucket}/${outputObjectPrefix}` } },
      }),
      signal: combinedSignal(signal, this.config.requestTimeoutMs || 360_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.name) {
      await this.deleteObject(bucket, inputObject, accessToken).catch(() => null);
      throw new ProviderRequestError("Vertex Batch", response.status, payload?.error?.message || response.statusText,
        { ...(payload?.error || {}), retryAfter: response.headers.get("retry-after") });
    }
    return { name: payload.name, state: payload.state || "JOB_STATE_PENDING", inputUri: `gs://${bucket}/${inputObject}`,
      outputUriPrefix: `gs://${bucket}/${outputObjectPrefix}`, itemIds: requests.map((item) => item.id),
      pollMs: Number(this.config.batchPollMs || 60_000) };
  }

  async getBatch(name) {
    const accessToken = await this.accessToken();
    const response = await this.fetch(`https://aiplatform.googleapis.com/v1/${String(name).replace(/^\//, "")}`, {
      headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new ProviderRequestError("Vertex Batch", response.status, payload?.error?.message || response.statusText,
      { ...(payload?.error || {}), retryAfter: response.headers.get("retry-after") });
    return payload;
  }

  async readBatchOutput(batch) {
    const accessToken = await this.accessToken();
    const outputUri = String(batch?.outputInfo?.gcsOutputDirectory || batch?.output_uri_prefix || "");
    const parsedUri = parseGcsUri(outputUri);
    if (!parsedUri) throw new Error("Vertex Batch completed without a readable Cloud Storage output directory.");
    const objects = await this.listObjects(parsedUri.bucket, parsedUri.object, accessToken);
    const jsonlObjects = objects.filter((item) => /\.jsonl$/i.test(item.name));
    const results = [];
    for (const item of jsonlObjects) {
      const body = await this.downloadObject(parsedUri.bucket, item.name, accessToken);
      const lines = body.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line.trim()) continue;
        const transport = { objectName: item.name, lineNumber: index + 1,
          checksum: crypto.createHash("sha256").update(line).digest("hex") };
        try { results.push({ ...parseBatchResult(JSON.parse(line)), transport }); }
        catch (error) { results.push({ id: "", error: `Invalid Vertex Batch JSONL output: ${error.message}`, transport }); }
      }
    }
    return results;
  }

  async cleanupBatch(batch) {
    const accessToken = await this.accessToken();
    const uris = [batch?.input_uri, batch?.inputUri, batch?.outputInfo?.gcsOutputDirectory, batch?.output_uri_prefix, batch?.outputUriPrefix]
      .map(parseGcsUri).filter(Boolean);
    const seen = new Set();
    for (const uri of uris) {
      const key = `${uri.bucket}/${uri.object}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (/\.jsonl$/i.test(uri.object)) await this.deleteObject(uri.bucket, uri.object, accessToken).catch(() => null);
      else {
        const objects = await this.listObjects(uri.bucket, uri.object, accessToken).catch(() => []);
        await Promise.allSettled(objects.map((item) => this.deleteObject(uri.bucket, item.name, accessToken)));
      }
    }
  }

  async uploadObject(bucket, objectName, body, contentType, accessToken) {
    const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`);
    url.searchParams.set("uploadType", "media");
    url.searchParams.set("name", objectName);
    const response = await this.fetch(url, { method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": contentType },
      body, signal: AbortSignal.timeout(this.config.requestTimeoutMs || 360_000) });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(`Cloud Storage batch staging failed (${response.status}): ${payload?.error?.message || response.statusText}`);
    }
  }

  async listObjects(bucket, prefix, accessToken) {
    const values = [];
    let pageToken = "";
    do {
      const url = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o`);
      url.searchParams.set("prefix", prefix);
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const response = await this.fetch(url, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`Cloud Storage batch output listing failed (${response.status}): ${payload?.error?.message || response.statusText}`);
      values.push(...(payload.items || []));
      pageToken = payload.nextPageToken || "";
    } while (pageToken);
    return values;
  }

  async downloadObject(bucket, objectName, accessToken) {
    const url = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}`);
    url.searchParams.set("alt", "media");
    const response = await this.fetch(url, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(this.config.requestTimeoutMs || 360_000) });
    if (!response.ok) throw new Error(`Cloud Storage batch output download failed (${response.status}).`);
    return response.text();
  }

  async deleteObject(bucket, objectName, accessToken) {
    const response = await this.fetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}`,
      { method: "DELETE", headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok && response.status !== 404) throw new Error(`Cloud Storage batch cleanup failed (${response.status}).`);
  }

  emitModelCall(metric) {
    try { this.config.onModelCall?.(metric); } catch { /* telemetry must never fail production */ }
  }

  async imageParts(assets) {
    const result = await this.assetClient.imageParts(assets);
    return {
      attempted: result.attempted,
      manifest: result.manifest || [],
      parts: result.parts.map((part) => {
        const match = /^data:([^;]+);base64,(.+)$/s.exec(part.image_url.url);
        return match ? { inlineData: { mimeType: match[1], data: match[2] } } : null;
      }).filter(Boolean),
    };
  }

  async videoParts(assets) {
    const attempted = (assets || []).filter((asset) => asset?.kind === "video");
    if (!attempted.length) return { parts: [], attempted: 0, cleanup: async () => {} };
    if (attempted.length > 1) {
      const prepared = [];
      try {
        for (const asset of attempted) prepared.push(await this.videoParts([asset]));
      } catch (error) {
        await Promise.allSettled(prepared.map((item) => item.cleanup()));
        throw error;
      }
      return {
        parts: prepared.flatMap((item) => item.parts), attempted: prepared.reduce((total, item) => total + item.attempted, 0),
        manifest: prepared.flatMap((item) => item.manifest || []),
        cleanup: async () => { await Promise.allSettled(prepared.map((item) => item.cleanup())); },
      };
    }
    const asset = attempted[0];
    const prepared = await this.loadVideoAsset(asset);
    const { bytes, mimeType, filename } = prepared;
    if (!SUPPORTED_VIDEO_MIME_TYPES.has(mimeType)) throw new Error("Uploaded source video has an unsupported MIME type.");
    if (!bytes.length) throw new Error("Uploaded source video is empty.");
    const maxInlineVideoBytes = Number(this.config.maxInlineVideoBytes || MAX_INLINE_VIDEO_BYTES);
    if (bytes.length <= maxInlineVideoBytes) {
      return { parts: [{ inlineData: { mimeType, data: bytes.toString("base64") } }], attempted: 1,
        manifest: [inputAssetManifest(asset, "video", "submitted", "inline_data")], cleanup: async () => {} };
    }

    const bucket = String(this.config.videoBucket || "").trim();
    if (!/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(bucket)) {
      throw new Error("Uploaded video is too large for inline analysis. Configure MANUAL_SOURCE_GCS_BUCKET and grant the VM service account object create/delete access, then retry extraction.");
    }
    const objectName = `manual-source-input/${crypto.randomUUID()}${path.extname(filename || "")?.toLowerCase() || extensionForVideo(mimeType)}`;
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
    return { parts: [{ fileData: { fileUri: `gs://${bucket}/${objectName}`, mimeType } }], attempted: 1,
      manifest: [inputAssetManifest(asset, "video", "submitted", "cloud_file")], cleanup };
  }

  async loadVideoAsset(asset) {
    if (asset?.local_path) {
      const uploadRoot = path.resolve(this.config.sourceUploadsDir || "data/source-uploads");
      const filename = path.resolve(String(asset.local_path));
      if (!filename.startsWith(`${uploadRoot}${path.sep}`)) throw new Error("Uploaded source video is outside the configured source directory.");
      return { bytes: await fs.readFile(filename), mimeType: String(asset.mime_type || "").toLowerCase(), filename };
    }
    const mediaUrl = xiaohongshuMediaUrl(asset?.remote_url);
    if (!mediaUrl) throw Object.assign(new Error("Captured Xiaohongshu video has no trusted downloadable media URL."), { retryable: false });
    const response = await this.fetch(mediaUrl, {
      method: "GET",
      headers: { referer: "https://www.xiaohongshu.com/" },
      redirect: "follow",
      signal: AbortSignal.timeout(this.config.requestTimeoutMs || 360_000),
    });
    if (!response.ok) throw Object.assign(new Error(`Captured Xiaohongshu video download failed (${response.status}).`), {
      code: "XHS_VIDEO_DOWNLOAD_FAILED", status: response.status, retryable: response.status === 408 || response.status === 429 || response.status >= 500,
    });
    if (response.url && !xiaohongshuMediaUrl(response.url)) throw Object.assign(new Error("Captured Xiaohongshu video redirected outside trusted media hosts."), { retryable: false });
    const mimeType = String(asset?.mime_type || response.headers.get("content-type") || "video/mp4").split(";", 1)[0].trim().toLowerCase();
    const bytes = await readResponseBytes(response, Number(this.config.maxVideoBytes || MAX_REMOTE_VIDEO_BYTES));
    return { bytes, mimeType, filename: new URL(mediaUrl).pathname };
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

function outputLimitError(stage) {
  if (stage === "source_research_extraction" || stage === "segment_claim_coverage_audit" || !stage) {
    return Object.assign(new Error("Vertex Gemini structured output reached its token limit; the Source segment must be split and retried."), {
      code: "MODEL_OUTPUT_LIMIT", retryable: true,
    });
  }
  const label = stage === "content_brief" ? "content planning" : String(stage).replaceAll("_", " ");
  return Object.assign(new Error(`Vertex Gemini ${label} structured output reached its token limit; narrow or correct the stage input before retrying.`), {
    code: "MODEL_OUTPUT_LIMIT", retryable: false,
  });
}

function xiaohongshuMediaUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || !(host === "xhscdn.com" || host.endsWith(".xhscdn.com")
      || host === "xhscdn.net" || host.endsWith(".xhscdn.net")
      || host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com"))) return "";
    return url.toString();
  } catch {
    return "";
  }
}

async function readResponseBytes(response, maximumBytes) {
  const declared = Number.parseInt(response.headers.get("content-length") || "", 10);
  if (Number.isFinite(declared) && declared > maximumBytes) throw Object.assign(new Error("Captured Xiaohongshu video exceeds the configured size limit."), { retryable: false });
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maximumBytes) throw Object.assign(new Error("Captured Xiaohongshu video exceeds the configured size limit."), { retryable: false });
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) throw Object.assign(new Error("Captured Xiaohongshu video exceeds the configured size limit."), { retryable: false });
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function extensionForVideo(mimeType) {
  return ({ "video/mp4": ".mp4", "video/quicktime": ".mov", "video/mpeg": ".mpeg", "video/webm": ".webm", "video/3gpp": ".3gp" })[mimeType] || ".mp4";
}

function modelCallIdentity(stage, schema, instructions, content) {
  const digest = (value) => crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
  return { stage: stage || "unknown", promptHash: digest(instructions || ""), schemaHash: digest(schema || {}), inputHash: digest(content || "") };
}

function vertexAttemptMetric({ identity, policy, telemetryContext, attempt, attemptStartedAt, requestStartedAt, status,
  errorCode = null, retryReason = null, usage = null }) {
  return { ...identity, provider: "vertex", model: policy.model,
    inputTokens: usage?.promptTokenCount ?? null, outputTokens: usage?.candidatesTokenCount ?? null,
    cachedTokens: usage?.cachedContentTokenCount ?? null, thinkingTokens: usage?.thoughtsTokenCount ?? null,
    providerUsage: usage || null, latencyMs: Date.now() - attemptStartedAt, attempts: attempt + 1,
    attemptNumber: attempt + 1, status: status === "succeeded" ? "succeeded" : "failed", attemptStatus: status,
    errorCode, retryReason, requestKind: "provider", policyVersion: policy.version, configHash: policy.configHash,
    runId: telemetryContext?.runId || null, entityId: telemetryContext?.entityId || null,
    queueWaitMs:telemetryContext?.queueWaitMs??null,providerRequestMs:Date.now()-attemptStartedAt,
    retryWaitMs:telemetryContext?.retryWaitMs??0,
    totalStageMs:(telemetryContext?.queueWaitMs||0)+Math.max(0,Date.now()-(telemetryContext?.stageStartedAt||attemptStartedAt)),
    executionRoute:telemetryContext?.executionRoute||null,
    requestStartedAt, requestCompletedAt: new Date().toISOString(), costUsd: null, costStatus: "unknown" };
}

function vertexRequestBody({ name, schema, instructions, content, config }) {
  return {
    systemInstruction: { parts: [{ text: instructions }] },
    contents: [{ role: "user", parts: normalizeVertexParts(content) }],
    generationConfig: {
      responseMimeType: "application/json",
      ...vertexStructuredOutput(schema, config.structuredSchemaMode || "json_schema"),
      maxOutputTokens: config.maxCompletionTokens || 16_000,
      ...(String(config.model).startsWith("gemini-3")
        ? { thinkingConfig: { thinkingLevel: REASONING_STAGES.has(name)
          ? config.reasoningThinkingLevel || "MEDIUM" : config.thinkingLevel || "LOW" } }
        : { temperature: 0.1 }),
    },
  };
}

function parseGcsUri(value) {
  const match = /^gs:\/\/([^/]+)\/(.*)$/i.exec(String(value || "").trim());
  return match ? { bucket: match[1], object: match[2] } : null;
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

function combinedSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function parseBatchResult(row) {
  const id = String(row?.key || "");
  const requestFingerprint = row?.instance?.request || row?.request
    ? crypto.createHash("sha256").update(JSON.stringify(row?.instance?.request || row.request)).digest("hex") : "";
  if (row?.status && !row?.response) return { id, requestFingerprint,
    error: row.status.message || JSON.stringify(row.status), code: String(row.status.code || "VERTEX_BATCH_ITEM_FAILED"), status: row.status };
  const payload = row?.response || row;
  const candidate = payload?.candidates?.[0];
  const finishReason = String(candidate?.finishReason || "");
  if (finishReason === "MAX_TOKENS") return { id, requestFingerprint, finishReason,
    error: "Vertex Batch structured output reached its token limit.", code: "MODEL_OUTPUT_LIMIT" };
  const output = candidate?.content?.parts?.map((part) => part.text || "").join("");
  const parsed = parseStructuredJson(output);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") return { id, requestFingerprint, finishReason,
    error: "Vertex Batch returned invalid structured JSON.", code: "INVALID_MODEL_OUTPUT" };
  const modelReportedId = String(parsed.value.batch_item_id || "");
  const value = { ...parsed.value };
  delete value.batch_item_id;
  return { id, requestFingerprint, modelReportedId, finishReason, output: value, usage: payload?.usageMetadata || null };
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
