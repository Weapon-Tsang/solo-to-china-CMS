import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { createApplication } from '../src/server.mjs';
import { loadConfig } from '../src/config.mjs';
import { seedRouteProduction } from '../test-support/route-production-fixture.mjs';
import { routeReadableMarkdown } from '../src/route-bundle.mjs';
import { Pipeline } from '../src/pipeline.mjs';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cms-a2-media-browser-'));
const databasePath=path.join(directory,'test.sqlite');openDatabase(databasePath).close();
const config=loadConfig({HOST:'127.0.0.1',PORT:'0',DATABASE_PATH:databasePath,CMS_DATA_ROOT:directory,
  SOURCE_UPLOADS_DIR:path.join(directory,'sources'),GENERATED_MEDIA_DIR:path.join(directory,'media'),
  CAPTURE_UPLOADS_DIR:path.join(directory,'capture'),CAPTURE_MEDIA_UPLOADS_DIR:path.join(directory,'capture-media'),
  CMS_PROCESS_ROLE:'api',MAINTENANCE_ENABLED:'false',LOG_LEVEL:'error',
  ADMIN_TOKEN:'a2-local-fixture-token',ADMIN_USERNAME:'a2-test',ADMIN_PASSWORD:'a2-local-test-only',
  SESSION_SECRET:'a2-local-isolated-session-secret'});
const app=createApplication(config),repo=app.repository,seed=seedRouteProduction(repo,{requiredSchematic:!process.argv.includes('--optional'),
  unknownDuration:process.argv.includes('--unknown-duration')});
repo.db.prepare('DELETE FROM jobs').run(); // capture seed prerequisites only
const bundle=repo.getPlanningPackage(seed.candidateId,{opportunityId:seed.ownerId}).route_bundle;
const brief=repo.saveBrief(seed.candidateId,{title:'Beijing one-day itinerary',audience:['solo'],outline:[],search_intent:'informational'},
  'local-fixture',{deferDraft:true,opportunityId:seed.ownerId,routeBundle:bundle});
const draftId=repo.saveDraft(brief,{title:'Beijing one-day itinerary',slug:'route-recovery',body_markdown:routeReadableMarkdown(bundle),
  meta_description:'Source route sequence',evidence_ledger:[],unresolved_conflicts:[],visuals:[]},'local-fixture',
  {deferReview:true,opportunityId:seed.ownerId,routeBundle:bundle});
const worker=new Pipeline(repo,{enabled:false});
const outputDirectory=repo.contentConfig.generatedMediaDir;
repo.contentConfig.generatedMediaDir=null;
repo.enqueue('generate_visuals',draftId,{pipelineVersion:'article_bundle_v1',productionOwnerOpportunityId:seed.ownerId});
await worker.runOne();
repo.contentConfig.generatedMediaDir=outputDirectory;
await app.start();
const stopFile=path.join(directory,'STOP');
console.log(JSON.stringify({directory,databasePath,stopFile,url:`http://127.0.0.1:${app.server.address().port}`,draftId,owner:seed.ownerId}));
let stopped=false,busy=false;
const stop=async()=>{if(stopped)return;stopped=true;clearInterval(poll);clearTimeout(deadline);await app.stop();};
const poll=setInterval(async()=>{
  if(fs.existsSync(stopFile)){if(!busy)await stop();return;}
  if(busy || !repo.db.prepare("SELECT 1 FROM jobs WHERE type='generate_visuals' AND status='queued'").get())return;
  busy=true;try{await worker.runOne();}finally{busy=false;}
},300);
const deadline=setTimeout(()=>void stop(),15*60*1000);
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
