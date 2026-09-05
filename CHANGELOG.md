# Changelog

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
