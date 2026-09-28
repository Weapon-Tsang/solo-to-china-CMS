import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { sha256, now } from '../utils.mjs';
import { transaction } from '../db.mjs';
import { safeMediaPath, inspectMediaFile, trustedMediaRecord } from '../media-storage.mjs';
import { repairMediaBinding } from './media-binding-repair.mjs';
import { AsyncSemaphore } from '../../extension/sync-core.js';
const decoders=new AsyncSemaphore(2);

const fail=(code,message,statusCode=409)=>Object.assign(new Error(message),{code,statusCode});
const provenance=row=>JSON.parse(row.provenance_json || '{}');

export async function pdfSupplementContext(db,parentId,storageRoot) {
  const parent=db.prepare(`SELECT a.*,s.capture_version AS current_version,s.raw_text FROM source_assets a
    JOIN sources s ON s.id=a.source_id WHERE a.id=?`).get(parentId);
  if(!parent) throw fail('ASSET_NOT_FOUND','PDF source asset not found.',404);
  if(parent.mime_type!=='application/pdf') throw fail('NOT_PDF','Select a PDF source asset.',400);
  if(parent.capture_version!==parent.current_version) throw fail('CONTEXT_STALE','PDF capture changed.');
  const filename=safeMediaPath(storageRoot,path.relative(storageRoot,parent.local_path));
  const bytes=await fs.readFile(filename);
  const hash=sha256(bytes);
  if(hash!==(parent.original_sha256 || parent.stored_sha256)) throw fail('CONTEXT_STALE','PDF bytes changed.');
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task=getDocument({data:new Uint8Array(bytes),disableWorker:true,verbosity:0,isEvalSupported:false});
  let pageCount;
  try {pageCount=(await task.promise).numPages;} finally {await task.destroy();}
  return {source_id:parent.source_id,capture_version:parent.capture_version,parent_asset_id:parent.id,
    parent_sha256:hash,page_count:pageCount,
    context_hash:sha256(JSON.stringify([parent.id,parent.source_id,parent.capture_version,hash,parent.raw_text,parent.provenance_json])),
    supplements:db.prepare(`SELECT id,original_filename,width,height,original_sha256,provenance_json FROM source_assets
      WHERE source_id=? AND capture_version=? AND json_extract(provenance_json,'$.supplement.parent_asset_id')=? ORDER BY position,id`)
      .all(parent.source_id,parent.capture_version,parent.id).map(row=>({...row,provenance_json:undefined,supplement:provenance(row).supplement,
        relationships:provenance(row).supplement.state==='confirmed' ? repairMediaBinding(db,row.id).new_bindings : []}))};
}

/** Append only. Uses the shared receiver's durable, hash-verified receipt. */
export async function receivePdfSupplement(repository,parentId,input,storageRoot,actor) {
  const db=repository.db,context=await pdfSupplementContext(db,parentId,storageRoot);
  if(input.context_hash!==context.context_hash) throw fail('CONTEXT_STALE','Reload the PDF before saving.');
  if(!/^[a-zA-Z0-9_-]{16,100}$/.test(input.idempotency_key || '')) throw fail('INVALID_KEY','Invalid receipt identity.',400);
  const receipt=input.receipt;
  if(!receipt || !/^media\/[a-f0-9]{2}\/[a-f0-9]{64}\.(jpg|png|webp|gif)$/.test(receipt.storageRef || ''))
    throw fail('INVALID_RECEIPT','An independent image receipt is required.',400);
  const original=trustedMediaRecord(storageRoot,receipt.storageRef,receipt.sha256);
  if(!original || original.kind!=='image') throw fail('INVALID_RECEIPT','The server has not confirmed these original bytes.',400);
  const filename=safeMediaPath(storageRoot,receipt.storageRef);
  await inspectMediaFile(filename,{sha256:original.sha256,mimeType:original.mimeType,kind:'image'});
  // Full decoder traversal; sharp's default decompression protection remains in force.
  let metadata;
  try {metadata=await decoders.run(async()=>{const info=await sharp(filename).metadata();await sharp(filename).stats();return info;});}
  catch {throw fail('IMAGE_DECODE_FAILED','Image decoding failed or exceeded decoder resource protection; original receipt retained.',400);}
  const assetId=`supplement_${sha256(`${parentId}:${input.idempotency_key}`).slice(0,32)}`;
  const requestHash=sha256(JSON.stringify([context.context_hash,receipt.storageRef,original.sha256,String(input.filename || '')]));
  // Recheck after asynchronous file inspection, before the synchronous transaction.
  if((await pdfSupplementContext(db,parentId,storageRoot)).context_hash!==context.context_hash) throw fail('CONTEXT_STALE','PDF changed during receipt validation.');
  return transaction(db,()=>{
    const previous=db.prepare('SELECT * FROM source_assets WHERE id=?').get(assetId);
    if(previous) {
      if(provenance(previous).supplement.request_hash!==requestHash) throw fail('IDEMPOTENCY_CONFLICT','This receipt identity belongs to another submission.');
      return {asset_id:assetId,supplement:provenance(previous).supplement};
    }
    const supplement={version:1,kind:'manual_source_supplement',state:'pending_confirmation',
      parent_asset_id:parentId,parent_sha256:context.parent_sha256,source_id:context.source_id,capture_version:context.capture_version,
      context_hash:context.context_hash,page:null,object_id:null,region:null,actor,received_at:now(),
      receipt:{storageRef:receipt.storageRef,sha256:original.sha256,sizeBytes:original.sizeBytes,mimeType:original.mimeType},
      idempotency_key:input.idempotency_key,request_hash:requestHash};
    db.prepare(`INSERT INTO source_assets(id,source_id,kind,remote_url,position,local_path,mime_type,original_filename,
      width,height,original_sha256,stored_sha256,stored_size_bytes,storage_status,original_bytes_status,durability_status,
      capture_version,provenance_json,publishable,authorization_status,authorization_origin)
      VALUES (?,?,'image',?,?, ?,?,?,?,?,?,?,?,'saved','saved_original','ORIGINAL_STORED',?,?,0,'authorized','manual_source_supplement')`)
      .run(assetId,context.source_id,`urn:cms:source-supplement:${assetId}`,
        db.prepare('SELECT COALESCE(MAX(position),-1)+1 n FROM source_assets WHERE source_id=?').get(context.source_id).n,
        filename,original.mimeType,path.basename(String(input.filename || 'image')),metadata.width,metadata.height,
        original.sha256,original.sha256,original.sizeBytes,context.capture_version,JSON.stringify({supplement}));
    repository.saveSourceAssetStorageRef(assetId,{originalStorageRef:receipt.storageRef});
    return {asset_id:assetId,supplement};
  });
}

export async function confirmPdfSupplement(repository,parentId,assetId,input,storageRoot,actor) {
  const db=repository.db,context=await pdfSupplementContext(db,parentId,storageRoot);
  const asset=db.prepare('SELECT * FROM source_assets WHERE id=?').get(assetId);
  const data=asset && provenance(asset),supplement=data?.supplement;
  if(!supplement || supplement.parent_asset_id!==parentId || asset.source_id!==context.source_id
    || asset.capture_version!==context.capture_version) throw fail('SUPPLEMENT_SCOPE_MISMATCH','Image does not belong to this PDF.',400);
  if(input.context_hash!==context.context_hash || supplement.context_hash!==context.context_hash) throw fail('CONTEXT_STALE','PDF context changed; old confirmation cannot be applied.');
  const page=input.page==null || input.page==='' ? null : Number(input.page);
  if(page!==null && (!Number.isSafeInteger(page) || page<1 || page>context.page_count)) throw fail('INVALID_PDF_PAGE','Page is outside this PDF.',400);
  if(typeof input.caption!=='string' || input.caption.length>12000) throw fail('INVALID_CAPTION','Provide a caption up to 12000 characters.',400);
  if(!['unknown','documentary_photo','editorial_infographic','screenshot','map_or_route'].includes(input.role)) throw fail('INVALID_ROLE','Choose the actual image role.',400);
  await inspectMediaFile(asset.local_path,{sha256:asset.original_sha256,mimeType:asset.mime_type,kind:'image'});
  if((await pdfSupplementContext(db,parentId,storageRoot)).context_hash!==context.context_hash) throw fail('CONTEXT_STALE','PDF changed during confirmation.');
  const confirmationHash=sha256(JSON.stringify([context.context_hash,page,input.caption,input.role]));
  return transaction(db,()=>{
    const current=provenance(db.prepare('SELECT provenance_json FROM source_assets WHERE id=?').get(assetId)).supplement;
    if(current.state==='confirmed') {
      if(current.confirmation_hash!==confirmationHash) throw fail('CONFIRMATION_CONFLICT','Already confirmed with different evidence.');
      return {asset_id:assetId,supplement:current,bindings:repairMediaBinding(db,assetId)};
    }
    const confirmed={...current,state:'confirmed',page,caption:input.caption,declared_role:input.role,
      confirmed_by:actor,confirmed_at:now(),confirmation_hash:confirmationHash,evidence_channel:'administrator_source_assertion'};
    db.prepare('UPDATE source_assets SET caption_text=?,alt_text=?,provenance_json=?,publishable=1 WHERE id=?')
      .run(input.caption,input.caption,JSON.stringify({...data,supplement:confirmed}),assetId);
    // Preserve human classification separately from model/pixel claims. Unknown stays unanalysed.
    if(input.role!=='unknown') repository.saveSourceAssetAnalysis(assetId,{analysis_status:'needs_review',asset_kind:input.role,
      analysis_version:'manual-source-supplement-1',provider:'administrator',confidence:0,primary_subjects:[],entities:[],
      last_error:'Human-declared role; no independent pixel/location verification.'},{withinTransaction:true});
    const preview=repairMediaBinding(db,assetId);
    const bindings=repairMediaBinding(db,assetId,{apply:true,expectedHash:preview.preview_hash});
    return {asset_id:assetId,supplement:confirmed,bindings};
  });
}
