import assert from "node:assert/strict";
import test from "node:test";
import { KimiExtractor } from "../src/ai/kimi.mjs";

test("single-image analysis rejects a ready handwritten card with no decoded text", async () => {
  const output={asset_id:"asset-card",source_sha256:"sha",analysis_status:"ready",asset_kind:"handwritten_card",
    text_regions:[],photo_regions:[],entities:[],editor_ui_regions:[],primary_subjects:[],language_by_region:[],
    reader_text_present:true,confidence:0.95,analysis_version:"media-analysis-2",prompt_version:"media-analysis-prompt-2"};
  const extractor=new KimiExtractor({provider:"vertex",projectId:"project",location:"global",model:"gemini-2.5-pro",
    accessToken:"token",maxCompletionTokens:16_000},async()=>Response.json({
      candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify(output)}]}}],
    }));
  await assert.rejects(()=>extractor.analyzeMediaAsset({id:"asset-card",original_sha256:"sha",
    ai_derivative_data_url:`data:image/png;base64,${Buffer.from("fixture").toString("base64")}`}),
  (error)=>error.code==="MEDIA_ANALYSIS_INCOMPLETE"&&error.retryable===true);
});

test("single-image analysis records the actual prompt revision, not the model's self-reported version", async () => {
  const output={asset_id:"asset-photo",source_sha256:"sha",analysis_status:"ready",asset_kind:"documentary_photo",
    text_regions:[],photo_regions:[],entities:[],editor_ui_regions:[],primary_subjects:["Chongqing street photo"],
    language_by_region:[],reader_text_present:false,confidence:0.95,
    analysis_version:"media-analysis-2",prompt_version:"media-analysis-prompt-2"};
  const extractor=new KimiExtractor({provider:"vertex",projectId:"project",location:"global",model:"gemini-2.5-pro",
    accessToken:"token",maxCompletionTokens:16_000},async()=>Response.json({
      candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify(output)}]}}],
    }));
  const analyzed=await extractor.analyzeMediaAsset({id:"asset-photo",original_sha256:"sha",
    ai_derivative_data_url:`data:image/png;base64,${Buffer.from("fixture").toString("base64")}`});
  assert.equal(analyzed.result.prompt_version,"media-analysis-prompt-3");
});
