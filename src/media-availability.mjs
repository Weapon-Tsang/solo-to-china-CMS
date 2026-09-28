import { sha256 } from './utils.mjs';
import { documentMediaCapability } from './repositories/media-diagnostics.mjs';

/** Pre-writing capability snapshot, not a declaration of publishability or route validity. */
export function mediaAvailabilitySnapshot(assets = [], retrieval = assets.retrieval || {}) {
  const entries = assets.map(asset => {
    const bindings = (asset.source_bindings || []).filter(row => row.status === 'confirmed');
    const reasons = [];
    if (asset.mime_type === 'application/pdf') reasons.push('PDF_ASSET_NOT_MATERIALIZED');
    if (asset.original_bytes_status && asset.original_bytes_status !== 'saved_original'
      || asset.durability_status && asset.durability_status !== 'ORIGINAL_STORED') reasons.push('ORIGINAL_MISSING');
    if (!asset.original_bytes_status || !asset.durability_status) reasons.push('ORIGINAL_STATUS_UNKNOWN');
    if (!['ready','needs_review'].includes(asset.analysis_status)) reasons.push('ANALYSIS_MISSING');
    if (!bindings.length) reasons.push('BINDING_EVIDENCE_MISSING');
    const issues=asset.source_binding_issues || [];
    if(issues.some(row=>row.evidence?.some(item=>item.polarity==='contradicts'))) reasons.push('BINDING_NEGATED');
    for(const status of ['conflict','revoked','ambiguous','candidate'])
      if(issues.some(row=>row.status===status)) reasons.push(`BINDING_${status.toUpperCase()}`);
    const assetId=asset.id || asset.source_asset_id;
    if(retrieval.selected_asset_ids && !retrieval.selected_asset_ids.includes(assetId)) reasons.push('RETRIEVAL_MISS');
    return { asset_id:assetId,source_id:asset.source_id,
      original_sha256:asset.original_sha256 || null,capture_version:asset.capture_version ?? null,
      asset_kind:asset.asset_kind || 'unknown',
      supported_relationships:bindings.map(row=>({binding_id:row.id,occurrence_id:row.occurrence_id,
        entity_key:row.entity_key,destination_slug:row.destination_slug,canonical_subject:row.canonical_subject,
        relation_type:row.relation_type,context_hash:row.context_hash,
        allowed_uses:row.allowed_uses || [],prohibited_inferences:row.prohibited_inferences || []})),
      known_gaps:reasons,byte_validation:'record_only_not_inspected',
      unresolved_relationships:issues.map(row=>({binding_id:row.id,entity_key:row.entity_key,relation_type:row.relation_type,status:row.status})),
      document_capability:documentMediaCapability(asset),adoption_status:'candidate_not_selected' };
  });
  const counts={};for(const asset of entries)for(const reason of asset.known_gaps)counts[reason]=(counts[reason] || 0)+1;
  const value = { version:2,scope:retrieval.scope || 'supplied_candidates_only',assets:entries,
    reason_counts:counts,count_unit:'unique asset IDs per reason; categories overlap',
    retrieval:{has_more:Boolean(retrieval.has_more || retrieval.inventory_has_more),offset:retrieval.offset ?? 0,next_offset:retrieval.next_offset ?? null,
      missing_explicit_ids:retrieval.missing_explicit_ids || [],unchecked:'outside returned entity/source page; bytes are not inspected'},
    constraints:['No precise entrance, route connection or viewpoint without matching evidence.',
      'Candidate photos do not verify route feasibility; A2 must validate the route bundle.',
      'This snapshot never removes required media or creates an adoption revision.'] };
  return {...value,snapshot_hash:sha256(JSON.stringify(value))};
}
