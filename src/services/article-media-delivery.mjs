import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {transaction} from '../db.mjs';
import {mediaHash,prepareWebMedia} from '../web-media.mjs';
import {readCoverContract} from '../cover-contract.mjs';
import {evaluatePublicationEligibility} from '../publication-eligibility.mjs';
import {publicMediaUrl} from '../media-delivery.mjs';
const parse=value=>JSON.parse(value || '{}');
const digest=value=>mediaHash(JSON.stringify(value));
const fail=(code,message)=>Object.assign(new Error(message),{code,retryable:false,statusCode:409});
export function articleMediaDeliveryPlan(db,draftId) {
  const draft=db.prepare('SELECT id,revision,body_markdown,title,slug,content_hash FROM article_drafts WHERE id=?').get(draftId);
  if(!draft)throw fail('DRAFT_NOT_FOUND','Draft not found.');
  const revision=db.prepare('SELECT * FROM article_media_revisions WHERE draft_id=? AND draft_revision=? ORDER BY media_revision DESC LIMIT 1').get(draftId,draft.revision);
  if(!revision)throw fail('MEDIA_REVISION_REQUIRED','No confirmed manual media revision exists.');
  const receipt=parse(revision.receipt_json),publication=db.prepare('SELECT * FROM wordpress_publications WHERE draft_id=?').get(draftId),remote=parse(publication?.response_json);
  const contract=readCoverContract(db),eligibility=evaluatePublicationEligibility(db,draftId);
  const selected=receipt.plan?.selections.filter(s=>s.purpose==='body') || [];
  const rows=selected.map(s=>db.prepare('SELECT id,asset_fingerprint,media_metadata_json FROM article_visuals WHERE id=?').get(s.slot_id));
  const plan={draft_id:draftId,draft_revision:draft.revision,media_revision:revision.media_revision,revision_id:revision.id,
    protected_content_hash:digest(draft),post_id:publication?.post_id || null,site_url:publication?.site_url || null,
    prior_page_hash:remote.page_payload_hash || null,prior_modified_gmt:remote.modified_gmt || null,
    published:remote.status==='publish',contract_hash:contract.artifact_sha256 || null,contract_commit:contract.frontend_commit_sha || null,
    slots:selected.map(s=>({slot_id:s.slot_id,caption:s.caption,anchor:s.anchor,source_asset_id:s.asset_id})),
    media_fingerprint:digest(rows),scope:'body_media_only',body_change:false,
    ready:eligibility.passed && revision.state==='local_ready' && selected.length>0,missing:eligibility.missing,
    capacity:200,selected_count:JSON.parse(revision.manifest_json).slots.length,external_dependency:'EXT-BODY-MEDIA-REFRESH'};
  return {...plan,plan_hash:digest(plan)};
}
/** Disabled by default: the current WordPress receiver has no verified media-only CAS adapter.
 * A future verified receiver consumes one file stream at a time, with durable idempotency reconciliation.
 */
export async function deliverArticleMedia(db,draftId,{receiver,authorization,expectedPlanHash,outputDir}) {
  const plan=articleMediaDeliveryPlan(db,draftId);
  if(authorization?.scope!=='body_media_only'||authorization.mode!=='release')throw fail('MEDIA_DELIVERY_NOT_AUTHORIZED','Media delivery requires explicit external authorization.');
  const saved=parse(db.prepare('SELECT receipt_json FROM article_media_revisions WHERE id=?').get(plan.revision_id).receipt_json).delivery_attempt;
  if(saved?.state==='confirmed'&&saved.plan.plan_hash===expectedPlanHash)return {state:'confirmed',receipt:saved.receipt};
  if(plan.plan_hash!==expectedPlanHash)throw fail('MEDIA_DELIVERY_PLAN_STALE','Media plan changed.');
  const capability=await receiver?.verifiedCapabilities?.();
  if(!/^[a-f0-9]{64}$/.test(plan.contract_hash || '')||!/^[a-f0-9]{40}$/.test(plan.contract_commit || '')
    || !capability?.body_media_only || !capability.compare_and_swap || !capability.idempotency_reconciliation
    || capability.site_url!==plan.site_url || capability.contract_hash!==plan.contract_hash || capability.contract_commit!==plan.contract_commit
    || (plan.published && (!capability.published_media_refresh || authorization.published_post_id!==plan.post_id)))
    throw fail('MEDIA_RECEIVER_CAPABILITY_UNVERIFIED','Receiver cannot safely perform this exact media-only refresh.');
  if(!plan.ready || plan.selected_count>plan.capacity || !plan.post_id || !plan.prior_page_hash || !plan.prior_modified_gmt)
    throw fail('MEDIA_DELIVERY_BASELINE_REQUIRED','Required media, capacity or target receipt is incomplete.');
  let row=db.prepare('SELECT * FROM article_media_revisions WHERE id=?').get(plan.revision_id),receipt=parse(row.receipt_json),attempt=receipt.delivery_attempt;
  if(attempt){
    if(attempt.state==='confirmed')return {state:'confirmed',receipt:attempt.receipt};
    const result=await receiver.reconcile({idempotency_key:attempt.id,plan:attempt.plan});
    return result?finish(db,plan,attempt,result):{state:'needs_review',reason:'Outcome unknown; no upload repeated.'};
  }
  const assets=[];
  for(const slot of plan.slots){const visual=db.prepare('SELECT * FROM article_visuals WHERE id=?').get(slot.slot_id),metadata=parse(visual.media_metadata_json);
    const manual=metadata.manual_local_receipt?.derivative;
    let derivative=manual;
    if(!derivative){const source=db.prepare('SELECT original_sha256,mime_type FROM source_assets WHERE id=?').get(visual.source_asset_id);
      if(fs.statSync(visual.media_path).size>128*1024*1024)throw fail('MEDIA_PROCESSING_RESOURCE_LIMIT','Mother exceeds local transform memory protection.');
      const bytes=fs.readFileSync(visual.media_path),format=visual.media_path.split('.').at(-1).toLowerCase();
      derivative=(await prepareWebMedia({bytes,contentType:format==='jpg'||format==='jpeg'?'image/jpeg':`image/${format}`,outputDir,kind:'text',purpose:'body',
        qa:metadata.quality_qa,originalHash:source.original_sha256})).receipt;
    }
    if(mediaHash(fs.readFileSync(derivative.localPath))!==derivative.sha256)throw fail('MEDIA_DERIVATIVE_CHANGED','Derivative receipt differs from bytes.');
    assets.push({...slot,derivative});
  }
  if(articleMediaDeliveryPlan(db,draftId).plan_hash!==expectedPlanHash)throw fail('MEDIA_DELIVERY_PLAN_STALE','Media changed while preparing uploads.');
  attempt={id:randomUUID(),state:'dispatch_started',plan,assets,prior_publication:db.prepare('SELECT * FROM wordpress_publications WHERE draft_id=?').get(draftId)};
  db.prepare('UPDATE article_media_revisions SET receipt_json=? WHERE id=?').run(JSON.stringify({...receipt,delivery_attempt:attempt}),row.id);
  async function* streams(){for(const asset of assets)yield {...asset,stream:fs.createReadStream(asset.derivative.localPath,{highWaterMark:256*1024})};}
  try {return finish(db,plan,attempt,await receiver.refreshMedia({idempotency_key:attempt.id,plan,assets:streams()}));}
  catch(error){receipt=parse(db.prepare('SELECT receipt_json FROM article_media_revisions WHERE id=?').get(row.id).receipt_json);
    db.prepare('UPDATE article_media_revisions SET receipt_json=? WHERE id=?').run(JSON.stringify({...receipt,delivery_attempt:{...attempt,state:'outcome_unknown',error:String(error.message)}}),row.id);
    throw fail('MEDIA_DELIVERY_OUTCOME_UNKNOWN','Reconcile the existing attempt before any new upload or refresh.');}
}
function finish(db,plan,attempt,result){
  const media=result.media || [],ids=new Set(media.map(item=>item.slot_id));
  const valid=result.idempotency_key===attempt.id && result.post_id===plan.post_id && result.cms_draft_id===plan.draft_id
    && result.cms_revision===plan.draft_revision && result.prior_page_hash===plan.prior_page_hash && result.protected_content_hash===plan.protected_content_hash
    && /^[a-f0-9]{64}$/.test(result.page_payload_hash || '') && typeof result.modified_gmt==='string'
    && media.length===attempt.assets.length && ids.size===media.length && attempt.assets.every(asset=>{
      const item=media.find(item=>item.slot_id===asset.slot_id);return item&&Number.isInteger(item.media_id)&&item.media_id>0
        && item.upload_hash===asset.derivative.sha256&&publicMediaUrl(item.url)
        && Number.isInteger(item.width)&&item.width>0&&Number.isInteger(item.height)&&item.height>0
        && /^image\/(png|jpeg|webp|avif)$/.test(item.mime || '');
    }) && articleMediaDeliveryPlan(db,plan.draft_id).plan_hash===plan.plan_hash;
  const state=valid?'confirmed':'needs_review';
  transaction(db,()=>{
    const receipt=parse(db.prepare('SELECT receipt_json FROM article_media_revisions WHERE id=?').get(plan.revision_id).receipt_json);
    if(valid)for(const asset of attempt.assets){const delivered=media.find(item=>item.slot_id===asset.slot_id),row=db.prepare('SELECT media_metadata_json FROM article_visuals WHERE id=?').get(asset.slot_id);
      db.prepare('UPDATE article_visuals SET wordpress_media_id=?,wordpress_media_url=?,media_metadata_json=? WHERE id=?')
        .run(delivered.media_id,delivered.url,JSON.stringify({...parse(row.media_metadata_json),manual_delivery_receipt:delivered,web_derivative:asset.derivative,
          master_hash:asset.derivative.parent_hash,upload_bytes_hash:asset.derivative.sha256,sha256:asset.derivative.sha256,
          wordpress_uploaded:true,wordpress_media_id:delivered.media_id,url:delivered.url,width:delivered.width,height:delivered.height,
          mime:delivered.mime,bytes:asset.derivative.bytes,derivatives:delivered.derivatives || [],reusable:true,served_asset_hash:null}),asset.slot_id);}
    db.prepare('UPDATE article_media_revisions SET receipt_json=? WHERE id=?').run(JSON.stringify({...receipt,delivery:state,
      delivery_attempt:{...attempt,state,receipt:result}}),plan.revision_id);
  });
  return {state,receipt:result,body_changed:false,old_receipts_retained:true};
}
