# Project handoff

## Active Content Strategy

- **Active strategy:** SoloToChina Content Production Strategy 1.5
- **Canonical manifest:** `config/content-strategy.json`
- **Specification:** `docs/content-strategy/CONTENT_PRODUCTION_STRATEGY_1.5.md`
- **Evolution log:** `docs/content-strategy/CHANGELOG.md` and the manifest `history` entries
- **Status:** implemented incrementally on the existing durable SQLite pipeline; legacy records intentionally have no retroactive strategy tag.

Any future maintainer, agent, or developer must read the active manifest and linked strategy specification before changing intake, recommendations, content planning, image behaviour, QA, or publishing.

## Frontend capability contract

- **CMS integration specification:** `docs/FRONTEND_CONTRACT_INTEGRATION.md`
- **Owner of component capability:** the separate Frontend repository, through its published machine-readable Component Registry and Page Schema
- **CMS role:** synchronized Contract consumer, editorial composer, payload producer, and pre-publish validator
- **Current safety state:** Frontend Contract `1.1.0` publishes the generated Component Registry, Page Schema, Publish Package Schema, and the authenticated draft-only CMS Article API. Contract-aware installations synchronize the deployed artifacts; installations with no Contract sources retain the legacy Markdown/WordPress fallback.

Future maintainers must not scan Frontend JSX/CSS, duplicate a component list in this repository, or hardcode component IDs into AI prompts. Read the Frontend Contract Integration document before changing Contract sync, composition, or publishing gates.

Affiliate components follow the same rule. The CMS may request semantic capabilities such as `affiliate_booking_card`, `affiliate_search_card`, or `affiliate_banner`, but only the Frontend's published Contract makes one available. A missing component creates a durable capability request; it is never simulated by hardcoded CMS presentation code.

The audited Frontend Registry provides the QA-selected booking, search, banner, and promotion components. The pre-QA CMS Page Composer still excludes all commercial and `affiliate_*` capabilities; only the post-QA deterministic overlay may insert them into the final validated Page Payload.

## Entity and Claim resolution

- **Lifecycle specification:** `docs/CLAIM_KNOWLEDGE_LIFECYCLE.md`
- Migration 18 adds Entity type/granularity/location fields, typed Entity Relations, auditable merge history with undo, structured Claim values/scopes, Claim Relations, and categorized Claim review cases.
- Migration 19 versions extraction runs, archives superseded Claim snapshots, records Claim role/Knowledge eligibility, and schedules a one-time recalculation of historical Claim Review cases.
- Identity merges require compatible type, geography, granularity, canonical identity, and alias plausibility. Obvious collection/specific or claim-like mismatches never enter manual review.
- Knowledge aggregation no longer treats different value strings as a conflict. It persists enrichment/refinement/overlap/compatibility, canonicalizes reservation booleans, treats compatible positive view/scenery/appearance/lighting/vegetation/amenity descriptions as enrichment, and reviews only mutually incompatible claims or uncovered extraction errors. Procedural “只需要” wording is not an exclusivity limit, and contactless satisfies “0 打扰” semantics.
- Remaining manual-review cards state in plain Chinese what the system compared, why it stopped, what each option means, and which value later content will use. False-positive dismissal keeps both Claims and all evidence; final-value selection changes the active Knowledge conclusion without deleting provenance.
- Editorial metadata and personal experiences remain auditable Claims but are not eligible for destination Knowledge. Re-extraction preserves old Claim revisions as immutable history instead of erasing their audit trail.
- Claims, original quotes, Sources, evidence, and provenance are retained through extraction revisions, merge, rejection, relation creation, conflict resolution, and undo.

## Commercial Phase 1

- `affiliate_assets` is the canonical runtime inventory. The old `/api/commercial/offers` endpoint remains a compatibility adapter and writes through to the new model.
- Provider, Asset, mapping, opportunity, performance, and event APIs live under `/api/commercial/*`; the dashboard's Commercial view reads `/api/commercial`.
- `affiliate_asset_queue_tasks` closes the manual Trip.com setup loop. Tasks come only from `config/affiliate-queue-seeds.json` or qualifying HIGH/VERY_HIGH Affiliate Opportunities; `task_key` and `trip_sub1` are durable and unique.
- Queue completion validates an exact operator-pasted official URL, creates one canonical `affiliate_assets` row, links the original Opportunity, and then uses the existing Composer/Event/Performance path. CSV/JSON import is row-isolated and supports dry-run.
- The composer runs after QA, derives block intent, selects decision-appropriate precision, falls back silently, enforces density, and stores an independent Overlay. Research packages never read these tables.
- WordPress receives generated safe commercial blocks with disclosure and sponsored link attributes. Arbitrary HTML/script is rejected.
- App/Extension version `1.17.6` and schema migration `35` are the expected local implementation baseline. Migration 35 adds immutable lossless Capture snapshots, complete rights/provenance manifests, Source/Asset provenance, race-safe capture/job identity, and Favorites Sync aggregate telemetry while preserving prior data. Queue scheduling prioritizes extraction finalization, targeted retries, and coverage audits so a large segment backlog cannot indefinitely hide completed work. The Sources API and UI expose each note's current extraction stage, active/remaining job counts, source-level queue position, cooldown deadline, and provider-pressure error. Feature claims now treat translated or progressively detailed positive descriptions as compatible evidence, and dismissed false-positive reviews remain dismissed after Knowledge rebuilds. A Source remains in processing state until all of its segments reach a terminal coverage state; any segment that still has an audited gap can be retried individually or explicitly confirmed as non-material, with the operator decision retained in its audit JSON.
- HTTPS Frontend Contract synchronization versions all three source URLs with the exact deployed frontend commit, preventing a CDN edge from returning the previous Registry/Page/Publish artifact immediately after deployment.

Trip.com remains manual-only: an operator must create official links/embed configuration in the official platform and paste only those public artifacts into the Queue/Registry. Do not store credentials/cookies, automate dashboard login, crawl the affiliate dashboard, invent tracking parameters, or create low-value entity links at scale. See `docs/AFFILIATE_ASSET_QUEUE.md` for the operator workflow and provider-dependent limits.

Deferred Phase 2: official API/feed integration when available, report import, automatic provider-side Sub ID insertion, EPC/RPM learning, A/B testing, promotion-aware ranking, and learned component optimization.

## Current operating boundary

Source discovery and selection stay human-led. A user favorite is the Research selection step; the Chrome Extension incrementally discovers that chosen collection and captures detail pages through the signed-in browser, with explicit single-note Save retained as fallback. It never receives credentials/cookies or bypasses verification. The engine stores complete raw evidence, creates traceable structured claims, asks for a human decision before article planning, sends only validated drafts to WordPress, and never publishes a post itself.

The Sources dashboard also accepts explicit administrator submissions: public Xiaohongshu, WeChat, video, and ordinary web links; PDF/DOC/DOCX files; one or more images; and a single video file up to 256 MB. Browser video uploads use resumable 5 MB application chunks with visible progress. These inputs become immutable Source evidence and enter Strategy 1.4 preflight, segmentation, exhaustive extraction, coverage audit, Knowledge, Opportunity, and content production. Uploaded originals live under `SOURCE_UPLOADS_DIR`, which must remain inside the persistent Docker volume.

## Admin model and action navigation

- The default text/image-understanding model is Vertex AI Gemini 3.8 Flash (`gemini-3.8-flash`) at the `global` location. Explicit model choices saved from Settings remain operator-owned and are not overwritten during upgrade.
- Image generation remains a separate pipeline whose default is Gemini 3.1 Flash Image (`gemini-3.1-flash-image`). Never route factual image generation through the text/writing model.
- `/api/dashboard` returns `actionCounts` for menu badges. Counts represent records with a real operator action: failed Sources, pending Recommendations, WordPress delivery/sync failures, open Commercial opportunities, all operational Exceptions, failed maintenance/integration runs, and required AI/Contract configuration.
- The mobile admin navigation is a three-column grid. Do not reintroduce a horizontally scrolling tab list on phone breakpoints.
