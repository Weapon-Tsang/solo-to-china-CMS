import assert from "node:assert/strict";
import test from "node:test";
import { createAiClient } from "../src/ai/client.mjs";
import { decodeOpenAiWire, openAiWireSchema, providerReasoningOptions } from "../src/ai/provider-schema.mjs";
import { Repository } from "../src/repository.mjs";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";

const encryptionKey=Buffer.alloc(32,7).toString("base64");
const answerSchema={type:"object",additionalProperties:false,required:["answer"],properties:{answer:{type:"string"}}};
const policy={version:"model-routing-policy-1.1.0",stages:{test_stage:{class:"extraction",role:"extraction",thinking:"LOW",maxOutputTokens:1000,timeoutMs:5000,maxAttempts:1}}};

test("model credential encryption readiness distinguishes missing, malformed, and valid root keys",(t)=>{
  const missing=repositoryFixture(t).repository.getModelRoutingSettings();
  assert.equal(missing.encryptionReady,false);
  assert.equal(missing.encryptionErrorCode,"MODEL_CREDENTIAL_ENCRYPTION_KEY_REQUIRED");
  const malformed=repositoryFixture(t,{modelCredentialEncryptionKey:"configured-but-invalid"}).repository.getModelRoutingSettings();
  assert.equal(malformed.encryptionReady,false);
  assert.equal(malformed.encryptionErrorCode,"MODEL_CREDENTIAL_ENCRYPTION_KEY_INVALID");
  const valid=repositoryFixture(t,{modelCredentialEncryptionKey:encryptionKey}).repository.getModelRoutingSettings();
  assert.equal(valid.encryptionReady,true);
  assert.equal(valid.encryptionErrorCode,null);
});

test("encrypted extraction routing is optimistic and freezes each new Job profile",(t)=>{
  const {db,repository}=repositoryFixture(t,{modelCredentialEncryptionKey:encryptionKey});
  const initial=repository.getModelRoutingSettings();
  assert.equal(initial.selectedProvider,"deepseek");
  assert.equal(initial.activeProvider,"legacy");
  const activated=repository.updateModelRouting({provider:"deepseek",apiKey:"ds-secret-value",activate:true,expectedRevision:initial.revision});
  assert.equal(activated.activeProvider,"deepseek");
  assert.equal(activated.credentials.deepseek.maskedSuffix,"alue");
  assert.doesNotMatch(JSON.stringify(activated),/ds-secret-value/);
  const stored=db.prepare("SELECT * FROM model_credentials WHERE provider='deepseek'").get();
  assert.notEqual(stored.encrypted_secret,"ds-secret-value");
  assert.equal(repository.readModelCredential("deepseek"),"ds-secret-value");
  assert.equal(new Repository(db,{modelCredentialEncryptionKey:encryptionKey}).readModelCredential("deepseek"),"ds-secret-value");
  const oldJob=repository.enqueue("analyze_intake","source-old");
  const oldProfile=JSON.parse(db.prepare("SELECT model_profile_json FROM jobs WHERE id=?").get(oldJob).model_profile_json);
  assert.equal(oldProfile.provider,"deepseek");
  const switched=repository.updateModelRouting({provider:"openai",apiKey:"openai-secret-value",activate:true,expectedRevision:activated.revision});
  const newJob=repository.enqueue("analyze_intake","source-new");
  const writingJob=repository.enqueue("generate_draft","brief-new");
  assert.equal(JSON.parse(db.prepare("SELECT model_profile_json FROM jobs WHERE id=?").get(oldJob).model_profile_json).provider,"deepseek");
  assert.equal(JSON.parse(db.prepare("SELECT model_profile_json FROM jobs WHERE id=?").get(newJob).model_profile_json).provider,"openai");
  assert.deepEqual(JSON.parse(db.prepare("SELECT model_profile_json FROM jobs WHERE id=?").get(writingJob).model_profile_json),{
    role:"writing",provider:"vertex",model:"gemini-3.8-flash",policyVersion:"model-routing-policy-1.1.0"});
  assert.throws(()=>repository.updateModelRouting({provider:"deepseek",expectedRevision:activated.revision}),error=>error.code==="MODEL_ROUTING_REVISION_CONFLICT");
  assert.equal(switched.revision,activated.revision+1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM model_routing_audit").get().n,2);
});

test("activation requires credentials and settings do not create business work",(t)=>{
  const {db,repository}=repositoryFixture(t,{modelCredentialEncryptionKey:encryptionKey});
  const before=repository.getModelRoutingSettings();
  assert.throws(()=>repository.updateModelRouting({provider:"openai",activate:true,expectedRevision:before.revision}),error=>error.code==="MODEL_CREDENTIAL_REQUIRED");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs").get().n,0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sources").get().n,0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM article_drafts").get().n,0);
});

test("provider cooldown is isolated by frozen source and writing roles",(t)=>{
  const {db,repository}=repositoryFixture(t,{modelCredentialEncryptionKey:encryptionKey});
  const initial=repository.getModelRoutingSettings();
  repository.updateModelRouting({provider:"deepseek",apiKey:"ds-secret",activate:true,expectedRevision:initial.revision});
  const extractionJob=repository.enqueue("analyze_intake","source-isolated",{priority:1});
  const writingJob=repository.enqueue("generate_draft","brief-isolated",{priority:1});
  db.prepare(`INSERT INTO provider_runtime_state(provider,model,backoff_until,consecutive_failures,updated_at)
    VALUES ('deepseek','deepseek-flash','2999-01-01T00:00:00.000Z',1,'now')`).run();
  const claimed=repository.claimJob();
  assert.equal(claimed.id,writingJob,"DeepSeek cooldown must not block fixed Vertex article production");
  repository.completeJob(claimed.id,claimed.locked_by,claimed.lease_generation);
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id=?").get(extractionJob).status,"queued");
});

test("DeepSeek uses explicit JSON and thinking controls while retaining provider telemetry",async()=>{
  const metrics=[];let requestBody;
  const client=createAiClient({provider:"deepseek",apiKey:"test",model:"deepseek-flash",baseUrl:"https://example.test",stagePolicy:policy,onModelCall:(m)=>metrics.push(m)},async(_url,init)=>{
    requestBody=JSON.parse(init.body);
    return new Response(JSON.stringify({id:"ds-request",model:"deepseek-flash",choices:[{finish_reason:"stop",message:{content:'{"answer":"ok"}'}}],usage:{prompt_tokens:5,completion_tokens:2}}),{status:200,headers:{"content-type":"application/json","x-request-id":"ds-header"}});
  });
  assert.deepEqual((await client.completeJson({name:"test_stage",schema:answerSchema,instructions:"Return JSON",content:"evidence",telemetryContext:{role:"extraction"}})).output,{answer:"ok"});
  assert.deepEqual(requestBody.response_format,{type:"json_object"});
  assert.equal(requestBody.thinking.type,"enabled");
  assert.equal(requestBody.reasoning_effort,"low");
  assert.equal(metrics[0].httpStatus,200);assert.equal(metrics[0].providerRequestId,"ds-header");assert.equal(metrics[0].role,"extraction");
});

test("OpenAI Responses disables storage/tools and validates strict canonical output",async()=>{
  const metrics=[];let requestBody;
  const client=createAiClient({provider:"openai",apiKey:"test",model:"gpt-5.6-luna",baseUrl:"https://example.test/v1",stagePolicy:policy,onModelCall:(m)=>metrics.push(m)},async(_url,init)=>{
    requestBody=JSON.parse(init.body);
    return new Response(JSON.stringify({id:"resp_1",status:"completed",model:"gpt-5.6-luna",output_text:'{"answer":"ok"}',usage:{input_tokens:5,output_tokens:2}}),{status:200,headers:{"content-type":"application/json","x-request-id":"oa-header"}});
  });
  assert.deepEqual((await client.completeJson({name:"test_stage",schema:answerSchema,instructions:"Return JSON",content:"evidence",telemetryContext:{role:"dispute_review"}})).output,{answer:"ok"});
  assert.equal(requestBody.store,false);assert.equal(requestBody.tools,undefined);
  assert.equal(requestBody.text.format.strict,true);assert.equal(requestBody.reasoning.effort,"low");
  assert.equal(metrics[0].returnedModel,"gpt-5.6-luna");assert.equal(metrics[0].role,"dispute_review");
});

test("unknown explicit providers fail closed",()=>{
  const client=createAiClient({provider:"mystery",apiKey:"test",model:"mystery",stagePolicy:policy});
  assert.throws(()=>client.enabled,error=>error.code==="UNKNOWN_AI_PROVIDER");
});

test("provider failures keep response status and do not masquerade as local non-attempts",async()=>{
  const metrics=[];
  const deepseek=createAiClient({provider:"deepseek",apiKey:"test",model:"deepseek-flash",baseUrl:"https://example.test",stagePolicy:policy,onModelCall:(m)=>metrics.push(m)},async()=>new Response(JSON.stringify({error:{code:"rate_limit",message:"slow down"}}),{status:429,headers:{"content-type":"application/json","x-request-id":"ds-429","retry-after":"2"}}));
  await assert.rejects(()=>deepseek.completeJson({name:"test_stage",schema:answerSchema,instructions:"JSON",content:"evidence"}),error=>error.status===429&&error.retryAfterMs===2000);
  assert.equal(metrics[0].httpStatus,429);assert.equal(metrics[0].dispatchState,"response_received");
  const openai=createAiClient({provider:"openai",apiKey:"test",model:"gpt-5.6-luna",baseUrl:"https://example.test/v1",stagePolicy:policy},async()=>new Response(JSON.stringify({id:"resp_refused",status:"completed",output:[{content:[{type:"refusal",refusal:"policy"}]}]}),{status:200,headers:{"content-type":"application/json"}}));
  await assert.rejects(()=>openai.completeJson({name:"test_stage",schema:answerSchema,instructions:"JSON",content:"evidence"}),error=>error.code==="MODEL_REFUSAL"&&error.retryable===false);
});

test("OpenAI strict projection preserves optional and open metadata semantics",()=>{
  const schema={type:"object",additionalProperties:false,required:["id"],properties:{id:{type:"string"},metadata:{type:"object",additionalProperties:true}}};
  const wire=openAiWireSchema(schema);
  assert.deepEqual(wire.required,["id","metadata"]);
  assert.ok(Array.isArray(wire.properties.metadata.type));
  assert.deepEqual(decodeOpenAiWire({id:"x",metadata:'{"region":"north"}'},schema),{id:"x",metadata:{region:"north"}});
  assert.throws(()=>providerReasoningOptions("vertex","MINIMAL"),error=>error.code==="UNSUPPORTED_REASONING_LEVEL");
});

test("new Knowledge records an update without clearing a frozen Draft review",(t)=>{
  const {db,repository}=repositoryFixture(t);
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,evidence_ledger_json,created_at,updated_at)
    VALUES ('brief-frozen','beijing','Guide','[]','informational','ready','["place:hours"]','now','now')`).run();
  db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at,revision,content_hash)
    VALUES ('draft-frozen','brief-frozen','Guide','guide','## Guide\n\nFrozen.','{"passed":true}','qa_passed','now','now',4,'draft-hash')`).run();
  const result=repository.invalidateFactDependents("beijing",["place:hours"]);
  assert.deepEqual(result.draftIds,["draft-frozen"]);
  const draft={...db.prepare("SELECT status,quality_report_json,revision,content_hash FROM article_drafts WHERE id='draft-frozen'").get()};
  assert.deepEqual(draft,{status:"qa_passed",quality_report_json:'{"passed":true}',revision:4,content_hash:"draft-hash"});
  assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs WHERE entity_id='draft-frozen'").get().n,0);
  assert.equal(db.prepare("SELECT status FROM draft_knowledge_updates WHERE draft_id='draft-frozen'").get().status,"update_available");
  repository.invalidateFactDependents("beijing",["place:hours"]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM draft_knowledge_updates WHERE draft_id='draft-frozen'").get().n,1);
});
