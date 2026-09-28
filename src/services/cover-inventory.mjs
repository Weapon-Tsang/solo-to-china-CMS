import fs from 'node:fs';
import {mediaHash} from '../web-media.mjs';
import {readMediaBindings,bindingSupportsPhoto} from '../repositories/media-bindings.mjs';
import {transaction} from '../db.mjs';
const fail=(code,message)=>Object.assign(new Error(message),{code,statusCode:409});
export function coverInventory(db,draftId,{offset=0,limit=25}={}) {
  if(!Number.isSafeInteger(offset)||offset<0)throw fail('COVER_PAGE_INVALID','Invalid inventory page.');
  limit=Math.max(1,Math.min(25,limit));
  const draft=db.prepare('SELECT ad.revision,cb.destination_slug,cb.topic FROM article_drafts ad JOIN content_briefs cb ON cb.id=ad.brief_id WHERE ad.id=?').get(draftId);
  if(!draft)throw fail('DRAFT_NOT_FOUND','Draft not found.');
  const rows=db.prepare(`SELECT DISTINCT sa.id,sa.local_path,sa.original_sha256,sa.stored_sha256,sa.alt_text,sa.caption_text,saa.asset_kind,saa.reader_text_present
    FROM current_source_assets sa JOIN source_asset_analyses saa ON saa.asset_id=sa.id
    JOIN media_bindings mb ON mb.asset_id=sa.id WHERE mb.destination_slug=? AND mb.status='confirmed'
      AND saa.analysis_status='ready' AND saa.asset_kind='documentary_photo' AND saa.source_sha256=COALESCE(NULLIF(sa.original_sha256,''),sa.stored_sha256)
      AND sa.original_bytes_status='saved_original' AND sa.durability_status='ORIGINAL_STORED'
      AND NOT EXISTS(SELECT 1 FROM article_visuals av WHERE av.draft_id=? AND av.source_asset_id=sa.id)
    ORDER BY sa.id LIMIT ? OFFSET ?`).all(draft.destination_slug,draftId,limit+1,offset);
  const items=rows.slice(0,limit).map(row=>{
    const bindings=readMediaBindings(db,row.id),related=bindingSupportsPhoto({...row,source_bindings:bindings},{...draft,image_subject:draft.topic,purpose:draft.topic,media_purpose:'cover'});
    const hash=row.original_sha256 || row.stored_sha256;
    const reasons=[];if(!related)reasons.push('COVER_ENTITY_RELATION_UNCONFIRMED');if(!row.local_path||!fs.existsSync(row.local_path))reasons.push('COVER_MASTER_UNAVAILABLE_OR_INVALID');
    if(row.reader_text_present!==0)reasons.push('COVER_OVERLAY_REVIEW_REQUIRED');
    return {source_asset_id:row.id,original_hash:hash,alt:row.alt_text || row.caption_text,eligible:!reasons.length,reasons,
      source_binding_ids:bindings.map(x=>x.id)};
  });
  return {draft_revision:draft.revision,items,offset,next_offset:rows.length>limit?offset+limit:null};
}
export function importCoverSource(db,draftId,input,actor) {
  const inventory=coverInventory(db,draftId,{offset:input.offset || 0});
  if(input.expected_revision!==inventory.draft_revision)throw fail('COVER_REVISION_CONFLICT','Draft changed.');
  const candidate=inventory.items.find(item=>item.source_asset_id===input.source_asset_id);
  if(!candidate?.eligible || candidate.original_hash!==input.original_hash)throw fail('COVER_SOURCE_CONFLICT','Stored source is not an eligible related photo.');
  const source=db.prepare('SELECT * FROM source_assets WHERE id=?').get(candidate.source_asset_id);
  if(mediaHash(fs.readFileSync(source.local_path))!==candidate.original_hash)throw fail('COVER_SOURCE_CONFLICT','Original bytes changed.');
  const id=`cover_source_${mediaHash(`${draftId}:${source.id}`).slice(0,32)}`;
  transaction(db,()=>{
    db.prepare(`INSERT INTO article_visuals(id,draft_id,slot,placement,purpose,alt_text,caption,generation_prompt,status,created_at,updated_at,
      media_path,media_url,source_asset_id,acquisition_strategy,image_type,media_metadata_json,asset_fingerprint)
      VALUES (?,?,(SELECT COALESCE(MAX(slot),0)+1 FROM article_visuals WHERE draft_id=?),'hero','cover',?,?,'','generated',datetime('now'),datetime('now'),?,?,?,
        'use_authorized_source_image','real_world_photo',?,?)`).run(id,draftId,draftId,source.alt_text || candidate.alt,source.caption_text || '',source.local_path,
        `/api/source-assets/${encodeURIComponent(source.id)}/preview`,source.id,JSON.stringify({media_purpose:'cover',cover_inventory_selection:{actor,source_asset_id:source.id,hash:candidate.original_hash},
          visual_decision:{action:'retain'},source_analysis:{analysis_status:'ready',asset_kind:'documentary_photo',reader_text_present:false},authorized_asset_match:{score:1,source_binding_ids:candidate.source_binding_ids}}),mediaHash(JSON.stringify(candidate)));
  });
  return {visual_id:id,draft_revision:inventory.draft_revision};
}

export function planCoverIllustration(db,draftId,input,actor) {
  const draft=db.prepare('SELECT revision FROM article_drafts WHERE id=?').get(draftId);
  if(!draft || draft.revision!==input.expected_revision)throw fail('COVER_REVISION_CONFLICT','Draft changed.');
  const subjects={packing:'Travel preparation with luggage and practical packing objects',payments:'Travel payment preparation with abstract wallet and card shapes',travel_preparation:'Abstract travel preparation checklist represented by objects without text'};
  const subject=subjects[input.abstract_topic];if(!subject)throw fail('COVER_ILLUSTRATION_SCOPE_INVALID','Only abstract travel preparation, packing or payment themes are allowed.');
  const id=`cover_illustration_${mediaHash(draftId).slice(0,32)}`;
  const prior=db.prepare('SELECT * FROM article_visuals WHERE id=?').get(id);
  if(prior){const topic=JSON.parse(prior.media_metadata_json || '{}').cover_generation?.abstract_topic;
    if(topic!==input.abstract_topic)throw fail('COVER_ILLUSTRATION_SCOPE_CONFLICT','Existing illustration plan has a different topic. Review it before changing the plan.');
    return {visual_id:id,status:'WAITING_AUTH',provider_calls:0,existing:true};}
  db.prepare(`INSERT INTO article_visuals(id,draft_id,slot,placement,purpose,alt_text,caption,generation_prompt,aspect_ratio,image_type,
    acquisition_strategy,status,last_error,created_at,updated_at,media_metadata_json,asset_fingerprint)
    VALUES (?,?,(SELECT COALESCE(MAX(slot),0)+1 FROM article_visuals WHERE draft_id=?),'hero','cover',?,? ,?,'16:9','illustration',
    'generate_illustration','planned','COVER_GENERATION_WAITING_AUTH',datetime('now'),datetime('now'),?,?)`).run(id,draftId,draftId,
      `Editorial illustration: ${subject}.`,`Editorial illustration: ${subject}.`,subject,
      JSON.stringify({media_purpose:'cover',cover_generation:{abstract_topic:input.abstract_topic,authorized:false,actor,max_distinct_candidates:2}}),mediaHash(`${draftId}:${subject}`));
  return {visual_id:id,status:'WAITING_AUTH',provider_calls:0,max_distinct_candidates:2};
}
