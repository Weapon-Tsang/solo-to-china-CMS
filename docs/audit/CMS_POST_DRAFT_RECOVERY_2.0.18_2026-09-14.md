# CMS 2.0.18 post-Draft recovery audit

Date: 2026-09-14

App version: 2.0.18

Schema: 69

Content Strategy: 3.3

Production state: 1.5

## Production before-state

A complete query-only transaction on the production database reported seven approved production records, seven `needs_attention`, zero queued/running Jobs and zero writes. Five records have a current `revise_draft` failure with `MODEL_OUTPUT_LIMIT` created before App 2.0.17 was deployed. One record has a failed QA review plus a later `SOURCE_IMAGE_FORMAT_UNSUPPORTED` visual failure against a retained WebP original. One has a failed QA review plus a later invalid Frontend Page Payload. The latter two were incorrectly projected as an interrupted path to Commercial Composition even though QA had not passed.

The audit did not retry a Job, call a model, create a WordPress request, archive/delete a record or change Sources, original media, Claims, Knowledge, Evidence, Experience, approvals, Failure Lessons or production artifacts.

## Implementation

- `production_state` 1.5 gives a current failing QA result priority over later failures from its parallel page/image branch. A failed `revise_draft` attempt remains the most specific primary failure.
- The conditional `revise_draft` stage appears in the registry, progress and next-stage fields as soon as a current failing review requires it, even if no repair Job has yet been created.
- Completing or terminally failing a post-Draft parallel branch rechecks a deferred failing review and enqueues one revision-scoped bounded repair through the existing durable queue and `auto-quality-repair` dedupe key.
- Explicit visual-stage recovery includes failed slots. Vertex Gemini localization accepts a retained WebP original and sends its unchanged bytes with MIME `image/webp`; generated derivatives remain separate.
- Content Recovery details follow the same authoritative `production_state` failure. A later non-blocking branch failure is retained for diagnosis and in the production timeline.

## Safety and compatibility

This is a code-only release. Schema 69 needs no migration. Startup reconciliation remains disabled for historical production retries, so deployment cannot enqueue or call models for the seven records. No Frontend component, JSX or CSS is copied into the CMS. The active Frontend Contract remains the only page-schema authority.

## Verification

- L1 targeted recovery/production-state/visual regressions: 43 passed, 0 failed.
- L2 full test suite: 565 passed, 0 failed. `npm run check` also passed.
- Consolidated offline release gate: 50 mandatory checks passed, 0 failed, with five warnings and five explicitly external/not-tested checks. The fixed Frontend commit `f44ce1092ced93dfb47d9b3eae83d0d5e4b97086` passed its Contract gate.
- L3/L6 production-data replay ran App 2.0.18 against the production volume mounted read-only with SQLite `query_only=1`. It projected all seven rows to `revise_draft`: five exact `MODEL_OUTPUT_LIMIT` failures and two authoritative failed reviews (`DATABASE_DUMP` and `invalid_evidence_key`). Before/after projections were identical and each audit transaction reported `total_changes=0`.
- L4 authenticated production UI acceptance showed App 2.0.18, seven current-production rows and the same recovery target/error semantics. No recovery action was clicked.
- L5 made one bounded real-provider request with a synthetic WebP containing no production material. `gemini-3.1-flash-image` accepted `image/webp` and returned a renderable `image/png`; no 400, 429 or output-limit error occurred.

## Production rollout

Commit `39562f57375f798921f4b3f356c3cff8f0a6d1a2` was pushed to `codex/audit-v1.3`. Cloud Build `7c570917-6ee1-4be1-80ed-d37322ac1223` produced immutable image digest `sha256:b121ebbed24eee2075971b921f659987449f722a4ec405191f33bde3bea14052`.

The code-only rollout performed no migration. Isolated readiness passed before the new container joined the production network. Public `/api/health` and `/api/ready` report App 2.0.18, ready database, schema 69, Strategy 3.3, Frontend Contract 1.4.0 and queue active/queued/running 0. Startup completed 26 unowned deterministic topic, coverage, Opportunity reconciliation and Frontend Contract sync Jobs; every one succeeded, none carried a production owner, and no model-backed production Job was created.

The stable post-rollout read-only audit reported model-call metrics unchanged at 5,828, zero active production Jobs, zero active WordPress Jobs, Sources 74, Claims 5,147, Evidence 8,292 and Knowledge 4,270. SQLite integrity is `ok` with zero foreign-key violations. No production record was retried, archived or deleted.

Disk cleanup removed two superseded rollback containers, their unused images and temporary audit files, reclaiming 487.7 MB. The active 2.0.18 container, stopped `engine-before-39562f5` 2.0.17 rollback container, Cloudflared image, persistent data volume and the active legacy `/app/data` bind remain. VM disk usage is 12% with 67 GiB available.
