import test from 'node:test';
import assert from 'node:assert/strict';
import { routeFixture } from '../test-support/route-fixture.mjs';
import { compileRouteBundle,normalizeRouteFragments,routeReadableMarkdown } from '../src/route-bundle.mjs';

test('unknown optional duration is omitted with evidence warning while core fields cannot be downgraded',()=>{
  const f=routeFixture();
  f.fragment.legs[0].field_evidence=[{field:'duration',value:null,status:'unknown',evidence_span_ids:[]}];
  const fragments=normalizeRouteFragments([f.fragment],f.input);
  for(const stop of fragments[0].stops)stop.identity_status='confirmed';
  const bundle=compileRouteBundle({...f.options,fragments});
  assert.equal(bundle.status,'FROZEN');assert.equal(bundle.legs[0].duration,null);
  assert.equal(bundle.source_snapshot[0].legs[0].duration.value,15);
  assert.equal(bundle.diagnostics[0].severity,'warning');
  assert.doesNotMatch(routeReadableMarkdown(bundle),/15 minutes/);
  for(const field of ['direction','mode','entity_id','validity']) {
    f.fragment.legs[0].field_evidence=[{field,value:null,status:'unknown',optional:true,evidence_span_ids:['span-route']}];
    const core=normalizeRouteFragments([f.fragment],f.input);
    for(const stop of core[0].stops)stop.identity_status='confirmed';
    assert.notEqual(compileRouteBundle({...f.options,fragments:core}).status,'FROZEN',field);
  }
});

test('multi-source same-scope field conflicts retain both locators; distinct scopes stay independent',()=>{
  const f=twoSources();
  for(const [i,fragment] of f.options.fragments.entries())fragment.legs[0].field_evidence=[{
    field:'mode',value:i?'taxi':'walk',applies_to:'weekday morning route',status:'source_assertion',evidence:fragment.legs[0].evidence}];
  const scope={mode:'evidence_composed_route',fragment_ids:f.options.fragments.map(x=>x.fragment_id),
    days:f.options.fragments.map((fragment,i)=>({source_day_id:fragment.days[0].day_id,label:`Day ${i+1}`,
      stop_ids:fragment.stops.map(s=>s.stop_id),leg_ids:fragment.legs.map(l=>l.leg_id)}))};
  const options={...f.options,approval:{...f.approval,scope:{route_scope:scope}}};
  const conflict=compileRouteBundle(options);
  assert.equal(conflict.status,'ROUTE_CONFLICT');
  const issue=conflict.diagnostics.find(d=>d.reason==='contradictory_scoped_source_fields');
  assert.equal(new Set(issue.evidence.map(e=>e.source_id)).size,2);
  assert.deepEqual(issue.actual,{expected:'walk',actual:'taxi',applies_to:'weekday morning route'});
  f.extra.legs[0].field_evidence[0].applies_to='weekend evening alternative';
  assert.equal(compileRouteBundle(options).status,'FROZEN');
  for(const [i,fragment] of f.options.fragments.entries())Object.assign(fragment.legs[0].field_evidence[0],
    {field:'duration',value:'15 minutes',applies_to:'weekday morning route',approximate:Boolean(i)});
  const precision=compileRouteBundle(options);
  assert.equal(precision.status,'ROUTE_CONFLICT');
  assert.equal(precision.diagnostics[0].actual.expected_approximate,false);
  assert.equal(precision.diagnostics[0].actual.actual_approximate,true);
});

function twoSources() {
  const fixture=routeFixture(),second=routeFixture();
  second.input.source.id='second-source';
  const extra=normalizeRouteFragments([second.fragment],second.input)[0];
  for(const stop of extra.stops) stop.identity_status='confirmed';
  return {...fixture,extra,options:{...fixture.options,fragments:[fixture.fragments[0],extra]}};
}

test('stored selection chooses the approved source, never the source with more photographs',()=>{
  const f=twoSources();
  assert.throws(()=>compileRouteBundle(f.options),{code:'ROUTE_EVIDENCE_PENDING'});
  const bundle=compileRouteBundle({...f.options,approval:{...f.approval,scope:{route_scope:{fragment_ids:[f.extra.fragment_id]}}}});
  assert.equal(bundle.status,'FROZEN');assert.equal(bundle.source_snapshot.length,1);
  assert.equal(bundle.source_snapshot[0].source_id,'second-source');
  assert.throws(()=>compileRouteBundle({...f.options,approval:{...f.approval,scope:{route_scope:{fragment_ids:['invented']}}}}),{code:'ROUTE_EVIDENCE_PENDING'});
});

test('approved multi-source composition retains repeated visits and field evidence without adding model calls',()=>{
  const f=twoSources();
  const scope={mode:'evidence_composed_route',fragment_ids:f.options.fragments.map(x=>x.fragment_id),day_count:2,
    days:f.options.fragments.map((fragment,i)=>({source_day_id:fragment.days[0].day_id,label:`Day ${i+1}`,
      stop_ids:fragment.stops.map(s=>s.stop_id),leg_ids:fragment.legs.map(l=>l.leg_id)}))};
  const options={...f.options,approval:{...f.approval,scope:{route_scope:scope}}};
  const bundle=compileRouteBundle(options);
  assert.equal(bundle.status,'FROZEN');assert.equal(bundle.mode,'evidence_composed_route');
  assert.equal(bundle.stops.length,6);assert.equal(new Set(bundle.stops.map(s=>s.stop_id)).size,6);
  assert.equal(bundle.legs[0].duration.approximate,true);assert.equal(bundle.legs[1].duration,null);
  assert.equal(bundle.source_snapshot.length,2);assert.equal(bundle.reality_verification,'NOT_VERIFIED');
  const reversed=structuredClone(options);reversed.approval.scope.route_scope.days[0].stop_ids.reverse();
  assert.throws(()=>compileRouteBundle(reversed),{code:'ROUTE_CONFLICT'});
  const missing=structuredClone(options);missing.approval.scope.route_scope.days[0].leg_ids.pop();
  assert.equal(compileRouteBundle(missing).status,'ROUTE_EVIDENCE_PENDING');
});

test('cross-source connection uses supported entity endpoints and rejects similarly named substitutes',()=>{
  const f=twoSources(),first=f.fragments[0];
  const scope={mode:'evidence_composed_route',fragment_ids:f.options.fragments.map(x=>x.fragment_id),days:[{
    source_day_id:first.days[0].day_id,label:'Day 1',stop_ids:[first.stops[0].stop_id,f.extra.stops[1].stop_id],
    leg_ids:[{evidence_leg_id:f.extra.legs[0].leg_id,from_stop_id:first.stops[0].stop_id,to_stop_id:f.extra.stops[1].stop_id}]}]};
  const options={...f.options,approval:{...f.approval,scope:{route_scope:scope}}};
  const bundle=compileRouteBundle(options);assert.equal(bundle.status,'FROZEN');
  assert.equal(bundle.legs[0].evidence[0].source_id,'second-source');
  const bad=structuredClone(options);bad.fragments[0].stops[0].entity_id='similarly-named-place';
  assert.throws(()=>compileRouteBundle(bad),{code:'ROUTE_CONFLICT'});
});

test('panel, asset and directed field provenance is preserved; invented regions and ambiguous arrows block',()=>{
  const f=routeFixture();f.input.evidence_spans[0].asset_id='image-a';
  f.fragment.legs[0].field_evidence=[{field:'direction',asset_id:'image-a',panel_id:'panel-2',
    region:{x:0.5,y:0,width:0.5,height:1},direction:'from_to',status:'source_assertion',evidence_span_ids:['span-route']}];
  const normalized=normalizeRouteFragments([f.fragment],f.input);
  assert.equal(normalized[0].legs[0].field_evidence[0].panel_id,'panel-2');
  for(const s of normalized[0].stops)s.identity_status='confirmed';
  assert.equal(compileRouteBundle({...f.options,fragments:normalized}).status,'FROZEN');
  normalized[0].legs[0].field_evidence[0].direction='ambiguous';
  assert.equal(compileRouteBundle({...f.options,fragments:normalized}).status,'ROUTE_CONFLICT');
  f.fragment.legs[0].field_evidence[0].region.width=0.8;
  assert.throws(()=>normalizeRouteFragments([f.fragment],f.input),{code:'ROUTE_EVIDENCE_PENDING'});
  f.fragment.legs[0].field_evidence[0].region.width=0.5;
  f.fragment.legs[0].field_evidence[0].asset_id='another-image';
  assert.throws(()=>normalizeRouteFragments([f.fragment],f.input),{code:'ROUTE_EVIDENCE_PENDING'});
});

test('available city/bank/time and stale-condition evidence blocks conflicts without claiming live verification',()=>{
  for(const kind of ['bank','city','time','stale']) {
    const f=routeFixture(),r=f.fragments[0],evidence=r.stops[0].evidence;
    if(kind==='time')r.stops[0].constraints=[{field:'arrival_minutes',value:1000,evidence},{field:'closing_minutes',value:900,evidence}];
    else if(kind==='stale')r.legs[0].constraints=[{field:'validity',value:'old schedule',status:'stale',evidence}];
    else {r.stops[0].constraints=[{field:kind,value:'a',evidence}];r.legs[0].constraints=[{field:`from_${kind}`,value:'b',evidence}];}
    const bundle=compileRouteBundle(f.options);
    assert.notEqual(bundle.status,'FROZEN',kind);assert.ok(bundle.diagnostics[0].field);
    assert.equal(bundle.reality_verification,'NOT_VERIFIED');
  }
});
