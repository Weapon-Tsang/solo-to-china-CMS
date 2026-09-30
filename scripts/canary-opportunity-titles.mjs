import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Repository } from '../src/repository.mjs';
import { ContentEngine } from '../src/ai/content-engine.mjs';
import { loadConfig } from '../src/config.mjs';
import { createGoogleAccessTokenProvider } from '../src/google-access-token.mjs';
import { opportunityTitlePackage, saveOpportunityTitles } from '../src/services/opportunity-titles.mjs';

const [filename,destination,reportFile]=process.argv.slice(2);
if (process.env.ALLOW_REAL_PROVIDER_CANARY !== '1') throw new Error('Real-provider canary is disabled; set ALLOW_REAL_PROVIDER_CANARY=1 explicitly.');
if (!filename || !destination || !reportFile || !/(?:^|[-_])work\.sqlite$/iu.test(path.basename(filename)))
  throw new Error('Usage: canary-opportunity-titles.mjs disposable-work.sqlite destination report.json');
if (!fs.existsSync(filename)) throw new Error('Disposable work database must already exist.');
const config=loadConfig(),db=new DatabaseSync(filename),repository=new Repository(db);
if (!config.vertex.projectId) throw new Error('Google Cloud project is required.');
let dispatches=0;const attempts=[];
const engine=new ContentEngine({...config.vertex,provider:'vertex',model:'gemini-3.8-flash',role:'writing',batchEnabled:false,
  stagePolicy:config.ai.stagePolicy,googleAccessTokenProvider:createGoogleAccessTokenProvider(config.vertex),
  beforeRequest:()=>{if(++dispatches>2)throw Object.assign(new Error('Canary dispatch budget exhausted.'),{retryable:false});},
  onModelCall:metric=>attempts.push(metric)});
const pack=opportunityTitlePackage(repository,destination);
if (!pack.opportunities.length || pack.opportunities.length>6) throw new Error('Golden batch must contain 1–6 pending opportunities.');
const started=Date.now();
const report={startedAt:new Date().toISOString(),model:'gemini-3.8-flash',destination,
  inputBytes:Buffer.byteLength(JSON.stringify(pack)),ids:pack.opportunities.map(item=>item.id),productionWrites:0};
try {
  const result=await engine.composeOpportunityTitles(pack,{signal:AbortSignal.timeout(150_000),
    telemetryContext:{runId:'opportunity-title-canary',entityId:destination,role:'writing'}});
  report.output=result.output;report.usage=result.usage || null;
  report.saved=saveOpportunityTitles(repository,pack,result.output,result.model);report.status='PASS';
} catch(error) {
  report.status='FAIL';report.error={code:error.code || null,status:error.status || null,message:error.message};process.exitCode=1;
} finally {
  report.dispatches=dispatches;report.latencyMs=Date.now()-started;report.attempts=attempts;
  fs.writeFileSync(reportFile,JSON.stringify(report,null,2));db.close();
  console.log(JSON.stringify({...report,output:undefined,attempts:undefined}));
}
