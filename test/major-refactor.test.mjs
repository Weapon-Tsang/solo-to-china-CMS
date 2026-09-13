import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { normalizeXiaohongshuCapture } from "../src/adapters/xiaohongshu.mjs";
import { CaptureMediaUploadManager } from "../src/capture-media-upload.mjs";
import { SCHEMA_VERSION } from "../src/db.mjs";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";

test("current schema installs the durable editorial, failure, reconciliation, and backfill boundaries", (t) => {
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

test("capture media uploads durably assemble verified image and video originals", async (t) => {
  const { directory } = repositoryFixture(t);
  const manager = new CaptureMediaUploadManager({uploadDir:path.join(directory,"chunks"),storageDir:path.join(directory,"stored")});
  const fixtures = [
    {kind:"image",mimeType:"image/png",bytes:Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.from("durable-image")])},
    {kind:"video",mimeType:"video/mp4",bytes:Buffer.concat([Buffer.alloc(4),Buffer.from("ftypisom"),Buffer.from("durable-video")])},
  ];
  for (const fixture of fixtures) {
    const sha256=crypto.createHash("sha256").update(fixture.bytes).digest("hex");
    const upload=await manager.create({...fixture,size:fixture.bytes.length,sha256});
    await assert.rejects(() => manager.complete(upload.uploadId),/missing/i);
    await manager.writeChunk(upload.uploadId,0,fixture.bytes);
    const completed=await manager.complete(upload.uploadId);
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
  db.prepare("UPDATE source_assets SET repair_status='browser_repair_required' WHERE source_id=?").run(first.id);
  const requested=repository.checkCaptureIdentities([{externalId:"browser-repair",url:input.url}])[0];
  assert.ok(requested.requiredActions.includes("BROWSER_MEDIA_REPAIR"));
  assert.deepEqual(requested.repairMedia.missingOriginals.map((asset)=>asset.mediaIdentity),["browser-photo"]);
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
  assert.deepEqual(repository.checkCaptureIdentities([{externalId:"browser-repair",url:input.url}])[0].repairMedia.missingOriginals,[]);
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
  db.prepare("DELETE FROM experience_extraction_runs WHERE source_id=?").run(sourceId);
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
    ...Array.from({length:24},(_,index)=>({type:"field_note",title:`Grounded note ${index+1}`,segment_ids:["segment-experience"],
      supporting_claim_ids:[claimId],evidence_span_ids:["span-experience"],sequence:[`Step ${index+1}`],confidence:.8})),
  ]},"test",input);
  assert.equal(saved.blocks.length,20);
  const earlyEntry=saved.blocks.find((block)=>block.title==="Early-entry sequence");
  assert.ok(earlyEntry);
  assert.deepEqual(earlyEntry.supporting_claim_ids,[claimId]);
  assert.equal(saved.blocks.some((block)=>block.title==="Invented route"),false);
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
  assert.throws(()=>repository.saveNarrativePlan(briefId,{evidence_selections:[{claim_key:selected[0],claim_id:'forged',source_id:'unrelated',role:'current'}]}),{code:'NARRATIVE_EVIDENCE_INVALID'});
  repository.saveNarrativePlan(briefId,{opening_job:"Give the route answer",throughline:"Route, payment, then fallback",
    evidence_selections:selected.map(key=>{const evidence=facts.find(fact=>fact.normalized_key===key).evidence[0];return {claim_key:key,claim_id:evidence.claim_id,source_id:evidence.source_id,role:'current'};}),
    route_sequence:["route"],supporting_fact_keys:selected,experience_placements:[],conditional_branches:["If the last train has left, use a taxi"],
    tradeoffs:["Metro is cheaper; taxi is later"],exclusions:["Unrelated attractions"],closing_decision:"Choose by arrival time"},"test");
  const packet=repository.assembleWritingPacket(briefId);
  assert.match(packet.packet_text,/ARTICLE GOAL[\s\S]*NARRATIVE[\s\S]*SELECTED PRACTICAL FACTS/);
  assert.ok(packet.evidence_ledger.every(entry=>entry.fact_snapshot.evidence.every(evidence=>evidence.claim_id)));
  assert.ok(packet.evidence_ledger.every(entry=>!entry.fact_snapshot.evidence_json && !entry.fact_snapshot.consensus_detail_json));
  assert.deepEqual(packet.selected_fact_keys,selected);
  assert.doesNotMatch(packet.packet_text,/normalized_key|predicate|value_text/i);
});

test("knowledge opportunities use completed sources while unfinished sources remain out of the evidence set", (t) => {
  const {db,repository}=repositoryFixture(t);
  const readyA=saveResearchSource(repository,"68abcdef00000000000000a1",[
    ["chengdu.metro.ready.route","Chengdu Metro","route","Line 18 reaches the airport corridor"],
  ],"Line 2 reaches the airport corridor.");
  const readyB=saveResearchSource(repository,"68abcdef00000000000000a2",[
    ["chengdu.metro.ready.payment","Chengdu Metro","payment","Mobile payment is supported"],
  ],"Mobile payment is supported.");
  const unfinished=saveResearchSource(repository,"68abcdef00000000000000a3",[
    ["chengdu.metro.unfinished.schedule","Chengdu Metro","schedule","A provisional schedule claim"],
  ],"A provisional schedule claim.");
  db.prepare("DELETE FROM experience_extraction_runs WHERE source_id=?").run(unfinished);
  db.prepare("UPDATE sources SET status='processing' WHERE id=?").run(unfinished);
  repository.rebuildKnowledge("chengdu");
  const completedFacts=repository.completedOpportunityFacts(repository.knowledgeForDestination("chengdu"));
  assert.equal(completedFacts.some((fact)=>fact.evidence.some((item)=>item.source_id===unfinished)),false);
  assert.ok(completedFacts.length>=2,JSON.stringify({completedFacts,sources:db.prepare("SELECT id,status,capture_version FROM sources").all(),runs:db.prepare("SELECT source_id,capture_version,status,degraded FROM experience_extraction_runs").all()}));
  repository.rebuildTopicClusters("chengdu");
  repository.rebuildKnowledgeOpportunities("chengdu");
  const opportunity=repository.listRecommendationInbox().find((item)=>item.coverage.knowledgeEventGenerated);
  assert.ok(opportunity,JSON.stringify(db.prepare("SELECT id,inbox_state,processing_state,strategy_version,source_ids_json,coverage_json FROM content_opportunities").all()));
  assert.notEqual(opportunity.processing_state,"PROCESSING_GAP");
  assert.equal(opportunity.coverage.selectedSourceIds.includes(unfinished),false);
  assert.deepEqual(new Set(opportunity.coverage.selectedSourceIds),new Set([readyA,readyB]));
});

test("knowledge opportunities collapse resolved aliases, count source families once, and infer type from the entity", (t) => {
  const {db,repository}=repositoryFixture(t);
  const sourceA=saveResearchSource(repository,"68abcdef00000000000000b1",[
    ["chengdu.dujiangyan.entry","Dujiangyan","entry","Use the signed visitor entrance"],
  ],"Use the signed visitor entrance.");
  const sourceB=saveResearchSource(repository,"68abcdef00000000000000b2",[
    ["chengdu.dujiangyan.transport","都江堰","transport","Take the intercity rail connection"],
  ],"Take the intercity rail connection.");
  const sourceC=saveResearchSource(repository,"68abcdef00000000000000b3",[
    ["chengdu.dujiangyan.timing","Dujiangyan Scenic Area","opening_time","Arrive before the busiest period"],
  ],"Arrive before the busiest period.");
  const timestamp=new Date().toISOString();
  db.prepare("DELETE FROM source_family_memberships WHERE source_id IN (?,?,?)").run(sourceA,sourceB,sourceC);
  db.prepare("INSERT INTO source_families(id,family_key,canonical_source_id,created_at,updated_at) VALUES ('family-a','family-a',?,?,?),('family-c','family-c',?,?,?)")
    .run(sourceA,timestamp,timestamp,sourceC,timestamp,timestamp);
  const membership=db.prepare(`INSERT INTO source_family_memberships(family_id,source_id,relation_type,created_at,updated_at)
    VALUES (?,?,?, ?,?)`);
  membership.run("family-a",sourceA,"INDEPENDENT",timestamp,timestamp);
  membership.run("family-a",sourceB,"NEAR_DUPLICATE",timestamp,timestamp);
  membership.run("family-c",sourceC,"INDEPENDENT",timestamp,timestamp);
  repository.rebuildKnowledge("chengdu");
  db.prepare(`UPDATE knowledge_facts SET entity_key='attraction.dujiangyan',canonical_subject='Dujiangyan Scenic Area',
    entity_resolution_status='resolved',entity_type='attraction',granularity='specific_entity'
    WHERE destination_id=(SELECT id FROM destinations WHERE slug='chengdu')`).run();
  assert.equal(repository.rebuildTopicClusters("chengdu"),1,JSON.stringify(repository.knowledgeForDestination("chengdu")
    .map((fact)=>({key:fact.normalized_key,entityKey:fact.entity_key,canonical:fact.canonical_subject,status:fact.entity_resolution_status}))));
  const rebuilt=repository.rebuildKnowledgeOpportunities("chengdu");
  assert.equal(rebuilt.created,1);
  const opportunities=repository.listRecommendationInbox().filter((item)=>item.coverage.knowledgeEventGenerated);
  assert.equal(opportunities.length,1);
  assert.equal(opportunities[0].content_type,"attraction_guide");
  assert.equal(opportunities[0].readiness.sourceFamilyCount,2);
  assert.equal(opportunities[0].readiness.factCount,3);
  assert.deepEqual(new Set(opportunities[0].coverage.selectedSourceIds),new Set([sourceA,sourceB,sourceC]));
  repository.rebuildCoverageMatrices("chengdu");
  const refreshed=repository.listRecommendationInbox().find((item)=>item.id===opportunities[0].id);
  assert.equal(refreshed.readiness.factCount,3);
  assert.deepEqual(new Set(refreshed.coverage.selectedFactKeys),new Set(opportunities[0].coverage.selectedFactKeys));
});

test("knowledge rebuild suppresses replaced alias opportunities and rejects context-free generic subjects", (t) => {
  const {db,repository}=repositoryFixture(t);
  saveResearchSource(repository,"68abcdef00000000000000c1",[
    ["chengdu.pathway.surface","pathway","surface","The pathway is paved"],
  ],"The pathway is paved.");
  saveResearchSource(repository,"68abcdef00000000000000c2",[
    ["chengdu.pathway.width","pathway","accessibility","The pathway has narrow sections"],
  ],"The pathway has narrow sections.");
  for(const [suffix,subject,predicate,value] of [
    ["c3","venue","seating","The venue has reserved seating"],
    ["c4","venue","entry","The venue uses timed entry"],
    ["c5","hotpot restaurant","payment","The restaurant accepts mobile payment"],
    ["c6","hotpot restaurant","queue","The restaurant uses a queue system"],
    ["c7","Day 3 itinerary","route","The itinerary crosses the central district"],
    ["c8","Day 3 itinerary","timing","The itinerary starts before noon"],
  ])saveResearchSource(repository,`68abcdef00000000000000${suffix}`,[
    [`chengdu.${suffix}.${predicate}`,subject,predicate,value],
  ],value);
  repository.rebuildKnowledge("chengdu");
  repository.rebuildTopicClusters("chengdu");
  const timestamp=new Date().toISOString();
  db.prepare(`INSERT INTO content_opportunities(id,destination_slug,destination_scopes_json,topic_key,strategy_version,
    source_ids_json,title,content_type,readiness_score,readiness_json,coverage_json,status,created_at,updated_at,lifecycle_state)
    VALUES ('legacy-alias','chengdu','["chengdu"]','chengdu:knowledge:legacy-alias',?,'[]','Legacy alias','practical_guide',0,
      '{"ready":false}','{"knowledgeEventGenerated":true}','recommended',?,?,'recommended')`)
    .run(repository.strategyVersion,timestamp,timestamp);
  const rebuilt=repository.rebuildKnowledgeOpportunities("chengdu");
  assert.equal(rebuilt.created,0);
  assert.ok(rebuilt.retired>=1);
  const legacy=db.prepare("SELECT status,inbox_state,suppression_reason FROM content_opportunities WHERE id='legacy-alias'").get();
  assert.equal(legacy.status,"suppressed");
  assert.equal(legacy.inbox_state,"INTERNAL");
  assert.equal(legacy.suppression_reason,"knowledge_cluster_replaced");
  assert.equal(repository.listRecommendationInbox().some((item)=>item.coverage.knowledgeEventGenerated),false);
});

test("knowledge opportunity types follow the topic entity and bilingual destination names collapse", (t) => {
  const {repository}=repositoryFixture(t);
  saveResearchSource(repository,"68abcdef00000000000000e1",[
    ["chengdu.taxi.food_nearby","Chengdu Taxi","food_nearby","Restaurants are available near taxi ranks"],
  ],"Restaurants are available near taxi ranks.");
  saveResearchSource(repository,"68abcdef00000000000000e2",[
    ["chengdu.taxi.restaurant_access","Chengdu Taxi","restaurant_access","Taxi ranks serve restaurant districts"],
  ],"Taxi ranks serve restaurant districts.");
  saveResearchSource(repository,"68abcdef00000000000000e3",[
    ["chengdu.city.food_options","Chengdu","food_options","The city has several dining districts"],
  ],"The city has several dining districts.");
  saveResearchSource(repository,"68abcdef00000000000000e4",[
    ["chengdu.city.transport_options","成都","transport_options","The city has metro and bus connections"],
  ],"The city has metro and bus connections.");
  saveResearchSource(repository,"68abcdef00000000000000e5",[
    ["chengdu.creative_park.food_nearby","Beicang Creative Park","food_nearby","Restaurants operate near the park"],
  ],"Restaurants operate near the park.");
  saveResearchSource(repository,"68abcdef00000000000000e6",[
    ["chengdu.creative_park.dining_access","Beicang Creative Park","dining_access","The park is walkable from a dining street"],
  ],"The park is walkable from a dining street.");
  saveResearchSource(repository,"68abcdef00000000000000e7",[
    ["chengdu.summer_weather.food","Chengdu summer weather","food_storage","Keep snacks out of direct heat"],
  ],"Keep snacks out of direct heat.");
  saveResearchSource(repository,"68abcdef00000000000000e8",[
    ["chengdu.summer_weather.water","Chengdu summer weather","water","Carry water in hot weather"],
  ],"Carry water in hot weather.");
  repository.rebuildKnowledge("chengdu");
  repository.rebuildTopicClusters("chengdu");
  repository.rebuildKnowledgeOpportunities("chengdu");
  const opportunities=repository.listRecommendationInbox().filter((item)=>item.coverage.knowledgeEventGenerated);
  const taxi=opportunities.find((item)=>item.title.startsWith("Chengdu Taxi:"));
  assert.equal(taxi?.content_type,"transport_guide");
  const city=opportunities.filter((item)=>item.content_type==="city_guide");
  assert.equal(city.length,1,JSON.stringify(opportunities.map((item)=>({title:item.title,type:item.content_type}))));
  assert.equal(city[0].readiness.factCount,2);
  assert.equal(opportunities.find((item)=>item.title.startsWith("Beicang Creative Park:"))?.content_type,"attraction_guide");
  assert.equal(opportunities.find((item)=>item.title.startsWith("Chengdu summer weather:"))?.content_type,"practical_guide");
});

test("recommendation reconciliation merges near-identical production paths from the same source", (t) => {
  const {db,repository}=repositoryFixture(t);
  const sourceId=saveResearchSource(repository,"68abcdef00000000000000d1",[
    ["chengdu.metro.route","Chengdu Metro","route","Use Line 2 for the central corridor"],
  ],"Use Line 2 for the central corridor.");
  repository.saveIntakeAnalysis(sourceId,{classification:"ARTICLE_CANDIDATE",recommended_action:"CREATE_CONTENT_PLAN",
    production_mode:"SOURCE_ADAPTATION",primary_topic:"Chengdu metro",suggested_content_type:"practical_guide",
    suggested_article_title:"Chengdu Metro Line-by-Line Guide: Attractions, Base Areas, and Practical Transit Tips",
    confidence:.9,article_potential:80,information_density:80,topic_completeness:70,reasoning_summary:"Bounded source guide.",
    production_paths:[{mode:"SOURCE_ADAPTATION",content_type:"practical_guide",
      title:"Chengdu Metro Line-by-Line Guide: Attractions, Stays, and Transit Tips",
      reader_promise:"Use the metro by area.",why_it_works:"The source supplies the route.",evidence_boundary:"This source only."}]},"test");
  const stored=db.prepare("SELECT id,inbox_state,primary_opportunity_id,canonical_intent_key FROM content_opportunities WHERE source_id=?").all(sourceId);
  assert.equal(stored.length,2);
  assert.equal(stored.filter((item)=>item.inbox_state==="ACTIONABLE").length,1);
  assert.equal(stored.filter((item)=>item.inbox_state==="MERGED").length,1);
  assert.equal(new Set(stored.map((item)=>item.canonical_intent_key)).size,1);
  assert.equal(repository.listRecommendationInbox().filter((item)=>item.source_id===sourceId).length,1);
});

test("knowledge reconciliation merges the same intent across a city and its nested destination scope", (t) => {
  const {db,repository}=repositoryFixture(t);
  const sourceIds=new Map();
  for(const [externalId,destination,key,predicate,value] of [
    ["68abcdef00000000000000f1",["Chongqing","chongqing"],"chongqing.hongyadong.entry","entry","Use the signed visitor entrance"],
    ["68abcdef00000000000000f2",["Chongqing","chongqing"],"chongqing.hongyadong.timing","timing","Arrive before the evening peak"],
    ["68abcdef00000000000000f3",["Chongqing Jiefangbei","chongqing-jiefangbei"],"jiefangbei.hongyadong.entry","entry","Use the signed visitor entrance"],
    ["68abcdef00000000000000f4",["Chongqing Jiefangbei","chongqing-jiefangbei"],"jiefangbei.hongyadong.timing","timing","Arrive before the evening peak"],
  ]) sourceIds.set(externalId,saveResearchSource(repository,externalId,[[key,"Hongyadong",predicate,value]],value,destination));
  for(const destination of ["chongqing","chongqing-jiefangbei"]){
    repository.rebuildKnowledge(destination);
    repository.rebuildTopicClusters(destination);
    repository.rebuildKnowledgeOpportunities(destination);
    repository.rebuildCoverageMatrices(destination);
  }
  const rows=db.prepare(`SELECT id,destination_slug,inbox_state,primary_opportunity_id,canonical_intent_key
    FROM content_opportunities WHERE json_extract(coverage_json,'$.knowledgeEventGenerated')=1 ORDER BY destination_slug`).all();
  assert.equal(rows.length,2,JSON.stringify({destinations:db.prepare("SELECT * FROM destinations").all(),
    facts:db.prepare("SELECT destination_id,normalized_key,subject,evidence_json FROM knowledge_facts").all(),
    clusters:db.prepare("SELECT destination_slug,title,claim_keys_json FROM topic_clusters").all(),
    opportunities:db.prepare("SELECT id,destination_slug,title,inbox_state,coverage_json FROM content_opportunities").all()}));
  assert.equal(rows.filter((row)=>row.inbox_state==="ACTIONABLE").length,1);
  assert.equal(rows.filter((row)=>row.inbox_state==="MERGED").length,1);
  assert.equal(new Set(rows.map((row)=>row.canonical_intent_key)).size,1);
  assert.equal(repository.listRecommendationInbox().filter((item)=>item.coverage.knowledgeEventGenerated).length,1);
  for(const externalId of ["68abcdef00000000000000f1","68abcdef00000000000000f3"]){
    repository.saveIntakeAnalysis(sourceIds.get(externalId),{classification:"ARTICLE_CANDIDATE",recommended_action:"CREATE_CONTENT_PLAN",
      production_mode:"SOURCE_ADAPTATION",primary_topic:"Hongyadong field note",suggested_content_type:"attraction_guide",
      suggested_article_title:"Hongyadong field note",confidence:.9,article_potential:80,information_density:80,topic_completeness:70,
      reasoning_summary:"Keep separately authorized source adaptations within their explicit destination scope."},"test");
  }
  const adaptations=repository.listRecommendationInbox().filter((item)=>item.source_id && item.title==="Hongyadong field note");
  assert.equal(adaptations.length,2);
  assert.equal(new Set(adaptations.map((item)=>item.canonical_intent_key)).size,2);
});

test("terminal expression failure archives the attempt and retains artifacts, approval and Golden Article associations", (t) => {
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
  assert.ok(db.prepare("SELECT 1 FROM content_briefs WHERE id='brief-failure'").get());
  const opportunity=db.prepare("SELECT * FROM content_opportunities WHERE id='opportunity-failure'").get();
  assert.equal(opportunity.lifecycle_state,"producing");
  assert.equal(opportunity.approved_at,'now');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM failure_lessons").get().n,1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM production_rollbacks").get().n,0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM production_attempt_archives").get().n,1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM editorial_lessons").get().n,1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM golden_articles WHERE draft_id='draft-failure'").get().n,1);
  assert.equal(repository.listOperationalExceptions().some((item) => item.key===`job:${jobId}`),false);
  assert.equal(db.prepare("SELECT body_markdown FROM article_drafts WHERE id='draft-failure'").get().body_markdown,'Body');
});

function saveResearchSource(repository,externalId,claims,text,destinationOverride=null) {
  const saved=repository.saveCapture(normalizeXiaohongshuCapture({url:`https://www.xiaohongshu.com/explore/${externalId}`,
    title:externalId,text,images:[]}));
  const destination=destinationOverride || (externalId.startsWith("metro") ? ["Shanghai","shanghai"] : ["Chengdu","chengdu"]);
  repository.saveExtraction(saved.id,{source:{language:"en",summary:text,destination_name:destination[0],destination_slug:destination[1],
    traveler_fit:["solo"],practical_tips:[],warnings:[],confidence:.9},claims:claims.map(([key,subject,predicate,value]) =>
      ({key,subject,predicate,value,qualifiers:[],source_quote:value,confidence:.9})),
    blueprint:{format:"guide",hook:"practical",angle:"independent travel",sections:[],strengths:[],gaps:[]}},"test","test");
  repository.saveExperienceExtraction(saved.id,{blocks:[]},"test");
  return saved.id;
}
