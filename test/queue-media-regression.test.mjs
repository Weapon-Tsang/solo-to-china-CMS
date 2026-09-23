import assert from "node:assert/strict";
import test from "node:test";
import { normalizeXiaohongshuCapture } from "../src/adapters/xiaohongshu.mjs";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";
import { Pipeline } from "../src/pipeline.mjs";

test("ordinary image segments form traceable 4-8 item model batches while maps stay individual", (t) => {
  const {repository,db}=repositoryFixture(t);
  const images=[
    ...Array.from({length:19},(_,index)=>({url:`https://sns-img.xhscdn.com/batch-${index}.jpg`,alt:`ordinary travel photo ${index}`})),
    {url:"https://sns-img.xhscdn.com/map.jpg",alt:"route map with station labels"},
  ];
  const saved=repository.saveCapture(normalizeXiaohongshuCapture({
    url:"https://www.xiaohongshu.com/explore/media-batch-regression",title:"Traceable media batch",
    text:"A complete paragraph of source evidence accompanies the image set.",images,
  }));
  db.prepare("DELETE FROM jobs").run();
  const segments=repository.prepareSourceSegments(saved.id);
  const batches=repository.prepareMediaExtractionBatches(saved.id);
  assert.deepEqual(batches.map((batch)=>batch.assetIds.length),[5,5,5,4]);
  assert.ok(batches.every((batch)=>batch.assetIds.length>=4&&batch.assetIds.length<=8));
  const batched=new Set(batches.flatMap((batch)=>batch.segmentIds));
  const mapAsset=db.prepare("SELECT id FROM current_source_assets WHERE source_id=? AND alt_text LIKE '%route map%'").get(saved.id);
  const mapSegment=segments.find((segment)=>(segment.assetId||segment.asset_id)===mapAsset.id);
  assert.equal(batched.has(mapSegment.id),false);
  const pack=repository.getMediaBatchExtractionPackage(batches[0].id);
  assert.equal(pack.source.assets.length,batches[0].assetIds.length);
  assert.ok(pack.source.assets.every((asset)=>asset.segment_id));
  const target=pack.source.assets[0];
  const manifest={version:1,expectedModality:"image",receivedModality:"image",provider:"fixture",model:"fixture",
    capabilities:{text:true,image:true,video:false,batch:false},assets:pack.source.assets.map((asset)=>({
      assetId:asset.id,hash:null,kind:"image",status:"submitted",requestReference:"fixture",
    }))};
  assert.throws(()=>repository.saveMediaBatchExtraction(batches[0].id,{method:"fixture",model:"fixture",
    result:{source:{},claims:[{key:"unattributed",source_quote:"visible"}]}}),
  error=>error.code==="MEDIA_CLAIM_ATTRIBUTION_MISSING");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM segment_extractions WHERE source_id=?").get(saved.id).count,0);
  const savedSegments=repository.saveMediaBatchExtraction(batches[0].id,{method:"fixture_multimodal",model:"fixture",inputManifest:manifest,
    result:{source:{language:"zh-CN",summary:"",destination_name:"Test",destination_slug:"test",traveler_fit:[],practical_tips:[],warnings:[],confidence:0.8},
      media_analysis:pack.source.assets.map((asset)=>({asset_id:asset.id,analysis_status:"needs_review",asset_kind:"unknown",
        text_regions:[],photo_regions:[],entities:[],editor_ui_regions:[],primary_subjects:[],language_by_region:[],
        reader_text_present:true,confidence:0,analysis_version:"media-analysis-2",prompt_version:"media-analysis-prompt-2"})),
      claims:[{key:"test.visible.fact",subject:"Place",predicate:"feature",value:"visible",qualifiers:[],confidence:0.8,
        source_quote:"visible",asset_id:target.id,segment_id:target.segment_id}],blueprint:{}}});
  assert.equal(savedSegments.length,batches[0].segmentIds.length);
  const results=db.prepare(`SELECT segment_id,result_json FROM segment_extractions WHERE segment_id IN (${savedSegments.map(()=>"?").join(",")})`).all(...savedSegments);
  assert.equal(results.reduce((sum,row)=>sum+JSON.parse(row.result_json).claims.length,0),1);
  assert.deepEqual(db.prepare(`SELECT analysis_status,reader_text_present FROM source_asset_analyses
    WHERE asset_id IN (${pack.source.assets.map(()=>"?").join(",")})`).all(...pack.source.assets.map((asset)=>asset.id))
    .map((row)=>[row.analysis_status,row.reader_text_present]),pack.source.assets.map(()=>["needs_review",1]));
});

test("media batch output limit halves work before falling back to individual images", async (t) => {
  const {repository,db}=repositoryFixture(t);
  const saved=repository.saveCapture(normalizeXiaohongshuCapture({
    url:"https://www.xiaohongshu.com/explore/media-output-limit",title:"Seven image guide",
    text:"A complete paragraph of source evidence accompanies the images.",
    images:Array.from({length:7},(_,index)=>({url:`https://sns-img.xhscdn.com/limit-${index}.jpg`,alt:`travel photo ${index}`})),
  }));
  db.prepare("DELETE FROM jobs").run();
  repository.prepareSourceSegments(saved.id);
  repository.contentConfig.mediaImageBatchSize=8;
  const [batch]=repository.prepareMediaExtractionBatches(saved.id);
  assert.equal(batch.segmentIds.length,7);
  repository.enqueue("extract_media_batch",batch.id);
  const pipeline=new Pipeline(repository,{async extract(source){
    if(source.assets.length>2)throw Object.assign(new Error("output token limit"),{code:"MODEL_OUTPUT_LIMIT",retryable:true});
    return {method:"fixture",model:"fixture",result:{source:{},claims:[]}};
  }},{maxConcurrent:1});
  assert.equal(await pipeline.runOne(),true);
  assert.equal(db.prepare("SELECT status FROM media_extraction_batches WHERE id=?").get(batch.id).status,"complete");
  assert.deepEqual(db.prepare("SELECT json_array_length(segment_ids_json) AS count FROM media_extraction_batches WHERE status='pending' ORDER BY sequence").all().map((row)=>row.count),[4,3]);
  for(let index=0;index<40&&db.prepare("SELECT COUNT(*) AS count FROM segment_extractions WHERE source_id=?").get(saved.id).count<7;index++)
    assert.equal(await pipeline.runOne(),true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM segment_extractions WHERE source_id=?").get(saved.id).count,7);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type='extract_media_batch' AND status='failed'").get().count,0);
  assert.equal(repository.prepareMediaExtractionBatches(saved.id).length,0);
});

test("DeepSeek and Gemini route image segments individually after multi-image attribution failures",async(t)=>{
  for(const provider of ["deepseek","gemini"]){
  const {repository,db}=repositoryFixture(t);
  const saved=repository.saveCapture(normalizeXiaohongshuCapture({
    url:`https://www.xiaohongshu.com/explore/${provider}-single-image-routing`,title:"Three image guide",
    text:"A complete paragraph of source evidence accompanies the images.",
    images:Array.from({length:3},(_,index)=>({url:`https://sns-img.xhscdn.com/${provider}-${index}.jpg`,alt:`photo ${index}`})),
  }));
  db.prepare("DELETE FROM jobs").run();
  repository.enqueue("segment_source",saved.id);
  const pipeline=new Pipeline(repository,{config:{provider}},{maxConcurrent:1});
  assert.equal(await pipeline.runOne(),true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM media_extraction_batches WHERE source_id=?").get(saved.id).count,0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM jobs j JOIN source_segments ss ON ss.id=j.entity_id
    WHERE ss.source_id=? AND ss.asset_id IS NOT NULL AND j.type='extract_segment_claims' AND j.status='queued'`)
    .get(saved.id).count,3);
  }
});

test("existing failed media batches recover once into single-image jobs", (t) => {
  const {repository,db}=repositoryFixture(t);
  const saved=repository.saveCapture(normalizeXiaohongshuCapture({
    url:"https://www.xiaohongshu.com/explore/failed-media-output-limit",title:"Failed image guide",
    text:"Source text with seven image assets.",
    images:Array.from({length:7},(_,index)=>({url:`https://sns-img.xhscdn.com/recover-${index}.jpg`,alt:`photo ${index}`})),
  }));
  db.prepare("DELETE FROM jobs").run();
  repository.prepareSourceSegments(saved.id);
  repository.contentConfig.mediaImageBatchSize=8;
  const [batch]=repository.prepareMediaExtractionBatches(saved.id);
  const jobId=repository.enqueue("extract_media_batch",batch.id);
  db.prepare("UPDATE jobs SET status='failed',attempts=3,last_failure_code='MODEL_OUTPUT_LIMIT' WHERE id=?").run(jobId);
  assert.equal(repository.recoverFailedMediaBatchOutputLimits(),1);
  assert.equal(repository.recoverFailedMediaBatchOutputLimits(),0);
  assert.deepEqual(db.prepare("SELECT json_array_length(segment_ids_json) AS count FROM media_extraction_batches WHERE status='pending' ORDER BY sequence").all().map((row)=>row.count),[4,3]);
  assert.equal(db.prepare("SELECT status FROM media_extraction_batches WHERE id=?").get(batch.id).status,"complete");
});

test("failed current-image schema jobs receive one versioned recovery attempt",(t)=>{
  const {repository,db}=repositoryFixture(t);
  const saved=repository.saveCapture(normalizeXiaohongshuCapture({
    url:"https://www.xiaohongshu.com/explore/failed-single-image",title:"Failed image",
    text:"A complete paragraph of source evidence accompanies this image.",
    images:[{url:"https://sns-img.xhscdn.com/failed-single.jpg",alt:"route map with station labels"}],
  }));
  db.prepare("DELETE FROM jobs").run();
  const imageSegment=repository.prepareSourceSegments(saved.id).find((segment)=>segment.assetId||segment.asset_id);
  assert.ok(imageSegment);
  const failedId=repository.enqueue("extract_segment_claims",imageSegment.id);
  db.prepare("UPDATE jobs SET status='failed',attempts=3,last_failure_code='INVALID_MODEL_OUTPUT' WHERE id=?").run(failedId);
  assert.equal(repository.recoverFailedImageExtractionJobs(),1);
  assert.equal(repository.recoverFailedImageExtractionJobs(),0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE entity_id=? AND status='queued'").get(imageSegment.id).count,1);
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id=?").get(failedId).status,"failed");
});

test("processing-gap recovery is dry-run by default and execution requires the exact reviewed fingerprint", (t) => {
  const {repository,db}=repositoryFixture(t);
  const saved=repository.saveCapture({
    adapter:"manual",externalId:"gap",canonicalUrl:"https://example.com/gap",title:"Gap",authorName:"",authorUrl:"",
    publishedAt:null,capturedAt:new Date().toISOString(),rawText:"Complete text evidence with enough detail for extraction.",
    rawHtml:"",sourceKind:"manual_text",assets:[],files:[],completeness:{overall:"complete"},rights:{},client:{},
  });
  db.prepare("DELETE FROM jobs").run();
  const dry=repository.runSourceProcessingGapRecovery();
  assert.equal(dry.dryRun,true);
  assert.equal(dry.items.some((item)=>item.sourceId===saved.id),true);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM jobs").get().count,0);
  const executed=repository.runSourceProcessingGapRecovery({dryRun:false,approvedFromRunId:dry.id});
  assert.equal(executed.queued,true);
  const job=db.prepare("SELECT type,priority FROM jobs WHERE entity_id=?").get(saved.id);
  assert.equal(job.type,"preflight_source");
  assert.equal(job.priority,70);
});

test("provider runtime uses persisted telemetry and source status/timeline stay capture-version scoped", (t) => {
  const {repository}=repositoryFixture(t);
  repository.recordModelCall({stage:"source_research_extraction",provider:"vertex",model:"gemini-test",status:"succeeded",latencyMs:125});
  const runtime=repository.providerRuntime({provider:"vertex",model:"gemini-test",configured:true});
  assert.equal(runtime.state,"available_recent_success");
  assert.equal(runtime.windows.oneHour.successes,1);
  const saved=repository.saveCapture({
    adapter:"manual",externalId:"status",canonicalUrl:"https://example.com/status",title:"Status",authorName:"",authorUrl:"",
    publishedAt:null,capturedAt:new Date().toISOString(),rawText:"Version scoped source status evidence.",
    rawHtml:"",sourceKind:"manual_text",assets:[],files:[],completeness:{overall:"complete"},rights:{},client:{},
  });
  const status=repository.listSourceStatusProjection({ids:[saved.id]})[0];
  assert.equal(status.capture_version,1);
  assert.equal(status.current_stage,"extract_source");
  assert.equal(repository.sourceTimeline(saved.id).some((event)=>event.stage==="capture_saved"),true);
});

test("AI coverage routing is opt-in and cannot enter the paid Batch path by default", (t) => {
  const {repository}=repositoryFixture(t);
  const saved=repository.saveCapture({
    adapter:"manual",externalId:"coverage-opt-in",canonicalUrl:"https://example.com/coverage-opt-in",title:"Coverage",authorName:"",authorUrl:"",
    publishedAt:null,capturedAt:new Date().toISOString(),rawText:"Adult tickets cost 60 CNY and the museum opens at 09:00 every day.",
    rawHtml:"",sourceKind:"manual_text",assets:[],files:[],completeness:{overall:"complete"},rights:{},client:{},
  });
  const [segment]=repository.prepareSourceSegments(saved.id);
  repository.saveSegmentExtraction(segment.id,{method:"fixture",model:"fixture",result:{source:{},claims:[]}});
  repository.enqueue("audit_segment_coverage",segment.id);
  assert.equal(repository.shouldRunAiCoverage(segment.id),false);
  assert.equal(repository.countVertexBatchEligibleJobs("audit_segment_coverage"),0);
});

test("media storage migration remains a non-mutating estimate", (t) => {
  const {repository,db}=repositoryFixture(t);
  const before=db.prepare("SELECT COUNT(*) count FROM source_assets").get().count;
  const report=repository.runMediaStorageMigrationEstimate();
  assert.equal(report.dryRun,true);
  assert.equal(report.policy.automaticDeletion,false);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM source_assets").get().count,before);
});
