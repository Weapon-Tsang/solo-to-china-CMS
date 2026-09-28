import { VertexGeminiClient } from "../src/ai/vertex-gemini-client.mjs";

const accessToken = process.env.STC_STAGE01_VERTEX_TOKEN;
const projectId = process.env.GOOGLE_CLOUD_PROJECT;
if (!accessToken || !projectId) throw new Error("STC_STAGE01_VERTEX_TOKEN and GOOGLE_CLOUD_PROJECT are required.");

const attempts = [];
const client = new VertexGeminiClient({
  provider: "vertex", projectId, location: "global", model: "gemini-3.8-flash", accessToken,
  structuredSchemaMode: "openapi", thinkingLevel: "LOW", maxCompletionTokens: 256, requestTimeoutMs: 60_000,
  stagePolicy: { version: "stage01-canary-1", stages: { stage01_canary: {
    class: "general", requires: ["structured_output"], thinking: "LOW",
    maxOutputTokens: 256, timeoutMs: 60_000, maxAttempts: 1,
  } } },
  beforeRequest: () => { if (attempts.length >= 1) throw new Error("Stage 01 canary exceeded one provider call."); },
  onModelCall: (metric) => attempts.push({ status: metric.attemptStatus, inputTokens: metric.inputTokens,
    outputTokens: metric.outputTokens, thinkingTokens: metric.thinkingTokens, errorCode: metric.errorCode }),
});

const started = Date.now();
try {
  const result = await client.completeJson({
    name: "stage01_canary",
    schema: { type: "object", additionalProperties: false, required: ["alwaysOpen", "priceCny"],
      properties: { alwaysOpen: { type: "boolean" }, priceCny: { type: "integer" } } },
    instructions: "Extract only the two requested facts from the source. Return JSON. Do not invent facts.",
    content: [{ type: "text", text: "Golden source: The visitor information desk is open 24 hours a day, every day. Admission is free (0 CNY)." }],
  });
  const pass = result?.output?.alwaysOpen === true && result?.output?.priceCny === 0;
  console.log(JSON.stringify({ result: pass ? "PASS" : "FAIL", providerReached: attempts.length > 0,
    schemaAccepted: attempts.some((item) => item.status === "succeeded"), calls: attempts.length,
    elapsedMs: Date.now() - started, semantics: { alwaysOpen: result?.output?.alwaysOpen,
      priceCny: result?.output?.priceCny }, attempts }));
  if (!pass) process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({ result: "FAIL", providerReached: attempts.length > 0,
    calls: attempts.length, elapsedMs: Date.now() - started,
    error: { code: error?.code || error?.name || "UNKNOWN", status: error?.status || null }, attempts }));
  process.exitCode = 1;
}
