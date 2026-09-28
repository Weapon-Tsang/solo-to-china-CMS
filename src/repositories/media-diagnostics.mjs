import fs from 'node:fs/promises';
import sharp from 'sharp';
import { inspectMediaFile } from '../media-storage.mjs';
import { refreshSourceMediaBindings, bindingSupportsPhoto } from './media-bindings.mjs';

export function documentMediaCapability(asset) {
  if(asset.mime_type!=='application/pdf') return null;
  const provenance=asset.provenance || JSON.parse(asset.provenance_json || '{}');
  return {status:'unsupported_independent_extraction',reason:'PDF_ASSET_NOT_MATERIALIZED',
    parent_sha256:asset.original_sha256 || asset.stored_sha256 || null,
    locator:Object.fromEntries(['pdfPages','pageStart','pageEnd','objectId','region'].filter(k=>provenance[k]!==undefined).map(k=>[k,provenance[k]])),
    inventory:'Existing parser retains visual page presence; no reliable embedded-image/object inventory.',
    asset_role:'document_visual_evidence',publishable_as_photo:false,
    fallback:{owner:'A1',implemented:true,scope:'source_supplement_only',article_adoption_implemented:false,
      endpoint:`/api/source-assets/${encodeURIComponent(asset.id)}/pdf-supplements`,
      action:'Upload an independent image and confirm its source relationship. Article adoption remains D-owned.',
      source_asset_id:asset.id,source_id:asset.source_id,capture_version:asset.capture_version}};
}

/** Explicit detail inspection only. No menu scan, writes, model or job creation. */
export async function diagnoseMediaAsset(db, assetId) {
  const asset=db.prepare(`SELECT sa.*,s.capture_version AS current_capture_version,saa.asset_kind
    FROM source_assets sa JOIN sources s ON s.id=sa.source_id
    LEFT JOIN source_asset_analyses saa ON saa.asset_id=sa.id WHERE sa.id=?`).get(assetId);
  if(!asset) throw Object.assign(new Error('Source asset not found.'),{statusCode:404,code:'ASSET_NOT_FOUND'});
  const reasons=[];
  let bytes={status:'not_checked',scope:'one_asset',max_bytes:32*1024*1024};
  const capability=documentMediaCapability(asset);
  if(capability) reasons.push(capability.reason);
  if(!asset.local_path) { reasons.push('ORIGINAL_MISSING');bytes.status='no_local_reference'; }
  else if(!capability) {
    try {
      const stat=await fs.stat(asset.local_path);
      if(stat.size>bytes.max_bytes) bytes.status='budget_exhausted';
      else {
        const receipt=await inspectMediaFile(asset.local_path,{kind:'image',mimeType:asset.mime_type,
          sha256:asset.original_sha256 || asset.stored_sha256 || undefined,maxBytes:bytes.max_bytes});
        const metadata=await sharp(asset.local_path,{limitInputPixels:40_000_000}).metadata();
        bytes={...bytes,status:'verified',...receipt,width:metadata.width,height:metadata.height,
          validation:'hash_signature_and_decoder_metadata'};
      }
    } catch(error) {
      bytes.status=['ENOENT','ENOTDIR'].includes(error.code) ? 'missing' : ['EACCES','EPERM'].includes(error.code) ? 'access_denied' : 'invalid';
      reasons.push(bytes.status==='missing' ? 'ORIGINAL_MISSING' : bytes.status==='invalid' ? 'BYTES_INVALID' : 'BYTES_NOT_CHECKED');
    }
  }
  const current=asset.capture_version===asset.current_capture_version;
  const plan=current && !capability ? refreshSourceMediaBindings(db,asset.source_id,{assetIds:[assetId]}).assets[0] : null;
  if(!current) reasons.push('CONTEXT_STALE');
  if(plan) reasons.push(plan.reason);
  const slots=db.prepare(`SELECT av.id AS slot_id,av.draft_id,av.slot,av.purpose,av.image_subject,av.media_metadata_json
    FROM article_visuals av WHERE av.source_asset_id=? ORDER BY av.draft_id,av.slot,av.id LIMIT 101`).all(assetId);
  const slotDiagnostics=slots.slice(0,100).map(slot=>{
    const metadata=JSON.parse(slot.media_metadata_json || '{}');
    const bound=plan?.bindings.find(row=>(metadata.authorized_asset_match?.source_binding_ids || []).includes(row.id));
    const request={purpose:slot.purpose,image_subject:slot.image_subject,media_metadata:metadata,
      ...(bound ? {entity_key:bound.entity_key,destination_slug:bound.destination_slug} : {}),...metadata.media_request};
    const tooSpecific=/\b(?:entrance|boarding|pier|vessel|platform|gate|viewpoint)\b|入口|码头|登船|机位/iu.test(slot.purpose);
    const matched=plan && bindingSupportsPhoto({...asset,source_bindings:plan.bindings},request);
    const failures=[...reasons.filter(reason=>!['SOURCE_BINDING_SUPPORTED'].includes(reason)),
      ...(!matched ? [tooSpecific ? 'SLOT_TOO_SPECIFIC' : 'MATCH_REJECTED'] : [])];
    return {slot_id:slot.slot_id,draft_id:slot.draft_id,slot:slot.slot,reason_codes:[...new Set(failures)]};
  });
  const frozen=db.prepare(`SELECT wp.id AS packet_id,wp.brief_id,wp.input_hash,
      json_extract(selected.value,'$.capture_version') AS capture_version,
      json_extract(selected.value,'$.original_sha256') AS original_sha256
    FROM writing_packets wp JOIN json_each(wp.context_json,'$.authorized_source_assets') selected
    WHERE COALESCE(json_extract(selected.value,'$.id'),json_extract(selected.value,'$.source_asset_id'))=?
    ORDER BY wp.id LIMIT 101`).all(assetId);
  const counts={};for(const reason of new Set(reasons)) counts[reason]=(counts[reason] || 0)+1;
  const slotCounts={};for(const slot of slotDiagnostics) for(const reason of slot.reason_codes) slotCounts[reason]=(slotCounts[reason] || 0)+1;
  return {asset_id:assetId,source_id:asset.source_id,capture_version:asset.capture_version,
    bytes,document_capability:capability,occurrence_id:plan?.occurrence_id || null,
    reason_counts:counts,slot_reason_counts:slotCounts,slots:slotDiagnostics,
    units:{reason_counts:'unique assets per reason; reasons overlap',slot_reason_counts:'slots per reason; reasons overlap'},
    frozen_references:frozen.slice(0,100),frozen_references_has_more:frozen.length>100,
    scope:'one_asset_and_direct_referencing_slots',has_more:slots.length>100,
    unchecked_scope:['unreferenced article slots','other entity media','full pixel decode'],
    model_calls:0,writes:0};
}
