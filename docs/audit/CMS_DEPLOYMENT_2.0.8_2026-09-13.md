# CMS 2.0.8 production deployment record

Deployment completed on 2026-09-13 Asia/Shanghai (2026-09-12 UTC) from branch `codex/audit-v1.3`.

## Release identity

- Final Git revision: `afaf4e7678ef377ccbf3921704ba637289d3a323`; pushed to `origin/codex/audit-v1.3`.
- Cloud Build: `a283f453-c1c0-4c99-aac9-9fcd881aa303`, status `SUCCESS`.
- Immutable image: `asia-east1-docker.pkg.dev/project-4bcb9146-c37b-43b0-b11/solo-to-china/engine@sha256:2ae943ff2c0c16f52b7349cf12c6705ba764eacdad314e169a178fe4c79fe58c`.
- Active runtime: App/Extension 2.0.8, Content Strategy 3.3, schema 67. The persistent environment and startup metadata are pinned to the final revision and digest.
- Baseline before this release: revision `2f71d45ddf80b588a58789aa94c251413fa498b7`, image digest `sha256:626293d8d4171af36d021ccf2ad71671b56e3c54a35fbefaee5e246d913d65ed`, App 2.0.7 / Strategy 3.2 / schema 66.

The initial 2.0.8 image at revision `6a1c68a4e030b1d483fdd6eb5720c320cab70967` exposed a real SQLite writer collision when two pre-existing ordinary Knowledge rebuild jobs resumed. A recovery timer received `database is locked`, and that intermediate container restarted once. Revision `afaf4e7` serializes database-heavy derived-index jobs, enforces workload-lane concurrency and contains transient lock errors in recovery, claim and heartbeat ticks. The final container passed an isolated runtime contract and has restart count zero and zero lock/FATAL/unhandled log matches after startup.

## Backup, migration and rollback

- Pre-patch disk snapshot: `solo-to-china-pre-208-lockfix-afaf4e7-20260913`, 80 GB, status `READY`. The earlier pre-2.0.8 snapshot `solo-to-china-pre-208-6a1c68a-20260912` is also retained.
- Paired application snapshot: `solo-to-china-2026-09-12T16-15-09-116Z.snapshot`; 1,963,692,032 bytes, SHA-256 `17af5608478091558251f373fae78aa8857858c724445dc198494c5b24d0b52a`, 1009 files, integrity `ok`.
- Restore drill: passed with external side effects disabled; all 1318 evidence previews opened, with no draft-media probe applicable because production has no drafts.
- Isolated schema rehearsal: schema 67, integrity `ok`, zero foreign-key errors, content fingerprints preserved, 145,283 ms.
- Production schema verification: schema 67, integrity `ok`, zero foreign-key errors, content fingerprints preserved, 168,037 ms.
- Preserved counts: 74 Sources, 149 capture versions, 1318 source assets, 1391 segments, 6421 Claims and 6399 evidence spans.
- Rollback container: `engine-before-afaf4e7`. Rollback must restore the paired snapshot and the recorded image together if writes need to cross back from schema 67.

The old container did not exit within the 120-second graceful-stop allowance and Docker stopped it with exit 137. The disk snapshot preceded this action, and the paired post-stop backup, restore drill, SQLite integrity/foreign-key checks, file hashes and content fingerprints all passed before the replacement container received traffic.

## Production dry runs

No `--execute` flag was used. `recoveryExecutionJobs` is zero and the count of non-dry backfills created since the deployment sequence began is zero.

- Final Processing Gap dry run: `processing_gap_run_6e962f8e1f5047e89193642aa1437fa2`, fingerprint `7fe863592b79b15b03e9746dc407fff3b1d52bc847c4ac0d83830cbf6940e642`. It scanned 74 Sources and reported 35 gaps/actions: 34 legacy manual-start gates and one missing finalization; no active recovery job, no queued execution and no hard-limit blocker.
- The first post-schema Knowledge projection, before normal queued rebuilds completed, was `backfill_d8147c3073d0462488ddd251e190dace`: 229 cases evaluated, with 1 `AUTO_EQUIVALENT`, 13 `AUTO_SCOPE_SPLIT`, 48 `AUTO_CONSENSUS`, 151 `VERIFICATION_REQUIRED`, 16 `REPAIR_REQUIRED` and 0 `HUMAN_REQUIRED`.
- Final Knowledge dry run: `backfill_c343871250b34165a37c11dbd1166214`. It evaluated zero remaining manual-review cases and made no change. Pre-existing normal runtime jobs, rather than a backfill execution, had already rebuilt Knowledge under 2.0.8. Current persisted queues contain 14 targeted-verification jobs, 49 Claim-repair jobs and no manual-review rows.

Historical Source recovery remains unexecuted. No media deletion, Base64 deletion, WordPress draft creation or WordPress publication occurred.

## Performance and runtime verification

The production-host synthetic fixture had 120 Claims/facts and 60 opportunities. Full Coverage refreshed 60 opportunities in 345.16 ms; dirty-scope refresh updated one in 25.01 ms, a 13.8x elapsed-time improvement. Compact Intake used 59,423 bytes instead of 571,331 bytes, an 89.6% reduction.

During isolated work, local health latency was p50 1.47 ms / p95 10.93 ms for the CPU worker and p50 1.41 ms / p95 2.32 ms for the verified backup child. Sixty real production health requests during the benchmark measured p50 19.16 ms, p95 38.12 ms and max 196.99 ms.

Twelve public samples per endpoint all returned HTTP 200. Engine health measured p50 475.55 ms / p95 1315.85 ms; Engine readiness 428.12 / 462.28 ms; Capture health 421.03 / 1191.62 ms; Capture readiness 379.72 / 403.75 ms. Both hosts reported App 2.0.8 and database `ready`; health reported Strategy 3.3.

The observed 24-hour provider window contained 936 attempts, 814 successes, 122 failures and 106 rate-limit classifications, with provider p50 9630 ms and p95 59,422 ms. Token and cost totals remain unknown because not every historical metric has those values. The Source job sample (1153 jobs, p50 582 ms, p95 6,629,095 ms) mixes old Batch lifecycle and pre-release work, so it is not evidence of a Source end-to-end production speedup.

After deployment the 80 GB filesystem had 30,322,569,216 bytes available (63% used). Docker images used 17.02 GB with 15.5 GB reported reclaimable; no image, container, backup or original-media cleanup was performed.

## Validation and operating steps

Local validation passed 511/511 tests. `npm run check` passed, and `npm run release:check` passed all 51 mandatory checks with zero failures, four expected warnings and five environment-only checks marked not tested.

For a later upgrade, record the active digest/revision and capacity, create a disk snapshot, stop writers, create and drill a paired backup, rehearse the migration on a copy, start the immutable image on network `none`, validate readiness/version/schema, connect the service network, then run Processing Gap and Knowledge inventories without `--execute`. Real Chrome/MV3 capture, production WordPress/theme HTML, rankings, indexing, traffic, Core Web Vitals and AI citations remain outside this server-side deployment validation.
