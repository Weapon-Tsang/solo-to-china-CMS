import crypto from "node:crypto";

const SCOPES = new Map([
  ["presentation", "compose_frontend_page"],
  ["commercial", "compose_commercial"],
  ["media", "generate_visuals"],
]);

export class DeliveryRefreshError extends Error {
  constructor(code, message, details = null, statusCode = 409) {
    super(message);
    this.name = "DeliveryRefreshError";
    this.code = code;
    this.details = details;
    this.statusCode = statusCode;
  }
}

export function deliveryRefreshScopeForJob(repository, job) {
  let current = job || null;
  const seen = new Set();
  for (let depth = 0; current && depth < 32; depth += 1) {
    const match = String(current.dedupe_key || "").match(/^delivery-refresh:(presentation|commercial|media|editorial):/);
    if (match) return match[1];
    const parentId = current.parent_job_id;
    if (!parentId || seen.has(parentId)) break;
    seen.add(parentId);
    current = repository?.db?.prepare("SELECT id,dedupe_key,parent_job_id FROM jobs WHERE id=?").get(parentId) || null;
  }
  return null;
}

// Editorial refreshes of an already published post are intentionally not exposed
// through the draft-only refresh endpoint. A guarded operator migration supplies
// the original WordPress receipt fingerprint in the root Job key; descendants
// inherit it through parent_job_id so the final delivery can fail closed if the
// published page changed in the meantime.
export function editorialRefreshBaselineForJob(repository, job) {
  let current = job || null;
  const seen = new Set();
  for (let depth = 0; current && depth < 32; depth += 1) {
    const match = String(current.dedupe_key || "").match(/^delivery-refresh:editorial:[^:]+:r\d+:([a-f0-9]{64})$/);
    if (match) return match[1];
    const parentId = current.parent_job_id;
    if (!parentId || seen.has(parentId)) break;
    seen.add(parentId);
    current = repository?.db?.prepare("SELECT id,dedupe_key,parent_job_id FROM jobs WHERE id=?").get(parentId) || null;
  }
  return null;
}

export function wordpressReceiptFingerprint(receipt) {
  return crypto.createHash('sha256').update(`${String(receipt?.modified_gmt || '')}|${String(receipt?.page_payload_hash || '')}`).digest('hex');
}

export function assertWordPressDeliveryScope(receipt, draftId, scope) {
  if (scope === 'editorial' && !receipt) {
    throw Object.assign(new Error('The guarded editorial refresh has no existing WordPress receipt.'),
      {code:'WORDPRESS_EDITORIAL_REFRESH_TARGET_CHANGED',retryable:false});
  }
  if (!receipt) return;
  if (receipt.cms_draft_id && receipt.cms_draft_id !== draftId) {
    throw Object.assign(new Error('Existing WordPress post belongs to another CMS draft.'),
      {code:'WORDPRESS_REFRESH_IDENTITY_MISMATCH',retryable:false});
  }
  if (receipt.status === 'publish' && !['media','editorial'].includes(scope)) {
    throw Object.assign(new Error('A published WordPress post requires a guarded, explicitly scoped refresh.'),
      {code:'WORDPRESS_PUBLISHED_REFRESH_SCOPE_REQUIRED',retryable:false});
  }
  if (scope === 'editorial' && receipt.status !== 'publish') {
    throw Object.assign(new Error('The guarded editorial refresh no longer targets a published post.'),
      {code:'WORDPRESS_EDITORIAL_REFRESH_TARGET_CHANGED',retryable:false});
  }
}

export function deliveryRefreshContinuation(repository, job, completedStage) {
  const scope = deliveryRefreshScopeForJob(repository, job);
  if (completedStage === "compose_frontend_page" && ["presentation", "media"].includes(scope)) {
    return "compose_commercial";
  }
  return null;
}

export function planDeliveryRefresh(repository, input = {}) {
  const scope = String(input.scope || "presentation");
  const stage = SCOPES.get(scope);
  if (!stage) throw new DeliveryRefreshError("DELIVERY_REFRESH_SCOPE_INVALID", "scope must be presentation, commercial, or media.", null, 400);
  const draftIds = [...new Set((Array.isArray(input.draft_ids) ? input.draft_ids : []).map(String).filter(Boolean))];
  if (!draftIds.length || draftIds.length > 20) {
    throw new DeliveryRefreshError("DELIVERY_REFRESH_WHITELIST_REQUIRED", "Choose an explicit whitelist of 1-20 draft IDs.", null, 400);
  }
  const inventoryRows = repository.listWordPressInventory();
  const sync = repository.getWordPressSyncState(inventoryRows[0]?.site_url || "");
  const syncAgeMs = sync?.last_succeeded_at ? Date.now() - Date.parse(sync.last_succeeded_at) : Number.POSITIVE_INFINITY;
  const inventoryFresh = Number.isFinite(syncAgeMs) && syncAgeMs >= 0 && syncAgeMs <= 10 * 60_000;
  const inventory = new Map(inventoryRows.map((row) => [Number(row.post_id), row]));
  const items = draftIds.map((draftId) => {
    const pkg = repository.getDraftPackage(draftId);
    if (!pkg?.draft) return { draft_id:draftId, disposition:"blocked", reason:"draft_not_found", planned_stage:null };
    const publication = pkg.publication || null;
    const postId = Number(publication?.post_id || 0) || null;
    const remote = safeJson(publication?.response_json);
    const wordpress = postId ? inventory.get(postId) : null;
    const activeJob = repository.db.prepare("SELECT id,type,status FROM jobs WHERE entity_id=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1").get(draftId);
    const media=scope === "media" && typeof repository.mediaRepairPlan === "function" ? repository.mediaRepairPlan(draftId) : null;
    let disposition = "eligible";
    let reason = "whitelisted_incremental_refresh";
    if (!inventoryFresh) { disposition="blocked"; reason="wordpress_inventory_not_fresh"; }
    else if (!pkg.review?.passed) { disposition="blocked"; reason="current_draft_has_not_passed_qa"; }
    else if (!pkg.frontend_page?.current) { disposition="blocked"; reason="current_frontend_page_missing"; }
    else if (!publication || !postId) { disposition="blocked"; reason="wordpress_mapping_missing"; }
    else if (remote.status && remote.status !== "draft") { disposition="diagnose_only"; reason="stored_wordpress_response_is_not_draft"; }
    else if (!wordpress) { disposition="blocked"; reason="wordpress_inventory_mapping_missing"; }
    else if (wordpress.status !== "draft") { disposition="diagnose_only"; reason="wordpress_post_is_not_draft"; }
    else if (wordpress.title !== pkg.draft.title) { disposition="conflict"; reason="wordpress_title_changed_outside_cms"; }
    else if (wasModifiedAfterDelivery(wordpress.modified_at, publication.updated_at)) { disposition="conflict"; reason="wordpress_draft_changed_outside_cms"; }
    else if (activeJob) { disposition="conflict"; reason="active_job_exists"; }
    return {
      draft_id:draftId,title:pkg.draft.title,revision:Number(pkg.draft.revision),content_hash:pkg.draft.content_hash,
      page_id:pkg.frontend_page.id,page_content_hash:pkg.frontend_page.draft_content_hash,
      wordpress_post_id:postId,wordpress_status:wordpress?.status || null,wordpress_modified_at:wordpress?.modified_at || null,
      publication_updated_at:publication?.updated_at || null,disposition,reason,
      planned_stage:disposition === "eligible" ? stage : null,
      media,
      preserve:{ body_sha256:sha256(pkg.draft.body_markdown || ""),
        visual_fingerprint_sha256:sha256((pkg.draft.visuals || []).map((item) => item.asset_fingerprint || item.id).join("|")) },
    };
  });
  const fingerprintInput = { scope,inventory_synced_at:sync?.last_succeeded_at || null,
    media_plan_hashes:items.map((item)=>item.media?.plan_hash || null),
    items:items.map(({ draft_id,revision,content_hash,page_id,page_content_hash,wordpress_post_id,wordpress_status,wordpress_modified_at,disposition,reason }) =>
      ({ draft_id,revision,content_hash,page_id,page_content_hash,wordpress_post_id,wordpress_status,wordpress_modified_at,disposition,reason })) };
  return { mode:"dry_run",scope,inventory:{ fresh:inventoryFresh,synced_at:sync?.last_succeeded_at || null },
    safeguards:["explicit whitelist","fresh WordPress inventory","draft-only","external-edit conflict stop","frozen body","reuse existing media","bounded stage","idempotent recovery run"],
    confirmation:sha256(JSON.stringify(fingerprintInput)),items,
    summary:Object.fromEntries(["eligible","blocked","conflict","diagnose_only"].map((key) => [key,items.filter((item) => item.disposition === key).length])) };
}

export function applyDeliveryRefresh(repository, input = {}, actor = "administrator") {
  const plan = planDeliveryRefresh(repository, input);
  if (!input.confirmation || input.confirmation !== plan.confirmation) {
    throw new DeliveryRefreshError("DELIVERY_REFRESH_CONFIRMATION_MISMATCH", "The reviewed delivery-refresh fingerprint is missing or stale.", { expected:plan.confirmation });
  }
  const ineligible = plan.items.filter((item) => item.disposition !== "eligible");
  if (ineligible.length) {
    throw new DeliveryRefreshError("DELIVERY_REFRESH_PREFLIGHT_FAILED", "Every whitelisted draft must pass the same fresh preflight before any Job is queued.", { items:ineligible });
  }
  const timestamp = new Date().toISOString();
  const queued = [];
  repository.db.exec("BEGIN IMMEDIATE");
  try {
    for (const item of plan.items) {
      const recoveryRunId = `delivery_refresh_${sha256(`${plan.scope}:${item.draft_id}:${item.revision}:${plan.confirmation}`).slice(0,24)}`;
      if (plan.scope === "commercial") repository.db.prepare("UPDATE commercial_compositions SET refresh_required=1,refresh_reason='operator_scoped_repair',updated_at=? WHERE draft_id=?").run(timestamp,item.draft_id);
      if (plan.scope === "media") repository.prepareMediaRepair?.(item.draft_id);
      const owner = repository.db.prepare(`SELECT tc.opportunity_id FROM article_drafts ad JOIN content_briefs cb ON cb.id=ad.brief_id
        LEFT JOIN topic_candidates tc ON tc.id=cb.candidate_id WHERE ad.id=?`).get(item.draft_id)?.opportunity_id || null;
      const jobId = repository.enqueue(item.planned_stage,item.draft_id,{ dedupeKey:`delivery-refresh:${plan.scope}:${item.draft_id}:r${item.revision}:${plan.confirmation.slice(0,12)}`,
        workloadClass:"historical_recovery",recoveryRunId,productionOwnerOpportunityId:owner });
      queued.push({ draft_id:item.draft_id,job_id:jobId,recovery_run_id:recoveryRunId,stage:item.planned_stage,actor });
    }
    repository.db.exec("COMMIT");
  } catch (error) {
    repository.db.exec("ROLLBACK");
    throw error;
  }
  return { ...plan,mode:"apply",queued };
}

function wasModifiedAfterDelivery(modifiedAt, publicationUpdatedAt) {
  const modified = Date.parse(String(modifiedAt || ""));
  const delivered = Date.parse(String(publicationUpdatedAt || ""));
  if (!Number.isFinite(modified) || !Number.isFinite(delivered)) return true;
  return modified - delivered > 15_000;
}

function sha256(value) { return crypto.createHash("sha256").update(String(value || "")).digest("hex"); }
function safeJson(value) { try { return JSON.parse(value || "{}"); } catch { return {}; } }
