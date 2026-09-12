# CMS 2.0.6 production rollout — 2026-09-12

The user explicitly authorized commit, push and deployment after the implementation was completed. This record supplements the earlier local-only [T01–T18 implementation audit](CMS_PIPELINE_RELIABILITY_2026-09-12.md). It does not authorize or record publication of WordPress articles, a historical backfill, or changes to the separate Frontend repository.

The [machine-readable production checks](CMS_DEPLOYMENT_CHECKS_2026-09-12.json) preserve the actual container identity, backup and migration fingerprints, final health checks, and individual production timing samples.

## Provenance and validation

- Branch: `codex/audit-v1.3`, starting from clean `2395fe4ed68f7414d777d0156770af76e858eb1b`.
- Core implementation: `f6ffc3d19b22322dd04be069d828c2507a0fc4cb`, pushed to origin. **Final deployed runtime revision: `8a6f3383176c918b3a353ddb586968219d0ffe9a`**, including the Docker packaging correction below.
- Deployment probe/scripts and two regression tests: `9e7f254d23e2eb5a3e68786d9cf8901018e18866`, pushed separately; these do not change application runtime files.
- Helper follow-ups `967fc5d` and `14b98e4` detect missing old `/app/data` before stopping and report bounded non-secret failure diagnostics. An explicit attempt number keeps earlier failed records intact.
- Local consolidated implementation gate: 51 mandatory checks passed, 0 failures, 4 warnings and 5 explicitly untested/unconfigured items; 480/480 tests passed. After adding the deployment tests, `npm test` passed **482/482**, 0 failures, 0 skipped, 22223.8432 ms.
- GitHub Linux release gates passed for both [runtime](https://github.com/Weapon-Tsang/solo-to-china-CMS/actions/runs/34681332150) and [deployment helpers](https://github.com/Weapon-Tsang/solo-to-china-CMS/actions/runs/34681550746). The gate includes Node 24, build/static checks, tests, fixed-SHA Frontend checks, clean migrations, backup drill and isolated smoke checks.
- New probe tests exercise schema 59→65 with preserved cited asset/segment IDs and original files, paired-database rollback retaining the failed database, changed-content rejection and corrupt-backup rejection. Bash syntax check passed.
- Final Cloud Build **`ad416530-c595-4291-8751-582f4261c40f` SUCCESS**, finished `2026-09-12T08:27:56.484830Z`. It built and actually started the runtime image, checked HTTP readiness, and restored a database across separate Docker data/operations mounts. [Final runtime GitHub gate](https://github.com/Weapon-Tsang/solo-to-china-CMS/actions/runs/34683247217) also passed.
- Image: `asia-east1-docker.pkg.dev/project-4bcb9146-c37b-43b0-b11/solo-to-china/engine:2.0.6-8a6f338`; tag `2.0.6` points to the same image.
- **Deployed digest: `sha256:90edeaa896864729a50b4e83a9e86d25e35e6ea438061b2dd5224a9333ba3f03`.**
- Final source comes from `git archive 8a6f338`. An early build (`a26af548-a20b-435a-82f0-8d055937667b`) was cancelled because Windows `tar.exe` rejected some Chinese document paths. Python extracted complete UTF-8 archives for subsequent builds. Local credentials/data/backups/output were excluded.
- Earlier candidate build `5abc6653-aed7-47a8-8498-2b6b0cc99f30` succeeded as a Docker build, but image `69f880927499faaa5e0201900fae9f9b68adcf7e3faaa5e28c4e53fbed6bb36c` failed actual startup and is **not the deployed release**. Build `229c40ba-e386-4081-8ba6-731ae3fb0a7b` then correctly failed the new isolated smoke check because its test fixture omitted required authentication settings; it was not published as the final image. The fixture now supplies explicit test-only credentials without changing production authentication requirements.

## Production operations

- Existing project `project-4bcb9146-c37b-43b0-b11`, VM/disk `solo-to-china-engine`, zone `asia-east1-b`, Docker volume `solo_to_china_data`.
- SSH/IAP diagnostic initially found no ingress SSH firewall rule. Deployment used the existing metadata startup mechanism and controlled stop/start, followed by a verified image-only continuation over IAP. During the long real-data backup/drill, temporary rule `stc-upgrade-iap-f6ffc3d` allowed only TCP 22 from Google IAP `35.235.240.0/20`, targeting the unique tag added only to this VM. **The rule and tag were removed and their absence verified after deployment.** IAM permissions were not expanded. This follows [Google's IAP TCP forwarding guidance](https://docs.cloud.google.com/iap/docs/using-tcp-forwarding).
- Before any production migration, created private persistent-disk snapshot `stc-pre206-20260912-f6ffc3d`; status **READY**, original disk size 30 GB. This is an additional disk recovery point; the application-consistent verified backup is recorded below.
- First startup preflight stopped before touching the database: 1,508,372,480 bytes available; 9,469,695,812 required; current data excluding backups 2,440,737,388 bytes. The old 2.0.5 service still returned health HTTP 200 afterward.
- Expanded the existing disk from **30 GB to 50 GB** rather than deleting originals, backups or images. This increases allocated persistent-disk storage and its ongoing billing. Instance stop/start applies the boot filesystem expansion.
- Guest `google_disk_expand` ran `resize2fs` at `07:48:59Z`; the next preflight reported 21,778,763,776 bytes available. The first switch then stopped at legacy-directory copying, before backup or migration (`stopped=1, renamed=0, migrated=0, exposed=0`). Automatic recovery restored 2.0.5 at `07:51:15Z`; public readiness returned HTTP 200 with the old version and database ready.
- The helper initially matched one Docker error wording for an absent `/app/data`. The corrected helper directly checks inside the running container; attempt 2 confirmed `/app/data present=no` at `07:54:44Z`. It initializes empty persistent capture state only after that check. Attempt 1 is retained at `/opt/solo-to-china/upgrades/f6ffc3d19b22322dd04be069d828c2507a0fc4cb`; attempt 2 uses the `-attempt-2` suffix. No missing old capture state is claimed to have been recovered.
- Upgrade verified `.env.production` and original-media hashes before exposure. After successful deployment, `pin-runtime-image.py` changed **only `ENGINE_IMAGE`** to the immutable final digest; all other configuration bytes were checked unchanged. The previous environment file is retained privately, mode 0600, at `/opt/solo-to-china/upgrades/8a6f3383176c918b3a353ddb586968219d0ffe9a/.env.production.before-image-pin`; its contents were not exported. `cloudflared` was retained.
- Backup and migration probes run with Docker `--network none`, without starting the CMS or model/WordPress clients. The new application first passes readiness on an isolated network before being connected to the existing public service network.

## Actual production backup and restore drill

The offline probe started at approximately `07:56:50Z` and returned backup/drill success at `08:08:43Z` (about **11 minutes 53 seconds**, including baseline integrity/fingerprints and repeated full backup/restore verification on an `e2-small` VM). This real maintenance cost is much larger than empty-fixture timings. Monitoring and direct container inspection confirmed active work during this interval; no success was inferred from waiting.

- Snapshot: `/var/lib/solo-to-china/backups/solo-to-china-2026-09-12T07-58-50-074Z.snapshot`.
- Backup schema **59**, integrity **ok**, file count **1009**, database size **1,918,566,400 bytes**.
- Database SHA-256: `d3f339ae6f5139492b550314e7f940b86f1b016a1ecf87969cae1d675594fda7`.
- Restore drill **passed**, `externalSideEffects=false`, **1318** evidence references successfully opened. No article drafts or draft visuals existed in the production backup, so draft delivery was **not applicable**, not a passed end-to-end WordPress test.
- Baseline rows: sources **74**, capture versions **149**, source assets **1318**, source files **0**, source segments **1391**, claims **6595**, evidence spans **5588**, extraction coverage **1389**, article drafts **0**, article visuals **0**. Migration probes compare content hashes and IDs as well as these counts.

## Migration, failures caught, and final switch

- Backup-copy migration/verification passed at `08:12:50Z`: schema **65**, integrity **ok**, **0** foreign-key errors, all baseline table fingerprints and counts identical; `migrationMs=223071`.
- Production migration/verification passed at `08:16:40Z` with the same results; `migrationMs=227110`. These durations include migrations, integrity/foreign-key checks, content fingerprinting and checkpointing, not just DDL execution. Original media/environment hashes passed at `08:16:59Z`.
- The initial candidate failed isolated runtime startup: `ERR_MODULE_NOT_FOUND /app/extension/media-contract.js`. The server had begun sharing pure media/scheduling modules with the extension, but Docker's runtime stage did not copy that directory. Dockerfile now copies it, and CI/Cloud Build actually start the built image. Source-tree tests and a successful image build alone did not catch this defect.
- Automatic rollback then hit `EXDEV` moving the database from the data mount to `/ops`. Bash's error handling inside an `||` context incorrectly allowed the offline wrapper to report success. The old 2.0.5 container ran from `08:20:14Z` until it was stopped at `08:21:22Z`, while the database remained schema 65. This was a deployment-helper failure, not a successful rollback. The original database was not moved by the failed rename.
- Both helper defects are fixed: failed databases now stay **inside the data mount**, and a failed Docker probe explicitly returns failure before any old-container start. A real Docker regression with separate mounts passed. The old container was stopped with restart disabled, and an independent offline recheck passed in **102349 ms**: schema 65, integrity ok, zero FK errors, and every recorded source/version/asset/file/segment/claim/evidence/coverage/draft fingerprint exactly matched the pre-upgrade baseline. No source/material replacement was used to make that check pass.
- The corrected image passed isolated readiness. Docker requires disconnecting its `none` network before attaching the service network; this was applied, added to both deployment helpers, and added to the runtime-image smoke test. The successful continuation used `resume-verified-upgrade.sh` with the freshly verified, stopped database; it did not re-run migrations or restore older data.
- **Production completion recorded at `2026-09-12T08:31:57Z` (16:31:57 Asia/Shanghai).** Runtime revision and image digest were read back from the actual running container, schema 65 from the production database, and the container is attached to `solo-to-china`.
- Final records: `/opt/solo-to-china/upgrades/8a6f3383176c918b3a353ddb586968219d0ffe9a`. Old container: `engine-before-8a6f338`, stopped, restart disabled. Failed candidate container is retained separately. The active `/app/data` bind mount is `/opt/solo-to-china/upgrades/f6ffc3d19b22322dd04be069d828c2507a0fc4cb-attempt-2/legacy-app-data`; retain that directory in future backups and upgrades.
- Startup metadata now points at the final immutable image/revision and recognizes the completion marker; a later boot starts the existing containers without re-running migration. Disk-snapshot rollback must also restore the intended startup metadata, because instance metadata is not part of a disk snapshot. Do not use the fresh-install provisioner or old Compose layout to replace this native Docker installation.

## Online checks and observed performance

All seven post-switch HTTP probes passed their expected statuses: Engine health/readiness **200**, Capture health **200**, Capture dashboard **404**, authenticated dashboard summary **200**, sources list **200** (20 returned), and strategy **200**. Version **2.0.6**, Strategy **3.1**, media protocol **v2**, database ready.

Isolated startup temporarily marked the Frontend Contract cache stale. One explicit CMS contract-sync job refreshed its read-only upstream schema resources after network connection. Final status **healthy**, contract **1.3.0**, fixed Frontend SHA `f44ce1092ced93dfb47d9b3eae83d0d5e4b97086`, 26 stable components, `canCompose=true`, queue active **0**. The live service reports registry checksum `d049ccabc8efe98a00bfcd48936585b31d54e41c0421ff07f5bb55c4aa7b44f2`; this live response value is recorded separately from the checked-in contract fixture checksum. No Frontend repository or WordPress article was modified by contract refresh.

The first external probes measured health/readiness around 401–557 ms, summary 3947 ms and sources 3844 ms. Three subsequent read-only rounds, including network time, measured:

| Endpoint | Round 1 | Round 2 | Round 3 |
|---|---:|---:|---:|
| health | 895 ms | 415 ms | 378 ms |
| dashboard summary | 2038 ms | 725 ms | 276 ms |
| sources, limit 20 | 2231 ms | 2019 ms | 2068 ms |

These are **three observations per route**, not a production stress test or a reliable production p95 estimate. Sources still take about two seconds on this dataset/VM/network path. No before/after production speedup is claimed. The separate [ABBA mixed-load benchmark](CMS_PIPELINE_RELIABILITY_2026-09-12.md) measures the implemented responsiveness/memory gains and the slower finalizer batch explicitly; it does not substitute for these production observations.

## Extension handoff

A private cloud-configured 2.0.6 package was generated at `output/release-2.0.6-f6ffc3d/extension-cloud` and `SoloToChina-extension-2.0.6.zip` beside it. It reuses the existing Capture credential and is ignored by Git; do not publish it. The temporary credential input file was removed. Update the **existing loaded extension directory** and reload it in Chrome to preserve its extension ID and IndexedDB; do not uninstall and reinstall into a different directory while captures are pending. Real Chrome/MV3 and Xiaohongshu acceptance is still outstanding.

## Remaining acceptance boundaries

The implementation audit remains authoritative for unverified real Chrome MV3/Xiaohongshu lifecycle behavior, large-video streaming (not implemented; explicit browser limits apply), real model semantic quality/latency/cost, end-to-end article production and WordPress delivery, and search outcomes. Production deployment does not imply those checks passed. No probes publish WordPress articles or schedule a backfill. The browser extension still needs to be reloaded/updated in the user's Chrome profile after backend protocol v2 is confirmed.
