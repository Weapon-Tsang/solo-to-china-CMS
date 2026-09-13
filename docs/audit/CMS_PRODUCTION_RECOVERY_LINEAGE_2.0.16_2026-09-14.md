# CMS 2.0.16 production recovery lineage audit

Date: 2026-09-14  
Release: 2.0.16  
Schema: 69 (unchanged)  
Content Strategy: 3.3 (unchanged)  
Production state: 1.4

## Scope and safety

This repair covers the seven approved records visible in Content Workbench after the 2.0.15 rollout. The production audit was read-only. Recovery behavior was replayed against a consistent `VACUUM INTO` copy in a temporary network-disabled container with no worker, provider credentials or outbound network. The disposable replay created Jobs only in its copied database. No production record was retried, archived, deleted or scope-corrected during investigation, and no model or WordPress request was made.

The release has no database migration. Deployment and startup must not enqueue these seven records; each record continues only after its own explicit operator action.

## Root causes

1. The recovery route accepted an Opportunity ID but used it as a Candidate ID when loading topic and planning packages. Three structured-output rows and one interrupted row therefore failed in the HTTP route before a replacement Job was created; the Workbench continued to display the old Vertex 400 failure.
2. A completed destination correction updated the approved Opportunity correctly, but the state builder still treated the pre-correction `DESTINATION_TOPIC_MISMATCH` Job and Editorial Assembly as current-scope production state.
3. Persisted Brief rows whose status was later changed to `exception` were not counted as completed planning artifacts. A downstream legacy interruption therefore tried to recover `plan_content` instead of continuing at the first genuinely missing current stage.
4. A completed failing QA report was represented only as a failed `review_draft`; it did not identify the minimal repair stage. The running review Job also matched its own active-Job guard, preventing the bounded automatic repair it was meant to enqueue.
5. Historical Jobs for stages no longer present in the current stage registry could remain current failures instead of audit history.

## Implementation

- Recovery resolves the Opportunity owner to its canonical Candidate before loading Candidate-owned research and planning packages. Newly recovered production Jobs remain Opportunity-owned.
- A completed `correct_destination` operation defines a production-scope reset timestamp. Jobs, receipts and Editorial Assembly artifacts before that boundary remain auditable but do not determine current progress or failure.
- If the correction has not yet been explicitly reconfirmed, the backend returns `pending_start`, no live error, and action `confirm_destination_scope`. The action validates the corrected package, clears only the suppression flag and idempotently queues `assemble_editorial` for that Opportunity. A post-correction retry already present in the lineage is treated as explicit confirmation, so its current outcome is not hidden.
- A persisted Brief proves `plan_content` completed. A completed QA report proves `review_draft` ran, whether it passed or failed. Blocking content issues recover through `revise_draft`; page-only issues recover through `compose_frontend_page`; media-only blockers remain manual.
- The current running review Job is excluded from only its own automatic-repair guard. Unrelated active Jobs still prevent duplicate repair enqueue.
- Failures for disabled or removed legacy stages move to history. Recovery begins at the first missing stage in the current registry.
- Deterministic Coverage Matrix reconciliation restores a missing top-level `proposal.readerPromise` from the frozen approved proposal, falling back to the existing title only for an unfrozen recommendation. This satisfies the enforced opportunity audit without calling a model or changing an approved scope.
- `production_state` is version 1.4. The UI renders the backend action and corrected-scope state; it does not infer this condition from legacy status fields.

## Production-copy replay

The final isolated replay covered all seven current Workbench owners:

| Record | Expected current action/stage after repair |
| --- | --- |
| Chongqing food guide with corrected destination | `confirm_destination_scope`, then `assemble_editorial` |
| Chongqing Metro Tourist Map | `plan_content` |
| Chongqing 3-Day Walking Itinerary | `plan_content` |
| Chongqing 48-hour guide | `plan_content` |
| Feasible 3-Day Chongqing Route with current quota exhaustion | `assemble_editorial` |
| Chinese 20-landmark route with legacy page-plan interruption | `plan_narrative` |
| Hongyadong guide with blocking QA result | `revise_draft` |

All seven replay assertions passed. Counts before and after replay were identical for protected stores: Sources 74, Claims 5,147, Evidence 8,292, Knowledge 4,270 and model-call metrics 5,748. SQLite integrity returned `ok` and the foreign-key check returned zero rows.

## Verification

Targeted production-state and recovery tests cover canonical owner resolution, destination-scope confirmation, stale-suppression clearing, null-safe destination validation, persisted Brief recovery, current-registry discontinuity and QA repair targeting. The pipeline test proves a running review Job can enqueue its bounded child repair without allowing an unrelated duplicate.

The complete local suite passed 556/556 tests. `npm run check` passed the Vite production build, syntax checks and all seven service-boundary checks. The consolidated `npm run release:check` gate passed 50 mandatory checks with zero failures, five explicit warnings and five external/not-tested checks. It covered the full suite, clean schema 1→69 migration, production build, fixed-SHA Frontend Contract, backup/restore drill and isolated API/UI smoke. Real provider generation is intentionally not part of this release verification because the repair changes recovery lineage and state projection, not the 2.0.15 provider transport implementation.

Production rollout evidence is appended after execution.

The first authorized rollout attempt stopped before new-code exposure because the enforced Opportunity audit found eight legacy actionable rows with no top-level `proposal.readerPromise`. The helper automatically restored the verified 2.0.15 database and restarted the previous container. This was a safe deployment-gate rejection, not an application or migration failure. The deterministic invariant repair above was added and must pass the same gate before a new immutable revision is attempted; the failed database copy remains temporary rollback evidence until the successful rollout cleanup.
