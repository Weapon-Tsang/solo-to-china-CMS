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
  assert.equal(analyzed.result.prompt_version,"media-analysis-prompt-4");
});

// Production regression (Three Gorges Museum draft): three cache-hit replays of
// one source analysis were recorded as paid dispatches, exhausted the visual's
// analyze_source_image budget and stranded a persisted candidate before its QA.
test("a cached source analysis replay does not consume the paid media dispatch budget", async () => {
  const output={asset_id:"asset-photo",source_sha256:"sha",analysis_status:"ready",asset_kind:"documentary_photo",
    text_regions:[],photo_regions:[],entities:[],editor_ui_regions:[],primary_subjects:["Chongqing street photo"],
    language_by_region:[],reader_text_present:false,confidence:0.95,
    analysis_version:"media-analysis-2",prompt_version:"media-analysis-prompt-4"};
  let providerRequests=0;
  const permits=[];
  const mediaRequestExecutor={acquire(request){
    const permit={request,finished:[],finish(result={}){ this.finished.push(result); }};
    permits.push(permit); return permit;
  }};
  const extractor=new KimiExtractor({provider:"vertex",projectId:"project",location:"global",model:"gemini-2.5-pro",
    accessToken:"token",maxCompletionTokens:16_000,mediaRequestExecutor},async()=>{
    providerRequests++;
    return Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify(output)}]}}]});
  });
  const asset={id:"asset-photo",original_sha256:"sha",
    ai_derivative_data_url:`data:image/png;base64,${Buffer.from("fixture").toString("base64")}`};
  const telemetryContext={runId:"job-cache",visualId:"visual-cache"};
  await extractor.analyzeMediaAsset(asset,{telemetryContext});
  await extractor.analyzeMediaAsset(asset,{telemetryContext});
  assert.equal(providerRequests,1,"the replay is served from the response cache");
  assert.equal(permits.length,1,"only the request that reached the provider holds a dispatch permit");
  assert.equal(permits[0].request.visualId,"visual-cache");
  assert.equal(permits[0].request.substage,"analyze_source_image");
  assert.deepEqual(permits[0].finished,[{}]);
});

test("a blocked media dispatch stops source analysis before the provider request", async () => {
  let providerRequests=0;
  const mediaRequestExecutor={acquire(){
    throw Object.assign(new Error("Media dispatch budget is exhausted."),{code:"MEDIA_BUDGET_EXHAUSTED"});
  }};
  const extractor=new KimiExtractor({provider:"vertex",projectId:"project",location:"global",model:"gemini-2.5-pro",
    accessToken:"token",maxCompletionTokens:16_000,mediaRequestExecutor},async()=>{ providerRequests++; return Response.json({}); });
  await assert.rejects(()=>extractor.analyzeMediaAsset({id:"asset-blocked",original_sha256:"sha",
    ai_derivative_data_url:`data:image/png;base64,${Buffer.from("fixture").toString("base64")}`}),
  (error)=>error.code==="MEDIA_BUDGET_EXHAUSTED");
  assert.equal(providerRequests,0);
});
