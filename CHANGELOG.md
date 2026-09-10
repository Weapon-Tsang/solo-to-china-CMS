# Changelog

## 1.17.23 - Unreleased (audit requirements 1.3)

- Persist structured extraction input manifests so image/video coverage uses submitted asset evidence rather than method-name guesses; legacy records remain explicitly unknown.
- Separate Vertex Batch inference completion, output reading, item ingestion, quarantine, and cleanup so transient Cloud Storage failures resume without repeated inference or premature deletion.
- Correlate Batch rows with Vertex's transport `keyField`, retain request fingerprints as a recovery path, quarantine duplicate/unknown rows, and treat model-reported IDs only as a cross-check.
- Persist Batch failure classes, route decisions, attempt budgets, and next-eligible timestamps so permanent preparation failures terminate, oversized inputs use realtime, provider failures back off, and local capacity does not spend the error budget.
- Freeze provider, model, location, project, schema, prompt, and configuration identity on submitted Batch runs; historical Vertex work continues through its stored adapter after the default model changes.
- Fence job ownership with a monotonic lease generation, abort guarded model and delivery calls when heartbeats lose ownership, reject stale completion/failure writes, and recover only expired Batch preparations.
- Separate publication, observation, capture, verification, and validity-window semantics; scheduled and historical evidence is retained but excluded from current conclusions.
- Separate manual submitter metadata from author/publisher identity, preserve original/canonical/final public URLs, and deduplicate uploaded files and repeated URLs by stable source identity.
- Resolve overlapping duplicate families, stable source identities, and stable authors as deterministic connected components with folded-source audit detail and a dry-run rebuild preview.
- Replace page-array provenance with stable section/node references and store a Contract-neutral sidecar that traces factual blocks through Claims and Sources to exact evidence spans; legacy mappings remain explicitly unknown.
- Validate final visible page artifacts against their evidence ledger, protected values and qualifiers, visible as-of dates, Claim/Source relations, and answer-bearing content before delivery.
- Split extraction transport success, evidence coverage, publication usability, and materiality; retain partially covered Claims for bounded topics, route meaningful zero-Claim media to review, and propagate only topic-relevant coverage limitations.
- Fence editorial assignments by explicit Entity scope and typed predicates/relations, expose per-Fact include/exclude reasons, rank automatic type candidates with confidence, and preserve operator type overrides.
- Cancel and invalidate stale detail requests, and report full/partial/failed dashboard refresh outcomes without replacing a newer dialog or claiming false success.
- Add bounded adaptive account/client-source login throttling, generic failure responses, password-free audit events, unknown-account timing equalization, and an explicit trusted-proxy header policy.
- Replace database-only backups with hashed database-and-content snapshots, database-file reference verification, versioned rollback metadata, and an isolated mock delivery restore drill.
- Consolidate Node 24 tests, static/build checks, fixed-SHA Frontend contracts, version alignment, backup drills, and explicit offline/unverified quality dimensions into one release gate and CI workflow.
- Add media-aware source admission, deterministic processing-scope estimates and manual start for high-cost captures; reject missing or unsupported evidence before a model call.
- Preserve PDF text and visual-page inventories with page locators, route scanned/chart pages through the existing Vertex document input, and avoid automatic whole-document OCR.
- Add a held-out, versioned article quality set and deterministic hard gates for evidence coverage, amounts, dates, exceptions, audience qualifiers, prompt injection, FAQ support, and final-page facts while keeping length, repetition, readability, metadata length, Sources presentation, and image count as editorial warnings.
- Freeze per-stage model capability/thinking/token/timeout/retry policy, meter every realtime and Batch attempt, retain unknown costs as null with dated price provenance, and replace full draft rewrites with current-hash bounded section repair.
- Persist dependency/config artifact keys for safe duplicate reuse, eliminate the duplicate coverage rebuild, page Entity resolution beyond 300 Claims, add age/realtime/dependency-aware scheduling and queue age, and expose measured runtime/performance reports without invented p95 or database-query estimates.
- Keep SEO titles and descriptions evidence-bounded and independently editable without mechanical search-snippet truncation; version page and SEO artifacts so metadata-only edits reuse research and writing while invalidating final checks.
- Synchronize visible metadata, canonical URLs, Article/WebPage/Breadcrumb schema and optional visible FAQ from one deterministic source; omit invented authors, dates, products, ratings and private media URLs.
- Select internal links only from relevant published same-site WordPress inventory, validate real anchors and targets, report duplicate risk without automatic consolidation, and invalidate only page blocks affected by route/status changes.
- Persist WordPress media URL, intrinsic dimensions, MIME, bytes, SHA-256 and responsive derivatives; deduplicate the same source asset, enforce evidence/alt/public-URL rules, and render one high-priority first image with lazy later images in the Legacy path.
- Validate fixed published/draft HTML fixtures across visible body, one-H1, SEO, schema, link/media, sitemap, robots and device-equivalence dimensions while keeping production HTML, indexing, ranking, CWV and AI citation conclusions explicitly separate.
- Add a first-time-guide Content AST compatibility path with stable semantic/evidence/media references and deterministic Registry mapping, preserving Markdown, visible facts, FAQ and schema while retaining the existing fallback for unsupported types.
- Add cursor-safe operations workspaces with real total counts, four independent draft readiness dimensions, explicit untested states and failed-stage-only retry guidance.
- Version Commercial overlays and event attribution by article revision, asset and source; reject money on clicks and keep unconfirmed bookings/commission unknown rather than zero.
- Begin the tested in-process Repository/UI split with machine-checked service boundaries, extracted Commercial event persistence and an isolated content-quality workspace, retaining the API and SQLite facade.

## 1.17.11 - 2026-09-09

- Finish active Source coverage, finalization and intake diagnostics before expanding the remaining extraction backlog.
- Pause AI job claiming under Vertex provider pressure without marking every queued Source as cooling down.
- Use low Gemini thinking for extraction/classification and medium thinking for planning, writing and review; remove redundant image/video coverage model calls.
- Drop individual untraceable text Claims while preserving valid Claims, and reserve manual review for material segments with no traceable evidence.
- Add Content Strategy 1.6 editorial sufficiency, focused Topic Features, rights-authorized single-Source adaptations and multiple specific series ideas.
- Fix the mobile Sources status summary layout and make a Sources-tab action badge open the first Source requiring intervention.

## 1.17.10 - 2026-09-09

- Smooth AI traffic with a shared one-second request gate so a restarted worker does not send its initial batch simultaneously.
- Start durable AI work at two concurrent jobs, grow to four after 12 successful calls, and halve concurrency immediately when any extraction, analysis, drafting, review, or visual job encounters provider pressure.
- Replace the fixed one-minute-to-one-hour quota delay with Retry-After-aware, jittered truncated exponential backoff from five seconds to five minutes, using consecutive provider-pressure outcomes rather than unrelated job attempt counts.
- Remove the ignored `temperature` parameter from Gemini 3 requests and make every throughput/backoff setting explicit in the production environment.

## 1.17.9 - 2026-09-09

- Show both source titles, original links, exact text context, and linked source images directly in Claim review cards.
- Add an authenticated, bounded image-preview endpoint backed by the stored review derivative, with HTTPS original-image fallback for legacy captures.
- Disable final Claim decisions whenever either side lacks reviewable evidence, and offer per-source re-extraction instead of asking the operator to guess.
- Treat viewpoint locations, offered views, and viewpoint-for relations as compatible multi-value evidence instead of single-value hard facts.

## 1.17.8 - 2026-09-09

- Prioritize non-model Knowledge rebuilds ahead of the historical model-extraction backlog so startup reconciliation promptly removes review cases that the current semantic rules now classify as compatible.
- Keep source finalization first and continue respecting every job's availability time and provider cooldown.

## 1.17.7 - 2026-09-09

- Treat different valid viewpoints in is_visible_from Claims as multi-value enrichment rather than a single-value conflict.
- Recognize a full-glass normalized description as preserving the source meaning of “只有玻璃”, while genuine missing exclusivity still enters review.
- Add production-derived regressions for both remaining false positives after the 1.17.6 Knowledge rebuild.

## 1.17.6 - 2026-09-09

- Treat different positive natural-language descriptions of the same feature as compatible enrichment, including view, scenery, appearance, lighting, vegetation, and amenity Claims.
- Do not mistake procedural convenience wording such as “只需要” for a missing exclusivity qualifier; recognize contactless as preserving “0 打扰” semantics while retaining review for genuine limits such as “only the east gate”.
- Recalculate away historical pending false-positive reviews under the corrected rules, while preserving explicit administrator dismissals.
- Explain every remaining manual review in plain Chinese: what the system compared, why it stopped, what each choice means, and what changes after the decision.
- Label final-value choices as the fact that future content will use, while making clear that original evidence is retained.
- Treat positive feature flags and their richer descriptions as compatible enrichment, and recognize translated feature values extracted from the same evidence as paraphrases instead of conflicts.
- Normalize scope comparisons consistently and prefer informative Knowledge values over boolean shorthand when evidence support is tied.
- Preserve an administrator's false-positive dismissal through later Knowledge rebuilds so the same reviewed pair does not reappear as a conflict.
- Keep a Source in processing state while other segments are still queued, and expose an audited per-segment choice to retry or confirm that uncovered text is non-material before finalization.
- Localize segment extraction, coverage-review statuses, and the legacy coverage error shown in Source details.
- Show each Source's live extraction stage, running and remaining job counts, source-level queue position, cooldown time, and provider-pressure state; number Source titles consistently in the current list.

## 1.17.5 - 2026-09-09

- Prevent coverage audits and source finalization from starving behind a large FIFO segment-extraction backlog, while preserving each job's Vertex cooldown and availability time.
- Show extracted and audited segment counts in the Sources list before final Claims are committed, so active work is observable instead of appearing permanently stuck at zero.

## 1.17.4 - 2026-09-09

- Prevent Favorites Sync retry sessions from remaining indefinitely in the checkpoint-saving phase by committing terminal state before cleanup and bounding CMS/media requests with explicit timeouts.
- Recover a persisted running/completed session during Extension restart and keep timed-out failed items resumable without losing successful captures.

## 1.17.3 - 2026-09-09

- Localize CMS detail dialogs, review workflows, configuration guides, commercial and affiliate sections, shared status/category labels, login, and password forms into Chinese.
- Add a regression check that prevents the localized workflow controls from silently returning to English.

## 1.17.2 - 2026-09-08

- Load owner-authorized Xiaohongshu CDN videos through a hostname-allowlisted, size-bounded path instead of misclassifying them as out-of-directory uploads.
- Keep Vertex 429 quota failures durably queued with longer backoff and apply a shared AI queue cooldown instead of exhausting three short retries into a manual blocker.

## 1.17.1 - 2026-09-08

- Pause Favorites Sync when Xiaohongshu verification interrupts note navigation, reduce resumed concurrency, and keep concurrent work recoverable.
- Keep failed tasks available for retry and prevent a run with unresolved failures from being reported as complete.
- Let an already completed partial 1.17.0 run retry or rediscover only its failed items while preserving successful captures.

## 1.17.0 - 2026-09-08

- Fixed real Xiaohongshu board acquisition to use each visible card's authorized detail navigation URL while keeping CMS identity/storage token-free; legacy unfinished queues are rediscovered, temporary completeness gaps retry, and one failed note no longer blocks the collection.
- Localized the Favorites Sync extension popup and manifest in Chinese, added live Scope detection, one-second progress refresh, and explicit ready/scanning/acquiring/retrying/paused/completed/error guidance.
- Added a Manifest V3 Favorites Sync service worker with persistent per-Scope sessions, batched identity discovery, reliable checkpoint/known-streak stopping, unbounded full-history streaming, reusable worker tabs, adaptive 4–12 browser concurrency, retry/backoff, pause/resume/cancel/recovery, optional Auto Sync, progress summaries, and the existing single-note Save fallback.
- Added Migration 35 with immutable Capture Versions, complete Source/Asset rights and provenance, media identity/dimensions/duration/original/derivative hashes, completeness state, per-version Source segments, one-Source-per-Xiaohongshu identity, active Job dedupe keys, and aggregate Favorites Sync run telemetry.
- Added authenticated batch identity, chunked Capture upload, and Favorites run-summary APIs. Large JSON captures are size/SHA-256 verified and abandoned upload sessions expire automatically.
- Removed silent raw-text/DOM/media total truncation. All image batches and videos are processed, oversized originals keep provenance alongside AI-safe derivatives, partial captures cannot enter extraction, and model output exhaustion resegments and retries evidence.
- Added adaptive 4–8 CMS extraction concurrency and explicit per-call/per-segment configuration. Favorites and explicit Extension Save now share owner-confirmed commercial-use/publishable media semantics with full provenance while preserving the Recommendation human approval boundary.
- Added migration, API, queue/recovery, idempotency, rights, completeness, large-capture, multi-media, provider-batching, output-limit, and pipeline regression coverage; updated architecture, operations, ingestion, research-boundary, strategy interpretation, handoff, and Extension documentation.

## 1.16.1 — 2026-09-08

- Aligned Queue guidance with the current Trip.com Affiliate Link builder, including Attractions & Tours Page destination tasks and the visible Flight + Hotel, Car Rentals, Airport Transfers, and Homepage tools.
- Added migration 34 to preserve existing tasks while correcting incomplete attraction destination guidance and extending required pickup-location data.
- Made explicit Seed synchronization refresh mutable operator guidance without changing task keys, Sub IDs, completed tasks, or skipped tasks.

## 1.16.0 — 2026-09-08

- Added a durable Trip.com manual Affiliate Asset Setup Queue with explicit seed tasks, qualifying Opportunity intake, stable task keys and Sub IDs, and exact-asset suppression.
- Added authenticated completion, skip, CSV/JSON export and row-isolated import APIs; completion reuses the existing Affiliate Asset, Composer, attribution, and performance pipeline.
- Added the Commercial dashboard queue workflow with filtering, operator guidance, copy actions, validation preview, and safe URL recording.
- Added schema migration 33 and strict Trip.com HTTPS/official-domain validation, structured Search Box configuration, promotion validity enforcement, and full regression coverage.

## 1.15.2 — 2026-09-08

- Version HTTPS Frontend Contract requests with the exact deployed frontend commit and request cache revalidation, preventing stale CDN artifacts from being accepted immediately after a frontend release.
- Add production-derived regression coverage for all Registry, Page Schema, and Publish Package Schema source URLs while preserving existing query parameters.

## 1.15.1 — 2026-09-08

- Rebuilt Frontend Contract snapshots around composite artifact identity so a Page or Publish Schema change can be activated while the Registry checksum stays stable.
- Preserved foreign-key references during the migration and added a partial unique index for non-empty composite checksums.

## 1.15.0 — 2026-09-08

- Bound QA, page composition, commercial composition and publishing to exact draft/evidence revisions, with final-page validation before external delivery.
- Added Strategy 1.5 content sufficiency, visible source traceability, optional evidence-backed FAQ, stable block provenance and subject-matched media handling.
- Added durable job leases, partial media progress, server-side session revocation, provider schema validation, bounded model execution, hash-only usage metrics and response reuse.
- Added publication lifecycle impact, composite frontend artifact identity, cross-repository release verification and concurrent WordPress draft idempotency.

## 1.14.1 — 2026-09-07

- Made the confirmed derived-research reset atomic across the bidirectional Opportunity, Recommendation, and Candidate relationships by deferring foreign-key checks until every derived projection is removed.
- Included draft-linked commercial opportunities and events in the reset scope while continuing to preserve raw Sources, uploaded originals, source assets, affiliate inventory, and the persistent Docker volume.
- Added a populated cyclic-relationship regression test reproducing the production foreign-key failure.

## 1.14.0 — 2026-09-07

- Activated Content Production Strategy 1.4 with Source Segments, Evidence Spans, exhaustive segment extraction, coverage audit/retry, Source Families, Topic Clusters, Coverage Matrices, and evidence-gated durable Content Opportunities.
- Changed article approval to map to the exact Opportunity: insufficient evidence waits without repeated approval, while a ready Opportunity creates and queues one stable Candidate.
- Added reversible administrator Claim exclusion and Knowledge hide/restore controls whose audit decisions survive Knowledge rebuilds without deleting Sources, Claims, or evidence.
- Added 5 MB chunked video intake with upload progress and assembled-file signature validation; raised defaults to 64 MB documents, 20 MB images, 30 images, 256 MB video, and 300 MB total.
- Added the confirmed derived-research reset/requeue operation, preserving raw Sources, uploaded files, source assets, and the persistent Docker volume.
- Completed Contract-aware Publish Composition so validated Frontend Page Payload order, Commercial overlay, presentation, SEO/GEO, JSON-LD, and media references are delivered through the Frontend CMS Article API; legacy Markdown/Gutenberg rendering remains fallback-only.
- Localized the Maintenance workspace and retained responsive multi-column mobile navigation with actionable menu badges.

## 1.13.2 — 2026-09-06

- Refresh Dashboard totals whenever an administrator changes sections, and temporarily poll every five seconds while background jobs are active so asynchronous planning and QA state becomes visible without a manual refresh.
- Count the Content Opportunity card from approved candidates that actually entered the production pipeline instead of all discovered candidates, making the approval transition immediately visible.
- Added the Content navigation action badge for briefs and drafts that require editorial intervention; backend dashboard counts and browser-rendered navigation now share the same actionable-state definition.

## 1.13.1 — 2026-09-06

- Fixed Vertex Gemini source extraction requests by translating shared Kimi/OpenAI text and image parts into the Vertex `text` and `inlineData` shapes instead of sending the unsupported `parts[].type` field.
- Added conservative structured-output cleanup plus one retry for malformed Vertex JSON, with an explicit token-limit error instead of an ambiguous parse failure.
- Made Entity Resolution fall back to the existing deterministic resolver only for recoverable model-output formatting failures, so Claims and Knowledge rebuilding continue without deleting or rewriting source evidence.
- Suppressed recovered historical job failures from the active Exceptions queue once a later job for the same entity and stage succeeds, while retaining the job records for audit history.

## 1.13.0 — 2026-09-06

- Added administrator video-file Sources with signature validation, persistent original evidence, schema migration 21, and direct Vertex Gemini frame/audio analysis for MP4, MOV, MPEG/MPG, WebM, AVI, WMV, FLV, and 3GP inputs.
- Raised the default video limit to 100 MB while keeping document and image limits unchanged. Videos up to the safe inline threshold are sent directly; larger files use an ephemeral Cloud Storage model-input object that is deleted after extraction while the authorized original remains in the persistent volume.
- Added explicit processing failures when the selected model lacks video input or large-video Cloud Storage staging is not configured, instead of silently treating a filename or operator note as decoded video evidence.

## 1.12.0 — 2026-09-05

- Added an administrator-only manual Source intake for public Xiaohongshu, WeChat, video, and ordinary web links, plus PDF, DOC/DOCX, and multi-image uploads; every accepted submission enters the existing extraction, Claim, Knowledge, Blueprint, and content-intake pipeline.
- Added direct public YouTube video/audio evidence input for the active Vertex Gemini model; other video platforms stay page-text/transcript-only and are labeled accordingly instead of being misrepresented as decoded video.
- Added persistent original-file evidence storage and schema migration 20 (`source_files`, Source type/submission metadata, and local multimodal asset paths) without weakening Claim/evidence retention.
- Added SSRF-safe public-link extraction and classified operator errors for authentication walls, bot protection, rate limits, timeouts, oversized/unsupported responses, parse failures, and empty content.
- Added Vertex AI Gemini 3.8 Flash (`gemini-3.8-flash`) as the default multimodal extraction, writing, and review model, using Google's supported global endpoint; the Gemini 3.1 Flash Image generation default is unchanged.
- Added live numbered action badges to the admin navigation for failed Sources, pending Recommendations, WordPress delivery/sync failures, open Commercial opportunities, operational Exceptions, failed maintenance/integration runs, and required AI/Contract configuration.
- Replaced the mobile horizontal navigation scroller with a touch-friendly three-column menu grid so every admin section is reachable without sideways swiping.

- Added schema migration 19 with extraction-run revisions and immutable superseded Claim snapshots, so re-extraction preserves the full structured Claim audit trail while Knowledge consumes only the active projection.
- Required atomic Claim extraction guidance, minimal proposition-specific source quotes, explicit negation/limiter retention, and canonical reservation booleans across Kimi and OpenAI extractors.
- Canonicalized reservation assertions such as `does not require reservation` and `requires reservation = no reservation required` to the same typed fact, eliminating false source conflicts without hiding true required/not-required contradictions.
- Reduced extraction-review noise from contrastive language and colloquial slogans, and evaluate sibling Claims sharing the same quote before reporting a missing negation or limiter.
- Added Claim roles and Knowledge eligibility: editorial metadata, personal experience, and non-durable promotional observations remain auditable evidence but do not enter destination Knowledge.
- Queued a one-time Knowledge/Claim Review recalculation for existing destinations after migration 19.

## 1.11.1 — 2026-09-03

- Fixed false `NEGATION_EXTRACTION_ERROR` reviews by evaluating the complete Claim semantics—predicate, value, qualifiers, and structured fields—instead of value text alone.
- Treats identical time evidence with richer descriptive wording as enrichment rather than a hard-fact source conflict.
- Replaced the misleading extraction-review acknowledgement with explicit “retry source extraction” and “meaning preserved / dismiss false positive” actions; extraction reviews can no longer be closed as resolved without re-extraction.
- Preserves explicit false-positive dismissals across Knowledge rebuilds, while reopening legacy extraction acknowledgements that never corrected the underlying Claim.
- Fixed source retry state so delayed jobs become immediately eligible, attempts are reset, queued sources display as queued, and an already-running extraction remains visibly processing instead of being overwritten as captured.

## 1.11.0 — 2026-09-03

- Added schema migration 18 with typed/granular Entity identity, Entity Relations, auditable/undoable merge history, structured Claim value/scope fields, Claim Relations, and categorized Claim review cases.
- Replaced value-string inequality conflict detection with coexistence-aware exact/paraphrase/refinement/enrichment/generalization/compatible/overlap/complement/conflict classification; original source sentences and normalized Claims remain visible for review.
- Added the canonical Affiliate Provider and Asset Registry, mappings, block-level Commercial Intent, decision-specific resolution/fallback, density guard, thresholded Opportunity queue, slots/compositions, impression/click events, commission metadata, and performance aggregation.
- Preserved `/api/commercial/offers` as a write-through compatibility adapter while moving runtime selection to `affiliate_assets`; Research, Knowledge, planning, drafts, QA, and Evidence Ledgers remain commercially isolated.
- Added safe structured Commercial Blocks for WordPress with disclosure and sponsored attributes, plus Frontend Contract capability-gap requests instead of a hand-maintained component list.
- Added compatibility with the Frontend repository's published `inputSchema` shape and excluded commercial capabilities from all pre-QA editorial component resolution.
- Activated immutable Content Production Strategy 1.3, updated operator/API documentation, and expanded automated Entity, Claim, Commercial, Contract, WordPress, server, migration, and release coverage.

## 1.5.0 — 2026-08-28

- Added the governed **SoloToChina Content Production Strategy 1.0** manifest, immutable specification, upgrade guide, handoff document, system API metadata, and release-drift checks.
- Added strategy-versioned Intake Analysis, content recommendations, and evidence-based content opportunities. Kimi now recommends a next action; only an explicit **Approve article** decision queues planning.
- Added versioned Canonical Travel Content, structured content blocks, answer-first SEO/GEO fields, deterministic WebPage/Article/Breadcrumb/Organization/ImageObject schema, and WordPress strategy metadata.
- Added safe image taxonomy and acquisition rules: only non-factual editorial illustrations can enter automatic image generation; real-world photos, maps, and factual graphics are never fabricated.
- Made `kimi-k2.7-code` the default Kimi model for new installations while retaining Kimi K3 as an explicit Settings choice.
- Added schema migration 12 plus strategy, human-approval, image-safety, API, and release coverage.

## 1.4.0 — 2026-08-28

- Switched the active AI provider to Kimi Chat Completions with JSON Schema structured output and trusted Xiaohongshu image-to-base64 vision input.
- Added persistent dashboard selection for Kimi K3 and Kimi K2.7 Code, with the active model exposed in the operator status badge.
- Added SEO/GEO output metadata, visible key takeaways and FAQs, `Article` / `FAQPage` JSON-LD, and deterministic output gates.
- Added 2--5 original editorial visual plans per Draft, optional Google Vertex Imagen rendering, media serving, and WordPress media upload/placement.
- Added GCE + Cloudflare Tunnel deployment assets, a capture-only Cloudflare hostname boundary, and an origin-pinned cloud extension packaging command.
- Added an isolated, Windows-compatible `npm run release:check` gate: production build, static checks, tests, temporary SQLite migrations and writes, temporary server/API/UI smoke checks, log scanning, cleanup verification, and Chrome extension static validation.
- Corrected unknown API `GET` routes so they return a JSON `404` instead of the single-page-app HTML fallback.

## 1.3.0 — 2026-08-25

- Migrated the dashboard from the legacy static UI to React, Vite, Tailwind CSS, Lucide React, and source-owned shadcn/ui primitives while preserving the single-process deployment model.
- Rebuilt all eight operational views with responsive metric cards, pill navigation, accessible dialogs, actionable empty states, and desktop/mobile layouts.
- Added a production frontend build to startup and release checks, with Vite proxy support for local UI development.
- Added automatic read-only Google Search Console query/page inventory with service-account authentication, durable scheduling, and reversible query-level topic cannibalization protection.
- Added schema migration 8 for Search Console performance inventory without mixing performance data into the Research Knowledge Base.
- Added native Gutenberg block output plus optional WordPress featured-media, template, and REST-exposed SEO meta mappings while preserving draft-only delivery.
- Expanded the release suite to 34 tests and documented environment-only secret rotation and deployment boundaries.

## 1.2.0 — 2026-08-24

- Redesigned the complete dashboard with a clean Apple-inspired visual system, compact pipeline metrics, responsive navigation, richer empty/loading states, keyboard interaction, and mobile layouts.
- Added durable Job start/completion timestamps, queue latency, end-to-end duration, rolling success rates, and per-type p95 performance telemetry.
- Added structured JSON/pretty stdout logs for HTTP requests, Pipeline jobs, maintenance tasks, startup, and shutdown, with safe request ID propagation.
- Added `GET /api/ready` for database-backed deployment readiness.
- Added optional HTTPS exception webhooks with severity filtering, Bearer authentication, persistent fingerprints, change detection, repeat reminders, failure retry, and automatic resolved-state cleanup.
- Added Maintenance UI operational health cards and detailed rolling Job performance.
- Added non-destructive `npm run backup:drill` restore exercises against an isolated temporary database.
- Added schema migration 7 and expanded the release suite to 29 tests.

## 1.1.0 — 2026-08-23

- Added a durable maintenance scheduler for continuously running installations.
- Periodically refreshes WordPress inventory and recalculates Knowledge freshness without requiring a restart.
- Creates consistent, verified SQLite backups automatically with the existing retention policy.
- Prunes only expired successful Job history; failed Jobs remain visible for intervention.
- Added maintenance run history, failure projection into Exceptions, admin-triggered Run now, and a Maintenance dashboard view.
- Background workers now start only after the HTTP bind succeeds, preventing duplicate maintenance from a failed second process.
- Added schema migration 6 and aligned package, API, and Chrome extension versions.

## 1.0.0 — 2026-08-23

- Manual, explicit-click Xiaohongshu Chrome capture with no crawler behavior.
- Durable raw evidence, multimodal extraction, Claims, Source Blueprints, Destination KB, and Editorial Blueprint aggregation.
- Evidence-gated topic planning, original English drafting, independent QA, and one automatic revision.
- Time-sensitive and stale-evidence classification with deterministic publication gates.
- Read-only WordPress inventory sync and topic cannibalization suppression.
- WordPress draft-only delivery with overwrite protection and optional author/category/tag mapping.
- Strictly isolated typed Commercial Layer and deterministic affiliate disclosure.
- Unified operational exception queue with protected retry actions.
- Consistent SQLite backups, integrity verification, checksums, and retention.
- Loopback-safe defaults, admin/capture token separation, security headers, and non-loopback startup guard.
