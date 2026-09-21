# CMS 2.0.47 release readiness — 2026-09-22

This is the integrated pipeline and admin performance `DATA_MIGRATION_RELEASE` candidate. It includes the independently deployed 2.0.46 extension capture hotfix from `main` (`25e4775`), advances the code schema from 73 to 76, and keeps Content Strategy 3.8. The candidate is on `codex/integrated-pipeline-v2-release` at merge commit `4de86fc`. Production currently runs 2.0.46 on schema 73. This candidate has not been merged into `main` or deployed.

## Release evidence

| Check | Result | Scope |
|---|---|---|
| Production disk | PASS | Removed only old disposable `/tmp` SQLite replays and transfer fragments; root free space rose from about 2.1 GB to 30 GB. Live DB, media and backup snapshots were retained. |
| Backup and restore | PASS | The completed 2026-09-21 snapshot passed isolated restore drill: 1,207 files, 1,423 media references, 1,407 source previews, 16 draft media files and one mock delivery; zero external calls. |
| Schema 73-to-76 migration | PASS on snapshot | The read-only source hash matched its manifest. Local disposable migration preserved old-column content and IDs for 11 tables, including 16,190 Jobs; integrity and repeated opening passed; baseline remained schema 73. |
| Production-copy recovery | PASS for one failed record | Idempotent retry queued one `generate_visuals` Job, preserved earlier stages and protected entity counts, and made zero model/WordPress calls. |
| API/Worker process split | PASS before mainline merge | Actual runtime-image CI on `d12717d` used one disposable database and kept the standalone Worker alive. The integrated 2.0.47 image CI is pending. |
| 2.0.46 hotfix integration | PASS targeted | 22 focused capture, extension, schema and process tests passed after resolving merge conflicts; full release gate is pending. |
| Local browser | PARTIAL | All six menus, 20/50 Source page size, next-page prefetch and a `needs_review` recovery action passed on a disposable fixture. Active production Worker latency and mobile behavior remain unmeasured. |
| Full bundle/429/restart/grant/mock WordPress chain | NOT TESTED | Required v2.0 acceptance scenario M35/X01–X07 is still open. |
| Real Provider canary | NOT TESTED | Paid Provider calls were excluded from the development authorization; actual model/schema compatibility and cost remain unmeasured. |
| Full 72-item acceptance ledger | PARTIAL | See `INTEGRATED_PIPELINE_PERFORMANCE_2026-09-21.md`; many scenarios still lack end-to-end evidence. |

## Current decision

**NO-GO.** Do not merge this candidate into `main` or switch production to schema 76 until the integrated 2.0.47 image CI passes, the complete failure/recovery chain is exercised, Provider compatibility is checked under an explicit bounded authorization, and the remaining required v2.0 acceptance cases are closed. A future production migration must create a fresh paired pre-upgrade snapshot after 2.0.46, verify and drill it, remeasure current-data compatibility, and retain the matching 2.0.46 image and stopped container for rollback.

Rollback after migration requires stopping API and Worker, preserving new database/WAL, media and remote receipts, then restoring the paired old database/media with the old image. Old code must not open schema 76. No production database, Provider or WordPress writes were made by this candidate review.
