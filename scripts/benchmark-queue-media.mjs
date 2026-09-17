import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { openDatabase } from "../src/db.mjs";
import { Repository } from "../src/repository.mjs";
import { estimateSourceProcessing } from "../src/source-preflight.mjs";
import { sourceProcessingProfile } from "../src/source-processing-profile.mjs";

const directory=fs.mkdtempSync(path.join(os.tmpdir(),"stc-queue-media-benchmark-"));
const db=openDatabase(path.join(directory,"benchmark.sqlite"));
const repository=new Repository(db,{mediaImageBatchSize:6,mediaBatchingEnabled:true});
const capturedAt=new Date().toISOString();
const makeAssets=(count,{map=false,video=false}={})=>Array.from({length:count},(_,index)=>({
  kind:video&&index===count-1?"video":"image",
  url:`https://example.com/media-${count}-${index}.${video&&index===count-1?"mp4":"jpg"}`,
  alt:map&&index===count-1?"route map with station labels":`ordinary travel photo ${index}`,
  position:index,durabilityStatus:"ORIGINAL_STORED",storageStatus:"saved",originalBytesStatus:"saved_original",
  localPath:`C:/fixture/${count}-${index}`,originalSha256:String(index).padStart(64,"0"),
}));
const fixtures=[
  {name:"short_text",rawText:"A concise but complete practical observation for a visitor.",assets:[]},
  {name:"long_text",rawText:"Transit, opening hours and route notes. ".repeat(900),assets:[]},
  {name:"text_plus_19_images",rawText:"One paragraph accompanies nineteen photographs.",assets:makeAssets(19)},
  {name:"text_plus_27_images_and_map",rawText:"A larger image-led guide includes a route map.",assets:makeAssets(27,{map:true})},
  {name:"video_with_operator_notes",rawText:"Operator transcript notes preserve the observable route and timing.",assets:makeAssets(1,{video:true})},
];
const results=[];
try {
  for(const [index,fixture] of fixtures.entries()){
    const capture={adapter:"manual",externalId:`benchmark-${index}`,canonicalUrl:`https://example.com/benchmark-${index}`,
      submittedUrl:`https://example.com/benchmark-${index}`,title:fixture.name,authorName:"",authorUrl:"",publishedAt:null,capturedAt,
      rawText:fixture.rawText,rawHtml:"",sourceKind:fixture.name.includes("video")?"video":"manual_source",
      assets:fixture.assets,files:[],completeness:{overall:"complete"},rights:{},client:{},
      submissionMetadata:{operatorNotesProvided:fixture.name.includes("video")}};
    const estimate=estimateSourceProcessing(capture,{imageBatchSize:6});
    const started=performance.now();
    const saved=repository.saveCapture(capture);
    db.prepare("DELETE FROM jobs").run();
    const segments=repository.prepareSourceSegments(saved.id);
    const batches=repository.prepareMediaExtractionBatches(saved.id);
    const elapsedMs=performance.now()-started;
    const batchedIds=new Set(batches.flatMap((batch)=>batch.segmentIds));
    const individualMediaSegments=segments.filter((segment)=>(segment.assetId||segment.asset_id)&&!batchedIds.has(segment.id));
    const optimizedRequests=segments.filter((segment)=>!(segment.assetId||segment.asset_id)).length+batches.length+individualMediaSegments.length;
    const legacyRequests=segments.length;
    const accountedMedia=new Set([...batches.flatMap((batch)=>batch.assetIds),
      ...individualMediaSegments.map((segment)=>segment.assetId||segment.asset_id)]).size;
    const batchSizes=batches.map((batch)=>batch.assetIds.length);
    results.push({name:fixture.name,profile:sourceProcessingProfile(capture),processingClass:estimate.processingClass,
      legacyRequests,optimizedRequests,requestReduction:legacyRequests?Number((1-optimizedRequests/legacyRequests).toFixed(4)):0,
      segmentCount:segments.length,mediaBatchCount:batches.length,batchSizes,accountedMedia,expectedMedia:fixture.assets.length,
      setupAndPlanningMs:Number(elapsedMs.toFixed(3)),qualityGate:{allMediaAccounted:accountedMedia===fixture.assets.length,
        boundedBatches:batchSizes.every((size)=>size>=4&&size<=8),manualStartRemoved:estimate.requiresManualStart===false}});
  }
  const output={generatedAt:new Date().toISOString(),kind:"offline_fixed_fixture_no_paid_model_calls",
    summary:{fixtures:results.length,qualityGatesPassed:results.every((item)=>Object.values(item.qualityGate).every(Boolean)),
      totalLegacyRequests:results.reduce((sum,item)=>sum+item.legacyRequests,0),
      totalOptimizedRequests:results.reduce((sum,item)=>sum+item.optimizedRequests,0)},results};
  const outputIndex=process.argv.indexOf("--output");
  const outputPath=outputIndex>=0?process.argv[outputIndex+1]:"docs/audit/CMS_QUEUE_MEDIA_BENCHMARK_2026-09-12.json";
  if(outputPath){const resolved=path.resolve(outputPath);fs.mkdirSync(path.dirname(resolved),{recursive:true});fs.writeFileSync(resolved,JSON.stringify(output,null,2)+"\n");}
  process.stdout.write(JSON.stringify(output,null,2)+"\n");
} finally {
  db.close();
  fs.rmSync(directory,{recursive:true,force:true});
}
