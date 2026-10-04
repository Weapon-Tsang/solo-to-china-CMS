// Reversible wire-only IDs preserve every claim/span and its original text.
export function compactExperienceReferences(input) {
  const forward = new Map(), reverse = new Map();
  let prefix = '@experience:';
  while (JSON.stringify(input).includes(prefix)) prefix = `@${prefix}`;
  for (const [key, kind] of [['segments','segment'],['claims','claim'],['evidence_spans','span'],['media','asset']])
    for (const [index, item] of (input[key] || []).entries()) {
      if (typeof item.id !== 'string' || forward.has(item.id)) continue;
      const alias = `${prefix}${kind}:${index}`;
      forward.set(item.id, alias); reverse.set(alias, item.id);
    }
  return { input: replace(input, forward), restore: output => replace(output, reverse) };
}

export function validateExperienceReferences(output,input) {
  const allowed=new Map([['segment_ids',new Set((input.segments||[]).map(x=>x.id))],
    ['supporting_claim_ids',new Set((input.claims||[]).map(x=>x.id))],
    ['evidence_span_ids',new Set((input.evidence_spans||[]).map(x=>x.id))]]);
  const errors=[];
  function visit(value,path='$'){
    if(Array.isArray(value))return value.forEach((item,i)=>visit(item,`${path}[${i}]`));
    if(!value||typeof value!=='object')return;
    for(const [field,child] of Object.entries(value)){
      if(allowed.has(field)&&Array.isArray(child))for(const ref of child)
        if(!allowed.get(field).has(ref))errors.push({path:`${path}.${field}`,invalid_reference:ref});
      visit(child,`${path}.${field}`);
    }
  }
  visit(output);
  if(errors.length)throw Object.assign(new Error('Experience output contains unknown evidence identifiers.'),
    {code:'EXPERIENCE_REFERENCE_INVALID',retryable:false,details:errors.slice(0,30)});
  return output;
}

function replace(value, mapping) {
  if (typeof value === 'string') return mapping.get(value) ?? value;
  if (Array.isArray(value)) return value.map(item => replace(item, mapping));
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, replace(item, mapping)]));
  return value;
}
