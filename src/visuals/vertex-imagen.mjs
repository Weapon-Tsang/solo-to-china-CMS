import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { ProviderRequestError, providerTransportError } from "../ai/provider-schema.mjs";

const METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const VISUAL_QA_SCHEMA={type:"object",additionalProperties:false,
  required:["language","completeness","style","semantic","notes"],properties:{
    language:qaStatusSchema(),completeness:qaStatusSchema(),style:qaStatusSchema(),semantic:qaStatusSchema(),notes:{type:"string"},
  }};

function qaStatusSchema(){return {type:"object",additionalProperties:false,required:["status","reason"],properties:{
  status:{type:"string",enum:["passed","failed","needs_review","not_tested"]},reason:{type:"string"},
}};}

export class VertexImagen {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  get enabled() {
    return this.config.enabled && ["vertex_imagen", "vertex_gemini"].includes(this.config.provider) && Boolean(this.config.projectId && this.config.publicBaseUrl);
  }

  async generate(visual, draft, options = {}) {
    if (!this.enabled) throw new Error("Visual generation is not configured.");
    if (visual.image_type !== "illustration" || visual.acquisition_strategy !== "generate_illustration" || visual.factual_image_required) {
      throw new Error("The visual generator may generate only non-factual illustrations, never real-world photos, maps, or infographics.");
    }
    if (this.config.provider === "vertex_gemini") return this.generateGeminiImage(visual, draft, options);
    if (this.config.provider === "vertex_imagen") return this.generateImagenImage(visual, draft, options);
    throw new Error("The selected visual provider cannot generate image files.");
  }

  async localizeSourceImage(visual, draft, options = {}) {
    if (!this.enabled || this.config.provider !== "vertex_gemini") {
      throw Object.assign(new Error("中文图片翻译需要已配置的 Vertex Gemini 图片模型。"), { retryable: false, code: "IMAGE_LOCALIZATION_NOT_CONFIGURED" });
    }
    const transformStrategies=new Set(["localize_source_image","localize_photo_overlay","recompose_editorial_card",
      "recompose_collage","recompose_map_or_route"]);
    if (!transformStrategies.has(visual.acquisition_strategy) || !visual.source_asset_id) {
      throw Object.assign(new Error("图片翻译只接受已授权并已保存的实景原图。"), { retryable: false, code: "INVALID_IMAGE_LOCALIZATION_SOURCE" });
    }
    const source = readSourceImage(visual);
    const accessToken = await this.accessToken();
    const location = this.config.location || "global";
    const host = location === "global" ? "https://aiplatform.googleapis.com" : `https://${location}-aiplatform.googleapis.com`;
    const endpoint = `${host}/v1/projects/${encodeURIComponent(this.config.projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(this.config.model)}:generateContent`;
    const metadata=safeJson(visual.media_metadata_json || visual.media_metadata);
    const prompt = transformPrompt(visual,metadata);
    await this.config.beforeRequest?.({ provider: "vertex_gemini", model: this.config.model, stage: "localize_source_image", attempt: 1 });
    const response = await providerFetch(this.fetch, endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        contents: { role: "USER", parts: [{ text: prompt }, { inlineData: { mimeType: source.mimeType, data: source.base64 } }] },
        // Localization must retain the source crop and geometry. Asking the
        // provider for a new aspect ratio can truncate long cards or captions.
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      }),
      signal: combinedSignal(options.signal, this.config.requestTimeoutMs),
    }, "vertex_gemini", options.signal);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new ProviderRequestError("Vertex Gemini 图片翻译", response.status, payload?.error?.message || response.statusText,
      { ...(payload?.error || {}), retryAfter: response.headers.get("retry-after") });
    const part = payload?.candidates?.flatMap((candidate) => candidate?.content?.parts || []).find((item) => item?.inlineData?.data);
    if (!part) throw imageOutputError("Image localization model", payload);
    const sourceInspection=await inspectImageBytes(source.bytes,source.mimeType);
    const outputBytes=Buffer.from(part.inlineData.data,"base64");
    await inspectImageBytes(outputBytes,part.inlineData.mimeType);
    const qualityQa=await this.reviewTransformedImage({visual,metadata,source,outputBytes,
      outputMimeType:part.inlineData.mimeType,endpoint,accessToken,signal:options.signal});
    return this.storeImage({ base64: part.inlineData.data, mimeType: part.inlineData.mimeType, visual, draft,
      provider: "vertex_gemini", model: this.config.model, sourceDimensions: sourceInspection.dimensions,qualityQa });
  }

  async reviewTransformedImage({visual,metadata,source,outputBytes,outputMimeType,endpoint,accessToken,signal}) {
    await this.config.beforeRequest?.({provider:"vertex_gemini",model:this.config.model,stage:"visual_quality_qa",attempt:1});
    const response=await providerFetch(this.fetch,endpoint,{method:"POST",headers:{authorization:`Bearer ${accessToken}`,"content-type":"application/json"},
      body:JSON.stringify({contents:{role:"USER",parts:[{text:visualQaPrompt(visual,metadata)},
        {inlineData:{mimeType:source.mimeType,data:source.base64}},
        {inlineData:{mimeType:normalizeMime(outputMimeType),data:outputBytes.toString("base64")}}]},
      generationConfig:{responseModalities:["TEXT"],responseMimeType:"application/json",responseSchema:VISUAL_QA_SCHEMA}}),
      signal:combinedSignal(signal,this.config.requestTimeoutMs)},"vertex_gemini",signal);
    const payload=await response.json().catch(()=>({}));
    if (!response.ok) throw new ProviderRequestError("Vertex Gemini visual quality QA",response.status,payload?.error?.message || response.statusText,
      {...(payload?.error || {}),retryAfter:response.headers.get("retry-after")});
    const raw=payload?.candidates?.flatMap((candidate)=>candidate?.content?.parts || []).find((item)=>item?.text)?.text || "";
    let qa; try { qa=JSON.parse(raw); } catch { throw Object.assign(new Error("Visual quality QA returned invalid JSON."),{code:"VISUAL_QUALITY_QA_INVALID",retryable:true}); }
    const normalized=normalizeVisualQa(qa);
    const failed=Object.entries(normalized).filter(([key,value])=>key !== "notes" && value.status !== "passed");
    if (failed.length) throw Object.assign(new Error(`Visual quality QA did not pass: ${failed.map(([key,value])=>`${key}=${value.status}`).join(", ")}`),
      {code:"VISUAL_QUALITY_QA_FAILED",retryable:true,qualityQa:normalized});
    return normalized;
  }

  async generateImagenImage(visual, draft, options = {}) {
    const accessToken = await this.accessToken();
    const endpoint = `https://${this.config.location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(this.config.projectId)}/locations/${encodeURIComponent(this.config.location)}/publishers/google/models/${encodeURIComponent(this.config.model)}:predict`;
    await this.config.beforeRequest?.({ provider: "vertex_imagen", model: this.config.model, stage: "generate_visual", attempt: 1 });
    const response = await providerFetch(this.fetch, endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        instances: [{ prompt: visual.generation_prompt }],
        parameters: {
          sampleCount: 1,
          aspectRatio: visual.aspect_ratio,
          sampleImageSize: visual.image_role === "hero" ? this.config.coverQuality : this.config.inlineQuality,
          addWatermark: true,
          personGeneration: "dont_allow",
          safetyFilterLevel: "block_medium_and_above",
        },
      }),
      signal: combinedSignal(options.signal, this.config.requestTimeoutMs),
    }, "vertex_imagen", options.signal);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new ProviderRequestError("Vertex Imagen", response.status, payload?.error?.message || response.statusText,
      { ...(payload?.error || {}), retryAfter: response.headers.get("retry-after") });
    const prediction = payload?.predictions?.find((item) => item?.bytesBase64Encoded);
    if (!prediction) throw new Error("Vertex Imagen returned no renderable image bytes.");
    return await this.storeImage({
      base64: prediction.bytesBase64Encoded,
      mimeType: prediction.mimeType,
      visual,
      draft,
      provider: "vertex_imagen",
      model: this.config.model,
    });
  }

  async generateGeminiImage(visual, draft, options = {}) {
    const accessToken = await this.accessToken();
    const location = this.config.location || "global";
    const host = location === "global" ? "https://aiplatform.googleapis.com" : `https://${location}-aiplatform.googleapis.com`;
    const endpoint = `${host}/v1/projects/${encodeURIComponent(this.config.projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(this.config.model)}:generateContent`;
    const prompt = `${visual.generation_prompt}\n\nCreate an original editorial illustration only. Do not depict people, logos, watermarks, readable text, or a documentary-style real place.`;
    await this.config.beforeRequest?.({ provider: "vertex_gemini", model: this.config.model, stage: "generate_visual", attempt: 1 });
    const response = await providerFetch(this.fetch, endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        contents: { role: "USER", parts: [{ text: prompt }] },
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: { aspectRatio: visual.aspect_ratio },
        },
        safetySettings: [{
          method: "PROBABILITY",
          category: "HARM_CATEGORY_DANGEROUS_CONTENT",
          threshold: "BLOCK_MEDIUM_AND_ABOVE",
        }],
      }),
      signal: combinedSignal(options.signal, this.config.requestTimeoutMs),
    }, "vertex_gemini", options.signal);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new ProviderRequestError("Gemini 3.1 Flash Image", response.status, payload?.error?.message || response.statusText,
      { ...(payload?.error || {}), retryAfter: response.headers.get("retry-after") });
    const part = payload?.candidates?.flatMap((candidate) => candidate?.content?.parts || []).find((item) => item?.inlineData?.data);
    if (!part) throw imageOutputError("Gemini 3.1 Flash Image", payload);
    return await this.storeImage({
      base64: part.inlineData.data,
      mimeType: part.inlineData.mimeType,
      visual,
      draft,
      provider: "vertex_gemini",
      model: this.config.model,
    });
  }

  async storeImage({ base64, mimeType: suppliedMimeType, visual, draft, provider, model, sourceDimensions = null,
    qualityQa = defaultVisualQa() }) {
    const mimeType = normalizeMime(suppliedMimeType);
    const bytes = Buffer.from(base64, "base64");
    const inspection = await inspectImageBytes(bytes, mimeType);
    const expectedRatio = sourceDimensions
      ? sourceDimensions.width / sourceDimensions.height
      : parseAspectRatio(visual.aspect_ratio);
    if (expectedRatio && Math.abs(inspection.dimensions.width / inspection.dimensions.height - expectedRatio) / expectedRatio > 0.16) {
      throw Object.assign(new Error("Generated image dimensions do not preserve the required composition."), {
        code: "IMAGE_ASPECT_RATIO_MISMATCH", retryable: true, inspection, sourceDimensions,
      });
    }
    const extension = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png";
    const checksum = crypto.createHash("sha256").update(bytes).update(JSON.stringify({sourceAssetId:visual.source_asset_id || null,
      strategy:visual.acquisition_strategy,crop:safeJson(visual.media_metadata_json).crop || null,locale:"en",
      styleVersion:safeJson(visual.media_metadata_json).style_version || null})).digest("hex").slice(0, 32);
    const filename = `${draft.id}-${String(visual.slot).padStart(2, "0")}-${checksum}.${extension}`;
    fs.mkdirSync(this.config.mediaDir, { recursive: true });
    const mediaPath = path.join(this.config.mediaDir, filename);
    if (!fs.existsSync(mediaPath)) fs.writeFileSync(mediaPath, bytes, { mode: 0o640,flag:"wx" });
    return {
      mediaPath,
      mediaUrl: `${this.config.publicBaseUrl}/media/${filename}`,
      provider,
      model,
      mimeType,
      metadata: { binary_qa: { status: "passed", ...inspection, expected_ratio: expectedRatio || null,
        source_dimensions: sourceDimensions },pixel_qa:{status:"passed",...inspection,expected_ratio:expectedRatio || null,
        source_dimensions:sourceDimensions},quality_qa:qualityQa },
    };
  }

  async accessToken() {
    if (this.config.accessToken) return this.config.accessToken;
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const response = await providerFetch(this.fetch, METADATA_TOKEN_URL, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(5_000),
    }, "vertex_gemini");
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) throw new Error("Vertex Imagen could not obtain a Google Compute Engine service-account token.");
    this.token = payload.access_token;
    this.tokenExpiresAt = Date.now() + Math.max(60, Number(payload.expires_in || 300) - 60) * 1_000;
    return this.token;
  }
}

async function providerFetch(fetchImpl, url, init, provider, externalSignal = null) {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    if (externalSignal?.aborted) throw error;
    throw providerTransportError(provider, error);
  }
}

function imageOutputError(label, payload = {}) {
  const candidate = payload?.candidates?.[0] || {};
  const reason = String(payload?.promptFeedback?.blockReason || candidate?.finishReason || "NO_IMAGE_BYTES").slice(0,120);
  const responseText = (candidate?.content?.parts || []).map((part) => part?.text).filter(Boolean).join(" ")
    .replace(/\s+/g," ").trim().slice(0,300);
  const safetyBlocked = /SAFETY|BLOCKLIST|PROHIBITED|RECITATION/i.test(reason);
  const detail = responseText ? ` Provider text: ${responseText}` : "";
  return Object.assign(new Error(`${label} returned no renderable image bytes (${reason}).${detail}`), {
    name:"ProviderImageOutputError",
    code:safetyBlocked ? "IMAGE_SAFETY_BLOCKED" : "EMPTY_IMAGE_OUTPUT",
    provider:"vertex_gemini",
    retryable:!safetyBlocked,
  });
}

function combinedSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function transformPrompt(visual,metadata={}) {
  const decision=metadata.visual_decision || {};
  const analysis=metadata.source_analysis || {};
  const requiredText=(analysis.text_regions || []).map((region)=>({region_id:region.region_id,text:region.text || "",
    role:region.role || "unknown",preserve:Boolean(region.preserve)}));
  const facts={required_text:requiredText,entities:analysis.entities || [],primary_subjects:analysis.primary_subjects || [],
    editor_ui_regions:analysis.editor_ui_regions || [],preserve_region_ids:decision.preserveRegionIds || [],
    translate_region_ids:decision.translateRegionIds || []};
  const shared=`Use the attached authorized source image. Do not invent unreadable words, prices, times, routes, entities, people, places, or objects. Preserve every number, currency, operating time, negation, exception, arrow, route direction, ordering relationship, photograph, and factual relationship. Return one complete image with no cropped final line. Required source manifest: ${JSON.stringify(facts)}`;
  if (visual.acquisition_strategy === "recompose_editorial_card") return `${shared}\nRecompose the editorial card from scratch in concise natural English on a warm white background with restrained light-blue accents, dark readable type, generous spacing, and a clear information hierarchy. Remove Notes bars, editor chrome, canvas controls, selection handles, watermarks, and decorative red/black poster styling. Do not pretend this card is a documentary photograph.`;
  if (visual.acquisition_strategy === "recompose_collage") return `${shared}\nRecompose the collage for an English travel article. Keep every factual photo region unchanged and in its original meaning and order. Keep real-world storefront signs inside photos intact. Replace only author-written captions or overlays with concise English in a warm-white/light-blue editorial system. Never merge several restaurants into one venue or describe the collage as a single photograph.`;
  if (visual.acquisition_strategy === "recompose_map_or_route") return `${shared}\nRecompose the route or map in English. Preserve topology, start/end points, directions, arrows, step sequence, durations, distances, transfer relationships, and place identity exactly. If all required information cannot fit legibly, use a clearer multi-panel layout without omitting facts.`;
  return `${shared}\nTranslate only author-added Chinese overlay text into concise English. Preserve the documentary photograph exactly: scene, people, buildings, food, objects, crop, perspective, lighting, natural colors, logos, and real-world signage must remain unchanged.`;
}

function visualQaPrompt(visual,metadata={}) {
  return `The first image is the authorized source and the second is its proposed English derivative. Independently audit the derivative for delivery. Check language (all required author/editorial Chinese localized; preserved real-world signs allowed), completeness (all readable facts, numbers, currency, times, negations, exceptions, arrows and ordering preserved with no crop), style (warm-white/light-blue editorial treatment for recomposed cards, no Notes/editor UI, while documentary photos keep natural colors), and semantic fidelity (same subjects, places, photographs, route geometry and meaning; no fabricated content). Return failed or needs_review if uncertain. Strategy: ${visual.acquisition_strategy}. Manifest: ${JSON.stringify(metadata.source_analysis || {})}`;
}

function normalizeVisualQa(value={}) {
  const field=(name)=>({status:["passed","failed","needs_review","not_tested"].includes(value?.[name]?.status) ? value[name].status : "needs_review",
    reason:String(value?.[name]?.reason || "No reason supplied.").slice(0,1000)});
  return {language:field("language"),completeness:field("completeness"),style:field("style"),semantic:field("semantic"),
    notes:String(value.notes || "").slice(0,2000)};
}

function defaultVisualQa(){return {language:{status:"not_tested",reason:"Not a source-text transformation."},
  completeness:{status:"not_tested",reason:"Not a source-text transformation."},style:{status:"not_tested",reason:"No independent style audit was requested."},
  semantic:{status:"not_tested",reason:"No source transformation to compare."},notes:""};}

function safeJson(value){if(!value)return {};if(typeof value === "object")return value;try{return JSON.parse(value);}catch{return {};}}

function normalizeMime(value) {
  return ["image/png", "image/jpeg", "image/webp"].includes(value) ? value : "image/png";
}

export async function inspectImageBytes(bytes, suppliedMimeType = "") {
  if (!Buffer.isBuffer(bytes) || bytes.length < 64) throw invalidImage("Image output is empty or truncated.");
  let decoded;
  try { decoded=await sharp(bytes,{failOn:"error",limitInputPixels:40_000_000}).raw().toBuffer({resolveWithObject:true}); }
  catch (error) { throw Object.assign(invalidImage("Image output cannot be fully decoded."),{cause:error}); }
  const format=(await sharp(bytes,{failOn:"error",limitInputPixels:40_000_000}).metadata()).format;
  const mimeType=({png:"image/png",jpeg:"image/jpeg",webp:"image/webp"})[format] || "";
  const dimensions={width:decoded.info.width,height:decoded.info.height};
  if (!mimeType || !dimensions.width || !dimensions.height) throw invalidImage("Image output has no readable pixel dimensions.");
  if (suppliedMimeType && normalizeMime(suppliedMimeType) !== mimeType) throw invalidImage("Image MIME type does not match its bytes.");
  const pixels = dimensions.width * dimensions.height;
  if (Math.min(dimensions.width, dimensions.height) < 360 || pixels > 40_000_000) {
    throw Object.assign(invalidImage("Image output fails the delivery pixel budget."), { dimensions, pixels });
  }
  let minimum=255; let maximum=0; let visible=0;
  const channels=decoded.info.channels; const data=decoded.data; const stride=Math.max(channels,Math.floor(data.length/200_000/channels)*channels);
  for(let offset=0;offset+channels<=data.length;offset+=stride){
    const alpha=channels===4 ? data[offset+3] : 255; if(alpha===0)continue; visible+=1;
    for(let channel=0;channel<Math.min(3,channels);channel+=1){minimum=Math.min(minimum,data[offset+channel]);maximum=Math.max(maximum,data[offset+channel]);}
  }
  if (!visible || maximum-minimum < 2) throw invalidImage("Image output is blank or a solid-color placeholder.");
  return { mime_type:mimeType, dimensions, byte_length:bytes.length,
    decoded_pixel_bytes:data.length,dynamic_range:maximum-minimum,sha256:crypto.createHash("sha256").update(bytes).digest("hex") };
}

function jpegDimensions(bytes) {
  let offset=2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker=bytes[offset + 1];
    if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
      return { height:bytes.readUInt16BE(offset + 5), width:bytes.readUInt16BE(offset + 7) };
    }
    if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
    const length=bytes.readUInt16BE(offset + 2);
    if (length < 2) break;
    offset += 2 + length;
  }
  return null;
}

function webpDimensions(bytes) {
  const chunk=bytes.subarray(12,16).toString("ascii");
  if (chunk === "VP8X" && bytes.length >= 30) return {
    width:1 + bytes.readUIntLE(24,3), height:1 + bytes.readUIntLE(27,3),
  };
  if (chunk === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return {
    width:bytes.readUInt16LE(26) & 0x3fff, height:bytes.readUInt16LE(28) & 0x3fff,
  };
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits=bytes.readUInt32LE(21);
    return { width:1 + (bits & 0x3fff), height:1 + ((bits >> 14) & 0x3fff) };
  }
  return null;
}

function parseAspectRatio(value) {
  const match=String(value || "").match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  return match && Number(match[2]) ? Number(match[1]) / Number(match[2]) : null;
}

function invalidImage(message) {
  return Object.assign(new Error(message), { code:"IMAGE_PIXEL_QA_FAILED", retryable:true });
}

function readSourceImage(visual) {
  if (visual.source_asset_local_path) {
    const bytes = fs.readFileSync(visual.source_asset_local_path);
    if (!bytes.length) throw Object.assign(new Error("已保存的原图为空，无法翻译。"), { retryable: false });
    return { bytes, base64: bytes.toString("base64"), mimeType: normalizeSourceMime(visual.source_asset_mime_type, bytes) };
  }
  const match = String(visual.source_asset_data_url || "").match(/^data:(image\/(?:png|jpe?g|webp));base64,(.+)$/is);
  if (match) {
    const bytes = Buffer.from(match[2], "base64");
    return { bytes, mimeType: normalizeSourceMime(match[1].toLowerCase(), bytes), base64: match[2] };
  }
  throw Object.assign(new Error("没有找到已保存的原图文件，无法翻译。"), { retryable: false, code: "SOURCE_IMAGE_BYTES_MISSING" });
}

function normalizeSourceMime(supplied, bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0,4).toString("ascii") === "RIFF" && bytes.subarray(8,12).toString("ascii") === "WEBP") return "image/webp";
  if (["image/png", "image/jpeg", "image/jpg", "image/webp"].includes(supplied)) return supplied === "image/jpg" ? "image/jpeg" : supplied;
  throw Object.assign(new Error("原图格式不受图片翻译模型支持。"), { retryable: false, code: "SOURCE_IMAGE_FORMAT_UNSUPPORTED" });
}
