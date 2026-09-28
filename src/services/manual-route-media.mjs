import { compareRouteMedia, routeSemantics } from '../route-bundle.mjs';
export const MANUAL_ROUTE_MEDIA_POLICY = 'manual-route-media-1';

// Administrator assertions identify this article's photo, not transport facts.
// A declared diagram day can establish a conflict, never establish pixel QA.
export function manualRouteMediaDecision(bundle, item, priorContract = null) {
  if (!bundle) return priorContract || item.kind === 'route' ? {
    policy_version:MANUAL_ROUTE_MEDIA_POLICY, blocked: true, code: 'ROUTE_SNAPSHOT_REQUIRED', differences: [{ field: 'approved_route', expected: 'verified article route', actual: null }],
    actions: ['保留原件，核对文章已有路线；不得根据新图自动建立路线。'], contract: priorContract,
  } : null;
  const differences = [];
  if (item.approved_route_hash !== bundle.approved_route_hash)
    differences.push({ field: 'approved_route_hash', expected: bundle.approved_route_hash, actual: item.approved_route_hash || null });
  const use = item.purpose === 'cover' ? 'cover' : 'stop_photo';
  if (item.kind === 'photo') {
    if (priorContract && !['cover', 'stop_photo', 'route_context_photo'].includes(priorContract.use))
      differences.push({ field: 'media_use', expected: priorContract.use, actual: use });
    const compared = compareRouteMedia(bundle, { use, entity_id: item.route_entity_id, binding_valid: item.factual_photo === true });
    differences.push(...compared.differences);
    return { policy_version:MANUAL_ROUTE_MEDIA_POLICY, blocked: differences.length > 0, code: differences.length ? 'ROUTE_PHOTO_BINDING_REQUIRED' : null, differences,
      actions: differences.length ? ['选择批准路线中的对应站点；普通照片请放入独立照片槽位。'] : [],
      contract: { ...compared, compatible: differences.length === 0, differences, route_id: bundle.route_id, revision: bundle.revision,
        approved_route_hash: bundle.approved_route_hash, use, entity_id: item.route_entity_id || null,
        binding_basis: 'administrator_article_slot_confirmation', target: routeSemantics(bundle) } };
  }
  if (item.kind !== 'route' && !priorContract) return null;
  const day = bundle.days.find(d => d.day_id === item.route_day_id);
  if (!day) differences.push({ field: 'day', expected: 'approved day', actual: item.route_day_id || null });
  const label = String(item.embedded_day_label || '').trim();
  if (day && label && label.toLowerCase() !== day.label.trim().toLowerCase())
    differences.push({ field: 'embedded_day_label', expected: day.label, actual: label });
  differences.push({ field: 'pixel_route_evidence', expected: 'image-bound stop/arrow/transport comparison and QA', actual: 'not_verified' });
  return { policy_version:MANUAL_ROUTE_MEDIA_POLICY, blocked: true, code: differences.some(d => d.field === 'embedded_day_label') ? 'ROUTE_MEDIA_CONFLICT' : 'ROUTE_EVIDENCE_PENDING', differences,
    actions: ['保留原件，上传与当前路线相符的图。', '采用相关单点实拍，或按已批准骨架重新制作示意图。', '修改天数、站点或交通需单独提交路线修订提案。'],
    contract: { ...(priorContract || {}), compatible: false, differences, route_id: bundle.route_id, revision: bundle.revision,
      approved_route_hash: bundle.approved_route_hash, use: 'day_route_diagram', day_id: day?.day_id || null, target: routeSemantics(bundle) } };
}
