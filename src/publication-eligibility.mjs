import crypto from 'node:crypto';
import fs from 'node:fs';
import { parseMediaMetadata, validateMediaDelivery } from './media-delivery.mjs';
import { visualQaMentionsSpellingError } from './visual-qa.mjs';
import { readMediaBindings, readMediaBindingIssues, bindingBlocksPhoto } from './repositories/media-bindings.mjs';
import { verifyStoredRouteVisual } from './visuals/route-schematic.mjs';
import { panelReceiptValid } from './visuals/route-panel.mjs';
import { coverDeliveryBlocker } from './services/cover-selection.mjs';

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function routePageDependencyHash(db,draftId) {
  const page=db.prepare(`SELECT payload_json,status,contract_checksum,draft_revision,draft_content_hash
    FROM frontend_page_compositions WHERE draft_id=?`).get(draftId);
  return page ? digest(JSON.stringify(page)) : null;
}

export function routeMediaDependencyHash(db,draftId) {
  return digest(JSON.stringify(db.prepare(`SELECT id,slot,status,asset_fingerprint,caption,alt_text,media_metadata_json
    FROM article_visuals WHERE draft_id=? ORDER BY slot`).all(draftId).map(({media_metadata_json,...row})=>{
      const metadata=parseMediaMetadata(media_metadata_json);
      return {...row,route_contract:metadata.route_contract || null,route_omission:metadata.route_omission || null,
        file_hash:metadata.binary_qa?.sha256 || metadata.pixel_qa?.sha256 || metadata.sha256 || null};
    })));
}

// Independent text review depends on words, placement and route meaning. Image
// bytes and receiver attachment identities have their own QA/delivery receipts.
export function routeReviewMediaDependencyHash(db,draftId) {
  return digest(JSON.stringify(db.prepare(`SELECT id,slot,caption,alt_text,media_metadata_json
    FROM article_visuals WHERE draft_id=? ORDER BY slot`).all(draftId).map(({media_metadata_json,...row})=>{
      const metadata=parseMediaMetadata(media_metadata_json);
      return {...row,route_contract:metadata.route_contract || null,route_omission:metadata.route_omission || null};
    })));
}
export function routeReviewPageDependencyHash(db,draftId) {
  const page=db.prepare(`SELECT payload_json,status,contract_checksum,draft_revision,draft_content_hash
    FROM frontend_page_compositions WHERE draft_id=?`).get(draftId);
  if(!page)return null;
  const payload=JSON.parse(page.payload_json);
  for(const block of payload.blocks || [])if(block.type==='image'&&block.data) {
    for(const key of ['media_id','src','url','width','height'])delete block.data[key];
  }
  if(payload.metadata)delete payload.metadata.featuredMediaId;
  return digest(JSON.stringify({...page,payload_json:JSON.stringify(payload)}));
}

export function mediaManifestForDraft(db, draftId) {
  const draft = db.prepare('SELECT id,revision,content_hash,strategy_version FROM article_drafts WHERE id=?').get(draftId);
  if (!draft) return null;
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='article_media_revisions'").get()) {
    const manual=db.prepare('SELECT manifest_json FROM article_media_revisions WHERE draft_id=? AND draft_revision=? ORDER BY media_revision DESC LIMIT 1').get(draftId,draft.revision);
    if(manual)return JSON.parse(manual.manifest_json);
  }
  const row = db.prepare('SELECT * FROM required_media_manifests WHERE draft_id=? AND revision=?')
    .get(draftId, draft.revision);
  if (!row) return null;
  return { version: 1, draftId, revision: row.revision, contentHash: row.content_hash,
    manifestHash: row.manifest_hash, minimumRequired: row.minimum_required,
    approvedNoImage: Boolean(row.approved_no_image), slots: JSON.parse(row.slots_json) };
}

// Called before any media RPC. An existing revision is immutable; changing the
// plan requires a new draft revision and a fresh QA/delivery decision.
export function freezeRequiredMediaManifest(db, draftId, { approvedNoImage = false } = {}) {
  const current = mediaManifestForDraft(db, draftId);
  if (current) return current;
  const draft = db.prepare('SELECT id,revision,content_hash,strategy_version FROM article_drafts WHERE id=?').get(draftId);
  if (!draft) throw new Error(`Draft ${draftId} does not exist.`);
  const rows = db.prepare(`SELECT id,slot,asset_fingerprint,factual_image_required,source_asset_id,
    acquisition_strategy,media_metadata_json FROM article_visuals WHERE draft_id=? AND COALESCE(json_extract(media_metadata_json,'$.media_purpose'),'body')<>'cover' ORDER BY slot`).all(draftId);
  if (!rows.length && !approvedNoImage) return null;
  const slots = rows.map((row) => ({ slotId: row.id, slot: row.slot,
    required:row.acquisition_strategy==='render_route_schematic'
      ? parseMediaMetadata(row.media_metadata_json).required_visual_obligation?.required===true
      : !(parseMediaMetadata(row.media_metadata_json).route_omission && !row.factual_image_required
        && !parseMediaMetadata(row.media_metadata_json).required_visual_obligation?.required),
    factualImageRequired: Boolean(row.factual_image_required), sourceAssetId: row.source_asset_id || null,
    acquisitionStrategy: row.acquisition_strategy, planFingerprint: row.asset_fingerprint,
    ...(parseMediaMetadata(row.media_metadata_json).route_contract
      ? {routeContract:parseMediaMetadata(row.media_metadata_json).route_contract} : {}) }));
  const minimumRequired = slots.filter(slot=>slot.required).length;
  const manifestHash = digest(JSON.stringify({ draftId, revision: draft.revision,
    contentHash: draft.content_hash, minimumRequired, approvedNoImage, slots }));
  db.prepare(`INSERT OR IGNORE INTO required_media_manifests
    (draft_id,revision,content_hash,manifest_hash,minimum_required,approved_no_image,slots_json,created_at)
    VALUES (?,?,?,?,?,?,?,datetime('now'))`).run(draftId, draft.revision, draft.content_hash,
      manifestHash, minimumRequired, approvedNoImage ? 1 : 0, JSON.stringify(slots));
  return mediaManifestForDraft(db, draftId);
}

export function evaluatePublicationEligibility(db, draftId, { phase = 'local', pagePayload = null, requireRouteReview = true } = {}) {
  if(phase==='delivery') {
    const coverBlocker=coverDeliveryBlocker(db,draftId);
    if(coverBlocker)return {passed:false,code:coverBlocker.code,missing:[coverBlocker],required:null,ready:0};
  }
  let routeBundle=null;
  const draft = db.prepare('SELECT id,revision,content_hash,strategy_version FROM article_drafts WHERE id=?').get(draftId);
  if(draft) {
    const route=db.prepare(`SELECT rb.* FROM route_bundles rb JOIN content_briefs cb ON cb.candidate_id=rb.candidate_id
      JOIN article_drafts ad ON ad.brief_id=cb.id WHERE ad.id=? ORDER BY rb.revision DESC LIMIT 1`).get(draftId);
    if(route) {
      const bundle=JSON.parse(route.bundle_json);
      routeBundle=bundle;
      const sourceStale=bundle.source_snapshot.some(s=>db.prepare('SELECT capture_version FROM sources WHERE id=?').get(s.source_id)?.capture_version!==s.capture_version);
      const receipts=db.prepare(`SELECT artifact_kind,receipt_json FROM route_artifacts WHERE route_id=? AND route_revision=?
        AND approved_route_hash=? AND content_hash=? AND artifact_kind IN ('draft','text_review','page')`)
        .all(route.route_id,route.revision,route.approved_route_hash,draft.content_hash);
      const hasDraft=receipts.some(r=>r.artifact_kind==='draft' && JSON.parse(r.receipt_json).draft_id===draftId);
      const hasReview=receipts.some(r=>{const receipt=JSON.parse(r.receipt_json);return r.artifact_kind==='text_review'
        && receipt.draft_id===draftId && receipt.passed && receipt.audit?.checked && receipt.audit?.passed
        && !receipt.audit.differences?.length && receipt.audit.approved_route_hash===route.approved_route_hash
        && (receipt.dependency_version==='route-review-dependencies-v2'
          ? receipt.text_media_dependency_hash===routeReviewMediaDependencyHash(db,draftId)
            && (receipt.text_page_dependency_hash || null)===routeReviewPageDependencyHash(db,draftId)
          : receipt.media_dependency_hash===routeMediaDependencyHash(db,draftId)
            && (receipt.page_dependency_hash || null)===routePageDependencyHash(db,draftId));});
      if(route.status!=='FROZEN' || sourceStale || !hasDraft || ((requireRouteReview || phase==='delivery') && !hasReview)) return {passed:false,
        code:'ROUTE_REVIEW_MISSING_OR_STALE',missing:[{sourceStale,hasDraft,hasReview}],required:null,ready:0};
      const pageHash=routePageDependencyHash(db,draftId);
      if(phase==='delivery' && pageHash && !receipts.some(r=>{
        const receipt=JSON.parse(r.receipt_json);
        return r.artifact_kind==='page' && receipt.draft_id===draftId && receipt.page_dependency_hash===pageHash
          && receipt.media_dependency_hash===routeMediaDependencyHash(db,draftId);
      })) return {passed:false,code:'ROUTE_PAGE_MISSING_OR_STALE',missing:[{pageHash}],required:null,ready:0};
    }
  }
  const manifest = draft && mediaManifestForDraft(db, draftId);
  if (!draft || !manifest || manifest.contentHash !== draft.content_hash) {
    return { passed: false, code: 'MEDIA_MANIFEST_MISSING_OR_STALE', missing: [],
      required: manifest?.minimumRequired ?? null, ready: 0 };
  }
  if (!manifest.slots.length && !manifest.approvedNoImage) {
    return { passed: false, code: 'EMPTY_MEDIA_MANIFEST_NOT_APPROVED', missing: [], required: 0, ready: 0 };
  }
  const visualRows = db.prepare(`SELECT av.*,sa.local_path AS source_asset_local_path,
    sa.original_bytes_status,sa.durability_status,sa.original_sha256 AS source_original_sha256,
    sa.provenance_json AS source_provenance_json,
    sa.local_photo_audit_json AS source_local_photo_audit_json
    FROM article_visuals av
    LEFT JOIN source_assets sa ON sa.id=av.source_asset_id WHERE av.draft_id=?`).all(draftId);
  const byId = new Map(visualRows.map((row) => [row.id, row]));
  const missing = [];
  for (const slot of manifest.slots) {
    const row = byId.get(slot.slotId);
    if(!slot.required && row?.status==='skipped' && !row.factual_image_required && row.asset_fingerprint===slot.planFingerprint
      && JSON.stringify(slot.routeContract)===JSON.stringify(parseMediaMetadata(row.media_metadata_json).route_contract)
      && parseMediaMetadata(row.media_metadata_json).route_omission?.plan_fingerprint===slot.planFingerprint) continue;
    const failures = [];
    if (!row || row.slot !== slot.slot || row.asset_fingerprint !== slot.planFingerprint) failures.push('stale_or_missing_slot');
    if (row?.status !== 'generated') failures.push('not_generated');
    if (slot.factualImageRequired && (!row?.source_asset_id || row.acquisition_strategy === 'generate_illustration'
      || row.original_bytes_status !== 'saved_original' || row.durability_status !== 'ORIGINAL_STORED')) {
      failures.push('factual_source_unverified');
    }
    const filePath = row?.media_path || row?.source_asset_local_path;
    let fileHash = null;
    try { if (filePath) fileHash = digest(fs.readFileSync(filePath)); } catch { /* keep the missing file explicit */ }
    if (!fileHash) failures.push('local_file_missing');
    const metadata = parseMediaMetadata(row?.media_metadata_json);
    if(metadata.route_contract?.compatible===false) failures.push('route_media_conflict');
    if(!panelReceiptValid(metadata.route_contract,metadata.route_panel_derivative,row?.source_original_sha256))
      failures.push('route_panel_bytes_missing_or_stale');
    if(slot.routeContract && JSON.stringify(slot.routeContract)!==JSON.stringify(metadata.route_contract))
      failures.push('route_manifest_dependency_changed');
    const boundIds=metadata.authorized_asset_match?.source_binding_ids || [];
    if(row?.source_asset_id && bindingBlocksPhoto({source_binding_issues:readMediaBindingIssues(db,row.source_asset_id)},row)) {
      failures.push('source_binding_stale_or_conflicted');
    }
    if(boundIds.length){
      const current=new Set(readMediaBindings(db,row?.source_asset_id).map(binding=>binding.id));
      if(!boundIds.every(id=>current.has(id)))failures.push('source_binding_stale_or_conflicted');
    }
    // A model's generic "QA passed" must not overrule a near-zero source/subject
    // match. This caught a Chongqing itinerary illustrated with an unrelated
    // preparation/bus card. A location claim may be explicitly verified by an
    // editor when a documentary photo is genuinely taken on site.
    const matchScore = Number(metadata.authorized_asset_match?.score);
    const sourceProvenance = parseMediaMetadata(row?.source_provenance_json);
    const verifiedLocation = sourceProvenance.editorialLocationVerification;
    const editorVerified = verifiedLocation?.status === 'confirmed'
      && verifiedLocation.draftId === draftId && Boolean(verifiedLocation.evidence);
    const matchFloor = ['photo_collage','editorial_infographic','map_or_route','handwritten_card']
      .includes(metadata.source_analysis?.asset_kind) ? 0.30 : 0.34;
    if (row?.factual_image_required && metadata.authorized_asset_match
      && (!Number.isFinite(matchScore) || matchScore < matchFloor) && !editorVerified) {
      failures.push('source_subject_mismatch');
    }
    if (row?.image_type === 'infographic' && /^\s*photo of\b/i.test(String(row.caption || ''))) {
      failures.push('infographic_caption_mislabels_media');
    }
    const checkedHash = metadata.binary_qa?.sha256 || metadata.pixel_qa?.sha256 || metadata.sha256;
    const sourceAnalysis=metadata.source_analysis || {};
    let localPhotoAudit={};
    try { localPhotoAudit=JSON.parse(row?.source_local_photo_audit_json || '{}'); } catch { /* invalid audit fails closed */ }
    const localPhotoQualified=localPhotoAudit.status === 'eligible'
      && localPhotoAudit.sha256 === fileHash && Number(localPhotoAudit.providerCalls) === 0;
    const manual=metadata.manual_article_selection,manualReceipt=metadata.manual_local_receipt;
    // A locked operator photo belongs to its visual slot. A bounded text repair
    // bumps the draft revision but keeps the slot row, so the adoption carries
    // over (2026-09-30: every QA repair silently invalidated an adopted photo).
    // A regenerated draft rebuilds its slots and cannot match the old slot id.
    const manualRevisionCurrent=manual?.draft_revision===draft.revision
      || (manual?.slot_id===row?.id && Number(manual?.draft_revision)<=Number(draft.revision));
    const manualPhoto=Boolean(manual?.locked && manual.local_photo && !manual.route_blocked
      && manual.asset_id===row?.source_asset_id && manualRevisionCurrent
      && manual.original_hash===fileHash && manualReceipt?.original_hash===fileHash
      && manualReceipt.selection_id===manual.id && manualReceipt.provider_calls===0
      && manualReceipt.photo_audit?.sha256===fileHash && Number.isFinite(manualReceipt.photo_audit.textChars)
      && !manualReceipt.photo_audit.reasons?.some(reason=>!['resolution_low','focus_low','detail_low'].includes(reason))
      && (!manualReceipt.photo_audit.reasons?.length || manual.quality_confirmed)
      && row.original_bytes_status==='saved_original' && row.durability_status==='ORIGINAL_STORED'
      && row.source_original_sha256===fileHash
      && row?.acquisition_strategy==='manual_article_selection');
    const retainedPhoto=manualPhoto || Boolean(row?.acquisition_strategy === 'use_authorized_source_image'
      && row?.source_asset_id && row.original_bytes_status === 'saved_original'
      && row.durability_status === 'ORIGINAL_STORED'
      && row.source_original_sha256 === fileHash
      && (localPhotoQualified
        || (sourceAnalysis.analysis_status === 'ready'
          && sourceAnalysis.asset_kind === 'documentary_photo'
          && sourceAnalysis.reader_text_present === false
          && !(sourceAnalysis.editor_ui_regions || []).length))
      && metadata.visual_decision?.action === 'retain'
      && (Number(metadata.authorized_asset_match?.score || 0) >= 0.34 || editorVerified));
    if ((!checkedHash || checkedHash !== fileHash) && !retainedPhoto) failures.push('file_hash_unverified');
    if (metadata.binary_qa?.status !== 'passed' && metadata.pixel_qa?.status !== 'passed'
      && !retainedPhoto) failures.push('binary_qa_missing');
    const quality = metadata.quality_qa || {};
    let localRouteQualified=false;
    if(row?.acquisition_strategy==='render_route_schematic') {
      try { localRouteQualified=Boolean(routeBundle && verifyStoredRouteVisual(db,routeBundle,row,metadata)); }
      catch { /* Invalid artifact, caption or bytes cannot be delivered. */ }
      if(!localRouteQualified) failures.push('route_render_receipt_missing_or_stale');
    }
    const qaPassed = !visualQaMentionsSpellingError(quality)
      && (quality.status === 'passed' || ['language','completeness','style','semantic']
        .every((field) => quality[field]?.status === 'passed'));
    if ((!qaPassed || quality.file_hash !== fileHash) && !retainedPhoto && !localRouteQualified) {
      failures.push('quality_qa_missing_or_stale');
    }
    if (!String(row?.alt_text || '').trim()) failures.push('alt_missing');
    if (phase === 'delivery' && (!row?.wordpress_media_id || !row?.wordpress_media_url)) failures.push('wordpress_media_missing');
    if (phase === 'delivery') {
      if(metadata.web_derivative) {
        const web=metadata.web_derivative;
        let webHash=null;
        try { webHash=digest(fs.readFileSync(web.localPath)); } catch { /* fail closed */ }
        if(web.parent_hash!==fileHash || web.sha256!==webHash || web.sha256!==metadata.upload_bytes_hash
          || metadata.master_hash!==fileHash || web.verification!=='decoded_and_lineage_verified')
          failures.push('wordpress_media_lineage_mismatch');
      } else if(metadata.sha256 !== fileHash) failures.push('wordpress_media_hash_mismatch');
    }
    if (failures.length) missing.push({ slotId: slot.slotId, slot: slot.slot, reasons: failures });
  }
  if (manifest.slots.length < manifest.minimumRequired || new Set(manifest.slots.map((item) => item.slotId)).size !== manifest.slots.length) {
    return { passed: false, code: 'MEDIA_MANIFEST_INVALID', missing, required: manifest.minimumRequired,
      ready: Math.max(0, manifest.minimumRequired - missing.filter(item=>manifest.slots.some(slot=>slot.required && slot.slotId===item.slotId)).length) };
  }
  if (missing.length) return { passed: false, code: 'MEDIA_INCOMPLETE', missing,
    required: manifest.minimumRequired, ready: Math.max(0, manifest.minimumRequired - missing.filter(item=>manifest.slots.some(slot=>slot.required && slot.slotId===item.slotId)).length) };
  if (phase === 'delivery') {
    const delivered = validateMediaDelivery(visualRows.map((row) => ({ ...row,
      media_metadata: parseMediaMetadata(row.media_metadata_json) })), { requireMetadata: true, pagePayload });
    if (!delivered.valid) return { passed: false, code: 'MEDIA_DELIVERY_INVALID', missing: delivered.errors,
      required: manifest.minimumRequired, ready: manifest.minimumRequired };
  }
  return { passed: true, code: null, missing: [], required: manifest.minimumRequired, ready: manifest.minimumRequired,
    revision: draft.revision, contentHash: draft.content_hash, manifestHash: manifest.manifestHash };
}

export function assertPublicationEligibility(db, draftId, options = {}) {
  const result = evaluatePublicationEligibility(db, draftId, options);
  if (!result.passed) throw Object.assign(new Error(`${result.code}: required media is incomplete.`), {
    code: result.code, statusCode: 409, retryable: false, details: result,
  });
  return result;
}
