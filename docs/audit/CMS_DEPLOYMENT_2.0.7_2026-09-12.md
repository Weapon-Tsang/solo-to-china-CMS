# CMS 2.0.7 production rollout — 2026-09-12

The user authorized implementation, commit, push and deployment. Release `2f71d45ddf80b588a58789aa94c251413fa498b7` on `codex/audit-v1.3` is pushed to origin and deployed as App 2.0.7, Content Strategy 3.2 and schema 66. This rollout did not publish WordPress content, execute historical recovery, delete Base64 data, or remove original media.

## Provenance and recovery points

- Cloud Build `bee35bd6-878e-41af-b7c7-31bbb85ccfad` completed with status `SUCCESS` in 1 minute 14 seconds.
- The active immutable image is `asia-east1-docker.pkg.dev/project-4bcb9146-c37b-43b0-b11/solo-to-china/engine@sha256:626293d8d4171af36d021ccf2ad71671b56e3c54a35fbefaee5e246d913d65ed`.
- Persistent-disk snapshot `stc-pre-207-2f71d45-20260912` is `READY`. It captures the 50 GB `solo-to-china-engine` disk before the rollout.
- Release records are retained at `/opt/solo-to-china/upgrades/2f71d45ddf80b588a58789aa94c251413fa498b7`. The stopped rollback container is `engine-before-2f71d45`.
- The active `/app/data` bind is `/opt/solo-to-china/upgrades/2f71d45ddf80b588a58789aa94c251413fa498b7/legacy-app-data`; the upgrade copied and hashed the complete previous container directory before replacement.
- After online verification, `pin-runtime-image.py` updated only `ENGINE_IMAGE` to the immutable digest. The previous private environment file remains mode 0600 inside the release records.

## Backup, migration and data verification

- Application snapshot `solo-to-china-2026-09-12T11-49-58-217Z.snapshot` contains a 1,934,319,616-byte SQLite copy and 1,009 files. Its database SHA-256 is `2b36f3d565da72dd3d675763e3e68a385ba8daafc2ddfc6fc8957c334e6dcb98`; integrity is `ok`.
- The isolated restore drill passed with `externalSideEffects=false` and opened all 1,318 evidence previews. Draft-media delivery was not applicable because production had no article drafts or visuals.
- The schema 65 to 66 rehearsal passed in 139,529 ms. Production migration passed in 155,911 ms. Both reported integrity `ok`, zero foreign-key errors, and identical content fingerprints.
- Original-media SHA-256 checks and the pre-pin environment hash passed before network exposure.
- Final read-only verification reported 74 Sources, 149 capture versions, 1,318 source assets, 1,391 source segments and 6,421 Claims. These counts and fingerprints match the immediate pre-migration backup.

## Online checks and observed performance

- `https://engine.solotochina.com` and `https://capture.solotochina.com` returned HTTP 200 from `/api/health` and `/api/ready`, with version 2.0.7, Strategy 3.2, database ready and queue 0 queued / 0 running.
- Provider runtime was `available_recent_success` for Vertex `gemini-3.8-flash`. The value comes from persisted call telemetry; the health read did not invoke the provider.
- Authenticated `/api/sources/status?limit=1` and Source detail returned HTTP 200. The projection and timeline matched the current capture version.
- Stable container samples: health 15 calls, p50 13.14 ms and p95 33.13 ms; Source status 15 calls, p50 1,236.75 ms and p95 2,137.13 ms.
- Stable public samples: Engine readiness p50 315.39 ms / p95 320.44 ms; Capture readiness p50 310.99 ms / p95 316.51 ms. Health p50 was 331.78 ms on Engine and 338.94 ms on Capture.
- During restart recovery, two `build_coverage_matrix` jobs used about 108% CPU and took 121.8 and 122.8 seconds. A health call exceeded 30 seconds while this synchronous work occupied the application process. This is a measured remaining bottleneck; more ordinary post-release traffic is needed before attributing provider latency changes to image batching.
- The scheduled full application backup later occupied the same process for 185.1 seconds; two 20-second public health probes timed out during that interval. Health returned HTTP 200 in 1.03 seconds after the backup completed. Backup execution must move outside the HTTP event loop before this maintenance window can be called highly available.

## Dry-run reports

- Processing-gap run `processing_gap_run_02ae6459406946c4aeafb134f43d1160` found 35 Sources and 35 missing-stage actions. Thirty-four candidates carry the legacy `requiresManualStart` value. Fingerprint: `7fe863592b79b15b03e9746dc407fff3b1d52bc847c4ac0d83830cbf6940e642`.
- Media-storage run `media_storage_run_1b35d0a821c24b89b0d7fd4ed99e7cd3` counted 1,666,083,487 encoded characters, approximately 1,249,562,615 decoded bytes, 1,318 asset rows, 999 stored hashes and 1,305 legacy derivative Base64 rows.
- Both reports are stored as dry runs. No recovery jobs or media migration were executed. Online media-storage migration execution remains disabled and automatic deletion remains false.

## Resource capacity and cleanup


- Immediately after rollout, `/` used 38,966,185,984 of 52,589,998,080 bytes (78%) with 11,359,076,352 bytes available. The next scheduled verified backup raised the final sample to 41,030,557,696 bytes used (82%), 9,294,704,640 bytes available and 13,012,317,188 backup bytes. Application data excluding backups was 2,893,779,004 bytes.
- The e2-small had 1,402,855,424 bytes available of 2,072,461,312 bytes RAM and no swap at the idle sample. No disk, backup, Docker-image or original-media cleanup ran.
- The production measurements justify a separate evaluation of moving synchronous coverage work out of the HTTP process or testing e2-medium. This rollout keeps the current VM size because a size change alone has not been benchmarked against the event-loop bottleneck.
- Temporary IAP SSH rule/tag `stc-diagnose-iap-01812cf` was removed after verification. The instance is running and the rule lookup is empty.

## Upgrade and rollback procedure

For another environment, create a disk snapshot and verified application snapshot, run the restore drill, rehearse schema 65 to 66 against the isolated copy, then run the production migration offline. Hash original media and environment before and after migration. Start the immutable 2.0.7 image on the Docker `none` network, require `/api/ready` to report version 2.0.7, then attach it to `solo-to-china` and pin the exact digest.

For this host, the first rollback choice is the retained `engine-before-2f71d45` container paired with the pre-upgrade application snapshot. A full machine rollback uses disk snapshot `stc-pre-207-2f71d45-20260912` and must also restore the matching instance startup metadata because disk snapshots do not include instance metadata. Do not combine old code with the schema 66 database without completing the documented restore path.

## External checks still outstanding

- No paid fixture run was started solely for this acceptance. Quality and request-count changes are established by the fixed offline benchmark; real grouped-image provider latency, token cost, 429 rate and human correction rate require reviewed new production Sources.
- The packaged extension passed automated tests, but reloading it in the user's signed-in Chrome profile and running a real Xiaohongshu capture were not performed from the VM.
- No WordPress article was created or published. Real theme rendering, crawler behavior, Search Console results, ranking, traffic, Core Web Vitals and AI citation remain unverified.
