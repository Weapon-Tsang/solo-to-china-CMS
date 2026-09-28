import { sha256 } from '../utils.mjs';
import { transaction } from '../db.mjs';
import { refreshSourceMediaBindings, MEDIA_BINDING_POLICY } from './media-bindings.mjs';

const fail = (message, code, statusCode) => Object.assign(new Error(message), {code,statusCode});

/** Preview or apply one current occurrence's deterministic relationship repair.
 * Drafts, frozen packets, analyses, jobs and budgets are never mutated here.
 */
export function repairMediaBinding(db, assetId, { apply = false, expectedHash = null } = {}) {
  const preview = () => {
    const asset = db.prepare(`SELECT sa.*,s.capture_version AS current_capture_version
      FROM source_assets sa JOIN sources s ON s.id=sa.source_id WHERE sa.id=?`).get(assetId);
    if (!asset) throw fail('Source asset not found.', 'ASSET_NOT_FOUND', 404);
    if (asset.capture_version !== asset.current_capture_version) {
      throw fail('Only the current capture can be repaired.', 'CONTEXT_STALE', 409);
    }
    if (asset.mime_type === 'application/pdf') throw fail('PDF pages are visual evidence, not independent image files. Supply a materialized image before repairing a photo relationship.',
      'PDF_ASSET_NOT_MATERIALIZED', 409);
    if (asset.kind !== 'image') throw fail('Only image relationships can be repaired here.', 'ASSET_NOT_IMAGE', 400);
    const plan = refreshSourceMediaBindings(db,asset.source_id,{assetIds:[assetId]});
    const next = plan.assets[0];
    const old = db.prepare(`SELECT mb.id,mb.occurrence_id,mb.relation_type,mb.entity_key,mb.status,
      mb.policy_version,mo.context_hash FROM media_bindings mb JOIN media_occurrences mo ON mo.id=mb.occurrence_id
      WHERE mb.asset_id=? ORDER BY mb.id`).all(assetId);
    const affected = db.prepare(`SELECT av.id AS visual_id,av.draft_id,av.slot,ad.revision,ad.content_hash
      FROM article_visuals av JOIN article_drafts ad ON ad.id=av.draft_id
      WHERE av.source_asset_id=? ORDER BY av.draft_id,av.slot,av.id LIMIT 101`).all(assetId);
    const counts = {};
    const reasons = [next.reason];
    if (!asset.local_path || asset.original_bytes_status !== 'saved_original'
      || asset.durability_status !== 'ORIGINAL_STORED') reasons.push('ORIGINAL_MISSING');
    const analysis = db.prepare('SELECT analysis_status,source_sha256 FROM source_asset_analyses WHERE asset_id=?').get(assetId);
    if (!analysis || !['ready','needs_review'].includes(analysis.analysis_status)) reasons.push('ANALYSIS_MISSING');
    if (analysis && analysis.source_sha256 !== (asset.original_sha256 || asset.stored_sha256)) reasons.push('CONTEXT_STALE');
    if (next.context_status === 'context_pending') reasons.push('CONTEXT_MISSING');
    for (const reason of new Set(reasons)) counts[reason] = 1;
    const preserved = new Map(old.filter(row => ['revoked','conflict'].includes(row.status)).map(row => [row.id,row.status]));
    const bindings = next.bindings.map(row => ({...row,status:preserved.get(row.id) || row.status}));
    const report = { source_id:asset.source_id,asset_id:assetId,capture_version:asset.capture_version,
      occurrence_id:next.occurrence_id,context_hash:next.context_hash,policy_version:MEDIA_BINDING_POLICY,
      context_status:next.context_status,supplementation:next.supplementation,
      old_bindings:old,new_bindings:bindings,reason_counts:counts,
      affected_slots:affected.slice(0,100),affected_slots_has_more:affected.length>100,
      local_steps:['restore_retained_context','rebuild_source_relationships'],model_calls:0,
      paid_steps:[],unresolved_action:next.context_status === 'context_pending' ? 'read_context_or_supply_evidence' : null,
      draft_action:'unchanged; consuming frozen plans requires a later explicit media revision',
      rollback:'prior immutable occurrence and relationship rows are retained; no draft or pixel analysis is rewritten' };
    return {...report,preview_hash:sha256(JSON.stringify(report))};
  };
  if (!apply) return {...preview(),applied:false};
  return transaction(db, () => {
    const report = preview();
    if (!expectedHash || expectedHash !== report.preview_hash) {
      throw fail('Repair preview changed; reload the exact relationship diff.', 'CONTEXT_STALE', 409);
    }
    refreshSourceMediaBindings(db,report.source_id,{dryRun:false,assetIds:[assetId]});
    return {...preview(),applied:true};
  });
}
