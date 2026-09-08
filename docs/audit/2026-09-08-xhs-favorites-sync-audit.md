# Xiaohongshu Favorites Sync vNext audit and implementation record

Date: 2026-09-08  
Release: CMS/Extension 1.17.1
Schema: migrations 1–35  
Content Strategy: 1.5 (unchanged)

## 1. Audit Summary

The former Extension ran inside the popup and supported only an explicit single-note Save. The audit found no recoverable Favorites session, no batched identity API, no collection checkpoint, no durable browser queue, no full-history streaming, fixed/serial capture behavior, and several Source-total truncation risks in DOM/text/media/model preparation. Source and media authorization/provenance were too coarse for the confirmed Favorites product semantics, and concurrent capture/job writes needed database-level idempotency.

The implementation keeps one CMS and one durable SQLite Job system. Browser acquisition is now a separate persistent MV3 workflow; accepted Captures immediately hand off to the existing asynchronous Research pipeline. Recommendations remain the only article-production approval.

## 2. Architecture Changes

- Added `extension/background.js` as the service-worker orchestrator, `extension/sync-core.js` for deterministic state/identity/concurrency logic, and `extension/page-extractor.js` for centralized page selectors and complete extraction.
- Persists one active profile session, per-Scope checkpoint, bounded discovery windows, browser queue, task state, retries, worker tabs, progress, and recent summaries in `chrome.storage.local`.
- Reuses bounded worker tabs and the existing server `jobs` queue. No second CMS worker system was introduced.
- Serializes browser state mutations so pause/cancel/recovery cannot be overwritten by stale concurrent task snapshots.

## 3. Database / Migration Changes

Migration 35 adds:

- Source acquisition origin, sync scope, Extension version, completeness manifest/status, rights, and availability metadata.
- Asset media identity, dimensions/duration, original and derivative hashes, rights, and provenance.
- Immutable `capture_versions` snapshots and Capture Version-aware Source segments.
- Stable Xiaohongshu `(adapter, external_id)` uniqueness.
- Active Job `dedupe_key` uniqueness for `extract_source:{sourceId}:{captureVersion}` race safety.
- `favorites_sync_runs` aggregate observability without account credentials or browser session state.

The migration first resolves pre-existing active duplicate Jobs before creating the partial unique index. Existing Sources and Assets are backfilled into version/provenance structures.

## 4. API Changes

- `POST /api/captures/identity-check`: one query for up to 100 identities.
- `POST /api/capture-uploads`, `PUT /api/capture-uploads/:id/chunks/:index`, `POST /api/capture-uploads/:id/complete`: exact-size, SHA-256-verified large JSON capture persistence with stale-session cleanup.
- `GET/POST /api/favorites-sync-runs`: authenticated aggregate run summaries.
- Direct `/api/captures` remains available for smaller payloads and manual Save.

## 5. Extension Changes

- Popup now starts incremental or full historical sync, shows Scope/progress/history, pauses, resumes, cancels, stops after current queue, configures Auto Sync/concurrency/batches, and retains **Save Current Note**.
- Favorites cards are identity-only discovery records. Detail tabs perform ordinary navigation, wait for stable DOM, expand content, traverse lazy media/carousels, and capture full text/DOM/media manifests.
- Board discovery uses the visible card's short-lived per-note navigation URL so Xiaohongshu can open the same detail the user selected. Only the token-free canonical identity reaches CMS storage; terminal queue compaction removes the local navigation URL.
- Login/verification pages pause the full session; 404 fails one item; transient network/5xx/rate-limit errors use bounded backoff.
- The manifest requests `tabs`, `alarms`, Xiaohongshu page/media hosts, and Engine hosts; it does not request `cookies`.

## 6. Incremental Sync Algorithm

Discovery starts at the newest Favorites window, canonicalizes each Note, deduplicates by `xiaohongshu:{externalId}`, and sends identities in configurable batches (default 50). Incremental stop requires all three conditions: the prior reliable checkpoint was observed, at least 12 consecutive stable known identities were seen, and the current window contains no new Note. Reordering or a new Note resets the safe stop condition.

Full historical sync uses the same bounded batches and queue high-water backpressure but has no session-total cap. It continues until collection end, cancellation, login/verification pause, or a recoverable failure. Collection end must be observed in two consecutive discovery passes so a transient lazy-load gap cannot truncate a historical backfill.

## 7. Queue / Concurrency / Retry Strategy

Browser acquisition states are queued/opening/loading/extracting/submitting/captured or duplicate, with retry_wait/failed/paused/cancelled paths. Successful tasks survive pause, cancel, service-worker restart, and Chrome restart. Concurrency starts from PC capacity within 4–8 and may grow to 12 after sustained healthy work; latency/errors/access pressure reduce it.

CMS extraction adapts within 4–8, continues to use durable leases/heartbeats/CAS completion, and respects Retry-After/backpressure. Capture acceptance advances browser work without waiting for AI.

## 8. Rights / Security Changes

`xhs_favorites_sync` and `xhs_manual_extension` set owner-confirmed commercial-use, editing, redistribution, derivative, and publishable rights for text/images/videos with full Source/Asset provenance. Other origins do not inherit these rights. No username/password/Cookie/LocalStorage token is collected, no private XHS API is a dependency, and CAPTCHA/verification is never bypassed.

## 9. Zero-Loss Changes

- Removed raw text/DOM and Source-total media slices/truncation.
- Content hash covers complete text/DOM and every media/file identity.
- Large Capture JSON uses chunked persistence instead of body-tail loss.
- All image batches and every video are submitted to supported model paths; per-call image size is not a Source-total cap.
- Oversized images preserve original URL/hash and a separately hashed AI derivative.
- Partial captures cannot queue extraction or become processed.
- Model output exhaustion subdivides only the affected text segment and retries both children.

## 10. Tests Added

Coverage includes identity/canonicalization, safe checkpoint stop, reordering, unlimited multi-batch backfill, recovery, adaptive concurrency, migration/backfill/indexes, concurrent idempotency, large chunked Capture fidelity, upload expiry, completeness/rights/provenance, long-text segmentation, multi-image batching, multi-video handling, oversized derivatives, output-token resegmentation, API auth/telemetry, and existing pipeline regressions.

Final automated results: `npm run check` passed; `npm test` passed 191/191; `npm run release:check` passed all 39 mandatory checks with zero failures and reported `READY FOR EXTENSION INTEGRATION`. The release gate included migrations 1–35, SQLite integrity, isolated HTTP/API/UI smoke, Extension static validation, and the real sibling Frontend Contract gate. Real signed-in Chrome/Xiaohongshu acceptance and configured external Kimi/WordPress/Search Console calls remain explicitly manual/external checks.

## 11. Documentation / Version

Updated README, Architecture, Manual Source Ingestion, Research Boundary, Operations, Content Strategy interpretation/changelog, Handoff, `.env.example`, Extension manifest, release checks, and deployment image examples. Content Strategy remains 1.5 because this changes intake transport and applies existing approval policy rather than changing editorial policy.

## 12. Known Limitations

- Real Xiaohongshu DOM selectors can change; centralized selectors and manual Save provide recovery, but a signed-in real-profile acceptance run remains manual.
- Chrome may throttle background tabs/service workers. Durable recovery preserves correctness, though throughput can vary.
- The Extension records original remote media identity/hash where readable; it does not introduce a separate long-term binary Asset Archiver.
- Auto Sync can run only when Chrome and the signed-in profile are available; login/verification requires the user.

## 13. Exact User Workflow After Upgrade

Daily: favorite useful Notes on mobile/PC.  
Sync: keep Chrome signed in, open the target Favorites collection, click **Sync New Favorites**, then close the popup if desired.  
First backfill: click **Full Historical Sync** and let the persistent queue run; pause/resume is safe.  
Fallback: open one Note and click **Save Current Note**.  
Editorial: review the resulting Recommendation; only **Approve article** starts content production.
