import assert from "node:assert/strict";
import test from "node:test";
import { VertexGeminiClient } from "../src/ai/vertex-gemini-client.mjs";

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
  assert.equal(body.systemInstruction.parts[0].text, "Be precise.");
});
