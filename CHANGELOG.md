# Changelog

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
