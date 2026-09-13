# Failure and production lifecycle

## Unified production state

`production_state` is the only workbench lifecycle contract. It is calculated server-side from approved Opportunity readiness, Candidate/Brief/Draft lineage, durable Jobs and leases, Pipeline Artifacts, Step Receipts, current revision/hash-bound outputs, Frontend compositions, Quality Reviews, WordPress publications and record disposition. Clients must not combine `status`, `brief_status`, `draft_status` or `workflow_status` to infer production state.

The top-level shape contains `version`, `lifecycle`, `readiness`, `headline`, `explanation`, `blocking_requirements`, `current_stage`, `current_stage_label`, `stage_status`, `completed_stages`, `pending_stages`, `next_stage`, `progress`, `auto_continue`, `needs_human`, `recoverable`, `latest_error`, `last_attempt_at`, `available_actions`, `stage_registry`, `timeline`, `disposition` and `has_production_lineage`. `lifecycle` is one of `pending_start`, `in_progress`, `needs_attention`, `completed` or `history`; `stage_status` distinguishes `waiting`, `queued`, `running`, `failed`, `interrupted`, `blocked` and `succeeded`.

An unresolved failed Job wins over legacy Candidate/Brief/Draft labels and supplies the stage, failure code, operator-safe reason and occurrence time. A Brief/Draft `exception` without a retained failed Job is surfaced as an explicit persisted-state inconsistency rather than a generic “ready” label. A running Job whose lease has expired is `interrupted`. A completed persisted step followed by no downstream Job/output beyond the continuity grace period is also `interrupted`, with `next_stage` set to the first missing dependency-safe step.

## Recovery and record disposition

`retry_failed_stage` resolves only to `latest_error.stage`; `recover_next_stage` resolves only to `next_stage`. Dependencies must already be complete. The recovery Job receives a recovery-run identity and uses the normal durable Job dedupe, stage Artifact hash, Step Receipt, lease and transaction mechanisms. It does not delete or overwrite successful upstream outputs.

Archive stops active production Jobs and moves the attempt to `history` without deleting artifacts. Restore is explicit. “Delete production record” removes production Jobs/Artifacts/Receipts plus Editorial Assembly, Brief, Draft, current review/visual/page/commercial/publish/WordPress-local descendants and orphanable Frontend capability requests. It retains Sources, original media/capture versions, Claims, Knowledge, Evidence, Experience, recommendations and decisions, Candidate/Opportunity approval, Failure Lessons, attempt archives, model-call accounting and operation audit. A retained remote WordPress Draft makes deletion invalid; archive must be used instead. All disposition operations are transactional, idempotency-keyed and recorded in `production_record_audit` with a deletion tombstone.

## Opportunity states

Actionable opportunities begin as `recommended` (or return as `recommended_again`). An editor may independently approve, defer or ignore each item. Approval changes the state to `approved`; evidence-ready work moves through `producing` to `finished`. Evidence-incomplete approval remains durable and resumes only when a Knowledge rebuild makes the coverage ready.

`SOURCE_ADAPTATION`, `TOPIC_FEATURE` and `MULTI_SOURCE_SYNTHESIS` are parallel production modes. Approving one path does not consume the others.

## Terminal production failure

A bounded, non-system production failure under Strategy 3.1 creates a `failure_lessons` record and an idempotent `production_attempt_archives` snapshot containing the failing stage, inputs, Assembly, Brief, Narrative, Packet, Draft/revisions, reviews, visuals, page and WordPress association. It preserves approval and all production artifacts for the existing bounded stage repair workflow.

- Expression or local ledger problems remain `qa_failed`; other recoverable content-stage failures remain `exception` with a specific repair stage.
- Sources, capture versions, original media, Claims, Knowledge, Experience, production artifacts, feedback and Golden Article associations remain available.
- Only explicit `APPROVED_SCOPE_INVALID` or `EVIDENCE_SCOPE_INVALID` cancels the remaining attempt jobs and resets the candidate/opportunity to `recommended_again`. Cancellation retains job rows and artifact history, and the preservation result is recorded in `production_rollbacks`.

The editor must approve a changed scope again. Ordinary expression, media, page, network or provider failures do not request a second approval of the same scope. Assembly receives only active, retry-safe Failure Lessons for the current opportunity; unrelated automatic failure lessons are excluded.

Database corruption/unavailability, credentials, provider quota, network and lease faults remain operational exceptions. A source-media fault marks the Draft `media_pending` and queues repair without rewriting valid prose. Automatic repair budgets remain enforced; exhausting a budget keeps a reviewable artifact and actionable diagnosis.

Entity-resolution pages and targeted extraction/coverage calls retain verified `pipeline_step_receipts` across worker replacement. Input/configuration changes and damaged output hashes prevent reuse; lost ownership cannot write a receipt. Targeted extraction stays private until coverage succeeds, then extraction, audit, downstream work and job completion commit together. Page/commercial/publish saves and WordPress acknowledgement also use guarded local transactions. External delivery still follows the existing idempotency/receipt protocol; a provider call cannot participate in the SQLite transaction.

## Published content impact

When a Claim or Knowledge change affects a published WordPress record, the system creates a durable impact plus an `UPDATE` opportunity. It never changes the live post. Topic overlap is shown as `UPDATE`, `EXPAND` or `MERGE`; a new topic is `NEW`, and an explicit editorial non-action is `SKIP`.

## Editorial feedback

Draft feedback produces reusable `editorial_lessons`. “很好” or another explicitly successful result may be saved as a `golden_articles` reference. These records guide later Assembly and Writing Packets while retaining their source Draft and revision; they are not copied wholesale into a new article.
