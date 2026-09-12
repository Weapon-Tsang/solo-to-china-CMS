import assert from "node:assert/strict";
import test from "node:test";
import { normalizeXiaohongshuCapture } from "../src/adapters/xiaohongshu.mjs";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";

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
  const savedSegments=repository.saveMediaBatchExtraction(batches[0].id,{method:"fixture_multimodal",model:"fixture",inputManifest:manifest,
    result:{source:{language:"zh-CN",summary:"",destination_name:"Test",destination_slug:"test",traveler_fit:[],practical_tips:[],warnings:[],confidence:0.8},
      claims:[{key:"test.visible.fact",subject:"Place",predicate:"feature",value:"visible",qualifiers:[],confidence:0.8,
        source_quote:"visible",asset_id:target.id,segment_id:target.segment_id}],blueprint:{}}});
  assert.equal(savedSegments.length,batches[0].segmentIds.length);
  const results=db.prepare(`SELECT segment_id,result_json FROM segment_extractions WHERE segment_id IN (${savedSegments.map(()=>"?").join(",")})`).all(...savedSegments);
  assert.equal(results.reduce((sum,row)=>sum+JSON.parse(row.result_json).claims.length,0),1);
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
