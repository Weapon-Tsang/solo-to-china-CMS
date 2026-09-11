import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { normalizeXiaohongshuCapture } from "../src/adapters/xiaohongshu.mjs";
import { CaptureMediaUploadManager } from "../src/capture-media-upload.mjs";
import { SCHEMA_VERSION } from "../src/db.mjs";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";

test("schema 57 installs the durable editorial, failure, and backfill boundaries", (t) => {
  const { db } = repositoryFixture(t);
  assert.equal(db.prepare("SELECT MAX(version) version FROM schema_migrations").get().version,SCHEMA_VERSION);
  for (const table of ["experience_blocks","editorial_assemblies","narrative_plans","writing_packets",
    "failure_lessons","production_rollbacks","editorial_lessons","golden_articles","system_backfill_runs"]) {
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)?.["1"],1,table);
  }
  const assetColumns = new Set(db.prepare("PRAGMA table_info(source_assets)").all().map((row) => row.name));
  for (const column of ["durability_status","ai_readability_status","repair_status","repair_attempts","storage_error","recovered_at"]) {
    assert.equal(assetColumns.has(column),true,column);
  }
});

test("capture media uploads durably assemble verified image and video originals", (t) => {
  const { directory } = repositoryFixture(t);
  const manager = new CaptureMediaUploadManager({uploadDir:path.join(directory,"chunks"),storageDir:path.join(directory,"stored")});
  const fixtures = [
    {kind:"image",mimeType:"image/png",bytes:Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.from("durable-image")])},
    {kind:"video",mimeType:"video/mp4",bytes:Buffer.concat([Buffer.alloc(4),Buffer.from("ftypisom"),Buffer.from("durable-video")])},
  ];
  for (const fixture of fixtures) {
    const sha256=crypto.createHash("sha256").update(fixture.bytes).digest("hex");
    const upload=manager.create({...fixture,size:fixture.bytes.length,sha256});
    assert.throws(() => manager.complete(upload.uploadId),/missing/i);
    manager.writeChunk(upload.uploadId,0,fixture.bytes);
    const completed=manager.complete(upload.uploadId);
    assert.equal(completed.sha256,sha256);
    assert.deepEqual(fs.readFileSync(path.join(directory,"stored",...completed.storageRef.split("/"))),fixture.bytes);
  }
});

test("browser media repair makes the original durable and resumes blocked extraction once", (t) => {
  const {directory,db,repository}=repositoryFixture(t);
  const bytes=Buffer.concat([Buffer.from([0xff,0xd8,0xff]),Buffer.from("authorized-original")]);
  const sha256=crypto.createHash("sha256").update(bytes).digest("hex");
  const input={url:"https://www.xiaohongshu.com/explore/browser-repair",title:"Browser repair",
    text:"A complete authorized note whose original image must be durable before extraction.",
    images:[{url:"https://sns-img.xhscdn.com/browser-repair.jpg",mediaIdentity:"browser-photo",originalSha256:sha256,mimeType:"image/jpeg"}]};
  const first=repository.saveCapture(normalizeXiaohongshuCapture(input));
  assert.equal(first.extractionQueued,false);
  assert.equal(first.mediaDurabilityStatus,"REMOTE_ONLY");
  const storageRef=`media/${sha256.slice(0,2)}/${sha256}.jpg`;
  const filename=path.join(directory,"source-images",...storageRef.split("/"));
  fs.mkdirSync(path.dirname(filename),{recursive:true});
  fs.writeFileSync(filename,bytes);
  const repaired=repository.saveCapture(normalizeXiaohongshuCapture({...input,images:[{...input.images[0],originalStorageRef:storageRef}]}));
  assert.equal(repaired.duplicate,true);
  assert.equal(repaired.mediaDurabilityComplete,true);
  assert.equal(repaired.extractionQueued,true);
  assert.equal(db.prepare("SELECT durability_status FROM source_assets WHERE source_id=?").get(first.id).durability_status,"ORIGINAL_STORED");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs WHERE type='repair_media_asset' AND status='queued'").get().n,0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs WHERE type='extract_source' AND status='queued'").get().n,1);
  assert.equal(repository.saveCapture(normalizeXiaohongshuCapture({...input,images:[{...input.images[0],originalStorageRef:storageRef}]})).extractionQueued,false);
});

test("published inventory classifies partial overlap as an explicit EXPAND opportunity", (t) => {
  const {db,repository}=repositoryFixture(t);
  const timestamp=new Date().toISOString();
  db.prepare(`INSERT INTO wordpress_content_inventory(id,site_url,post_id,slug,title,status,post_url,modified_at,synced_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run("wp-expand","https://example.test",77,"shanghai-metro-guide","Shanghai Metro Guide","publish",
      "https://example.test/shanghai-metro-guide/",timestamp,timestamp);
  const lifecycle=repository.classifyPublicationLifecycle("Shanghai Metro Airport Arrival Guide");
  assert.equal(lifecycle.action,"update");
  assert.equal(lifecycle.seoAction,"EXPAND");
  assert.equal(lifecycle.targetPostId,77);
  assert.equal(lifecycle.impact.requiresEditorialApproval,true);
});

test("one source keeps same-title adaptation and feature modes independently actionable", (t) => {
  const {repository}=repositoryFixture(t);
  const sourceId=saveResearchSource(repository,"parallel-modes",[
    ["chengdu.walk.route","Chengdu","route","Walk from the park to the teahouse"],
  ],"Walk from the park to the teahouse for a compact independent route.");
  repository.saveIntakeAnalysis(sourceId,{classification:"ARTICLE_CANDIDATE",recommended_action:"CREATE_CONTENT_PLAN",
    production_mode:"TOPIC_FEATURE",primary_topic:"Chengdu walk",suggested_article_title:"A compact Chengdu walk",
    suggested_content_type:"itinerary",confidence:.9,article_potential:85,information_density:80,topic_completeness:75,
    reasoning_summary:"Two legitimate editorial treatments.",production_paths:[{mode:"SOURCE_ADAPTATION",
      title:"A compact Chengdu walk",content_type:"itinerary",reader_promise:"Follow the exact compact route",
      why_it_works:"The selected source provides a coherent sequence.",evidence_boundary:"This source only."}]},"test");
  const modes=repository.listRecommendationInbox().filter((item) => item.source_id===sourceId)
    .map((item) => item.coverage.publicationMode).sort();
  assert.deepEqual(modes,["source_adaptation","topic_feature"]);
});

test("Experience Blocks reject invented provenance and persist grounded sequence separately from Claims", (t) => {
  const { db,repository }=repositoryFixture(t);
  const sourceId=saveResearchSource(repository,"experience-a",[
    ["chengdu.panda.entry","Chengdu Panda Base","entry","Book the first entry slot"],
  ],"Book the first entry slot, then walk to the quieter upper enclosures.");
  db.prepare(`INSERT INTO source_segments(id,source_id,segment_type,sequence,title,raw_text,content_hash,semantic_hash,status,created_at,updated_at)
    VALUES ('segment-experience',?,'paragraph_group',0,'Route','Book the first entry slot, then walk uphill.','a','b','complete','now','now')`).run(sourceId);
  const claimId=db.prepare("SELECT id FROM claims WHERE source_id=?").get(sourceId).id;
  db.prepare(`INSERT INTO evidence_spans(id,source_id,segment_id,locator_type,quote,region_json,created_at)
    VALUES ('span-experience',?,'segment-experience','text','Book the first entry slot','{}','now')`).run(sourceId);
  const backfill=repository.runExperienceBackfill({dryRun:false});
  assert.equal(db.prepare("SELECT status FROM system_backfill_runs WHERE id=?").get(backfill.id).status,"queued");
  assert.equal(db.prepare(`SELECT COUNT(*) count FROM jobs WHERE type='extract_source_experience'
    AND entity_id=? AND status IN ('queued','running')`).get(sourceId).count,1);
  repository.enqueue("extract_source_experience",sourceId,{dedupeKey:`experience-backfill:${sourceId}:legacy`,priority:70});
  assert.equal(repository.coalesceQueuedExperienceJobs(),1);
  assert.equal(db.prepare(`SELECT COUNT(*) count FROM jobs WHERE type='extract_source_experience'
    AND entity_id=? AND status IN ('queued','running')`).get(sourceId).count,1);
  assert.equal(db.prepare(`SELECT last_failure_code FROM jobs WHERE type='extract_source_experience'
    AND entity_id=? AND status='failed'`).get(sourceId).last_failure_code,"DUPLICATE_EXPERIENCE_JOB");
  const input=repository.getExperienceExtractionPackage(sourceId);
  const saved=repository.saveExperienceExtraction(sourceId,{blocks:[
    {type:"route_strategy",title:"Invented route",segment_ids:["not-a-segment"],supporting_claim_ids:[claimId],sequence:["Invented"]},
    {type:"route_strategy",title:"Early-entry sequence",traveler_goal:"Avoid the busiest flow",segment_ids:["segment-experience"],
      supporting_claim_ids:[claimId],evidence_span_ids:["span-experience"],sequence:["Book the first entry slot","Walk uphill"],confidence:.9},
  ]},"test",input);
  assert.equal(saved.blocks.length,1);
  assert.equal(saved.blocks[0].title,"Early-entry sequence");
  assert.deepEqual(saved.blocks[0].supporting_claim_ids,[claimId]);
  assert.equal(repository.getSource(sourceId).claims.length,1);
  assert.equal(db.prepare("SELECT status FROM system_backfill_runs WHERE id=?").get(backfill.id).status,"completed");
});

test("knowledge change creates an independent multi-source opportunity and Writing Packet selects only assembled evidence", (t) => {
  const { repository }=repositoryFixture(t);
  saveResearchSource(repository,"metroA",[
    ["shanghai.metro.route","Shanghai Metro","route","Line 2 connects the airport corridor"],
    ["shanghai.metro.payment","Shanghai Metro","payment","Use a supported mobile payment method"],
  ],"Line 2 connects the airport corridor. Use a supported mobile payment method.");
  saveResearchSource(repository,"metroB",[
    ["shanghai.metro.station","Shanghai Metro","station","People's Square is a useful interchange"],
    ["shanghai.metro.schedule","Shanghai Metro","schedule","Last-train time depends on the line"],
  ],"People's Square is a useful interchange. Last-train time depends on the line.");
  repository.rebuildKnowledge("shanghai");
  repository.rebuildTopicClusters("shanghai");
  const rebuilt=repository.rebuildKnowledgeOpportunities("shanghai");
  assert.ok(rebuilt.created >= 1,JSON.stringify({rebuilt,knowledge:repository.knowledgeForDestination("shanghai")}));
  const opportunity=repository.listRecommendationInbox().find((item) => item.coverage.knowledgeEventGenerated);
  assert.equal(opportunity.coverage.publicationMode,"multi_source_synthesis");
  assert.ok(opportunity.coverage.selectedSourceIds.length >= 2);

  repository.db.prepare("UPDATE content_opportunities SET readiness_json=json_set(readiness_json,'$.ready',json('true')),status='recommended' WHERE id=?").run(opportunity.id);
  const approval=repository.decideOpportunity(opportunity.id,"approve");
  assert.equal(approval.queued,true);
  const candidateId=approval.candidateId;
  const facts=repository.getEditorialAssemblyPackage(candidateId).facts;
  const selected=facts.slice(0,2).map((fact) => fact.normalized_key);
  repository.saveEditorialAssembly(candidateId,{selected_fact_keys:selected,selected_experience_block_ids:[],selected_source_ids:opportunity.coverage.selectedSourceIds,
    rationale:"Only route and payment facts serve this reader promise."},"test");
  const briefId=repository.saveBrief(candidateId,{title:opportunity.title,primary_keyword:"shanghai metro",search_intent:"informational",
    audience:["independent travelers"],angle:"airport route",reader_promise:"Choose a practical metro route",
    outline:[{section_id:"route",heading:"Choose the route",purpose:"Decision",claim_keys:selected}],adaptation_requirements:[],conflict_instructions:[]},"test",{deferDraft:true});
  repository.saveNarrativePlan(briefId,{opening_job:"Give the route answer",throughline:"Route, payment, then fallback",
    route_sequence:["route"],supporting_fact_keys:selected,experience_placements:[],conditional_branches:["If the last train has left, use a taxi"],
    tradeoffs:["Metro is cheaper; taxi is later"],exclusions:["Unrelated attractions"],closing_decision:"Choose by arrival time"},"test");
  const packet=repository.assembleWritingPacket(briefId);
  assert.match(packet.packet_text,/ARTICLE GOAL[\s\S]*NARRATIVE[\s\S]*CURRENT PRACTICAL FACTS/);
  assert.deepEqual(packet.selected_fact_keys,selected);
  assert.doesNotMatch(packet.packet_text,/normalized_key|predicate|value_text/i);
});

test("terminal production failure learns, removes transient artifacts, and requires reapproval", (t) => {
  const { db,repository }=repositoryFixture(t);
  db.prepare(`INSERT INTO topic_candidates(id,destination_slug,topic_key,proposed_title,rationale,coverage_score,evidence_count,conflict_count,status,created_at,updated_at,strategy_version)
    VALUES ('candidate-failure','xian','xian:failure','Xi''an guide','test',100,2,0,'drafted','now','now',?)`).run(repository.strategyVersion);
  db.prepare(`INSERT INTO content_opportunities(id,destination_slug,destination_scopes_json,topic_key,strategy_version,candidate_id,title,content_type,
    readiness_score,readiness_json,coverage_json,status,approved_at,created_at,updated_at,lifecycle_state)
    VALUES ('opportunity-failure','xian','["xian"]','xian:failure',?,'candidate-failure','Xi''an guide','practical_guide',100,
      '{"ready":true}','{}','producing','now','now','now','producing')`).run(repository.strategyVersion);
  db.prepare("UPDATE topic_candidates SET opportunity_id='opportunity-failure' WHERE id='candidate-failure'").run();
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at,candidate_id)
    VALUES ('brief-failure','xian','Xi''an guide','[]','informational','drafted','now','now','candidate-failure')`).run();
  db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at,revision,content_hash)
    VALUES ('draft-failure','brief-failure','Xi''an guide','xian-guide','Body','{}','qa_failed','now','now',1,'hash')`).run();
  repository.recordEditorialFeedback("draft-failure","像数据库");
  repository.markGoldenArticle("draft-failure",["Use a causal traveler path"]);
  const jobId=repository.enqueue("review_draft","draft-failure");
  db.prepare("UPDATE jobs SET max_attempts=1 WHERE id=?").run(jobId);
  const job=repository.claimJob();
  repository.failJob(job,Object.assign(new Error("DATABASE_DUMP repeated after bounded repair"),{code:"DATABASE_DUMP",retryable:false}));
  assert.equal(db.prepare("SELECT 1 FROM content_briefs WHERE id='brief-failure'").get(),undefined);
  const opportunity=db.prepare("SELECT * FROM content_opportunities WHERE id='opportunity-failure'").get();
  assert.equal(opportunity.lifecycle_state,"recommended_again");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM failure_lessons").get().n,1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM production_rollbacks").get().n,1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM editorial_lessons").get().n,1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM golden_articles WHERE draft_id IS NULL").get().n,1);
  assert.equal(repository.listOperationalExceptions().some((item) => item.key===`job:${jobId}`),false);
  assert.equal(repository.retryContent("candidate-failure"),null,"retry cannot bypass the new approval gate");
  assert.equal(repository.decideOpportunity("opportunity-failure","approve").queued,true);
});

function saveResearchSource(repository,externalId,claims,text) {
  const saved=repository.saveCapture(normalizeXiaohongshuCapture({url:`https://www.xiaohongshu.com/explore/${externalId}`,
    title:externalId,text,images:[]}));
  const destination=externalId.startsWith("metro") ? ["Shanghai","shanghai"] : ["Chengdu","chengdu"];
  repository.saveExtraction(saved.id,{source:{language:"en",summary:text,destination_name:destination[0],destination_slug:destination[1],
    traveler_fit:["solo"],practical_tips:[],warnings:[],confidence:.9},claims:claims.map(([key,subject,predicate,value]) =>
      ({key,subject,predicate,value,qualifiers:[],source_quote:value,confidence:.9})),
    blueprint:{format:"guide",hook:"practical",angle:"independent travel",sections:[],strengths:[],gaps:[]}},"test","test");
  return saved.id;
}
