import { transaction } from '../db.mjs';
import { currentRouteBundle, persistRouteBundle } from './route-bundles.mjs';
import { compileRouteBundle, routeHash, routeSemantics, routeError } from '../route-bundle.mjs';

const parse=value=>JSON.parse(value || '{}');
const inputError=field=>Object.assign(new Error(`Invalid route decision input: ${field}`),{code:'ROUTE_DECISION_INPUT',statusCode:400});
function validateScope(scope) {
  const ids=value=>Array.isArray(value) && value.length>0 && value.length<=120 && value.every(id=>typeof id==='string' && id.length>0 && id.length<=500);
  if(!scope || !['source_route_adaptation','evidence_composed_route'].includes(scope.mode) || !ids(scope.fragment_ids))throw inputError('route_scope');
  if(scope.mode==='source_route_adaptation' && scope.fragment_ids.length!==1)throw inputError('fragment_ids');
  if(scope.mode==='evidence_composed_route') {
    if(!Array.isArray(scope.days) || !scope.days.length || scope.days.length>30)throw inputError('days');
    for(const day of scope.days) {
      if(!day || !ids([day.source_day_id]) || typeof day.label!=='string' || !day.label.trim() || day.label.length>80
        || !ids(day.stop_ids) || !Array.isArray(day.leg_ids) || day.leg_ids.length>120)throw inputError('day');
      for(const leg of day.leg_ids)if(typeof leg==='string' ? !ids([leg]) : (!leg || !ids([leg.evidence_leg_id,leg.from_stop_id,leg.to_stop_id])))throw inputError('leg');
    }
  }
}
function ownerRecord(db,ownerId) {
  const owner=db.prepare('SELECT * FROM content_opportunities WHERE id=? AND approved_at IS NOT NULL').get(ownerId);
  if(!owner)throw Object.assign(new Error('Approved production owner not found.'),{statusCode:404});
  return owner;
}
function assertVersion(current,expected) {
  if(!current)throw routeError('ROUTE_SNAPSHOT_REQUIRED',{action:'Historical article remains read-only; establish an evidence-backed snapshot separately.'});
  if(current.content_hash!==expected)throw routeError('ROUTE_VERSION_STALE',{expected,current:current.content_hash});
}
function writeArtifact(db,bundle,id,kind,receipt) {
  db.prepare(`INSERT INTO route_artifacts(id,route_id,route_revision,approved_route_hash,artifact_kind,content_hash,receipt_json,created_at)
    VALUES (?,?,?,?,?,?,?,datetime('now'))`).run(id,bundle.route_id,bundle.revision,bundle.approved_route_hash,kind,routeHash(receipt),JSON.stringify(receipt));
}
function diff(before,after) {
  const result=[];
  for(const collection of ['days','stops','legs','branches']) {
    const a=before[collection] || [],b=after[collection] || [];
    for(let index=0;index<Math.max(a.length,b.length);index++) {
      for(const field of new Set([...Object.keys(a[index] || {}),...Object.keys(b[index] || {})])) {
        if(routeHash(a[index]?.[field])!==routeHash(b[index]?.[field]))
          result.push({field:`${collection}[${index}].${field}`,before:a[index]?.[field] ?? null,after:b[index]?.[field] ?? null});
      }
    }
  }
  return result;
}
function receiptRows(db,routeId,kind) {
  return db.prepare('SELECT id,content_hash,receipt_json,created_at FROM route_artifacts WHERE route_id=? AND artifact_kind=? ORDER BY created_at DESC,id DESC')
    .all(routeId,kind).map(row=>({id:row.id,proposal_hash:row.content_hash,created_at:row.created_at,...parse(row.receipt_json)}));
}
export function routeDecisionState(repository,ownerId) {
  const {db}=repository,owner=ownerRecord(db,ownerId),current=currentRouteBundle(db,ownerId);
  let articleRoute=null;
  if(current) {
    const artifact=db.prepare(`SELECT rb.bundle_json FROM route_artifacts ra JOIN route_bundles rb
      ON rb.route_id=ra.route_id AND rb.revision=ra.route_revision
      JOIN article_drafts ad ON ad.id=json_extract(ra.receipt_json,'$.draft_id') AND ad.content_hash=ra.content_hash
      JOIN content_briefs cb ON cb.id=ad.brief_id AND cb.candidate_id=?
      WHERE ra.route_id=? AND ra.artifact_kind='draft'
      ORDER BY ad.updated_at DESC,ra.route_revision DESC LIMIT 1`).get(owner.candidate_id,current.route_id);
    articleRoute=artifact?parse(artifact.bundle_json):null;
  }
  const decisions=current?receiptRows(db,current.route_id,'route_decision'):[];
  const proposals=current?receiptRows(db,current.route_id,'route_proposal').map(proposal=>{
    const decision=decisions.find(d=>d.proposal_id===proposal.id);
    return {...proposal,status:decision?.decision || (proposal.base_hash===current.content_hash?'pending':'stale'),decision:decision || null};
  }):[];
  const fragments=current?repository.currentRouteFragments(repository.getTopicPackage(owner.candidate_id,{opportunityId:ownerId})):[];
  return {owner_id:ownerId,current,article_route:articleRoute,article_route_status:articleRoute?'snapshot':'unknown',
    body_preserved:true,fragments,proposals,can_propose:Boolean(current && fragments.length)};
}

export function proposeRouteRevision(repository,ownerId,payload,actor) {
  if(!payload || typeof payload!=='object' || Array.isArray(payload))throw inputError('payload');
  const {db}=repository;
  return transaction(db,()=>{
    const owner=ownerRecord(db,ownerId),current=currentRouteBundle(db,ownerId);
    if(typeof payload.idempotency_key!=='string' || !/^[\w-]{8,100}$/.test(payload.idempotency_key))throw inputError('idempotency_key');
    if(typeof payload.reason!=='string' || !payload.reason.trim() || payload.reason.length>1000)throw inputError('reason');
    validateScope(payload.route_scope);
    const requestHash=routeHash({expected_hash:payload.expected_hash,route_scope:payload.route_scope,reason:payload.reason.trim()});
    const id=`route_proposal_${routeHash({ownerId,key:payload.idempotency_key}).slice(0,32)}`;
    const existing=db.prepare('SELECT receipt_json FROM route_artifacts WHERE id=?').get(id);
    if(existing) {
      const receipt=parse(existing.receipt_json);
      if(receipt.request_hash!==requestHash)throw routeError('ROUTE_IDEMPOTENCY_CONFLICT',{id});
      return {id,proposal_hash:routeHash(receipt),...receipt};
    }
    assertVersion(current,payload.expected_hash);
    const coverage=parse(owner.coverage_json),scope={...(coverage.approval?.proposal || current.approval.scope),route_scope:payload.route_scope};
    const topic=repository.getTopicPackage(owner.candidate_id,{opportunityId:ownerId});
    const fragments=repository.currentRouteFragments(topic);
    const approval={record_id:id,scope};
    const target=compileRouteBundle({routeId:current.route_id,revision:current.revision+1,fragments,approval,
      mediaAvailability:current.media_availability,mediaObligations:current.media_obligations});
    const receipt={owner_id:ownerId,base_hash:current.content_hash,base_revision:current.revision,request_hash:requestHash,
      reason:payload.reason.trim(),actor,scope,source_hash:routeHash(fragments),target,
      differences:diff(routeSemantics(current),routeSemantics(target)),body_preserved:true};
    writeArtifact(db,current,id,'route_proposal',receipt);
    return {id,proposal_hash:routeHash(receipt),...receipt};
  });
}

export function decideRouteRevision(repository,ownerId,proposalId,payload,actor) {
  if(!payload || typeof payload!=='object' || Array.isArray(payload))throw inputError('payload');
  const {db}=repository;
  return transaction(db,()=>{
    const owner=ownerRecord(db,ownerId),current=currentRouteBundle(db,ownerId);
    if(!['approve_route_revision','reject_route_revision'].includes(payload.decision))throw inputError('decision');
    if(payload.authority!=='route_revision')throw Object.assign(new Error('Media-only permission cannot change a route.'),{code:'ROUTE_REVISION_PERMISSION_REQUIRED',statusCode:403});
    const row=db.prepare("SELECT * FROM route_artifacts WHERE id=? AND artifact_kind='route_proposal'").get(proposalId);
    if(!row || row.route_id!==current?.route_id)throw Object.assign(new Error('Route proposal not found.'),{statusCode:404});
    if(payload.proposal_hash!==row.content_hash)throw routeError('ROUTE_PROPOSAL_STALE',{proposal_id:proposalId});
    const proposal=parse(row.receipt_json),decisionId=`route_decision_${routeHash(proposalId).slice(0,32)}`;
    const existing=db.prepare('SELECT receipt_json FROM route_artifacts WHERE id=?').get(decisionId);
    if(existing) {
      const receipt=parse(existing.receipt_json);
      if(receipt.decision!==payload.decision)throw routeError('ROUTE_ALREADY_DECIDED',{proposal_id:proposalId});
      return receipt;
    }
    assertVersion(current,payload.expected_hash);
    if(current.content_hash!==proposal.base_hash)throw routeError('ROUTE_VERSION_STALE',{proposal_id:proposalId});
    let approved=null;
    if(payload.decision==='approve_route_revision') {
      const fragments=repository.currentRouteFragments(repository.getTopicPackage(owner.candidate_id,{opportunityId:ownerId}));
      if(routeHash(fragments)!==proposal.source_hash)throw routeError('ROUTE_SOURCE_STALE',{proposal_id:proposalId});
      if(proposal.target.status!=='FROZEN')throw routeError(proposal.target.status,proposal.target.diagnostics);
      const coverage=parse(owner.coverage_json);
      coverage.approval={...(coverage.approval || {}),proposal:proposal.scope,route_decision_id:decisionId};
      const approval={record_id:`${owner.id}:${owner.approved_at}:${routeHash(coverage.approval)}`,scope:proposal.scope};
      approved=persistRouteBundle(db,{candidateId:owner.candidate_id,ownerId,fragments,approval,
        mediaAvailability:current.media_availability,mediaObligations:current.media_obligations});
      repository.assertCurrentRoute(approved);
      db.prepare('UPDATE content_opportunities SET coverage_json=?,updated_at=datetime(\'now\') WHERE id=?').run(JSON.stringify(coverage),ownerId);
    }
    const receipt={proposal_id:proposalId,decision:payload.decision,actor,base_hash:proposal.base_hash,
      approved_hash:approved?.approved_route_hash || null,approved_revision:approved?.revision || null,
      body_preserved:true,jobs_queued:0};
    writeArtifact(db,current,decisionId,'route_decision',receipt);
    return receipt;
  });
}
