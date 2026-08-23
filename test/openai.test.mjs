import assert from "node:assert/strict";
import test from "node:test";
import { OpenAIExtractor } from "../src/ai/openai.mjs";

test("OpenAI adapter sends local evidence as text/image input and requests strict structured output", async () => {
  let request;
  const expected = {
    source: {
      language: "zh-CN", summary: "Summary", destination_name: "Beijing", destination_slug: "Beijing City",
      traveler_fit: ["solo"], practical_tips: [], warnings: [], confidence: 0.9,
    },
    claims: [{
      key: "Attraction Entry Gate", subject: "Attraction", predicate: "entry gate", value: "East",
      qualifiers: [], confidence: 0.8, source_quote: "从东门进入",
    }],
    blueprint: { format: "guide", hook: "Save time", angle: "first visit", sections: [], strengths: [], gaps: [] },
  };
  const fetchStub = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ model: "test-model", output_text: JSON.stringify(expected) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const extractor = new OpenAIExtractor({
    apiKey: "test-key", model: "test-model", baseUrl: "https://api.example.test/v1", maxImages: 1,
  }, fetchStub);

  const output = await extractor.extract({
    canonical_url: "https://www.xiaohongshu.com/explore/test", title: "Title", author_name: "Author",
    published_at: null, raw_text: "A sufficiently detailed note.",
    assets: [{ remote_url: "https://example.com/image.jpg" }, { remote_url: "https://example.com/ignored.jpg" }],
  });

  assert.equal(request.url, "https://api.example.test/v1/responses");
  assert.equal(request.body.store, false);
  assert.equal(request.body.text.format.type, "json_schema");
  assert.equal(request.body.text.format.strict, true);
  assert.equal(request.body.input[0].content.filter((item) => item.type === "input_image").length, 1);
  assert.equal(output.result.source.destination_slug, "beijing-city");
  assert.equal(output.result.claims[0].key, "attraction.entry.gate");
});
