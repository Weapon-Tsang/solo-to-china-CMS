# V1 Operations

## Daily workflow

1. Select useful Xiaohongshu posts on mobile.
2. Open saved posts in desktop Chrome and click **Save to SoloToChina**.
3. Review only the **Exceptions** view when its count is non-zero.
4. Review final drafts in WordPress and publish manually.

No spreadsheet, manual source card, URL copy, tagging pass, or Knowledge Base maintenance is required.

## Start and stop

```powershell
npm start
```

The default `HOST=127.0.0.1` is local-only. Binding any non-loopback host is refused unless both `CAPTURE_TOKEN` and `ADMIN_TOKEN` are configured. Stop with Ctrl+C so the HTTP server and SQLite connection close cleanly.

## Secrets

- `CAPTURE_TOKEN` is used only by the Chrome extension capture endpoint.
- `ADMIN_TOKEN` protects retries, content generation, offer sync, pipeline execution, WordPress sync, and inventory refresh.
- The dashboard asks for `ADMIN_TOKEN` only after a protected action returns 401 and stores it in `sessionStorage`, not persistent browser storage.
- WordPress uses an Application Password over HTTPS and can create or update only `draft` posts through this engine.

## Backup and verification

Create a consistent SQLite snapshot while the engine is running:

```powershell
npm run backup
```

Each backup has a JSON manifest containing its byte size, SHA-256, schema version, and integrity result. Defaults are `./backups` and 14 retained snapshots.

Verify any snapshot before restore:

```powershell
npm run backup:verify -- ./backups/solo-to-china-TIMESTAMP.sqlite
```

To restore, stop the engine, verify the selected snapshot, preserve the current database, copy the verified snapshot to the configured `DATABASE_PATH`, and start the engine. Startup migrations are forward-only.

## Exceptions

- `blocker`: pipeline failure, stale evidence, exhausted draft QA, integration failure, or WordPress delivery failure.
- `warning`: conflicting evidence that requires editorial judgment.
- Retry buttons are shown only for operational failures. Knowledge conflicts and stale evidence require a newly saved source or a future official-source adapter, never manual KB editing.

## Release check

```powershell
npm run release:check
```

This runs syntax checks, the complete test suite, version alignment, migrations 1–5 on a clean database, and SQLite integrity verification.
