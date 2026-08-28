# V1 Operations

## Daily workflow

1. Select useful Xiaohongshu posts on mobile.
2. Open saved posts in desktop Chrome and click **Save to SoloToChina**.
3. When Kimi has analyzed a useful Source, make one decision in **Recommendations**: **Approve article**, Knowledge only, Cluster, Research first, or Ignore. Only **Approve article** queues content planning.
4. Review only the **Exceptions** view when its count is non-zero.
5. Review final drafts in WordPress and publish manually.

No spreadsheet, manual source card, URL copy, tagging pass, or Knowledge Base maintenance is required.

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
- `warning`: conflicting evidence that requires editorial judgment.
- Retry buttons are shown only for operational failures. Knowledge conflicts and stale evidence require a newly saved source or a future official-source adapter, never manual KB editing.

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

## Release check

```powershell
npm run release:check
```

This is the complete local release gate. It runs the production frontend build, static checks, the complete test suite, application/extension version alignment, Content Strategy manifest/specification/handoff/UI checks, migrations 1–12 on a clean database, and SQLite integrity verification. It then starts an isolated Node server using a temporary SQLite database and random loopback port, polls `/api/health` instead of relying on logs, checks `/api/ready`, `/api/system/info`, core read APIs, a temporary capture insert/revision/read, React HTML/assets, Extension manifest/assets, database integrity, server logs, automatic shutdown, and temporary-file cleanup.

The runner deliberately clears AI, WordPress, Search Console, webhook, and operational-token configuration for its child process, so it never calls external services or touches the live database. It uses these result states:

- `PASS`: mandatory automated check completed successfully.
- `WARNING`: intentional external-service or Node-runtime limitation; it does not block local extension integration.
- `FAIL`: mandatory check failed; the command exits non-zero.
- `NOT TESTED`: an explicit manual browser or real-account step that cannot be truthfully automated.

Run only the isolated HTTP/API/static smoke phase after an existing build with:

```powershell
npm run test:smoke
```
