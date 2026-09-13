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

The first authorized rollout attempt stopped before new-code exposure because the enforced Opportunity audit found eight legacy actionable rows with no top-level `proposal.readerPromise`. The helper automatically restored the verified 2.0.15 database and restarted the previous container. This was a safe deployment-gate rejection, not an application or migration failure. The deterministic invariant repair above was added, passed the same gate on the second attempt, and allowed the temporary failed-database copy to be removed after successful rollout.

## Production rollout

The successful authorized rollout used Cloud Build `11548179-8f9d-4a5c-8c39-d1615d73f0f6` and deployed revision `119604f29dedcb4658fec83022d31faa41b2ac7e` at immutable digest `sha256:af7892df209b995173e743bbd23097f8a6b5a775ecde8363fc881d3f7caf8b13`. Public `/api/health` reports App 2.0.16, ready HTTP/database services, zero queued or running Jobs, configured Vertex `gemini-3.8-flash`, and a healthy Frontend Contract 1.4.0 at Frontend commit `f44ce1092ced93dfb47d9b3eae83d0d5e4b97086`.

The upgrade created and drilled application snapshot `solo-to-china-2026-09-13T19-24-14-850Z.snapshot` (2,221,273,088 bytes, SHA-256 `4b7eee5d9f5bc659aec438e21a5a688660a41ffddeb804688659f6901a76c565`) and retained READY disk snapshot `stc-pre-2-0-16-efbc01d`. Rehearsal and production open both reported schema 69, integrity `ok`, zero foreign-key errors and identical protected-content fingerprints. The enforced Opportunity audit passed with zero hard or integrity violations. Deterministic reconciliation changed no model-call, WordPress Job or Draft count.

The authenticated post-rollout projection reports exactly seven approved records: one `pending_start` scope-confirmation record and six `needs_attention` records. Exact recovery targets are `assemble_editorial` for the quota-exhausted route, `revise_draft` for Hongyadong QA, `plan_narrative` for the interrupted legacy route, and `plan_content` for the three old Vertex-format failures. The corrected Chongqing food guide has no current error; the 11:23 mismatch is shown only under non-blocking history. There are zero active production Jobs and zero active Jobs of any type. Counts remain Sources 74, Claims 5,147, Evidence 8,292, Knowledge 4,270 and model-call metrics 5,748; integrity is `ok` and foreign-key errors are zero. No record was automatically retried, archived or deleted.

Chrome production acceptance used the existing authenticated session without submitting an action. Desktop Content Workbench displayed the server-supplied stages and recovery targets. At a 390×844 viewport, the mobile action menu opened above its trigger with details/menu z-index 40/50; hit testing returned the menu itself, not a following card, and the browser console had zero errors. The corrected-destination detail displayed `等待重新确认生产范围`, 0/11 current-scope progress, `素材组装` as the next step, and the old mismatch only as historical failure.

The immediate rollback set is the stopped `engine-before-119604f` container, the retained 2.0.15 image, the READY disk snapshot above and the verified application snapshot above. After success, the failed first rollout's 2.1 GiB database copy and release directory were removed, obsolete snapshot `stc-pre-2-0-14-9341a30` was deleted, and image pruning retained only current, immediate-rollback and Cloudflared images. VM disk use is 12% with 67 GiB free. Temporary IAP firewall/tag access and remote audit scripts were removed.
