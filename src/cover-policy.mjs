import { mediaHash } from './web-media.mjs';
import {visualQaMentionsSpellingError} from './visual-qa.mjs';

export const COVER_POLICY_VERSION='cover-1';
const rect=r=>r && ['x','y','width','height'].every(k=>Number.isFinite(r[k]))
  && r.x>=0 && r.y>=0 && r.width>0 && r.height>0 && r.x+r.width<=1 && r.y+r.height<=1;

// Coordinates are in the EXIF-normalized image. Never invent a subject/focal point.
export function planCoverCrop({width,height,safeRegion,focalPoint,qualityConfirmed=false}) {
  if(!Number.isInteger(width) || !Number.isInteger(height) || width<16 || height<9)
    return {status:'needs_review',reason:'COVER_DIMENSIONS_INVALID'};
  if(!rect(safeRegion) || !focalPoint || !Number.isFinite(focalPoint.x) || !Number.isFinite(focalPoint.y)
    || focalPoint.x<0 || focalPoint.x>1 || focalPoint.y<0 || focalPoint.y>1)
    return {status:'needs_review',reason:'COVER_SUBJECT_CONFIRMATION_REQUIRED'};
  const unit=Math.floor(Math.min(width/16,height/9));
  const cropWidth=unit*16,cropHeight=unit*9;
  const left=Math.max(0,Math.min(width-cropWidth,Math.round(focalPoint.x*width-cropWidth/2)));
  const top=Math.max(0,Math.min(height-cropHeight,Math.round(focalPoint.y*height-cropHeight/2)));
  if(left>safeRegion.x*width || top>safeRegion.y*height
    || left+cropWidth<(safeRegion.x+safeRegion.width)*width
    || top+cropHeight<(safeRegion.y+safeRegion.height)*height)
    return {status:'needs_review',reason:'COVER_SUBJECT_WOULD_BE_CROPPED'};
  const outputUnit=Math.min(75,unit); // exact 16:9, <=1200x675, no upscale
  return {status:cropWidth<768 && !qualityConfirmed?'needs_review':'planned',
    reason:cropWidth<768 && !qualityConfirmed?'COVER_SMALL_IMAGE_CONFIRMATION_REQUIRED':null,
    crop:{left,top,width:cropWidth,height:cropHeight},width:outputUnit*16,height:outputUnit*9,
    warning:cropWidth<1200?'COVER_BELOW_TARGET_RESOLUTION':null,
    policy_version:COVER_POLICY_VERSION};
}

export function evaluateCoverCandidate({id,analysis={},relationshipVerified=false,qa={},masterHash,
  width,height,geometry={},locked=false,origin='article'}) {
  const reasons=[];
  if(analysis.analysis_status!=='ready') reasons.push('COVER_ANALYSIS_REQUIRED');
  const illustration=analysis.asset_kind==='editorial_illustration' && analysis.non_factual===true && analysis.abstract_topic_approved===true;
  if(analysis.asset_kind!=='documentary_photo' && !illustration) reasons.push('COVER_NON_PHOTO_REQUIRES_SEPARATE_REVIEW');
  if(['handwritten_card','editorial_infographic','map_or_route','photo_collage'].includes(analysis.asset_kind))
    reasons.push('COVER_TEXT_OR_COLLAGE_DOMINANT');
  if(analysis.editor_ui_regions?.length || analysis.text_regions?.some(r=>r.role==='ui_text'))
    reasons.push('COVER_INTERFACE_SCREENSHOT');
  // Natural signs are permitted; uncertain overlays need editorial confirmation.
  if(analysis.text_regions?.some(r=>r.role!=='real_world_signage')) reasons.push('COVER_OVERLAY_REVIEW_REQUIRED');
  if(!relationshipVerified)reasons.push('COVER_ENTITY_RELATION_UNCONFIRMED');
  const qaPassed=qa !== null && typeof qa === 'object' && !Array.isArray(qa)
    && !visualQaMentionsSpellingError(qa) && (qa.status==='passed'
    || ['language','completeness','style','semantic'].every(key=>qa[key]?.status==='passed'));
  if(!masterHash || !qaPassed || qa?.file_hash!==masterHash) reasons.push('COVER_MASTER_QA_REQUIRED');
  const crop=planCoverCrop({...geometry,width,height});
  if(crop.status!=='planned')reasons.push(crop.reason);
  return {id,locked,origin,master_hash:masterHash || null,eligible:reasons.length===0,reasons,crop,
    policy_version:COVER_POLICY_VERSION};
}

export function selectCoverCandidate(candidates) {
  const locks=candidates.filter(c=>c.locked);
  if(locks.length>1)return {status:'needs_review',reason:'COVER_MULTIPLE_LOCKS',selected:null};
  if(locks.length)return locks[0].eligible?{status:'planned',selected:locks[0].id}
    :{status:'needs_review',reason:'COVER_LOCK_REQUIRES_ATTENTION',selected:null};
  const ordered=candidates.filter(c=>c.eligible).sort((a,b)=>
    ({article:0,stored:1,illustration:2}[a.origin]??1)-({article:0,stored:1,illustration:2}[b.origin]??1) || a.id.localeCompare(b.id));
  return ordered.length?{status:'planned',selected:ordered[0].id}
    :{status:'needs_review',reason:'COVER_NO_QUALIFIED_CANDIDATE',selected:null};
}

export function coverAuditFingerprint(value) {return mediaHash(JSON.stringify(value));}
