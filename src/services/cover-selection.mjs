import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseMediaMetadata} from '../media-delivery.mjs';
import {mediaHash} from '../web-media.mjs';
import {renderCoverMedia} from '../cover-media.mjs';
import {auditDraftCover} from './cover-audit.mjs';
import {COVER_POLICY_VERSION} from '../cover-policy.mjs';

const failure=(code,message)=>Object.assign(new Error(message),{code,statusCode:409,retryable:false});
const rowsFor=(db,id)=>db.prepare('SELECT * FROM article_visuals WHERE draft_id=? ORDER BY slot,id').all(id);
const masterBytes=row=>{
  try {return fs.readFileSync(row.media_path);}
  catch {throw failure('COVER_MASTER_CHANGED','Master is no longer available; refresh the cover audit.');}
};

export function readCoverSelection(db,draftId) {
  const rows=rowsFor(db,draftId),active=[];
  for(const row of rows) {
    const metadata=parseMediaMetadata(row.media_metadata_json);
    if(!metadata.cover_active_id)continue;
    const record=metadata.cover_selections?.find(item=>item.id===metadata.cover_active_id);
    if(!record)throw failure('COVER_SELECTION_INVALID','Active cover history record is missing.');
    active.push({...record,visual_id:row.id,locked:metadata.cover_locked===true});
  }
  if(active.length>1)throw failure('COVER_MULTIPLE_SELECTIONS','More than one cover is active.');
  if(!active[0])return null;
  const delivery=db.prepare('SELECT state FROM cover_delivery_attempts WHERE draft_id=? AND selection_id=?').get(draftId,active[0].id);
  return {...active[0],delivery_state:delivery?.state || 'local_only'};
}

export async function previewCoverSelection(db,draftId,input,{outputDir,quality=82}={}) {
  if(!input || !Number.isInteger(input.expected_revision) || !input.visual_id
    || !/^[a-f0-9]{64}$/.test(input.master_hash || '') || !input.expected_fingerprint)
    throw failure('COVER_INPUT_INVALID','Current revision, audit fingerprint, visual and master hash are required.');
  const geometry={master_hash:input.master_hash,safeRegion:input.safe_region,focalPoint:input.focal_point,
    qualityConfirmed:input.quality_confirmed===true};
  const report=await auditDraftCover(db,draftId,{expectedRevision:input.expected_revision,geometryByVisual:{[input.visual_id]:geometry}});
  if(report.input_fingerprint!==input.expected_fingerprint)throw failure('COVER_REVISION_CONFLICT','The reviewed media plan changed.');
  const candidate=report.candidates.find(c=>c.id===input.visual_id);
  if(!candidate?.eligible)throw Object.assign(failure('COVER_CANDIDATE_REJECTED','Candidate is not safe for cover use.'),{details:candidate?.reasons || []});
  const current=readCoverSelection(db,draftId);
  if(current?.locked && current.visual_id!==input.visual_id && input.replace_locked_id!==current.id)
    throw failure('COVER_LOCKED','Explicitly identify the locked selection before replacing it.');
  const row=rowsFor(db,draftId).find(r=>r.id===input.visual_id);
  const derivative=await renderCoverMedia({bytes:masterBytes(row),candidate,outputDir,quality,
    originalHash:candidate.original_hash || null});
  const after=await auditDraftCover(db,draftId,{expectedRevision:input.expected_revision,geometryByVisual:{[input.visual_id]:geometry}});
  if(after.input_fingerprint!==report.input_fingerprint || !after.candidates.find(c=>c.id===input.visual_id)?.eligible
    || mediaHash(masterBytes(row))!==derivative.parent_hash)
    throw failure('COVER_REVISION_CONFLICT','Media changed during cover rendering; the plan must be reviewed again.');
  return {draft_id:draftId,visual_id:row.id,revision:input.expected_revision,input_fingerprint:report.input_fingerprint,
    geometry,derivative,preview_url:`/media/cover-derivatives/${path.basename(derivative.localPath)}`,
    database_version:after.database_version,database_changes:after.database_changes,
    prior_selection_id:current?.id || null,delivery_status:'waiting_receiver_capability',policy_version:COVER_POLICY_VERSION};
}

export async function saveCoverSelection(db,draftId,input,options={}) {
  if(input?.confirmed!==true || !input?.preview_hash)
    throw failure('COVER_PREVIEW_CONFIRMATION_REQUIRED','Inspect the exact rendered cover before confirming it.');
  const preview=await previewCoverSelection(db,draftId,input,options);
  if(input.preview_hash!==preview.derivative.sha256)throw failure('COVER_PREVIEW_STALE','The confirmed cover differs from the current render.');
  db.exec('BEGIN IMMEDIATE');
  try {
    if(db.prepare('PRAGMA data_version').get().data_version!==preview.database_version
      || db.prepare('SELECT total_changes() n').get().n!==preview.database_changes)
      throw failure('COVER_REVISION_CONFLICT','Database changed before saving; review the plan again.');
    const draft=db.prepare('SELECT revision FROM article_drafts WHERE id=?').get(draftId);
    const active=readCoverSelection(db,draftId);
    if(draft?.revision!==preview.revision || (active?.id || null)!==(input.expected_selection_id || null))
      throw failure('COVER_REVISION_CONFLICT','Cover selection changed; reload before confirming.');
    const rows=rowsFor(db,draftId),selected=rows.find(r=>r.id===preview.visual_id);
    if(!selected || mediaHash(masterBytes(selected))!==preview.derivative.parent_hash)
      throw failure('COVER_MASTER_CHANGED','Master changed before saving the selection.');
    if(active?.derivative?.sha256===preview.derivative.sha256 && active.visual_id===preview.visual_id
      && active.locked===(input.locked===true)){db.exec('COMMIT');return active;}
    const record={...preview,id:randomUUID(),kind:selected.image_type==='illustration'?'illustration':'photo',purpose:'cover',locked:input.locked===true,
      source_asset_id:selected.source_asset_id || null,actor:String(options.actor || 'administrator'),created_at:new Date().toISOString()};
    for(const row of rows) {
      const metadata=parseMediaMetadata(row.media_metadata_json);
      if(row.id===selected.id) {
        metadata.cover_geometry=preview.geometry;
        metadata.cover_selections=[...(metadata.cover_selections || []),record];
        metadata.cover_active_id=record.id;metadata.cover_locked=record.locked;
      } else if(metadata.cover_active_id){metadata.cover_active_id=null;metadata.cover_locked=false;}
      else continue;
      db.prepare('UPDATE article_visuals SET media_metadata_json=? WHERE id=?').run(JSON.stringify(metadata),row.id);
    }
    db.exec('COMMIT');return record;
  } catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
}

export function coverDeliveryBlocker(db,draftId) {
  const selection=readCoverSelection(db,draftId);
  if(!selection){
    const required=db.prepare("SELECT id FROM article_visuals WHERE draft_id=? AND json_extract(media_metadata_json,'$.media_purpose')='cover' LIMIT 1").get(draftId);
    return required?{code:'REQUIRED_COVER_MISSING',visual_id:required.id,message:'An independent cover was requested; confirm its geometry and selection before new delivery.'}:null;
  }
  // No deployed capability is inferred from a schema or from an admin selection.
  return {code:'COVER_RECEIVER_CAPABILITY_UNVERIFIED',selection_id:selection.id,
    dependencies:['EXT-PURPOSE','EXT-REFRESH'],message:'Selected cover is saved locally; receiver capability and receipt reconciliation are required before delivery.'};
}
