# Failure and production lifecycle

## 2.0.23 recovery depth and authorized source media

`production_state` 1.9 chooses recovery depth from the authoritative failure, not from the button that happens to be visible. `INVALID_DRAFT_REPAIR_SCOPE`, `MODEL_OUTPUT_LIMIT`, a database-dump-style Draft, missing planned sections, evidence-ledger evasion, or multiple global structure blockers target `generate_draft`. This preserves Editorial Assembly, Narrative Plan, Writing Packet and Frontend Page Plan while rebuilding only the failed prose. A frozen Writing Packet/page-plan scope mismatch targets `assemble_editorial`; a page/Contract-only failure targets `compose_frontend_page`.

Manual recovery uses the same current failed-QA feedback as automatic recovery. The operation is transactional, Opportunity-owned and idempotent; replaying one idempotency key cannot create another Job. Startup, migration and list projection never enqueue these recoveries.

Every imported Source asset is project-authorized for editorial and production use. Legacy item-level authorization fields remain audit data but cannot veto a retained original. Recovery and delivery still require stored bytes, exact Source provenance, destination/factual relevance, useful alt text and a valid Frontend Contract payload; inaccessible or unrelated media remains blocked.

## Unified production state

`production_state` is the only workbench lifecycle contract. It is calculated server-side from approved Opportunity readiness, Candidate/Brief/Draft lineage, durable Jobs and leases, Pipeline Artifacts, Step Receipts, current revision/hash-bound outputs, Frontend compositions, Quality Reviews, WordPress publications and record disposition. Clients must not combine `status`, `brief_status`, `draft_status` or `workflow_status` to infer production state.

The top-level shape contains `version`, `lifecycle`, `readiness`, `headline`, `explanation`, `blocking_requirements`, `current_stage`, `current_stage_label`, `stage_status`, `completed_stages`, `pending_stages`, `production_instance_id`, `production_owner_opportunity_id`, `owner_resolution`, `recovery_target`, `recovery_target_label`, `next_stage`, `next_stage_label`, `progress`, `auto_continue`, `needs_human`, `recoverable`, `retry_state`, `latest_error`, `latest_historical_error`, `last_attempt_at`, `available_actions`, `stage_registry`, `timeline`, `disposition` and `has_production_lineage`. `lifecycle` is one of `pending_start`, `in_progress`, `needs_attention`, `completed` or `history`; `stage_status` distinguishes `waiting`, `queued`, `running`, `failed`, `interrupted`, `blocked` and `succeeded`. In contract 1.3, `retry_state` reports provider backoff attempt, maximum attempts, remaining automatic attempts and resume time; an exhausted cooldown is displayed as failed and never as an indefinitely auto-continuing queue item.

The approved Opportunity ID is both the production instance and canonical production owner. New production Jobs always store that owner and child Jobs inherit it. A legacy unowned Job may be used only when the Candidate has exactly one approved Opportunity; it is never copied across siblings. Candidate identity by itself is neither admission to `productionOnly` nor production lineage.

An unresolved owner-matched failed Job wins over legacy Brief/Draft labels only when its current-contract dependencies are complete. It supplies the stage, failure code, operator-safe reason, occurrence time, Job/request identity, attempt, failure class, provider/model, whether a provider request was sent and whether model execution is confirmed. A provider request rejected without token/usage evidence is `rejected_before_generation`, not “model called”. A later queued/running/succeeded attempt for the same stage supersedes the old failure. A Brief/Draft `exception` without a retained failed Job is surfaced as an explicit persisted-state inconsistency rather than a generic “ready” label. A running Job whose lease has expired is `interrupted`. A completed persisted step followed by no downstream Job/output beyond the continuity grace period is also `interrupted`.

When an old downstream failure lacks a prerequisite required by the current registry, it is not allowed to override the live recovery target. `production_state` 1.2 and later move its attribution to `latest_historical_error`, annotate the timeline step as non-blocking history, report the live state as `interrupted`, and choose the first missing prerequisite-safe step. This is how an old Page Plan failure now resumes Narrative/Packet assembly rather than attempting to skip directly to Page Plan.

`production_state` 1.6 also recognizes an old failed Draft whose visible headings retain fewer than 75% of the named evidence-bearing Brief sections. That record remains a QA failure for attribution, but its exact `recovery_target` becomes `generate_draft`; the preserved Brief, Narrative Plan and Writing Packet are reused, and only the damaged Draft plus its current dependent page/review artifacts are rebuilt. Active Jobs and a current passing review always take precedence, preventing compatibility detection from interrupting live or completed work.

`production_state` 1.7 treats a WordPress `INVALID_PAGE_SCHEMA` rejection as a delivery-boundary failure whose exact recovery target is `compose_publish_page`. The failed remote write created no WordPress Draft. Recovery reuses the current QA-passed Draft, Frontend page, media and commercial composition, remaps the public guide taxonomy, validates a new Publish Package and then resumes draft-only delivery. It never returns to writing or evidence stages.

`production_state` 1.8 applies the same targeted recovery to a WordPress `INVALID_COMPONENT_DATA` response caused by sanitizer-stable inline encoding. The Publish Package is rebuilt with canonical safe entities and revalidated locally; recovery neither reuses the rejected package nor restarts article production.

In 2.0.22 the final-page evidence gate also recognizes this delivery-only normalization by re-signing already verified block provenance in memory. The operation is fail-closed: any missing, reordered or changed original signature disables remapping and produces the existing QA failure.

Failed state separates `current_stage` (the failed step), `recovery_target` (repeat that exact step) and `next_stage` (the following pipeline step). Interrupted state reports the last completed position as current and the first missing dependency-safe step as both recovery target and next step. Queued/running state reports its active step and the following step. Only succeeded evidence increments `progress.completed`.

## Recovery and record disposition

Both `retry_failed_stage` and `recover_next_stage` resolve through the backend `recovery_target`; the former is valid only for `failed`, the latter only for `interrupted`. Dependencies must already be complete. A stale client request receives a refresh-and-use-current-target conflict in operator-facing Chinese instead of raw internal stage keys. The recovery Job receives the exact Opportunity owner and a recovery-run identity and uses the normal durable Job dedupe, stage Artifact hash, Step Receipt, lease and transaction mechanisms. The operation is idempotent by owner/stage/input identity/retry generation; a matching active recovery is returned instead of enqueued again. It does not delete or overwrite successful upstream outputs.

Vertex structured output uses native JSON Schema, then the provider OpenAPI Schema dialect. If both transports are rejected with HTTP 400, the client removes the provider-side schema, places the same contract in the system instruction and keeps `application/json`; the returned result must still pass the unchanged local JSON Schema validator. Each rejected transport transition is persisted in the existing model-call receipt. When the same durable Job is reclaimed after a provider backoff, it resumes the persisted transport instead of submitting a known-invalid Schema again. Transport negotiation does not consume the bounded semantic repair attempts. It creates no background retries and is used only when an explicitly queued stage executes.

Editorial Assembly has its own deterministic pre-model budget because it executes before a frozen fact selection exists: 48 ranked facts, 96 evidence snippets, 16 Experience blocks, 48 Source-family links, bounded learning examples and at most 128 KiB/~32k estimated input tokens. Materiality ranking retains conflicts, negatives, dates, exceptions and reader-promise overlap. This projection only limits the model request; complete Source, media, Claim, Knowledge, Evidence, Experience, approval and audit records remain stored unchanged.

Provider pressure uses exponential cooldown but never bypasses `jobs.max_attempts`. The final permitted 429 becomes an auditable failed Job with `failure_class=retryable_provider`; a later operator recovery creates/reuses the normal idempotent stage recovery. Legacy queued cooldown rows already at or above their maximum are transactionally finalized before Job selection without calling a model.

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
