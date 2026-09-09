import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAiClient } from "../src/ai/client.mjs";
import { parseBatchResult, VertexGeminiClient } from "../src/ai/vertex-gemini-client.mjs";

test("Vertex Gemini uses the configured model and structured JSON response", async () => {
  let request;
  const client = new VertexGeminiClient({
    projectId: "test-project", location: "us-central1", model: "gemini-3.1-pro-preview",
    accessToken: "test-access-token", maxCompletionTokens: 1000,
  }, async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }), { status: 200 });
  });
  const result = await client.completeJson({ name: "test", schema: { type: "object" }, instructions: "Be precise.", content: "source text" });
  assert.deepEqual(result, { output: { ok: true }, model: "gemini-3.1-pro-preview" });
  assert.match(request.url, /gemini-3\.1-pro-preview:generateContent$/);
  const body = JSON.parse(request.options.body);
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.equal(body.generationConfig.temperature, undefined);
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, "LOW");
  assert.equal(body.systemInstruction.parts[0].text, "Be precise.");
});

test("AI client dispatches an old Batch poll through its stored Vertex adapter after a Kimi switch", async () => {
  let requestUrl = "";
  const config = {
    provider: "vertex", projectId: "project-old", location: "global", model: "model-old",
    batchBucket: "valid-bucket", batchEnabled: true, accessToken: "test-token",
  };
  const client = createAiClient(config, async (url) => {
    requestUrl = String(url);
    return new Response(JSON.stringify({ name: "projects/project-old/locations/global/batchPredictionJobs/job-1", state: "JOB_STATE_RUNNING" }), { status: 200 });
  });
  config.provider = "kimi";
  config.model = "kimi-new";
  const result = await client.getBatch("projects/project-old/locations/global/batchPredictionJobs/job-1", {
    provider: "vertex", project_id: "project-old", location: "global", model: "model-old",
  });
  assert.equal(result.state, "JOB_STATE_RUNNING");
  assert.match(requestUrl, /aiplatform\.googleapis\.com\/v1\/projects\/project-old\/locations\/global\/batchPredictionJobs\/job-1$/);
});

test("Vertex Gemini reserves medium thinking for writing and review stages", async () => {
  let body;
  const client = new VertexGeminiClient({
    projectId: "test-project", location: "global", model: "gemini-3.8-flash", accessToken: "test-token",
    thinkingLevel: "LOW", reasoningThinkingLevel: "MEDIUM",
  }, async (_url, options) => {
    body = JSON.parse(options.body);
    return Response.json({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] });
  });
  await client.completeJson({ name: "content_brief", schema: { type: "object" }, instructions: "Plan.", content: "evidence" });
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, "MEDIUM");
});

test("Vertex Gemini converts shared text parts and retries malformed structured output once", async () => {
  const requests = [];
  const gatedAttempts = [];
  const client = new VertexGeminiClient({
    projectId: "test-project", location: "global", model: "gemini-3.8-flash", accessToken: "test-token",
    beforeRequest: async (request) => gatedAttempts.push(request),
  }, async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const text = requests.length === 1 ? '{"ok":' : '```json\n{"ok":true}\n```';
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }] });
  });
  const result = await client.completeJson({
    schema: { type: "object" }, instructions: "Be precise.", content: [{ type: "text", text: "source text" }],
  });
  assert.deepEqual(result.output, { ok: true });
  assert.equal(requests.length, 2);
  assert.deepEqual(gatedAttempts.map((item) => item.attempt), [1, 2]);
  assert.deepEqual(requests[0].contents[0].parts, [{ text: "source text" }]);
  assert.equal("type" in requests[0].contents[0].parts[0], false);
});

test("Vertex Gemini reports an exhausted structured output before attempting to parse it", async () => {
  const client = new VertexGeminiClient({
    projectId: "test-project", location: "global", model: "gemini-3.8-flash", accessToken: "test-token",
  }, async () => Response.json({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: '{"partial":' }] } }] }));
  await assert.rejects(() => client.completeJson({
    schema: { type: "object" }, instructions: "Be precise.", content: "source text",
  }), /structured output reached its token limit/);
});

test("Vertex Gemini uses the global API host for Gemini 3.8 Flash", async () => {
  let requestedUrl = "";
  const client = new VertexGeminiClient({
    projectId: "test-project", location: "global", model: "gemini-3.8-flash",
    accessToken: "test-access-token", maxCompletionTokens: 1000,
  }, async (url) => {
    requestedUrl = url;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }), { status: 200 });
  });
  await client.completeJson({ schema: { type: "object" }, instructions: "Be precise.", content: "source text" });
  assert.equal(requestedUrl, "https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/publishers/google/models/gemini-3.8-flash:generateContent");
});

test("Vertex Gemini loads a small uploaded video as inline multimodal evidence", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-vertex-video-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "route.mp4");
  fs.writeFileSync(filename, Buffer.from("video fixture"));
  const client = new VertexGeminiClient({ sourceUploadsDir: directory, maxInlineVideoBytes: 1024 }, async () => new Response("unexpected"));
  const result = await client.videoParts([{ kind: "video", local_path: filename, mime_type: "video/mp4" }]);
  assert.equal(result.attempted, 1);
  assert.equal(result.parts[0].inlineData.mimeType, "video/mp4");
  assert.equal(Buffer.from(result.parts[0].inlineData.data, "base64").toString(), "video fixture");
});

test("Vertex Gemini downloads an authorized Xiaohongshu CDN video for multimodal evidence", async () => {
  const requests = [];
  const client = new VertexGeminiClient({ maxInlineVideoBytes: 1024, maxVideoBytes: 2048, imageTimeoutMs: 1000 }, async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(Buffer.from("remote video fixture"), { status: 200, headers: { "content-type": "video/mp4", "content-length": "20" } });
  });
  const result = await client.videoParts([{ kind: "video", remote_url: "https://sns-video-bd.xhscdn.com/stream/note.mp4", mime_type: "" }]);
  assert.equal(requests[0].options.headers.referer, "https://www.xiaohongshu.com/");
  assert.equal(result.parts[0].inlineData.mimeType, "video/mp4");
  assert.equal(Buffer.from(result.parts[0].inlineData.data, "base64").toString(), "remote video fixture");
});

test("Vertex Gemini rejects untrusted remote video hosts and oversized responses", async () => {
  const client = new VertexGeminiClient({ maxVideoBytes: 4 }, async () => new Response(Buffer.from("oversized"), {
    status: 200, headers: { "content-type": "video/mp4", "content-length": "9" },
  }));
  await assert.rejects(() => client.videoParts([{ kind: "video", remote_url: "https://example.com/video.mp4" }]), /trusted downloadable/);
  await assert.rejects(() => client.videoParts([{ kind: "video", remote_url: "https://sns-video-bd.xhscdn.com/video.mp4" }]), /size limit/);
});

test("Vertex Gemini prepares every video in a multi-video source", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-vertex-videos-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const assets = ["one.mp4", "two.mp4", "three.mp4"].map((name, index) => {
    const filename = path.join(directory, name);
    fs.writeFileSync(filename, Buffer.from(`video fixture ${index}`));
    return { kind: "video", local_path: filename, mime_type: "video/mp4" };
  });
  const client = new VertexGeminiClient({ sourceUploadsDir: directory, maxInlineVideoBytes: 1024 }, async () => new Response("unexpected"));
  const result = await client.videoParts(assets);
  assert.equal(result.attempted, 3);
  assert.equal(result.parts.length, 3);
  assert.deepEqual(result.parts.map((part) => Buffer.from(part.inlineData.data, "base64").toString()),
    ["video fixture 0", "video fixture 1", "video fixture 2"]);
});

test("Vertex Gemini stages a large uploaded video in Cloud Storage and deletes the temporary model input", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-vertex-video-gcs-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "route.mp4");
  fs.writeFileSync(filename, Buffer.from("video fixture larger than inline threshold"));
  const requests = [];
  const client = new VertexGeminiClient({
    sourceUploadsDir: directory, maxInlineVideoBytes: 4, videoBucket: "solo-video-fixtures", accessToken: "test-access-token",
  }, async (url, options) => {
    requests.push({ url: String(url), options });
    return options.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ name: "uploaded" });
  });
  const result = await client.videoParts([{ kind: "video", local_path: filename, mime_type: "video/mp4" }]);
  assert.match(result.parts[0].fileData.fileUri, /^gs:\/\/solo-video-fixtures\/manual-source-input\//);
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.headers["content-type"], "video/mp4");
  await result.cleanup();
  assert.equal(requests[1].options.method, "DELETE");
});

test("Vertex Gemini submits, polls, reads, and cleans up a Cloud Storage batch", async () => {
  const calls = [];
  const output = { batch_item_id: "batch_item_1", source: { language: "zh-CN", summary: "route", destination_name: "Chongqing", destination_slug: "chongqing", traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.9 }, claims: [] };
  const client = new VertexGeminiClient({
    projectId: "fixture-project", location: "global", model: "gemini-3.8-flash", accessToken: "token",
    batchEnabled: true, batchBucket: "fixture-bucket", batchPollMs: 60_000,
  }, async (url, options = {}) => {
    const target = String(url);
    calls.push({ target, options });
    if (target.includes("upload/storage/v1")) return new Response("{}", { status: 200 });
    if (target.endsWith("/batchPredictionJobs") && options.method === "POST") return Response.json({ name: "projects/fixture-project/locations/global/batchPredictionJobs/job-1", state: "JOB_STATE_PENDING" });
    if (target.includes("batchPredictionJobs/job-1")) return Response.json({ state: "JOB_STATE_SUCCEEDED", outputInfo: { gcsOutputDirectory: "gs://fixture-bucket/vertex-batch/output/" } });
    if (target.includes("storage/v1/b/fixture-bucket/o?") && !target.includes("alt=media")) return Response.json({ items: [{ name: "vertex-batch/output/predictions.jsonl" }] });
    if (target.includes("predictions.jsonl") && target.includes("alt=media")) return new Response(`${JSON.stringify({ key: "batch_item_1", response: { candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] }, finishReason: "STOP" }] } })}\n`);
    if (options.method === "DELETE") return new Response(null, { status: 204 });
    throw new Error(`Unexpected request: ${target}`);
  });
  const request = client.prepareBatchRequest({ id: "batch_item_1", name: "source_research_extraction",
    schema: { type: "object", additionalProperties: false, required: ["source", "claims"], properties: { source: { type: "object" }, claims: { type: "array" } } },
    instructions: "Extract evidence.", content: "source" });
  const created = await client.createBatch([request]);
  const status = await client.getBatch(created.name);
  const rows = await client.readBatchOutput(status);
  assert.equal(status.state, "JOB_STATE_SUCCEEDED");
  assert.equal(rows[0].id, "batch_item_1");
  assert.deepEqual(rows[0].output.claims, []);
  const uploaded = String(calls.find((call) => call.target.includes("upload/storage/v1"))?.options?.body);
  assert.match(uploaded, /transport_key/);
  assert.match(uploaded, /batch_item_id/);
  const createBody = JSON.parse(calls.find((call) => call.target.endsWith("/batchPredictionJobs"))?.options?.body);
  assert.deepEqual(createBody.instanceConfig, { instanceType: "object", keyField: "transport_key" });
  await client.cleanupBatch({ ...created, ...status });
  assert.ok(calls.some((call) => call.options.method === "DELETE"));
});

test("Vertex Batch correlation survives provider errors, output limits, and invalid model JSON", () => {
  const providerError = parseBatchResult({ key: "transport-error", status: { code: 13, message: "backend failed" } });
  assert.equal(providerError.id, "transport-error");
  assert.equal(providerError.code, "13");

  const outputLimit = parseBatchResult({ key: "transport-limit", response: { candidates: [{ finishReason: "MAX_TOKENS" }] } });
  assert.equal(outputLimit.id, "transport-limit");
  assert.equal(outputLimit.code, "MODEL_OUTPUT_LIMIT");
  assert.equal(outputLimit.finishReason, "MAX_TOKENS");

  const invalid = parseBatchResult({ key: "transport-invalid", response: { candidates: [{ finishReason: "STOP",
    content: { parts: [{ text: "not json" }] } }] } });
  assert.equal(invalid.id, "transport-invalid");
  assert.equal(invalid.code, "INVALID_MODEL_OUTPUT");

  const success = parseBatchResult({ key: "transport-authoritative", response: { candidates: [{ finishReason: "STOP",
    content: { parts: [{ text: JSON.stringify({ batch_item_id: "model-wrong", value: 1 }) }] } }] } });
  assert.equal(success.id, "transport-authoritative");
  assert.equal(success.modelReportedId, "model-wrong");
  assert.deepEqual(success.output, { value: 1 });
});
