import { supplementMediaContext } from '../media-context.mjs';
import { sha256, now } from '../utils.mjs';
import { transaction } from '../db.mjs';

export const MEDIA_BINDING_POLICY = 'source-media-binding-4';
const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const aliasCatalogs = new WeakMap();

function aliasCatalog(db) {
  // Invalidate on local writes and commits from another connection. Never
  // cache a transaction's uncommitted interpretation (including rollbacks).
  const token = `${db.prepare('PRAGMA data_version').get().data_version}:${db.prepare('SELECT total_changes() n').get().n}`;
  const cached = !db.isTransaction && aliasCatalogs.get(db);
  if (cached?.token === token) return cached.rows;
  const rows = db.prepare('SELECT destination_slug,entity_key,canonical_subject,alias_normalized,aliases_json,entity_type,granularity FROM entity_aliases ORDER BY destination_slug,entity_key,id').all()
    .map(row => ({...row, names:[row.canonical_subject,row.alias_normalized,...JSON.parse(row.aliases_json || '[]')]
      .map(normalize).filter(name=>name.length>=2).map(name=>({name,han:/\p{Script=Han}/u.test(name)}))}));
  if (!db.isTransaction) aliasCatalogs.set(db,{token,rows});
  return rows;
}

function includesName(text, name) {
  const value=normalize(text);const alias=normalize(name);
  if(alias.length<2)return false;
  return /\p{Script=Han}/u.test(alias) ? value.includes(alias) : ` ${value} `.includes(` ${alias} `);
}

export function mediaEntityKeys(db, destination, text) {
  return [...new Set(aliasCatalog(db).filter(alias=>alias.destination_slug===destination
    && alias.names.some(({name})=>includesName(text,name))).map(alias=>alias.entity_key))];
}

// These predicates describe what the source asserts about this occurrence.
// They never relabel source assertions as independently observed pixels.
function typedEvidence(item) {
  const quote=item.quote;
  const relation_type=/\b(?:taken|captured|photographed) during\b|拍摄于.*(?:沿途|途中|航线)|沿途拍摄/iu.test(quote)
    ? 'captured_during_route'
    : /\billustrates? (?:the )?topic\b|主题示意|话题示意/iu.test(quote) ? 'illustrates_topic'
    : /\bmentions?\b|提及|提到/iu.test(quote) ? 'mentions_entity'
    : /\bdepicts?\b|画面展示|图中展示/iu.test(quote) ? 'depicts_entity' : 'source_asserts_location';
  const polarity=/\b(?:is not|does not depict|not at)\b|并非|不是|不在/iu.test(quote) ? 'contradicts' : 'supports';
  return {...item,relation_type,polarity,evidence_channel:'source_assertion'};
}

function allowedUses(type) {
  return type==='captured_during_route' ? ['route_context_photo']
    : type==='illustrates_topic' ? ['topic_illustration']
    : type==='mentions_entity' ? [] : ['stop_photo','route_context_photo'];
}

function evidenceForEntity(item, alias) {
  const text=normalize(item.quote);
  const opposed=alias.names.some(({name,han})=>{
    const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    return new RegExp(`(?:is not|not at|does not depict|不是|并非|不在)\\s*${escaped}${han ? '' : '(?: |$)'}`,'u').test(text);
  });
  return {...item,polarity:opposed ? 'contradicts' : 'supports',entity_key:alias.entity_key,
    destination_slug:alias.destination_slug,scope:'this_asset_occurrence_entity'};
}

function occurrenceEvidence(packet) {
  const context=packet.assets[0];
  return [...context.metadata.filter(item=>item.kind==='caption' && item.text && !item.truncated)
    .map(item=>({quote:item.text,locator:item.locator,strength:'explicit_caption'})),
    ...packet.blocks.filter(block=>context.explicit_block_ids.includes(block.id) && !block.truncated)
      .map(block=>({quote:block.text,locator:{source_id:context.source_id,capture_version:context.capture_version,
        asset_id:context.asset_id,block_id:block.id,start:block.start,end:block.end},strength:'explicit_image_reference'}))].map(typedEvidence);
}

/** Deterministic, scoped repair; never calls a provider or changes a draft. */
export function refreshSourceMediaBindings(db, sourceId, {dryRun = true, assetIds = null} = {}) {
  const source=db.prepare('SELECT id,capture_version,raw_text FROM sources WHERE id=?').get(sourceId);
  if(!source)throw new Error('Source not found.');
  if (assetIds !== null && (!Array.isArray(assetIds) || assetIds.length > 200
    || assetIds.some(id => typeof id !== 'string' || !id))) throw new Error('Invalid scoped media asset IDs.');
  const scopedIds = assetIds === null ? null : [...new Set(assetIds)];
  const assetColumns='id,source_id,capture_version,position,caption_text,nearby_text,alt_text,original_sha256,stored_sha256,provenance_json';
  const assets=scopedIds === null
    ? db.prepare(`SELECT ${assetColumns} FROM current_source_assets WHERE source_id=? AND kind='image' ORDER BY position,id`).all(sourceId)
    : scopedIds.flatMap(id => db.prepare(`SELECT ${assetColumns} FROM current_source_assets WHERE source_id=? AND id=? AND kind='image'`).all(sourceId,id));
  if (scopedIds && assets.length !== scopedIds.length) throw Object.assign(new Error('Asset does not belong to the current source capture.'),
    {code:'CONTEXT_STALE',statusCode:409});
  const aliases=aliasCatalog(db);
  const planned=assets.map(asset=>{
    const packet=supplementMediaContext(source,asset);const context=packet.assets[0];
    const directContextPending=context.metadata.some(item=>item.kind==='caption' && item.truncated)
      || packet.omitted_ranges.some(range=>context.explicit_block_ids.includes(range.block_id));
    // Include the context fingerprint in the row ID; old evidence is immutable.
    const evidence=[...context.metadata.filter(item=>item.kind==='caption' && item.text && !item.truncated)
      .map(item=>({quote:item.text,locator:item.locator,strength:'explicit_caption'})),
      ...packet.blocks.filter(block=>context.explicit_block_ids.includes(block.id) && !block.truncated)
        .map(block=>({quote:block.text,locator:{source_id:source.id,capture_version:source.capture_version,
          asset_id:asset.id,block_id:block.id,start:block.start,end:block.end},strength:'explicit_image_reference'}))].map(typedEvidence);
    const matches=new Map();
    const normalizedEvidence=evidence.map(item=>({item,text:normalize(item.quote)}));
    for(const alias of aliases){
      const proofs=normalizedEvidence.filter(({text})=>alias.names.some(({name,han})=>han
        ? text.includes(name) : ` ${text} `.includes(` ${name} `))).map(({item})=>evidenceForEntity(item,alias));
      if(proofs.length){
        const key=`${alias.destination_slug}:${alias.entity_key}`;
        const prior=matches.get(key);
        matches.set(key,{...alias,evidence:prior ? [...prior.evidence,...proofs] : proofs});
      }
    }
    const uncertain=evidence.some(item=>/\b(?:not|maybe|perhaps|possibly|unsure|similar)\b|不是|并非|可能|疑似|不确定|好像/iu.test(item.quote));
    // A different positive name alone is not a contradiction. Preserve only
    // explicit opposing evidence from byte-identical current occurrences.
    const peers=matches.size && context.original_sha256 ? db.prepare(`SELECT sa.*,s.raw_text FROM current_source_assets sa
      JOIN sources s ON s.id=sa.source_id WHERE sa.id<>? AND sa.kind='image'
      AND COALESCE(NULLIF(sa.original_sha256,''),sa.stored_sha256,'')=? ORDER BY sa.id LIMIT 101`)
      .all(asset.id,context.original_sha256) : [];
    const peerPackets=peers.slice(0,100).map(peer=>supplementMediaContext(
      {id:peer.source_id,capture_version:peer.capture_version,raw_text:peer.raw_text},peer));
    const peerPending=peerPackets.some(packet=>packet.assets[0].metadata.some(item=>item.kind==='caption' && item.truncated)
      || packet.omitted_ranges.some(range=>packet.assets[0].explicit_block_ids.includes(range.block_id)));
    const peerEvidence=peerPackets.flatMap(occurrenceEvidence);
    packet.peer_evidence_scope={checked_occurrences:peerPackets.length,has_more:peers.length>100,direct_context_pending:peerPending};
    for (const match of matches.values()) match.evidence.push(...peerEvidence.map(item=>evidenceForEntity(item,match))
      .filter(item=>item.polarity==='contradicts'));
    // Relevant alias changes produce a new binding revision without buying
    // image analysis or mutating an earlier confirmed interpretation.
    packet.source_context_hash=context.context_hash;
    context.context_hash=sha256(JSON.stringify([context.context_hash,context.original_sha256,MEDIA_BINDING_POLICY,
      [...matches.entries()].map(([key,match])=>[key,match.canonical_subject,match.entity_type,match.granularity,match.evidence]),peers.length>100,peerPending]));
    const occurrenceId=`${context.occurrence_id}_${context.context_hash.slice(0,16)}`;
    const bindings=[...matches.values()].flatMap(match=>[...new Set(match.evidence.map(item=>item.relation_type))].map(type=>{
      const proofs=match.evidence.filter(item=>item.relation_type===type);
      const sameScope=item=>item.relation_type===type || (['source_asserts_location','depicts_entity'].includes(type)
        && ['source_asserts_location','depicts_entity'].includes(item.relation_type));
      const scopedProofs=match.evidence.filter(sameScope);
      const opposed=scopedProofs.some(item=>item.polarity==='contradicts');
      return {
      id:`binding_${sha256(`${occurrenceId}:${match.destination_slug}:${match.entity_key}:${type}`).slice(0,32)}`,
      occurrence_id:occurrenceId,asset_id:asset.id,destination_slug:match.destination_slug,entity_key:match.entity_key,
      canonical_subject:match.canonical_subject,relation_type:type,
      subject_aliases:match.names.map(({name})=>name),
      // Retain the literal name matched in this occurrence. Duplicate alias
      // records can share a name without resolving to one canonical entity.
      matched_aliases:[...new Set(match.names.filter(({name})=>proofs.some(proof=>includesName(proof.quote,name)))
        .map(({name})=>name))],
      context_complete:!directContextPending && !peerPending && peers.length<=100,
      uncertain,
      // A list of places in a caption is not proof of a single depicted place.
      status:opposed ? (scopedProofs.some(item=>item.polarity==='supports') ? 'conflict' : 'candidate')
        : matches.size!==1 || uncertain ? 'ambiguous'
        : directContextPending || peerPending || peers.length>100 || match.granularity!=='specific_entity'
          || !['place','attraction','restaurant','hotel','transport_hub'].includes(match.entity_type) ? 'candidate' : 'confirmed',
      evidence:opposed ? scopedProofs : proofs,
      allowed_uses:allowedUses(type),
      prohibited_inferences:['precise_entrance','transport_connection','travel_time','route_order','author_visit_date'],
      actor:'deterministic_source_evidence',policy_version:MEDIA_BINDING_POLICY,
    };}));
    // A policy/context revision is not permission to undo an operator veto.
    const revoked = db.prepare("SELECT destination_slug,entity_key,relation_type FROM media_bindings WHERE asset_id=? AND status='revoked'").all(asset.id);
    for (const binding of bindings) if (revoked.some(row => row.destination_slug===binding.destination_slug
      && row.entity_key===binding.entity_key && row.relation_type===binding.relation_type)) binding.status='revoked';
    const supplement=JSON.parse(asset.provenance_json || '{}').supplement;
    if(supplement) {
      const parent=db.prepare('SELECT * FROM current_source_assets WHERE id=? AND source_id=?').get(supplement.parent_asset_id,sourceId);
      const valid=supplement.state==='confirmed' && parent?.mime_type==='application/pdf'
        && supplement.context_hash===sha256(JSON.stringify([parent.id,parent.source_id,parent.capture_version,
          parent.original_sha256 || parent.stored_sha256,source.raw_text,parent.provenance_json]));
      if(!valid) for(const binding of bindings) if(binding.status!=='revoked') binding.status='stale';
    }
    return {asset_id:asset.id,occurrence_id:occurrenceId,packet,context,bindings,
      reason:bindings.some(binding=>binding.status==='conflict') ? 'BINDING_CONFLICT'
        : bindings.some(binding=>binding.status==='revoked') ? 'BINDING_REVOKED'
        : bindings.some(binding=>binding.evidence.some(item=>item.polarity==='contradicts')) ? 'BINDING_NEGATED'
        : bindings.length ? (bindings.every(binding=>binding.status==='confirmed') ? 'SOURCE_BINDING_SUPPORTED'
        : bindings.some(binding=>binding.status==='ambiguous') ? 'BINDING_AMBIGUOUS' : 'BINDING_CANDIDATE')
        : evidence.length ? 'BINDING_ENTITY_UNRESOLVED' : packet.truncated ? 'CONTEXT_PENDING' : 'BINDING_EVIDENCE_MISSING'};
  });
  if(!dryRun)transaction(db,()=>{
    const timestamp=now();
    const occurrence=db.prepare(`INSERT OR IGNORE INTO media_occurrences
      (id,asset_id,source_id,capture_version,original_sha256,context_hash,context_json,status,policy_version,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const binding=db.prepare(`INSERT OR IGNORE INTO media_bindings
      (id,occurrence_id,asset_id,destination_slug,entity_key,canonical_subject,relation_type,status,evidence_json,
        allowed_uses_json,prohibited_inferences_json,actor,policy_version,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    db.prepare("UPDATE media_occurrences SET status='stale' WHERE source_id=? AND capture_version<>?").run(sourceId,source.capture_version);
    for(const item of planned){
      db.prepare("UPDATE media_occurrences SET status='stale' WHERE asset_id=? AND context_hash<>?").run(item.asset_id,item.context.context_hash);
      occurrence.run(item.occurrence_id,item.asset_id,sourceId,source.capture_version,item.context.original_sha256 || '',
        item.context.context_hash,JSON.stringify(item.packet),item.packet.status,MEDIA_BINDING_POLICY,timestamp);
      // A -> B -> A edits may reuse an immutable evidence identity. Restore its
      // current status, but never revive an operator-revoked relationship.
      db.prepare('UPDATE media_occurrences SET status=? WHERE id=?').run(item.packet.status,item.occurrence_id);
      for(const row of item.bindings)binding.run(row.id,row.occurrence_id,row.asset_id,row.destination_slug,row.entity_key,
        row.canonical_subject,row.relation_type,row.status,JSON.stringify(row.evidence),JSON.stringify(row.allowed_uses),
        JSON.stringify(row.prohibited_inferences),row.actor,row.policy_version,timestamp);
      for(const row of item.bindings)db.prepare("UPDATE media_bindings SET status=? WHERE id=? AND status='stale'").run(row.status,row.id);
    }
    db.prepare("UPDATE media_bindings SET status='stale' WHERE occurrence_id IN (SELECT id FROM media_occurrences WHERE source_id=? AND status='stale') AND status NOT IN ('revoked','stale')").run(sourceId);
  });
  return {source_id:sourceId,capture_version:source.capture_version,dry_run:dryRun,model_calls:0,
    assets:planned.map(item=>({asset_id:item.asset_id,occurrence_id:item.occurrence_id,context_hash:item.context.context_hash,
      context_status:item.packet.status,supplementation:item.packet.supplementation,reason:item.reason,bindings:item.bindings}))};
}

export function readMediaBindings(db, assetId) {
  const rows = db.prepare(`SELECT mb.*,mo.context_hash,mo.original_sha256,mo.capture_version,mo.status AS context_status
    FROM media_bindings mb JOIN media_occurrences mo ON mo.id=mb.occurrence_id
    JOIN source_assets sa ON sa.id=mb.asset_id JOIN sources s ON s.id=sa.source_id
    WHERE mb.asset_id=? AND mb.status='confirmed' AND mo.status<>'stale'
      AND mo.capture_version=sa.capture_version AND sa.capture_version=s.capture_version
      AND mo.original_sha256=COALESCE(NULLIF(sa.original_sha256,''),sa.stored_sha256,'')
      AND EXISTS (SELECT 1 FROM entity_aliases ea WHERE ea.destination_slug=mb.destination_slug
        AND ea.entity_key=mb.entity_key AND ea.canonical_subject=mb.canonical_subject AND ea.granularity='specific_entity')
    ORDER BY mb.id`).all(assetId);
  if (!rows.length) return [];
  // Read-time validation closes the interval between a caption/alias edit and
  // its next repair job. It is local, scoped and never writes or calls a model.
  const source = db.prepare('SELECT source_id FROM source_assets WHERE id=?').get(assetId);
  const planned = refreshSourceMediaBindings(db,source.source_id,{dryRun:true,assetIds:[assetId]});
  const valid = new Set(planned.assets.flatMap(asset => asset.bindings.filter(binding => binding.status === 'confirmed').map(binding => binding.id)));
  return rows.filter(row => valid.has(row.id)).map(row=>({...row,evidence:JSON.parse(row.evidence_json),
      allowed_uses:JSON.parse(row.allowed_uses_json),prohibited_inferences:JSON.parse(row.prohibited_inferences_json)}));
}

export function bindingSupportsPhoto(asset, request = {}) {
  if(bindingBlocksPhoto(asset,request)) return false;
  if (asset.mime_type === 'application/pdf') return false;
  if(asset.asset_kind!=='documentary_photo')return false;
  const text=`${request.image_subject || ''} ${request.purpose || ''} ${request.topic || ''}`;
  // General place identity must not silently certify a particular entrance or vessel.
  if(/\b(entrance|boarding|pier|vessel|platform|gate|diagram|map)\b|入口|登船|码头|检票|路线图/iu.test(text))return false;
  const use=request.media_purpose || request.media_metadata?.media_purpose || request.usage || request.role;
  if (use && !['stop_photo','route_context_photo','cover'].includes(use)) return false;
  return (asset.source_bindings || []).some(binding=>binding.status==='confirmed'
    && ['source_asserts_location','depicts_entity','captured_during_route'].includes(binding.relation_type)
    && binding.allowed_uses.includes(use==='cover' ? 'stop_photo' : use || 'stop_photo')
    && (!request.destination_slug || request.destination_slug===binding.destination_slug)
    && (request.entity_key ? request.entity_key===binding.entity_key : includesName(text,binding.canonical_subject)));
}

export function readMediaBindingIssues(db,assetId) {
  const asset=db.prepare('SELECT source_id FROM current_source_assets WHERE id=?').get(assetId);
  const vetoes=db.prepare(`SELECT DISTINCT destination_slug,entity_key,canonical_subject,relation_type,status
    FROM media_bindings WHERE asset_id=? AND status='revoked'`).all(assetId);
  if(!asset) return vetoes;
  return [...refreshSourceMediaBindings(db,asset.source_id,{assetIds:[assetId]}).assets[0].bindings
    .filter(row=>['conflict','revoked','ambiguous','candidate'].includes(row.status)),...vetoes];
}

export function bindingBlocksPhoto(asset,request={}) {
  const text=[request.image_subject,request.purpose,request.topic].filter(Boolean).join(' ');
  return (asset.source_binding_issues || []).some(row=>(['conflict','revoked'].includes(row.status)
      || row.evidence?.some(item=>item.polarity==='contradicts'))
    && (!request.destination_slug || request.destination_slug===row.destination_slug)
    && (request.entity_key ? request.entity_key===row.entity_key : includesName(text,row.canonical_subject)));
}
