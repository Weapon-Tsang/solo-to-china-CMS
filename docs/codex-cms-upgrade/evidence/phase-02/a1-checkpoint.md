# Phase 02 v1.4 — A1 checkpoint, 2026-09-27

Latest status is now in [the context-readback continuation](a1-readback-checkpoint.md). The 02-PRE prerequisite was subsequently accepted locally, and this continuation implemented bounded evidence readback and binding freshness checks. The historical precheck below is preserved, not the current blocker. Overall A1/phase 02 remains incomplete.

Latest continuation audit: **BLOCKED_02_PRE_EVIDENCE / NOT_ACCEPTED / STOPPED**. See [the prerequisite audit](a1-resume-precheck-20260927.md). All previously fingerprinted files matched at entry. The original 02-PRE specification and current specialist acceptance were not located; loaded user-extension version is NOT TESTED. Per the supplied continuation instruction, stop before further A1 implementation and use the original 02-PRE full TXT next. The implementation, remaining scope and historical evidence below are preserved unchanged; this is not A1-to-A2 approval.

Status: **BLOCKED_CONTEXT / NOT_ACCEPTED / STOPPED**. This is a partial implementation checkpoint, not completion of phase 02 or all of A1. The full 68 requirements and 90 acceptance cases remain in [the matrix](../../acceptance/phase-02.md); no remaining requirements have been removed.

The supplied specification explicitly permits stopping at a checkpoint when context is insufficient. Resume in a new conversation in the same CMS workspace with the complete [phase-02.txt](../../phases/phase-02.txt). Continue A1 gaps first, then A2 → B → C → D → complete acceptance. Do not advance to phase 03.

## Scope and provenance

- CMS root: `C:\Users\Mloong\Documents\ChatGPT\solo-to-china-CMS`.
- Remote: `https://github.com/Weapon-Tsang/solo-to-china-CMS.git`; branch `main`; HEAD `e9f7c8e82ff760f4d18f2d2e0673452eb8744290`.
- Spec SHA-256: `d4c223aac6b29b0c6b65fda7d70d8925ef37bfa6faf038f75d2dffe5c37b39c1`.
- The working tree already contained phase 01 changes. [baseline.json](baseline.json) records the initial hashes; [checkpoint-files.json](checkpoint-files.json) records current hashes and distinguishes changed pre-existing tracked files. The whole Git diff must not be attributed to this checkpoint. Previously untracked phase 01 files were not comprehensively fingerprinted at entry.
- Phase 01 prerequisite: latest v1.2 local result permits isolated phase 02 development; historical unknowns remain quarantined. This work does not change that production boundary.
- DEVELOPMENT only. No commit, push, deployment, production migration/backfill, WordPress write, paid Provider request, or frontend-repository modification. Deployment script changes only align schema assertions; the scripts were not executed.

## Implemented A1 slice

1. `src/media-context.mjs`: stable source/capture/asset occurrences; captions, nearby text, explicit image-number references, source-text block offsets and context hashes; bounded text with explicit omitted ranges/context-pending status. A title, mention order, or “第2天” does not become an image-number binding. Retained original text enables subsequent bounded readback, but the readback workflow is not implemented yet.
2. `src/ai/kimi.mjs`: realtime extraction, Batch input, and single-image reanalysis use the same source-context contract. Context is adjacent to the corresponding submitted image. Foreign/duplicate image IDs are rejected; omissions remain explicit. Batch input manifests preserve context. Equal Claims from separate images retain their evidence identities. Empty failed image batches do not purchase an empty request. These paths were tested with mocked transport, not real Provider generation.
3. `src/repositories/media-bindings.mjs` and schema 81: additive occurrence/binding tables; deterministic, scoped dry-run/apply repair using explicit captions/image references and existing entity aliases. Pixel observations remain separate. Multiple possible places and uncertain wording stay ambiguous; coarse entities stay candidates. Only supported specific physical-place relations can support general documentary-photo use. Entrance, pier, boarding and similar precise uses are not certified by general location context.
4. `src/repository.mjs`: extraction packages retain context; retained historical images use their own capture text; source preparation and deterministic entity resolution refresh relevant indexed bindings. Entity relations can retrieve cross-source assets without fabricating Claims. Automatic retrieval has pagination/remaining-range metadata; explicit asset IDs are fetched separately without the old candidate cap. Planning receives relation evidence and truncation metadata.
5. Matching uses verified source relations for general documentary photos while retaining existing quality gates. `src/publication-eligibility.mjs` rejects revoked/stale binding references even when old cached match scores are high. Context/alias changes create new revisions without resetting successful pixel analysis or rewriting article text.
6. `src/backup.mjs`: business fingerprints cover the new tables; snapshot/review-restore tests preserve relation evidence. Schema migration itself does not backfill or enqueue work.

## Reproducible audit path and fixes

Before the change, media batch extraction discarded source prose; single-image analysis had only limited nearby metadata; entity candidates were tied to article Claim sources and fixed candidate budgets; generic pixel subjects could exclude a source-supported place photograph. New tests exercise actual adapter request construction and repository retrieval/matching, not only standalone helpers.

The local historical replay initially exposed a uniqueness defect: identical entity keys in different destinations reduced 627 proposed binding rows to 381 persisted rows. Schema 81 uniqueness now includes destination; the replay preserves all 627 rows. An alias-catalog conflict regression now versions the interpretation and stales the old relation. The first full regression also found outdated deployment schema assertions and a failed-image-batch transport expectation; both were corrected, then the full suite passed. The original failure log is retained as `full-regression-first.log`.

## Verification and its limits

Change classes: DATABASE_LOGIC, PIPELINE, AI_PROVIDER, DATA_MIGRATION.

| Layer | Result | Actual coverage |
|---|---|---|
| L1 Targeted Tests | PASS | Latest context/binding/entity-resolution/pipeline run: 37/37; `a1-final-targeted-tests.log` |
| L2 Module Regression | PASS | Earlier related module run: 146/146 (`a1-module-tests.log`); final full `npm test`: 907/907 (`full-regression.log`); `npm run check`: PASS (`check.log`) |
| L3 Production DB Replay | PASS, scoped | Existing historical local snapshot, isolated baseline and disposable work DB; deterministic A1 binding logic only |
| L4 Browser E2E | NOT TESTED | No phase 02 UI workflow or browser acceptance implemented in this checkpoint |
| L5 Real Provider Canary | NOT TESTED | Explicit phase boundary excludes new paid requests; mocks do not establish Provider/semantic acceptance |
| L6 Full Production Replay | NOT TESTED | No end-to-end route/content/media/manual-upload/WordPress replay |
| Post-Fix Exploratory Audit | PASS, scoped | Binding row preservation, ambiguity, stale state, FK validity, idempotence and protected-table fingerprints; not all system invariants |

`npm run check` includes the local frontend build and service-boundary checks; this is not a deployment or browser test. Test success does not establish completion of the 90 specification cases.

Replay command:

```powershell
node scripts/stage02-media-binding-replay.mjs C:\Users\Mloong\AppData\Local\SoloToChinaStage01\baseline-20260923\database.sqlite D:\
```

C: lacked space for two safe copies of the 2,333,536,256-byte database. The approved local replay used new isolated D: directories. The final retained directory is `D:\cms-phase02-media-replay-pPPWln`; prior exploratory directories `D:\cms-phase02-media-replay-6reDXW` and `D:\cms-phase02-media-replay-22R0um` remain. They contain local database copies and must not be committed. No production connection was made.

[a1-production-db-replay.json](a1-production-db-replay.json) records schema 78→81, 84 sources, 1,364 inspected images, 627 persisted binding rows, 596 ambiguous binding rows, 28 source-supported image decisions and 3 candidate image decisions. These are different counting units. Source evidence is not independent pixel identification. Protected rows, original snapshot and isolated baseline were unchanged; second apply was idempotent; foreign keys were valid; model-call count stayed unchanged. No image-byte semantic inspection was performed.

## Remaining work — do not silently waive

- A1: complete reason taxonomy/drilldown and operator repair flow; bounded missing-context readback; broader typed relationship evidence and manual confirmations; PDF extraction/unsupported-state behavior; full availability-before-freeze behavior; full conflict/invalidation lifecycle and end-to-end publication checks. Review deterministic caption/alias semantics against the complete BIND requirements, including negative evidence. Current matching is deliberately narrower than the complete requirement.
- A2: all route-mode recognition, route fragments/bundles, ordering/legs/uncertainty, frozen skeleton propagation, renderer, semantic consistency and independent review, historical route protections and route/manual-upload integration.
- B: required media-original/master/derivative structure, deterministic optimization, QA/retry/cache/SEO behavior and WordPress size consumption.
- C: cover selection/cropping/refresh, full frontend contract artifacts and receiver compatibility evidence. Existing code is not automatically accepted against the new requirements.
- D: manual-upload entry points, unlimited business-count selection, streaming chunks/resume, persistent sessions, explicit adoption locks/revisions/outbox, recovery, UI/security/performance and backup/restore coverage. The explicit-ID retrieval test is not a manual-upload implementation.
- Complete PIPE requirements, every remaining matrix case, browser E2E at specified sizes, fault injection, load measurements and complete local business replay. External real-environment checks remain separately gated.
- Schema 81 is new and local only. Future production release requires DATA_MIGRATION_RELEASE validation; changing compatibility assertions does not authorize a code-only schema upgrade.

## Resume and stop state

All commands started for this checkpoint have exited. No long-running server or agent was started; no user-owned service was stopped. Preserve all working-tree changes. Read this checkpoint, the matrix, the complete spec and the latest phase 01 prerequisites before continuing. Check the actual workspace state and available disk space; do not repeat the costly database copies unless implementation changes require a new replay.

`current_authorized_step=NONE`

`phase_end_stop=true`
