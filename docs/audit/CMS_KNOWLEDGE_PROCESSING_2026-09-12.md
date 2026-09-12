# CMS 2.0.8 Knowledge resolution and Source processing report

Date: 2026-09-12. Branch: `codex/audit-v1.3`. Baseline repository HEAD: `5604c2d0b6966b28dd97c7448dad72a8cc7d7ac5`. Baseline production revision: `2f71d45ddf80b588a58789aa94c251413fa498b7`, immutable image digest `sha256:626293d8d4171af36d021ccf2ad71671b56e3c54a35fbefaee5e246d913d65ed`, App 2.0.7 / Strategy 3.2 / schema 66.

## Root causes

Knowledge comparisons previously allowed surface strings and a narrow predicate list to stand in for fact semantics. Equivalent all-day hours and free prices could remain separate, `opening_hours=open access` was compared as a schedule instead of identified as a predicate/value mismatch, scope omitted product/service and route dimensions, and current/scheduled/historical evidence was not resolved before conflict classification. Ordinary operational facts therefore flowed too readily into one manual conflict queue.

Source capture already removed the estimated-call pause, but old Sources retained legacy manual-start metadata and could have no active job. Recovery did not describe every stage or guarantee that child jobs kept the historical priority and route. Semantic work also waited behind Source diagnostics, while large Coverage and backup work could share the API process.

## Baseline production dry runs before code changes

The processing-gap run `processing_gap_run_c3b23676157f44cd8685eab85c8c2c25` had fingerprint `7fe863592b79b15b03e9746dc407fff3b1d52bc847c4ac0d83830cbf6940e642`. It found 35 Sources and 35 proposed actions: 34 `preflight_source` actions and one `finalize_source_extraction`; 34 records carried the legacy manual-start marker. It queued no job.

The Knowledge inventory contained 230 pending review records: 213 `SOURCE_CONFLICT`, 11 `NEGATION_EXTRACTION_ERROR`, four `TEMPORAL_CONFLICT` and two `QUALIFIER_EXTRACTION_ERROR`. The baseline heuristic found four predicate/value mismatches and 13 extraction-repair candidates. It classified 213 ordinary dynamic cases as machine verification candidates and found no demonstrably safety-critical human conflict in this inventory. This was an analysis-only projection because schema 66 did not yet have the 2.0.8 resolution engine.

## Implementation

- `src/claim-resolution.mjs`, `src/knowledge-resolution.mjs` and `src/evidence-consensus.mjs` implement stable typed values, expanded scope, temporal states, mismatch repair, source independence, weighted consensus and the explicit automatic/verification/repair/human state machine.
- `src/repository.mjs` persists decision history and repair/verification jobs, exposes exact dry-run backfills, produces complete Source processing manifests, inherits historical workload context, computes compact Intake packages and records dirty Coverage scopes.
- `src/job-policy.mjs` and `src/pipeline.mjs` add workload lanes, core/background separation, lane-aware backoff, executable guarded fragment routing and child context propagation.
- Database-heavy derived-index jobs are exclusive across pipeline workers. Recovery, claim and heartbeat ticks defer transient SQLite locks instead of allowing a timer callback to terminate the HTTP process.
- `src/process-runner.mjs`, `scripts/run-isolated-repository-task.mjs` and `src/maintenance.mjs` isolate repository-heavy work and scheduled backup from the HTTP event loop with bounded output, timeout and failure propagation.
- `src/server.mjs` and `frontend/src/views.jsx` add Knowledge status/history/verification APIs and separate automatic, verification, repair and human counts.
- Schema 67, Strategy 3.3, extension/app 2.0.8, deployment probes and regression/benchmark scripts complete the compatible rollout path.

## Local performance evidence

The synthetic benchmark uses 120 Claims, 120 resulting facts and 60 opportunities. A full Coverage rebuild updated all 60 opportunities in 169.31 ms; a one-fact dirty rebuild updated one opportunity in 15.63 ms, an 10.83x elapsed-time improvement on this run. Compact Intake was 59,423 bytes versus a 571,331-byte legacy Knowledge projection, an 89.6% reduction.

While an isolated CPU worker ran, 30 local health requests measured p50 0.89 ms, p95 1.84 ms and max 21.20 ms. While a child process copied and verified a 4,468,736-byte backup fixture, 30 requests measured p50 0.71 ms, p95 0.98 ms and max 3.08 ms; backup integrity was `ok`.

These measurements validate local event-loop isolation and relative Coverage/input changes. They do not measure Vertex latency, real provider token counts, 429 rate, production Source core p50/p95 or historical-recovery throughput. Production recovery stays dry-run, so the rollout deliberately does not manufacture those metrics by processing 35 historical Sources.

## Validation and production status

Final local validation passed: `npm run check` completed the Vite production build, syntax checks and service-boundary checks; `npm test` passed 511 of 511 tests in 26.37 seconds; and `npm run release:check` passed all 51 mandatory checks with zero failures. The release gate recorded four expected warnings and five environment-only checks as not tested. Its isolated migration rehearsal upgraded schema 59 through 67, preserved referenced IDs, verified foreign keys and integrity, and exercised the rollback guard. Deployment revision/digest, post-deploy dry-run IDs, health results and capacity checks are added after rollout in this report and `docs/HANDOFF.md`.

The rollout does not execute recovery, delete source media/Base64, create a WordPress draft or publish WordPress content.
