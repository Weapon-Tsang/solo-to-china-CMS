const parse=value=>{try{return typeof value==='string'?JSON.parse(value):value || {};}catch{return {};}};
const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(value)&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const latest=values=>values.map(date).filter(Boolean).sort().at(-1) || null;

// These are independent observations, never a single "freshness" timestamp.
// An upload, source capture, or successful model QA does not verify all facts.
export function articleTimeEvidence({publication=null,revisions=[],visuals=[],facts=[]}={}) {
  const remote=parse(publication?.response_json),post=remote.post || remote;
  const published=(post.status==='publish')?date(post.date_gmt?`${post.date_gmt.replace(/Z$/,'')}Z`:post.date):null;
  let substantive=null,previous=null;
  for(const revision of [...revisions].sort((a,b)=>a.revision-b.revision)) {
    const snapshot=parse(revision.snapshot_json);
    if(previous && typeof snapshot.body_markdown==='string' && snapshot.body_markdown!==previous.body_markdown)
      substantive=date(revision.created_at) || substantive;
    previous=snapshot;
  }
  const media=visuals.flatMap(visual=>{
    const metadata=parse(visual.media_metadata_json || visual.media_metadata);
    return [metadata.web_derivative,metadata.manual_local_receipt?.derivative].filter(r=>r?.verification==='decoded_and_lineage_verified');
  });
  const perFact=facts.map(fact=>({claim_key:fact.normalized_key,
    evidence_verified_at:latest((fact.evidence || []).map(e=>e.verified_at || e.source_verified_at)),
    basis:'saved_claim_source_evidence',conditions:fact.qualifiers || []}));
  return {published_at:published,substantive_edit_at:substantive,
    facts_verified_at:null,media_optimized_at:latest(media.map(r=>r.optimized_at)),
    facts_verification_status:'article_wide_verification_not_recorded',per_fact:perFact,
    note:'Source verification dates apply only to their cited evidence; no whole-article verification date is inferred.'};
}
