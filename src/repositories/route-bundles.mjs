import { compileRouteBundle, routeError, routeHash, assertFrozenRoute } from '../route-bundle.mjs';
import { transaction } from '../db.mjs';

export function currentRouteBundle(db, ownerId) {
  const row=db.prepare('SELECT bundle_json FROM route_bundles WHERE owner_id=? ORDER BY revision DESC LIMIT 1').get(ownerId);
  return row ? JSON.parse(row.bundle_json) : null;
}

// This entry consumes a stored approval, not a model's approved=true field.
// Changing a previously frozen scope requires a different approval record.
export function persistRouteBundle(db,{candidateId,ownerId,fragments,approval,mediaAvailability,mediaObligations=[]}) {
  return transaction(db,()=>{
    const current=currentRouteBundle(db,ownerId);
    const routeId=current?.route_id || `route_${routeHash({candidateId,ownerId}).slice(0,24)}`;
    const candidate=compileRouteBundle({routeId,revision:current?.revision || 1,fragments,approval,mediaAvailability,mediaObligations});
    if(current?.content_hash===candidate.content_hash) return current;
    if(current?.status==='FROZEN' && candidate.approved_route_hash!==current.approved_route_hash
      && current.approval.record_id===approval.record_id) throw routeError('ROUTE_CHANGE_APPROVAL_REQUIRED',{
        expected:current.approved_route_hash,actual:candidate.approved_route_hash,action:'Retain the approved route and submit a separate scope/evidence revision.'});
    // Media-only inventory refresh is not a route revision. Frozen snapshots remain immutable.
    if(current?.status==='FROZEN' && candidate.approved_route_hash===current.approved_route_hash) {
      if(candidate.status!=='FROZEN') throw routeError(candidate.status,candidate.diagnostics);
      return current;
    }
    const bundle=compileRouteBundle({routeId,revision:(current?.revision || 0)+1,fragments,approval,mediaAvailability,mediaObligations});
    db.prepare(`INSERT INTO route_bundles(route_id,revision,candidate_id,owner_id,approved_route_hash,content_hash,status,bundle_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,datetime('now'))`).run(routeId,bundle.revision,candidateId,ownerId,bundle.approved_route_hash,
      bundle.content_hash,bundle.status,JSON.stringify(bundle));
    return bundle;
  });
}

export function saveRouteArtifact(db,{bundle,kind,contentHash,receipt,mediaPath=null,fileHash=null}) {
  assertFrozenRoute(bundle);
  const current=db.prepare('SELECT approved_route_hash,revision FROM route_bundles WHERE route_id=? ORDER BY revision DESC LIMIT 1').get(bundle.route_id);
  if(!current || current.revision!==bundle.revision || current.approved_route_hash!==bundle.approved_route_hash)
    throw routeError('ROUTE_VERSION_STALE',{route_id:bundle.route_id,revision:bundle.revision});
  const id=`route_artifact_${routeHash({route:bundle.content_hash,kind,contentHash,receipt,fileHash}).slice(0,32)}`;
  db.prepare(`INSERT OR IGNORE INTO route_artifacts(id,route_id,route_revision,approved_route_hash,artifact_kind,content_hash,
    media_path,file_sha256,receipt_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))`)
    .run(id,bundle.route_id,bundle.revision,bundle.approved_route_hash,kind,contentHash,mediaPath,fileHash,JSON.stringify(receipt));
  return id;
}
