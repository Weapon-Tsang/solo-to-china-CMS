import crypto from 'node:crypto';
import fs from 'node:fs';
import { parseMediaMetadata, validateMediaDelivery } from './media-delivery.mjs';

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function mediaManifestForDraft(db, draftId) {
  const draft = db.prepare('SELECT id,revision,content_hash,strategy_version FROM article_drafts WHERE id=?').get(draftId);
  if (!draft) return null;
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
    acquisition_strategy FROM article_visuals WHERE draft_id=? ORDER BY slot`).all(draftId);
  if (!rows.length && !approvedNoImage) return null;
  const slots = rows.map((row) => ({ slotId: row.id, slot: row.slot, required: true,
    factualImageRequired: Boolean(row.factual_image_required), sourceAssetId: row.source_asset_id || null,
    acquisitionStrategy: row.acquisition_strategy, planFingerprint: row.asset_fingerprint }));
  const minimumRequired = slots.length;
  const manifestHash = digest(JSON.stringify({ draftId, revision: draft.revision,
    contentHash: draft.content_hash, minimumRequired, approvedNoImage, slots }));
  db.prepare(`INSERT OR IGNORE INTO required_media_manifests
    (draft_id,revision,content_hash,manifest_hash,minimum_required,approved_no_image,slots_json,created_at)
    VALUES (?,?,?,?,?,?,?,datetime('now'))`).run(draftId, draft.revision, draft.content_hash,
      manifestHash, minimumRequired, approvedNoImage ? 1 : 0, JSON.stringify(slots));
  return mediaManifestForDraft(db, draftId);
}

export function evaluatePublicationEligibility(db, draftId, { phase = 'local', pagePayload = null } = {}) {
  const draft = db.prepare('SELECT id,revision,content_hash,strategy_version FROM article_drafts WHERE id=?').get(draftId);
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
    sa.local_photo_audit_json AS source_local_photo_audit_json
    FROM article_visuals av
    LEFT JOIN source_assets sa ON sa.id=av.source_asset_id WHERE av.draft_id=?`).all(draftId);
  const byId = new Map(visualRows.map((row) => [row.id, row]));
  const missing = [];
  for (const slot of manifest.slots.filter((item) => item.required)) {
    const row = byId.get(slot.slotId);
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
    const checkedHash = metadata.binary_qa?.sha256 || metadata.pixel_qa?.sha256 || metadata.sha256;
    const sourceAnalysis=metadata.source_analysis || {};
    let localPhotoAudit={};
    try { localPhotoAudit=JSON.parse(row?.source_local_photo_audit_json || '{}'); } catch { /* invalid audit fails closed */ }
    const localPhotoQualified=localPhotoAudit.status === 'eligible'
      && localPhotoAudit.sha256 === fileHash && Number(localPhotoAudit.providerCalls) === 0;
    const retainedPhoto=Boolean(row?.acquisition_strategy === 'use_authorized_source_image'
      && row?.source_asset_id && row.original_bytes_status === 'saved_original'
      && row.durability_status === 'ORIGINAL_STORED'
      && row.source_original_sha256 === fileHash
      && (draft.strategy_version === '3.9' ? localPhotoQualified
        : (sourceAnalysis.analysis_status === 'ready'
          && sourceAnalysis.asset_kind === 'documentary_photo'
          && sourceAnalysis.reader_text_present === false
          && !(sourceAnalysis.editor_ui_regions || []).length))
      && metadata.visual_decision?.action === 'retain'
      && Number(metadata.authorized_asset_match?.score || 0) >= 0.34);
    if ((!checkedHash || checkedHash !== fileHash) && !retainedPhoto) failures.push('file_hash_unverified');
    if (metadata.binary_qa?.status !== 'passed' && metadata.pixel_qa?.status !== 'passed'
      && !retainedPhoto) failures.push('binary_qa_missing');
    const quality = metadata.quality_qa || {};
    const qaPassed = quality.status === 'passed' || ['language','completeness','style','semantic']
      .every((field) => quality[field]?.status === 'passed');
    if ((!qaPassed || quality.file_hash !== fileHash) && !retainedPhoto) {
      failures.push('quality_qa_missing_or_stale');
    }
    if (!String(row?.alt_text || '').trim()) failures.push('alt_missing');
    if (phase === 'delivery' && (!row?.wordpress_media_id || !row?.wordpress_media_url)) failures.push('wordpress_media_missing');
    if (phase === 'delivery' && metadata.sha256 !== fileHash) failures.push('wordpress_media_hash_mismatch');
    if (failures.length) missing.push({ slotId: slot.slotId, slot: slot.slot, reasons: failures });
  }
  if (manifest.slots.length < manifest.minimumRequired || new Set(manifest.slots.map((item) => item.slotId)).size !== manifest.slots.length) {
    return { passed: false, code: 'MEDIA_MANIFEST_INVALID', missing, required: manifest.minimumRequired,
      ready: manifest.minimumRequired - missing.length };
  }
  if (missing.length) return { passed: false, code: 'MEDIA_INCOMPLETE', missing,
    required: manifest.minimumRequired, ready: manifest.minimumRequired - missing.length };
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
