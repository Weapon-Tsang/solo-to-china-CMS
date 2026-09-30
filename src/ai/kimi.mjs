import crypto from "node:crypto";
import { slugify, truncate } from "../utils.mjs";
import { createAiClient } from "./client.mjs";
import { validateJsonSchema } from "../frontend-contract.mjs";
import { resolveStagePolicy } from "./stage-policy.mjs";
import { MEDIA_CONTEXT_INSTRUCTIONS, mediaContextForSource, sharedMediaContext, contextualImageParts, assertMediaOutputIdentity } from '../media-context.mjs';

const TEXT_REGION_SCHEMA={type:"object",additionalProperties:false,
  required:["region_id","text","role","language","readable","preserve"],properties:{
    region_id:{type:"string"},text:{type:"string"},role:{type:"string",enum:["author_overlay","editorial_text","ui_text","real_world_signage"]},
    language:{type:"string"},readable:{type:"boolean"},preserve:{type:"boolean"},
  }};
const MEDIA_ANALYSIS_ITEM_SCHEMA={ type:"object",additionalProperties:false,
  required:["asset_id","analysis_status","asset_kind","text_regions","photo_regions","entities","editor_ui_regions",
    "primary_subjects","language_by_region","reader_text_present","confidence","analysis_version","prompt_version"],
  properties:{ asset_id:{type:"string"},analysis_status:{type:"string",enum:["ready","needs_review","failed"]},
    asset_kind:{type:"string",enum:["documentary_photo","handwritten_card","editorial_infographic","photo_collage","map_or_route","decorative_illustration","unknown"]},
    text_regions:{type:"array",items:TEXT_REGION_SCHEMA},photo_regions:{type:"array",items:{type:"object",additionalProperties:true}},
    entities:{type:"array",items:{type:"string"}},editor_ui_regions:{type:"array",items:{type:"object",additionalProperties:true}},
    primary_subjects:{type:"array",items:{type:"string"}},language_by_region:{type:"array",items:{type:"object",additionalProperties:true}},
    reader_text_present:{type:"boolean"},confidence:{type:"number",minimum:0,maximum:1},analysis_version:{type:"string"},prompt_version:{type:"string"} } };

// Compact, flat per-image descriptor produced in the same extraction call that
// already sees every image. It records what the photo shows and whether it is
// worth publishing, so article planning does not need a second vision request.
export const IMAGE_CARD_VERSION = "image-card-1";
const IMAGE_CARD_KINDS=["documentary_photo","handwritten_card","editorial_infographic","photo_collage","map_or_route","decorative_illustration","unknown"];
const IMAGE_CARD_SCENES=["landscape","street","architecture","interior","food","transport","signage","ticket_or_document","map","screenshot","people","other"];
// Deliberately permissive: an Image Card is optional enrichment riding on the
// Claim extraction request. JSON-mode providers (DeepSeek) do not enforce enums
// or required fields, and a strict card schema made the whole extraction fail
// validation (L5 canary 2026-09-30). Allowed values are stated in the prompt and
// normalized by sanitizeImageCard; unusable cards are dropped, Claims are kept.
// The first listed type is what Vertex's OpenAPI projection sends to the
// provider; local validation accepts every listed type.
const LOOSE_TEXT={type:["string","number","boolean","null"]};
const LOOSE_LIST={type:["array","string","null"],items:{type:["string","number"]}};
const IMAGE_CARD_ITEM_SCHEMA={type:"object",
  properties:{asset_id:LOOSE_TEXT,asset_kind:LOOSE_TEXT,primary_subjects:LOOSE_LIST,place_names:LOOSE_LIST,
    scene:LOOSE_TEXT,visible_text:{type:["boolean","string","null"]},photo_quality:LOOSE_TEXT,
    editorial_use:LOOSE_TEXT,alt_text:LOOSE_TEXT,confidence:{type:["number","string","null"]}}};

// Strict where evidence depends on it, tolerant elsewhere. JSON-mode providers
// (DeepSeek) add stray keys, omit defaults and use off-enum or wrongly typed
// scalars; three L5 canaries on 2026-09-30 each failed on a different cosmetic
// deviation ($.image_cards[].scene, $.claims[].value, $.type) and every one of them
// discarded the whole batch of Claims. sanitizeResult normalizes and defaults;
// only a missing key/subject/predicate/value/source_quote rejects the output.
// For Vertex the OpenAPI projection sends the first listed type, so its native
// structured output keeps the same shape.
const EXTRACTION_SCHEMA = {
  type: "object",
  required: ["source", "claims"],
  properties: {
    source: {
      type: "object",
      required: ["summary", "destination_slug"],
      properties: {
        language: { type: "string" }, summary: { type: "string" }, destination_name: { type: "string" }, destination_slug: { type: "string" },
        traveler_fit: { type: ["array", "null"], items: { type: "string" } },
        practical_tips: { type: ["array", "null"], items: { type: "object", properties: { topic: { type: "string" }, detail: { type: "string" } } } },
        warnings: { type: ["array", "null"], items: { type: "string" } }, confidence: { type: ["number", "string", "null"] },
      },
    },
    claims: { type: "array", items: { type: "object", required: ["key", "subject", "predicate", "value", "source_quote"], properties: { key: { type: "string" }, subject: { type: "string" }, predicate: { type: "string" },
      value: { type: ["string", "number", "boolean", "null"] }, qualifiers: { type: ["array", "string", "null"], items: { type: ["string", "number"] } }, confidence: { type: ["number", "string", "null"] }, source_quote: { type: "string" }, asset_id: { type: ["string", "null"] }, segment_id: { type: ["string", "null"] }, observed_at: { type: ["string", "null"] }, valid_from: { type: ["string", "null"] }, valid_to: { type: ["string", "null"] }, date_confidence: { type: ["string", "null"] }, claim_role: { type: ["string", "null"] }, knowledge_eligible: { type: ["boolean", "string", "null"] } } } },
    media_analysis: { type:"array",items:MEDIA_ANALYSIS_ITEM_SCHEMA },
    image_cards: { type:"array",items:IMAGE_CARD_ITEM_SCHEMA },
  },
};
// DeepSeek JSON mode can return useful image evidence while omitting required
// fields from the much larger media-analysis contract. Keep evidence extraction
// bounded; dedicated visual analysis must establish image readiness later.
const DEEPSEEK_IMAGE_EXTRACTION_SCHEMA = {...EXTRACTION_SCHEMA,
  properties:Object.fromEntries(Object.entries(EXTRACTION_SCHEMA.properties).filter(([key])=>key!=="media_analysis"))};

const MEDIA_ANALYSIS_SCHEMA={...MEDIA_ANALYSIS_ITEM_SCHEMA,properties:{...MEDIA_ANALYSIS_ITEM_SCHEMA.properties,
  source_sha256:{type:"string"}},required:[...MEDIA_ANALYSIS_ITEM_SCHEMA.required,"source_sha256"]};

const BLUEPRINT_SCHEMA = { type: "object", additionalProperties: false, required: ["format", "hook", "angle", "sections", "strengths", "gaps"], properties: { format: { type: "string" }, hook: { type: "string" }, angle: { type: "string" }, sections: { type: "array", items: { type: "object", additionalProperties: false, required: ["heading", "purpose"], properties: { heading: { type: "string" }, purpose: { type: "string" } } } }, strengths: { type: "array", items: { type: "string" } }, gaps: { type: "array", items: { type: "string" } } } };

const COVERAGE_AUDIT_SCHEMA = { type: "object", additionalProperties: false, required: ["uncovered_spans"], properties: { uncovered_spans: { type: "array", items: { type: "object", additionalProperties: false, required: ["quote", "importance", "reason"], properties: { quote: { type: "string" }, importance: { type: "string", enum: ["material", "important", "minor"] }, reason: { type: "string" } } } } } };

export class KimiExtractor {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.client = createAiClient(config, fetchImpl);
  }

  get enabled() {
    return this.client.enabled;
  }

  get batchEnabled() {
    return this.config.provider === "vertex" && this.client.batchEnabled;
  }

  async testConnection({signal=null,telemetryContext=null}={}) {
    if(!this.enabled)throw Object.assign(new Error("AI provider is not configured."),{code:"AI_NOT_CONFIGURED",retryable:false});
    const started=Date.now();
    const completion=await this.client.completeJson({name:"manual_provider_connection_test",
      schema:{type:"object",additionalProperties:false,required:["ok"],properties:{ok:{type:"boolean"}}},
      instructions:"Return JSON with ok=true. This is an operator-requested provider connection test.",
      content:[{type:"text",text:"connection test"}],signal,telemetryContext:{runId:`connection-test-${started}`,entityId:"manual",role:"extraction",...(telemetryContext||{})}});
    return {ok:completion.output?.ok===true,model:completion.model,latencyMs:Date.now()-started,testedAt:new Date().toISOString()};
  }

  async testImageConnection({signal=null,telemetryContext=null}={}) {
    if(!this.enabled)throw Object.assign(new Error("AI provider is not configured."),{code:"AI_NOT_CONFIGURED",retryable:false});
    const started=Date.now();
    const pixel="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z6j8AAAAASUVORK5CYII=";
    const completion=await this.client.completeJson({name:"manual_provider_image_test",
      schema:{type:"object",additionalProperties:false,required:["ok"],properties:{ok:{type:"boolean"}}},
      instructions:"Inspect the supplied image and return JSON with ok=true. This is an operator-requested multimodal capability test.",
      content:[{type:"text",text:"multimodal connection test"},{type:"image_url",image_url:{url:pixel,detail:"low"}}],signal,
      telemetryContext:{runId:`image-connection-test-${started}`,entityId:"manual",role:"extraction",...(telemetryContext||{})}});
    return {ok:completion.output?.ok===true,model:completion.model,latencyMs:Date.now()-started,testedAt:new Date().toISOString()};
  }

  async analyzeMediaAsset(asset, {signal=null,telemetryContext=null}={}) {
    if (!this.enabled) throw Object.assign(new Error("Image analysis provider is not configured."),{code:"MEDIA_ANALYSIS_NOT_CONFIGURED",retryable:false});
    const images=await this.client.imageParts([{...asset,kind:"image"}]);
    if (!images.parts.length) throw Object.assign(new Error("Stored source image bytes are unavailable for analysis."),{code:"SOURCE_IMAGE_BYTES_MISSING",retryable:false});
    // Acquire the media dispatch only when the request actually leaves for the
    // provider. A recovery that replays an analysis from the response cache must
    // not consume the bounded paid-dispatch budget of this visual.
    let permit=null;
    const acquirePermit=()=>{ permit=this.config.mediaRequestExecutor?.acquire({provider:this.config.provider || 'vertex',
      model:this.config.model || 'unknown',accountScope:`${this.config.projectId || 'default'}:${this.config.location || 'global'}`,
      visualId:telemetryContext?.visualId || asset.id,substage:'analyze_source_image'}) || null; };
    let completion;
    try {
      const source={id:asset.source_id,capture_version:asset.capture_version,media_context:asset.media_context,assets:[asset]};
      completion=await this.client.completeJson({name:"source_asset_media_analysis",schema:MEDIA_ANALYSIS_SCHEMA,onProviderDispatch:acquirePermit,
        instructions:`${MEDIA_ANALYSIS_PROMPT}\n${MEDIA_CONTEXT_INSTRUCTIONS}`,content:[{type:"text",text:JSON.stringify({assetId:asset.id,
          sourceSha256:asset.original_sha256 || asset.stored_sha256 || "",media_context:sharedMediaContext(source)})},
          ...contextualImageParts(source,[asset],images)],signal,telemetryContext,validateOutput:validateMediaAnalysisOutput});
      assertMediaOutputIdentity({media_analysis:[completion.output]},[asset],{requireAll:true});
      permit?.finish();
    } catch (error) { permit?.finish({error,responseReceived:error?.status != null
      || ['LOCAL_OUTPUT_INVALID','MODEL_OUTPUT_INVALID'].includes(error?.code)}); throw error; }
    return {result:{...sanitizeMediaAnalysis({...completion.output,asset_id:asset.id,
      source_sha256:asset.original_sha256 || asset.stored_sha256 || completion.output?.source_sha256 || ""}),
      prompt_version:"media-analysis-prompt-4"},
      method:this.config.provider || "vertex",model:completion.model};
  }

  /** Image Cards only, several images per request: used to backfill images whose
   * extraction predates cards. Claims are not re-extracted. */
  async describeImageCards(assets, {signal=null,telemetryContext=null}={}) {
    if (!this.enabled) throw Object.assign(new Error("Image analysis provider is not configured."),{code:"MEDIA_ANALYSIS_NOT_CONFIGURED",retryable:false});
    const images=await this.client.imageParts(assets.map((asset)=>({...asset,kind:"image"})));
    const submitted=assets.filter((_,index)=>images.manifest[index]?.status==="submitted");
    if (!submitted.length) return {cards:[],model:null,skipped:assets.map((asset)=>asset.id)};
    const parts=submitted.flatMap((asset,index)=>[{type:"text",text:`Image assetId=${asset.id}`},images.parts[index]]);
    const completion=await this.client.completeJson({name:"source_image_card",
      schema:{type:"object",additionalProperties:false,required:["image_cards"],properties:{image_cards:{type:"array",items:IMAGE_CARD_ITEM_SCHEMA}}},
      instructions:`Describe each supplied travel-source image for editorial reuse. Return one image_cards record per image, using the assetId written immediately before it.\n${IMAGE_CARD_PROMPT}\n${MEDIA_CONTEXT_INSTRUCTIONS}`,
      content:parts,signal,telemetryContext});
    const ids=new Set(submitted.map((asset)=>asset.id));
    const cards=(completion.output?.image_cards || []).map(sanitizeImageCard).filter((card)=>ids.has(card.asset_id));
    return {cards,model:completion.model,skipped:assets.filter((asset)=>!ids.has(asset.id)).map((asset)=>asset.id)};
  }

  artifactContract(stage) {
    if (stage === 'analyze_source_blueprint') return { name: 'source_blueprint', schema: BLUEPRINT_SCHEMA, prompt: BLUEPRINT_PROMPT };
    return { name: stage === 'audit_segment_coverage' ? 'segment_claim_coverage_audit' : 'source_research_extraction',
      mediaWireVersion: 'shared-source-context-1',
      ...this.batchConfigSnapshot(stage) };
  }

  batchConfigSnapshot(operation = "extract_segment_claims") {
    const coverage = operation === "audit_segment_coverage";
    const snapshot = {
      provider: this.config.provider || "vertex",
      model: this.config.model || "",
      location: this.config.location || "global",
      projectId: this.config.projectId || "",
      schemaHash: digest(JSON.stringify(coverage ? COVERAGE_AUDIT_SCHEMA : EXTRACTION_SCHEMA)),
      promptHash: digest(coverage ? COVERAGE_AUDIT_PROMPT : `${SYSTEM_PROMPT}\n${MEDIA_CONTEXT_INSTRUCTIONS}`),
      configVersion: "batch-request-v2-media-context",
    };
    return { ...snapshot, configDigest: digest(JSON.stringify(snapshot)) };
  }

  async prepareBatchExtraction(source, batchItemId, runConfig = null) {
    if (!this.client.batchEnabledFor(runConfig)) throw Object.assign(new Error("Stored Vertex Batch extraction configuration is unavailable."), { code: "BATCH_CREDENTIALS_UNAVAILABLE", retryable: true });
    if ((source.assets || []).some((asset) => asset.kind === "video") || source.source_kind === "video_url") {
      throw new Error("Video segments remain on the realtime Vertex path.");
    }
    const images = await this.client.imageParts(source.assets || [], runConfig);
    const prepared = this.client.prepareBatchRequest({
      id: batchItemId,
      name: "source_research_extraction",
      schema: EXTRACTION_SCHEMA,
      instructions: `${SYSTEM_PROMPT}\n${MEDIA_CONTEXT_INSTRUCTIONS}`,
      content: [{ type: "text", text: buildInput(source) }, ...contextualImageParts(source,source.assets || [],images)],
    }, runConfig);
    const provider = runConfig?.provider || "vertex";
    const model = runConfig?.model || this.config.model;
    return { ...prepared, attemptedImages: images.attempted, suppliedImages: images.parts.length,
      inputManifest: extractionInputManifest({ source, provider, model, batch: true, images }) };
  }

  async prepareBatchCoverage({ segment, extraction, expectedModality = "text" }, batchItemId, runConfig = null) {
    if (!this.client.batchEnabledFor(runConfig)) throw Object.assign(new Error("Stored Vertex Batch coverage configuration is unavailable."), { code: "BATCH_CREDENTIALS_UNAVAILABLE", retryable: true });
    if (expectedModality !== "text") throw new Error("Only text coverage audits use Vertex Batch.");
    return this.client.prepareBatchRequest({
      id: batchItemId,
      name: "segment_claim_coverage_audit",
      schema: COVERAGE_AUDIT_SCHEMA,
      instructions: COVERAGE_AUDIT_PROMPT,
      content: [{ type: "text", text: buildCoverageInput(segment, extraction) }],
    }, runConfig);
  }

  createExtractionBatch(requests, options = {}) { return this.client.createBatch(requests, options, options.runConfig); }
  getExtractionBatch(name, runConfig) { return this.client.getBatch(name, runConfig); }
  findExtractionBatch(inputUri, runConfig) { return this.client.findBatchByInputUri(inputUri, runConfig); }
  readExtractionBatch(batch) { return this.client.readBatchOutput(batch, batch); }
  cleanupExtractionBatch(batch) { return this.client.cleanupBatch(batch, batch); }

  parseBatchExtraction(item, { inputManifest = null, runConfig = null, telemetryContext = null } = {}) {
    const context = telemetryContext || { runId: runConfig?.id || null, entityId: item?.jobId || item?.job_id || null };
    if (item?.error) {
      this.recordBatchAttempt("source_research_extraction", item, runConfig, context, "failed", item.code || "VERTEX_BATCH_ITEM_FAILED");
      throw Object.assign(new Error(item.error), { retryable: true, code: item.code || "VERTEX_BATCH_ITEM_FAILED" });
    }
    const errors = validateJsonSchema(item?.output, EXTRACTION_SCHEMA);
    if (errors.length) {
      this.recordBatchAttempt("source_research_extraction", item, runConfig, context, "failed", "INVALID_MODEL_OUTPUT", "schema_validation");
      throw Object.assign(new Error(`Vertex Batch returned invalid extraction JSON: ${JSON.stringify(errors.slice(0, 10))}`),
        { retryable: true, code: "INVALID_MODEL_OUTPUT" });
    }
    const manifest=inputManifest || item?.inputManifest;
    if (manifest?.mediaContext?.assets?.length) assertMediaOutputIdentity(item.output,
      manifest.mediaContext.assets.map(asset=>({id:asset.asset_id,segment_id:asset.segment_id})),{requireAll:true});
    this.recordBatchAttempt("source_research_extraction", item, runConfig, context, "succeeded");
    return { result: sanitizeResult(item.output), method: "vertex_batch", model: runConfig?.model || this.config.model,
      inputManifest: inputManifest || item?.inputManifest || null };
  }

  parseBatchCoverage(item, { runConfig = null, telemetryContext = null } = {}) {
    const context = telemetryContext || { runId: runConfig?.id || null, entityId: item?.jobId || item?.job_id || null };
    if (item?.error) {
      this.recordBatchAttempt("segment_claim_coverage_audit", item, runConfig, context, "failed", item.code || "VERTEX_BATCH_ITEM_FAILED");
      throw Object.assign(new Error(item.error), { retryable: true, code: item.code || "VERTEX_BATCH_ITEM_FAILED" });
    }
    const errors = validateJsonSchema(item?.output, COVERAGE_AUDIT_SCHEMA);
    if (errors.length) {
      this.recordBatchAttempt("segment_claim_coverage_audit", item, runConfig, context, "failed", "INVALID_MODEL_OUTPUT", "schema_validation");
      throw Object.assign(new Error(`Vertex Batch returned invalid coverage-audit JSON: ${JSON.stringify(errors.slice(0, 10))}`),
        { retryable: true, code: "INVALID_MODEL_OUTPUT" });
    }
    this.recordBatchAttempt("segment_claim_coverage_audit", item, runConfig, context, "succeeded");
    return { output: { ...sanitizeCoverageAudit(item.output), modality: {
      expected: "text", received: "text", attempted: 0,
    } }, model: runConfig?.model || this.config.model };
  }

  recordBatchAttempt(stage, item, runConfig, context, status, errorCode = null, retryReason = null) {
    const policy = resolveStagePolicy(stage, { ...this.config, ...runConfig });
    const usage = item?.usage || {};
    try {
      this.config.onModelCall?.({ stage, provider: runConfig?.provider || "vertex", model: runConfig?.model || this.config.model,
        inputTokens: usage.promptTokenCount ?? null, outputTokens: usage.candidatesTokenCount ?? null,
        cachedTokens: usage.cachedContentTokenCount ?? null, thinkingTokens: usage.thoughtsTokenCount ?? null,
        providerUsage: usage, latencyMs: null, attempts: 1, attemptNumber: 1, status,
        attemptStatus: status, requestKind: "batch_result", errorCode, retryReason,
        policyVersion: policy.version, configHash: policy.configHash,
        runId: context.runId, entityId: context.entityId,
        requestCompletedAt: new Date().toISOString() });
    } catch { /* telemetry must never fail batch ingestion */ }
  }

  async extract(source, { signal = null, telemetryContext = null } = {}) {
    if (!this.enabled) return { result: heuristicExtraction(source), method: "heuristic", model: null };
    const videoSource = source.source_kind === "video" || (source.source_kind === "video_url" && isYoutubeUrl(source.submitted_url));
    if (videoSource && this.config.provider !== "vertex" && !source.submission_metadata?.operatorNotesProvided) {
      throw new Error("Video extraction requires a Vertex Gemini model with video input, or an operator-supplied transcript in the source notes.");
    }
    const assets = source.assets || [];
    const imageAssets = assets.filter((asset) => asset.kind !== "video");
    const videoAssets = assets.filter((asset) => asset.kind === "video");
    const imageBatchSize = Math.max(1, Number(this.config.imageBatchSize || this.config.maxImages || 32));
    const batches = [];
    for (let index = 0; index < imageAssets.length; index += imageBatchSize) {
      batches.push({ images: imageAssets.slice(index, index + imageBatchSize), videos: [] });
    }
    for (const video of videoAssets) batches.push({ images: [], videos: [video] });
    if (!batches.length) batches.push({ images: [], videos: [] });

    const outputs = [];
    const methods = new Set();
    const inputManifests = [];
    let model = null;
    for (const batch of batches) {
      const images = await this.client.imageParts(batch.images);
      if (batches.length === 1 && batch.images.length && !images.parts.length) throw Object.assign(
        new Error("No captured image bytes could be sent to the extraction model."),
        {code:"SOURCE_IMAGE_BYTES_UNAVAILABLE",retryable:true});
      if (batch.images.length && !images.parts.length) {
        inputManifests.push(extractionInputManifest({source:{...source,assets:batch.images},
          provider:this.config.provider || 'kimi',model:this.config.model,batch:false,images}));
        continue;
      }
      const videos = await prepareVideoParts({ ...source, assets: batch.videos }, this.config.provider, this.client);
      const deferredImageAnalysis = this.config.provider === "deepseek" && images.parts.length > 0;
      const soleImage=batch.images.length===1 && !batch.videos.length ? batch.images[0] : null;
      const soleSegmentId=soleImage?.segment_id || source.submission_metadata?.asset_segment_ids?.[soleImage?.id]
        || source.submission_metadata?.segment_id || null;
      const deepseekInstructions=deferredImageAnalysis ? [DEEPSEEK_IMAGE_EXTRACTION_PROMPT,
        "For every Claim, claim_role MUST be exactly one of fact, recommendation, personal_experience, promotional_observation, editorial_metadata. Set knowledge_eligible=true only for independently useful travel facts and recommendations; set it to false for personal, promotional, or editorial Claims.",
        soleImage ? `Every Claim in this image request MUST have asset_id=${soleImage.id}${soleSegmentId ? ` and segment_id=${soleSegmentId}` : ""}.` : "",
      ].filter(Boolean).join("\n") : SYSTEM_PROMPT;
      let completion;
      try {
        completion = await this.client.completeJson({
          name: "source_research_extraction",
          schema: deferredImageAnalysis ? DEEPSEEK_IMAGE_EXTRACTION_SCHEMA : EXTRACTION_SCHEMA,
          instructions: `${deepseekInstructions}\n${MEDIA_CONTEXT_INSTRUCTIONS}`,
          content: [{ type: "text", text: buildInput({...source,assets:[...batch.images,...batch.videos]}) }, ...videos.parts,
            ...contextualImageParts(source,batch.images,images)],
          signal, telemetryContext,
        });
      } finally {
        await videos.cleanup();
      }
      if (batch.images.length) assertMediaOutputIdentity(completion.output,batch.images);
      const result = sanitizeResult(completion.output);
      if (!deferredImageAnalysis) {
        const returned=new Set(result.media_analysis.map(item=>item.asset_id));
        for (const asset of batch.images) if (!returned.has(asset.id)) {
          result.media_analysis.push(sanitizeMediaAnalysis({asset_id:asset.id,analysis_status:'needs_review',asset_kind:'unknown',reader_text_present:true}));
          result.source.warnings.push(`MEDIA_ANALYSIS_MISSING: ${asset.id}; a missing record is not a negative source binding.`);
        }
      }
      if (batch.images.length===1 && !batch.videos.length) result.claims=result.claims.map((claim)=>({
        ...claim,asset_id:batch.images[0].id,
        ...(soleSegmentId ? {segment_id:soleSegmentId} : {}),
      }));
      if (soleImage && result.image_cards.length===1) result.image_cards[0].asset_id=soleImage.id;
      const batchAssetIds=new Set(batch.images.map((asset)=>asset.id));
      result.image_cards=result.image_cards.filter((card)=>batchAssetIds.has(card.asset_id));
      const cardsById=new Map(result.image_cards.map((card)=>[card.asset_id,card]));
      if (deferredImageAnalysis) {
        // A qualifying plain-photo card is a real pixel analysis; everything else
        // keeps the explicit deferral for the dedicated text-region review.
        result.media_analysis = batch.images.map((asset)=>imageCardMediaAnalysis(cardsById.get(asset.id))
          || sanitizeMediaAnalysis({
            asset_id:asset.id,analysis_status:"needs_review",asset_kind:"unknown",
            reader_text_present:true,confidence:0,
          }));
        result.source.warnings.push("Image-level media analysis requires separate review before visual reuse.");
      } else {
        result.media_analysis=result.media_analysis.map((analysis)=>withImageCardRegion(analysis,cardsById.get(analysis.asset_id)));
      }
      if (completion.droppedClaims) result.source.warnings.push(
        `${completion.droppedClaims} claims were dropped for missing required evidence fields (key/subject/predicate/value/source_quote).`);
      if (completion.downgradedClaims) result.source.warnings.push(
        `${completion.downgradedClaims} claims had unrecognized roles and require evidence review before knowledge use.`);
      if (images.attempted > images.parts.length) result.source.warnings.push("Some captured image assets were unavailable to the vision model; completeness remains blocked until they are processed.");
      if (batch.videos.length && videos.parts.length < batch.videos.length) result.source.warnings.push("One or more captured videos were unavailable to the selected model; completeness remains blocked until they are processed.");
      outputs.push(result);
      inputManifests.push(extractionInputManifest({ source: { ...source, assets: [...batch.images, ...batch.videos] },
        provider: this.config.provider || "kimi", model: completion.model || this.config.model, batch: false, images, videos }));
      methods.add(videos.parts.length ? "video" : images.parts.length ? "multimodal" : "text");
      model ||= completion.model;
    }
    if (!outputs.length) throw Object.assign(new Error('No captured image bytes could be sent to the extraction model.'),
      {code:'SOURCE_IMAGE_BYTES_UNAVAILABLE',retryable:true});
    const merged=mergeExtractionResults(outputs);
    if(inputManifests.some(manifest=>manifest.assets.some(asset=>asset.status==='failed')))
      merged.source.warnings.push('Some captured image assets were unavailable; no request was purchased for an empty image batch.');
    return { result: merged, method: `${this.config.provider || "kimi"}_${[...methods].join("+")}`, model,
      inputManifest: mergeInputManifests(inputManifests) };
  }

  async analyzeBlueprint(source, { signal = null, telemetryContext = null } = {}) {
    if (!this.enabled) return { output: heuristicExtraction(source).blueprint, model: null };
    const completion = await this.client.completeJson({
      name: "source_editorial_blueprint",
      schema: BLUEPRINT_SCHEMA,
      instructions: BLUEPRINT_PROMPT,
      content: [{ type: "text", text: buildInput(source) }],
      signal, telemetryContext,
    });
    return { output: sanitizeBlueprint(completion.output), model: completion.model };
  }

  async auditCoverage({ segment, extraction, source, expectedModality = "text" }, { signal = null, telemetryContext = null } = {}) {
    if (!this.enabled) return { output: { uncovered_spans: [] }, model: null };
    const images = expectedModality === "image" ? await this.client.imageParts(source?.assets || []) : { parts: [], attempted: 0 };
    const videos = expectedModality === "video" ? await prepareVideoParts(source, this.config.provider, this.client)
      : { parts: [], attempted: 0, cleanup: async () => {} };
    try {
      const completion = await this.client.completeJson({
        name: "segment_claim_coverage_audit",
        schema: COVERAGE_AUDIT_SCHEMA,
        instructions: COVERAGE_AUDIT_PROMPT,
        content: [{ type: "text", text: buildCoverageInput(segment, extraction) }, ...videos.parts, ...images.parts],
        signal, telemetryContext,
      });
      return {
        output: { ...sanitizeCoverageAudit(completion.output), modality: {
          expected: expectedModality,
          received: videos.parts.length ? "video" : images.parts.length ? "image" : "text",
          attempted: videos.attempted || images.attempted || 0,
        } },
        model: completion.model,
      };
    } finally {
      await videos.cleanup();
    }
  }
}

async function prepareVideoParts(source, provider, client) {
  const empty = { parts: [], attempted: 0, manifest: [], cleanup: async () => {} };
  if (provider !== "vertex") return empty;
  if ((source?.assets || []).some((asset) => asset?.kind === "video")) return client.videoParts(source.assets || []);
  if (source?.source_kind !== "video_url" || !isYoutubeUrl(source.submitted_url)) return empty;
  try {
    const url = new URL(source.submitted_url || "");
    return { parts: [{ fileData: { fileUri: url.toString(), mimeType: "video/mp4" } }], attempted: 1,
      manifest: [{ assetId: null, hash: null, kind: "video", status: "submitted", requestReference: "public_url",
        failureCode: null, failureReason: null }], cleanup: async () => {} };
  } catch {
    return empty;
  }
}

function extractionInputManifest({ source, provider, model, batch, images = {}, videos = {} }) {
  const assets = [...(images.manifest || []), ...(videos.manifest || [])];
  const expectedKinds = new Set((source?.assets || []).map((asset) => asset?.kind === "video" ? "video" : "image"));
  if (source?.source_kind === "video_url") expectedKinds.add("video");
  const submittedKinds = new Set(assets.filter((asset) => asset.status === "submitted").map((asset) => asset.kind));
  return {
    version: 1,
    expectedModality: manifestModality(expectedKinds),
    receivedModality: manifestModality(submittedKinds),
    provider,
    model,
    capabilities: { text: true, image: true, video: provider === "vertex", batch: Boolean(batch) },
    assets,
    ...(expectedKinds.has('image') ? {mediaContext:mediaContextForSource(source)} : {}),
  };
}

function mergeInputManifests(manifests) {
  const values = (manifests || []).filter((item) => item?.version);
  if (!values.length) return null;
  const expected = new Set(values.map((item) => item.expectedModality).filter((item) => item !== "text"));
  const received = new Set(values.map((item) => item.receivedModality).filter((item) => item !== "text"));
  return {
    ...values[0],
    expectedModality: manifestModality(expected),
    receivedModality: manifestModality(received),
    assets: values.flatMap((item) => item.assets || []),
    mediaContexts: values.flatMap((item) => item.mediaContext ? [item.mediaContext] : []),
  };
}

function manifestModality(kinds) {
  const values = new Set();
  for (const item of kinds) {
    if (item === "mixed") { values.add("image"); values.add("video"); }
    else if (item === "image" || item === "video") values.add(item);
  }
  if (values.size > 1) return "mixed";
  return values.values().next().value || "text";
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function mergeExtractionResults(results) {
  const source = results.map((item) => item.source).filter(Boolean)
    .sort((left, right) => Number(right.confidence || 0) - Number(left.confidence || 0))[0]
    || heuristicExtraction({ raw_text: "", title: "", assets: [] }).source;
  source.warnings = [...new Set(results.flatMap((item) => item.source?.warnings || []))];
  const claims = [];
  const seen = new Set();
  for (const claim of results.flatMap((item) => item.claims || [])) {
    const key = [claim.asset_id, claim.segment_id, claim.key, claim.subject, claim.predicate, claim.value, claim.source_quote].join("\u0000").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    claims.push(claim);
  }
  const analyses=[]; const analysisIds=new Set();
  for (const item of results.flatMap((result)=>result.media_analysis || [])) {
    const normalized=sanitizeMediaAnalysis(item); if (!normalized.asset_id || analysisIds.has(normalized.asset_id)) continue;
    analysisIds.add(normalized.asset_id);analyses.push(normalized);
  }
  const cards=[]; const cardIds=new Set();
  for (const card of results.flatMap((result)=>result.image_cards || [])) {
    if (!card.asset_id || cardIds.has(card.asset_id)) continue;
    cardIds.add(card.asset_id);cards.push(card);
  }
  return { source, claims, media_analysis:analyses, image_cards:cards, blueprint: emptyBlueprint() };
}

function isYoutubeUrl(value) {
  try {
    const url = new URL(value || "");
    const host = url.hostname.toLowerCase();
    const segments = url.pathname.split("/").filter(Boolean);
    if (host === "youtu.be") return Boolean(segments[0]);
    if (!(host === "youtube.com" || host.endsWith(".youtube.com"))) return false;
    return Boolean(url.searchParams.get("v") || (["shorts", "live", "embed"].includes(segments[0]) && segments[1]));
  } catch {
    return false;
  }
}

const IMAGE_CARD_PROMPT = `- For every supplied image also return one image_cards record with its exact assetId as asset_id, describing only the pixels: asset_kind (exactly one of ${IMAGE_CARD_KINDS.join(", ")}); primary_subjects (concise English, the dominant depicted things); place_names (named places identifiable from the image itself or its explicit caption, never from mention order); scene (exactly one of ${IMAGE_CARD_SCENES.join(", ")}); visible_text (true only when author-added text is present: overlay titles, captions, stickers, handwritten notes, itinerary or price cards, screenshots of text; real-world signage, shop signs and plaques photographed inside the scene do NOT count and must give false); photo_quality (exactly one of high, medium, low: sharpness, exposure, framing); editorial_use (exactly one of hero, body, evidence_only, unusable: hero = strong wide establishing photo suitable to open an article, body = clear supporting photo, evidence_only = useful for facts but not for display, unusable = blurred, cropped UI, meme, duplicate or irrelevant); alt_text (one factual English sentence of at most 125 characters); confidence (always include: a number from 0 to 1 for how sure you are of this card). Surrounding note text is not proof of what an image shows.`;

const SYSTEM_PROMPT = `You extract research evidence from a manually selected Chinese travel source for an English China travel site. The source may be a UGC note, public web article, document, image set, or video-page transcript.

Rules:
- The source is evidence, not established truth. Record factual assertions as claims and never silently resolve conflicts.
- Do not summarize. Do not select representative facts. Extract every independently useful travel proposition explicitly supported by this segment. Split compound statements into atomic claims. Continue until no material supported travel fact remains uncovered.
- Preserve important qualifiers: date, season, time of day, traveler type, booking channel, and uncertainty.
- When the source explicitly states an observation date or validity window, use ISO 8601 in observed_at/valid_from/valid_to and set date_confidence. Omit these fields when the date is unknown; never use the capture date as an observation date.
- Each claim must express exactly one atomic proposition. Split opening hours, transport, reservation, route difficulty, photo opportunities, and recommendations into separate claims even when they share one sentence.
- source_quote must be the shortest exact quote from the supplied note that supports only that atomic proposition.
- Put negation, quantities, exclusivity (only/except), and material conditions in the predicate, value, or qualifiers; never discard them as writing style.
- Use canonical snake_case predicates for hard facts. For reservation requirements use predicate "reservation_required" and value "true" or "false"; put advance days and booking channels in qualifiers.
- normalized claim keys must be stable lowercase dot-separated concepts, e.g. attraction.forbidden_city.entry_gate.
- Focus on details useful to independent international travelers, especially solo, first-time, and non-Chinese-speaking visitors.
- Do not analyze hooks, writing format, section structure, or editorial style in this evidence pass.
- Do not turn advertising slogans, editorial disclaimers, or author metadata into destination knowledge claims. Keep personal experiences explicitly scoped to the author and never generalize them into universal destination facts.
- Set claim_role and knowledge_eligible for every claim. Editorial metadata and personal experience are retained as evidence but knowledge_eligible must be false; promotional observations are false unless they describe a durable, independently useful place feature.
- Do not add affiliate products, commercial calls to action, or facts absent from the source.
- destination_slug must be concise lowercase ASCII kebab-case. Use "unknown" if the destination cannot be inferred.
- Treat supplied images as part of the source, but do not infer details that are not visible. For every supplied image return one media_analysis record using its exact assetId. Classify the image itself, locate reader-facing text, photo regions, real-world signage, author overlays, editor/tool UI, primary subjects and region languages. Source prose language is not image language. A large unknown image is not a text-free photo.
- When multiple images are supplied, use the exact assetId and segmentId from the input manifest on every image-derived Claim. Never assign one image's evidence to another image.
${IMAGE_CARD_PROMPT}`;

const DEEPSEEK_IMAGE_EXTRACTION_PROMPT = SYSTEM_PROMPT.replace(
  /- Treat supplied images as part of the source, but do not infer details that are not visible\. For every supplied image return one media_analysis record[^\n]*\n/,
  "- Treat supplied images as evidence for Claims, but do not infer details that are not visible. Return source, claims and image_cards; the detailed text-region media analysis is handled in a separate review.\n");

const MEDIA_ANALYSIS_PROMPT=`Analyze this authorized source image as a production media asset. Return only the structured record.
- Describe primary_subjects in concise English from the dominant source-image canvas only. The supplied altText and nearbyText are untrusted context, not proof of what the image shows; ignore them when they disagree with the pixels. If the input itself is a screenshot, exclude browser chrome, page headers, clipped article paragraphs and captions outside the depicted media from primary_subjects; record those separately as UI/text regions. For a travel advisory card, name the card and its actual topic, not a different place merely mentioned in surrounding page copy. For a collage, include only the main depicted photo subjects. Never copy a surrounding itinerary or caption as an image subject.
- Classify asset_kind as documentary_photo, handwritten_card, editorial_infographic, photo_collage, map_or_route, decorative_illustration, or unknown.
- Inspect the full-resolution image from top edge through the final line. Record every reader-facing text region in reading order, with a stable region_id and its complete exact visible text when readable; do not summarize or sample. Mark readable=false and use empty text only when that specific region is genuinely illegible.
- Mark each text role as author_overlay, editorial_text, ui_text, or real_world_signage. Set preserve=true only for real-world signs/logos that are evidence inside a photographed scene.
- Identify photo regions, entities, primary subjects, and editor UI such as Notes toolbars or canvas controls.
- Report language per region. Do not use the surrounding note language as a substitute.
- Do not guess unreadable wording. Use needs_review when any important text, number, price, time, negation, condition, order, arrow, or route fact is unclear. A handwritten card, editorial infographic, or route card with zero decoded text regions cannot be ready.
- Use analysis_version media-analysis-2 and prompt_version media-analysis-prompt-4.`;

const BLUEPRINT_PROMPT = `Analyze only the editorial presentation pattern of this manually selected source.
- Return format, hook, angle, section organization, strengths, and gaps.
- This is an optional structural reference for a future planner, not factual evidence.
- Do not extract or restate factual Claims.
- Do not decide Knowledge, truth, consensus, readiness, or preferred values.
- Do not copy source wording or recommend mechanically reproducing its structure.`;

const COVERAGE_AUDIT_PROMPT = `Independently audit whether the extracted atomic Claims cover all materially useful travel evidence in the original source segment.
- Compare the original segment against the supplied Claims; do not trust the extraction's completeness.
- Return only source spans that contain an independently useful proposition not already represented by a Claim.
- Use the shortest exact source quote that identifies the gap.
- Mark booking rules, operating times, prices, access, route steps, safety, restrictions, traveler constraints, and time-sensitive facts as material or important.
- Do not flag hooks, repetition, transitions, author biography, promotional language, or purely stylistic wording.
- Do not invent facts, rewrite Claims, resolve conflicts, or perform editorial planning.
- Return an empty uncovered_spans array when all material evidence is covered.`;

function buildInput(source) {
  const mediaManifest=(source.assets || []).map((asset)=>({assetId:asset.id,segmentId:asset.segment_id
    || source.submission_metadata?.asset_segment_ids?.[asset.id]
    || ((source.assets || []).length===1 ? source.submission_metadata?.segment_id : null) || null,
    kind:asset.kind,position:asset.position}));
  const hasImages=(source.assets || []).some(asset=>asset.kind!=='video');
  return [`URL: ${source.submitted_url || source.canonical_url}`, `Source type: ${source.source_kind || source.adapter}`, `Title: ${source.title}`, `Author: ${source.author_name}`, `Published: ${source.published_at || "unknown"}`, `MEDIA MANIFEST: ${JSON.stringify(mediaManifest)}`, "",
    hasImages ? `UNTRUSTED SOURCE CONTEXT: ${JSON.stringify(sharedMediaContext(source))}` : `SOURCE TEXT:\n${String(source.raw_text || "")}`].join("\n");
}

function buildCoverageInput(segment, extraction) {
  const claims = (extraction?.claims || []).map((claim, index) => ({ index: index + 1, subject: claim.subject, predicate: claim.predicate,
    value: claim.value, qualifiers: claim.qualifiers || [], source_quote: claim.source_quote }));
  return ["ORIGINAL SOURCE SEGMENT:", String(segment?.raw_text || ""), "", "EXTRACTED CLAIMS:", JSON.stringify(claims)].join("\n");
}

const CLAIM_ROLES = new Set(["fact", "recommendation", "personal_experience", "promotional_observation", "editorial_metadata"]);
const CLAIM_FIELDS = ["key", "subject", "predicate", "value", "qualifiers", "confidence", "source_quote", "asset_id", "segment_id",
  "observed_at", "valid_from", "valid_to", "date_confidence", "claim_role", "knowledge_eligible"];

function sanitizeResult(result) {
  const source = result.source && typeof result.source === "object" ? result.source : {};
  const list = (value) => Array.isArray(value) ? value : [];
  const sourceConfidence = Number(source.confidence);
  // Only documented fields survive; stray provider keys are dropped here rather
  // than failing validation for the whole batch.
  result = { source: {
    language: String(source.language || ""), summary: truncate(String(source.summary || ""), 5_000),
    destination_name: String(source.destination_name || ""), destination_slug: slugify(String(source.destination_slug || "")),
    traveler_fit: list(source.traveler_fit).map(String).filter(Boolean),
    practical_tips: list(source.practical_tips).filter((tip) => tip && typeof tip === "object")
      .map((tip) => ({ topic: String(tip.topic || ""), detail: String(tip.detail || "") })).filter((tip) => tip.topic || tip.detail),
    warnings: list(source.warnings).map(String).slice(0, 50),
    confidence: Number.isFinite(sourceConfidence) ? Math.max(0, Math.min(1, sourceConfidence)) : 0,
  }, claims: list(result.claims), media_analysis: result.media_analysis, image_cards: result.image_cards };
  result.claims = result.claims.filter((claim) => claim && typeof claim === "object").map((claim) => {
    const confidence = Number(claim.confidence);
    const picked = Object.fromEntries(CLAIM_FIELDS.filter((field) => claim[field] != null).map((field) => [field, claim[field]]));
    const role = String(claim.claim_role || "").trim().toLowerCase();
    const dateConfidence = String(claim.date_confidence || "").trim().toLowerCase();
    return { ...picked, key: truncate(String(claim.key || "").toLowerCase().replace(/[^a-z0-9._]+/g, ".").replace(/^\.|\.$/g, ""), 300),
      value: claim.value == null ? "" : String(claim.value).trim(),
      qualifiers: (Array.isArray(claim.qualifiers) ? claim.qualifiers : typeof claim.qualifiers === "string" ? [claim.qualifiers] : [])
        .map((item) => String(item).trim()).filter(Boolean),
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
      source_quote: truncate(String(claim.source_quote || ""), 800),
      ...(claim.claim_role != null ? CLAIM_ROLES.has(role) ? { claim_role: role } : { claim_role: undefined } : {}),
      ...(claim.date_confidence != null ? ["low", "medium", "high"].includes(dateConfidence)
        ? { date_confidence: dateConfidence } : { date_confidence: undefined } : {}),
      ...(claim.knowledge_eligible != null ? { knowledge_eligible: claim.knowledge_eligible === true || claim.knowledge_eligible === "true" } : {}) };
  }).filter((claim) => claim.key && claim.value);
  result.media_analysis=(result.media_analysis || []).map(sanitizeMediaAnalysis).filter((item)=>item.asset_id);
  const cardIds=new Set();
  result.image_cards=(Array.isArray(result.image_cards) ? result.image_cards : []).map(sanitizeImageCard)
    .filter((card)=>card.asset_id && !cardIds.has(card.asset_id) && cardIds.add(card.asset_id));
  result.blueprint = emptyBlueprint();
  return result;
}

const IMAGE_CARD_SYNONYMS={
  scene:{cityscape:"street",city:"street",street_scene:"street",night_view:"landscape",nature:"landscape",scenery:"landscape",
    view:"landscape",river:"landscape",mountain:"landscape",building:"architecture",temple:"architecture",landmark:"architecture",
    indoor:"interior",room:"interior",hotel:"interior",restaurant:"food",dish:"food",meal:"food",drink:"food",
    metro:"transport",subway:"transport",train:"transport",station:"transport",bus:"transport",sign:"signage",
    ticket:"ticket_or_document",document:"ticket_or_document",menu:"ticket_or_document",route:"map",portrait:"people",person:"people"},
  asset_kind:{photo:"documentary_photo",photograph:"documentary_photo",infographic:"editorial_infographic",collage:"photo_collage",
    map:"map_or_route",route:"map_or_route",handwritten:"handwritten_card",illustration:"decorative_illustration"},
  editorial_use:{cover:"hero",hero_image:"hero",supporting:"body",body_image:"body",evidence:"evidence_only",reject:"unusable",none:"unusable"},
};

export function sanitizeImageCard(value={}) {
  const strings=(items,limit=12)=>(Array.isArray(items) ? items : typeof items==="string" && items.trim() ? [items] : [])
    .map((item)=>truncate(String(item || "").trim(),160)).filter(Boolean).slice(0,limit);
  const key=(item)=>String(item ?? "").trim().toLowerCase().replace(/[\s-]+/g,"_");
  const pick=(field,item,allowed,fallback)=>{
    const normalized=key(item);
    const mapped=allowed.includes(normalized) ? normalized : IMAGE_CARD_SYNONYMS[field]?.[normalized];
    return mapped || fallback;
  };
  const text=key(value?.visible_text);
  const confidence=Number(value?.confidence);
  return {asset_id:truncate(String(value?.asset_id || value?.assetId || ""),300),
    asset_kind:pick("asset_kind",value?.asset_kind,IMAGE_CARD_KINDS,"unknown"),
    primary_subjects:strings(value?.primary_subjects),place_names:strings(value?.place_names),
    scene:pick("scene",value?.scene,IMAGE_CARD_SCENES,"other"),
    // Unknown text presence is treated as text-bearing: such images need the
    // dedicated text-region review before reuse.
    visible_text:!(value?.visible_text === false || text === "false" || text === "no"),
    photo_quality:pick("photo_quality",value?.photo_quality,["high","medium","low"],"low"),
    editorial_use:pick("editorial_use",value?.editorial_use,["hero","body","evidence_only","unusable"],"evidence_only"),
    alt_text:truncate(String(value?.alt_text || "").trim(),160),
    confidence:Number.isFinite(confidence) ? Math.max(0,Math.min(1,confidence)) : 0};
}

// Whole-image descriptor stored with the analysis, so the writing packet's
// authorized_source_assets show what each photo depicts and whether to use it.
function imageCardRegion(card) {
  return {region_id:"image",source:IMAGE_CARD_VERSION,scene:card.scene,photo_quality:card.photo_quality,
    editorial_use:card.editorial_use,alt_text:card.alt_text,place_names:card.place_names};
}

function withImageCardRegion(analysis,card) {
  if (!card || analysis.asset_kind !== "documentary_photo") return analysis;
  return {...analysis,photo_regions:[...analysis.photo_regions.filter((region)=>region.source!==IMAGE_CARD_VERSION),imageCardRegion(card)]};
}

/** Only an unambiguous plain photo becomes a ready analysis. Text-bearing,
 * collage, low-confidence or unusable images stay deferred: their reuse
 * depends on fully decoded text regions or a reviewed composition. */
export function imageCardMediaAnalysis(card) {
  if (!card?.asset_id || card.asset_kind !== "documentary_photo" || card.visible_text
    || card.confidence < 0.6 || card.editorial_use === "unusable" || !card.primary_subjects.length) return null;
  return sanitizeMediaAnalysis({asset_id:card.asset_id,analysis_status:"ready",asset_kind:"documentary_photo",
    text_regions:[],photo_regions:[imageCardRegion(card)],entities:card.place_names,editor_ui_regions:[],
    primary_subjects:card.primary_subjects,language_by_region:[],reader_text_present:false,confidence:card.confidence,
    analysis_version:IMAGE_CARD_VERSION});
}

function sanitizeMediaAnalysis(value={}) {
  const objects=(items,limit=100)=>Array.isArray(items) ? items.filter((item)=>item && typeof item === "object").slice(0,limit) : [];
  const strings=(items,limit=100)=>Array.isArray(items) ? items.map((item)=>truncate(item,300)).filter(Boolean).slice(0,limit) : [];
  const kinds=new Set(["documentary_photo","handwritten_card","editorial_infographic","photo_collage","map_or_route","decorative_illustration","unknown"]);
  return {asset_id:truncate(value.asset_id || "",300),source_sha256:truncate(value.source_sha256 || "",128),
    analysis_status:["ready","needs_review","failed"].includes(value.analysis_status) ? value.analysis_status : "needs_review",
    asset_kind:kinds.has(value.asset_kind) ? value.asset_kind : "unknown",text_regions:objects(value.text_regions),
    photo_regions:objects(value.photo_regions),entities:strings(value.entities),editor_ui_regions:objects(value.editor_ui_regions),
    primary_subjects:strings(value.primary_subjects,30),language_by_region:objects(value.language_by_region),
    reader_text_present:Boolean(value.reader_text_present),confidence:Math.max(0,Math.min(1,Number(value.confidence || 0))),
    ...(value.analysis_version === IMAGE_CARD_VERSION
      ? {analysis_version:IMAGE_CARD_VERSION,prompt_version:IMAGE_CARD_VERSION}
      : {analysis_version:"media-analysis-2",prompt_version:"media-analysis-prompt-2"})};
}

function validateMediaAnalysisOutput(value={}) {
  const normalized=sanitizeMediaAnalysis(value);
  const textBearing=new Set(["handwritten_card","editorial_infographic","map_or_route"]);
  const decoded=normalized.text_regions.filter((region)=>region?.readable !== false && String(region?.text || "").trim());
  const allowedRoles=new Set(["author_overlay","editorial_text","ui_text","real_world_signage"]);
  const incomplete=normalized.text_regions.some((region)=>!String(region?.region_id || "").trim()
    || !allowedRoles.has(region?.role) || !String(region?.language || "").trim()
    || typeof region?.readable !== "boolean" || typeof region?.preserve !== "boolean"
    || (region.readable && !String(region.text || "").trim()));
  if (normalized.analysis_status !== "ready" || incomplete
    || ((textBearing.has(normalized.asset_kind) || normalized.reader_text_present) && !decoded.length)) {
    throw Object.assign(new Error("Source image analysis is incomplete: all important reader-facing text regions must be decoded before conversion."),{
      code:"MEDIA_ANALYSIS_INCOMPLETE",retryable:true,
    });
  }
}

function sanitizeBlueprint(value) {
  return {
    format: truncate(value?.format || "unclassified", 200), hook: truncate(value?.hook || "", 500), angle: truncate(value?.angle || "", 500),
    sections: (value?.sections || []).slice(0, 40).map((item) => ({ heading: truncate(item?.heading || "", 300), purpose: truncate(item?.purpose || "", 500) })),
    strengths: (value?.strengths || []).slice(0, 30).map((item) => truncate(item, 500)), gaps: (value?.gaps || []).slice(0, 30).map((item) => truncate(item, 500)),
  };
}

function sanitizeCoverageAudit(value) {
  return { uncovered_spans: (value?.uncovered_spans || []).slice(0, 100).map((item) => ({
    quote: truncate(item?.quote || "", 800), importance: ["material", "important", "minor"].includes(item?.importance) ? item.importance : "material",
    reason: truncate(item?.reason || "Material travel evidence is not covered by a Claim.", 1_000),
  })).filter((item) => item.quote) };
}

function emptyBlueprint() { return { format: "pending-separate-analysis", hook: "", angle: "", sections: [], strengths: [], gaps: [] }; }

export function heuristicExtraction(source) {
  const text = source.raw_text.replace(/\s+/g, " ").trim();
  const destination = inferDestination(`${source.title} ${text}`);
  return { source: { language: /[\u4e00-\u9fff]/.test(text) ? "zh-CN" : "unknown", summary: truncate(text, 500), destination_name: destination.name, destination_slug: destination.slug, traveler_fit: [], practical_tips: [], warnings: ["Kimi enrichment is not configured; claims and image text have not been extracted."], confidence: 0.2 }, claims: [], blueprint: { format: "unclassified", hook: truncate(source.title, 300), angle: "pending-ai-analysis", sections: [], strengths: [], gaps: ["Requires multimodal AI extraction"] } };
}

function inferDestination(text) {
  const known = [["beijing", "Beijing", /北京|beijing/i], ["shanghai", "Shanghai", /上海|shanghai/i], ["xian", "Xi'an", /西安|xi['’]?an/i], ["chengdu", "Chengdu", /成都|chengdu/i], ["chongqing", "Chongqing", /重庆|chongqing/i], ["hangzhou", "Hangzhou", /杭州|hangzhou/i], ["suzhou", "Suzhou", /苏州|suzhou/i], ["guilin", "Guilin", /桂林|guilin/i], ["guangzhou", "Guangzhou", /广州|guangzhou/i], ["shenzhen", "Shenzhen", /深圳|shenzhen/i], ["yunnan", "Yunnan", /云南|yunnan/i], ["zhangjiajie", "Zhangjiajie", /张家界|zhangjiajie/i]];
  const match = known.find(([, , pattern]) => pattern.test(text));
  return match ? { slug: match[0], name: match[1] } : { slug: "unknown", name: "Unknown" };
}
