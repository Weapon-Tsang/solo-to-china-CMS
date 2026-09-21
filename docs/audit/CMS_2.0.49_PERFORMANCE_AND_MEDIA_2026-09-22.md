# CMS 2.0.49: production-data replay and release evidence

This record distinguishes measured results from the requested targets. The 2026-09-22 baseline is a consistent, read-only copy of the live schema-73 SQLite database. Initial migrations, photo scans and HTTP benchmarks ran on disposable copies. The later, explicitly authorized production releases and bounded historical repair are recorded below; remaining article gates and tests are not counted as successes.

## S0 call and request paths

New approved content uses one structured `article_bundle_v1` generation followed by one independent text review. Source extraction, source-media analysis, image generation or English infographic translation, and independent visual QA have their own call and budget records. Existing article bodies, qualified images and accepted QA are retained across retries. The API process serves authenticated routes; a separate Worker claims jobs from the same SQLite database. Image dispatch uses the durable shared lane and quota receipts. The dashboard's list cache is for display only; delivery checks the latest media manifest, source audit, QA and budget receipts.

The extension capture path is browser extraction, a bounded model batch when needed, persisted source assets, source analysis, and then production candidates. The default extraction batch is 8 images. Already deleted source identities are tombstoned so a later extension sync skips them. Direct reuse of high-quality, relevant source photos adds no image or model request. Dense Chinese information graphics are still sent through translation and independent visual QA; missing essential visuals still use generation. The photo policy is a composition rule, not a blanket photo-first ranking.

The admin path is page-scoped React fetch, authenticated API, bounded SQL projection, then on-demand detail. Menus default to 20 actual SQL rows, optionally 50; one next page can be prefetched. Source lists now use current-capture asset/segment counts with covering indexes. Content state derives current independent QA evidence through batched reads. Recommendation responses omit large internal opportunity JSON that the list does not render.

## Fresh production snapshot and migration

The baseline contains 78 Sources, 1,505 assets, 2,328 segments, 5,331 Claims, 8,475 evidence spans, 13 Drafts, 27 Visuals, 12 WordPress publication rows and 16,378 Jobs. SQLite integrity is `ok`. A disposable copy migrated schema 73 to 78, reopened twice, retained every old-column content and sorted-ID hash for these tables, and passed `integrity_check`; repeat migration was idempotent. The immutable baseline SHA-256 is `d3f1c241cc72fef393d62326aeee3938f6fdc93986bd8e73a262f6d1216cb676`. The independent media archive SHA-256 is `44186fd8d869bb2094310093a0553d1ba4fc60c9cf68121776f78b1ae302065f`. Local evidence files are under `D:\codex\stc-v2-release\`; they are outside Git and are not a production backup.

Schema 78 adds source identity tombstones, file-deletion work receipts, SHA-bound photo audits, article photo-refresh records and WordPress publish/media-refresh attempt records. Code 2.0.46 must not be run against migrated schema 78. A rollback after public writes must first preserve the new database and media, reconcile new captures and remote posts, and restore the paired old image/database/media set.

## Same-snapshot admin measurements

`scripts/benchmark-admin-snapshot.mjs` sent 31 sequential loopback requests per route to an API-only process. Both versions used disposable copies of the same fresh production snapshot. Warm P50/P95 exclude the first request. SQL is executed-statement count per response. No production Worker was active. The compact recommendation result was measured in a later route-only run on the same copy; its timing is not a simultaneous before/after pair. UI paint, internet latency, and active production load are excluded.

| Route, 20 rows | Before cold ms | Before warm P50/P95 ms | After cold ms | After warm P50/P95 ms | Before → after bytes | Before → after SQL |
|---|---:|---:|---:|---:|---:|---:|
| Sources | 3613.65 | 1632.32 / 1693.32 | 140.82 | 98.35 / 123.86 | 47,810 → 48,412 | 2 → 4 |
| Content | 2644.68 | 136.61 / 146.33 | 189.44 | 165.28 / 173.95 | 14,320 → 14,316 | 119 → 25 |
| Recommendations | 1408.03 | 42.28 / 46.59 | 67.50 | 40.59 / 44.36 | 256,516 → 13,697 | 11 → 11 |
| Knowledge subjects | 1223.24 | 100.14 / 106.52 | 53.32 | 54.07 / 55.81 | 8,093 → 8,093 | 1 → 1 |
| Commercial | 42.25 | 1.79 / 3.49 | 2.50 | 1.31 / 2.33 | 7,781 → 7,835 | 7 → 8 |

All five successful routes returned HTTP 200 in every sample. The Content list is about 29 ms slower warm while now evaluating the same current QA evidence as the on-demand detail; its SQL count fell from 119 to 25. A real-data parity check found identical compact and detail status for all 13 Drafts. The seven-route before run had event-loop delay P95 1660.94 ms; the after run before final recommendation compaction had P95 171.44 ms. The later recommendation-only run had P95 43.61 ms. Settings and dashboard returned HTTP 409 on both local copies because the snapshot was deliberately started without its encryption key; their apparent latency is **not a successful measurement**. Production-active response times and menu paint are **NOT TESTED** at this point.

## Existing article and media replay

Of 229 current source photos linked to historical Drafts and available in the copied archive, local focus/size/OCR checks accepted 58 and sent 171 to `needs_review`; none were missing in the copy. This is a technical quality gate, not proof of article relevance or an English caption. Only 5 of the 58 accepted originals had an existing English primary-subject description that can be reused as alt text without a model call. Other originals need defensible descriptions or editorial review; the pipeline does not invent an English subject from an unrelated caption.

Plan-only repair covered 13 Drafts without adding a model-call ledger entry (6,292 before and after). It found published-inventory staleness, missing independent article QA, invalid optional visuals to remove, and three articles with visual slots that may need paid image generation/translation. The plan preserves every body and unaffected successful image. It made **no production article or WordPress change**. Applying a plan requires a current WordPress inventory read, independent QA and current source/visual gates. The two publicly published WordPress posts are among the historical reconciliation targets; CMS status sync uses exact post ID and preserves a local `needs_review` blocker.

## Verification and remaining release gates

Targeted source deletion, tombstone, WordPress publish/reconcile, media gate, photo audit, visual planning, Content state and release-migration tests passed locally. The WordPress parent theme 0.33.8 was packaged, statically parsed, exercised in a local WordPress 6.8.3 Playground, and installed through the signed-in production theme update UI; the prior 0.33.7 ZIP and its hash are retained for rollback. WordPress 7.1.1 Playground was **NOT TESTED** because its virtual filesystem ran out of space during setup. Local browser testing covered menu navigation, 20/50 pagination and source deletion on disposable data; final preview against the real CMS/WP pair is **NOT TESTED**.

| Level | Status | Scope |
|---|---|---|
| L1 targeted tests | PASS | Directly affected server, pipeline, state, media, extension and WordPress adapter cases |
| L2 module regression | PASS | Latest full local Node suite and build/check at the time of this report |
| L3 production DB replay | PASS | Fresh snapshot schema 73→78 identities, integrity, repeat migration, state parity and photo plan; no live writes |
| L4 browser E2E | PARTIAL | Disposable CMS menus, pagination and delete; live preview and active Worker timings pending |
| L5 real Provider canary | NOT TESTED | Native schema/prompt and bounded image call remain to be exercised |
| L6 full production-like replay | NOT TESTED | Full article bundle→review→media→WP path not yet replayed in one run |
| Post-fix exploratory audit | ISSUES FOUND | Historical QA/inventory blockers and 171 photos requiring editorial review |

The 72-item v2.0 acceptance ledger in `INTEGRATED_PIPELINE_PERFORMANCE_2026-09-21.md` remains the detailed case list. A locally passing item is not automatically marked production verified. Complete the production Worker/browser measurement, bounded real Provider check, guarded historical refresh and final ledger update before declaring all 72 complete.

## Production release and bounded historical repair, 2026-09-22

CMS 2.0.49 (`0615f0b`) was deployed with the schema 73-to-78 migration after database backup, restore drill and GCE disk snapshot. Versions 2.0.50, 2.0.51, 2.0.54 and 2.0.55 were subsequent immutable-image code switches; 2.0.52 and 2.0.53 were built but superseded before deployment. WordPress parent theme 0.33.8 is installed. At the time of this addendum 2.0.55 (`0430c4a7f07d5328859d6e40b33b56c93a62439c`) runs as separate API and Worker containers, both pinned to image SHA-256 `898c1194e23442b370f09e5a18844a9b22e04f7b01dddd0ea155697f0cdc119f`, sharing the same SQLite volume and durable media lane. The instance startup script pins that exact image and revision. Readiness returned HTTP 200, version 2.0.55.

The 229 source photographs linked to historical articles received SHA-bound local quality receipts without new Provider calls: 58 eligible and 171 `needs_review`. An initial guarded refresh advanced five articles by one media-only revision, preserving body hashes and current independent article QA. Its first nine observed model-call records included source analysis, localization and visual QA; their pricing fields were unknown, so no zero-cost claim is made for those calls. Failed QA, a persisted unknown media outcome and provider timeout kept affected articles in `needs_review`; neither a successful image nor the article body was reset. The actual WordPress inventory remained 12 posts: two `publish` (post IDs 69 and 87) and ten `draft`. CMS shows the remote `publish` state of post 69 alongside its local `needs_review` blocker.

Version 2.0.55 also repairs old successful transformations with missing local paths or old QA file-hash fields. Before touching live rows, a consistent 2,310,410,240-byte production SQLite backup at `/var/lib/solo-to-china/backups/visual-receipts-pre-2.0.55-20260922.sqlite` passed full integrity check. A separate work copy had identical SHA-256 `d62c291bea95c421200b1cb6b471ec4be6a4914358dadacd4ea1a0dcc19373f6`. GCE snapshot `stc-pre-2-0-55-visual-20260922` reached READY. Dry-run and apply on the work copy found the same 12 verified receipts. Work-copy integrity and foreign keys passed; eight authoritative tables, including Drafts, article QA, jobs, WordPress records and source assets, were unchanged. Only 12 visual rows changed, limited to the persisted QA hash/status, local path and update time. The production dry-run returned the same 12 IDs, and the guarded production apply updated those 12. Eleven had a valid existing path and gained the missing hash binding; one recovered its lost path from byte-identical disk media. This repair made no model or WordPress call. The pre-change backup and previous containers remain rollback inputs; restoring the database alone after newer live writes requires preserving and reconciling those writes first.

The 13-article live dry-run after this repair still found independent article QA gaps, stale WordPress inventory, one failed infographic QA with a later timeout, one `MEDIA_OUTCOME_UNKNOWN`, and required media gaps. WordPress inventory was refreshed read-only and again returned two published posts. A further media-only refresh of the Eling article preserved its body and two original photographs, but the visual Job reported success with a required slot still `planned`; no model call was recorded for that Job and the dependent page correctly failed `MEDIA_INCOMPLETE`. The source and asset capture versions are equal, so a current-capture checkpoint rejection does **not** explain this particular run. Version 2.0.57 adds an end-of-visual-stage gate so such a Job cannot succeed or enqueue page composition. No unfinished article is reported as delivered. A published itinerary retains a three-slot immutable media obligation while only two current visual rows exist; the no-op classification for that situation is corrected in 2.0.56. A Ciqikou draft has no current visual and no manifest and remains blocked.

Live same-VM loopback measurements used 31 sequential requests per route, 217 total, with the production Worker process up. The loopback client measured its own event-loop delay, **not** the server's event loop. All requests below returned HTTP 200. These runs had different live workloads and response contents, so the version-to-version numbers are observations rather than a controlled causal comparison. The 2.0.55 run followed release and data repair, without an active image transform. Full before/after SQL counts exist for the earlier disposable same-snapshot benchmark above; no per-request production SQL trace was collected for these live samples.

| Route | 2.0.54 warm P50/P95 ms | 2.0.55 warm P50/P95 ms | 2.0.55 cold ms | 2.0.55 bytes |
|---|---:|---:|---:|---:|
| Sources | 77.74 / 82.81 | 85.32 / 100.51 | 296.44 | 48,413 |
| Content | 214.58 / 257.62 | 214.28 / 361.60 | 298.51 | 25,589 |
| Recommendations | not retained | 38.74 / 40.56 | 287.73 | 13,601 |
| Knowledge | not retained | 60.28 / 62.64 | 106.68 | 8,151 |
| Commercial | not retained | 2.69 / 4.15 | 11.50 | 7,835 |
| Settings | 283.37 / 302.44 | 282.97 / 287.49 | 339.65 | 25,457 |
| Dashboard | 3.88 / 7.54 | 3.36 / 6.24 | 571.21 | 790 |

The 2.0.55 loopback client's event-loop delay P95 was 10.50 ms. Source and Content P95 worsened relative to the earlier 2.0.54 live sample; no improvement is claimed. Production browser menu and page paint under a concurrently running image Job are **NOT TESTED**. The real structured article-bundle Provider canary reached Vertex but encountered HTTP 429 before schema acceptance and generation; native schema compatibility is **NOT TESTED**. Real image localization and independent visual QA did run, including failures that correctly prevented delivery. L1 targeted tests, the 790-test local suite, `npm run check`, and offline `release:check` (50 mandatory passes, zero failures) passed for 2.0.55. A local browser E2E covered page navigation, 20/50 pagination, source deletion and preview gate behavior; production authenticated browser E2E remains **NOT TESTED** after the CMS session expired.

Historical disk cleanup removed only verified disposable replay paths and a stopped clone container. Root filesystem free space rose from about 44 GB to 54 GB; the active volume, current backup, snapshot, running containers and immediate rollback containers were retained.
