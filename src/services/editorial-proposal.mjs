import { sha256 } from '../utils.mjs';

const parse = value => { try { return typeof value === 'string' ? JSON.parse(value) : value || {}; } catch { return {}; } };
export function proposalForOpportunity(row) {
  const coverage = parse(row.coverage_json || row.coverage);
  const proposal = coverage.proposal || {};
  return { id: row.id, destination: row.destination_slug, title: row.title,
    contentType: row.content_type, mode: coverage.publicationMode || 'topic_feature',
    readerPromise: proposal.readerPromise || coverage.editorialBrief || row.title,
    evidenceBoundary: proposal.evidenceBoundary || coverage.editorialBrief || '',
    targetEntities: [...(coverage.targetEntities || proposal.targetEntities || [])].sort(),
    sourceId: row.source_id || null };
}
export function proposalFingerprint(row) { return sha256(JSON.stringify(proposalForOpportunity(row))); }
export function freezeProposal(row, actor = 'administrator') {
  return { version: 1, proposal: proposalForOpportunity(row), fingerprint: proposalFingerprint(row),
    selectedFactKeys: parse(row.coverage_json).selectedFactKeys || [], approvedAt: new Date().toISOString(), actor };
}

// A grouping signal, not a duplicate verdict. Do not merge or delete proposals.
export function groupProposals(rows) {
  const groups = new Map();
  for (const row of rows) {
    const p = proposalForOpportunity(row);
    const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
    const key = [p.destination,p.contentType,normalize(p.readerPromise),p.targetEntities.map(normalize).join('|')].join(':');
    if (!groups.has(key)) groups.set(key,[]);
    groups.get(key).push({id:row.id,title:row.title,status:row.status,mode:p.mode,sourceId:p.sourceId});
  }
  return [...groups.entries()].filter(([,items])=>items.length>1).map(([key,items])=>({id:sha256(key).slice(0,24),items,reason:'相同目的地、内容类型、读者承诺和明确地点范围；请比较是否需要独立成文，不会自动合并。'}));
}

export function validatePlannedEvidence(plan, contentPackage) {
  const facts = new Map((contentPackage.facts || []).map(f=>[f.normalized_key,f]));
  const sections = plan?.outline || [];
  const errors = [];
  if (!sections.length) errors.push({code:'OUTLINE_MISSING',message:'文章缺少必要的内容结构，不能开始写作。'});
  const selected = new Set();
  for (const section of sections) {
    for (const key of section.claim_keys || []) {
      selected.add(key);
      if (!facts.has(key)) errors.push({code:'PLAN_EVIDENCE_UNKNOWN',section:section.heading,key,message:'大纲引用了批准范围之外或不存在的证据。'});
      else if (facts.get(key).consensus_status === 'conflicted') errors.push({code:'PLAN_EVIDENCE_CONFLICT',section:section.heading,key,message:'大纲仍使用严格冲突证据，需调整选证据。'});
    }
  }
  if (!selected.size) errors.push({code:'PLAN_EVIDENCE_MISSING',message:'大纲未为文章承诺关联任何可追溯证据。'});
  return {valid:!errors.length,errors,selectedFactKeys:[...selected],scope:contentPackage.approved_proposal || null,
    semanticSupport:'Writing and semantic QA must still verify that cited evidence actually supports each statement; key existence alone is not proof.'};
}
