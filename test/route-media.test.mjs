import test from 'node:test';
import assert from 'node:assert/strict';
import { routeFixture } from '../test-support/route-fixture.mjs';
import { normalizeVisuals } from '../src/repository.mjs';
import { VertexImagen } from '../src/visuals/vertex-imagen.mjs';
import { compareRouteMedia, routeSemantics } from '../src/route-bundle.mjs';

function inputs(kind='documentary_photo') {
  const {bundle,fragments}=routeFixture();
  const asset={id:'route-image',source_id:'route-source',asset_kind:kind,analysis_status:'ready',primary_subjects:['East Hall'],
    alt_text:'East Hall',width:1200,height:800,mime_type:'image/png',storage_status:'saved',original_bytes_status:'saved_original',
    durability_status:'ORIGINAL_STORED',original_sha256:'bytes',language_status:'en',text_regions:[],
    source_bindings:[{id:'binding',status:'confirmed',relation_type:'depicts_entity',entity_key:'east',canonical_subject:'East Hall',allowed_uses:['stop_photo','route_context_photo']}],
    route_source_fragments:fragments};
  for(const item of [...fragments[0].days,...fragments[0].stops,...fragments[0].legs])item.evidence[0].asset_id=asset.id;
  const visual={source_asset_id:asset.id,image_type:kind==='map_or_route'?'map_or_route':'real_world_photo',
    image_subject:'East Hall',purpose:'East Hall',required:true,image_role:'support'};
  return {bundle,asset,visual};
}

test('subroute use requires contiguous approved occurrences; a partial diagram cannot claim the full day',()=>{
  const {bundle}=routeFixture(),ids=bundle.stops.slice(0,2).map(s=>s.stop_id);
  const route={...routeSemantics(bundle),stops:bundle.stops.slice(0,2),legs:bundle.legs.slice(0,1)};
  const candidate={use:'subroute_diagram',day_id:bundle.days[0].day_id,stop_ids:ids,route};
  assert.equal(compareRouteMedia(bundle,candidate).compatible,true);
  assert.equal(compareRouteMedia(bundle,candidate).target.stops.length,2);
  assert.equal(compareRouteMedia(bundle,{...candidate,use:'day_route_diagram'}).compatible,false);
  for(const stop_ids of [[ids[1],ids[0]],[ids[0],bundle.stops[2].stop_id],[ids[0],ids[0]],['missing']])
    assert.equal(compareRouteMedia(bundle,{...candidate,stop_ids}).compatible,false);
});

test('actual normalization retains panel crop semantics but never delivers the uncropped collage as a subroute',()=>{
  const f=inputs('map_or_route'),source=f.asset.route_source_fragments[0];
  const crop={x:0,y:0,width:0.5,height:1};
  for(const item of [...source.days,...source.stops,...source.legs]) {
    item.evidence[0].panel_id='left';item.evidence[0].region={x:0.1,y:0.1,width:0.2,height:0.2};
  }
  f.visual.media_metadata={media_purpose:'subroute_diagram',route_day_id:f.bundle.days[0].day_id,
    route_stop_ids:f.bundle.stops.slice(0,2).map(s=>s.stop_id),route_source_fragment_id:source.fragment_id,
    route_source_stop_ids:source.stops.slice(0,2).map(s=>s.stop_id),route_panel_id:'left',route_crop:crop};
  const normalize=()=>normalizeVisuals([f.visual],{id:'draft',title:'East Hall',strategy_version:'3.8'},
    {topic:'East Hall',route_bundle:f.bundle},[f.asset],{visuals:{maximum:1,target:1}})[0];
  const result=normalize(),contract=result.media_metadata.route_contract;
  assert.equal(result.status,'failed');assert.equal(result.source_asset_id,null);
  assert.equal(contract.semantic_compatible,true);assert.equal(contract.compatible,false);
  assert.equal(contract.target.stops.length,2);assert.equal(contract.panel_scope.valid,true);
  assert.equal(contract.panel_scope.status,'crop_bytes_and_qa_pending');
  assert.equal(contract.panel_scope.source_sha256,'bytes');
  f.visual.media_metadata.route_crop={x:0.8,y:0,width:0.3,height:1};
  assert.equal(normalize().media_metadata.route_contract.panel_scope.valid,false);
  f.visual.media_metadata.route_crop=crop;source.legs[0].evidence[0].panel_id='other';
  assert.equal(normalize().media_metadata.route_contract.panel_scope.valid,false);
});

test('actual normalization accepts related other-day photo but blocks a mismatching full-day map with a durable gap',()=>{
  const f=inputs(),draft={id:'draft',title:'East Hall',body_markdown:'East Hall',strategy_version:'3.8'};
  const normalize=f=>normalizeVisuals([f.visual],draft,{topic:'East Hall',route_bundle:f.bundle},[f.asset],{visuals:{maximum:5,target:1}})[0];
  let result=normalize(f);assert.equal(result.source_asset_id,f.asset.id);
  assert.equal(result.media_metadata.route_contract.compatible,true);
  assert.equal(result.media_metadata.route_contract.transform,'reuse_photo');
  const map=inputs('map_or_route');
  map.asset.route_source_fragments[0].legs[0].mode='taxi';
  result=normalize(map);assert.equal(result.status,'failed');
  assert.equal(result.media_metadata.required_visual_gap.reason,'route_media_conflict');
  assert.ok(result.media_metadata.route_contract.differences.some(x=>x.field==='legs'));
  assert.equal(result.media_metadata.route_contract.transform,'recomposition');
  assert.equal(result.source_asset_id,null);
  const good=normalize(inputs('map_or_route'));
  assert.equal(good.media_metadata.route_contract.transform,'faithful_localization');
  assert.equal(good.media_metadata.route_contract.compatible,true);
});

test('optional conflicting route map retains its source and explicit omission instead of vanishing',()=>{
  const f=inputs('map_or_route');f.visual.required=false;
  f.asset.route_source_fragments[0].legs[0].mode='taxi';
  const results=normalizeVisuals([f.visual],{id:'draft',title:'East Hall',body_markdown:'East Hall',strategy_version:'3.8'},
    {topic:'East Hall',route_bundle:f.bundle},[f.asset],{visuals:{maximum:5,target:1}});
  const omitted=results.find(v=>v.status==='skipped');
  assert.ok(omitted);assert.equal(omitted.source_asset_id,f.asset.id);
  assert.equal(omitted.media_metadata.route_omission.code,'ROUTE_MEDIA_MISMATCH');
  assert.ok(omitted.media_metadata.route_omission.differences.some(d=>d.field==='legs'));
  assert.equal(f.asset.original_sha256,'bytes');
});

test('actual independent visual QA request contains frozen topology and rejects missing/stale/wrong-arrow receipts',async()=>{
  const f=inputs('map_or_route');
  const visual=normalizeVisuals([f.visual],{id:'draft',title:'East Hall',strategy_version:'3.8'},
    {topic:'East Hall',route_bundle:f.bundle},[f.asset],{visuals:{maximum:1,target:1}})[0];
  const requests=[];
  let audit;
  const client=new VertexImagen({projectId:'fixture',qualityModel:'controlled-quality',requestTimeoutMs:5000},async(url,request)=>{
    requests.push(JSON.parse(request.body));
    const qa=Object.fromEntries(['language','completeness','style','semantic'].map(k=>[k,{status:'passed',reason:'controlled response'}]));
    return Response.json({candidates:[{content:{parts:[{text:JSON.stringify({...qa,notes:'',route_audit:audit})}]}}]});
  });
  const run=()=>client.reviewTransformedImage({visual,metadata:visual.media_metadata,source:{mimeType:'image/png',base64:'controlled'},
    outputBytes:Buffer.from('external-boundary-only'),outputMimeType:'image/png',accessToken:'test'});
  await assert.rejects(run(),{code:'ROUTE_VISUAL_QA_FAILED'});
  audit={approved_route_hash:'old',checked:true,passed:true,differences:[]};
  await assert.rejects(run(),{code:'ROUTE_VISUAL_QA_FAILED'});
  audit={...audit,approved_route_hash:f.bundle.approved_route_hash,passed:false,differences:['leg ab: expected east to west; actual west to east']};
  await assert.rejects(run(),{code:'ROUTE_VISUAL_QA_FAILED'});
  audit={...audit,passed:true,differences:[]};
  const qa=await run();assert.equal(qa.semantic.route_audit.approved_route_hash,f.bundle.approved_route_hash);
  assert.ok(requests[0].generationConfig.responseSchema.required.includes('route_audit'));
  assert.ok(requests[0].contents.parts[0].text.includes(f.bundle.approved_route_hash));
  assert.match(requests[0].contents.parts[0].text,/every stop occurrence, arrow direction/);
  assert.equal(requests.length,4);
});
