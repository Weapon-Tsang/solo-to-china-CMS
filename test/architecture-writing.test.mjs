import assert from 'node:assert/strict';
import test from 'node:test';
import { draftInputDto } from '../src/ai/content-engine.mjs';

test('writing compaction preserves distinct conditions and evidence roles behind identical source quotes',()=>{
  const rows=Array.from({length:5},(_,index)=>({claim_id:`claim-${index}`,source_id:'same-source',
    value:'CNY 20',quote:'Ticket conditions',qualifiers:[`condition-${index}`],
    evidence_role:index===4?'historical':'current',valid_from:`202${index}-01-01`}));
  const fact={normalized_key:'museum.ticket',subject:'Museum',predicate:'ticket',preferred_value:'CNY 20',
    selection_frozen:true,scope:{product:'admission'},evidence:rows};
  const pack={brief:{plan:{outline:[]}},writing_packet:{selected_fact_keys:['museum.ticket'],
    evidence_ledger:[{fact_snapshot:fact}],context:{version:2}}};
  const dto=draftInputDto(pack);
  const actual=dto.evidence_ledger_facts[0];
  assert.equal(actual.evidence.length,5);
  assert.deepEqual(actual.evidence.map(x=>x.qualifiers),rows.map(x=>x.qualifiers));
  assert.equal(actual.evidence[4].evidence_role,'historical');
  assert.equal(actual.selection_frozen,true);
  assert.deepEqual(actual.scope,{product:'admission'});
});

test('equivalent corroborating rows are bounded while a fourth distinct condition is retained',()=>{
  const evidence=Array.from({length:30},(_,i)=>({claim_id:`claim-${i}`,source_id:`source-${i}`,value:'CNY 20',
    quote:`Quoted observation ${i}`,qualifiers:['adult']}));
  evidence.push({claim_id:'child',source_id:'child-source',value:'CNY 20',quote:'Child ticket',qualifiers:['child']});
  const dto=draftInputDto({facts:[{normalized_key:'ticket',evidence}]});
  assert.equal(dto.evidence_ledger_facts[0].evidence.length,4);
  assert.equal(dto.evidence_ledger_facts[0].evidence.at(-1).claim_id,'child');
});

test('a frozen non-route packet cannot borrow a later live route',()=>{
  const dto=draftInputDto({route_bundle:{route_id:'live',approved_route_hash:'live'},
    writing_packet:{evidence_ledger:[],selected_fact_keys:[],context:{version:2}}});
  assert.equal(dto.route_bundle,null);assert.equal(dto.approved_route_table,null);
});
