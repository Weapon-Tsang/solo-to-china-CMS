import { assertFrozenRoute, compareRouteMedia, routeSemantics, routeHash } from './route-bundle.mjs';
import { bindingSupportsPhoto } from './repositories/media-bindings.mjs';

export function constrainRouteVisuals(visuals, bundle, assets, gap) {
  if(!bundle) return visuals;
  assertFrozenRoute(bundle);
  return visuals.map(visual=>{
    const asset=assets.find(a=>a.id===visual.source_asset_id);
    if(!asset) return visual;
    const metadata=visual.media_metadata || {};
    const diagram=asset.asset_kind==='map_or_route' || visual.image_type==='map_or_route'
      || /route_overview|day_route_diagram|subroute_diagram/.test(metadata.media_purpose || '');
    const use=diagram?(metadata.media_purpose || 'route_overview'):
      metadata.media_purpose || (visual.image_role==='hero'?'cover':'stop_photo');
    let decision;
    if(diagram) {
      const fragments=(asset.route_source_fragments || []).filter(f=>
        [...f.days,...f.stops,...f.legs].every(item=>(item.evidence || []).some(e=>e.asset_id===asset.id)
          || (item.field_evidence || []).some(e=>e.asset_id===asset.id && e.evidence?.length)));
      const selected=metadata.route_source_fragment_id?fragments.filter(f=>f.fragment_id===metadata.route_source_fragment_id):fragments;
      const source=selected.length===1?selected[0]:null;
      let sourceRoute=source?routeSemantics(source):null;
      let panel=null;
      if(metadata.route_panel_id || metadata.route_crop) {
        panel=routePanelScope(source,asset,metadata);
        sourceRoute=panel.route;
      }
      decision=compareRouteMedia(bundle,{use,day_id:metadata.route_day_id,stop_ids:metadata.route_stop_ids,route:sourceRoute});
      if(panel) {
        decision={...decision,panel_scope:panel,semantic_compatible:decision.compatible,
          compatible:Boolean(panel.valid && decision.compatible),requires_panel_derivative:true,
          transform:panel.valid?'crop_then_revalidate':'recomposition',
          differences:[...decision.differences,{field:'panel_derivative',expected:'actual cropped bytes with lineage and independent QA',actual:'not_produced'}]};
      }
    } else {
      const stop=bundle.stops.find(s=>bindingSupportsPhoto(asset,{...visual,entity_key:s.entity_id,media_purpose:use}));
      const day=bundle.days.find(d=>d.day_id===metadata.route_day_id);
      const labels=(asset.text_regions || []).filter(r=>/\bday\s*\d+\b|第[一二三四五六七八九十\d]+天/i.test(r.text || '')
        && (!day || String(r.text).trim().toLowerCase()!==day.label.trim().toLowerCase()));
      decision=compareRouteMedia(bundle,{use,entity_id:stop?.entity_id,binding_valid:Boolean(stop),
        conflicting_labels:labels.length?labels.map(r=>r.text):[]});
    }
    const contract={...decision,route_id:bundle.route_id,revision:bundle.revision,approved_route_hash:bundle.approved_route_hash,
      use,day_id:metadata.route_day_id || null,target:decision.target || routeSemantics(bundle)};
    const result={...visual,media_metadata:{...metadata,route_contract:contract}};
    if(decision.compatible && decision.requires_panel_derivative) {
      return {...result,status:'planned',acquisition_strategy:'localize_source_image'};
    }
    if(!decision.compatible) {
      if((diagram || !visual.factual_image_required) && !metadata.required_visual_obligation?.required)
        return {...result,status:'skipped',factual_image_required:false,media_url:'',media_metadata:{...result.media_metadata,
          route_omission:{code:'ROUTE_MEDIA_MISMATCH',reason:'Optional route image conflicts with the approved route.',
            source_asset_id:asset.id,differences:decision.differences}}};
      return gap(result,'route_media_conflict');
    }
    return result;
  }).filter(Boolean);
}

// A panel plan is evidence for a future crop, never permission to deliver the
// complete collage. Byte production and QA remain mandatory downstream.
function routePanelScope(source,asset,metadata) {
  const crop=metadata.route_crop,ids=metadata.route_source_stop_ids;
  const validRegion=r=>r && ['x','y','width','height'].every(k=>Number.isFinite(r[k]))
    && r.x>=0 && r.y>=0 && r.width>0 && r.height>0 && r.x+r.width<=1 && r.y+r.height<=1;
  const failed={valid:false,route:null,status:'invalid_panel_evidence'};
  if(!source || !metadata.route_panel_id || !validRegion(crop) || !Array.isArray(ids) || ids.length<2 || new Set(ids).size!==ids.length)return failed;
  const stops=ids.map(id=>source.stops.find(s=>s.stop_id===id));
  if(stops.some(s=>!s) || stops.some((s,i)=>s.day_id!==stops[0].day_id || (i>0 && s.sequence!==stops[i-1].sequence+1)))return failed;
  const legs=source.legs.filter(l=>ids.includes(l.from_stop_id) && ids.includes(l.to_stop_id));
  const days=source.days.filter(d=>d.day_id===stops[0].day_id);
  if(source.branches?.length || legs.length!==stops.length-1)return failed;
  const supported=item=>[...(item.evidence || []),...(item.field_evidence || []).filter(f=>f.evidence?.length && !['ambiguous','unknown'].includes(f.status))]
    .some(e=>e.asset_id===asset.id && e.panel_id===metadata.route_panel_id && validRegion(e.region)
      && e.region.x>=crop.x && e.region.y>=crop.y && e.region.x+e.region.width<=crop.x+crop.width
      && e.region.y+e.region.height<=crop.y+crop.height);
  if(![...days,...stops,...legs].every(supported))return failed;
  const route={days,stops,legs,branches:[]};
  return {valid:true,status:'crop_bytes_and_qa_pending',asset_id:asset.id,source_sha256:asset.original_sha256 || null,
    fragment_id:source.fragment_id,panel_id:metadata.route_panel_id,crop,route,scope_hash:routeHash(route)};
}
