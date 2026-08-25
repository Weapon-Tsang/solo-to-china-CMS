import assert from "node:assert/strict";
import test from "node:test";
import { KimiExtractor } from "../src/ai/kimi.mjs";

test("Kimi adapter sends trusted image evidence as base64 input and requests strict structured output", async () => {
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
    if (String(url).includes("xhscdn.com")) {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    request = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ model: "test-model", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(expected) } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const extractor = new KimiExtractor({
    apiKey: "test-key", model: "test-model", baseUrl: "https://api.example.test/v1", maxImages: 1,
  }, fetchStub);

  const output = await extractor.extract({
    canonical_url: "https://www.xiaohongshu.com/explore/test", title: "Title", author_name: "Author",
    published_at: null, raw_text: "A sufficiently detailed note.",
    assets: [{ remote_url: "https://sns-img.xhscdn.com/image.jpg" }, { remote_url: "https://sns-img.xhscdn.com/ignored.jpg" }],
  });

  assert.equal(request.url, "https://api.example.test/v1/chat/completions");
  assert.equal(request.body.response_format.type, "json_schema");
  assert.equal(request.body.response_format.json_schema.strict, true);
  const image = request.body.messages[1].content.find((item) => item.type === "image_url");
  assert.match(image.image_url.url, /^data:image\/jpeg;base64,/);
  assert.equal(output.result.source.destination_slug, "beijing-city");
  assert.equal(output.result.claims[0].key, "attraction.entry.gate");
});
