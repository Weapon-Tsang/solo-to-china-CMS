# Project handoff

## Active Content Strategy

- **Active strategy:** SoloToChina Content Production Strategy 1.3
- **Canonical manifest:** `config/content-strategy.json`
- **Specification:** `docs/content-strategy/CONTENT_PRODUCTION_STRATEGY_1.3.md`
- **Evolution log:** `docs/content-strategy/CHANGELOG.md` and the manifest `history` entries
- **Status:** implemented incrementally on the existing durable SQLite pipeline; legacy records intentionally have no retroactive strategy tag.

Any future maintainer, agent, or developer must read the active manifest and linked strategy specification before changing intake, recommendations, content planning, image behaviour, QA, or publishing.

## Frontend capability contract

- **CMS integration specification:** `docs/FRONTEND_CONTRACT_INTEGRATION.md`
- **Owner of component capability:** the separate Frontend repository, through its published machine-readable Component Registry and Page Schema
- **CMS role:** synchronized Contract consumer, editorial composer, payload producer, and pre-publish validator
- **Current safety state:** Frontend commit `210d0fe` publishes generated CMS artifacts at `contracts/component-registry.json` and `contracts/page-schema.json`. Production remains unconfigured until those reviewed artifacts are deployed and synchronized successfully; the legacy Markdown/WordPress path remains compatible.

Future maintainers must not scan Frontend JSX/CSS, duplicate a component list in this repository, or hardcode component IDs into AI prompts. Read the Frontend Contract Integration document before changing Contract sync, composition, or publishing gates.

Affiliate components follow the same rule. The CMS may request semantic capabilities such as `affiliate_booking_card`, `affiliate_search_card`, or `affiliate_banner`, but only the Frontend's published Contract makes one available. A missing component creates a durable capability request; it is never simulated by hardcoded CMS presentation code.

The audited Frontend Registry currently provides only the generic `affiliate_cta`. Dedicated booking/search/banner/promotion components, tracking metadata, and browser-side event dispatch still belong in the Frontend repository. The pre-QA CMS Page Composer explicitly excludes all commercial and `affiliate_*` capabilities.

## Entity and Claim resolution

- **Lifecycle specification:** `docs/CLAIM_KNOWLEDGE_LIFECYCLE.md`
- Migration 18 adds Entity type/granularity/location fields, typed Entity Relations, auditable merge history with undo, structured Claim values/scopes, Claim Relations, and categorized Claim review cases.
- Migration 19 versions extraction runs, archives superseded Claim snapshots, records Claim role/Knowledge eligibility, and schedules a one-time recalculation of historical Claim Review cases.
- Identity merges require compatible type, geography, granularity, canonical identity, and alias plausibility. Obvious collection/specific or claim-like mismatches never enter manual review.
- Knowledge aggregation no longer treats different value strings as a conflict. It persists enrichment/refinement/overlap/compatibility, canonicalizes reservation booleans, and reviews only mutually incompatible claims or uncovered extraction errors.
- Editorial metadata and personal experiences remain auditable Claims but are not eligible for destination Knowledge. Re-extraction preserves old Claim revisions as immutable history instead of erasing their audit trail.
- Claims, original quotes, Sources, evidence, and provenance are retained through extraction revisions, merge, rejection, relation creation, conflict resolution, and undo.

## Commercial Phase 1

- `affiliate_assets` is the canonical runtime inventory. The old `/api/commercial/offers` endpoint remains a compatibility adapter and writes through to the new model.
- Provider, Asset, mapping, opportunity, performance, and event APIs live under `/api/commercial/*`; the dashboard's Commercial view reads `/api/commercial`.
- The composer runs after QA, derives block intent, selects decision-appropriate precision, falls back silently, enforces density, and stores an independent Overlay. Research packages never read these tables.
- WordPress receives generated safe commercial blocks with disclosure and sponsored link attributes. Arbitrary HTML/script is rejected.
- App version `1.13.1` and schema migration `21` are the expected post-upgrade baseline.

Trip.com remains manual-only: an operator must create official links/embed configuration in the official platform and paste only those public artifacts into the registry. Do not store credentials/cookies, automate dashboard login, crawl the affiliate dashboard, invent tracking parameters, or create low-value entity links at scale.

Deferred Phase 2: official API/feed integration when available, report import, booking/commission attribution, official Sub ID automation, EPC/RPM learning, A/B testing, promotion-aware ranking, and learned component optimization.

## Current operating boundary

Source discovery stays human-led. The Chrome extension only captures a note the user has opened and explicitly saved. The engine stores raw evidence, creates traceable structured claims, asks for a human decision before article planning, sends only validated drafts to WordPress, and never publishes a post itself.

The Sources dashboard also accepts explicit administrator submissions: public Xiaohongshu, WeChat, video, and ordinary web links; PDF/DOC/DOCX files; one or more images; and a single video file up to 100 MB. These inputs become the same immutable Source evidence and use the existing extraction, Claim, Knowledge, Blueprint, and content-intake pipeline. Uploaded originals live under `SOURCE_UPLOADS_DIR`, which must remain inside the persistent Docker volume. Video files use Vertex Gemini frame/audio analysis; files above the inline threshold require ephemeral `MANUAL_SOURCE_GCS_BUCKET` staging. Public-link fetching carries no cookies or credentials, rejects private/reserved network destinations, and returns classified operator-facing errors for login walls, bot protection, rate limits, timeouts, unsupported responses, and empty content.

## Admin model and action navigation

- The default text/image-understanding model is Vertex AI Gemini 3.8 Flash (`gemini-3.8-flash`) at the `global` location. Explicit model choices saved from Settings remain operator-owned and are not overwritten during upgrade.
- Image generation remains a separate pipeline whose default is Gemini 3.1 Flash Image (`gemini-3.1-flash-image`). Never route factual image generation through the text/writing model.
- `/api/dashboard` returns `actionCounts` for menu badges. Counts represent records with a real operator action: failed Sources, pending Recommendations, WordPress delivery/sync failures, open Commercial opportunities, all operational Exceptions, failed maintenance/integration runs, and required AI/Contract configuration.
- The mobile admin navigation is a three-column grid. Do not reintroduce a horizontally scrolling tab list on phone breakpoints.
