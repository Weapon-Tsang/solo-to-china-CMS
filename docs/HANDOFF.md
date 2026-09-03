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

- Migration 18 adds Entity type/granularity/location fields, typed Entity Relations, auditable merge history with undo, structured Claim values/scopes, Claim Relations, and categorized Claim review cases.
- Identity merges require compatible type, geography, granularity, canonical identity, and alias plausibility. Obvious collection/specific or claim-like mismatches never enter manual review.
- Knowledge aggregation no longer treats different value strings as a conflict. It persists enrichment/refinement/overlap/compatibility and reviews only mutually incompatible claims or extraction errors.
- Claims, original quotes, Sources, evidence, and provenance are retained through merge, rejection, relation creation, conflict resolution, and undo.

## Commercial Phase 1

- `affiliate_assets` is the canonical runtime inventory. The old `/api/commercial/offers` endpoint remains a compatibility adapter and writes through to the new model.
- Provider, Asset, mapping, opportunity, performance, and event APIs live under `/api/commercial/*`; the dashboard's Commercial view reads `/api/commercial`.
- The composer runs after QA, derives block intent, selects decision-appropriate precision, falls back silently, enforces density, and stores an independent Overlay. Research packages never read these tables.
- WordPress receives generated safe commercial blocks with disclosure and sponsored link attributes. Arbitrary HTML/script is rejected.
- App version `1.11.0` and schema migration `18` are the expected post-upgrade baseline.

Trip.com remains manual-only: an operator must create official links/embed configuration in the official platform and paste only those public artifacts into the registry. Do not store credentials/cookies, automate dashboard login, crawl the affiliate dashboard, invent tracking parameters, or create low-value entity links at scale.

Deferred Phase 2: official API/feed integration when available, report import, booking/commission attribution, official Sub ID automation, EPC/RPM learning, A/B testing, promotion-aware ranking, and learned component optimization.

## Current operating boundary

Source discovery stays human-led. The Chrome extension only captures a note the user has opened and explicitly saved. The engine stores raw evidence, creates traceable structured claims, asks for a human decision before article planning, sends only validated drafts to WordPress, and never publishes a post itself.
