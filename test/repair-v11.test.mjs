import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {normalizeAffiliateAsset,normalizeAffiliateProviderAccount} from "../src/commercial.mjs";
import {repositoryFixture} from "../test-support/repository-fixture.mjs";

test("FINAL_PAGE_INVALID keeps original validator paths and deterministic attribution",(t)=>{
  const {db,repository}=repositoryFixture(t);
  repository.enqueue("compose_publish_page","draft-invalid",{dedupeKey:"v11-final-invalid"});
  const job=repository.claimJob();
  const error=Object.assign(new Error("Merged final page is invalid."),{
    code:"FINAL_PAGE_INVALID",retryable:false,details:{
      phase:"final_page_after_commercial_merge",draftRevision:7,inputHash:"input-hash",candidateHash:"candidate-hash",
      contract_checksum:"contract-checksum",overlay_version:"overlay-v2",asset_ids:["asset-hotel"],
      signed_url:"https://example.test/private?signature=secret",inlineData:"base64-secret",
      validation:{validator:"validatePagePayload",errors:[{
        code:"COMMERCIAL_DESCRIPTION_REQUIRED",subcode:"MIN_LENGTH",path:"$.blocks[4].data.description",
        instancePath:"/blocks/4/data/description",schemaPath:"#/properties/description/minLength",keyword:"minLength",
        expected:{minLength:1},actual_safe_excerpt:"",slot_key:"slot-hotel",asset_id:"asset-hotel",
        component_type:"affiliate_booking_card",
      }]},
    },
  });
  assert.equal(repository.failJob(job,error),true);
  const stored=db.prepare("SELECT failure_execution_kind,failure_details_json FROM jobs WHERE id=?").get(job.id);
  assert.equal(stored.failure_execution_kind,"deterministic");
  const details=JSON.parse(stored.failure_details_json);
  assert.equal(details.outer_code,"FINAL_PAGE_INVALID");
  assert.equal(details.details.validation.errors[0].path,"$.blocks[4].data.description");
  assert.equal(details.details.validation.errors[0].asset_id,"asset-hotel");
  assert.equal(details.details.signed_url,"[redacted]");
  assert.equal(details.details.inlineData,"[redacted]");
  const diagnostic=db.prepare("SELECT * FROM production_failure_diagnostics WHERE job_id=?").get(job.id);
  assert.equal(diagnostic.stage,"compose_publish_page");
  assert.equal(diagnostic.candidate_hash,"candidate-hash");
  assert.equal(JSON.parse(diagnostic.details_json).details.contract_checksum,"contract-checksum");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM model_call_metrics WHERE run_id=?").get(job.id).count,0);
});

test("editorial card overflow is attributed to deterministic layout, not the preceding provider call",(t)=>{
  const {db,repository}=repositoryFixture(t);
  repository.enqueue("generate_visuals","draft-overflow",{dedupeKey:"v11-card-overflow"});
  const job=repository.claimJob();
  const error=Object.assign(new Error("Editorial card text does not fit without cropping."),{
    code:"EDITORIAL_CARD_TEXT_OVERFLOW",retryable:false,details:{validation:"deterministic_text_layout_capacity"},
  });
  assert.equal(repository.failJob(job,error),true);
  const stored=db.prepare("SELECT failure_execution_kind,failure_details_json FROM jobs WHERE id=?").get(job.id);
  assert.equal(stored.failure_execution_kind,"deterministic");
  assert.equal(JSON.parse(stored.failure_details_json).details.validation,"deterministic_text_layout_capacity");
});

test("a visual dispatch intent is durable and completed in one call-ledger row",(t)=>{
  const {db,repository}=repositoryFixture(t);
  const common={callId:"visualcall-v11",stage:"visual_quality_qa",substage:"visual_quality_qa",
    provider:"vertex_gemini",model:"gemini-quality",runId:"job-v11",entityId:"visual-v11",visualId:"visual-v11",
    sourceAssetId:"source-asset-v11",requestKind:"provider",requestStartedAt:"2026-09-17T00:00:00.000Z",
    endpointId:"vertex_gemini:gemini-quality:visual_quality_qa",attempts:1,attemptNumber:1};
  repository.recordModelCall({...common,telemetryPhase:"started",status:"failed",attemptStatus:"started",
    dispatchState:"dispatch_started",evidenceBasis:"dispatch_intent_persisted"});
  let row=db.prepare("SELECT * FROM model_call_metrics WHERE id=?").get(common.callId);
  assert.equal(row.dispatch_state,"dispatch_started");
  assert.equal(row.request_completed_at,null);
  repository.recordModelCall({...common,telemetryPhase:"completed",status:"succeeded",attemptStatus:"succeeded",
    dispatchState:"completed",evidenceBasis:"provider_response_completed",httpStatus:200,
    requestCompletedAt:"2026-09-17T00:00:01.000Z",latencyMs:1000});
  row=db.prepare("SELECT * FROM model_call_metrics WHERE id=?").get(common.callId);
  assert.equal(row.status,"succeeded");
  assert.equal(row.dispatch_state,"completed");
  assert.equal(row.http_status,200);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM model_call_metrics WHERE id=?").get(common.callId).count,1);
});

test("affiliate edits are revisioned, isolated, concurrency-safe, and usage keeps the selected version",(t)=>{
  const {db,repository}=repositoryFixture(t);
  const provider=repository.upsertAffiliateProviderAccount(normalizeAffiliateProviderAccount({
    providerKey:"trip-v11",displayName:"Trip.com",connectionMode:"MANUAL",status:"CONFIGURED",
  }));
  const initialUrl="https://www.trip.com/t/hotel?sub1=stc_hotel&sig=a%2Bb&x=1&x=2";
  const asset=repository.upsertAffiliateAsset(normalizeAffiliateAsset({providerAccountId:provider.id,provider:"Trip.com",
    assetType:"CATEGORY_LINK",productCategory:"HOTEL",scopeType:"DESTINATION",scopeKey:"beijing",
    destinationSlug:"beijing",title:"Beijing hotels",description:"Compare stays",ctaLabel:"View hotels",
    targetUrl:initialUrl,active:true}));
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at)
    VALUES ('brief-v11','beijing','Hotels','[]','transactional','ready','now','now')`).run();
  db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at,revision,content_hash)
    VALUES ('draft-v11','brief-v11','Hotels','hotels','## Hotels\n\nCompare stays.','{}','wordpress_draft','now','now',3,'draft-hash')`).run();
  const composition={publishableBodyMarkdown:"## Hotels\n\nCompare stays.",offerIds:[],assetIds:[asset.id],commercialBlocks:[],contentBlocks:[],
    disclosureText:"Disclosure",strategyVersion:"3.5",readingLayoutVersion:"1.1",status:"composed",outcome:"inserted",
    diagnostics:{intents:[]},manifest:{},opportunities:[],intents:[{id:"intent-v11",blockIndex:0,blockKey:"hotels",
      intentType:"HOTEL_REVIEW",productCategory:"HOTEL",destinationSlug:"beijing",areaKey:"",routeKey:"",entityKey:"",
      intentStrength:"HIGH",decisionStage:"DECISION",recommendedComponent:"affiliate_booking_card",reason:"Hotel decision."}],
    slots:[{slot_key:"hotel-slot",affiliate_asset_id:asset.id,component_type:"affiliate_booking_card",placement:"contextual",
      block_index:0,product_category:"HOTEL"}]};
  repository.saveCommercialComposition("draft-v11",composition);
  const overlayV1=db.prepare("SELECT overlay_version FROM commercial_compositions WHERE draft_id='draft-v11'").get().overlay_version;

  const nextUrl="https://www.trip.com/t/hotel?x=2&sub1=stc_hotel&sig=z%2Fy";
  const edited=repository.updateAffiliateAsset(asset.id,{targetUrl:nextUrl},{expectedRevision:1,actor:"tester",queueRefresh:true});
  assert.equal(edited.revision,2);
  assert.equal(edited.target_url,nextUrl,"the signed/tracked URL bytes must not be normalized or reordered");
  assert.equal(edited.impact.count,1);
  assert.equal(edited.impact.queued,false);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM jobs WHERE entity_id='draft-v11'").get().count,0);
  assert.equal(db.prepare("SELECT refresh_required FROM commercial_compositions WHERE draft_id='draft-v11'").get().refresh_required,1);
  const usageBeforeRefresh=repository.affiliateAssetUsage(asset.id).items[0];
  assert.equal(usageBeforeRefresh.asset_revision,1);
  assert.equal(usageBeforeRefresh.dom_verification_status,"unknown");

  repository.saveCommercialComposition("draft-v11",composition);
  const overlayV2=db.prepare("SELECT overlay_version FROM commercial_compositions WHERE draft_id='draft-v11'").get().overlay_version;
  assert.notEqual(overlayV2,overlayV1);
  assert.equal(repository.affiliateAssetUsage(asset.id).items[0].asset_revision,2);
  const same=repository.updateAffiliateAsset(asset.id,{targetUrl:nextUrl},{expectedRevision:2,actor:"tester"});
  assert.equal(same.no_op,true);
  assert.equal(repository.listAffiliateAssetVersions(asset.id).length,2);
  assert.throws(()=>repository.updateAffiliateAsset(asset.id,{title:"Stale write"},{expectedRevision:1}),/changed since this form/);

  const disabled=repository.updateAffiliateAsset(asset.id,{active:false},{expectedRevision:2,actor:"tester"});
  assert.equal(disabled.active,0);
  const renamed=repository.updateAffiliateAsset(asset.id,{title:"Beijing stay options"},{expectedRevision:3,actor:"tester"});
  assert.equal(renamed.active,0,"an omitted active field must preserve the disabled state");
});

test("visual candidate reuse fails closed for missing or altered bytes",(t)=>{
  const {db,repository}=repositoryFixture(t);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"stc-candidate-v11-"));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at)
    VALUES ('candidate-brief','beijing','Guide','[]','informational','ready','now','now')`).run();
  db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at,revision,content_hash)
    VALUES ('candidate-draft','candidate-brief','Guide','guide','## Guide\n\nBody.','{}','qa_passed','now','now',1,'draft-hash')`).run();
  db.prepare(`INSERT INTO article_visuals(id,draft_id,slot,placement,purpose,alt_text,caption,generation_prompt,aspect_ratio,strategy_version,
    image_type,image_role,image_subject,acquisition_strategy,factual_image_required,status,created_at,updated_at,asset_fingerprint)
    VALUES ('candidate-visual','candidate-draft',1,'hero','support evidence','Alt','','','3:2','3.6','real_world_photo','hero','Place',
      'localize_source_image',1,'planned','now','now','fingerprint')`).run();
  const file=path.join(directory,"candidate.png");const bytes=Buffer.from("immutable candidate bytes");fs.writeFileSync(file,bytes);
  const outputHash=crypto.createHash("sha256").update(bytes).digest("hex");
  repository.saveVisualCandidate({visualId:"candidate-visual",draftId:"candidate-draft",transformInputHash:"transform-1",
    outputHash,mediaPath:file,mimeType:"image/png",byteSize:bytes.length,provider:"vertex_gemini",model:"image-model",
    expectedFingerprint:"fingerprint"});
  assert.equal(repository.findReusableVisualCandidate({visualId:"candidate-visual",transformInputHash:"transform-1"}).output_hash,outputHash);
  const candidateId=repository.listVisualCandidates("candidate-visual")[0].id;
  repository.updateVisualCandidate(candidateId,{status:"qa_failed",qa:{semantic:{status:"failed",reason:"wrong meaning"}}});
  assert.equal(repository.findReusableVisualCandidate({visualId:"candidate-visual",transformInputHash:"transform-1"}),null,
    "a conclusive QA failure must regenerate with feedback instead of re-reviewing identical bytes");
  repository.updateVisualCandidate(candidateId,{status:"pending_qa"});
  fs.writeFileSync(file,Buffer.from("tampered"));
  assert.equal(repository.findReusableVisualCandidate({visualId:"candidate-visual",transformInputHash:"transform-1"}),null);
  assert.equal(repository.listVisualCandidates("candidate-visual")[0].status,"invalidated");

  const missingFile=path.join(directory,"missing.png");
  repository.saveVisualCandidate({visualId:"candidate-visual",draftId:"candidate-draft",transformInputHash:"transform-2",
    outputHash:"missing-hash",mediaPath:missingFile,mimeType:"image/png",byteSize:10,provider:"vertex_gemini",model:"image-model",
    expectedFingerprint:"fingerprint"});
  assert.equal(repository.findReusableVisualCandidate({visualId:"candidate-visual",transformInputHash:"transform-2"}),null);
  assert.equal(repository.listVisualCandidates("candidate-visual").find((item)=>item.transform_input_hash==="transform-2").status,"missing");
});
