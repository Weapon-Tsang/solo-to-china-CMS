# CMS Vertex production recovery 2.0.15 implementation record

Date: 2026-09-14 (Asia/Shanghai). Source branch: `codex/audit-v1.3`. Development source is 2.0.15, schema remains 69 and Content Strategy remains 3.3. Production remains on 2.0.14 revision `9341a30ea07ac16fa2803a8aed5f27c776106c17`; this change has not been committed, pushed or deployed.

## Read-only production diagnosis

The operator-triggered record was the only active production instance during the audit. Its current `assemble_editorial` Job had reached attempt 11 despite `max_attempts=3`. The retained provider error was HTTP 429 `Resource has been exhausted`. Its earlier attempt had failed before confirmed generation with HTTP 400 because the request exceeded Vertex's 1,048,576-token input limit. Model-call receipts also showed native JSON Schema rejection followed by OpenAPI/429 cycles. No usage tokens confirmed generation for these rejected requests. The other six records were not automatically retried or modified.

Four coupled defects explain the visible behavior:

1. Only `plan_content` input was bounded; the earlier model-backed `assemble_editorial` stage still serialized the complete Topic/Knowledge/Experience package.
2. Vertex Schema fallback existed only as a local variable inside one call. A durable Job retry reconstructed the client call and restarted from native JSON Schema.
3. Provider pressure used `providerPressure || attempts < max_attempts`, so every 429 bypassed the configured attempt ceiling.
4. The backend state projection treated every queued provider cooldown as generic automatic progress and exposed neither the retry budget nor an exhausted state.

The 2.0.14 tests verified Schema fallback in one uninterrupted function call, planning-package bounds after Editorial Assembly, and the intended queue-wide provider cooldown. They did not combine production-sized Editorial Assembly input, a worker/Job boundary between Schema transports and 429, or quota pressure at the attempt ceiling. One operations test explicitly encoded the old unlimited-429 behavior by expecting a `max_attempts=1` provider failure to return to `queued`. That assertion has been corrected and dedicated cross-boundary regressions were added.

## Implementation

- `getEditorialAssemblyPackage` now returns a deterministic bounded projection. It selects by approved reader-promise materiality and retains conflicts, dates, negatives, exceptions and strongest evidence while enforcing 48 facts, 96 snippets, 16 Experience blocks, 48 family links, bounded lessons/examples and 128 KiB/~32k estimated tokens. The underlying retained records are not altered.
- Schema transition receipts now identify `json_schema->openapi` and `openapi->prompt_only`. `structuredSchemaModeForJob` resolves the most advanced persisted mode, including legacy generic receipts, and Pipeline passes it into Vertex on every durable claim.
- A 429 can queue another attempt only while `attempts < max_attempts`. `claimJob` transactionally finalizes older exhausted cooldown rows before selection, without sending a provider request. The failed Job remains available to the existing audited/idempotent recovery flow.
- `production_state` 1.3 adds `retry_state` with attempt, maximum, remaining automatic attempts and resume time. Cooldown is labelled as waiting for model quota; exhausted automatic retries become `failed`, `needs_human=true` and `auto_continue=false`.
- Operator explanations separately identify input overflow, Schema-interface rejection and provider quota exhaustion.

## Migration and production safety

No database migration is required. Existing `jobs`, `model_call_metrics`, failure records and recovery mechanisms are reused. Merely opening 2.0.15 performs no model call and enqueues no approved production work. On normal worker selection, an already-exhausted queued cooldown is changed deterministically from `queued` to `failed`; this is an idempotent local state correction and does not run the model. No production archive, deletion, automatic retry, WordPress operation or deployment was executed during this implementation.

## Verification

Targeted syntax checks and 54 focused Vertex, production-state and operations tests pass. The full suite passes 551/551 tests, `npm run check` passes the production build and service boundaries, and the consolidated offline release gate passes 50 mandatory checks with zero failures, five warnings and five explicitly external/not-tested checks. One release-gate run observed an unrelated Favorites worker ordering test flake; the isolated test immediately passed and the clean gate rerun passed all 551 tests. The new regressions include a 180-fact/1,800-snippet oversized assembly, deterministic byte/token enforcement, durable Schema-mode resumption, 429 maximum-attempt enforcement, legacy attempt-11 finalization and cooldown/exhaustion projection. No paid model, production WordPress, Search Console or production-database request was made.
