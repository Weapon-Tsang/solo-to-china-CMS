import http from "node:http";
import path from "node:path";
import { createApplication } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";
import { FrontendContractConsumer } from "../src/frontend-contract.mjs";
import { validateFinalPageArtifact } from "../src/publish-page.mjs";

const args = parseArgs(process.argv.slice(2));
if (process.env.ALLOW_WORDPRESS_DRAFT_CANARY !== "1") throw new Error("Set ALLOW_WORDPRESS_DRAFT_CANARY=1 to authorize this disposable WordPress draft-contract canary.");
if (!args.database) throw new Error("--database must identify a disposable production-copy work database.");
const databasePath = path.resolve(args.database);
if (!/(?:canary|replay|work)/i.test(path.basename(databasePath))) throw new Error("The canary database filename must contain canary, replay, or work; the live production database is refused.");

const requests = [];
const mock = http.createServer(async (request, response) => {
  const body = await readBody(request);
  const parsed = body ? JSON.parse(body) : null;
  requests.push({ method:request.method,url:request.url,authorization:request.headers.authorization || null,
    idempotencyKey:request.headers["idempotency-key"] || null,bytes:Buffer.byteLength(body,"utf8"),body:parsed });
  if (request.method !== "POST" || request.url !== "/wp-json/stc/v1/cms-articles") {
    response.writeHead(404,{"content-type":"application/json"});return response.end(JSON.stringify({code:"not_found"}));
  }
  if (parsed?.publication?.status !== "draft") {
    response.writeHead(409,{"content-type":"application/json"});
    return response.end(JSON.stringify({code:"publish_forbidden",message:"The canary accepts draft delivery only."}));
  }
  const origin=`http://127.0.0.1:${mock.address().port}`;
  response.writeHead(200,{"content-type":"application/json"});
  response.end(JSON.stringify({status:"draft",post_id:args.postId,slug:parsed.page?.metadata?.slug || "canary-draft",
    preview_url:`${origin}/?p=${args.postId}&preview=true`,edit_url:`${origin}/wp-admin/post.php?post=${args.postId}&action=edit`,
    contract_version:parsed.contract?.componentContractVersion || null,updated:false}));
});
await new Promise((resolve,reject)=>{mock.once("error",reject);mock.listen(0,"127.0.0.1",resolve);});

const mockOrigin=`http://127.0.0.1:${mock.address().port}`;
const config=loadConfig({...process.env,DATABASE_PATH:databasePath,HOST:"127.0.0.1",PORT:"0",PROCESS_ISOLATION_ENABLED:"false",
  GOOGLE_CLOUD_PROJECT:"",KIMI_API_KEY:"",IMAGE_ENABLED:"false",IMAGE_PROVIDER:"none",WORDPRESS_SITE_URL:mockOrigin,
  WORDPRESS_USERNAME:"canary",WORDPRESS_APPLICATION_PASSWORD:"canary-only",WORDPRESS_CMS_ARTICLE_ENDPOINT:`${mockOrigin}/wp-json/stc/v1/cms-articles`,
  FRONTEND_COMPONENT_REGISTRY_SOURCE:"canary://persisted-registry",FRONTEND_PAGE_SCHEMA_SOURCE:"canary://persisted-page-schema",
  FRONTEND_PUBLISH_PACKAGE_SCHEMA_SOURCE:"canary://persisted-publish-schema",MAINTENANCE_ENABLED:"false"});
const app=createApplication(config);const {repository,pipeline}=app;
const protectedBefore=protectedCounts(repository);
const startupJobs=repository.db.prepare("SELECT id FROM jobs WHERE status IN ('queued','running')").all();
repository.db.prepare(`UPDATE jobs SET status='failed',failure_class='permanent_input',last_failure_code='CANARY_STARTUP_SKIPPED',
  last_error='Startup-only work was suppressed inside the disposable WordPress canary database.',locked_by=NULL,locked_at=NULL,
  lease_expires_at=NULL,updated_at=datetime('now'),completed_at=datetime('now') WHERE status IN ('queued','running')`).run();

const content=repository.listContent({productionOnly:true});
const row=content.find((item)=>item.opportunity_id===args.opportunity)
  || content.find((item)=>item.production_state?.stage_status==="completed" && item.draft_id)
  || content.find((item)=>item.qa_passed===1 && item.draft_id);
if (!row?.draft_id) { await close();throw new Error(`No QA-passed production record was found${args.opportunity ? ` for ${args.opportunity}` : ""}.`); }
const beforePackage=repository.getDraftPackage(row.draft_id);
if (!beforePackage?.review?.passed || !beforePackage.commercial_composition || !beforePackage.frontend_page?.current) {
  await close();throw new Error("The selected canary record must already have current QA, commercial, and editorial-page artifacts.");
}
repository.enqueue("compose_publish_page",row.draft_id,{dedupeKey:`wordpress-canary:${row.opportunity_id}:${row.draft_id}`,
  productionOwnerOpportunityId:row.opportunity_id});
try { await drainOpportunity(repository,pipeline,row.opportunity_id,args.timeoutMs); } finally { pipeline.stop(); }

const contentPackage=repository.getDraftPackage(row.draft_id);
const consumer=new FrontendContractConsumer(repository,config.frontendContract);
const publishPackage=contentPackage?.publish_composition?.publish_package;
const contractValidation=consumer.validatePublishPackage(publishPackage);
const finalValidation=validateFinalPageArtifact(publishPackage?.page,contentPackage);
const request=requests[0] || null;const payloadText=JSON.stringify(publishPackage || {});
const boundaryViolations=[/(?:^|["'])className(?:["']|\s*:)/i,/dangerouslySetInnerHTML/i,/<style\b/i,
  /(?:^|["'])jsx(?:["']|\s*:)/i,/(?:^|["'])css(?:["']|\s*:)/i].filter((pattern)=>pattern.test(payloadText)).map(String);
const protectedAfter=protectedCounts(repository);
const immutableProtected=["sources","source_assets","claims","evidence_spans","knowledge_facts","experience_blocks","approved_opportunities"];
const protectedDataPreserved=immutableProtected.every((key)=>protectedAfter[key]===protectedBefore[key])
  && protectedAfter.failure_lessons>=protectedBefore.failure_lessons;
const publication=contentPackage?.publication;
const finalState=repository.getContentProductionDetail(row.opportunity_id)?.production_state || null;
const assertions={
  oneDraftRequest:requests.length===1 && request?.method==="POST",
  authenticated:Boolean(request?.authorization?.startsWith("Basic ")),idempotent:Boolean(request?.idempotencyKey),
  boundedPayload:Number(request?.bytes || 0)>0 && Number(request?.bytes || 0)<=1024*1024,
  draftOnly:request?.body?.publication?.status==="draft" && publication?.status==="synced" && contentPackage?.draft?.status==="wordpress_draft",
  contractValid:contractValidation.valid,finalArtifactValid:finalValidation.valid,
  previewUrlStored:Boolean(publication?.preview_url && /preview=true/.test(publication.preview_url)),
  editUrlStored:Boolean(publication?.edit_url && /wp-admin\/post\.php/.test(publication.edit_url)),
  frontendBoundaryPreserved:boundaryViolations.length===0,protectedDataPreserved,
  productionCompleted:["succeeded","completed"].includes(finalState?.stage_status) && finalState?.auto_continue===false,
};
const result={version:"production-wordpress-canary-1",database:path.basename(databasePath),
  isolation:{productionDatabase:false,realWordPress:false,modelCalls:false,published:false},startupJobsCancelledInCopy:startupJobs.length,
  opportunityId:row.opportunity_id,draftId:row.draft_id,title:contentPackage.draft.title,postId:publication?.post_id || null,
  previewUrl:publication?.preview_url || null,editUrl:publication?.edit_url || null,publishPackageBytes:request?.bytes || 0,
  pageBlocks:publishPackage?.page?.blocks?.length || 0,contractVersion:publishPackage?.contract?.componentContractVersion || null,
  boundaryViolations,contractErrors:contractValidation.errors,finalArtifactErrors:finalValidation.errors,protectedBefore,protectedAfter,
  finalProductionState:finalState ? {version:finalState.version,stageStatus:finalState.stage_status,
    completedStages:finalState.completed_stages?.length || 0,currentStage:finalState.current_stage,nextStage:finalState.next_stage,
    autoContinues:finalState.auto_continue} : null,assertions};
console.log(JSON.stringify(result,null,2));await close();
if (Object.values(assertions).some((passed)=>!passed)) process.exitCode=1;

async function drainOpportunity(repo,worker,opportunityId,timeoutMs){const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){
  const jobs=repo.db.prepare("SELECT type,status FROM jobs WHERE production_owner_opportunity_id=? AND status IN ('queued','running') ORDER BY created_at").all(opportunityId);
  if(!jobs.length)return;const ran=await worker.runOne();if(!ran)await new Promise((resolve)=>setTimeout(resolve,100));}
  throw new Error(`Timed out waiting for WordPress canary flow ${opportunityId}.`);}
function protectedCounts(repo){return Object.fromEntries([["sources","sources"],["source_assets","source_assets"],["claims","claims"],
  ["evidence_spans","evidence_spans"],["knowledge_facts","knowledge_facts"],["experience_blocks","experience_blocks"],
  ["approved_opportunities","content_opportunities WHERE approved_at IS NOT NULL"],["failure_lessons","failure_lessons"]]
  .map(([key,from])=>[key,Number(repo.db.prepare(`SELECT COUNT(*) AS count FROM ${from}`).get().count || 0)]));}
async function readBody(request){const chunks=[];let bytes=0;for await(const chunk of request){bytes+=chunk.length;
  if(bytes>1024*1024)throw new Error("Mock WordPress request exceeded 1 MiB.");chunks.push(chunk);}return Buffer.concat(chunks).toString("utf8");}
async function close(){repository.db.close();await new Promise((resolve)=>mock.close(resolve));}
function parseArgs(values){const output={database:"",opportunity:"",postId:92019,timeoutMs:120000};for(let index=0;index<values.length;index+=1){
  const value=values[index];if(value==="--database")output.database=values[++index] || "";else if(value==="--opportunity")output.opportunity=values[++index] || "";
  else if(value==="--post-id")output.postId=bounded(values[++index],1,9999999,"post-id");
  else if(value==="--timeout-seconds")output.timeoutMs=bounded(values[++index],1,600,"timeout-seconds")*1000;else throw new Error(`Unknown argument: ${value}`);}return output;}
function bounded(value,minimum,maximum,name){const number=Number(value);if(!Number.isInteger(number)||number<minimum||number>maximum)
  throw new Error(`--${name} must be ${minimum}-${maximum}.`);return number;}
