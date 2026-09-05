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

test("Vertex extraction sends a public YouTube source as direct video evidence", async () => {
  let request;
  const expected = {
    source: { language: "zh-CN", summary: "Video summary", destination_name: "Chongqing", destination_slug: "chongqing", traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.8 },
    claims: [],
    blueprint: { format: "video notes", hook: "route", angle: "first visit", sections: [], strengths: [], gaps: [] },
  };
  const fetchStub = async (url, options = {}) => {
    if (String(url).startsWith("http://metadata.google.internal")) return new Response(JSON.stringify({ access_token: "fixture-token", expires_in: 300 }), { status: 200 });
    request = { url, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(expected) }] } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const extractor = new KimiExtractor({ provider: "vertex", projectId: "fixture-project", model: "gemini-3.8-flash", location: "global", maxImages: 0 }, fetchStub);
  const output = await extractor.extract({
    canonical_url: "manual-source://fixture", submitted_url: "https://www.youtube.com/watch?v=fixture",
    source_kind: "video_url", title: "Chongqing route video", author_name: "人工提交", published_at: null,
    raw_text: "Public video page metadata and an operator-selected travel source.", assets: [],
  });
  const video = request.body.contents[0].parts.find((part) => part.fileData);
  assert.equal(video.fileData.fileUri, "https://www.youtube.com/watch?v=fixture");
  assert.equal(video.fileData.mimeType, "video/mp4");
  assert.equal(output.method, "vertex_video");
});

test("non-Vertex models require an operator transcript for video URLs and uploaded video files", async () => {
  const extractor = new KimiExtractor({ provider: "kimi", apiKey: "fixture", model: "fixture", baseUrl: "https://api.example.test", maxImages: 0 }, async () => {
    throw new Error("request should not be attempted");
  });
  await assert.rejects(() => extractor.extract({
    submitted_url: "https://youtu.be/public-fixture", source_kind: "video_url", submission_metadata: { operatorNotesProvided: false }, assets: [],
  }), /requires a Vertex Gemini model.*operator-supplied transcript/);
  await assert.rejects(() => extractor.extract({
    submitted_url: "", source_kind: "video", submission_metadata: { operatorNotesProvided: false }, assets: [{ kind: "video" }],
  }), /requires a Vertex Gemini model.*operator-supplied transcript/);
});
