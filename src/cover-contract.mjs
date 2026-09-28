import {mediaHash} from './web-media.mjs';

export function inspectCoverContract(snapshot) {
  if(!snapshot)return {status:'missing',delivery_enabled:false,receiver_status:'NOT_TESTED',fields:{featuredMediaId:false,cardTitle:false,deck:false}};
  try {
    const registry=JSON.parse(snapshot.registry_json),page=JSON.parse(snapshot.page_schema_json),publish=JSON.parse(snapshot.publish_package_schema_json);
    const calculated=mediaHash(JSON.stringify([registry,page,publish]));
    const pinned=/^[a-f0-9]{40}$/i.test(snapshot.frontend_commit_sha || '');
    const integrity=calculated===snapshot.artifact_checksum;
    const fields=page.properties?.metadata?.properties || {};
    return {status:pinned && integrity?'pinned_cache_verified':'unverified_cache',delivery_enabled:false,
      frontend_commit_sha:snapshot.frontend_commit_sha,contract_version:snapshot.contract_version,
      artifact_sha256:calculated,stored_artifact_sha256:snapshot.artifact_checksum,pinned,integrity,
      registry_sha256:mediaHash(snapshot.registry_json),page_schema_sha256:mediaHash(snapshot.page_schema_json),
      publish_schema_sha256:mediaHash(snapshot.publish_package_schema_json),receiver_status:'NOT_TESTED',
      media_capacity:pinned&&integrity&&Number.isInteger(publish.properties?.media?.maxItems)?publish.properties.media.maxItems:null,
      fields:Object.fromEntries(['featuredMediaId','cardTitle','deck'].map(key=>[key,pinned && integrity && Object.hasOwn(fields,key)])),
      mapping:{source_media_id:'internal_only',parent_hash:'internal_only',derivative_hash:'internal_only',
        purpose:'internal_only',crop:'internal_only',focal:'internal_only',policy_version:'internal_only',locked:'internal_only',
        featured_media_id:'page.metadata.featuredMediaId only after receiver verification',
        card_title:'internal_only_until_verified',deck:'internal_only_until_verified'},
      fallback:'preserve existing title, excerpt, body and published article; block selected-cover delivery'};
  } catch {
    return {status:'invalid_cache',delivery_enabled:false,receiver_status:'NOT_TESTED',fields:{featuredMediaId:false,cardTitle:false,deck:false}};
  }
}

export function readCoverContract(db) {
  return inspectCoverContract(db.prepare(`SELECT fc.* FROM frontend_contract_state state
    JOIN frontend_contract_snapshots fc ON fc.id=state.active_snapshot_id WHERE state.singleton=1`).get());
}
