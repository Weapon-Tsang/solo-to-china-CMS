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
const EDITORIAL_TRANSLATION_SCHEMA={type:"object",additionalProperties:false,required:["regions"],properties:{
  regions:{type:"array",items:{type:"object",additionalProperties:false,required:["region_id","english_text"],properties:{
    region_id:{type:"string"},english_text:{type:"string"},
  }}},
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
    const location = this.config.location || "global";
    const host = location === "global" ? "https://aiplatform.googleapis.com" : `https://${location}-aiplatform.googleapis.com`;
    const endpoint = `${host}/v1/projects/${encodeURIComponent(this.config.projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(this.config.model)}:generateContent`;
    const metadata=safeJson(visual.media_metadata_json || visual.media_metadata);
    if (shouldRenderEditorialTextCard(visual,metadata)) {
      return this.renderEditorialTextCard({visual,draft,metadata,source,signal:options.signal,options});
    }
    const sourceInspection=await inspectImageBytes(source.bytes,source.mimeType);
    const transformInputHash=hashBytes(Buffer.concat([source.bytes,Buffer.from(JSON.stringify({
      visual_id:visual.id,asset_fingerprint:options.expectedFingerprint || visual.asset_fingerprint || "",
      strategy:visual.acquisition_strategy,aspect_ratio:visual.aspect_ratio,model:this.config.model,
    }))]));
    const resumed=await this.resumeCandidate({visual,draft,source,sourceInspection,transformInputHash,options,metadata});
    if (resumed) return resumed;
    const accessToken = await this.accessToken();
    const prompt = transformPrompt(visual,metadata);
    const transformed=await this.trackedRequest({provider:"vertex_gemini",model:this.config.model,stage:"localize_source_image",
      endpoint,visual,options},async()=>{
      const response = await providerFetch(this.fetch, endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          contents: { role: "USER", parts: [{ text: prompt }, { inlineData: { mimeType: source.mimeType, data: source.base64 } }] },
          // Request the nearest supported ratio selected from the stored source
          // dimensions. Pixel and semantic QA still reject any crop or omission.
          generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: visual.aspect_ratio } },
        }),
        signal: combinedSignal(options.signal, this.config.requestTimeoutMs),
      }, "vertex_gemini", options.signal);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new ProviderRequestError("Vertex Gemini 图片翻译", response.status, body?.error?.message || response.statusText,
        { ...(body?.error || {}), retryAfter: response.headers.get("retry-after"),
          providerRequestId:response.headers.get("x-request-id") || response.headers.get("x-goog-request-id") });
      const outputPart=body?.candidates?.flatMap((candidate) => candidate?.content?.parts || []).find((item) => item?.inlineData?.data);
      if (!outputPart) throw imageOutputError("Image localization model", body);
      return {payload:body,part:outputPart};
    });
    const {part}=transformed;
    const outputBytes=Buffer.from(part.inlineData.data,"base64");
    await inspectImageBytes(outputBytes,part.inlineData.mimeType);
    const candidate=await this.persistCandidate({visual,draft,source,outputBytes,mimeType:part.inlineData.mimeType,
      provider:"vertex_gemini",model:this.config.model,transformInputHash,options});
    return this.reviewAndPromoteCandidate({candidate,visual,draft,metadata,source,sourceInspection,outputBytes,
      outputMimeType:part.inlineData.mimeType,accessToken,options});
  }

  async renderEditorialTextCard({visual,draft,metadata,source,accessToken=null,signal,options={}}) {
    const location=this.config.location || "global";
    const host=location === "global" ? "https://aiplatform.googleapis.com" : `https://${location}-aiplatform.googleapis.com`;
    const translationModel=this.config.qualityModel || "gemini-3.8-flash";
    const endpoint=`${host}/v1/projects/${encodeURIComponent(this.config.projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(translationModel)}:generateContent`;
    const regions=editorialTranslationRegions(metadata);
    const priorFeedback=visualRetryFeedback(metadata);
    const prompt=`Translate every source region into concise, natural English for a travel editorial card. Return every region_id exactly once and no extra ids. Preserve every proper noun, number, time, price, transport mode, negation, warning, list item, and factual qualifier. Do not summarize or omit details. Remove no source content except regions already excluded from this manifest. ${priorFeedback ? `The prior derivative failed QA; correct these defects: ${JSON.stringify(priorFeedback)}.` : ""} Source regions: ${JSON.stringify(regions)}`;
    const sourceInspection=await inspectImageBytes(source.bytes,source.mimeType);
    const sourceHash=hashBytes(source.bytes);
    const regionManifestHash=hashBytes(Buffer.from(JSON.stringify(regions)));
    const translationInputHash=hashBytes(Buffer.concat([source.bytes,Buffer.from(JSON.stringify({visual_id:visual.id,
      strategy:visual.acquisition_strategy,translation_model:translationModel,
      translation_prompt_version:"editorial-card-translation-1",regions,prior_feedback:priorFeedback}))]));
    let artifact=await this.config.findVisualTranslationArtifact?.({visualId:visual.id,translationInputHash});
    const checkpointIdentity={visualId:visual.id,draftId:draft.id,sourceHash,
      regionManifestHash,model:translationModel};
    if (artifact && !completeTranslationArtifact(artifact,regions,translationInputHash,checkpointIdentity)) artifact=null;
    let token=accessToken;
    if (!artifact) {
      token=token || await this.accessToken();
      const payload=await this.trackedRequest({provider:"vertex_gemini",model:translationModel,stage:"translate_editorial_card",
        endpoint,visual,options},async()=>{
        const response=await providerFetch(this.fetch,endpoint,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},
          body:JSON.stringify({contents:{role:"USER",parts:[{text:prompt}]},generationConfig:{responseModalities:["TEXT"],
            responseMimeType:"application/json",responseSchema:EDITORIAL_TRANSLATION_SCHEMA}}),
          signal:combinedSignal(signal,this.config.requestTimeoutMs)},"vertex_gemini",signal);
        const body=await response.json().catch(()=>({}));
        if (!response.ok) throw new ProviderRequestError("Vertex Gemini editorial card translation",response.status,
          body?.error?.message || response.statusText,{...(body?.error || {}),retryAfter:response.headers.get("retry-after"),
            providerRequestId:response.headers.get("x-request-id") || response.headers.get("x-goog-request-id")});
        return body;
      });
      const raw=payload?.candidates?.flatMap((candidate)=>candidate?.content?.parts || []).find((item)=>item?.text)?.text || "";
      let translated; try { translated=JSON.parse(raw); }
      catch { throw Object.assign(new Error("Editorial card translation returned invalid JSON."),{code:"EDITORIAL_TRANSLATION_INVALID",retryable:true}); }
      const expected=new Set(regions.map((region)=>region.region_id));
      const entries=Array.isArray(translated?.regions) ? translated.regions : [];
      const actual=new Set(entries.map((entry)=>String(entry?.region_id || "")));
      if (entries.length !== expected.size || actual.size !== expected.size || [...expected].some((id)=>!actual.has(id))
        || entries.some((entry)=>!String(entry?.english_text || "").trim())) {
        throw Object.assign(new Error("Editorial card translation did not return one complete English region for every source region."),
          {code:"EDITORIAL_TRANSLATION_INCOMPLETE",retryable:true});
      }
      const ordered=regions.map((region)=>({region_id:region.region_id,
        english_text:String(entries.find((entry)=>entry.region_id === region.region_id).english_text).trim()}));
      artifact=await this.config.saveVisualTranslationArtifact?.({visualId:visual.id,draftId:draft.id,
        translationInputHash,sourceHash,regionManifestHash,provider:"vertex_gemini",model:translationModel,
        providerResponseId:payload?.responseId || payload?.response_id || null,regions:ordered,
        expectedFingerprint:options.expectedFingerprint || visual.asset_fingerprint || null});
      if (!artifact || !completeTranslationArtifact(artifact,regions,translationInputHash,checkpointIdentity)) {
        throw Object.assign(new Error("Editorial translation was not durably checkpointed."),
          {code:"EDITORIAL_TRANSLATION_CHECKPOINT_MISSING",retryable:true});
      }
    }
    const ordered=Array.isArray(artifact.regions) ? artifact.regions : [];
    const layoutMaxHeight=boundedEditorialCardHeight(this.config.editorialCardMaxHeight);
    const transformInputHash=hashBytes(Buffer.from(JSON.stringify({translation_input_hash:translationInputHash,
      aspect_ratio:visual.aspect_ratio,regions:ordered,layout_max_height:layoutMaxHeight,
      layout_version:"editorial-card-layout-3"})));
    const resumed=await this.resumeCandidate({visual,draft,source,sourceInspection,transformInputHash,options,metadata,accessToken:token});
    if (resumed) return resumed;
    let rendered;
    try { rendered=await renderTextCardPng(ordered,visual.aspect_ratio,{maxHeight:layoutMaxHeight}); }
    catch (error) {
      error.details={...(error.details || {}),visualId:visual.id,substage:"deterministic_text_layout",
        translationCheckpoint:"persisted",translationInputHash};
      throw error;
    }
    const outputBytes=rendered.bytes;
    const candidate=await this.persistCandidate({visual,draft,source,outputBytes,mimeType:"image/png",
      provider:"vertex_gemini_text_layout",model:translationModel,transformInputHash,options});
    return this.reviewAndPromoteCandidate({candidate,visual,draft,metadata,source,sourceInspection,outputBytes,
      outputMimeType:"image/png",accessToken:token || await this.accessToken(),options:{...options,signal,layoutTelemetry:rendered.telemetry}});
  }

  async reviewTransformedImage({visual,metadata,source,outputBytes,outputMimeType,accessToken,signal,options={}}) {
    const location=this.config.location || "global";
    const host=location === "global" ? "https://aiplatform.googleapis.com" : `https://${location}-aiplatform.googleapis.com`;
    const qualityModel=this.config.qualityModel || "gemini-3.8-flash";
    const endpoint=`${host}/v1/projects/${encodeURIComponent(this.config.projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(qualityModel)}:generateContent`;
    const payload=await this.trackedRequest({provider:"vertex_gemini",model:qualityModel,stage:"visual_quality_qa",
      endpoint,visual,options:{...options,signal}},async()=>{
      const response=await providerFetch(this.fetch,endpoint,{method:"POST",headers:{authorization:`Bearer ${accessToken}`,"content-type":"application/json"},
        body:JSON.stringify({contents:{role:"USER",parts:[{text:visualQaPrompt(visual,metadata)},
          {inlineData:{mimeType:source.mimeType,data:source.base64}},
          {inlineData:{mimeType:normalizeMime(outputMimeType),data:outputBytes.toString("base64")}}]},
        generationConfig:{responseModalities:["TEXT"],responseMimeType:"application/json",responseSchema:VISUAL_QA_SCHEMA}}),
        signal:combinedSignal(signal,this.config.requestTimeoutMs)},"vertex_gemini",signal);
      const body=await response.json().catch(()=>({}));
      if (!response.ok) throw new ProviderRequestError("Vertex Gemini visual quality QA",response.status,body?.error?.message || response.statusText,
        {...(body?.error || {}),retryAfter:response.headers.get("retry-after"),
          providerRequestId:response.headers.get("x-request-id") || response.headers.get("x-goog-request-id")});
      return body;
    });
    const raw=payload?.candidates?.flatMap((candidate)=>candidate?.content?.parts || []).find((item)=>item?.text)?.text || "";
    let qa; try { qa=JSON.parse(raw); } catch { throw Object.assign(new Error("Visual quality QA returned invalid JSON."),{code:"VISUAL_QUALITY_QA_INVALID",retryable:true}); }
    const normalized=normalizeVisualQa(qa);
    const failed=Object.entries(normalized).filter(([key,value])=>key !== "notes" && value.status !== "passed");
    if (failed.length) throw Object.assign(new Error(`Visual quality QA did not pass: ${failed.map(([key,value])=>`${key}=${value.status}`).join(", ")}`),
      {code:"VISUAL_QUALITY_QA_FAILED",retryable:true,qualityQa:normalized});
    return normalized;
  }

  async resumeCandidate({visual,draft,source,sourceInspection,transformInputHash,options,metadata={},accessToken=null}) {
    const candidate=await this.config.findVisualCandidate?.({visualId:visual.id,transformInputHash});
    if (!candidate) return null;
    const outputBytes=fs.readFileSync(candidate.media_path);
    const persistedQa=normalizeVisualQa(candidate.qa);
    const alreadyPassed=candidate.status === "promoted"
      && Object.entries(persistedQa).every(([key,value])=>key === "notes" || value.status === "passed");
    if (alreadyPassed) {
      const result=await this.storeImage({base64:outputBytes.toString("base64"),mimeType:candidate.mime_type,visual,draft,
        provider:candidate.provider,model:candidate.model,sourceDimensions:sourceInspection.dimensions,qualityQa:persistedQa});
      return {...result,candidateId:candidate.id || null,candidateHash:candidate.output_hash,
        resumedCandidate:true,reusedPromotedCandidate:true};
    }
    const token=accessToken || await this.accessToken();
    return this.reviewAndPromoteCandidate({candidate,visual,draft,metadata,source,sourceInspection,outputBytes,
      outputMimeType:candidate.mime_type,accessToken:token,options});
  }

  async persistCandidate({visual,draft,source,outputBytes,mimeType,provider,model,transformInputHash,options}) {
    const normalizedMime=normalizeMime(mimeType);
    const extension=normalizedMime === "image/jpeg" ? "jpg" : normalizedMime === "image/webp" ? "webp" : "png";
    const outputHash=hashBytes(outputBytes);
    const pendingDir=path.join(this.config.mediaDir,".pending");
    fs.mkdirSync(pendingDir,{recursive:true});
    const mediaPath=path.join(pendingDir,`${draft.id}-${visual.id}-${outputHash.slice(0,24)}.${extension}`);
    if (!fs.existsSync(mediaPath)) fs.writeFileSync(mediaPath,outputBytes,{mode:0o640,flag:"wx"});
    const telemetry=options.telemetryContext || {};
    const saved=await this.config.saveVisualCandidate?.({
      visualId:visual.id,draftId:draft.id,jobId:telemetry.runId || null,jobAttempt:telemetry.jobAttempt || 0,
      recoveryRunId:telemetry.recoveryRunId || null,sourceHash:source?.bytes ? hashBytes(source.bytes) : '',transformInputHash,outputHash,
      mediaPath,mimeType:normalizedMime,byteSize:outputBytes.length,provider,model,
      expectedFingerprint:options.expectedFingerprint || visual.asset_fingerprint || null,
    });
    return saved || {id:null,media_path:mediaPath,mime_type:normalizedMime,output_hash:outputHash,provider,model};
  }

  async reviewAndPromoteCandidate({candidate,visual,draft,metadata,source,sourceInspection,outputBytes,outputMimeType,accessToken,options}) {
    let qualityQa;
    try {
      qualityQa=await this.reviewTransformedImage({visual,metadata,source,outputBytes,outputMimeType,accessToken,
        signal:options.signal,options});
    } catch (error) {
      const conclusive=error?.code === "VISUAL_QUALITY_QA_FAILED";
      if (candidate.id) await this.config.updateVisualCandidate?.(candidate.id,{status:conclusive ? "qa_failed" : "pending_qa",
        qa:error?.qualityQa || null,error:{code:error?.code || null,message:error?.message || String(error),
          http_status:error?.status ?? null,retry_after_ms:error?.retryAfterMs ?? null,evidence_basis:conclusive ? "qa_response" : "qa_unavailable"}});
      error.details={...(error.details || {}),candidateHash:candidate.output_hash,candidateId:candidate.id || null,
        visualId:visual.id,substage:"visual_quality_qa",generationCheckpoint:"persisted_pending_qa"};
      throw error;
    }
    const result=await this.storeImage({base64:outputBytes.toString("base64"),mimeType:outputMimeType,visual,draft,
      provider:candidate.provider,model:candidate.model,sourceDimensions:sourceInspection.dimensions,qualityQa,
      layoutTelemetry:options.layoutTelemetry || null});
    if (candidate.id) await this.config.updateVisualCandidate?.(candidate.id,{status:"promoted",qa:qualityQa});
    return {...result,candidateId:candidate.id || null,candidateHash:candidate.output_hash,resumedCandidate:Boolean(candidate.created_at)};
  }

  async trackedRequest({provider,model,stage,endpoint,visual,options={}},operation) {
    const context=options.telemetryContext || {};
    const startedAt=new Date().toISOString();
    const startedMs=Date.now();
    let permit;
    try {
      if (this.config.mediaRequestExecutor) permit = this.config.mediaRequestExecutor.acquire({
        provider, model, accountScope:`${this.config.projectId || 'default'}:${this.config.location || 'global'}`,
        visualId:visual.id, substage:stage,
      });
      else await this.config.beforeRequest?.({provider,model,stage,attempt:1});
    } catch (error) {
      await this.recordVisualCall({provider,model,stage,visual,context,startedAt,startedMs,status:"failed",
        error,requestKind:"local_gate",dispatchState:"not_attempted",evidenceBasis:"before_request_gate",endpoint});
      throw error;
    }
    const callId=`visualcall_${crypto.randomUUID()}`;
    const heartbeat = permit ? setInterval(() => permit.heartbeat(), 30_000) : null;
    heartbeat?.unref();
    try {
      if (this.config.onModelCallStart) await this.recordVisualCall({callId,telemetryPhase:"started",provider,model,stage,visual,context,
        startedAt,startedMs,status:"failed",requestKind:"provider",attemptStatus:"started",dispatchState:"dispatch_started",
        evidenceBasis:"dispatch_intent_persisted",endpoint});
      const result=await operation();
      permit?.finish();
      await this.recordVisualCall({callId,provider,model,stage,visual,context,startedAt,startedMs,status:"succeeded",
        requestKind:"provider",dispatchState:"completed",evidenceBasis:"provider_response_completed",httpStatus:200,endpoint});
      return result;
    } catch (error) {
      const responded=(error?.status != null && Number.isFinite(Number(error.status))) || error?.responseReceived === true;
      permit?.finish({error,responseReceived:responded});
      await this.recordVisualCall({callId,provider,model,stage,visual,context,startedAt,startedMs,status:"failed",error,
        requestKind:"provider",dispatchState:responded ? "response_received" : "dispatch_started",
        evidenceBasis:responded ? "provider_error_response" : "dispatch_started_outcome_unknown",
        httpStatus:error?.status != null && Number.isFinite(Number(error.status)) ? Number(error.status) : responded ? 200 : null,endpoint});
      // Pass the exact persisted attempt through failJob; the job may contain
      // older calls from translation, generation or a previous recovery run.
      error.causalModelCallId=callId;
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  async recordVisualCall({callId=null,telemetryPhase="completed",provider,model,stage,visual,context,startedAt,startedMs,status,error=null,requestKind,
    attemptStatus=status,dispatchState,evidenceBasis,httpStatus=null,endpoint}) {
    const sink=telemetryPhase === "started" ? this.config.onModelCallStart : this.config.onModelCall;
    if (!sink) return;
    const details=error?.details || {};
    await sink({callId,telemetryPhase,stage,substage:stage,provider,model,status,errorCode:error?.code || (httpStatus && httpStatus !== 200 ? String(httpStatus) : null),
      latencyMs:Math.max(0,Date.now()-startedMs),attempts:1,attemptNumber:1,requestKind,attemptStatus,
      runId:context.runId || null,entityId:context.entityId || visual.id,visualId:visual.id,
      sourceAssetId:visual.source_asset_id || context.sourceAssetId || null,inputHash:hashBytes(Buffer.from(JSON.stringify({
        visual_id:visual.id,asset_fingerprint:visual.asset_fingerprint || "",stage,
      }))),promptHash:"",schemaHash:"",requestStartedAt:startedAt,requestCompletedAt:new Date().toISOString(),
      httpStatus,providerCode:details.code || details.status || null,
      providerRequestId:details.providerRequestId || details.requestId || null,dispatchState,evidenceBasis,
      endpointId:`${provider}:${model}:${stage}`,retryAfterMs:error?.retryAfterMs ?? null,
      providerUsage:null,inputTokens:null,outputTokens:null,cachedTokens:null,costStatus:"unknown",
      executionRoute:context.executionRoute || "realtime",queueWaitMs:context.queueWaitMs ?? null,
    });
  }

  async generateImagenImage(visual, draft, options = {}) {
    const identity=this.illustrationInputHash(visual);
    const resumed=await this.config.findVisualCandidate?.({visualId:visual.id,transformInputHash:identity});
    if (resumed) return this.promoteIllustrationCandidate(resumed,visual,draft,options);
    const accessToken = await this.accessToken();
    const endpoint = `https://${this.config.location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(this.config.projectId)}/locations/${encodeURIComponent(this.config.location)}/publishers/google/models/${encodeURIComponent(this.config.model)}:predict`;
    const prediction=await this.trackedRequest({provider:"vertex_imagen",model:this.config.model,stage:"generate_visual",
      endpoint,visual,options},async()=>{
      const response = await providerFetch(this.fetch, endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          instances: [{ prompt: visual.generation_prompt }],
          parameters: {
            sampleCount: 1, aspectRatio: visual.aspect_ratio,
            sampleImageSize: visual.image_role === "hero" ? this.config.coverQuality : this.config.inlineQuality,
            addWatermark: true, personGeneration: "dont_allow", safetyFilterLevel: "block_medium_and_above",
          },
        }),
        signal: combinedSignal(options.signal, this.config.requestTimeoutMs),
      }, "vertex_imagen", options.signal);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new ProviderRequestError("Vertex Imagen", response.status, payload?.error?.message || response.statusText,
        { ...(payload?.error || {}), retryAfter: response.headers.get("retry-after"),
          providerRequestId:response.headers.get("x-request-id") || response.headers.get("x-goog-request-id") });
      const output=payload?.predictions?.find((item) => item?.bytesBase64Encoded);
      if (!output) throw imageOutputError("Vertex Imagen",payload);
      return output;
    });
    const candidate=await this.persistCandidate({visual,draft,source:null,
      outputBytes:Buffer.from(prediction.bytesBase64Encoded,'base64'),mimeType:prediction.mimeType,
      provider:'vertex_imagen',model:this.config.model,transformInputHash:identity,options});
    return this.promoteIllustrationCandidate(candidate,visual,draft,options);
  }

  async generateGeminiImage(visual, draft, options = {}) {
    const identity=this.illustrationInputHash(visual);
    const resumed=await this.config.findVisualCandidate?.({visualId:visual.id,transformInputHash:identity});
    if (resumed) return this.promoteIllustrationCandidate(resumed,visual,draft,options);
    const accessToken = await this.accessToken();
    const location = this.config.location || "global";
    const host = location === "global" ? "https://aiplatform.googleapis.com" : `https://${location}-aiplatform.googleapis.com`;
    const endpoint = `${host}/v1/projects/${encodeURIComponent(this.config.projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(this.config.model)}:generateContent`;
    const prompt = `${visual.generation_prompt}\n\nCreate an original editorial illustration only. Do not depict people, logos, watermarks, readable text, or a documentary-style real place.`;
    const part=await this.trackedRequest({provider:"vertex_gemini",model:this.config.model,stage:"generate_visual",
      endpoint,visual,options},async()=>{
      const response = await providerFetch(this.fetch, endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          contents: { role: "USER", parts: [{ text: prompt }] },
          generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: visual.aspect_ratio } },
          safetySettings: [{ method: "PROBABILITY", category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" }],
        }),
        signal: combinedSignal(options.signal, this.config.requestTimeoutMs),
      }, "vertex_gemini", options.signal);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new ProviderRequestError("Gemini 3.1 Flash Image", response.status, payload?.error?.message || response.statusText,
        { ...(payload?.error || {}), retryAfter: response.headers.get("retry-after"),
          providerRequestId:response.headers.get("x-request-id") || response.headers.get("x-goog-request-id") });
      const output=payload?.candidates?.flatMap((candidate) => candidate?.content?.parts || []).find((item) => item?.inlineData?.data);
      if (!output) throw imageOutputError("Gemini 3.1 Flash Image", payload);
      return output;
    });
    const candidate=await this.persistCandidate({visual,draft,source:null,
      outputBytes:Buffer.from(part.inlineData.data,'base64'),mimeType:part.inlineData.mimeType,
      provider:'vertex_gemini',model:this.config.model,transformInputHash:identity,options});
    return this.promoteIllustrationCandidate(candidate,visual,draft,options);
  }

  illustrationInputHash(visual) {
    return hashBytes(Buffer.from(JSON.stringify({visualId:visual.id,fingerprint:visual.asset_fingerprint,
      prompt:visual.generation_prompt,ratio:visual.aspect_ratio,model:this.config.model,version:'illustration-qa-1'})));
  }

  async promoteIllustrationCandidate(candidate, visual, draft, options = {}) {
    const outputBytes=fs.readFileSync(candidate.media_path);
    if (hashBytes(outputBytes)!==candidate.output_hash) throw Object.assign(new Error('Visual candidate hash mismatch.'),
      {code:'CANDIDATE_HASH_MISMATCH',retryable:false});
    let qualityQa=candidate.qa || safeJson(candidate.qa_json);
    const passed=qualityQa?.status==='passed' || ['language','completeness','style','semantic']
      .every((field)=>qualityQa?.[field]?.status==='passed');
    if (!passed) {
      try { qualityQa=await this.reviewIllustration({visual,outputBytes,mimeType:candidate.mime_type,options}); }
      catch(error) {
        if(candidate.id) await this.config.updateVisualCandidate?.(candidate.id,{status:error?.code==='VISUAL_QUALITY_QA_FAILED'?'qa_failed':'pending_qa',
          qa:error?.qualityQa || null,error:{code:error?.code || null,message:String(error?.message || error)}});
        throw error;
      }
      if(candidate.id) await this.config.updateVisualCandidate?.(candidate.id,{status:'promoted',qa:qualityQa});
    }
    return this.storeImage({base64:outputBytes.toString('base64'),mimeType:candidate.mime_type,visual,draft,
      provider:candidate.provider,model:candidate.model,qualityQa});
  }

  async reviewIllustration({visual,outputBytes,mimeType,options}) {
    const token=await this.accessToken();
    const location=this.config.location || 'global';
    const host=location==='global'?'https://aiplatform.googleapis.com':`https://${location}-aiplatform.googleapis.com`;
    const model=this.config.qualityModel || 'gemini-3.8-flash';
    const endpoint=`${host}/v1/projects/${encodeURIComponent(this.config.projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
    const payload=await this.trackedRequest({provider:'vertex_gemini',model,stage:'visual_quality_qa',endpoint,visual,options},async()=>{
      const response=await providerFetch(this.fetch,endpoint,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
        body:JSON.stringify({contents:{role:'USER',parts:[{text:`Review this generated editorial illustration for its approved subject, readable composition, accurate alt text, no fabricated documentary scene, no logos or misleading text. Subject: ${visual.image_subject}. Alt: ${visual.alt_text}. Return all four quality fields.`},
          {inlineData:{mimeType:normalizeMime(mimeType),data:outputBytes.toString('base64')}}]},
          generationConfig:{responseModalities:['TEXT'],responseMimeType:'application/json',responseSchema:VISUAL_QA_SCHEMA}}),
        signal:combinedSignal(options.signal,this.config.requestTimeoutMs)},'vertex_gemini',options.signal);
      const body=await response.json().catch(()=>({}));
      if(!response.ok)throw new ProviderRequestError('Illustration QA',response.status,body?.error?.message || response.statusText,
        {...(body?.error || {}),retryAfter:response.headers.get('retry-after')});
      return body;
    });
    const raw=payload?.candidates?.flatMap((candidate)=>candidate?.content?.parts || []).find((item)=>item?.text)?.text || '';
    let qa;try{qa=JSON.parse(raw);}catch{throw Object.assign(new Error('Illustration QA returned invalid JSON.'),{code:'VISUAL_QUALITY_QA_INVALID',retryable:true});}
    const normalized=normalizeVisualQa(qa);
    if(Object.entries(normalized).some(([key,value])=>key!=='notes' && value.status!=='passed'))
      throw Object.assign(new Error('Illustration quality QA did not pass.'),{code:'VISUAL_QUALITY_QA_FAILED',retryable:true,qualityQa:normalized});
    return normalized;
  }

  async storeImage({ base64, mimeType: suppliedMimeType, visual, draft, provider, model, sourceDimensions = null,
    qualityQa = defaultVisualQa(), layoutTelemetry = null }) {
    const mimeType = normalizeMime(suppliedMimeType);
    const bytes = Buffer.from(base64, "base64");
    const inspection = await inspectImageBytes(bytes, mimeType);
    const adaptiveTextCard=provider === "vertex_gemini_text_layout"
      && shouldRenderEditorialTextCard(visual,safeJson(visual.media_metadata_json || visual.media_metadata));
    const expectedRatio = adaptiveTextCard ? null : sourceDimensions
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
        source_dimensions:sourceDimensions,adaptive_text_height:adaptiveTextCard},quality_qa:{...qualityQa,
          file_hash:inspection.sha256},
        ...(layoutTelemetry ? {layout_telemetry:layoutTelemetry} : {}) },
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

function completeTranslationArtifact(artifact,sourceRegions,inputHash,{visualId,draftId,sourceHash,regionManifestHash,model}) {
  if (artifact?.status !== "translated" || artifact.translation_input_hash !== inputHash
    || artifact.visual_id !== visualId || artifact.draft_id !== draftId
    || artifact.source_hash !== sourceHash || artifact.region_manifest_hash !== regionManifestHash
    || artifact.model !== model || !Array.isArray(artifact.regions)
    || artifact.regions.length !== sourceRegions.length) return false;
  const ids=new Set();
  for (let index=0;index<sourceRegions.length;index+=1) {
    const region=artifact.regions[index];
    if (region?.region_id !== sourceRegions[index].region_id || !String(region.english_text || "").trim()
      || ids.has(region.region_id)) return false;
    ids.add(region.region_id);
  }
  return artifact.output_hash === hashBytes(Buffer.from(JSON.stringify(artifact.regions)));
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
    responseReceived:true,
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
  const priorQa=metadata.quality_qa || {};
  const retryFeedback=Object.entries(priorQa).filter(([name,value])=>name !== "notes"
    && ["failed","needs_review"].includes(value?.status)).map(([name,value])=>({field:name,
    reason:String(value?.reason || "Previous audit did not pass.").slice(0,1000)}));
  const requiredText=(analysis.text_regions || []).map((region)=>({region_id:region.region_id,text:region.text || "",
    role:region.role || "unknown",preserve:Boolean(region.preserve)}));
  const facts={required_text:requiredText,entities:analysis.entities || [],primary_subjects:analysis.primary_subjects || [],
    editor_ui_regions:analysis.editor_ui_regions || [],preserve_region_ids:decision.preserveRegionIds || [],
    translate_region_ids:decision.translateRegionIds || []};
  const priorFailure=retryFeedback.length ? ` A previous derivative failed independent QA. Correct every listed defect and do not introduce a new omission or spelling error: ${JSON.stringify(retryFeedback)}. Proofread every English proper noun, transport mode, number, time, price, and final line against the source manifest before returning the image.` : "";
  const shared=`Use the attached authorized source image. Do not invent unreadable words, prices, times, routes, entities, people, places, or objects. Preserve every number, currency, operating time, negation, exception, arrow, route direction, ordering relationship, photograph, and factual relationship. Return one complete image with no cropped final line.${priorFailure} Required source manifest: ${JSON.stringify(facts)}`;
  if (visual.acquisition_strategy === "recompose_editorial_card") return `${shared}\nRecompose the editorial card from scratch in concise natural English on a warm white background with restrained light-blue accents, dark readable type, generous spacing, and a clear information hierarchy. Remove Notes bars, editor chrome, canvas controls, selection handles, watermarks, and decorative red/black poster styling. Do not pretend this card is a documentary photograph.`;
  if (visual.acquisition_strategy === "recompose_collage") return `${shared}\nRecompose the collage for an English travel article. Keep every factual photo region unchanged and in its original meaning and order. Keep real-world storefront signs inside photos intact. Replace only author-written captions or overlays with concise English. The overall canvas and all caption/card surfaces must be warm white; use light blue only as a restrained accent with dark readable type. Do not use dark blue, dark green, purple, red, black, or saturated full-card backgrounds. Natural colors inside the factual photo regions must remain unchanged. Never merge several restaurants into one venue or describe the collage as a single photograph.`;
  if (visual.acquisition_strategy === "recompose_map_or_route") return `${shared}\nRecompose the route or map in English. Preserve topology, start/end points, directions, arrows, step sequence, durations, distances, transfer relationships, and place identity exactly. If all required information cannot fit legibly, use a clearer multi-panel layout without omitting facts.`;
  return `${shared}\nTranslate only author-added Chinese overlay text into concise English. Preserve the documentary photograph exactly: scene, people, buildings, food, objects, crop, perspective, lighting, natural colors, logos, and real-world signage must remain unchanged.`;
}

function visualRetryFeedback(metadata={}) {
  return Object.entries(metadata.quality_qa || {}).filter(([name,value])=>name !== "notes"
    && ["failed","needs_review"].includes(value?.status)).map(([field,value])=>({field,
    reason:String(value?.reason || "Previous audit did not pass.").slice(0,1000)}));
}

function editorialTranslationRegions(metadata={}) {
  const analysis=metadata.source_analysis || {};
  const translatedIds=new Set(metadata.visual_decision?.translateRegionIds || []);
  return (analysis.text_regions || []).filter((region)=>translatedIds.size ? translatedIds.has(region.region_id)
    : region.readable !== false && region.role !== "ui_text" && !region.preserve).map((region)=>({
      region_id:String(region.region_id),source_text:String(region.text || ""),role:String(region.role || "editorial_text"),
    })).filter((region)=>region.source_text.trim());
}

function shouldRenderEditorialTextCard(visual,metadata={}) {
  const analysis=metadata.source_analysis || {};
  const regions=editorialTranslationRegions(metadata);
  return visual.acquisition_strategy === "recompose_editorial_card"
    && ["handwritten_card","editorial_infographic","text_card"].includes(String(analysis.asset_kind || ""))
    && Array.isArray(analysis.photo_regions) && analysis.photo_regions.length === 0
    && !visualRetryFeedback(metadata).some(({reason})=>/\b(?:photo(?:graph)?s?|documentary imagery|image regions?)\b/i.test(reason)
      && /\b(?:omit(?:ted)?|missing|preserv(?:e|ed|ation)?|lost|strip(?:ped)?|flatten(?:ed)?)\b/i.test(reason))
    && regions.length > 0;
}

function boundedEditorialCardHeight(value) {
  const parsed=Number(value);
  return Number.isFinite(parsed) && parsed >= 1000 ? Math.min(Math.floor(parsed),4096) : 4096;
}

async function renderTextCardPng(regions,aspectRatio,{maxHeight=4096}={}) {
  const ratio=parseAspectRatio(aspectRatio) || 3/4;
  const width=896; const minimumHeight=Math.max(500,Math.round(width/ratio));
  const fontSize=38; const titleFontSize=46; const lineHeight=52;
  const title=regions[0]?.english_text || "Travel Notes";
  const titleLayout=await fitEditorialLines(title,36,766,titleFontSize);
  const titleLines=titleLayout.lines;
  const headerHeight=96+titleLines.length*60;
  const items=[]; let bottom=headerHeight+80; let maximumMeasuredWidth=titleLayout.maximumMeasuredWidth;
  for (const region of regions.slice(1)) {
    const layout=await fitEditorialLines(region.english_text,39,750,fontSize);
    const lines=layout.lines;
    maximumMeasuredWidth=Math.max(maximumMeasuredWidth,layout.maximumMeasuredWidth);
    items.push({region_id:region.region_id,y:bottom,lines});
    bottom+=lines.length*lineHeight+36;
  }
  const height=Math.max(minimumHeight,bottom+64);
  if (height>maxHeight) throw Object.assign(new Error("Editorial card text cannot fit at a mobile-readable size; ordered split delivery is required."),
    {code:"EDITORIAL_CARD_TEXT_OVERFLOW",retryable:false,details:{validation:"deterministic_text_layout_capacity",
      region_count:regions.length,aspect_ratio:aspectRatio,minimum_font_size:fontSize,
      title_bottom:headerHeight,rendered_bottom:bottom,height,max_height:maxHeight,
      attempted_columns:1,fallback_attempts:1,layout_version:"editorial-card-layout-3",recovery_target:"ordered_child_cards"}});
  const titleSpans=titleLines.map((line,index)=>`<tspan x="58" dy="${index ? 60 : 0}">${escapeXml(line)}</tspan>`).join("");
  const bodyText=items.map((item)=>`<text x="64" y="${item.y}" font-family="DejaVu Sans,Arial,sans-serif" font-size="${fontSize}" fill="#172033">${item.lines.map((line,index)=>`<tspan x="64" dy="${index ? lineHeight : 0}">${escapeXml(line)}</tspan>`).join("")}</text>`).join("");
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#fbf8f1"/>
    <rect x="34" y="34" width="${width-68}" height="${headerHeight}" rx="24" fill="#dceef8"/>
    <rect x="34" y="${headerHeight+56}" width="8" height="${Math.max(0,height-headerHeight-100)}" rx="4" fill="#7fb6d6"/>
    <text x="58" y="94" font-family="DejaVu Sans,Arial,sans-serif" font-size="${titleFontSize}" font-weight="700" fill="#16324a">${titleSpans}</text>
    ${bodyText}
  </svg>`;
  return {bytes:await sharp(Buffer.from(svg)).png().toBuffer(),telemetry:{layout_version:"editorial-card-layout-3",
    columns:1,font_size:fontSize,title_font_size:titleFontSize,region_count:regions.length,
    region_order:items.map((item)=>item.region_id),max_measured_line_width:maximumMeasuredWidth,
    aspect_ratio:aspectRatio,rendered_bottom:bottom,height,
    fallback_attempts:1}};
}

async function fitEditorialLines(value,maxChars,maxWidth,fontSize) {
  const pending=wrapEditorialText(value,maxChars); const lines=[]; let maximumMeasuredWidth=0;
  while (pending.length) {
    const line=pending.shift();
    const measuredWidth=await measureEditorialLine(line,fontSize);
    if (measuredWidth<=maxWidth) {
      lines.push(line);maximumMeasuredWidth=Math.max(maximumMeasuredWidth,measuredWidth);continue;
    }
    const characters=Array.from(line);
    if (characters.length<=1) throw Object.assign(new Error("One editorial glyph exceeds the safe text width."),
      {code:"EDITORIAL_CARD_TEXT_OVERFLOW",retryable:false,details:{glyph:line,measured_width:measuredWidth,max_width:maxWidth}});
    let split=Math.floor(characters.length/2);
    for (let index=split;index>1;index-=1) if (characters[index]===" ") {split=index;break;}
    pending.unshift(characters.slice(0,split).join("").trimEnd(),characters.slice(split).join("").trimStart());
  }
  return {lines,maximumMeasuredWidth};
}

async function measureEditorialLine(line,fontSize) {
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="4096" height="128"><text x="0" y="80" font-family="DejaVu Sans,Arial,sans-serif" font-size="${fontSize}">${escapeXml(line)}</text></svg>`;
  const {info}=await sharp(Buffer.from(svg)).trim().toBuffer({resolveWithObject:true});
  return info.width;
}

function wrapEditorialText(value,maxChars) {
  const words=String(value || "").replace(/\s+/g," ").trim().split(" ").filter(Boolean);
  const lines=[]; let current="";
  for (const word of words) {
    const pieces=[]; const characters=Array.from(word);
    for (let index=0;index<characters.length;index+=maxChars) pieces.push(characters.slice(index,index+maxChars).join(""));
    for (const piece of pieces) {
      const candidate=current ? `${current} ${piece}` : piece;
      if (Array.from(candidate).length<=maxChars) current=candidate;
      else { lines.push(current); current=piece; }
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function escapeXml(value) {
  return String(value || "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
    .replaceAll('"',"&quot;").replaceAll("'","&apos;");
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

function hashBytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
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
