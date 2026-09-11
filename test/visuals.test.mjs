import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { VertexImagen } from "../src/visuals/vertex-imagen.mjs";

test("Vertex Imagen stores a generated visual in the configured media directory", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-vertex-visual-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fetchStub = async (url) => {
    if (String(url).includes("metadata.google.internal")) return Response.json({ access_token: "metadata-token", expires_in: 300 });
    return Response.json({ predictions: [{ bytesBase64Encoded: Buffer.from("image-bytes").toString("base64"), mimeType: "image/png" }] });
  };
  const client = new VertexImagen({ enabled: true, provider: "vertex_imagen", projectId: "project", location: "us-central1", model: "imagen-4.0-generate-001", coverQuality: "1K", inlineQuality: "1K", mediaDir: directory, publicBaseUrl: "https://engine.example.com", requestTimeoutMs: 5_000 }, fetchStub);
  const output = await client.generate({ id: "visual_1", slot: 1, image_type: "illustration", acquisition_strategy: "generate_illustration", factual_image_required: false, image_role: "hero", aspect_ratio: "16:9", generation_prompt: "A quiet travel scene" }, { id: "draft_1" });
  assert.equal(output.provider, "vertex_imagen");
  assert.match(output.mediaUrl, /^https:\/\/engine\.example\.com\/media\/draft_1-/);
  assert.equal(fs.readFileSync(output.mediaPath).toString(), "image-bytes");
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
    return Response.json({ candidates: [{ content: { parts: [{ text: "Illustration created." }, { inlineData: { data: Buffer.from("gemini-image-bytes").toString("base64"), mimeType: "image/png" } }] } }] });
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
  assert.equal(fs.readFileSync(output.mediaPath).toString(), "gemini-image-bytes");
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

test("Chinese source-image localization sends the retained original and forbids scene changes", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-localize-visual-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, "authorized.png");
  const sourceBytes = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.from("original-scene")]);
  fs.writeFileSync(sourcePath, sourceBytes);
  let request;
  const client = new VertexImagen({ enabled: true, provider: "vertex_gemini", projectId: "project", location: "global",
    model: "gemini-3.1-flash-image", accessToken: "token", mediaDir: directory,
    publicBaseUrl: "https://engine.example.com", requestTimeoutMs: 5_000 }, async (url, options) => {
      request = { url: String(url), options };
      return Response.json({ candidates: [{ content: { parts: [{ inlineData: {
        data: Buffer.from("localized-image-bytes").toString("base64"), mimeType: "image/png",
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
  assert.equal(fs.readFileSync(output.mediaPath).toString(), "localized-image-bytes");
});
