# 2.0.78 required source-photo recovery

Change class: PIPELINE / DATABASE_LOGIC. Same-schema CODE_ONLY_RELEASE; schema 83 / Content Strategy 3.9 unchanged.

The screenshots identify two approved articles blocked during required original-photo selection. Investigation found three deterministic recovery defects: cached recognized photos were not locally audited; a failed required visual slot prematurely stopped continued discovery; and an earlier low-quality original could mask a later qualified, relevant original. Recovery now audits cached originals in durable local batches, continues until the required slot is satisfied or bounded discovery ends, and considers a qualified relevant original before an unqualified exact selection. Qualified immutable derivatives and factual/location gates are preserved.

Tiny images receive a negative-only local resolution check before paid recognition. Passing dimensions does not establish image identity, authorization or delivery quality. SHA-matched rejections are reused; local-only progress defers without consuming a job attempt or provider allowance. No new provider schema/prompt/model is introduced. An unchanged no-relevant-image retry is refused even when a failed required slot exists; newly auditable/discoverable or actually repairable media can still recover.

## Actual source inputs

The affected drafts expose 147 distinct authorized retained originals (38 for Museum, within Zoo's 147). Those original files were read from production without mutation, copied locally and individually SHA256 verified. A contact-sheet inspection found city-wide itinerary/guide collages, comment emojis and dogs, low-resolution panda photos, and a Museum photo embedded in a multi-place guide card. No replacement image was fabricated, upscaled to simulate quality, or silently substituted.

Two recognized panda originals are 640x480 and 640x853; both fail the existing local photo resolution gate. Their location metadata also does not establish an exact Chongqing Zoo scene. The Museum picture inside its Day-4 collage is only roughly 335x189 within a 1080x1443 card; a crop does not satisfy the existing original-photo quality requirement. Fixing recovery is not equivalent to supplying a qualified original for either article.

## Verification before release

- L1 Targeted Tests: PASS. Cached recognition audit with zero additional paid calls; fourth-image discovery with a persisted failed required slot; cached local audit continuation to a qualified fourth original; negative-only resolution screen; refusal of unchanged recovery. Production screenshot cases are permanent regressions.
- L2 Module Regression: PASS for the 124 directly related tests, with additional resolution and recovery regressions and the complete release gate recorded in ignored evidence. Final `npm run release:check`: PASS, all 50 mandatory checks, zero failures. A fixture accidentally used duplicate original hashes and was corrected; discovery intentionally deduplicates identical bytes. The legacy required-gap assertion now expects the more specific no-relevant-image terminal reason.
- L3 Production DB Replay: PASS. A read-only production-derived baseline was copied to a disposable work DB; 147 exact original files verified. Both affected owners ran image-stage recovery to explicit `MEDIA_DISCOVERY_NO_RELEVANT_IMAGE`, with no active jobs, duplicate active owners or orphan active owners. Unchanged retries refused. All article bodies, source rows, Knowledge and WordPress receipts preserved. No real provider or production writes in this replay. Thirteen remaining card recognitions use an offline manual-corpus fixture; this is deterministic pipeline replay, not a real-provider success claim.
- L4 Browser E2E: NOT TESTED in this run so far. The local API is ready; the browser reports connection refused, then rejects its internal data URL. Do not label API verification as browser E2E.
- L5 Real Provider Canary: NOT REQUIRED for the deterministic code changes; actual production recovery results will separately record real paid requests and terminal outcomes.
- L6 Full Production Replay: NOT TESTED. Neither affected article has yet been verified through successful final page/WordPress delivery with qualified media. Offline gate/fixtures and a single image recognition cannot establish article completion.
- Post-Fix Exploratory Audit: ISSUES FOUND. Genuine retained-media input gaps remain. The disposable recovery leaves no active/orphan/duplicate-owner jobs. Live audit is recorded after deployment/testing.

Ignored evidence is under `output/content-media-completion-20261001/`.

## Released version and actual production runs

Code commit `e277016043f4f6d723e134288ad662fd9fd3b86c` was committed, pushed to `main`, and deployed as 2.0.78 using the same-schema code-only procedure. Cloud Build `ccc872d5-6b1f-4c09-a005-63f38082be13` succeeded. The immutable production image is `sha256:44b927e50aef612640a25072d5a96d98e740ffc8a1a82d246e78e15602c11f46`. Isolated startup, readiness, Linux runtime checks, container switch and resume-only startup metadata verification passed. The prior 2.0.77 image and stopped containers are retained for rollback. No production schema migration, full backup, disk snapshot or backfill ran. The remote has only `origin/main` after pruning; there is no remaining feature branch to delete.

Real production recovery was requested through the normal authenticated API, scoped to the two affected approved owners. Existing planning and article bodies were preserved. Times below are UTC on 2026-09-30 (2026-10-01 in Asia/Shanghai).

| Owner | Real job | Outcome | Paid recognitions |
| --- | --- | --- | --- |
| Museum | `job_4f7891639fa84d958503b8c78c48a0e7` | 18:36:02, `MEDIA_DISCOVERY_NO_RELEVANT_IMAGE` | 0 |
| Zoo, first bounded run | `job_987825baf6a1473ba250b93736eb3ff4` | 18:49:29, `MEDIA_DISCOVERY_BUDGET_EXHAUSTED`, three remaining candidates | 12 |
| Zoo, scoped continuation | `job_224e603636f4426b9ef6354ba98d0cd3` | 19:00:18, `MEDIA_DISCOVERY_NO_RELEVANT_IMAGE`, zero remaining candidates | 1 |

The Zoo continuation correctly reused all earlier recognition results. Its two tiny remaining originals were rejected locally and only its one remaining full-size card called the real provider. All 13 recognitions succeeded, with no repeated original IDs across the three test jobs and no provider error recorded. Actual request latency ranged from approximately 7.3 to 57.1 seconds. Successful recognition did not qualify a collage as a relevant documentary photograph.

Final read-only owner inspection confirms both records are explicitly failed at `generate_visuals` with a permanent input reason and an empty discovery/local-audit queue. No active jobs, duplicate active production owners or orphan active production owners remain. API and worker containers have zero restarts and zero OOM events. The authentic input gap remains: low-resolution panda originals and an insufficient embedded Museum photo. These outcomes establish termination/recovery behavior, not successful final article delivery.

Final authenticated API verification completed at 19:04:18 UTC. Both unchanged-input retry requests returned HTTP 409 with a request to supply relevant original media. Database job counts and model-call counts were unchanged by those requests. All 16 article bodies and 14 WordPress publication receipts retain their exact pre-release fingerprints. Content list API HTTP 200 projects the same failed stage and exact terminal reason as the persisted jobs. Final live verification evidence is `real-production-test.json`; its PASS applies only to recovery, termination, reuse, protected-data and job invariants, not article completion.

Final coverage: L1 PASS; L2 PASS; L3 PASS; L5 real recognition canary PASS for 13 actual recognitions, including continuation and reuse. L4 Browser E2E NOT TESTED: the browser could not connect to the local replay server, its internal connection-error data URL was rejected by automatic safety review, and a normal production HTTPS navigation timed out. The disposable local server was stopped after testing. L6 successful full article/page/WordPress delivery NOT TESTED because neither article has a qualified required source photograph. Post-Fix Exploratory Audit: ISSUES FOUND (retained-media input gaps); no active/orphan/duplicate-owner job findings. Do not report these two articles as completed or published.
