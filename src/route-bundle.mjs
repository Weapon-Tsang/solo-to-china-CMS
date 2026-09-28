import { createHash } from 'node:crypto';
import { selectRouteFragments, routeConstraintDiagnostics, optionalRouteFields, omitUnknownRouteDetails } from './route-composition.mjs';

export const ROUTE_POLICY = 'route-bundle-1';
export function canonicalRouteJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalRouteJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(k=>value[k]!==undefined).sort()
    .map(k=>`${JSON.stringify(k)}:${canonicalRouteJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}
export const routeHash = value => createHash('sha256').update(canonicalRouteJson(value)).digest('hex');
export function routeError(code, details) {
  return Object.assign(new Error(`${code}: ${JSON.stringify(details)}`), {code,details,retryable:false,statusCode:409});
}
export function routeContentKind(input = {}) {
  const proposal=input.approved_proposal || input.brief?.plan || input.brief || {};
  const type=proposal.content_type || proposal.contentType || input.candidate?.content_type || '';
  if (/^(itinerary|walk|route|walking_route)$/i.test(type)) return 'route';
  // Source fragments describe available evidence, not editorial permission to
  // turn an approved knowledge article into an itinerary.
  if (proposal.route_scope) return 'mixed';
  const title=proposal.title || input.candidate?.proposed_title || '';
  return /(?:\b\d+[- ]day\b|\bitinerary\b|\bwalking route\b|[一二三四五六七八九十\d]+[天日]游|分天行程)/i.test(title) ? 'route' : 'knowledge';
}

// The locator is an existing evidence span, never photo order or a model hash.
// This checks provenance and explicit extraction, not real-world truth.
export function normalizeRouteFragments(fragments, input) {
  const spans=new Map((input.evidence_spans || []).map(s=>[s.id,s]));
  const source=input.source;
  if (!source?.id || !Number.isInteger(source.capture_version)) throw routeError('ROUTE_EVIDENCE_PENDING',{field:'source_capture'});
  if (!Array.isArray(fragments) || fragments.length>8) throw routeError('ROUTE_EVIDENCE_PENDING',{field:'route_fragments'});
  const evidence=ids => (ids || []).map(id=>{
    const span=spans.get(id);
    if (!span) throw routeError('ROUTE_EVIDENCE_PENDING',{field:'evidence_span_id',actual:id});
    return {source_id:source.id,capture_version:source.capture_version,span_id:id,segment_id:span.segment_id,
      asset_id:span.asset_id || null,locator_type:span.locator_type,quote:span.quote,
      region:span.region || span.locator?.region || null,panel_id:span.panel_id || span.locator?.panel_id || null,
      start_offset:span.start_offset ?? null,end_offset:span.end_offset ?? null};
  });
  const fields=item=>(item.field_evidence || []).map(field=>{
    const refs=evidence(field.evidence_span_ids);
    if(!refs.length && !(optionalRouteFields.has(field.field) && field.status==='unknown'))
      throw routeError('ROUTE_EVIDENCE_PENDING',{field:field.field});
    const region=field.region || null;
    if(region && (!field.asset_id || !refs.every(ref=>ref.asset_id===field.asset_id)
      || !['x','y','width','height'].every(k=>Number.isFinite(region[k]))
      || region.x<0 || region.y<0 || region.width<=0 || region.height<=0
      || region.x+region.width>1 || region.y+region.height>1))
      throw routeError('ROUTE_EVIDENCE_PENDING',{field:field.field,reason:'invalid_asset_region'});
    if(field.panel_id && (!field.asset_id || !region))
      throw routeError('ROUTE_EVIDENCE_PENDING',{field:field.field,reason:'panel_requires_asset_region'});
    return {field:field.field,...(Object.hasOwn(field,'value')?{value:field.value}:{}),
      ...(field.applies_to?{applies_to:field.applies_to}:{}),...(Object.hasOwn(field,'approximate')?{approximate:field.approximate}:{}),
      asset_id:field.asset_id || null,panel_id:field.panel_id || null,region,
      direction:field.direction || null,status:field.status || 'source_assertion',evidence:refs};
  });
  const constraints=item=>(item.constraints || []).map(c=>({...c,
    value:['arrival_minutes','closing_minutes'].includes(c.field) && /^\d+$/.test(String(c.value)) ? Number(c.value):c.value,
    evidence:evidence(c.evidence_span_ids)}));
  return fragments.map((fragment,index)=>{
    if (!fragment.occurrence_key || !['explicit_route','ambiguous'].includes(fragment.basis))
      throw routeError('ROUTE_EVIDENCE_PENDING',{field:'basis',fragment:index});
    const prefix=`${source.id}:${source.capture_version}:${fragment.occurrence_key}`;
    const days=(fragment.days || []).map(day=>({day_id:`${prefix}:day:${day.key}`,source_key:day.key,
      label:day.label,sequence:day.sequence,evidence:evidence(day.evidence_span_ids),field_evidence:fields(day)}));
    const stops=(fragment.stops || []).map(stop=>({stop_id:`${prefix}:stop:${stop.key}`,source_key:stop.key,
      day_id:`${prefix}:day:${stop.day_key}`,sequence:stop.sequence,entity_id:stop.entity_id || null,
      name_zh:stop.name_zh || null,name_en:stop.name_en || null,identity_status:stop.entity_id?'candidate':'unknown',
      evidence:evidence(stop.evidence_span_ids),field_evidence:fields(stop),constraints:constraints(stop)}));
    const legs=(fragment.legs || []).map(leg=>({leg_id:`${prefix}:leg:${leg.key}`,
      from_stop_id:`${prefix}:stop:${leg.from_key}`,to_stop_id:`${prefix}:stop:${leg.to_key}`,
      mode:leg.mode || null,duration:leg.duration || null,conditions:leg.conditions || [],
      uncertainty:leg.uncertainty || 'source_assertion',evidence:evidence(leg.evidence_span_ids),
      field_evidence:fields(leg),constraints:constraints(leg)}));
    return {fragment_id:prefix,source_id:source.id,capture_version:source.capture_version,
      source_input_hash:input.input_hash || null,
      basis:fragment.basis,days,stops,legs,branches:fragment.branches || [],evidence_status:'source_assertion_not_live_verified'};
  });
}

export function routeSemantics(route) {
  return {days:route.days,stops:route.stops,legs:route.legs,branches:route.branches || []};
}
export function routeDiagnostics(route) {
  const issues=[];
  const issue=(code,field,expected,actual)=>issues.push({code,field,expected,actual});
  if (!route.days?.length || !route.stops?.length) issue('ROUTE_EVIDENCE_PENDING','days/stops','explicit route',null);
  for(const [collection,id] of [['days','day_id'],['stops','stop_id'],['legs','leg_id']]) {
    const seen=new Set();
    for(const item of route[collection] || []) {
      if(!item[id] || seen.has(item[id])) issue('ROUTE_CONFLICT',`${collection}.${id}`,'unique occurrence',item[id]);
      seen.add(item[id]);
      if(!item.evidence?.length) issue('ROUTE_EVIDENCE_PENDING',`${item[id]}.evidence`,'source locator',null);
    }
  }
  const days=new Set((route.days || []).map(x=>x.day_id));
  const stops=new Map((route.stops || []).map(x=>[x.stop_id,x]));
  const daySequences=new Set();
  for(const day of route.days || []) {
    if(!Number.isInteger(day.sequence) || day.sequence<1 || daySequences.has(day.sequence))
      issue('ROUTE_CONFLICT',`${day.day_id}.sequence`,'unique positive sequence',day.sequence);
    daySequences.add(day.sequence);
    const ordered=(route.stops || []).filter(s=>s.day_id===day.day_id).sort((a,b)=>a.sequence-b.sequence);
    const seen=new Set();
    for(const stop of ordered) {
      if(!Number.isInteger(stop.sequence) || stop.sequence<1 || seen.has(stop.sequence))
        issue('ROUTE_CONFLICT',`${stop.stop_id}.sequence`,'unique positive sequence',stop.sequence);
      seen.add(stop.sequence);
    }
    for(let i=1;i<ordered.length;i++) {
      if(!(route.legs || []).some(l=>l.from_stop_id===ordered[i-1].stop_id && l.to_stop_id===ordered[i].stop_id))
        issue('ROUTE_EVIDENCE_PENDING',`${ordered[i-1].stop_id}->${ordered[i].stop_id}`,'directed connection',null);
    }
  }
  for(const stop of route.stops || []) {
    if(!days.has(stop.day_id)) issue('ROUTE_CONFLICT',`${stop.stop_id}.day_id`,'known day',stop.day_id);
    if(!stop.entity_id || stop.identity_status!=='confirmed') issue('ROUTE_EVIDENCE_PENDING',`${stop.stop_id}.entity_id`,'resolved entity',stop.entity_id);
  }
  for(const leg of route.legs || []) {
    if(!stops.has(leg.from_stop_id) || !stops.has(leg.to_stop_id)) issue('ROUTE_CONFLICT',leg.leg_id,'known endpoints',leg);
    if(['ambiguous','conflict','inferred'].includes(leg.uncertainty)) issue('ROUTE_CONFLICT',`${leg.leg_id}.uncertainty`,'supported connection',leg.uncertainty);
    if(leg.duration && (!Number.isFinite(leg.duration.value) || leg.duration.value<=0 || !['minutes','hours'].includes(leg.duration.unit)
      || typeof leg.duration.approximate!=='boolean')) issue('ROUTE_CONFLICT',`${leg.leg_id}.duration`,'positive duration with explicit precision',leg.duration);
  }
  const edges=new Map();
  for(const leg of route.legs || []) {
    const key=`${leg.from_stop_id}->${leg.to_stop_id}`;
    const value=canonicalRouteJson({mode:leg.mode,duration:leg.duration,conditions:leg.conditions});
    if(edges.has(key) && edges.get(key)!==value) issue('ROUTE_CONFLICT',key,edges.get(key),value);
    edges.set(key,value);
  }
  return [...issues,...routeConstraintDiagnostics(route)];
}

export function compileRouteBundle({routeId,revision=1,fragments,approval,mediaAvailability,mediaObligations=[]}) {
  if(!approval?.record_id || !approval?.scope) throw routeError('ROUTE_EVIDENCE_PENDING',{field:'approval'});
  const selected=selectRouteFragments(fragments,approval.scope);
  const source=omitUnknownRouteDetails(selected.route);
  const bundle={policy:ROUTE_POLICY,route_id:routeId,revision,mode:selected.mode,approval,
    ...structuredClone(routeSemantics(source)),source_snapshot:structuredClone(selected.fragments),
    source_route_hash:routeHash(selected.fragments.map(f=>routeSemantics(f))),media_availability:mediaAvailability || null,
    media_obligations:structuredClone(mediaObligations),reality_verification:'NOT_VERIFIED'};
  bundle.days.sort((a,b)=>a.sequence-b.sequence);
  bundle.stops.sort((a,b)=>bundle.days.findIndex(d=>d.day_id===a.day_id)-bundle.days.findIndex(d=>d.day_id===b.day_id) || a.sequence-b.sequence);
  bundle.diagnostics=routeDiagnostics(bundle);
  const promisedDays=Number(approval.scope.route_scope?.day_count || approval.scope.day_count || 0);
  if(promisedDays && bundle.days.length!==promisedDays) bundle.diagnostics.push({code:'ROUTE_CONFLICT',field:'approved_day_count',expected:promisedDays,actual:bundle.days.length});
  if(selected.fragments.some(f=>f.basis!=='explicit_route')) bundle.diagnostics.push({code:'ROUTE_EVIDENCE_PENDING',field:'basis',actual:'ambiguous'});
  for(const obligation of mediaObligations.filter(x=>x.required)) {
    if(obligation.kind==='schematic' && obligation.use==='route_overview') continue;
    const asset=mediaAvailability?.assets?.find(a=>a.asset_id===obligation.asset_id);
    if(!asset || asset.known_gaps.length || !asset.supported_relationships.some(r=>r.entity_key===obligation.entity_id
      && r.allowed_uses.includes(obligation.use))) bundle.diagnostics.push({code:'REQUIRED_ROUTE_MEDIA_MISSING',field:obligation.slot_id});
  }
  bundle.status=bundle.diagnostics.find(issue=>issue.severity!=='warning')?.code || 'FROZEN';
  bundle.approved_route_hash=routeHash({policy:bundle.policy,mode:bundle.mode,approval,...routeSemantics(bundle)});
  bundle.content_hash=routeHash(bundle);
  return bundle;
}

export function assertFrozenRoute(bundle) {
  if(!bundle || bundle.status!=='FROZEN') throw routeError(bundle?.status || 'ROUTE_EVIDENCE_PENDING',bundle?.diagnostics || []);
  const {content_hash,...content}=bundle;
  if(routeHash(content)!==content_hash || routeHash({policy:bundle.policy,mode:bundle.mode,approval:bundle.approval,...routeSemantics(bundle)})!==bundle.approved_route_hash)
    throw routeError('ROUTE_VERSION_STALE',{route_id:bundle.route_id});
  return bundle;
}

export function routeReadableMarkdown(bundle) {
  assertFrozenRoute(bundle);
  const cell=value=>String(value || '').replace(/[|\r\n]/g,' ');
  return bundle.days.map(day=>{
    const stops=bundle.stops.filter(s=>s.day_id===day.day_id);
    return [`### ${cell(day.label)}`, '| Stop | Next connection |', '| --- | --- |', ...stops.map(stop=>{
      const leg=bundle.legs.find(l=>l.from_stop_id===stop.stop_id);
      const next=leg && bundle.stops.find(s=>s.stop_id===leg.to_stop_id);
      const time=leg?.duration ? `${leg.duration.approximate?'about ':''}${leg.duration.value} ${leg.duration.unit}` : '';
      const connection=leg ? [next?.name_en || next?.name_zh,leg.mode || 'transport not specified',time,...leg.conditions].filter(Boolean).join('; ') : 'End of day';
      return `| ${cell(stop.name_en || stop.name_zh)} | ${cell(connection)} |`;
    })].join('\n');
  }).join('\n\n');
}

// A readable deterministic assertion surface supplements, never replaces,
// the independent review of all prose/captions/SEO claims.
export function validateRouteDraft(bundle,draft) {
  if(!bundle) return;
  assertFrozenRoute(bundle);
  const expected=routeReadableMarkdown(bundle).split('\n\n');
  const body=String(draft.body_markdown || '').replace(/\r\n/g,'\n');
  let position=-1;
  for(const table of expected) {
    // Heading levels may be normalized by the existing content engine.
    const lines=table.split('\n'),label=lines.shift().replace(/^#+ /,'');
    const literal=lines.join('\n');const found=body.indexOf(literal,position+1);
    const prefix=found<0?'':body.slice(position+1,found);
    if(found<0 || !prefix.split('\n').some(line=>line.replace(/^#+ /,'').trim()===label))
      throw routeError('ROUTE_TEXT_MISMATCH',{field:'readable_route_table',expected:table,route_id:bundle.route_id});
    position=found+literal.length-1;
  }
}

export function compareRouteMedia(bundle, candidate) {
  assertFrozenRoute(bundle);
  if(['stop_photo','route_context_photo','cover'].includes(candidate.use)) {
    const valid=bundle.stops.some(s=>s.entity_id===candidate.entity_id);
    const differences=[];
    if(!valid || !candidate.binding_valid) differences.push({field:'entity_binding',expected:'current source binding',actual:candidate.entity_id});
    if(candidate.conflicting_labels?.length) differences.push({field:'embedded_labels',actual:candidate.conflicting_labels});
    return {compatible:!differences.length,differences,transform:'reuse_photo',does_not_prove:'route connection or same-day photography'};
  }
  let target=candidate.use==='day_route_diagram' || candidate.use==='subroute_diagram' ? {
    days:bundle.days.filter(d=>d.day_id===candidate.day_id),
    stops:bundle.stops.filter(s=>s.day_id===candidate.day_id),
    legs:bundle.legs.filter(l=>[l.from_stop_id,l.to_stop_id].every(id=>bundle.stops.some(s=>s.stop_id===id && s.day_id===candidate.day_id))),branches:bundle.branches,
  }:routeSemantics(bundle);
  const differences=[];
  if(!['day_route_diagram','route_overview','subroute_diagram'].includes(candidate.use) || !target.days.length) differences.push({field:'use/day',actual:candidate.use});
  if(candidate.use==='subroute_diagram') {
    const ids=candidate.stop_ids;
    const ordered=[...target.stops].sort((a,b)=>a.sequence-b.sequence);
    const start=Array.isArray(ids)?ordered.findIndex(s=>s.stop_id===ids[0]):-1;
    if(!Array.isArray(ids) || ids.length<2 || start<0 || ids.some((id,index)=>ordered[start+index]?.stop_id!==id)
      || target.branches.length) differences.push({field:'subroute_scope',expected:'contiguous approved occurrences without unresolved branches',actual:ids || null});
    else {
      const stops=ordered.slice(start,start+ids.length);
      target={...target,stops,legs:target.legs.filter(l=>ids.includes(l.from_stop_id) && ids.includes(l.to_stop_id))};
    }
  }
  const expected=routeMediaSemantics(target),actual=candidate.route?routeMediaSemantics(candidate.route):null;
  for(const field of ['days','stops','legs','branches']) if(canonicalRouteJson(expected[field])!==canonicalRouteJson(actual?.[field]))
    differences.push({field,expected:expected[field],actual:actual?.[field] ?? null});
  return {compatible:!differences.length,differences,transform:differences.length?'recomposition':'faithful_localization',
    target,
    source_route_hash:candidate.route?routeHash(candidate.route):null,target_route_hash:bundle.approved_route_hash,
    actions:differences.length?['redraw_from_approved_route','use_verified_photo_region','upload_matching_route','propose_route_revision']:[]};
}

// Compare factual topology, not source-specific locator IDs. Repeated visits
// remain distinct by occurrence position, including a return to the same entity.
export function routeMediaSemantics(route) {
  const days=[...(route.days || [])].sort((a,b)=>a.sequence-b.sequence);
  const stops=days.flatMap(day=>(route.stops || []).filter(s=>s.day_id===day.day_id).sort((a,b)=>a.sequence-b.sequence));
  return {days:days.map(d=>({label:d.label,sequence:d.sequence})),
    stops:stops.map(s=>({entity_id:s.entity_id,name_zh:s.name_zh || null,name_en:s.name_en || null,
      day:days.findIndex(d=>d.day_id===s.day_id),sequence:s.sequence})),
    legs:(route.legs || []).map(l=>({from:stops.findIndex(s=>s.stop_id===l.from_stop_id),to:stops.findIndex(s=>s.stop_id===l.to_stop_id),
      mode:l.mode,duration:l.duration,conditions:l.conditions,uncertainty:l.uncertainty})).sort((a,b)=>a.from-b.from || a.to-b.to),
    branches:route.branches || []};
}
