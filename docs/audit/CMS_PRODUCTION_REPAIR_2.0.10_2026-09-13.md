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

## Safety boundaries

The reconciliation does not delete Sources, original media, Claims, analyses, recommendations or historical opportunities. It does not approve an opportunity, create a WordPress draft or publish a post.

## Local validation

- `npm test`: 517 passed, 0 failed.
- `npm run check`: passed; Vite built 1,882 modules, JavaScript 431.55 kB (134.90 kB gzip), CSS 57.45 kB (10.51 kB gzip), and all 12 dependency-boundary files passed.
- `npm run release:check`: 51 mandatory checks passed, 0 failed, with four unconfigured-service warnings and five explicitly untested external conclusions.
- Queue/media benchmark: all five fixtures passed; one text segment plus 19 images is normal work in four bounded media batches of 5, 5, 5 and 4, reducing 20 legacy calls to five planned calls (75%).
- Knowledge benchmark: 120 Claims produced 120 facts and 60 opportunities; full coverage rebuild took 179.15 ms and a one-fact incremental rebuild took 27.27 ms (6.57x). Compact Intake reduced 571,331 bytes to 59,423 bytes (89.6%). Isolated worker p50/p95 was 0.75/1.49 ms and backup p50/p95 was 0.67/0.94 ms with hash verification.

## Production deployment and backup

Cloud Build `5ffc334e-733b-4700-8f56-e09e097b9e9e` produced:

`asia-east1-docker.pkg.dev/project-4bcb9146-c37b-43b0-b11/solo-to-china/engine@sha256:9451b6855f92c74bac5a1f6202e14e3830ca52bfe0b612dac1957d3e72830b12`

Production runs code revision `bd5edd32ecfeee900c8ba1d185d653fa96d922e4`, App 2.0.10, Strategy 3.3 and schema 67. The upgrade snapshot is `solo-to-china-2026-09-12T19-03-31-467Z.snapshot`: its database is 1,979,482,112 bytes with SHA-256 `9031e5f92ae85bf27c967f372e04acf7bb869435d49c14cc823587900d300be6`, `integrity_check=ok`, and 1,009 hashed files. The isolated restore drill opened all 1,318 Source-asset references, made zero external calls and found no draft media because production has no drafts. Rehearsal and live opening both retained schema 67, zero foreign-key errors and identical fingerprints for 74 Sources, 149 capture versions, 1,318 Source assets, 2,275 segments, 6,365 Claims, 6,614 evidence spans and 1,546 coverage rows.

The new container passed readiness before network attachment, remains on the exact digest with zero restarts, and has no lock, fatal, uncaught or unhandled log matches since startup. Both public hostnames returned App 2.0.10 and a ready database. Across 12 requests per endpoint, health p50/p95 was 386/1,150 ms on the Engine hostname and 380/1,037 ms on Capture; readiness p50/p95 was 340/343 ms and 336/350 ms respectively.

The live volume retains one verified snapshot. Docker retains only the active 2.0.10 image, the stopped 2.0.9 rollback container/image and Cloudflared; rehearsal databases were deleted. Artifact Registry retains only 2.0.10 and the immediate 2.0.9 rollback digest. Root usage after deployment is 9,186,045,952 bytes (12%) with 71,554,555,904 bytes available; `/var/lib/docker` is 6,707,665,282 bytes and upgrade records are 1,766,037 bytes.

## Production reconciliation result

- Dry run: `backfill_3e3983164dba4d2ea1253e966996a2a9`, fingerprint `889900008860f6037f651e481f8f60672f6fc4714da0517a34734890a1992dbb`.
- Applied run: `backfill_c7256a3558eb47f4835eb836139461e0`, using the same fingerprint.
- Inputs: 16 completed Sources already on 3.3, 25 compatible completed Sources promoted from 3.0-3.2, zero incompatible Sources and 33 incomplete Sources left for the pipeline.
- Provider effect: 25 model calls avoided, 25 diagnostics reused, zero diagnostic jobs queued. The previously interrupted run is now closed as completed; its 26 uncalled jobs remain auditable as `SUPERSEDED_RECONCILIATION_REUSE`.
- Result: all 41 qualifying completed Sources now have Strategy 3.3 diagnostics. Current 3.3 inventory contains 326 opportunities: 128 source-derived and 198 Knowledge-derived. The API returns 248 actionable opportunities, comprising 152 ready and 96 evidence-gap opportunities; eight duplicate intents are merged and 66 processing-gap rows remain internal.
- Incomplete work: 32 Sources are still in the core media/coverage/finalization queue. One Source that completed core extraction while validation ran is queued for Experience extraction. All 33 retain their originals and will enter current diagnostic/opportunity reconciliation after completion.
- UI acceptance: `/api/recommendations?limit=500` returned 248 items and no next cursor; all 74 Sources loaded, all 32 processing Sources exposed a core queue state, and zero processed Sources exposed a core queue state.

No opportunity was approved. Production still has zero article drafts and zero `push_wordpress_draft` jobs; no WordPress content was created or published.

## Upgrade and rollback

For another installation, check out revision `bd5edd32ecfeee900c8ba1d185d653fa96d922e4`, use the immutable digest above with `deployment/gce/upgrade-existing.sh`, and require the backup, restore drill, schema/integrity/foreign-key and preserved-fingerprint gates before attaching traffic. After readiness, run `node scripts/run-backfill.mjs recommendations` first; execute only with its unchanged run ID using `--execute --approved-from <dry-run-id>`. The immediate production rollback pair is stopped container `engine-before-bd5edd3`, image digest `sha256:9251804f66aedeb7a3db465a88b6268cfd3c5da3e307fb0538afa0a2bc636bec`, and the verified pre-2.0.10 snapshot above. A rollback must restore the image and snapshot together under maintenance so post-deployment captures are not discarded.
