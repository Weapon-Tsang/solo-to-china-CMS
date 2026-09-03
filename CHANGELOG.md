# Changelog

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
