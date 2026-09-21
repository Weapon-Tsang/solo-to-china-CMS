# CMS 2.0.45 release readiness — 2026-09-21

This is a `DATA_MIGRATION_RELEASE` candidate from production schema 73 to code schema 76. The current production application is 2.0.44. This record distinguishes the verified offline release gate from the task brief's wider 72-item acceptance ledger in `INTEGRATED_PIPELINE_PERFORMANCE_2026-09-21.md`.

## Read-only production preflight

- Running engine: app 2.0.44, schema 73. The database contained 78 Sources, 13 Drafts, 1,145 failed historical Jobs and 15,045 succeeded Jobs; there were no queued or running Jobs at inspection time.
- The 80-GB VM root disk initially had about 2.1 GB free (98% used). The current database was about 2.2 GB; retained local snapshots occupied about 16 GB. Non-backup application data was 5,601,261,337 bytes, so the migration helper requires more than 18,951,267,659 bytes free before it stops the engine. The disk did not satisfy that preflight at initial inspection. No production backup or source media was removed.
- Instance startup metadata expects an earlier engine image digest than the running 2.0.44 container. A VM restart can fail its image identity check. The intended 2.0.45 startup wrapper must be tested and installed only with the final immutable image identity.
- The 2026-09-21 snapshot database was transferred read-only, decompressed with gzip CRC verification and matched to the manifest SHA-256. A disposable local work copy migrated schema 73 to 76 with SQLite integrity `ok`, repeat open idempotent, baseline still at 73, and unchanged IDs and old-column content hashes for 78 Sources, 5,147 Claims, 13 Drafts, 27 Visuals, 12 WordPress publications and 16,190 Jobs. The first rehearsal attempt exposed a harness error: it included the new `jobs.pipeline_version` column when comparing old content. A schema-73 regression test and the rerun passed after the harness compared only pre-existing columns.

On 2026-09-22 the user authorized cleanup of historical disk use. The old 2026-09-17/18 SQLite replay copies and transfer fragments in `/tmp` had no open file handles and were outside the running container's data mounts. Removing those disposable files raised root free space from about 2.1 GB to 30 GB (98% to 61% used). The live database, snapshot directories, media, running `engine` and `cloudflared` were retained. The latest 2026-09-21 snapshot database was copied into an isolated temporary baseline and its SHA-256 matched the snapshot manifest: `d3f09f645469d60a9a77b16aa337af304eccd1d5cabf1ba9cd2d78138e047170`. This frees the disk-space gate but does not by itself authorize migration or establish the other release gates.

The same snapshot passed a full isolated restore drill using the existing production image: 1,207 snapshot files, 1,423 restored media references, 1,407 opened source evidence previews, 16 opened draft media files, and one successful mock delivery probe. External model and WordPress calls were zero. The temporary replay and drill directories were removed after verification; root free space returned to 30 GB.

While this candidate was being reviewed, a separate 2.0.46 extension capture hotfix was merged into `main` as `25e4775` and deployed. The production engine image changed to digest `0e493ac5...`, and its startup metadata now pins that running image. The 2.0.45 candidate has **not** been merged or deployed; its release baseline must incorporate 2.0.46 and be retested before any further release decision.

## Local release candidate checks

| Gate | Result | Scope |
|---|---|---|
| `npm run release:check` | PASS | 50 mandatory offline checks, 0 failures; unit duration warning and external-service exclusions retained |
| `test/deployment-upgrade.test.mjs` | PASS | Five local backup, drill, migration, rollback and script contract tests |
| Git Bash syntax validation | PASS | `upgrade-existing.sh`, `resume-verified-upgrade.sh`, `startup.sh`, runtime-image smoke script |
| Runtime image smoke in CI | PASS | [Run 35627390850](https://github.com/Weapon-Tsang/solo-to-china-CMS/actions/runs/35627390850) passed offline gate and actual API/Worker image smoke on one disposable database. The prior failure revealed a real Worker exit: its unreferenced timer let the standalone process terminate after `worker.ready`. The Worker timer and liveness regression test were fixed in `d12717d`. |
| Current production database replay | PASS for schema, identity and bounded recovery | 2026-09-21 snapshot, local disposable copy, schema 73 to 76, 11 table fingerprints and integrity; one failed production record resumed at `generate_visuals` with the same idempotent Job, preserved earlier stages, zero model/WordPress calls, and no live DB writes |
| Snapshot restore drill | PASS | 2026-09-21 snapshot, full isolated media/reference verification and mock delivery; 0 external calls |
| Full bundle → 429 → restart → grant → mock WordPress chain | NOT TESTED | Required by M35/X01–X07 |
| Real Provider canary | NOT TESTED | Paid calls were not authorized by the development brief |
| Production active-load browser performance | NOT TESTED | No workload was initiated on production |
| Local browser E2E | PASS for bounded fixture flow | Playwright opened all six menus, changed Source page size from 20 to 50, navigated to page 2, and recovered one `needs_review` item from its saved target; no browser console errors. It did not simulate production Worker load. |

The upgrade helper now launches `engine` as API only and `engine-worker` as a separate process, both on the same database and preserved `/app/data` mount. The API is checked while isolated before public attachment, and the Worker must emit `worker.ready` before the release marker is written. `resume-verified-upgrade.sh` is pinned to schema 76 and Strategy 3.8. The same split is represented in fresh-install startup and Compose configuration. The built-image CI smoke covers two role processes on one disposable database.

## Go/no-go and rollback

**NO-GO at this record revision.** The disk, current-data schema migration and actual image smoke gates passed. The full failure/recovery chain, required Provider compatibility check, browser behavior under worker load and predominantly `PARTIAL` 72-item ledger remain unresolved. Passing the offline release gate does not close those acceptance items. Do not merge this candidate into `main` or switch the production container yet.

On a later approved production migration, keep the paired verified snapshot, original media hashes, previous image and old stopped container. Before public exposure the helper restores the paired old database and container if migration/readiness fails. After exposure, stop API and Worker, preserve any new DB/WAL/media/remote receipts, reconcile new writes, and only then restore the matching old code/database/media. The older code must not open schema 76.
