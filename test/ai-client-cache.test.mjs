import assert from "node:assert/strict";
import test from "node:test";
import { createAiClient } from "../src/ai/client.mjs";

test("AI client reuses a bounded hash-identified structured response without another provider call", async () => {
  let requests = 0;
  const metrics = [];
  const client = createAiClient({
    provider: "kimi",
    apiKey: "test-key",
    model: "test-model",
    baseUrl: "https://example.test/v1",
    maxCompletionTokens: 100,
    onModelCall: (metric) => metrics.push(metric),
  }, async () => {
    requests += 1;
    return new Response(JSON.stringify({
      model: "test-model",
      choices: [{ finish_reason: "stop", message: { content: '{"answer":"cached"}' } }],
      usage: { prompt_tokens: 4, completion_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const input = {
    name: "cache_test",
    schema: { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "string" } } },
    instructions: "Return the answer.",
    content: "same evidence input",
  };

  const first = await client.completeJson({...input,telemetryContext:{queueWaitMs:17,executionRoute:"realtime"}});
  const second = await client.completeJson({...input,telemetryContext:{queueWaitMs:17,executionRoute:"realtime"}});

  assert.deepEqual(second, first);
  assert.equal(requests, 1);
  assert.equal(metrics.length, 2);
  assert.equal(metrics[1].attempts, 0);
  assert.equal(metrics[1].costUsd, 0);
  assert.equal(metrics[1].providerRequestMs, 0);
  assert.equal(metrics[1].totalStageMs, 17);
  assert.equal(metrics[1].executionRoute, "realtime");
  assert.match(metrics[1].promptHash, /^[a-f0-9]{64}$/);
  assert.match(metrics[1].inputHash, /^[a-f0-9]{64}$/);
});
