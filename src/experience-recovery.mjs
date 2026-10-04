// Split evidence, never truncate it. Each part retains every referenced span
// and segment; a cross-panel claim therefore keeps its supporting context.
export const EXPERIENCE_RECOVERY_VERSION='evidence-partitions-2-validated-references';
export function splitExperiencePackage(input) {
  const segments=input.segments || [],claims=input.claims || [],spans=input.evidence_spans || [];
  // Partition by claim ownership when evidence spans many panels. Supporting
  // context may overlap, but no claim is scheduled twice or silently omitted.
  const bySegment=claims.length<2 && segments.length>1;
  const units=bySegment ? segments.map(s=>s.id) : claims.length>1 ? claims.map(c=>c.id) : [];
  if(units.length<2)return null;
  const middle=Math.ceil(units.length/2);
  const parts=[units.slice(0,middle),units.slice(middle)].map((ids,index)=>{
    const primary=new Set(ids);
    const selectedSpans=bySegment ? spans.filter(s=>primary.has(s.segment_id)) : [];
    const spanIds=new Set(selectedSpans.map(s=>s.id));
    const selectedClaims=claims.filter(c=>bySegment
      ? (c.evidence_span_ids || []).some(id=>spanIds.has(id))
        || (index===0 && !(c.evidence_span_ids || []).some(id=>spans.some(s=>s.id===id && segments.some(segment=>segment.id===s.segment_id))))
      : primary.has(c.id));
    for(const claim of selectedClaims)for(const id of claim.evidence_span_ids || [])spanIds.add(id);
    // Unclaimed context belongs to exactly one partition, including orphan
    // anchors. Referenced context follows every claim that actually uses it.
    const referenced=new Set(claims.flatMap(c=>c.evidence_span_ids || []));
    if(index===0)for(const span of spans)if(!referenced.has(span.id)
      || !segments.some(s=>s.id===span.segment_id))spanIds.add(span.id);
    const evidence=spans.filter(s=>spanIds.has(s.id));
    const segmentIds=new Set([...ids.filter(id=>bySegment),...evidence.map(s=>s.segment_id)]);
    if(!bySegment && index===0)for(const s of segments)
      if(!spans.some(span=>span.segment_id===s.id))segmentIds.add(s.id);
    const selectedSegments=segments.filter(s=>segmentIds.has(s.id));
    const assetIds=new Set([...selectedSegments.map(s=>s.asset_id),...evidence.map(s=>s.asset_id)].filter(Boolean));
    const media=(input.media || []).filter(a=>assetIds.has(a.id)
      || index===0 && !segments.some(s=>s.asset_id===a.id) && !spans.some(s=>s.asset_id===a.id));
    return {...input,segments:selectedSegments,claims:selectedClaims,evidence_spans:evidence,media,
      recovery_partition:{version:EXPERIENCE_RECOVERY_VERSION,part:index+1,total:2,
        instruction:'Extract only this evidence partition. Preserve explicit local route fragments; never infer a connection across absent panels. Return at most 20 grounded blocks.'}};
  });
  const core=part=>JSON.stringify([part.claims,part.evidence_spans,part.segments,part.media]);
  // A single indivisible claim may reference the entire source. Never split
  // it into identical paid requests that only differ in partition metadata.
  return parts.some(part=>core(part)===core(input)) ? null : parts;
}

export function shouldPartitionExperience(input) {
  return (input.claims?.length || 0)>120 || JSON.stringify(input).length>90_000;
}

export async function extractExperienceWithRecovery(input,{runStep,analyze,maxDepth=3},key='experience',depth=0) {
  const parts=depth<maxDepth ? splitExperiencePackage(input) : null;
  const result=await runStep(`${key}:result`,input,async signal=>{
    if(parts && shouldPartitionExperience(input))return {partitionRequired:true};
    try{return await analyze(input,{signal});}
    catch(error){
      if(error?.code!=='MODEL_OUTPUT_LIMIT' || !parts)throw error;
      // Remember the overflow as a durable decision. Restarting the worker
      // must not buy the same known-overflowing parent request again.
      return {partitionRequired:true,reason:'MODEL_OUTPUT_LIMIT'};
    }
  });
  if(!result.partitionRequired)return result;
  if(!parts)throw new Error('Stored Experience partition cannot be reconstructed.');
  const completed=[];
  for(const [index,part] of parts.entries())completed.push(await extractExperienceWithRecovery(part,
    {runStep,analyze,maxDepth},`${key}:${index+1}`,depth+1));
  return mergeExperienceParts(completed);
}

export function mergeExperienceParts(parts) {
  const blocks=[],routes=[],blockKeys=new Set(),routeKeys=new Set();
  for(const [index,part] of parts.entries()) {
    for(const block of part.output?.blocks || []){
      const key=JSON.stringify(block);
      if(!blockKeys.has(key)){blockKeys.add(key);blocks.push(block);}
    }
    for(const fragment of part.output?.route_fragments || []){
      const key=JSON.stringify(fragment);if(routeKeys.has(key))continue;routeKeys.add(key);
      const prefix=`p${index+1}:`,ids=new Set([...(fragment.days || []),...(fragment.stops || []),...(fragment.legs || [])].map(x=>x.key));
      const rewrite=(value,field)=>Array.isArray(value)?value.map(x=>rewrite(x,field))
        : value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,rewrite(v,k)]))
          : ['key','day_key','from_key','to_key','applies_to'].includes(field)&&ids.has(value)?prefix+value:value;
      routes.push({...rewrite(fragment),occurrence_key:prefix+fragment.occurrence_key});
    }
  }
  return {model:[...new Set(parts.map(p=>p.model).filter(Boolean))].join('+'),
    output:{blocks,route_fragments:routes,partitioned:true},partitioned:true};
}
