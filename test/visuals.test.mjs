import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectImageBytes, VertexImagen } from "../src/visuals/vertex-imagen.mjs";

function pngBytes(width = 1600, height = 900, marker = "image") {
  const bytes = Buffer.alloc(256, 0);
  Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(bytes, 0);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  bytes.write(marker, 32, "utf8");
  return bytes;
}

function webpBytes(width = 1600, height = 900) {
  const bytes = Buffer.alloc(128, 0);
  bytes.write("RIFF", 0, "ascii"); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WEBP", 8, "ascii"); bytes.write("VP8X", 12, "ascii");
  bytes.writeUIntLE(width - 1, 24, 3); bytes.writeUIntLE(height - 1, 27, 3);
  return bytes;
}

test("pixel QA rejects truncated and undersized provider outputs before persistence", () => {
  assert.throws(() => inspectImageBytes(Buffer.from("image-bytes"), "image/png"),
    (error) => error.code === "IMAGE_PIXEL_QA_FAILED");
  assert.throws(() => inspectImageBytes(pngBytes(320, 180), "image/png"),
    (error) => error.code === "IMAGE_PIXEL_QA_FAILED" && error.dimensions.width === 320);
});

test("Vertex Imagen stores a generated visual in the configured media directory", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-vertex-visual-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fetchStub = async (url) => {
    if (String(url).includes("metadata.google.internal")) return Response.json({ access_token: "metadata-token", expires_in: 300 });
    return Response.json({ predictions: [{ bytesBase64Encoded: pngBytes().toString("base64"), mimeType: "image/png" }] });
  };
  const client = new VertexImagen({ enabled: true, provider: "vertex_imagen", projectId: "project", location: "us-central1", model: "imagen-4.0-generate-001", coverQuality: "1K", inlineQuality: "1K", mediaDir: directory, publicBaseUrl: "https://engine.example.com", requestTimeoutMs: 5_000 }, fetchStub);
  const output = await client.generate({ id: "visual_1", slot: 1, image_type: "illustration", acquisition_strategy: "generate_illustration", factual_image_required: false, image_role: "hero", aspect_ratio: "16:9", generation_prompt: "A quiet travel scene" }, { id: "draft_1" });
  assert.equal(output.provider, "vertex_imagen");
  assert.match(output.mediaUrl, /^https:\/\/engine\.example\.com\/media\/draft_1-/);
  assert.deepEqual(fs.readFileSync(output.mediaPath), pngBytes());
  assert.equal(output.metadata.pixel_qa.status, "passed");
  await assert.rejects(
    client.generate({ id: "visual_2", slot: 2, image_type: "real_world_photo", acquisition_strategy: "search_real_image", factual_image_required: true, image_role: "support", aspect_ratio: "3:2", generation_prompt: "" }, { id: "draft_1" }),
    /only non-factual illustrations/i,
  );
});

test("Gemini 3.1 Flash Image stores an inline image from the global Gemini endpoint", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-gemini-visual-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let request;
  const fetchStub = async (url, options = {}) => {
    if (String(url).includes("metadata.google.internal")) return Response.json({ access_token: "metadata-token", expires_in: 300 });
    request = { url: String(url), options };
    return Response.json({ candidates: [{ content: { parts: [{ text: "Illustration created." }, { inlineData: { data: pngBytes().toString("base64"), mimeType: "image/png" } }] } }] });
  };
  const client = new VertexImagen({ enabled: true, provider: "vertex_gemini", projectId: "project", location: "global", model: "gemini-3.1-flash-image", mediaDir: directory, publicBaseUrl: "https://engine.example.com", requestTimeoutMs: 5_000 }, fetchStub);
  const output = await client.generate({ id: "visual_1", slot: 1, image_type: "illustration", acquisition_strategy: "generate_illustration", factual_image_required: false, image_role: "hero", aspect_ratio: "16:9", generation_prompt: "A quiet travel scene" }, { id: "draft_1" });

  assert.equal(output.provider, "vertex_gemini");
  assert.equal(output.model, "gemini-3.1-flash-image");
  assert.match(request.url, /^https:\/\/aiplatform\.googleapis\.com\/v1\/projects\/project\/locations\/global\/publishers\/google\/models\/gemini-3\.1-flash-image:generateContent$/);
  const body = JSON.parse(request.options.body);
  assert.deepEqual(body.generationConfig.responseModalities, ["TEXT", "IMAGE"]);
  assert.equal(body.generationConfig.imageConfig.aspectRatio, "16:9");
  assert.match(body.contents.parts[0].text, /Do not depict people/i);
  assert.deepEqual(fs.readFileSync(output.mediaPath), pngBytes());
});

test("visual generation participates in the shared request gate and preserves provider retry timing", async () => {
  let gated = 0;
  const client = new VertexImagen({
    enabled: true, provider: "vertex_gemini", projectId: "project", location: "global", model: "gemini-3.1-flash-image",
    accessToken: "token", publicBaseUrl: "https://engine.example.com", requestTimeoutMs: 5_000,
    beforeRequest: async () => { gated += 1; },
  }, async () => Response.json({ error: { message: "Resource exhausted." } }, { status: 429, headers: { "retry-after": "2" } }));
  await assert.rejects(
    client.generate({ id: "visual_limited", slot: 1, image_type: "illustration", acquisition_strategy: "generate_illustration", factual_image_required: false, image_role: "hero", aspect_ratio: "16:9", generation_prompt: "A quiet travel scene" }, { id: "draft_1" }),
    (error) => error.status === 429 && error.retryable === true && error.retryAfterMs === 2_000,
  );
  assert.equal(gated, 1);
});

test("Flash Image transport failures retain their provider and retry classification", async () => {
  const client = new VertexImagen({
    enabled:true,provider:"vertex_gemini",projectId:"project",location:"global",model:"gemini-3.1-flash-image",
    accessToken:"token",publicBaseUrl:"https://engine.example.com",requestTimeoutMs:5_000,
  }, async()=>{throw new TypeError("fetch failed",{cause:{code:"UND_ERR_SOCKET"}});});
  await assert.rejects(client.generate({id:"visual-network",slot:1,image_type:"illustration",
    acquisition_strategy:"generate_illustration",factual_image_required:false,image_role:"hero",aspect_ratio:"16:9",
    generation_prompt:"A quiet travel scene"},{id:"draft-network"}),
  (error)=>error.code==="PROVIDER_TRANSPORT_FAILED"&&error.provider==="vertex_gemini"&&error.retryable===true);
});

test("Flash Image empty responses remain provider failures while explicit safety blocks stop", async () => {
  const config={enabled:true,provider:"vertex_gemini",projectId:"project",location:"global",model:"gemini-3.1-flash-image",
    accessToken:"token",publicBaseUrl:"https://engine.example.com",requestTimeoutMs:5_000};
  const visual={id:"visual-empty",slot:1,image_type:"illustration",acquisition_strategy:"generate_illustration",
    factual_image_required:false,image_role:"hero",aspect_ratio:"16:9",generation_prompt:"A quiet travel scene"};
  const transient=new VertexImagen(config,async()=>Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:"Unable to return an image this time."}]}}]}));
  await assert.rejects(transient.generate(visual,{id:"draft-empty"}),
    (error)=>error.code==="EMPTY_IMAGE_OUTPUT"&&error.provider==="vertex_gemini"&&error.retryable===true
      && /Unable to return an image/.test(error.message));
  const blocked=new VertexImagen(config,async()=>Response.json({promptFeedback:{blockReason:"SAFETY"}}));
  await assert.rejects(blocked.generate(visual,{id:"draft-blocked"}),
    (error)=>error.code==="IMAGE_SAFETY_BLOCKED"&&error.provider==="vertex_gemini"&&error.retryable===false);
});

test("Chinese source-image localization sends the retained original and forbids scene changes", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-localize-visual-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, "authorized.png");
  const sourceBytes = pngBytes(1200, 800, "original-scene");
  fs.writeFileSync(sourcePath, sourceBytes);
  let request;
  const client = new VertexImagen({ enabled: true, provider: "vertex_gemini", projectId: "project", location: "global",
    model: "gemini-3.1-flash-image", accessToken: "token", mediaDir: directory,
    publicBaseUrl: "https://engine.example.com", requestTimeoutMs: 5_000 }, async (url, options) => {
      request = { url: String(url), options };
      return Response.json({ candidates: [{ content: { parts: [{ inlineData: {
        data: pngBytes(1200, 800, "localized-image").toString("base64"), mimeType: "image/png",
      } }] } }] });
    });
  const output = await client.localizeSourceImage({ id: "visual_localized", slot: 1, image_type: "real_world_photo",
    acquisition_strategy: "localize_source_image", factual_image_required: true, source_asset_id: "asset-1",
    source_asset_local_path: sourcePath, source_asset_mime_type: "image/png", image_role: "hero", aspect_ratio: "16:9",
    generation_prompt: "" }, { id: "draft-localized" });
  const body = JSON.parse(request.options.body);
  assert.equal(body.contents.parts[1].inlineData.data, sourceBytes.toString("base64"));
  assert.match(body.contents.parts[0].text, /Preserve the photographed reality exactly/i);
  assert.match(body.contents.parts[0].text, /do not alter the scene/i);
  assert.deepEqual(fs.readFileSync(output.mediaPath), pngBytes(1200, 800, "localized-image"));
  assert.equal(body.generationConfig.imageConfig, undefined);
});

test("Chinese source-image localization accepts a retained WebP original without conversion", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-localize-webp-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, "authorized.webp");
  const sourceBytes = webpBytes();
  fs.writeFileSync(sourcePath, sourceBytes);
  let request;
  const client = new VertexImagen({ enabled: true, provider: "vertex_gemini", projectId: "project", location: "global",
    model: "gemini-3.1-flash-image", accessToken: "token", mediaDir: directory,
    publicBaseUrl: "https://engine.example.com", requestTimeoutMs: 5_000 }, async (url, options) => {
      request = { url: String(url), options };
      return Response.json({ candidates: [{ content: { parts: [{ inlineData: {
        data: pngBytes().toString("base64"), mimeType: "image/png",
      } }] } }] });
    });

  await client.localizeSourceImage({ id: "visual_webp", slot: 1, image_type: "real_world_photo",
    acquisition_strategy: "localize_source_image", factual_image_required: true, source_asset_id: "asset-webp",
    source_asset_local_path: sourcePath, source_asset_mime_type: "image/webp", image_role: "hero", aspect_ratio: "16:9",
    generation_prompt: "" }, { id: "draft-webp" });

  const body = JSON.parse(request.options.body);
  assert.equal(body.contents.parts[1].inlineData.mimeType, "image/webp");
  assert.equal(body.contents.parts[1].inlineData.data, sourceBytes.toString("base64"));
});
