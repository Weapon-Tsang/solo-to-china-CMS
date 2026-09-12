# CMS queue, performance and media implementation report

Date: 2026-09-12. Baseline HEAD: `01812cf92cc6bff996443987430bc7b34cdcce1b`. Baseline production runtime: `8a6f3383176c918b3a353ddb586968219d0ffe9a`, App/Extension 2.0.6, Strategy 3.1, schema 65.

## Production facts captured before implementation

The production inspection was read-only. It did not publish WordPress content, start historical processing, mutate source evidence or delete files.

- Queue: 0 queued, 0 running, 991 historical failures, 7,156 succeeded. Of the failures, 949 were expired/forbidden remote media inputs; recent model pressure showed 189 HTTP 429 attempts and no timeout attempts in the inspected 24-hour window.
- Thirty-four complete Sources were held in `captured` only because their stored v1 estimate had `requiresManualStart=true`. Their current capture versions had complete original media and no current segments/extractions. Counts included 19, 21, 24 and 27-image Sources. The 19-image case reached the old threshold because one text segment plus nineteen image calls equalled twenty.
- Three Sources showed `processing` without an active job. One had current segments/extractions but no coverage; two stopped after retryable claim extraction failures.
- The latest provider success was a Vertex `source_editorial_blueprint` call using `gemini-3.8-flash` at 12,973 ms. The latest nearby failure was `MODEL_OUTPUT_LIMIT`, not a connectivity failure.
- SQLite was 2,340,265,984 bytes with about 406 MB on the freelist. Embedded media occupied roughly 418 MB in `sources.raw_payload_json`, 428 MB in `capture_versions.raw_payload_json`, 417 MB in `capture_versions.assets_json`, and 411 MB in `source_assets.ai_derivative_data_url`.
- There were 1,318 asset rows, 999 distinct stored hashes and 999 distinct paths. Physical original files were already content addressed; repeated database Base64 was the main duplication.
- The Docker volume used about 11.38 GB, including 8.50 GB of backups. Docker images used about 16.29 GB, of which Docker reported 15.5 GB reclaimable. No cleanup was executed.
- Root disk was 69% used with about 16.0 GB available. The e2-small had about 1.43 GB memory available, no swap and was idle during the sample. This did not justify resizing the VM.

The detailed diagnostic JSON remains in the ignored local `output/` directory because it contains source-level production metadata. This tracked report contains only the aggregates needed for review.

## S0-S5 / T01-T18 results

| Task | Implemented behavior | Verification |
| --- | --- | --- |
| T01-T02 | Processing estimates are `normal`, `heavy`, `oversized` or `blocked_hard_limit`. Work size never requests a manual start. Only explicit file/total/media hard limits block. | Regression covers 18, 19 and 27 images plus a 513 MiB hard-limit case. |
| T03 | Historical gaps use `runSourceProcessingGapRecovery()`. Default is a stored dry run; execution requires the exact dry-run ID and unchanged fingerprint. Jobs use priority 70. | Test proves dry run creates no job and an approved execution creates only the missing stage. Production execution is intentionally not automatic. |
| T04-T05 | `/api/health` separates service readiness, AI configuration, provider runtime and queue health. Provider state comes from persisted model-call telemetry. `/api/sources/status` is a bounded projection and visible queue polling remains 7.5 seconds, dropping to 120 seconds while hidden. | UI build and request coordinator tests; health reads make no provider call. Manual connection test is a separate authenticated POST. |
| T06 | Ordinary images form durable, balanced groups of 4-8. Maps, tables, text-dense screenshots and videos remain individual. The model input names exact asset/segment IDs; output Claims are split back to their matching segment. | A 19-image fixture forms 5/5/5/4 groups and proves one scoped Claim is written once, while a route map stays outside the group. |
| T07-T08 | Source profile records `complete_source`, `segmented` or `fragment`. Compact Experience/Intake DTOs omit raw HTML and full-source text duplication. Fragment downstream routing remains behind the existing quality flag. | Five-type benchmark records all three routes; package tests continue to enforce evidence IDs. |
| T09-T10 | Model metrics include queue, provider request, retry and total stage time, route, cache hit and backoff fields with 1h/24h aggregates. Source detail includes a capture/job timeline and current stage. | Persisted provider runtime and capture-version status tests pass. |
| T11 | Lower numeric priority remains higher priority. New interactive work stays realtime; reviewed historical recovery uses priority 70 and eligible text work can use Vertex Batch. | Existing queue/Batch regression suite plus the processing-gap priority assertion. |
| T12-T14 | Original, derived, delivery and temporary media lifecycles are separated. New capture snapshots strip embedded media copies. Valid images use content-addressed files/side-table references; a single legacy database value remains as compatibility fallback when file materialization is unavailable. Historical Base64 migration is estimate-only online. | Backup/preview compatibility tests and non-mutating media migration test pass. |
| T15 | Existing system snapshots retain SQLite, source uploads and delivery media with hashes, retention metadata, verification and isolated restore drill support. | Existing backup suite and deployment rehearsal cover integrity and references. |
| T16 | Production disk/CPU/memory were measured before changes. No VM resize or disk cleanup was performed. | Values are recorded above. |
| T17-T18 | Fixed five-type benchmark covers short text, long text, 19 images, 27 images plus a map, and video with notes. Strategy 3.2 and the 2.0.7 upgrade/handoff docs define flags, migration and rollback. | `CMS_QUEUE_MEDIA_BENCHMARK_2026-09-12.json` is machine readable. |

## Performance evidence

The deterministic benchmark makes no paid model calls. It measures real SQLite migration, capture persistence, segmentation and batch planning. After correcting the legacy comparison to use actual segments, it reports the request-count change and per-fixture local duration. Provider latency improvements require new production traffic and are not claimed from this benchmark.

The pre-change 24-hour telemetry showed the main external bottlenecks:

- source research: 637 successes, average 14.4 s; 83 rate-limited attempts;
- coverage: 54 successes, average 8.78 s; 5 rate-limited attempts;
- Experience: 106 successes, average 19.28 s; 30 rate-limited attempts;
- blueprint: 106 successes, average 7.74 s; 22 rate-limited attempts;
- intake: 104 successes, average 52.1 s and 63,037,347 total input tokens; 48 rate-limited attempts.

The compact DTO and media grouping target these two measured causes: repeated large downstream context and one provider request per ordinary image. Real post-release latency and 429 changes must be evaluated after ordinary new Sources complete.

## Items deliberately left manual

- No historical processing-gap execution, Base64 deletion/migration, Docker image pruning, backup pruning, database vacuum or WordPress publication runs automatically.
- `COVERAGE_AI_ROUTING_ENABLED` defaults to false. Conditional AI coverage can be enabled only after a reviewed content-quality comparison.
- `SOURCE_COMPLEXITY_ROUTING` retains its prior default false for downstream fragment skipping.
- Production content quality for newly grouped real images cannot be verified without running paid extraction on selected sources. Asset/segment attribution, batch bounds, retry and coverage invariants are verified offline.

## Production rollout verification

Release `2f71d45ddf80b588a58789aa94c251413fa498b7` was deployed as App 2.0.7 / Strategy 3.2 / schema 66. The verified backup and restore drill, immutable image, migration timings, live endpoint checks, dry-run IDs, resource measurements and rollback locations are recorded in [CMS_DEPLOYMENT_2.0.7_2026-09-12.md](CMS_DEPLOYMENT_2.0.7_2026-09-12.md).

At a stable empty queue, container health p50/p95 was 13.14/33.13 ms and the Source status projection was 1,236.75/2,137.13 ms across 15 calls. During restart recovery, two synchronous coverage rebuilds each occupied roughly 108% CPU for about 122 seconds and one health request exceeded 30 seconds. The e2-small therefore remains a measured bottleneck during this CPU-bound stage. A worker-process change or e2-medium trial needs a separate benchmark; this release does not claim that local request-count improvements removed that production limit.

