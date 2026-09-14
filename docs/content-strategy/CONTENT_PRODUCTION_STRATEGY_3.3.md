# SoloToChina Content Production Strategy 3.3

Status: active. Effective date: 2026-09-12. Current release candidate application and extension are 2.0.25 with schema 69. The deployed revision and immutable image are recorded in the release audit rather than pinned in this strategy document.

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

## Production writing and recovery doctrine

The seven approved production records are a permanent regression corpus, not a one-off queue to force through. A fix is acceptable only when it converts the exposed failure into a reusable invariant for later approvals. Current production ownership is the approved Opportunity; a Candidate ID, an older Job, or a historical failure may never create another production owner or override the newest current-scope attempt.

Every model stage receives the smallest complete projection for its job. Editorial Assembly selects the approved facts, Narrative Planning receives only the approved outline, selected fact provenance and selected Experience Blocks, and the writer receives one frozen Writing Packet in which each fact is represented once. A stage must fail locally before a provider request when its bounded input exceeds the declared byte/token budget. This prevents complete destination history, media inventories, failure logs or repeated evidence snapshots from becoming writing input.

Compression may remove duplicated evidence but may never remove editorial obligations. Every Draft and bounded repair receives the approved adaptation requirements, conflict instructions and verification qualifiers alongside its evidence scope. Independent QA must explicitly audit every mandatory adaptation and conflict instruction. A missing audit or failed requirement is a blocker even when the provider labels it as a warning. Later revisions also receive recent blocker history as regression guardrails, so fixing one issue cannot silently restore an unsupported fact, hidden uncertainty or missing bilingual navigation aid from an earlier revision.

Independent QA uses a distinct compact projection: the approved outline and mandatory requirements appear once, and only asserted or promised facts retain bounded values, qualifiers and evidence excerpts. The audit result is finite and deduplicated. Hidden model reasoning must not consume the structured JSON budget; QA uses LOW thinking, while another reasoning stage that reaches its token ceiling may retry once with LOW thinking and full attempt telemetry. A repeated content blocker on two consecutive revisions proves that the bounded patch did not match the defect and escalates to Draft-only regeneration. Delivery, media and Frontend Contract blockers never use that escalation.

The narrative and Draft must turn evidence into traveler decisions rather than enumerate facts. Each evidence-bearing section has a distinct practical job and should connect the relevant condition to its consequence, trade-off or next action. Section depth and presentation vary with that job; repetitive templates, disconnected fact rows, generic transitions, fabricated first-person experience and artificial completeness are rejected or returned as explicit editorial guidance. SEO uses natural search intent and clear entity naming; GEO uses direct, self-contained answers and visible evidence-consistent structure. Neither relies on keyword repetition, forced FAQ/schema or unsupported claims.

Page Composition starts from the current reader-visible Draft and active Frontend Contract. It preserves all evidence-bearing H2 sections, selects only published components and variants, emits semantic SEO/GEO and JSON-LD fields that agree with visible content, and orders content for answer-first scanning on small screens. The CMS stores component choices, data and provenance; Frontend/WordPress exclusively owns JSX, CSS, typography, spacing and responsive rendering. The final visual acceptance is the returned WordPress preview URL at desktop and mobile widths.

Deterministic authorized-source visual selection runs before the durable stage input is frozen. All retained Source assets are authorized for editorial and production use under `AGENTS.md`; missing legacy per-item licence flags are not a veto. Selection still requires durable bytes, destination and factual relevance, source attribution, accurate alt text and Contract-safe placement. Broken or unrelated media fail closed and no factual scene is fabricated.

Text-provider availability never weakens visual acceptance. Production writing remains on the configured text model; any explicitly audited fallback affects text only. Generated illustrations and localized authorized photos continue through the configured Gemini 3.1 Flash Image path and must produce real image bytes, hashes and media records. Reader alt text must describe the selected visual and may not expose Claim keys, database identifiers or a serialized evidence ledger. WordPress receives binary media through its media endpoint and only stable media references in the bounded Publish Package.

WordPress media responses own the public URL, dimensions, derivatives and uploaded-byte hash; they do not replace CMS provenance. At delivery, legacy visual rows are deterministically rehydrated from the authoritative Source and Source Asset records, including original-byte durability and project-level authorization, before WordPress metadata is merged. Missing historical per-visual metadata therefore cannot reject an otherwise valid authorized original, while an actually missing or inaccessible original still fails closed.

Recovery resumes at the first missing or currently failed stage and reuses valid prior artifacts. A current QA pass proves that older writing, planning and page-composition failures for the superseded revision are historical, while required visual or delivery failures remain current until resolved. Recovery, automatic continuation and operator retry share the same dependency hashes and idempotency keys. Every terminal failure remains auditable as a Failure Lesson; no repair deletes Source, original media, Claims, Knowledge, Evidence, Experience, approvals or prior attempts.

Draft acceptance checks deterministically protected amounts, durations, dates, negations, audiences, conditions and exceptions before any image or page Job is scheduled. A missing value is returned to the same bounded structured generation as an exact correction list. This invariant applies equally to full Draft generation and bounded repair: a repair receives one exact in-Job correction, then fails closed and promotes recovery to full Draft regeneration if the protected value is still absent. If a full Draft regeneration supersedes an older bounded-repair failure, that old `revise_draft` attempt becomes history even when the new QA finds a different current blocker; state and recovery always describe the current revision.

## Safety and migration

## 不变的安全边界

Upgrade rehearsal must migrate a copied schema 66 database to 67, verify integrity and cited IDs, and drill the paired backup before traffic changes. Production processing-gap and Knowledge recomputation runs remain dry-run during this rollout. No recovery execution, Base64 deletion, original-media deletion, WordPress draft creation or publication is part of the migration.
