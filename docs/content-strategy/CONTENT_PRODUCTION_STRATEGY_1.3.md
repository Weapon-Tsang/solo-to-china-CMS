# SoloToChina Content Production Strategy 1.3

## Overview

SoloToChina turns explicitly human-selected China-travel sources into original, evidence-bounded English content for independent international visitors. Strategy 1.3 succeeds Strategy 1.2 without rewriting it. Earlier specifications remain immutable records, while new downstream records carry the active `1.3` provenance.

The production path remains: human capture → traceable Claims → normalized entities and Knowledge → one recommended editorial action → explicit article approval → evidence-bounded draft → independent QA → optional Commercial Overlay → WordPress draft. No stage may auto-publish.

## Non-negotiable boundaries

- Research, Knowledge, intake analysis, topic planning, drafting, and QA never read affiliate assets, commissions, events, or opportunities.
- Commercial composition runs only after a Research Draft passes QA and never mutates that draft or its Evidence Ledger.
- When no relevant active asset exists, commercial composition is a strict no-op.
- WordPress only creates or updates drafts and refuses to overwrite a human-published post.
- Source Claims, quotes, provenance, and authorized source assets are never deleted by entity normalization or conflict resolution.

## Entity identity, relatedness, and facts

Entity identity asks whether two names denote the same real-world object. Semantic relatedness, shared topic, shared location, shared category, and cross-language similarity are not identity evidence by themselves. Merge solves identity; Entity Relations solve relatedness; Claims store facts and judgments.

Every normalized entity records an `entity_type`, `granularity`, optional geographic identity, canonical name, and aliases. Automatic or human merge must pass type, geography, granularity, canonical-identity, and alias-plausibility constraints. A specific attraction is not a collection; a hotel is not a hotel category; a city is not a district; a route is not a destination. Obvious mismatches are automatically kept separate and do not create operator work.

Related non-identical objects use typed relations such as `member_of`, `part_of`, `located_in`, `applies_to`, `related_to`, `supports`, `contradicts`, `generalizes`, `specializes`, `derived_from`, or `example_of`. Every accepted merge stores its source entity IDs, operator, timestamp, AI recommendation/confidence, reason, and before/after snapshot. Undo restores the previous aliases and Claim entity fields without deleting evidence.

## Claim structure and compatibility

Different wording is not a conflict. More detailed information usually enriches a Claim. A conflict exists only when two propositions cannot both be true under compatible scope, time, conditions, visitor type, season, and ticket type.

Claim values are separated into primary value, qualifiers/rationale, and structured scope. Relations are classified as `EXACT_MATCH`, `PARAPHRASE`, `REFINEMENT`, `ENRICHMENT`, `GENERALIZATION`, `COMPATIBLE`, `OVERLAPPING`, `COMPLEMENTARY`, `CONFLICT`, or `UNCERTAIN`. Compatible relations are persisted automatically and do not enter the exception queue.

Opening times, ticket prices, reservation requirements, addresses, stations, and schedules use strict hard-fact rules. Visit-time suggestions, suitability, photography advice, recommendations, and worth-visiting judgments are soft, multi-value, or context-dependent. Source negation or limiting words lost during extraction create an Extraction Error review rather than a false source conflict.

## Focused operator review

The exception workspace separates Entity Identity, Claim Conflict, Relation, Source Conflict, Temporal Conflict, Granularity Conflict, and Extraction Error. Review cards show original source sentences alongside normalized Claims. Enrichment, refinement, compatible recommendations, obvious granularity differences, normal affiliate fallback, and low-value missing deep links never create manual work.

## Commercial intent and affiliate assets

Affiliate Provider Accounts contain configuration metadata only. V1 uses `MANUAL`; it never stores provider credentials, cookies, or login state and never logs in to or crawls an affiliate dashboard. Official links are stored without inventing or changing tracking parameters.

Affiliate Assets separate presentation type (`DEEP_LINK`, `CATEGORY_LINK`, `SEARCH_BOX`, `STATIC_BANNER`, `DYNAMIC_BANNER`, `PROMOTION`) from product category (`HOTEL`, `FLIGHT`, `TRAIN`, `ATTRACTION`, `TOUR_ACTIVITY`, `FLIGHT_HOTEL`, `CAR_RENTAL`, `AIRPORT_TRANSFER`, `PLANNER`). Search and banner configuration is structured, domain-allowlisted data; arbitrary HTML and script are rejected.

The Commercial Composer derives block-level intent after QA, resolves an existing asset at the precision appropriate to the user's decision, and applies density limits. Destination/category assets are the default. Area, route, and major-attraction assets are selective. Specific hotel/product links are exceptional. Missing precision silently falls back unless a high intent, high value, reusable opportunity exceeds the manual-work threshold.

Commercial specificity follows user decision specificity, not maximum technical specificity. The target is the right product × intent × placement × component × landing-page precision—not more links.

## Rendering, measurement, and frontend contracts

Commercial blocks are generated outside the Research Draft. WordPress renders only known server-side components, credential-free HTTPS links, allowlisted structured embeds, disclosure, and `rel="sponsored nofollow noopener"`. Arbitrary scripts are never injected.

Impression and click events record article/draft, asset, provider, category, slot, component, placement, entity/route/destination, device, locale, timestamp, and strategy version. Booking and commission events are reserved for later official attribution. Commission metadata is maintainable commercial data and never changes research conclusions.

The CMS consumes affiliate component capabilities from the published Frontend Contract. It never keeps a hand-written copy of the frontend component registry. Missing `affiliate_booking_card`, `affiliate_search_card`, `affiliate_banner`, or other selected capabilities create a `frontend_capability_request`; WordPress may retain its independently validated safe fallback.

## Authorized source images and reader trust

The Strategy 1.2 authorization boundary remains active: images from explicitly human-selected and saved Xiaohongshu sources may be used when linked to article evidence, with source traceability. They do not establish unsupported facts. Deterministic maps/infographics and non-factual original illustrations remain fallbacks.

Every new intake, recommendation, opportunity, brief, draft, QA review, visual, Commercial Composition, event, and WordPress draft retains Strategy `1.3` provenance where applicable. Upgrades do not relabel historical records. Future changes require a new immutable strategy document, manifest entry, automated coverage, handoff updates, and a passing release check.

## Deferred Phase 2

Official Trip.com API/feed integration, commission report import, booking attribution, official Sub ID automation, EPC/RPM optimization, A/B testing, learned commercial scoring, automated component optimization, and promotion-aware ranking remain explicitly deferred until official capability and account access are available.
