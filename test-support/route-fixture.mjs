import { normalizeRouteFragments, compileRouteBundle } from '../src/route-bundle.mjs';

export function routeFixture() {
  const source={id:'route-source',capture_version:1};
  const input={source,segments:[],claims:[],evidence_spans:[{id:'span-route',segment_id:'segment-route',
    asset_id:null,locator_type:'text_quote',quote:'Day 1: East Hall → West Hall → East Hall. Walk about 15 minutes to West Hall; return by bus.'}]};
  const fragment={occurrence_key:'walk',basis:'explicit_route',days:[{key:'1',label:'Day 1',sequence:1,evidence_span_ids:['span-route']}],
    stops:[['a','east','East Hall'],['b','west','West Hall'],['c','east','East Hall']].map(([key,entity_id,name_en],i)=>({
      key,day_key:'1',sequence:i+1,entity_id,name_en,name_zh:'',evidence_span_ids:['span-route']})),
    legs:[{key:'ab',from_key:'a',to_key:'b',mode:'walk',duration:{value:15,unit:'minutes',approximate:true},conditions:[],uncertainty:'source_assertion',evidence_span_ids:['span-route']},
      {key:'bc',from_key:'b',to_key:'c',mode:'bus',duration:null,conditions:[],uncertainty:'source_assertion',evidence_span_ids:['span-route']}]};
  const fragments=normalizeRouteFragments([fragment],input);
  for(const stop of fragments[0].stops) stop.identity_status='confirmed';
  const approval={record_id:'approval-1',scope:{content_type:'itinerary',title:'One-day route'}};
  const options={routeId:'route-fixture',fragments,approval,mediaAvailability:{assets:[]}};
  return {input,fragment,fragments,approval,options,bundle:compileRouteBundle(options)};
}
