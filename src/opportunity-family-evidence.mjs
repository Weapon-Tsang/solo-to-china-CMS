import { createHash } from 'node:crypto';

export const FAMILY_EVIDENCE_VERSION = 'selected-usable-facts-v1';
export const usableOpportunityFact = fact => fact.visibility_status !== 'hidden'
  && fact.consensus_status !== 'conflicted'
  && ['current', 'unknown'].includes(fact.validity_state || 'unknown')
  && Boolean(String(fact.preferred_value || '').trim());

export function evidenceFamilyKeys(evidence, familyBySource) {
  return [...new Set(evidence.filter(item => item.source_id).map(item =>
    familyBySource.get(item.source_id) ? `family:${familyBySource.get(item.source_id)}` : `source:${item.source_id}`))].sort();
}

// No application bootstrap, migrations, workers, configuration or network access.
export function completedOpportunitySourceIds(db) {
  return new Set(db.prepare(`SELECT s.id FROM sources s
    WHERE s.completeness_status='complete' AND s.status IN ('processed','needs_ai')
    AND NOT EXISTS (SELECT 1 FROM current_source_assets a WHERE a.source_id=s.id
      AND (a.durability_status IS NULL OR a.durability_status<>'ORIGINAL_STORED'))
    AND EXISTS (SELECT 1 FROM experience_extraction_runs er WHERE er.source_id=s.id
      AND er.capture_version=s.capture_version AND er.status='succeeded' AND er.degraded=0)`).all().map(r => r.id));
}

export function selectedFamilyProjection(db, opportunity) {
  const coverage = JSON.parse(opportunity.coverage_json);
  const keys = [...new Set(coverage.selectedFactKeys || [])].sort();
  const complete = completedOpportunitySourceIds(db);
  const membership = new Map(db.prepare('SELECT source_id,family_id FROM source_family_memberships').all().map(r => [r.source_id,r.family_id]));
  const facts = keys.length ? db.prepare(`SELECT k.*,r.status AS resolution_status,r.preferred_value AS resolved_value
    FROM knowledge_facts k JOIN destinations d ON d.id=k.destination_id
    LEFT JOIN knowledge_resolutions r ON r.destination_slug=d.slug AND r.normalized_key=k.normalized_key
    WHERE d.slug=? AND k.normalized_key IN (${keys.map(() => '?').join(',')}) ORDER BY k.normalized_key`)
    .all(opportunity.destination_slug,...keys).map(row => ({...row,
      consensus_status:row.resolution_status==='resolved'?'corroborated':row.consensus_status,
      preferred_value:row.resolution_status==='resolved'?(row.resolved_value || row.preferred_value):row.preferred_value,
      evidence:JSON.parse(row.evidence_json).filter(e => complete.has(e.source_id))})) : [];
  const usable = facts.filter(f => f.visibility_status==='visible' && usableOpportunityFact(f) && f.evidence.length);
  const families = evidenceFamilyKeys(usable.flatMap(f => f.evidence),membership);
  const sources = [...new Set(usable.flatMap(f => f.evidence.map(e => e.source_id)))].sort();
  const memberships = sources.map(source => [source,membership.get(source) || null]);
  const dependencyFingerprint = createHash('sha256').update(JSON.stringify({version:FAMILY_EVIDENCE_VERSION,
    keys,facts,families,sources,memberships})).digest('hex');
  return {version:FAMILY_EVIDENCE_VERSION,keys,facts:usable,families,sources,dependencyFingerprint,
    missing:keys.length-facts.length,unusable:facts.length-usable.length};
}
