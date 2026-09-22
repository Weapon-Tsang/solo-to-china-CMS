import assert from 'node:assert/strict';
import test from 'node:test';
import {repositoryFixture} from '../test-support/repository-fixture.mjs';

test('a frozen writing packet remains authoritative when a draft is saved and reviewed',t=>{
  const {db,repository}=repositoryFixture(t);
  const key='itinerary.chongqing.day2_sequence';
  const heading='Day 2: South-Bank Heritage, Then Liangjiang Xiao Ferry';
  const value='Huangjueya Old Street -> Huangge Ancient Road -> Longmenhao Old Street -> Xiahaoli -> Clock Tower Square -> Liangjiang Xiao Ferry';
  const outline=[{section_id:'day-2-south-bank-ferry',heading,purpose:'Follow the supplied Day 2 route.',claim_keys:[key]}];
  const fact={normalized_key:key,subject:'Chongqing 3-Day Itinerary Day 2',canonical_subject:'Chongqing 3-Day Itinerary Day 2',
    predicate:'route_sequence',preferred_value:value,consensus_status:'operator_confirmed_source',
    freshness_state:'current',verification_priority:'normal',consensus_method:'USER_PROVIDED_EDITORIAL_SOURCE',
    consensus_confidence:1,validity_state:'current',selection_frozen:true,evidence:[{
      claim_id:'claim-route-day2',source_id:'source-route-maps',value,
      quote:'Day 2 follows the supplied south-bank route and Liangjiang Xiao Ferry.',
      qualifiers:['Day 2','user-supplied route collage'],confidence:1,publication_usability:'usable',
      evidence_coverage:'complete',coverage_limitations:[],evidence_role:'current',
    }]};
  db.prepare(`INSERT INTO topic_candidates(id,destination_slug,topic_key,proposed_title,rationale,
    coverage_score,evidence_count,conflict_count,status,created_at,updated_at)
    VALUES ('candidate','chongqing','three-day-route','Three-Day Chongqing Route','fixture',1,1,0,'brief_ready','now','now')`).run();
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,plan_json,canonical_json,
    status,created_at,updated_at,candidate_id,evidence_ledger_json,strategy_version)
    VALUES ('brief','chongqing','Three-Day Chongqing Route','["solo travelers"]','informational',?,?,'ready','now','now',
      'candidate',?,'3.9')`).run(JSON.stringify({title:'Three-Day Chongqing Route',outline}),
      JSON.stringify({content_type:'itinerary'}),JSON.stringify([key]));
  db.prepare(`INSERT INTO narrative_plans(id,brief_id,route_sequence_json,supporting_fact_keys_json,created_at,updated_at)
    VALUES ('narrative','brief',?,?,'now','now')`).run(JSON.stringify(['day-2-south-bank-ferry']),JSON.stringify([key]));
  db.prepare(`INSERT INTO writing_packets(id,brief_id,narrative_plan_id,packet_text,evidence_ledger_json,
    selected_fact_keys_json,selected_experience_block_ids_json,input_hash,context_json,created_at,updated_at)
    VALUES ('packet','brief','narrative','Frozen Day 2 route',?,?,'[]','packet-hash',?,'now','now')`)
    .run(JSON.stringify([{version:2,key,subject:fact.subject,predicate:fact.predicate,value,status:'operator_confirmed_source',
      fact_snapshot:fact,sources:[{claim_id:'claim-route-day2',source_id:'source-route-maps'}]}]),
    JSON.stringify([key]),JSON.stringify({version:2,narrative_plan:{route_sequence:['day-2-south-bank-ferry'],
      supporting_fact_keys:[key]},content_policy:{visuals:{minimum:0,target:0,maximum:0}},
      authorized_source_assets:[],reader_sources:[],internal_link_inventory:[]}));

  const before=repository.getBriefPackage('brief');
  assert.equal(before.facts.length,1);
  assert.equal(before.facts[0].preferred_value,value);
  const body=`## ${heading}\n\n**Suggested order:** ${value}.`;
  const draftId=repository.saveDraft('brief',{title:'Three-Day Chongqing Route',slug:'three-day-route',body_markdown:body,
    meta_description:'Three-day Chongqing itinerary.',evidence_ledger:[{section_id:'day-2-south-bank-ferry',section:heading,
      content_node_ids:[],claim_keys:[key],source_ids:['source-route-maps']}],unresolved_conflicts:[],verification_notes:[],
    seo:{},schema_jsonld:{},visuals:[]},'fixture',{deferReview:true});
  const saved=repository.getDraftPackage(draftId);
  assert.equal(saved.facts[0].preferred_value,value);
  assert.deepEqual(saved.draft.evidence_ledger[0].claim_keys,[key]);
  assert.deepEqual(saved.draft.evidence_ledger[0].source_ids,['source-route-maps']);
  assert.equal(saved.draft.evidence_ledger[0].content_node_ids.length,1);
});
