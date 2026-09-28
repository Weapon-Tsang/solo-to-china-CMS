import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {mediaHash} from '../web-media.mjs';
import {readCoverSelection} from './cover-selection.mjs';
import {readCoverContract} from '../cover-contract.mjs';
const fail=(code,message)=>Object.assign(new Error(message),{code,statusCode:409,retryable:false});
const hash=value=>mediaHash(JSON.stringify(value));
const parse=value=>JSON.parse(value || '{}');
export function coverDeliveryPlan(db,draftId) {
  const draft=db.prepare('SELECT id,revision,title,slug,body_markdown,content_hash FROM article_drafts WHERE id=?').get(draftId);
  if(!draft)throw fail('DRAFT_NOT_FOUND','Draft does not exist.');
  const selection=readCoverSelection(db,draftId),contract=readCoverContract(db);
  const publication=db.prepare('SELECT * FROM wordpress_publications WHERE draft_id=?').get(draftId);
  const prior=parse(publication?.response_json);
  return {draft_id:draftId,draft_revision:draft.revision,selection_id:selection?.id || null,
    parent_hash:selection?.derivative?.parent_hash || null,upload_hash:selection?.derivative?.sha256 || null,
    contract_hash:contract.artifact_sha256 || null,contract_commit:contract.frontend_commit_sha || null,
    post_id:publication?.post_id || null,site_url:publication?.site_url || null,prior_featured_media_id:prior.featured_media_id ?? null,
    prior_page_hash:prior.page_payload_hash || null,prior_modified_gmt:prior.modified_gmt || null,
    protected_content_hash:hash(draft),scope:'cover_only',body_change:false,
    fields:['featuredMediaId'],status:selection&&contract.fields.featuredMediaId?'RECEIVER_VERIFICATION_REQUIRED':'COVER_NOT_READY',
    blockers:selection?['EXT-PURPOSE','EXT-REFRESH']:['REQUIRED_COVER_MISSING']};
}
/** Explicit receiver interface. The app currently has no verified implementation, so this is not auto-dispatched.
 * A receiver must perform CAS and provide a read-only idempotency reconciliation operation.
 * An upload or write of unknown outcome is NEVER repeated by this state machine.
 */
export async function deliverSelectedCover(db,draftId,{receiver,authorization,expectedPlanHash}) {
  const plan=coverDeliveryPlan(db,draftId),selection=readCoverSelection(db,draftId);
  if(authorization?.mode!=='release' || authorization.scope!=='cover_only')throw fail('COVER_DELIVERY_NOT_AUTHORIZED','Explicit external cover delivery authorization is required.');
  if(hash(plan)!==expectedPlanHash)throw fail('COVER_DELIVERY_PLAN_STALE','Cover delivery plan changed.');
  const capability=await receiver?.verifiedCapabilities?.();
  if(!capability?.cover_only || !capability.compare_and_swap || !capability.idempotency_reconciliation
    || capability.contract_hash!==plan.contract_hash || capability.contract_commit!==plan.contract_commit || capability.site_url!==plan.site_url)
    throw fail('COVER_RECEIVER_CAPABILITY_UNVERIFIED','Receiver has not verified this exact contract and cover-only scope.');
  if(plan.status==='COVER_NOT_READY'||!plan.post_id||!plan.prior_page_hash||!plan.prior_modified_gmt)throw fail('COVER_BASELINE_RECEIPT_REQUIRED','An exact existing target receipt is required.');
  const bytes=fs.readFileSync(selection.derivative.localPath);
  if(mediaHash(bytes)!==plan.upload_hash)throw fail('COVER_BYTES_CHANGED','Saved derivative differs from its receipt.');
  if(hash(coverDeliveryPlan(db,draftId))!==expectedPlanHash)throw fail('COVER_DELIVERY_PLAN_STALE','Cover changed while checking receiver capabilities.');
  let attempt=db.prepare('SELECT * FROM cover_delivery_attempts WHERE draft_id=? AND selection_id=?').get(draftId,selection.id);
  if(attempt?.state==='confirmed')return {state:'confirmed',attempt_id:attempt.id,receipt:parse(attempt.receipt_json),prior_receipts_retained:true};
  if(attempt && ['dispatch_started','outcome_unknown','needs_review'].includes(attempt.state)) {
    const reconciled=await receiver.reconcile({idempotency_key:attempt.id,request:parse(attempt.request_json)});
    if(!reconciled)return {state:'needs_review',attempt_id:attempt.id,reason:'Remote outcome remains unknown; no duplicate upload or write.'};
    return saveReceipt(db,attempt,reconciled);
  }
  if(!attempt){const id=randomUUID();db.prepare("INSERT INTO cover_delivery_attempts(id,draft_id,selection_id,state,request_json,created_at) VALUES (?,?,?,'dispatch_started',?,datetime('now'))")
    .run(id,draftId,selection.id,JSON.stringify(plan));attempt=db.prepare('SELECT * FROM cover_delivery_attempts WHERE id=?').get(id);}
  try {
    const remote=await receiver.replaceCover({idempotency_key:attempt.id,plan,bytes,
      content_type:selection.derivative.mime || `image/${selection.derivative.format}`,caption:'',alt:db.prepare('SELECT alt_text FROM article_visuals WHERE id=?').get(selection.visual_id)?.alt_text || ''});
    return saveReceipt(db,attempt,remote);
  }catch(error){db.prepare("UPDATE cover_delivery_attempts SET state='outcome_unknown',receipt_json=? WHERE id=?")
    .run(JSON.stringify({code:error.code || 'COVER_OUTCOME_UNKNOWN',message:String(error.message),retain_prior:true}),attempt.id);
    throw fail('COVER_OUTCOME_UNKNOWN','Cover outcome must be reconciled before another operation. Existing article receipts remain intact.');}
}
function saveReceipt(db,attempt,receipt) {
  const plan=parse(attempt.request_json);
  const valid=receipt.post_id===plan.post_id && receipt.cms_draft_id===plan.draft_id && receipt.cms_revision===plan.draft_revision
    && receipt.prior_page_hash===plan.prior_page_hash && receipt.protected_content_hash===plan.protected_content_hash
    && receipt.upload_hash===plan.upload_hash && Number.isInteger(receipt.attachment_id) && receipt.attachment_id>0
    && receipt.featured_media_id===receipt.attachment_id && /^[a-f0-9]{64}$/.test(receipt.page_payload_hash || '')
    && typeof receipt.modified_gmt==='string' && receipt.idempotency_key===attempt.id;
  const current=readCoverSelection(db,plan.draft_id);
  const currentPlan=coverDeliveryPlan(db,plan.draft_id);
  const state=valid&&current?.id===attempt.selection_id&&currentPlan.protected_content_hash===plan.protected_content_hash
    && currentPlan.prior_page_hash===plan.prior_page_hash?'confirmed':'needs_review';
  db.prepare('UPDATE cover_delivery_attempts SET state=?,receipt_json=? WHERE id=?').run(state,JSON.stringify(receipt),attempt.id);
  return {state,attempt_id:attempt.id,receipt,prior_receipts_retained:true};
}
export const coverDeliveryPlanHash=hash;
