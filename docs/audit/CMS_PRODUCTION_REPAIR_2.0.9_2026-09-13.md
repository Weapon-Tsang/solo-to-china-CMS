# CMS 2.0.9 production repair and storage cleanup — 2026-09-13

## Scope and observed production state

This follow-up investigated the live Source list and Recommendation inbox before changing data. Production was running revision `afaf4e7678ef377ccbf3921704ba637289d3a323` (App 2.0.8, Strategy 3.3, schema 67). The live database held 74 complete Sources: 39 were processed, 34 were captured and one was processing. There were 74 historical intake analyses but no current Strategy 3.3 analyses, except the single analysis created while the audit was running. Of 1,032 opportunities, 1,004 were system-owned superseded processing gaps and only one was current and actionable.

The Source processing-gap dry run found 35 Sources with no active recovery job: 34 retained the removed estimated-call manual-start decision and one had completed every extraction stage without the final Source status transition. One background completion reduced the reviewed production set to 34 before execution. None of the Sources had a technical hard-limit blocker, and every discovered original was stored.

The two Sources reported as failed in the list were already complete in current state:

- `重庆两日游攻略（美食版）` had 15/15 extracted and audited segments, 14/14 stored media originals and a successful current Experience run.
- `重庆📍三日游丨懒人版保姆级逛吃攻略‼️` had 14/14 extracted and audited segments, 13/13 stored media originals and a successful current Experience run.

Both retained old failed segment jobs from September 11, followed by successful current extraction. The full Source endpoint suppressed those old failures, but the lightweight polling projection did not. Polling therefore replaced the correct first render with a historical red failure while the detail view continued to show the current successful state. Successful jobs could also retain `last_error` from an earlier retry.

## Implemented correction

Revision `2e1919118aac6f4744cf9ade5fa802523bef6625` makes the lightweight projection use the same current-state rule as the full Source endpoint. A processed Source does not expose an old terminal job as its live queue state; the immutable timeline still contains the failed attempt. Successful completion now clears error class, code and text.

Recommendation reconciliation now inventories Sources whose latest diagnostic was produced by an older strategy, fingerprints that exact set in a dry run, and accepts execution only against the unchanged reviewed fingerprint. Execution rebuilds the derived opportunity indexes and queues current diagnostics under the historical-recovery workload lane. A Strategy upgrade can no longer supersede the prior inbox without also providing a bounded path to create replacement recommendations.

The old estimated-call gate remains removed. One text segment plus 19 ordinary images is normal automatic work. The media planner preserves every Source/asset/segment relation and groups the 19 images into four model batches of 5, 5, 5 and 4; it does not pause the Source. Only an explicit technical hard limit, login/verification/authorization requirement or user pause can stop it.

## Reviewed production recovery

- Processing Gap dry run: `processing_gap_run_cf2019a7b601491b81c130e3ee217c9c`, fingerprint `7de8f78c773732c92e808afcd86e2126b691478087fdd99ee5f5a1b8ef31a3fe`.
- Processing Gap execution: `processing_gap_run_d982d74799924dc29cc7c9a719bfec8f`; 34 first-missing-stage jobs queued, comprising 33 legacy-gate Sources and one missing finalization.
- Recommendation dry run: `backfill_9912a3846ac146b081df66148adb975b`, fingerprint `7d51d649014d721acc1fa0cd7d34f11abe8a472b74546efc3c51300eb172f917`.
- Recommendation execution: `backfill_bd41ea00c9f748f4b5f71d27de8edfef`; 40 ready Sources with stale diagnostics queued, while the 33 Sources still being extracted will reach the same diagnostic stage through their normal pipeline.
- Historical successful-job cleanup: 909 stale error payloads cleared; zero successful jobs retained an error afterwards.

The subsequent 2.0.10 audit determined that Strategy 3.0-3.2 diagnostics use the same Intake decision contract as 3.3. Fourteen of these jobs had completed before intervention; the remaining 26 queued diagnostic jobs were stopped with `SUPERSEDED_RECONCILIATION_REUSE` before a provider call. The replacement reconciliation promotes compatible stored diagnostics locally and is recorded in `CMS_PRODUCTION_REPAIR_2.0.10_2026-09-13.md`.

No Source, Source asset, Claim, Experience block or immutable timeline event was deleted. No content opportunity was approved, no production task was started from an opportunity, and no WordPress draft or post was created or published.

## Upgrade and rollback evidence

Cloud Build `77f2b62b-153d-438b-987b-37ef293ff260` produced the immutable image:

`asia-east1-docker.pkg.dev/project-4bcb9146-c37b-43b0-b11/solo-to-china/engine@sha256:9251804f66aedeb7a3db465a88b6268cfd3c5da3e307fb0538afa0a2bc636bec`

The upgrade created and verified one retained snapshot directory before changing the runtime. Its database was 1,974,296,576 bytes with SHA-256 `b10e001e16cecb4829735d95594710d7cb24d7dfabb0c2cb579ea059ebbf4758`, schema 67 and `integrity_check=ok`. The isolated restore drill opened all 1,318 Source-asset references and made no external model or WordPress call. Rehearsal and live migration both reported zero foreign-key errors and identical fingerprints for Sources, capture versions, Source assets, Source segments, Claims, evidence spans, extraction coverage, drafts and draft visuals.

Production readiness passed before network attachment. The active container reports App 2.0.9, Strategy 3.3 and schema 67, uses the exact image digest above, and had zero restarts in the post-deployment check. The immediately preceding `2.0.8-afaf4e7` container and registry image are retained as the single paired rollback generation.

## Storage result

Before cleanup the VM root used about 50.4 GB (63%). `/var/lib/docker` used 39.28 GB, including about 17.98 GB of retained local backups and 18.4 GB of overlay layers; `/opt/solo-to-china/upgrades` used 8.19 GB, mostly rehearsal databases. There were 80 local images, 16 backup generations and four project-specific GCE upgrade snapshots.

After the successful upgrade, the VM root used 9,181,143,040 bytes (12%) with 71,559,458,816 bytes available. `/var/lib/docker` used 6,704,759,245 bytes, including the live volume and one verified snapshot; `/opt/solo-to-china/upgrades` used 1,522,156 bytes of audit records and no rehearsal database. Local Docker held only the active engine, its immediate rollback image and Cloudflared. Artifact Registry was reduced from 80 engine digests to the current and immediate rollback digests. The four SoloToChina GCE snapshots, 33,247,058,112 bytes (about 31.0 GiB) of remote snapshot storage, were deleted; snapshots belonging to unrelated VMs were left unchanged.

Future successful upgrades retain one verified local content snapshot and one immediate rollback container, remove rehearsal SQLite files and older stopped engine containers, then prune all unreferenced Docker images. GitHub stores source code, while the production SQLite database, uploaded originals, environment and deployable image are separate state. The single verified snapshot and immediate rollback generation remain necessary for a fast, paired rollback; older generations have no active deployment role.

## Verification

- `npm test`: 514 passed, 0 failed.
- `npm run check`: passed; Vite built 1,882 modules, JavaScript 431.55 kB (134.90 kB gzip), CSS 57.45 kB (10.51 kB gzip), and all 12 dependency-boundary checks passed.
- `npm run release:check`: 51 mandatory checks passed, 0 failed, 4 environment warnings and 5 explicitly not-tested external conclusions.
- Queue/media benchmark: all five fixtures passed; the one-text-plus-19-images fixture reduced 20 legacy calls to five planned calls (75%).
- Knowledge benchmark: full coverage rebuild 166.02 ms, incremental rebuild 15.70 ms (10.57x); model intake reduced from 571,331 to 59,423 bytes (89.6%). Isolated worker p50/p95 was 0.80/1.37 ms and isolated backup p50/p95 was 0.71/1.06 ms.
- Production database after migration: schema 67, `integrity_check=ok`, zero foreign-key errors.

The production provider returned intermittent Vertex 429 responses during recovery. Historical work remained queued with backoff and did not block interactive intake. Batch output that could not pass exact item-correlation checks was quarantined and returned to realtime extraction; unverified Batch results were not committed.
