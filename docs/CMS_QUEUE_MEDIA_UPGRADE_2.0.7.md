# CMS 2.0.7 queue and media upgrade

Target: App/Extension 2.0.7, Content Production Strategy 3.2, schema 66.

## Upgrade

1. Stop writers and create a verified system snapshot that includes SQLite, source uploads and generated media. Record the current image digest and active `/app/data` mount.
2. Rehearse the upgrade against the isolated snapshot with Node 24 or the candidate container. Schema 66 adds only new tables and nullable model telemetry columns; it does not rewrite Sources, assets, Claims, evidence or article rows.
3. Deploy the immutable image and start one application instance. Confirm `/api/health` reports `serviceHealth.ready=true`, version 2.0.7, Strategy 3.2 and schema 66.
4. Confirm the active data mount is unchanged. Verify `PRAGMA integrity_check`, foreign keys, source/asset/claim counts, `/api/sources/status`, and a source detail timeline.
5. Reload the packaged 2.0.7 extension from the existing directory. Do not uninstall it or clear IndexedDB.
6. Run the processing-gap and media-storage commands without `--execute` and review their stored reports:

   `npm run backfill -- processing-gaps`

   `npm run backfill -- media-storage`

7. If an operator later approves processing recovery, use the exact current report:

   `npm run backfill -- processing-gaps --execute --approved-from <dry-run-id>`

   A changed candidate fingerprint is rejected. Media-storage execution is disabled in the online process.

## Feature controls

- `MEDIA_EXTRACTION_BATCHING_ENABLED=true` enables traceable ordinary-image grouping.
- `MEDIA_EXTRACTION_BATCH_SIZE=6` accepts 4-8 and defaults to 6.
- `COVERAGE_AI_ROUTING_ENABLED=false` uses deterministic exhaustive coverage; conditional AI coverage remains pending a reviewed quality benchmark.
- `SOURCE_COMPLEXITY_ROUTING=false` preserves the prior conservative downstream routing default.

## Rollback

Stop writers, restore the paired pre-upgrade database and file snapshot, and redeploy the recorded 2.0.6 image digest. Never lower the schema marker in place and never restore only SQLite without its referenced files. Schema 66 is additive, so retaining the upgraded database during a code rollback has not been declared compatible; use the paired snapshot.

Rollback does not delete the 2.0.7 image, dry-run reports or evidence. Keep them until the incident is understood.

