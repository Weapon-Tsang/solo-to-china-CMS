import {selectInternalLinks,suggestContentDisposition,inventoryVersion} from '../seo-geo.mjs';

const parse=value=>{try{return JSON.parse(value || '{}');}catch{return {};}};
const normalize=value=>String(value || '').normalize('NFKC').toLowerCase().trim();

// Read only saved editorial identity and anonymous observations. An inventory
// sync proves publication status, not anonymous accessibility or topic identity.
export function editorialSeoContext(db,{proposal={},plan={},destination='',topic='',siteUrl='',facts=[],inventory=[],candidateId=null,now=Date.now()}={}) {
  const aliases=db.prepare('SELECT entity_key,alias_normalized,canonical_subject FROM entity_aliases WHERE destination_slug=?').all(destination);
  const ids=values=>[...new Set((Array.isArray(values)?values:[]).flatMap(value=>{
    const label=typeof value==='string'?value:value?.entity_id || value?.entity_key;
    const matches=aliases.filter(a=>[a.entity_key,a.alias_normalized,a.canonical_subject].some(x=>normalize(x)===normalize(label)));
    return new Set(matches.map(a=>a.entity_key)).size===1?[matches[0].entity_key]:[];
  }))];
  const context={entities:ids(proposal.targetEntities || proposal.entity_ids),
    question:proposal.readerQuestion || proposal.reader_question || proposal.readerPromise || proposal.reader_promise || plan.reader_promise || '',
    articleType:proposal.content_type || proposal.contentType || '',evidenceSufficient:facts.length>0};
  const rows=db.prepare(`SELECT wp.site_url,wp.post_id,ad.id draft_id,ad.revision,ad.content_hash,cb.plan_json,cb.candidate_id,
    (SELECT count(*) FROM content_opportunities co WHERE co.candidate_id=cb.candidate_id AND co.approved_at IS NOT NULL) approved_owner_count,
    (SELECT coverage_json FROM content_opportunities co WHERE co.candidate_id=cb.candidate_id AND co.approved_at IS NOT NULL
      ORDER BY co.updated_at DESC,co.id LIMIT 1) coverage_json,
    rs.value_json observation_json
    FROM wordpress_publications wp JOIN article_drafts ad ON ad.id=wp.draft_id
    JOIN content_briefs cb ON cb.id=ad.brief_id
    LEFT JOIN runtime_settings rs ON rs.setting_key='seo_observation:'||ad.id`).all();
  const sameSite=value=>{try{return new URL(value).origin===new URL(siteUrl).origin;}catch{return false;}};
  const enriched=inventory.filter(item=>sameSite(item.site_url)&&!rows.some(row=>row.site_url===item.site_url&&row.post_id===item.post_id&&row.candidate_id===candidateId)).map(item=>{
    const matches=rows.filter(row=>row.site_url===item.site_url && row.post_id===item.post_id);
    if(matches.length!==1)return {...item,entity_ids:[],reader_question:'',public_accessibility:'unknown'};
    const local=matches[0],coverage=parse(local.coverage_json),approved=coverage.approval?.proposal || {};
    if(local.approved_owner_count!==1)return {...item,entity_ids:[],reader_question:'',public_accessibility:'unknown'};
    const observation=parse(local.observation_json),age=now-Date.parse(observation.checked_at || '');
    const current=Number.isFinite(age)&&age>=0&&age<300_000&&observation.page_revision===local.revision
      && observation.content_hash===local.content_hash&&observation.url===item.post_url&&observation.result?.finalUrl===item.post_url;
    const observed=current&&observation.result?.requests?.[0]?.status==='observed';
    return {...item,entity_ids:ids(coverage.targetEntities || approved.targetEntities || approved.entity_ids),
      reader_question:coverage.editorialBrief || approved.readerQuestion || approved.reader_question || approved.readerPromise || approved.reader_promise || parse(local.plan_json).reader_promise || '',
      article_type:approved.content_type || approved.contentType || '',public_accessibility:observed?'confirmed':'unknown'};
  });
  const links=selectInternalLinks(enriched,{...context,topic,siteUrl});
  return {context,links,disposition:suggestContentDisposition(enriched,context),
    inventory_version:inventoryVersion(enriched),unverified_targets:enriched.filter(i=>i.status==='publish'&&i.public_accessibility!=='confirmed').map(i=>({post_id:i.post_id,url:i.post_url,status:'unknown'})),
    automatic:false,external_calls:0};
}
