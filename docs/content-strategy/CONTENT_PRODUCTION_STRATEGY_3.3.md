# SoloToChina Content Production Strategy 3.3

Status: active. Effective date: 2026-09-12. Current production application and extension are 2.0.13, schema 69, revision `8e3b9a467c36ff6a3b0ff33d4b28cf8700db6303`.

Strategy 3.3 keeps the source authorization, evidence, editorial approval, WordPress draft, and publication boundaries from 3.2. It changes how Claims become Knowledge, how interrupted historical Sources recover, and where expensive maintenance runs.

## Typed Knowledge resolution

Claim identity uses stable typed serialization. Equivalent hours (`24_hours`, `24/7`, `全天`, `24 hours`) and free prices (`free`, `0`, `0 RMB`, `0 CNY`, `免费`) share one canonical fact. Opening schedules retain intervals, closed days, last entry and effective dates. Predicate/value compatibility is checked before comparison; a local deterministic repair such as `opening_hours=open access` becomes `access_policy=public_access` without globally rewriting unrelated Claims.

Scope includes product or service, price type, admission scope, transport mode, direction, origin, destination, venue area, access type, booking channel and effective period. Disjoint scope and validity periods coexist. Scheduled evidence cannot replace current evidence; superseded evidence remains historical.

Ordinary dynamic disagreement uses independent-source, authority, completeness and recency weighting. A remaining ambiguity creates a targeted verification job. Only safety-critical or truly unresolved same-scope/current hard contradictions enter human review. Every automatic, repair, verification and human decision has a persisted state and history record. A recomputation dry run reports the current manual count and projected automatic, verification, repair and human counts. Execution requires its exact dry-run ID and preserves prior operator decisions.

## Source recovery and workload lanes

All complete Sources enter processing automatically, including one paragraph with 19 or 27 images. Work size selects batching and a workload lane; only an explicit technical hard limit blocks processing. Ordinary images use traceable groups of four to eight, while maps, text-dense images, tables, screenshots and videos retain individual handling.

## Opportunity reconciliation clarification

Every completed current Source that satisfies the active intake policy contributes all of its distinct production paths. Same-mode paths are merged only when their destination, content type, duration and semantic intent overlap; different publication modes and materially different reader promises remain separate.

Knowledge opportunities require at least two usable current facts from at least two independent Source families. Canonical entity identity and known bilingual destination aliases define the cluster. Context-free labels such as `venue`, `restaurant`, `pathway` or `Day 3 itinerary` do not create an article opportunity by themselves. Content type follows the cluster entity and complete title tokens; incidental words in supporting predicates cannot reclassify the topic.

Knowledge opportunity identity uses the resolved cluster entity across a primary city and its nested destination scopes. A bilingual or parent/child destination title for the same entity, content type and publication mode remains one actionable opportunity. Source-backed adaptations retain the exact declared destination because their source path and reader promise may be independently useful.

An evidence-gap opportunity remains visible for editorial consideration but cannot enter production until its required coverage is ready. Coverage refresh uses only the opportunity's selected fact keys. Replaced, duplicate and older-strategy records remain auditable internally and do not inflate the actionable Inbox.

An existing-installation upgrade deterministically rebuilds and reconciles opportunities offline, then enforces admission quality before public traffic is connected. The gate checks current completed evidence, current strategy, declared Source paths, usable selected facts, independent Source families, readiness consistency, valid lifecycle/type/mode/title/reader promise, generic-topic exclusion, duplicate identity, migration references, database integrity and foreign keys. It performs no model request, editorial approval, draft creation or WordPress action.

The processing-gap diagnostic reports capture completeness, media durability, segments, extraction, coverage, Experience, active jobs, legacy gates, hard limits, the first missing stage and the proposed action. Historical recovery begins from a stored dry-run fingerprint and queues only the missing stage. Child jobs inherit the recovery run, parent job, route, priority and `historical_recovery` class. New interactive intake runs ahead of historical work. Completed stages and model receipts remain reusable across restarts.

Experience completion opens the core entity and Knowledge path immediately. Source-family analysis, blueprint, diagnostics, topic clustering, coverage and opportunity refresh use the background-enrichment lane. `SOURCE_COMPLEXITY_ROUTING` remains disabled by default; a fragment may skip blueprint and diagnostic only after the feature flag is enabled and its quality benchmark is reviewed.

## Process isolation and incremental coverage

Knowledge aggregation, topic clustering, coverage matrices and opportunity regeneration execute in child processes when `PROCESS_ISOLATION_ENABLED=true`. Scheduled backup also runs in a child process. A child failure fails or retries its durable job while the HTTP process continues serving health and administrative reads.

Knowledge writes record changed fact keys in `coverage_dirty_scopes`. Coverage refresh selects opportunities already using those keys or newly matching their topic scope. An explicit rebuild without a dirty scope remains a full rebuild. Runtime telemetry records full or incremental mode, scanned opportunities, updated opportunities and duration.

Intake analysis receives a compact Claim and Knowledge projection with bounded excerpts. It excludes raw HTML, full Source text, complete media payloads and unrelated fact evidence. Input byte and estimated-token telemetry accompany the package.

## Safety and migration

## 不变的安全边界

Upgrade rehearsal must migrate a copied schema 66 database to 67, verify integrity and cited IDs, and drill the paired backup before traffic changes. Production processing-gap and Knowledge recomputation runs remain dry-run during this rollout. No recovery execution, Base64 deletion, original-media deletion, WordPress draft creation or publication is part of the migration.
