import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { inspectImageBytes, VertexImagen } from "../src/visuals/vertex-imagen.mjs";

async function pngBytes(width = 1600, height = 900, marker = "image") {
  const color=marker.includes("localized") ? {r:40,g:120,b:220} : {r:220,g:80,b:50};
  return sharp({create:{width,height,channels:3,background:color}}).png().composite([{
    input:Buffer.from(`<svg width="${width}" height="${height}"><rect x="20" y="20" width="100" height="100" fill="#fff"/></svg>`),
  }]).toBuffer();
}

async function webpBytes(width = 1600, height = 900) {
  return sharp({create:{width,height,channels:3,background:{r:30,g:90,b:160}}}).composite([{
    input:Buffer.from(`<svg width="${width}" height="${height}"><circle cx="80" cy="80" r="50" fill="#fff"/></svg>`),
  }]).webp().toBuffer();
}

test("pixel QA rejects truncated and undersized provider outputs before persistence", async () => {
  await assert.rejects(() => inspectImageBytes(Buffer.from("image-bytes"), "image/png"),
    (error) => error.code === "IMAGE_PIXEL_QA_FAILED");
  const undersized=await pngBytes(320,180);
  await assert.rejects(() => inspectImageBytes(undersized, "image/png"),
    (error) => error.code === "IMAGE_PIXEL_QA_FAILED" && error.dimensions.width === 320);
  const fake=Buffer.alloc(256);Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(fake);
  fake.write("IHDR",12);fake.writeUInt32BE(1600,16);fake.writeUInt32BE(900,20);
  await assert.rejects(()=>inspectImageBytes(fake,"image/png"),(error)=>error.code === "IMAGE_PIXEL_QA_FAILED");
});

test("Vertex Imagen stores a generated visual in the configured media directory", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-vertex-visual-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const rendered=await pngBytes();
  const fetchStub = async (url) => {
    if (String(url).includes("metadata.google.internal")) return Response.json({ access_token: "metadata-token", expires_in: 300 });
    return Response.json({ predictions: [{ bytesBase64Encoded: rendered.toString("base64"), mimeType: "image/png" }] });
  };
  const client = new VertexImagen({ enabled: true, provider: "vertex_imagen", projectId: "project", location: "us-central1", model: "imagen-4.0-generate-001", coverQuality: "1K", inlineQuality: "1K", mediaDir: directory, publicBaseUrl: "https://engine.example.com", requestTimeoutMs: 5_000 }, fetchStub);
  const output = await client.generate({ id: "visual_1", slot: 1, image_type: "illustration", acquisition_strategy: "generate_illustration", factual_image_required: false, image_role: "hero", aspect_ratio: "16:9", generation_prompt: "A quiet travel scene" }, { id: "draft_1" });
  assert.equal(output.provider, "vertex_imagen");
  assert.match(output.mediaUrl, /^https:\/\/engine\.example\.com\/media\/draft_1-/);
  assert.deepEqual(fs.readFileSync(output.mediaPath), rendered);
  assert.equal(output.metadata.pixel_qa.status, "passed");
  await assert.rejects(
    client.generate({ id: "visual_2", slot: 2, image_type: "real_world_photo", acquisition_strategy: "search_real_image", factual_image_required: true, image_role: "support", aspect_ratio: "3:2", generation_prompt: "" }, { id: "draft_1" }),
    /only non-factual illustrations/i,
  );
});

test("Gemini 3.1 Flash Image stores an inline image from the global Gemini endpoint", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-gemini-visual-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const rendered=await pngBytes();
  let request;
  const fetchStub = async (url, options = {}) => {
    if (String(url).includes("metadata.google.internal")) return Response.json({ access_token: "metadata-token", expires_in: 300 });
    request = { url: String(url), options };
    return Response.json({ candidates: [{ content: { parts: [{ text: "Illustration created." }, { inlineData: { data: rendered.toString("base64"), mimeType: "image/png" } }] } }] });
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
  assert.deepEqual(fs.readFileSync(output.mediaPath), rendered);
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
  const sourceBytes = await pngBytes(1200, 800, "original-scene");
  const localizedBytes=await pngBytes(1200,800,"localized-image");
  fs.writeFileSync(sourcePath, sourceBytes);
  const requests=[];
  const client = new VertexImagen({ enabled: true, provider: "vertex_gemini", projectId: "project", location: "global",
    model: "gemini-3.1-flash-image", accessToken: "token", mediaDir: directory,
    publicBaseUrl: "https://engine.example.com", requestTimeoutMs: 5_000 }, async (url, options) => {
      requests.push({ url: String(url), options });
      if(requests.length===2)return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(passedQa())}]}}]});
      return Response.json({ candidates: [{ content: { parts: [{ inlineData: {
        data: localizedBytes.toString("base64"), mimeType: "image/png",
      } }] } }] });
    });
  const output = await client.localizeSourceImage({ id: "visual_localized", slot: 1, image_type: "real_world_photo",
    acquisition_strategy: "localize_source_image", factual_image_required: true, source_asset_id: "asset-1",
    source_asset_local_path: sourcePath, source_asset_mime_type: "image/png", image_role: "hero", aspect_ratio: "3:2",
    generation_prompt: "" }, { id: "draft-localized" });
  const body = JSON.parse(requests[0].options.body);
  assert.match(requests[0].url,/models\/gemini-3\.1-flash-image:generateContent$/);
  assert.match(requests[1].url,/models\/gemini-3\.8-flash:generateContent$/,
    "quality QA must use the structured multimodal reviewer, not the image-generation model");
  assert.equal(body.contents.parts[1].inlineData.data, sourceBytes.toString("base64"));
  assert.match(body.contents.parts[0].text, /Preserve the documentary photograph exactly/i);
  assert.match(body.contents.parts[0].text, /scene, people, buildings, food/i);
  assert.deepEqual(fs.readFileSync(output.mediaPath), localizedBytes);
  assert.equal(body.generationConfig.imageConfig.aspectRatio, "3:2");
  assert.equal(output.metadata.quality_qa.semantic.status,"passed");
});

test("Chinese source-image localization accepts a retained WebP original without conversion", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-localize-webp-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, "authorized.webp");
  const sourceBytes = await webpBytes();
  const localizedBytes=await pngBytes();
  fs.writeFileSync(sourcePath, sourceBytes);
  const requests=[];
  const client = new VertexImagen({ enabled: true, provider: "vertex_gemini", projectId: "project", location: "global",
    model: "gemini-3.1-flash-image", accessToken: "token", mediaDir: directory,
    publicBaseUrl: "https://engine.example.com", requestTimeoutMs: 5_000 }, async (url, options) => {
      requests.push({ url: String(url), options });
      if(requests.length===2)return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(passedQa())}]}}]});
      return Response.json({ candidates: [{ content: { parts: [{ inlineData: {
        data: localizedBytes.toString("base64"), mimeType: "image/png",
      } }] } }] });
    });

  await client.localizeSourceImage({ id: "visual_webp", slot: 1, image_type: "real_world_photo",
    acquisition_strategy: "localize_source_image", factual_image_required: true, source_asset_id: "asset-webp",
    source_asset_local_path: sourcePath, source_asset_mime_type: "image/webp", image_role: "hero", aspect_ratio: "16:9",
    generation_prompt: "" }, { id: "draft-webp" });

  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.contents.parts[1].inlineData.mimeType, "image/webp");
  assert.equal(body.contents.parts[1].inlineData.data, sourceBytes.toString("base64"));
  assert.equal(body.generationConfig.imageConfig.aspectRatio, "16:9");
});

test("collage recomposition requests the source-shaped output and forbids dark card styling", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-collage-visual-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, "authorized-collage.png");
  const sourceBytes = await pngBytes(900,1200,"original-collage");
  const localizedBytes = await pngBytes(900,1200,"localized-collage");
  fs.writeFileSync(sourcePath,sourceBytes);
  const requests=[];
  const client=new VertexImagen({enabled:true,provider:"vertex_gemini",projectId:"project",location:"global",
    model:"gemini-3.1-flash-image",accessToken:"token",mediaDir:directory,
    publicBaseUrl:"https://engine.example.com",requestTimeoutMs:5_000},async(url,options)=>{
      requests.push({url:String(url),options});
      if(requests.length===2)return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(passedQa())}]}}]});
      return Response.json({candidates:[{content:{parts:[{inlineData:{data:localizedBytes.toString("base64"),mimeType:"image/png"}}]}}]});
    });
  await client.localizeSourceImage({id:"visual-collage",slot:1,image_type:"infographic",
    acquisition_strategy:"recompose_collage",factual_image_required:true,source_asset_id:"asset-collage",
    source_asset_local_path:sourcePath,source_asset_mime_type:"image/png",image_role:"support",aspect_ratio:"3:4",
    media_metadata_json:JSON.stringify({source_analysis:{text_regions:[{region_id:"caption",text:"source caption",role:"author_overlay",preserve:false}]},
      quality_qa:{language:{status:"passed",reason:"Readable"},completeness:{status:"failed",reason:"The prior derivative omitted subway in Tip 15."},
        style:{status:"passed",reason:"Style passed"},semantic:{status:"failed",reason:"The transport mode changed."}}})},
  {id:"draft-collage"});
  const body=JSON.parse(requests[0].options.body);
  assert.equal(body.generationConfig.imageConfig.aspectRatio,"3:4");
  assert.match(body.contents.parts[0].text,/overall canvas and all caption\/card surfaces must be warm white/i);
  assert.match(body.contents.parts[0].text,/Do not use dark blue, dark green/i);
  assert.match(body.contents.parts[0].text,/Natural colors inside the factual photo regions must remain unchanged/i);
  assert.match(body.contents.parts[0].text,/previous derivative failed independent QA/i);
  assert.match(body.contents.parts[0].text,/omitted subway in Tip 15/i);
  assert.match(body.contents.parts[0].text,/Proofread every English proper noun, transport mode/i);
});

test("text-only editorial cards use structured translation and deterministic uncropped layout",async(t)=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"solo-text-card-test-"));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const sourcePath=path.join(directory,"authorized-card.png");
  const sourceBytes=await pngBytes(900,1200,"source-card");
  fs.writeFileSync(sourcePath,sourceBytes);
  const requests=[];
  const translations={regions:[
    {region_id:"title",english_text:"Chongqing Travel Notes"},
    {region_id:"tip-15",english_text:"Choose chain hotels along metro lines, or an all-in-one stay with accommodation, leisure, massage, food, drinks, and entertainment."},
  ]};
  const client=new VertexImagen({enabled:true,provider:"vertex_gemini",projectId:"project",location:"global",
    model:"gemini-3.1-flash-image",qualityModel:"gemini-3.8-flash",accessToken:"token",mediaDir:directory,
    publicBaseUrl:"https://engine.example.com",requestTimeoutMs:5_000},async(url,options)=>{
      requests.push({url:String(url),options});
      if(requests.length===1)return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(translations)}]}}]});
      return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(passedQa())}]}}]});
    });
  const output=await client.localizeSourceImage({id:"visual-text-card",slot:3,image_type:"infographic",
    acquisition_strategy:"recompose_editorial_card",factual_image_required:true,source_asset_id:"asset-text-card",
    source_asset_local_path:sourcePath,source_asset_mime_type:"image/png",image_role:"support",aspect_ratio:"3:4",
    media_metadata_json:JSON.stringify({source_analysis:{asset_kind:"handwritten_card",photo_regions:[],text_regions:[
      {region_id:"title",text:"Chongqing notes",role:"author_overlay",readable:true,preserve:false},
      {region_id:"tip-15",text:"Tip 15 source",role:"author_overlay",readable:true,preserve:false},
      {region_id:"ui",text:"+",role:"ui_text",readable:true,preserve:false},
    ]},visual_decision:{translateRegionIds:["title","tip-15"]},quality_qa:{semantic:{status:"failed",reason:"Subway was omitted."}}})},
  {id:"draft-text-card"});
  assert.equal(requests.length,2,"text-only cards must not depend on raster text generation");
  assert.match(requests[0].url,/models\/gemini-3\.8-flash:generateContent$/);
  const translationBody=JSON.parse(requests[0].options.body);
  assert.equal(translationBody.generationConfig.responseMimeType,"application/json");
  assert.match(translationBody.contents.parts[0].text,/Subway was omitted/i);
  assert.match(translationBody.contents.parts[0].text,/Return every region_id exactly once/i);
  const inspection=await inspectImageBytes(fs.readFileSync(output.mediaPath),"image/png");
  assert.deepEqual(inspection.dimensions,{width:896,height:1195});
  assert.equal(output.provider,"vertex_gemini_text_layout");
  assert.equal(output.metadata.quality_qa.completeness.status,"passed");
});

test("production runtime installs the font used by deterministic editorial cards",()=>{
  const dockerfile=fs.readFileSync(path.resolve("Dockerfile"),"utf8");
  assert.match(dockerfile,/apt-get install[^\n]*fonts-dejavu-core/,
    "the slim production image must include DejaVu Sans instead of rendering card text as tofu squares");
});

function passedQa(){return {language:{status:"passed",reason:"English overlays are readable."},
  completeness:{status:"passed",reason:"All source facts are present."},style:{status:"passed",reason:"Style matches the requested path."},
  semantic:{status:"passed",reason:"Source meaning and imagery are unchanged."},notes:""};}
