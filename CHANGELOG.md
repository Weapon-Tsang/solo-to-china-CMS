# Changelog

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
