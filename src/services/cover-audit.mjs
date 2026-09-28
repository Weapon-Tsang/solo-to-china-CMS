import fs from 'node:fs';
import sharp from 'sharp';
import { parseMediaMetadata } from '../media-delivery.mjs';
import { mediaHash } from '../web-media.mjs';
import { readMediaBindings,bindingSupportsPhoto } from '../repositories/media-bindings.mjs';
import { COVER_POLICY_VERSION,evaluateCoverCandidate,selectCoverCandidate,coverAuditFingerprint } from '../cover-policy.mjs';
import {readCoverContract} from '../cover-contract.mjs';

const error=(code,message)=>Object.assign(new Error(message),{code,statusCode:409,retryable:false});
let lane=Promise.resolve();

// Deliberately read-only: no mutation, enqueue, remote inventory, model or upload.
// This is an audit plan, never a publication eligibility receipt.
export function auditDraftCover(db,draftId,options={}) {
  const task=lane.then(()=>audit(db,draftId,options));
  lane=task.catch(()=>{});
  return task;
}

async function audit(db,draftId,{expectedRevision=null,geometryByVisual={},offset=0,limit=25}={}) {
  const draft=db.prepare('SELECT id,revision,content_hash,body_markdown,title,slug,status,brief_id FROM article_drafts WHERE id=?').get(draftId);
  if(!draft)throw Object.assign(new Error('Draft not found'),{code:'DRAFT_NOT_FOUND',statusCode:404});
  if(expectedRevision!==null && (!Number.isInteger(expectedRevision) || draft.revision!==expectedRevision))
    throw error('COVER_REVISION_CONFLICT','The draft revision changed.');
  const brief=db.prepare('SELECT destination_slug,topic FROM content_briefs WHERE id=?').get(draft.brief_id);
  const publication=db.prepare('SELECT post_id,status FROM wordpress_publications WHERE draft_id=?').get(draftId);
  const rows=db.prepare('SELECT * FROM article_visuals WHERE draft_id=? ORDER BY slot,id').all(draftId);
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>50)throw error('COVER_PAGE_INVALID','Invalid candidate page.');
  const locks=rows.filter(row=>parseMediaMetadata(row.media_metadata_json).cover_locked===true);
  const lockIds=new Set(locks.slice(0,2).map(row=>row.id));
  const pageRows=rows.filter((row,index)=>(index>=offset&&index<offset+limit)||Object.hasOwn(geometryByVisual,row.id)||lockIds.has(row.id));
  const inputIdentity=coverAuditFingerprint({draft,rows,publication});
  const sourceQuery=db.prepare(`SELECT sa.*,saa.analysis_status,saa.asset_kind,saa.source_sha256 AS analysis_hash,
    saa.text_regions_json,saa.editor_ui_regions_json,saa.reader_text_present FROM current_source_assets sa
    LEFT JOIN source_asset_analyses saa ON saa.asset_id=sa.id WHERE sa.id=?`);
  const sourceIdentities=new Map();
  const candidates=[];
  for(const row of pageRows) {
    const metadata=parseMediaMetadata(row.media_metadata_json);
    const source=row.source_asset_id?sourceQuery.get(row.source_asset_id):null;
    const originalHash=source?.original_sha256 || source?.stored_sha256;
    let analysis=source && originalHash && source.analysis_hash===originalHash
      ? {analysis_status:source.analysis_status,asset_kind:source.asset_kind,
        text_regions:JSON.parse(source.text_regions_json || '[]'),editor_ui_regions:JSON.parse(source.editor_ui_regions_json || '[]')} : {};
    const bindings=source?readMediaBindings(db,source.id):[];
    if(row.source_asset_id)sourceIdentities.set(row.source_asset_id,coverAuditFingerprint({source,bindings}));
    let relationshipVerified=source && bindingSupportsPhoto({...source,source_bindings:bindings},
      {...brief,image_subject:row.image_subject,purpose:row.purpose,media_purpose:'cover'});
    let info={},hash=null,fileIssue=null;
    try {
      if(!row.media_path)throw new Error('Missing master path');
      const bytes=fs.readFileSync(row.media_path);hash=mediaHash(bytes);
      info=await sharp(bytes,{limitInputPixels:40_000_000,failOn:'error'}).metadata();
      await sharp(bytes,{limitInputPixels:40_000_000,failOn:'error'}).stats();
      if((info.pages || 1)>1 || !['jpeg','png','webp'].includes(info.format))throw new Error('Unsupported master');
      if(mediaHash(fs.readFileSync(row.media_path))!==hash)throw new Error('Master changed during decode');
    } catch {fileIssue='COVER_MASTER_UNAVAILABLE_OR_INVALID';}
    const rotated=[5,6,7,8].includes(info.orientation);
    // Future selection UI must persist geometry bound to the exact master hash.
    const suppliedGeometry=geometryByVisual[row.id] || metadata.cover_geometry;
    const geometry=suppliedGeometry?.master_hash===hash?suppliedGeometry:{};
    const localAudit=parseMediaMetadata(source?.local_photo_audit_json);
    const manual=metadata.manual_article_selection,manualReceipt=metadata.manual_local_receipt;
    if(row.image_type==='illustration' && !row.factual_image_required && ['travel_preparation','payments','packing'].includes(metadata.cover_generation?.abstract_topic)){
      analysis={analysis_status:'ready',asset_kind:'editorial_illustration',non_factual:true,abstract_topic_approved:true,text_regions:[],editor_ui_regions:[]};relationshipVerified=true;
    }
    const manualPhoto=!fileIssue && source && manual?.locked && manual.local_photo && !manual.route_blocked
      && manual.asset_id===source.id && manual.draft_revision===draft.revision && manual.original_hash===hash
      && originalHash===hash && source.original_bytes_status==='saved_original' && source.durability_status==='ORIGINAL_STORED'
      && manualReceipt?.original_hash===hash && manualReceipt.selection_id===manual.id
      && manualReceipt.photo_audit?.sha256===hash && Number.isFinite(manualReceipt.photo_audit.textChars) && manualReceipt.provider_calls===0
      && !manualReceipt.photo_audit.reasons?.some(reason=>!['resolution_low','focus_low','detail_low'].includes(reason))
      && (!manualReceipt.photo_audit.reasons?.length || manual.quality_confirmed);
    if(manualPhoto){relationshipVerified=true;analysis={analysis_status:'ready',asset_kind:'documentary_photo',text_regions:[],editor_ui_regions:[]};}
    const retainedOriginal=manualPhoto || (!fileIssue && source && originalHash===hash && source.original_bytes_status==='saved_original'
      && source.durability_status==='ORIGINAL_STORED' && row.acquisition_strategy==='use_authorized_source_image'
      && metadata.visual_decision?.action==='retain' && relationshipVerified && analysis.analysis_status==='ready'
      && analysis.asset_kind==='documentary_photo' && !(analysis.editor_ui_regions || []).length
      && (source.reader_text_present===0 || (localAudit.status==='eligible' && localAudit.sha256===hash && localAudit.providerCalls===0)));
    const candidate=evaluateCoverCandidate({id:row.id,analysis,relationshipVerified,masterHash:hash,
      qa:retainedOriginal?{status:'passed',file_hash:hash}:metadata.quality_qa,width:rotated?info.height:info.width,height:rotated?info.width:info.height,
      geometry,locked:metadata.cover_locked===true,origin:metadata.cover_generation?'illustration':metadata.cover_inventory_selection?'stored':'article'});
    candidate.qa_basis=manualPhoto?'confirmed_article_photo_local_checks':retainedOriginal?'retained_source_checks':'stored_master_qa';
    if(fileIssue){candidate.eligible=false;candidate.reasons.unshift(fileIssue);}
    candidate.source_asset_id=row.source_asset_id || null;
    candidate.original_hash=originalHash || null;
    candidate.binding_ids=bindings.map(b=>b.id);
    candidate.old_media_id=row.wordpress_media_id || null;
    candidate.master_dimensions={width:rotated?info.height:info.width,height:rotated?info.width:info.height};
    candidate.master_preview_url=(/^\/media\/[A-Za-z0-9_-]+\.(png|jpe?g|webp)$/.test(row.media_url || '') || (manualPhoto && /^\/api\/drafts\/[^/]+\/article-media\/uploads\/[a-f0-9-]+\/preview$/.test(row.media_url || '')))?row.media_url:null;
    candidate.alt=String(row.alt_text || '');
    if(retainedOriginal && metadata.cover_inventory_selection?.source_asset_id===source?.id)candidate.master_preview_url=`/api/source-assets/${encodeURIComponent(source.id)}/preview`;
    candidates.push(candidate);
  }
  const current=db.prepare('SELECT id,revision,content_hash,body_markdown,title,slug,status,brief_id FROM article_drafts WHERE id=?').get(draftId);
  const currentRows=db.prepare('SELECT * FROM article_visuals WHERE draft_id=? ORDER BY slot,id').all(draftId);
  const currentPublication=db.prepare('SELECT post_id,status FROM wordpress_publications WHERE draft_id=?').get(draftId);
  for(const [id,identity] of sourceIdentities) {
    const source=sourceQuery.get(id),bindings=source?readMediaBindings(db,id):[];
    if(coverAuditFingerprint({source,bindings})!==identity)
      throw error('COVER_SOURCE_CONFLICT','Source analysis or binding changed during the audit.');
  }
  if(inputIdentity!==coverAuditFingerprint({draft:current,rows:currentRows,publication:currentPublication}))
    throw error('COVER_REVISION_CONFLICT','Draft or media changed while auditing; rerun the read-only plan.');
  const selected=locks.length>1?{status:'needs_review',reason:'COVER_MULTIPLE_LOCKS',selected:null}:selectCoverCandidate(candidates);
  return {dry_run:true,policy_version:COVER_POLICY_VERSION,draft_id:draft.id,revision:draft.revision,
    post_id:publication?.post_id || null,body_hash:mediaHash(draft.body_markdown),input_fingerprint:inputIdentity,
    selection:selected,candidates,pagination:{offset,limit,total:rows.length,next_offset:offset+limit<rows.length?offset+limit:null},execution_enabled:false,contract:readCoverContract(db),
    external_dependencies:['EXT-PURPOSE','EXT-REFRESH','EXT-CARD'],
    next_local_steps:selected.selected?['confirm_cover_geometry','render_separate_cover','verify_contract_and_receiver']:['review_candidate_reasons'],
    paid_steps:[],paid_steps_status:'not_planned_no_automatic_ai_fallback',
    rollback:{post_id:publication?.post_id || null,revision:draft.revision,
      media_ids:rows.map(row=>row.wordpress_media_id).filter(Boolean),action:'retain_existing_article_and_media'},
    database_version:db.prepare('PRAGMA data_version').get().data_version,
    database_changes:db.prepare('SELECT total_changes() n').get().n,
    effects:{database_writes:0,remote_requests:0,model_calls:0,uploads:0}};
}
