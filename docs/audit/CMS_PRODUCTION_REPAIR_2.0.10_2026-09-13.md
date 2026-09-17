# CMS 2.0.10 Source completion and opportunity repair — 2026-09-13

## Problem and production diagnosis

The production Source list showed completed Sources as queued because the lightweight status projection included downstream `analyze_source_diagnostic` jobs. Recommendation reconciliation treated every diagnostic whose strategy label was older than 3.3 as stale, even though the intake prompt and response contract had been stable across Strategies 3.0-3.3. It queued 40 provider calls. Fourteen completed before intervention and the remaining 26 queued calls were stopped without execution.

The production database retained all historical opportunities. Before this correction it contained 714 Strategy 3.0, 21 Strategy 3.1 and 26 Strategy 3.2 opportunities marked `SUPERSEDED/PROCESSING_GAP`, while only seven Strategy 3.3 opportunities were actionable. An additional conflict-update omission left an existing opportunity on its old strategy even after a fresh diagnostic rebuilt the same topic key.

Thirty-three Sources were still processing current image-bearing capture versions. Their previous image segments had `asset_id=NULL` and `input_modality=unknown`, so the historical `vertex_multimodal` rows did not prove that the provider received the images. Those media jobs are real extraction gaps and remain queued. They are kept separate from completed-Source opportunity calculation.

## Implementation

- Compatible Strategy 3.0-3.2 intake diagnostics are normalized and promoted under 3.3 without a model request. The dry-run fingerprint separately records current, reusable and incompatible Sources; only incompatible rows may queue a diagnostic.
- Rebuilding an existing source or Knowledge opportunity updates its strategy version, coverage and readiness while retaining approved lifecycle state and immutable historical records.
- Multi-source Knowledge opportunities and coverage use evidence only from complete, processed Sources with durable originals and a current successful Experience extraction. Processing Sources join after completion.
- Source list queue projections include only capture, preflight, segmentation, Claim/media extraction, coverage retry/audit and finalization. Downstream work remains in Experience status and the immutable Source timeline.
- Experience completion immediately reconciles existing current diagnostics for that destination. A Source that crosses the final processing gate therefore enters the opportunity inbox without waiting for a full-dashboard read and without repeating diagnostic inference.
- Dashboard processing totals exclude superseded historical opportunities while retaining those rows for audit and rollback.

## Safety boundaries

The reconciliation does not delete Sources, original media, Claims, analyses, recommendations or historical opportunities. It does not approve an opportunity, create a WordPress draft or publish a post.

## Local validation

- `npm test`: 519 passed, 0 failed.
- `npm run check`: passed; Vite built 1,882 modules, JavaScript 431.55 kB (134.90 kB gzip), CSS 57.45 kB (10.51 kB gzip), and all 12 dependency-boundary files passed.
- `npm run release:check`: 51 mandatory checks passed, 0 failed, with four unconfigured-service warnings and five explicitly untested external conclusions.
- Queue/media benchmark: all five fixtures passed; one text segment plus 19 images is normal work in four bounded media batches of 5, 5, 5 and 4, reducing 20 legacy calls to five planned calls (75%).
- Knowledge benchmark: 120 Claims produced 120 facts and 60 opportunities; full coverage rebuild took 179.15 ms and a one-fact incremental rebuild took 27.27 ms (6.57x). Compact Intake reduced 571,331 bytes to 59,423 bytes (89.6%). Isolated worker p50/p95 was 0.75/1.49 ms and backup p50/p95 was 0.67/0.94 ms with hash verification.

## Production deployment and backup

The final Cloud Build `2ef6d4ba-c638-4e5c-a0a7-bdcfd42d6046` produced:

`asia-east1-docker.pkg.dev/project-4bcb9146-c37b-43b0-b11/solo-to-china/engine@sha256:1efd84459eb811928144d38a3499469f97aa451c851d8b5ad2d6decf32adaf49`.

Production runs code revision `908dad5005f4ac730e21ff3516fcbfea93f74803`, App 2.0.10, Strategy 3.3 and schema 67. The final upgrade snapshot is `solo-to-china-2026-09-12T20-23-39-569Z.snapshot`: its database is 1,975,627,776 bytes with SHA-256 `76728d857ec72efa5eb45563a5783c9647ebae2de48cda6bd356621ec0262fd9`, `integrity_check=ok`, and 1,009 hashed files. The isolated restore drill opened all 1,318 Source-asset references, made zero external calls and found no draft media because production has no drafts. Rehearsal and live opening both retained schema 67, zero foreign-key errors and identical fingerprints for 74 Sources, 149 capture versions, 1,318 Source assets, 2,275 segments, 6,019 Claims, 6,986 evidence spans and 1,969 coverage rows.

The new container passed readiness before network attachment, remains on the exact digest with zero restarts, and has no fatal, uncaught, unhandled or panic log matches since startup. Both public hostnames returned App 2.0.10 and a ready database. Across 12 requests per endpoint, health p50/p95 was 392/1,143 ms on the Engine hostname and 408/1,078 ms on Capture; readiness p50/p95 was 348/780 ms and 358/830 ms respectively.

The live volume retains one verified snapshot whose complete tree is 2,491,826,655 bytes. Docker retains only the active 2.0.10 image, the stopped immediate 2.0.10 rollback container/image and Cloudflared; rehearsal databases were deleted. Artifact Registry retains only the final digest and the immediate rollback digest. Eight unreferenced historical upgrade directories were removed; the active and rollback mount records total 484,246 bytes. Root usage after deployment is 9,189,076,992 bytes (12%) with 71,551,524,864 bytes available, and `/var/lib/docker` is 6,684,900,097 bytes.

## Production reconciliation result

- Dry run: `backfill_3e3983164dba4d2ea1253e966996a2a9`, fingerprint `889900008860f6037f651e481f8f60672f6fc4714da0517a34734890a1992dbb`.
- Applied run: `backfill_c7256a3558eb47f4835eb836139461e0`, using the same fingerprint.
- Inputs: 16 completed Sources already on 3.3, 25 compatible completed Sources promoted from 3.0-3.2, zero incompatible Sources and 33 incomplete Sources left for the pipeline.
- Provider effect: 25 model calls avoided, 25 diagnostics reused, zero diagnostic jobs queued. The previously interrupted run is now closed as completed; its 26 uncalled jobs remain auditable as `SUPERSEDED_RECONCILIATION_REUSE`.
- Result: all 41 qualifying completed Sources have Strategy 3.3 diagnostics. The current policy classified 33 as `ARTICLE_CANDIDATE/CREATE_CONTENT_PLAN`, and all 33 have at least one current source opportunity. The other eight are intentionally routed to Knowledge (two), clustering (one) or research first (five). Current 3.3 inventory contains 326 opportunities: 128 source-derived and 198 Knowledge-derived. The final API returned 250 actionable opportunities, including 77 current-ready and 173 evidence-gap rows; seven duplicate intents were merged. Sixty-eight current processing-gap rows remain internal, while 710 superseded historical rows remain auditable but are excluded from that UI total.
- Incomplete work: 25 Sources remain in the core media/coverage/finalization queue and eight core-complete Sources are queued for Experience. All 33 retain their originals, have an active task, and will enter current diagnostic/opportunity reconciliation after completion.
- UI acceptance: `/api/recommendations?limit=500` returned 250 items and no next cursor; all 74 Sources loaded, all 25 processing Sources exposed a core queue state, zero processed Sources exposed a core queue state, and the other eight unfinished processed Sources had queued Experience jobs.

No opportunity was approved. Production still has zero article drafts and zero `push_wordpress_draft` jobs; no WordPress content was created or published.

## Upgrade and rollback

For another installation, check out revision `908dad5005f4ac730e21ff3516fcbfea93f74803`, use the immutable digest above with `deployment/gce/upgrade-existing.sh`, and require the backup, restore drill, schema/integrity/foreign-key and preserved-fingerprint gates before attaching traffic. If the installation has not yet run the 2.0.10 recommendation repair, run `node scripts/run-backfill.mjs recommendations` first and execute only with its unchanged run ID using `--execute --approved-from <dry-run-id>`. The immediate production rollback pair is stopped container `engine-before-908dad5`, image digest `sha256:a6cc2f090bbe1ba6fb95d5e837da444878a1399e287763ce748245ee27c3c922`, and the verified final pre-upgrade snapshot above. A rollback must restore the image and snapshot together under maintenance so post-deployment captures are not discarded.
