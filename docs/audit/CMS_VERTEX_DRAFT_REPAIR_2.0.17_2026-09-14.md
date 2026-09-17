# CMS 2.0.17 Vertex bounded Draft repair audit

## Scope and production baseline

The operator-authorized repair started with a fully read-only audit of production schema 69. SQLite integrity was `ok`, foreign-key violations were zero and the audit connection reported zero changes, zero enqueued Jobs and zero model calls. The Content Workbench contained seven approved records: four in progress and three failed at `revise_draft`. No retry, archive, deletion, approval change or WordPress action was performed during diagnosis.

The three failed Drafts were `The Feasible 3-Day Chongqing Route: Pacing, Taxis, and Vertical Navigation`, `Hongyadong: a practical guide for independent travelers`, and `What to Eat in Chongqing: The Essential Neighborhood Food Guide to Ciqikou, Jiefangbei, and Guanyinqiao`. Their retained Draft bodies were 5.3–8.3 KiB, their repair projections selected 1–17 facts, and their final Vertex attempts used 4,650–8,807 input tokens. They therefore did not exceed the model context window.

## Root cause

Each failed Job first submitted the canonical JSON Schema and then an OpenAPI response schema. The provider rejected both requests with HTTP 400 before returning usage. A production-environment compatibility probe against the configured `gemini-3.8-flash` global endpoint confirmed that a simple OpenAPI response schema succeeds, while the Draft repair schema is rejected when it contains `maxItems`; the same schema succeeds after array bounds are removed from the provider-only projection.

The fallback prompt-only request did execute the model. Its 6,000-token stage budget was shared by MEDIUM thinking and visible JSON. The failed samples consumed 3,950–5,757 thinking tokens and reached `MAX_TOKENS` after only 236–2,046 JSON tokens. The prior UI message incorrectly described this as excessive input even though the provider telemetry proves output-budget exhaustion.

## Implementation

- Vertex now defaults to the documented OpenAPI `responseSchema` transport. `minItems` and `maxItems` remain in the canonical JSON Schema but are omitted from the provider wire schema; local validation remains authoritative.
- `bounded_draft_repair` now uses LOW thinking and a 12,000-token output budget.
- The repair response requires only the base Draft hash and bounded replacement sections. Unchanged metadata, evidence ledger and verification notes no longer need to be echoed.
- Warnings and page-only failures are excluded from Draft rewrite input. The evidence projection is capped at 36 prioritized facts, two evidence samples per fact and bounded text fields.
- A retained ledger is validated against all frozen facts, not only the compact provider projection, so safe untouched references cannot be rejected merely because they were not re-sent to the model.
- Operator text now identifies a truncated model result and explains that the Draft and evidence remain retained.

No database migration is required. Startup does not enqueue or invoke a model for these failed records. Each remains available for an explicit idempotent `retry_failed_stage` action after deployment, and only `revise_draft` is rerun.

## Verification and deployment

Pre-deployment verification passed all 559 tests in the full suite, 48 focused Provider/repair/production-state regressions, `npm run check`, the production build, service boundaries and the consolidated offline release gate (50 mandatory checks, zero failures, five warnings and five explicitly external/not-tested checks). The bounded real-Provider compatibility probe was read-only with respect to CMS data and used only synthetic payloads; it did not enqueue or recover production content.

Production rollout identifiers, immutable digest, before/after state evidence, active-Job handling and storage cleanup are appended after deployment. This is a code-only release: schema stays at 69 and no historical data transformation is required.
