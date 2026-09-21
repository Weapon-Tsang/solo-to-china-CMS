# CMS 2.0.45 release readiness — 2026-09-21

This is a `DATA_MIGRATION_RELEASE` candidate from production schema 73 to code schema 76. The current production application is 2.0.44. This record distinguishes the verified offline release gate from the task brief's wider 72-item acceptance ledger in `INTEGRATED_PIPELINE_PERFORMANCE_2026-09-21.md`.

## Read-only production preflight

- Running engine: app 2.0.44, schema 73. The database contained 78 Sources, 13 Drafts, 1,145 failed historical Jobs and 15,045 succeeded Jobs; there were no queued or running Jobs at inspection time.
- The 80-GB VM root disk had about 2.1 GB free (98% used). The current database was about 2.2 GB; retained local snapshots occupied about 16 GB. Non-backup application data was 5,601,261,337 bytes, so the migration helper requires more than 18,951,267,659 bytes free before it stops the engine. The current disk does not satisfy that preflight. No production backup or source media was removed.
- Instance startup metadata expects an earlier engine image digest than the running 2.0.44 container. A VM restart can fail its image identity check. The intended 2.0.45 startup wrapper must be tested and installed only with the final immutable image identity.
- A recent local-snapshot database is being copied read-only to a local drive for a disposable migration rehearsal. Until verification and rehearsal complete, current-production L3 replay is `NOT TESTED`.

## Local release candidate checks

| Gate | Result | Scope |
|---|---|---|
| `npm run release:check` | PASS | 50 mandatory offline checks, 0 failures; unit duration warning and external-service exclusions retained |
| `test/deployment-upgrade.test.mjs` | PASS | Five local backup, drill, migration, rollback and script contract tests |
| Git Bash syntax validation | PASS | `upgrade-existing.sh`, `resume-verified-upgrade.sh`, `startup.sh`, runtime-image smoke script |
| Runtime image smoke in CI | NOT TESTED | Local Docker CLI is unavailable; the workflow runs it on branch push |
| Current production database replay | NOT TESTED | Read-only copy and disposable work database pending |
| Full bundle → 429 → restart → grant → mock WordPress chain | NOT TESTED | Required by M35/X01–X07 |
| Real Provider canary | NOT TESTED | Paid calls were not authorized by the development brief |
| Production active-load browser performance | NOT TESTED | No workload was initiated on production |

The upgrade helper now launches `engine` as API only and `engine-worker` as a separate process, both on the same database and preserved `/app/data` mount. The API is checked while isolated before public attachment, and the Worker must emit `worker.ready` before the release marker is written. `resume-verified-upgrade.sh` is pinned to schema 76 and Strategy 3.8. The same split is represented in fresh-install startup and Compose configuration. The built-image CI smoke covers two role processes on one disposable database.

## Go/no-go and rollback

**NO-GO at this record revision.** Do not merge this candidate into `main` or switch the production container until the current-data migration rehearsal, actual image smoke, full failure/recovery chain, required Provider compatibility check, browser behavior under worker load and VM disk preflight are resolved. The 72-item ledger is still predominantly `PARTIAL`; passing the offline release gate does not close those acceptance items.

On a later approved production migration, keep the paired verified snapshot, original media hashes, previous image and old stopped container. Before public exposure the helper restores the paired old database and container if migration/readiness fails. After exposure, stop API and Worker, preserve any new DB/WAL/media/remote receipts, reconcile new writes, and only then restore the matching old code/database/media. The older code must not open schema 76.
