# Integrated pipeline and admin performance, 2026-09-21

Development evidence for the v2.0 task brief. Base checkout: `40092d4be708a81485ad14f095909174a792028e`; app version remains `2.0.44`, Content Strategy remains `3.8`, local schema advances from 73 to 76. No production writes, remote WordPress writes, paid model calls, Cloud Build, commit or push were made. The repository already contained user edits in the extension, frontend views and three tests; they were retained.

## S0 observed paths

Before this change, approved content could pass through separate `plan_content`, `plan_narrative`, `generate_draft`, frontend page planning/composition, SEO and review calls. A healthy new approved Job now freezes `article_bundle_v1`: `plan_content` invokes one structured bundle call, persists Brief and Draft, composes the page deterministically, then invokes one independent `review_draft` text call. Source extraction and image generation/translation/QA remain separately counted. A bounded repair is an additional call only on failure. Historical Jobs retain the old path. The real Provider call count for the new path is **unmeasured** because a paid canary was not authorized.

Admin request path: React view key → authenticated API → SQL page projection → optional page-specific joins; selection → detail endpoint; visible source IDs → light status endpoint. Previously the source endpoint defaulted to 100 rows, the Content endpoint to 50, menus refreshed overview on navigation, and commercial assets were loaded without SQL pagination. Current defaults are 20, with 50 available. Sources and Knowledge use keyset paging; Content, recommendations and commercial assets use bounded offset paging. The dashboard summary is cached for 15 seconds and invalidated early when SQLite `data_version` changes from another connection. Content still executes 95 SQL statements for a 20-row page in the synthetic fixture; this is a remaining optimization target.

## Local HTTP benchmark

Command: `node scripts/benchmark-admin-http.mjs --isolated-fixture`. The script copies the repository's local preview fixture into a disposable database, adds 400 synthetic Sources and 5,000 synthetic Knowledge facts, runs the API-only role on loopback, and sends 31 sequential requests per route. It counts SQLite statement executions (and prepares), JSON response bytes, HTTP status and event-loop delay. The dataset has no commercial assets or recommendations, so those small payloads are **not** evidence of performance at real volume. No production worker was active. Browser timing includes rendering and network behavior not measured by these HTTP numbers.

| Route | Cold ms | Warm P50/P95 ms | Max ms | Bytes/response | SQL executions cold/warm | Errors/31 |
|---|---:|---:|---:|---:|---:|---:|
| Sources, 20 | 26.34 | 2.76 / 5.05 | 26.34 | 21,111 | 4 / 4 | 0 |
| Content, 20 | 25.25 | 9.46 / 13.40 | 25.25 | 18,747 | 95 / 95 | 0 |
| Recommendations, 20 | 2.57 | 1.07 / 1.71 | 4.22 | 237 | 11 / 11 | 0 |
| Knowledge subjects, 20 | 33.30 | 30.83 / 31.88 | 33.30 | 7,057 | 1 / 1 | 0 |
| Commercial assets, 20 | 2.45 | 1.14 / 1.45 | 2.45 | 163 | 8 / 8 | 0 |
| Settings | 2.67 | 1.56 / 2.26 | 5.24 | 23,690 | 25 / 25 | 0 |
| Dashboard summary | 4.64 | 0.75 / 1.35 | 4.64 | 755 | 27 / 6 | 0 |

Total: 217 requests, zero HTTP errors, 2,224,560 response bytes across the seven routes, event-loop delay P95 31.72 ms and max 33.23 ms. The Knowledge query rewrite was measured on the same synthetic fixture earlier in this development session: hot P95 fell from 94.88 ms to 31.60 ms, though those runs were separate and subject to normal timing variation. The earlier Content repository projection measured 122 rows at 1,056,296 bytes and 736 prepares versus its compact 50-row projection at 46,672 bytes and 227 prepares; these are repository measurements, not a same-route HTTP before/after. Cold/after figures for the other routes have no comparable before measurement, so their before P50/P95, SQL executions, max and error rate are `null`. Active production load P50/P95, menu feedback latency, login-to-first-screen latency and real network transfer timing are also `null` / NOT TESTED.

Local Playwright exercised source page 1→2, a source detail request, Knowledge directory→subject detail and Content directory→production detail against the disposable API database. After the next-page prefetch was added, the browser fetched page 2 once in the background; clicking Next showed `Benchmark source 379` without another page-2 request and then fetched page 3 once. Detail endpoints fired only on selection. At that point, six-menu navigation, mobile rendering, needs-review recovery and active production worker behavior were not tested.

Follow-up local Playwright run on 2026-09-22 opened all six menus on the disposable fixture, selected Source page size 50, reached page 2 (`Benchmark source 349`), and confirmed the Content `needs_review` count changed from 19 to 18 while `producing` changed from 0 to 1 after the user-visible recovery action. The detail showed the saved media-assembly recovery target. The browser console had no errors. The observed session included a single page-2 prefetch. This is a functional browser check; it is not a timed active-production-load benchmark.

## Migration, compatibility and rollback

`node scripts/rehearse-v2-migration.mjs --isolated-baseline` copied the repository's historical schema-69 production baseline to a disposable work database. Schema 76 migration and repeat open passed SQLite integrity. Source 74, Claim 5,147, Draft 7 and Visual 2 counts and sorted ID hashes were unchanged; WordPress publication rows were 0 in this baseline. The baseline stayed at schema 69. This baseline predates the current production database, so the rehearsal does not establish current-data compatibility. Schema 74 introduces revision-bound required manifests, 75 a persisted media lane and quota receipts, and 76 a Job pipeline version. Existing Drafts have no backfilled manifest and fail closed until an explicit recovery creates a current manifest. Old API binaries reject schema 76; rollback needs a paired pre-upgrade database restore, not merely old code. Preserve the current WAL and media for diagnosis and retain successful remote drafts.

Follow-up migration rehearsal on 2026-09-22 used the complete 2026-09-21 production snapshot database as a read-only source. The gzip stream passed CRC validation and the 2,291,630,080-byte baseline matched the snapshot manifest SHA-256. A disposable local copy migrated schema 73 to 76 and passed SQLite integrity, repeat open, and old-column content and ID hashes for 78 Sources, 156 captures, 1,407 assets, 2,275 segments, 5,147 Claims, 8,292 evidence spans, 13 Drafts, 27 Visuals, 12 WordPress publications and 16,190 Jobs. The baseline remained schema 73. This verifies schema/data compatibility on the latest snapshot; it does not exercise live queue recovery, provider transport or WordPress delivery.

A separate disposable production-copy recovery replay found one failed production record. It requested `retry_failed_stage` twice with the same key, received one Job both times, resolved to `generate_visuals`, kept the earlier stages, and preserved all protected entity counts. Model calls and WordPress writes were both zero. This is bounded business-state coverage, not a full cross-stage replay.

The 2026-09-21 production snapshot also passed a full isolated restore drill: 1,207 files, 1,423 verified media references, 1,407 source evidence previews opened, 16 draft media files opened, and one mock delivery probe passed with no external model or WordPress calls. A separate 2.0.46 extension hotfix reached `main` and production during this review. The v2 candidate must be integrated with that mainline and retested before deployment.

## Verification level

| Level | Result | Scope |
|---|---|---|
| L1 targeted tests | PASS | Bundle, publication gate, media quota, commercial pagination and summary invalidation |
| L2 module regression | PASS | Full local Node suite: 770 passed, 0 failed |
| L3 production DB replay | PARTIAL | Latest schema-73 snapshot migration, content identity and one idempotent failed-record recovery passed; broader state corpus pending |
| L4 browser E2E | PARTIAL | Local Playwright list/detail navigation only |
| L5 real Provider canary | NOT TESTED | Paid calls not authorized |
| L6 full production-like replay | NOT TESTED | No complete cross-stage failure chain with a live production-like corpus |
| Post-fix exploratory audit | PARTIAL | Targeted SQL/cache/recovery scans and migration identity check; no current production-state scan |

## 72-item acceptance ledger

`LOCAL` means the cited behavior passed a local automated test, `PARTIAL` means some code or local evidence exists but the full scenario is unverified, and `NOT TESTED` means the specific acceptance scenario was not executed. These labels do not imply production readiness.

| ID | Result | Evidence or remaining boundary |
|---|---|---|
| M01 | PARTIAL | Mock bundle pipeline has one bundle and one review; real Provider untested. |
| M02 | PARTIAL | Structured bundle and legacy projection tested; provider schema acceptance untested. |
| M03 | PARTIAL | Existing DeepSeek schema tests; no current paid call. |
| M04 | PARTIAL | Adapter and local validation tests; native schema acceptance untested. |
| M05 | PARTIAL | Evidence validation tested for body; every SEO/alt date and price field needs more cases. |
| M06 | LOCAL | Required three-slot manifest blocks with only one image. |
| M07 | LOCAL | Required nonfactual illustration is enforced. |
| M08 | PARTIAL | Missing/stale manifest and empty visuals fail locally; forged no-image case not exhaustive. |
| M09 | PARTIAL | Persisted manifest gate; approved no-image creation path needs separate E2E. |
| M10 | PARTIAL | Durable wait/cooldown, needs-review projection; UI count parity not fully tested. |
| M11 | PARTIAL | WordPress adapter guard and pipeline gates; every legacy/manual route not E2E tested. |
| M12 | PARTIAL | Local/delivery gate ordering; all upload receipt combinations not replayed. |
| M13 | PARTIAL | Local media delivery validation; final multi-image placement E2E untested. |
| M14 | LOCAL | Virtual starts 0/31/62 seconds at 2 RPM. |
| M15 | LOCAL | Two actual processes contend for one SQLite visual lane. |
| M16 | PARTIAL | Visual and image-review calls wired to executor; every manual legacy call not audited. |
| M17 | PARTIAL | Retry-After seconds/date and default cooldown tested; server-time extension not fully simulated. |
| M18 | LOCAL | Same-scope cooldown survives executor restart. |
| M19 | PARTIAL | Wait does not spend dispatch; nested provider fallback budget needs fault injection. |
| M20 | PARTIAL | Follow-up 2.0.48 stores bounded append-only grants and exposes an authenticated article action; unit/API tests pass. The complete real recovery and browser flow remains untested. |
| M21 | LOCAL | Persisted candidate resumes QA without generation. |
| M22 | LOCAL | Translation and layout checkpoint tests; upload-only recovery has narrower coverage. |
| M23 | LOCAL | Generated bytes persist as a reusable candidate before local promotion. |
| M24 | PARTIAL | Failed independent QA blocks; bounded re-image sequence not fully replayed. |
| M25 | PARTIAL | Current-source image input tested; full visual input manifest assertions incomplete. |
| M26 | PARTIAL | Unknown outcome is durable; actual worker crash after remote send untested. |
| M27 | PARTIAL | Lease/revision protections have local tests; old remote receipt race incomplete. |
| M28 | LOCAL | Existing bounded repair and frozen media tests pass. |
| M29 | PARTIAL | Existing telemetry tests; all listed provider failure modes not replayed here. |
| M30 | PARTIAL | Existing schema/role tests; unknown stage and v2/v3 historical report cases incomplete. |
| M31 | PARTIAL | Existing source batch/coverage tests; full Golden Source batch replay untested. |
| M32 | PARTIAL | Current production schema 73-to-78 migration, backup/restore rehearsal and full ID/content fingerprint check passed; full media and recovery compatibility remains incomplete. |
| M33 | PARTIAL | Draft-only adapter and previous-post handling tested locally. |
| M34 | PARTIAL | Local browser recovery changed counts and displayed the persisted target; full worker completion and production-like corpus untested. |
| M35 | PARTIAL | Follow-up 2.0.48 local media-stage replay covers two 429 responses, exhaustion, grant, fresh executor and only-missing-image recovery with unchanged body/first-image hash. Full bundle-to-independent-QA-to-mock-WordPress chain remains NOT TESTED. |
| M36 | NOT TESTED | Side-by-side semantic quality review of old/new model output. |
| B01 | PARTIAL | Local browser opened all six menus; timed navigation with active production Worker incomplete. |
| B02 | PARTIAL | Scoped 30-second display cache; precise no-fetch and stale refresh assertions incomplete. |
| B03 | PARTIAL | Account/view/page/filter key; role-switch and credential persistence audit incomplete. |
| B04 | PARTIAL | 20/50 SQL pages for primary lists; full commercial sublists still broad. |
| B05 | PARTIAL | Source/Knowledge SQL filters; deep-page needs-review filter case incomplete. |
| B06 | PARTIAL | On the same production snapshot, Content list fell from 119 to 25 executed SQL statements per 20 rows; nested detail and other broad lists remain open. |
| B07 | PARTIAL | Keyset Source/Knowledge; offset page mutation policy incomplete. |
| B08 | PARTIAL | Playwright observed one page-2 prefetch and one page-3 prefetch after navigation; hidden/no-loop edge tests pending. |
| B09 | PARTIAL | Foreground navigation and mutation abort prefetch; slow-network race test pending. |
| B10 | PARTIAL | Latest detail coordinator exists; menu and mutation race coverage incomplete. |
| B11 | PARTIAL | Mutation patches the row and refreshes asynchronously; all action shapes unverified. |
| B12 | PARTIAL | Error rollback and backend idempotency have local coverage; browser replay incomplete. |
| B13 | PARTIAL | Detail opens on demand; nested tab/log paging remains broad. |
| B14 | PARTIAL | Visible Source IDs status API; row version and sorted-change signal incomplete. |
| B15 | LOCAL | Active/idle/hidden polling cleanup tests pass. |
| B16 | PARTIAL | Health/summary split; Settings still returns 23.7 KB and provider metadata. |
| B17 | LOCAL | Second SQLite connection invalidates summary before TTL. |
| B18 | PARTIAL | Read-only local HTTP routes; zero paid calls by fixture; all GET side effects not audited. |
| B19 | LOCAL | API and worker run in two actual processes against one test DB. |
| B20 | NOT TESTED | 217 live requests were measured with the separate production Worker process up; a simultaneous active image transform and browser menu/paint run is still missing. |
| B21 | PARTIAL | Shared-lock and migration tests; active lease/restart scenario incomplete. |
| B22 | PARTIAL | Single visible view; render profiling and mobile duplicate-tree audit incomplete. |
| B23 | PARTIAL | Vite build passes; split/chunk and original-image preload audit incomplete. |
| B24 | PARTIAL | Summary TTL and data-version invalidation; broader query single-flight test incomplete. |
| B25 | PARTIAL | Existing bulk semantics tests; cross-page browser selection untested. |
| B26 | PARTIAL | Same-snapshot cold/warm P50/P95, bytes, SQL and loopback client event-loop report exists; live 217-request samples are recorded, but busy-worker before/after was not controlled. |
| B27 | PARTIAL | Server routes measured; agreed network/browser target measurement unavailable. |
| B28 | PARTIAL | No Redis added; Content SQL count improved to 25 per 20-row local response, while live Content P95 remains variable and a busy-worker browser profile is open. |
| X01 | NOT TESTED | Complete two-worker/browser/model failure chain not run. |
| X02 | NOT TESTED | Menus and pages under media 429 load not run. |
| X03 | PARTIAL | Local stale payload reached the WordPress adapter after Draft revision changed and was blocked before any remote request; browser race not run. |
| X04 | PARTIAL | Window/cooldown and candidate restart tests; complete grant/recovery chain missing. |
| X05 | PARTIAL | Local mock WP delivery; exact multi-image final chain missing. |
| X06 | NOT TESTED | Concurrent recovery, stale poll and prefetch chain not run. |
| X07 | PARTIAL | Lease and unknown-result rules tested separately; combined race not run. |
| X08 | PARTIAL | Current-data backup, schema migration rehearsal, 2.0.55 twelve-row repair rehearsal and restore-copy fingerprint passed; an actual live rollback and complete historical pipeline replay were not executed. |

## Next development work before claiming v2.0 complete

The original 72-item ledger retains conservative statuses: 12 LOCAL, 55 PARTIAL and 5 NOT TESTED before the row-note updates above. A local pass has not been converted to end-to-end production PASS without its corresponding real flow. The current release and same-snapshot/live measurements are detailed in `CMS_2.0.49_PERFORMANCE_AND_MEDIA_2026-09-22.md`. Separate API and Worker containers now run against one production SQLite volume; the historical photo audit imported 229 SHA-bound local receipts without Provider calls, and 2.0.55 rebound 12 successful visual QA/file receipts after an exact production-copy rehearsal. The production WordPress inventory has two published and ten draft posts. A remotely published post can simultaneously carry a CMS `needs_review` blocker. Real image generation/localization and independent image QA were observed, including quality failures and a durable unknown outcome, while the article-bundle native schema canary received HTTP 429 before generation. The unfinished acceptance cases remain PARTIAL or NOT TESTED.

Production replay exposed a photo-refresh no-op despite a missing required-media slot; 2.0.56 classifies it as blocked. A separate Eling visual Job then reported success with a required slot still `planned` and no model call recorded. The source and asset capture versions were equal. Version 2.0.57 adds a post-stage media gate that fails the Job and prevents downstream page composition until the slot is ready. Regression tests cover both invariants, and a separate historical-asset analysis checkpoint case. Version 2.0.57 is deployed; a bounded live Eling recovery reached real source-image analysis and failed `MEDIA_INCOMPLETE` before composition, proving the new fail-closed behavior. The earlier visual Job finished before its three current image rows were inserted, so its empty-plan success is explained by late seeding, although the seeding-order cause remains unresolved. The immutable manifest still describes the pre-analysis slot, and a new dry-run plan would replace existing photographs; that plan was not applied without article-relevance review. The ledger remains conservative because no complete historical article delivery or concurrent browser/media-load test has passed.

Verify next-page prefetch priority with Playwright, paginate commercial opportunity/queue and nested detail lists, profile Content's remaining detail queries, expose a versioned status summary, then execute M35/X01–X07 fault injection with an isolated current-production copy and Playwright. A separately authorized, bounded real Provider canary is required for schema acceptance and semantic quality. Repeat cold/hot and active-worker measurements in the same environment, record browser timing and compare the new article output against the existing quality corpus before proposing release.
