import { routeError, canonicalRouteJson } from './route-bundle.mjs';

// Only explanatory fields may be omitted. Caller-supplied optional/critical
// flags must never weaken identity, direction, transport or validity checks.
export const optionalRouteFields=new Set(['duration','visit_duration','photo_tip']);
export function omitUnknownRouteDetails(route) {
  for(const item of [...(route.days || []),...(route.stops || []),...(route.legs || [])]) {
    for(const field of item.field_evidence || []) {
      if(optionalRouteFields.has(field.field) && (!field.evidence?.length || field.status!=='source_assertion')) {
        if(Object.hasOwn(item,field.field))item[field.field]=null;
      }
    }
  }
  return route;
}

// All selectors come from the persisted opportunity approval. The writer has
// no assembly authority. Whole supported days can be combined; within-day
// composition must select every occurrence and an existing directed connection.
export function selectRouteFragments(fragments, approvalScope = {}) {
  const scope=approvalScope.route_scope || {};
  const mode=scope.mode || 'source_route_adaptation';
  if(!['source_route_adaptation','evidence_composed_route'].includes(mode))
    throw routeError('ROUTE_CONFLICT',{field:'route_mode',actual:mode});
  const ids=scope.fragment_ids;
  if(ids && (!Array.isArray(ids) || !ids.length || new Set(ids).size!==ids.length))
    throw routeError('ROUTE_CONFLICT',{field:'fragment_ids'});
  const selected=ids ? ids.map(id=>{
    const matches=fragments.filter(f=>f.fragment_id===id);
    if(matches.length!==1) throw routeError('ROUTE_EVIDENCE_PENDING',{field:'fragment_id',actual:id,count:matches.length});
    return matches[0];
  }) : fragments;
  if(!selected.length || (mode==='source_route_adaptation' && selected.length!==1))
    throw routeError('ROUTE_EVIDENCE_PENDING',{field:'route_selection',count:selected.length,
      action:'Select the approved source route or explicitly approve an evidence composition.'});
  if(mode==='source_route_adaptation') return {mode,fragments:selected,route:structuredClone(selected[0])};
  if(!Array.isArray(scope.days) || !scope.days.length || !ids)
    throw routeError('ROUTE_EVIDENCE_PENDING',{field:'approved_composition_days'});
  const all=collection=>selected.flatMap(f=>f[collection] || []);
  const lookup=(collection,key,id)=>{
    const matches=all(collection).filter(x=>x[key]===id);
    if(matches.length!==1) throw routeError('ROUTE_EVIDENCE_PENDING',{field:collection,actual:id});
    return structuredClone(matches[0]);
  };
  const route={days:[],stops:[],legs:[],branches:[]};
  const consumed=new Set();
  for(const [index,selection] of scope.days.entries()) {
    const day=lookup('days','day_id',selection.source_day_id);
    if(typeof selection.label!=='string' || !selection.label.trim() || !selection.stop_ids?.length || !Array.isArray(selection.leg_ids))
      throw routeError('ROUTE_EVIDENCE_PENDING',{field:'approved_day',actual:index});
    const dayId=`composed:day:${index+1}`;
    route.days.push({...day,day_id:dayId,source_day_id:day.day_id,label:selection.label,sequence:index+1});
    for(const [sequence,stopId] of selection.stop_ids.entries()) {
      if(consumed.has(stopId)) throw routeError('ROUTE_CONFLICT',{field:'reused_stop_occurrence',actual:stopId});
      consumed.add(stopId);
      const stop=lookup('stops','stop_id',stopId);
      route.stops.push({...stop,source_day_id:stop.day_id,day_id:dayId,sequence:sequence+1});
    }
    for(const link of selection.leg_ids) {
      const legId=typeof link==='string'?link:link.evidence_leg_id;
      const leg=lookup('legs','leg_id',legId);
      if(typeof link==='object') {
        const sourceFrom=lookup('stops','stop_id',leg.from_stop_id),sourceTo=lookup('stops','stop_id',leg.to_stop_id);
        const targetFrom=lookup('stops','stop_id',link.from_stop_id),targetTo=lookup('stops','stop_id',link.to_stop_id);
        if(!sourceFrom.entity_id || !sourceTo.entity_id || sourceFrom.entity_id!==targetFrom.entity_id || sourceTo.entity_id!==targetTo.entity_id)
          throw routeError('ROUTE_CONFLICT',{field:legId,reason:'connection_evidence_entity_mismatch'});
        leg.source_leg_id=leg.leg_id;
        leg.leg_id=`${leg.leg_id}:composed:${index+1}:${selection.leg_ids.indexOf(link)+1}`;
        leg.from_stop_id=link.from_stop_id;leg.to_stop_id=link.to_stop_id;
      }
      const from=selection.stop_ids.indexOf(leg.from_stop_id),to=selection.stop_ids.indexOf(leg.to_stop_id);
      if(from<0 || to!==from+1) throw routeError('ROUTE_CONFLICT',{field:legId,reason:'connection_not_between_selected_adjacent_occurrences'});
      route.legs.push(leg);
    }
  }
  // Optional branches retain their original evidence and are never invented by
  // selecting photos. Reject unscoped branches until their endpoints are selected.
  for(const branch of all('branches')) {
    if(!consumed.has(branch.from_stop_id) || !consumed.has(branch.to_stop_id))
      throw routeError('ROUTE_EVIDENCE_PENDING',{field:'branch_scope',actual:branch});
    route.branches.push(structuredClone(branch));
  }
  return {mode,fragments:selected,route};
}

// These are checks against supplied evidence only, never a claim that transit,
// opening times or ticket availability have been verified in the real world.
export function routeConstraintDiagnostics(route) {
  const issues=[];
  const add=(item,field,actual,evidence,reason,code='ROUTE_CONFLICT')=>issues.push({code,
    severity:optionalRouteFields.has(field) && reason==='unresolved_field_evidence'?'warning':'error',
    field:`${item.stop_id || item.leg_id || item.day_id}.${field}`,actual,evidence,reason});
  for(const item of [...(route.days || []),...(route.stops || []),...(route.legs || [])]) {
    for(const field of item.field_evidence || []) {
      if(!field.evidence?.length || field.status!=='source_assertion')
        add(item,field.field,field.status,field.evidence,'unresolved_field_evidence','ROUTE_EVIDENCE_PENDING');
      if(field.direction && field.direction!=='from_to')
        add(item,field.field,field.direction,field.evidence,'ambiguous_or_reversed_arrow');
    }
    const grouped=new Map();
    for(const c of item.constraints || []) {
      if(!c.evidence?.length) {add(item,c.field,c.value,[],'missing_constraint_evidence','ROUTE_EVIDENCE_PENDING');continue;}
      if(c.status && c.status!=='source_assertion')
        add(item,c.field,c.status,c.evidence,'unresolved_condition','ROUTE_EVIDENCE_PENDING');
      const key=`${c.field}:${c.applies_to || ''}`;
      if(grouped.has(key) && canonicalRouteJson(grouped.get(key).value)!==canonicalRouteJson(c.value))
        add(item,c.field,c.value,[...grouped.get(key).evidence,...c.evidence],'contradictory_conditions');
      grouped.set(key,c);
      if(['arrival_minutes','closing_minutes'].includes(c.field)
        && (!Number.isInteger(c.value) || c.value<0 || c.value>1440))
        add(item,c.field,c.value,c.evidence,'invalid_clock_minutes');
    }
    const arrival=grouped.get('arrival_minutes:')?.value,close=grouped.get('closing_minutes:')?.value;
    if(Number.isFinite(arrival) && Number.isFinite(close) && arrival>close)
      add(item,'time_window',{arrival,close},item.evidence,'arrival_after_closing');
  }
  // Compare assertions only for the same explicit applicability scope. A
  // repeated place or different day's transport alternative is not a conflict.
  const assertions=new Map();
  for(const item of [...(route.stops || []),...(route.legs || [])]) {
    const entity=item.entity_id || [item.from_stop_id,item.to_stop_id].map(id=>route.stops.find(s=>s.stop_id===id)?.entity_id).join('->');
    for(const field of [...(item.field_evidence || []),...(item.constraints || [])]) {
      if(!field.applies_to || field.value==null || field.status && field.status!=='source_assertion')continue;
      const key=canonicalRouteJson([entity,field.field,field.applies_to]);
      const previous=assertions.get(key);
      const precisionChanged=previous && (previous.approximate ?? null)!==(field.approximate ?? null);
      if(previous && (canonicalRouteJson(previous.value)!==canonicalRouteJson(field.value) || precisionChanged))
        add(item,field.field,{expected:previous.value,actual:field.value,applies_to:field.applies_to,
          ...(precisionChanged?{expected_approximate:previous.approximate ?? null,actual_approximate:field.approximate ?? null}:{})},
          [...(previous.evidence || []),...(field.evidence || [])],'contradictory_scoped_source_fields');
      assertions.set(key,field);
    }
  }
  const value=(item,field)=>(item?.constraints || []).find(c=>c.field===field)?.value;
  for(const leg of route.legs || []) {
    const from=route.stops.find(s=>s.stop_id===leg.from_stop_id),to=route.stops.find(s=>s.stop_id===leg.to_stop_id);
    for(const [endpoint,stop] of [['from',from],['to',to]]) for(const field of ['city','bank']) {
      const expected=value(leg,`${endpoint}_${field}`),actual=value(stop,field);
      if(expected!=null && actual!=null && expected!==actual)
        add(leg,`${endpoint}_${field}`,{expected,actual},[...(leg.evidence || []),...(stop.evidence || [])],'endpoint_condition_mismatch');
    }
  }
  return issues;
}
