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

The reconciliation does not delete Sources, original media, Claims, analyses, recommendations or historical opportunities. It does not approve an opportunity, create a WordPress draft or publish a post. Production validation, exact counts, image digest, revision and rollback locations are appended after the verified deployment.

## Local validation

- `npm test`: 517 passed, 0 failed.
- `npm run check`: passed; Vite built 1,882 modules, JavaScript 431.55 kB (134.90 kB gzip), CSS 57.45 kB (10.51 kB gzip), and all 12 dependency-boundary files passed.
- `npm run release:check`: 51 mandatory checks passed, 0 failed, with four unconfigured-service warnings and five explicitly untested external conclusions.
- Queue/media benchmark: all five fixtures passed; one text segment plus 19 images is normal work in four bounded media batches of 5, 5, 5 and 4, reducing 20 legacy calls to five planned calls (75%).
- Knowledge benchmark: 120 Claims produced 120 facts and 60 opportunities; full coverage rebuild took 179.15 ms and a one-fact incremental rebuild took 27.27 ms (6.57x). Compact Intake reduced 571,331 bytes to 59,423 bytes (89.6%). Isolated worker p50/p95 was 0.75/1.49 ms and backup p50/p95 was 0.67/0.94 ms with hash verification.
