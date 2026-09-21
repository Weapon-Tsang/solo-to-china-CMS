# CMS 2.0.49: production-data replay and release evidence

This record distinguishes measured results from the requested targets. The 2026-09-22 baseline is a consistent, read-only copy of the live schema-73 SQLite database. All local migrations, photo scans and HTTP benchmarks ran on disposable copies. The user subsequently authorized a production release and historical article repair; the results of those operations must be added before claiming production completion.

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
