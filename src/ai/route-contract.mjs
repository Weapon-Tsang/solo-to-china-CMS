const text={type:'string'};
const list=items=>({type:'array',items});
const object=properties=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
const evidence=list(text);
const fieldEvidence=list(object({field:text,value:{type:'string',nullable:true},applies_to:text,approximate:{type:'boolean',nullable:true},
  evidence_span_ids:evidence,asset_id:text,panel_id:text,
  region:{...object({x:{type:'number'},y:{type:'number'},width:{type:'number'},height:{type:'number'}}),nullable:true},
  direction:{type:'string',enum:['','from_to','ambiguous','reverse']},
  status:{type:'string',enum:['source_assertion','ambiguous','conflict','inferred','unknown']}}));
const constraints=list(object({field:{type:'string',enum:['city','bank','from_city','to_city','from_bank','to_bank',
  'arrival_minutes','closing_minutes','reservation','traveler_condition','validity']},
  value:text,applies_to:text,status:{type:'string',enum:['source_assertion','ambiguous','conflict','stale']},evidence_span_ids:evidence}));
export const ROUTE_FRAGMENTS_SCHEMA=list(object({
  occurrence_key:text,basis:{type:'string',enum:['explicit_route','ambiguous']},
  days:list(object({key:text,label:text,sequence:{type:'integer'},evidence_span_ids:evidence,field_evidence:fieldEvidence})),
  stops:list(object({key:text,day_key:text,sequence:{type:'integer'},entity_id:text,name_zh:text,name_en:text,evidence_span_ids:evidence,
    field_evidence:fieldEvidence,constraints})),
  legs:list(object({key:text,from_key:text,to_key:text,mode:text,
    duration:{...object({value:{type:'number'},unit:{type:'string',enum:['minutes','hours']},approximate:{type:'boolean'}}),nullable:true},
    conditions:list(text),uncertainty:{type:'string',enum:['source_assertion','ambiguous','conflict','inferred']},evidence_span_ids:evidence,
    field_evidence:fieldEvidence,constraints})),
}));
export const ROUTE_EXTRACTION_PROMPT=`
Also return route_fragments for explicit source itineraries only, in this same extraction request.
Do not infer route order from photo positions, OCR reading order, or prose mentions. Follow explicit Day labels and directed connections.
Use existing evidence_span_ids for every day, stop occurrence and leg. Repeat visits need distinct occurrence keys.
Unknown entity IDs/names/modes are empty strings, unknown duration is null, never zero or guessed walking.
Preserve approximate times and conditions. Ambiguous arrows remain ambiguous. A source claim is not proof of current feasibility.
For image-derived fields supply field_evidence with the source asset, panel identity, normalized x/y/width/height region,
and existing span IDs. Arrow direction must be from_to for the leg's stated endpoints; ambiguous arrows remain unresolved.
Preserve each field's explicit value, approximation and stated applicability in field_evidence. Use null value and unknown
for an unstated duration; applies_to is empty unless the source states a specific applicability scope. Never invent a shared scope.
Preserve explicit city/bank, reservation, opening/arrival times (minutes from midnight as a string), validity and traveler
conditions in constraints with their own evidence. Empty arrays are correct when these were not stated. Never infer live validity.
Do not merge panels or substitute similarly named entities. Empty route_fragments is correct for knowledge-only sources.`;
export const ROUTE_WRITING_PROMPT=`
If route_bundle is present it is the read-only approved route. Preserve every day, stop occurrence, directed leg,
mode, approximate duration, conditions and uncertainty. Do not add stops or infer transport/times from photos.
Copy approved_route_table into the article, retaining labels, row order and all connection values exactly (heading levels may adapt).
Use route_bundle's supported names, not guessed translations. The same constraints apply to title, SEO, FAQ,
cards, captions and prose. Include a readable route table for each day with the exact stop order and leg labels.
Optional missing photos do not authorize removing days; a route schematic is not factual photography or live navigation.
Warning diagnostics identify omitted non-critical values. Do not restore those values from source_snapshot or guess replacements;
preserve uncertainty while keeping the approved topology. Knowledge-only input without route_bundle requires no itinerary table.`;
export const ROUTE_REVIEW_PROMPT=`
Independently compare actual prose, title, summary, SEO, FAQ and captions against route_bundle and its source_snapshot.
Do not trust self-reported IDs or hashes. Check Day, occurrence order, direction, mode, approximation and conditions.
Report field-level expected/actual/day/stop/leg/evidence details in issues for deviations. Source agreement does not verify current feasibility.
Return route_audit with the supplied approved_route_hash and checked=true only after checking these actual assertions;
passed=false for any route discrepancy. This is part of this single independent editorial request.`;
export const ROUTE_AUDIT_SCHEMA=object({approved_route_hash:text,checked:{type:'boolean'},passed:{type:'boolean'},differences:list(text)});
