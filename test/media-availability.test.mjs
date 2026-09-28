import assert from 'node:assert/strict';
import test from 'node:test';
import { mediaAvailabilitySnapshot } from '../src/media-availability.mjs';
import { ContentEngine, draftInputDto } from '../src/ai/content-engine.mjs';
import { repositoryFixture } from '../test-support/repository-fixture.mjs';
import { PLANNING_INPUT_BUDGET } from '../src/repository.mjs';
import { normalizeXiaohongshuCapture } from '../src/adapters/xiaohongshu.mjs';

test('T02-40/41/44: real planning retrieves claim-free entity media and retains explicit IDs beyond preview',async t=>{
  const {repository,db}=repositoryFixture(t);
  db.prepare(`INSERT INTO entity_aliases(id,destination_slug,alias_normalized,entity_key,canonical_subject,aliases_json,
    resolution_source,confidence,created_at,updated_at,entity_type,granularity)
    VALUES ('hall','chongqing','hall','hall','Huguang Guild Hall','[]','manual',1,'now','now','attraction','specific_entity')`).run();
  const saved=repository.saveCapture(normalizeXiaohongshuCapture({url:'https://www.xiaohongshu.com/explore/planning-real',title:'Hall',
    text:'A note without claims.',images:Array.from({length:18},(_,i)=>({url:`https://sns-img.xhscdn.com/plan-${i}.jpg`,captionText:'Huguang Guild Hall'}))}));
  db.prepare(`UPDATE source_assets SET local_path='fixture.jpg',storage_status='saved',original_bytes_status='saved_original',
    durability_status='ORIGINAL_STORED',original_sha256='bytes',stored_sha256='bytes' WHERE source_id=?`).run(saved.id);
  repository.refreshSourceMediaBindings(saved.id,{dryRun:false});
  db.prepare(`INSERT INTO topic_candidates(id,destination_slug,topic_key,proposed_title,rationale,coverage_score,evidence_count,conflict_count,status,created_at,updated_at)
    VALUES ('real-plan','chongqing','Huguang Guild Hall','Huguang Guild Hall','fixture',0,0,0,'candidate','now','now')`).run();
  const ids=repository.getSource(saved.id).assets.map(a=>a.id);
  const research=repository.getPlanningPackage('real-plan',{explicitAssetIds:ids});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM claims').get().n,0);
  assert.equal(research.authorized_source_assets.length,18);
  const calls=[];const engine=new ContentEngine({apiKey:'unused',model:'fixture'});
  engine.respond=async request=>{calls.push(request);return {output:{brief:{},draft:{slug:'hall',title:'Hall'}}};};
  await engine.articleBundle(research);
  assert.equal(JSON.parse(calls[0].input).authorized_source_assets.length,18);
  const automatic=repository.getPlanningPackage('real-plan');
  assert.equal(automatic.authorized_source_assets.length,12);
  assert.equal(automatic.media_availability.retrieval.has_more,true);
  db.prepare("UPDATE source_assets SET original_bytes_status='missing' WHERE id=?").run(ids[0]);
  const unavailable=repository.getPlanningPackage('real-plan',{explicitAssetIds:[ids[0]]});
  assert.ok(unavailable.media_availability.assets.find(a=>a.asset_id===ids[0]).known_gaps.includes('ORIGINAL_MISSING'));
  db.prepare('DELETE FROM media_bindings').run();
  const unindexed=repository.getPlanningPackage('real-plan');
  assert.ok(unindexed.media_availability.assets.some(a=>a.asset_id===ids[0]));
  assert.ok(unindexed.media_availability.assets.every(a=>a.known_gaps.includes('BINDING_EVIDENCE_MISSING')));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM media_bindings').get().n,0);
});

const asset={id:'a',source_id:'s',capture_version:1,original_sha256:'bytes',mime_type:'image/jpeg',
  original_bytes_status:'saved_original',durability_status:'ORIGINAL_STORED',analysis_status:'ready',asset_kind:'documentary_photo',
  source_bindings:[{id:'binding',occurrence_id:'occurrence',status:'confirmed',entity_key:'hall',destination_slug:'chongqing',
    canonical_subject:'Huguang Guild Hall',relation_type:'source_asserts_location',context_hash:'context',
    allowed_uses:['stop_photo'],prohibited_inferences:['precise_entrance','route_order']}]};

test('T02-44: capability snapshot is versioned, exposes pagination and never promotes photo to precise entrance',()=>{
  const snapshot=mediaAvailabilitySnapshot([asset],{has_more:true,offset:0,next_offset:160});
  assert.equal(snapshot.retrieval.has_more,true);
  assert.equal(snapshot.assets[0].supported_relationships[0].prohibited_inferences[0],'precise_entrance');
  assert.equal(snapshot.assets[0].adoption_status,'candidate_not_selected');
  assert.equal(snapshot.snapshot_hash,mediaAvailabilitySnapshot([asset],{has_more:true,offset:0,next_offset:160}).snapshot_hash);
  assert.notEqual(snapshot.snapshot_hash,mediaAvailabilitySnapshot([{...asset,original_sha256:'different'}]).snapshot_hash);
  const pdf=mediaAvailabilitySnapshot([{...asset,mime_type:'application/pdf'}]);
  assert.ok(pdf.assets[0].known_gaps.includes('PDF_ASSET_NOT_MATERIALIZED'));
});

test('T02-44: actual legacy writer request retains frozen source relationship and cannot borrow a later live snapshot',async()=>{
  const frozen=mediaAvailabilitySnapshot([asset]);
  const input={brief:{plan:{outline:[]}},facts:[],authorized_source_assets:[{id:'unrelated'}],
    media_availability:mediaAvailabilitySnapshot([{id:'unrelated'}]),
    writing_packet:{selected_fact_keys:[],evidence_ledger:[],context:{version:2,
      authorized_source_assets:[asset],media_availability:frozen}}};
  assert.deepEqual(draftInputDto(input).media_availability,frozen);
  const calls=[];
  const engine=new ContentEngine({apiKey:'unused',model:'fixture'});
  engine.respond=async request=>{calls.push(request);return {output:{title:'Hall',slug:'hall',body_markdown:'A hall.',seo:{},visuals:[]}};};
  await engine.draft(input);
  const request=JSON.parse(calls[0].input);
  assert.equal(calls.length,1);
  assert.deepEqual(request.media_availability,frozen);
  assert.equal(request.authorized_source_assets[0].source_bindings[0].canonical_subject,'Huguang Guild Hall');
  assert.equal(request.authorized_source_assets[0].original_stored,true);
  assert.doesNotMatch(calls[0].input,/unrelated/);
});

test('T02-44: repository freezes availability with the writing packet and carries original receipt fields',t=>{
  const {repository,db}=repositoryFixture(t);
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at)
    VALUES ('b','chongqing','Hall','[]','informational','drafted','now','now')`).run();
  // Isolate candidate retrieval; the real package builder and persistence execute.
  repository.authorizedSourceAssetsForBrief=()=>[asset];
  repository.getNarrativePlan=()=>({id:'n',opening_job:'Describe a hall',throughline:'Hall',supporting_fact_keys:[],route_sequence:[],exclusions:[],conditional_branches:[],tradeoffs:[]});
  const packet=repository.getBriefPackage('b');
  assert.equal(packet.authorized_source_assets[0].original_bytes_status,'saved_original');
  assert.equal(packet.media_availability.assets[0].asset_id,'a');
  // Narrative foreign key uses a real persisted row.
  db.prepare(`INSERT INTO narrative_plans(id,brief_id,opening_job,throughline,created_at,updated_at)
    VALUES ('n','b','Describe a hall','Hall','now','now')`).run();
  const saved=repository.assembleWritingPacket('b');
  assert.deepEqual(saved.context.media_availability,packet.media_availability);
  const before=saved.input_hash;
  repository.authorizedSourceAssetsForBrief=()=>[{...asset,original_sha256:'new'}];
  assert.equal(repository.getWritingPacket('b').input_hash,before);
  assert.equal(draftInputDto(repository.getBriefPackage('b')).media_availability.snapshot_hash,packet.media_availability.snapshot_hash);
});

test('T02-41/44: actual article-bundle request includes bounded candidate availability and explicit has_more',async t=>{
  const {repository}=repositoryFixture(t);
  repository.getTopicPackage=()=>({candidate:{id:'topic',destination_slug:'chongqing',proposed_title:'Hall'},facts:[],experiences:[],editorial_patterns:[],constraints:{}});
  const assets=Array.from({length:20},(_,index)=>({...asset,id:`a-${index}`}));
  assets.retrieval={has_more:true,offset:0,next_offset:160};
  repository.authorizedSourceAssetsForBrief=()=>assets;
  const research=repository.getPlanningPackage('topic');
  assert.equal(research.authorized_source_assets.length,12);
  assert.equal(research.media_availability.assets.length,20);
  assert.equal(research.media_availability.reason_counts.RETRIEVAL_MISS,8);
  assert.equal(research.media_availability.retrieval.has_more,true);
  assert.ok(Buffer.byteLength(JSON.stringify(research))<=PLANNING_INPUT_BUDGET.maxInputBytes);
  const calls=[];
  const engine=new ContentEngine({apiKey:'unused',model:'fixture'});
  engine.respond=async request=>{calls.push(request);return {output:{brief:{},draft:{slug:'hall',title:'Hall'}}};};
  await engine.articleBundle(research);
  assert.equal(calls.length,1);
  assert.equal(JSON.parse(calls[0].input).media_availability.snapshot_hash,research.media_availability.snapshot_hash);
});
