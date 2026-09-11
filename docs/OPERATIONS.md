# V1 Operations

## Daily workflow

1. Select useful Xiaohongshu posts on mobile or desktop by adding them to the target Favorites collection.
2. In a signed-in desktop Chrome profile, open that collection and click **Sync New Favorites**. Use **Full Historical Sync** only for the first backfill or an explicit reconciliation. **Save Current Note** remains the selector-debugging and single-note fallback.
3. When Kimi has analyzed a useful Source, make one decision in **Recommendations**: **Approve article**, Knowledge only, Cluster, Research first, or Ignore. Only **Approve article** queues content planning.
4. Review only the **Exceptions** view when its count is non-zero.
5. Review final drafts in WordPress and publish manually.

No spreadsheet, manual source card, URL copy, tagging pass, or Knowledge Base maintenance is required.

## Favorites Sync operation

The popup may start, pause, resume, cancel, or stop after the current persisted queue. Closing the popup does not stop the MV3 background service worker workflow. A Chrome/service-worker restart changes unfinished work to a recoverable paused state; open the popup and click **Resume**. Successful tasks remain successful and are not submitted again.

Daily incremental discovery starts at the top and stops only after it has matched the saved Scope checkpoint, observed the configured consecutive-known streak, and found no new note in the current window. Full historical sync streams bounded discovery and identity batches until collection end and has no fixed session-total cap. The adaptive browser pool starts at 4–8 according to the PC and can grow to 12 under healthy load; access limits, timeouts, 429/5xx responses, and slow pages reduce pressure. Login walls or verification pages pause the whole session with an actionable state. The Extension never receives account credentials, requests browser cookies, or solves verification.

The CMS Sources list refreshes every five seconds while the durable queue is active. Each note shows its current or next extraction stage, active and remaining job counts, source-level waiting position, queue age, and a retry time when model pressure has placed work into cooldown. Queue order favors dependency-closing article/QA work and explicit realtime work, then gives jobs older than 15 minutes a fairness boost. Vertex Batch chooses the oldest eligible extraction or coverage class, with coverage winning ties, so sustained intake cannot indefinitely starve article completion.

CMS model work runs in the deployed engine, not in the Chrome extension. After a capture has been accepted by the CMS, the local computer and Chrome may be closed while extraction, Knowledge rebuilds, recommendations, and article work continue on GCE. Keep the local computer and signed-in Chrome open only while the extension is discovering or capturing Xiaohongshu notes, or while a Xiaohongshu verification challenge requires operator action.

The production Vertex configuration uses the global endpoint and smooths model calls with `AI_REQUEST_SPACING_MS=1000`. Durable AI work starts at `AI_CONCURRENCY_INITIAL=2`, grows by one only after `AI_CONCURRENCY_SUCCESS_WINDOW=12` successful calls, and is capped at `AI_CONCURRENCY_MAX=4`. Provider pressure halves concurrency immediately. A 429/500/503 response delays all queued AI work using `Retry-After` when supplied, otherwise jittered exponential backoff from `AI_PROVIDER_BACKOFF_INITIAL_MS=5000` to `AI_PROVIDER_BACKOFF_MAX_MS=300000`; five real successful calls reset the pressure streak. These values smooth Standard PayGo traffic but cannot guarantee that a dynamic shared-capacity pool will never return 429. Existing `EXTRACT_CONCURRENCY_*` variables remain supported as legacy aliases.

Per-stage model behavior is versioned in `config/model-stage-policy.json`; model prices are separate in `config/model-pricing.json`. Do not change the default model based on a model name or an assumed saving. Compare the same inputs against the versioned quality set and obtain an explicitly authorized paid trial first. The dashboard runtime ledger includes every request attempt, failed retry, cancellation, cache hit and bounded repair. Missing provider usage or price data remains `null`, never zero. SEO/GEO metadata is produced with the draft and checked locally; there is no mandatory extra full-document model pass.

Extension settings live in `chrome.storage.local`: identity/discovery batch sizes, checkpoint streak, queue high-water mark, retries, page timeout, concurrency mode/limits, and optional startup/daily Auto Sync. Server-side limits are documented in `.env.example`. `GET /api/favorites-sync-runs` exposes aggregate run summaries to the authenticated Maintenance surface; no account or browser-session data is recorded.

Large captures use `POST /api/capture-uploads`, exact binary chunks, and `/complete`. The server verifies declared byte size and SHA-256 before parsing/persisting JSON, and removes abandoned upload sessions after `CAPTURE_UPLOAD_MAX_AGE_HOURS`. Keep `CAPTURE_UPLOADS_DIR` within the existing data volume.

## Start and stop

```powershell
npm install
npm start
```

`npm start` runs a production frontend build before starting the HTTP server. For UI development, run the backend with `npm run dev:server` and Vite with `npm run dev`; Vite serves the interface on port 5173 and proxies `/api` to the backend on port 4310.

The default `HOST=127.0.0.1` is local-only. Binding any non-loopback host is refused unless both `CAPTURE_TOKEN` and `ADMIN_TOKEN` are configured. Stop with Ctrl+C so the HTTP server and SQLite connection close cleanly.

## Secrets

- `CAPTURE_TOKEN` is used only by the Chrome extension capture endpoint.
- `ADMIN_TOKEN` protects retries, content generation, offer sync, pipeline execution, WordPress sync, and inventory refresh.
- The dashboard asks for `ADMIN_TOKEN` only after a protected action returns 401 and stores it in `sessionStorage`, not persistent browser storage.
- WordPress uses an Application Password over HTTPS and can create or update only `draft` posts through this engine.

## Backup and verification

With `MAINTENANCE_ENABLED=true`, the engine automatically creates a backup every `AUTO_BACKUP_HOURS` and retains `BACKUP_RETENTION` snapshots. The Maintenance view shows the last verified filename, schema version, size, and checksum metadata. Manual commands remain available for exceptional use.

Create a consistent SQLite snapshot while the engine is running:

```powershell
npm run backup
```

Each backup has a JSON manifest containing its byte size, SHA-256, schema version, and integrity result. Defaults are `./backups` and 14 retained snapshots.

Verify any snapshot before restore:

```powershell
npm run backup:verify -- ./backups/solo-to-china-TIMESTAMP.sqlite
```

Exercise the complete restore path without replacing or opening the live database:

```powershell
npm run backup:drill -- ./backups/solo-to-china-TIMESTAMP.sqlite
```

The drill copies the selected backup into an isolated temporary directory, applies forward migrations, checks integrity, and reads critical table counts. The temporary restored database is removed afterwards.

To restore, stop the engine, verify the selected snapshot, preserve the current database, copy the verified snapshot to the configured `DATABASE_PATH`, and start the engine. Startup migrations are forward-only.

## Exceptions

- `blocker`: pipeline failure, stale evidence, exhausted draft QA, integration failure, or WordPress delivery failure.
- `warning`: Entity Identity, Claim Conflict, Source/Temporal/Granularity Conflict, or Extraction Error that genuinely requires judgment.
- Retry buttons are shown only for operational failures. Enrichment, refinement, compatible recommendations, obvious entity mismatches, and normal affiliate fallback never appear as exceptions.
- Entity merge review supports **same entity**, **different entity**, **create relation**, and **defer**. Accepted merges are auditable and may be undone from merge history without deleting Claims or Sources.

## Trip.com manual Affiliate setup

1. In the official Trip.com Affiliate Platform, create the official Link, Search Box, or Banner configuration. Do not invent or edit tracking parameters.
2. Create a `MANUAL` provider through `POST /api/commercial/providers`; store only display/site/language/disclosure metadata—never username, password, Cookie, or login state.
3. Add each reusable resource through `POST /api/commercial/assets`. Keep `assetType` (presentation) separate from `productCategory` (what is sold), and choose `scopeType` according to real user decision precision.
4. Prefer Destination + Category assets, then selective Area, Route, and major-attraction assets. Create specific hotel/product links only when repeated high-intent demand justifies maintenance.
5. Confirm the Commercial view shows the Provider, Asset, mapping, and any high-value Opportunity. Missing ordinary links should remain silent fallback.

Structured Search Box/Dynamic Banner configuration accepts only allowlisted fields and credential-free HTTPS sources. Arbitrary HTML/script is rejected. Commercial density defaults are configurable without affecting Research:

```text
COMMERCIAL_MAX_OFFERS_PER_DRAFT=3
COMMERCIAL_MAX_CONTEXTUAL_UNITS=2
COMMERCIAL_MAX_END_RESOURCE_UNITS=1
COMMERCIAL_MIN_BLOCK_DISTANCE=3
COMMERCIAL_MINIMUM_CONTENT_BLOCKS=2
AFFILIATE_OPPORTUNITY_THRESHOLD=70
```

The minimum measurement path accepts authenticated/server-side `impression` and `click` through `POST /api/commercial/events`; aggregated CTR/EPC/RPM placeholders are available from `/api/commercial/performance`. Never expose an administrator token in public browser JavaScript. Public Frontend tracking requires a same-origin WordPress relay or another separately reviewed ingestion boundary. Booking/commission import and official attribution remain Phase 2.

## Automatic maintenance

- Scheduler wake-up: `MAINTENANCE_INTERVAL_MINUTES` (default 15).
- Knowledge freshness reconciliation: `KNOWLEDGE_RECONCILE_HOURS` (default 24).
- Consistent database backup: `AUTO_BACKUP_HOURS` (default 24).
- Successful Job history: `JOB_HISTORY_RETENTION_DAYS` (default 30).
- WordPress inventory continues to use `WORDPRESS_INVENTORY_SYNC_HOURS`.
- Search Console query inventory uses `SEARCH_CONSOLE_SYNC_HOURS` when its read-only service account is configured.

Maintenance state is durable in SQLite. Restarts do not reset due times, and queue idempotency prevents duplicate reconciliation Jobs. Failed maintenance appears in Exceptions; failed pipeline Jobs are never removed by retention cleanup.

## Operational visibility

The **Maintenance** view shows active queue depth, oldest waiting age, rolling success rate, p95 queue latency, p95 processing duration, and per-Job-type outcomes. The rolling window defaults to 24 hours:

```text
TELEMETRY_WINDOW_HOURS=24
```

Every API response includes `X-Request-Id`. A safe incoming request ID is preserved; otherwise the engine generates one. API requests, Pipeline jobs, maintenance tasks, startup, and shutdown emit structured stdout events without authorization headers or URL query strings.

```text
LOG_LEVEL=info
LOG_FORMAT=json
```

Use `LOG_FORMAT=pretty` for local reading. Remote deployments can use `GET /api/health` for liveness and `GET /api/ready` for database-backed readiness.

## Search Console read-only sync

Grant a Google service account read access to the Search Console property, then configure `SEARCH_CONSOLE_SITE_URL`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, and `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`. Newlines in the private key may be represented as `\\n`. The scheduler refreshes a bounded query/page window automatically; `POST /api/search-console/sync` is reserved for exceptional admin-triggered refreshes.

Search Console performance is strategy inventory only. It never becomes Research evidence and never enters model prompts. A failed sync appears in Exceptions and is retryable through the existing workflow.

## Secret handling and rotation

The engine does not store provider secrets. Kimi API keys, WordPress Application Passwords, Google service-account private keys, webhook tokens, and operational tokens are read from the process environment and are never written to SQLite or returned by an API. Rotate a credential in the deployment secret manager or environment and restart the single process. Backups therefore contain domain data and operational state, not provider credentials.

## Exception webhook

Exception alerts are optional. When configured, maintenance sends a generic JSON payload containing only operational Exceptions at or above the selected severity:

```text
EXCEPTION_WEBHOOK_URL=https://automation.example/hooks/solo-to-china
EXCEPTION_WEBHOOK_TOKEN=
EXCEPTION_NOTIFICATION_MIN_SEVERITY=blocker
EXCEPTION_NOTIFICATION_INTERVAL_MINUTES=15
EXCEPTION_NOTIFICATION_REPEAT_HOURS=24
```

Remote webhook URLs must use HTTPS and cannot embed credentials. `EXCEPTION_WEBHOOK_TOKEN`, when present, is sent as a Bearer token. Delivery fingerprints and outcomes are durable: unchanged exceptions are suppressed until the repeat interval, changed exceptions notify immediately, failed deliveries retry on the next maintenance cycle, and resolved exceptions are removed from notification state. Webhook failures appear in the existing Exceptions view.

## Strategy 1.4 research rebuild

The Maintenance tab provides an explicit, confirmed “clear and reprocess” operation. It removes only derived extraction, Claim, Knowledge, Topic, Opportunity, Blueprint, Draft, Commercial, Publish Composition, and job state. Raw Sources, uploaded originals, source assets, hashes, and provenance remain in the persistent volume. Every preserved Source is then queued through the Strategy 1.4 preflight pipeline. The protected API is `POST /api/maintenance/reset-derived-research` with confirmation `RESET_DERIVED_RESEARCH`.

Never remove the Docker volume during this operation or deployment. The reset endpoint is the supported path for replacing potentially polluted derived research while preserving the evidence record.

## Release check

```powershell
npm run release:check
```

This is the complete local release gate. It runs the production frontend build, static checks, the complete test suite, application/extension version alignment, Content Strategy manifest/specification/handoff/UI checks, migrations 1–35 on a clean database, and SQLite integrity verification. It then starts an isolated Node server using a temporary SQLite database and random loopback port, polls `/api/health` instead of relying on logs, checks `/api/ready`, `/api/system/info`, core read APIs, a temporary capture insert/revision/read, React HTML/assets, Extension manifest/assets, database integrity, server logs, automatic shutdown, and temporary-file cleanup.

The runner deliberately clears AI, WordPress, Search Console, webhook, and operational-token configuration for its child process, so it never calls external services or touches the live database. It uses these result states:

- `PASS`: mandatory automated check completed successfully.
- `WARNING`: intentional external-service or Node-runtime limitation; it does not block local extension integration.
- `FAIL`: mandatory check failed; the command exits non-zero.
- `NOT TESTED`: an explicit manual browser or real-account step that cannot be truthfully automated.

Run only the isolated HTTP/API/static smoke phase after an existing build with:

```powershell
npm run test:smoke
```
