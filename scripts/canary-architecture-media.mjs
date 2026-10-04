// One fixed, authorized retained source image; one HTTP request maximum.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db.mjs';
import {KimiExtractor} from '../src/ai/kimi.mjs';
import {createMediaRequestExecutor} from '../src/media-request-executor.mjs';
if(process.env.RUN_ARCHITECTURE_CANARY!=='1')throw new Error('Paid media canary is disabled by default.');
const projectId=process.env.GOOGLE_CLOUD_PROJECT,accessToken=process.env.STC_ARCHITECTURE_VERTEX_TOKEN;
if(!projectId||!accessToken)throw new Error('Project and short-lived token are required.');
const source=new DatabaseSync('output/architecture-audit-20261004/production-work.sqlite',{readOnly:true});
const asset=source.prepare("SELECT * FROM current_source_assets WHERE id='asset_dccaba442a884f4e9bb7271ae8600e27'").get();source.close();
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(asset.local_path)).digest('hex'),
  '02eba6fae58cf4d4b0517ccb324cfd1b194217b5cef9933a2e3d8c9cc3fc816a');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cms-architecture-media-'));
const db=openDatabase(path.join(directory,'canary.sqlite')),metrics=[];let calls=0;
const executor=createMediaRequestExecutor(db,{maxDispatches:1});
const extractor=new KimiExtractor({provider:'vertex',model:'gemini-3.8-flash',projectId,accessToken,location:'global',
  sourceUploadsDir:'C:/s01-restore-20260927/source-uploads',mediaRequestExecutor:executor,batchEnabled:false,
  structuredSchemaMode:'openapi',beforeRequest:()=>{if(++calls>1)throw new Error('One-request canary budget exhausted');},
  onModelCall:m=>metrics.push({status:m.status,stage:m.stage,errorCode:m.errorCode,inputTokens:m.inputTokens,outputTokens:m.outputTokens,latencyMs:m.latencyMs}),
  stagePolicy:{version:'architecture-media-canary-1',stages:{source_asset_media_analysis:{thinking:'LOW',maxOutputTokens:4096,timeoutMs:90_000,maxAttempts:1}}}});
const report={assetId:asset.id,sourceSha256:asset.original_sha256,maximumRequests:1,productionWrites:0};
try{
  const result=await extractor.analyzeMediaAsset(asset);
  assert.equal(result.result.asset_id,asset.id);assert.equal(result.result.analysis_status,'ready');
  assert.match(result.result.primary_subjects.join(' '),/Hongya|Hongyadong|Chongqing|洪崖|重庆|bridge|桥/i);
  await extractor.analyzeMediaAsset(asset);
  assert.equal(calls,1);
  assert.equal(executor.budget({visualId:asset.id,substage:'analyze_source_image'}).spent,1);
  report.status='PASS';report.output=result.result;report.cacheReuseWithoutNewDispatch=true;
}catch(error){report.status='FAIL';report.error={code:error.code,message:error.message};process.exitCode=1;}
finally{
  report.metrics=metrics;report.dispatches=db.prepare('SELECT state,http_status,error_code FROM media_dispatches').all();db.close();
  fs.writeFileSync(process.argv[2] || 'output/architecture-audit-20261004/canary-media.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}
