# CMS 2.0.20 WordPress taxonomy and final-preview acceptance

Date: 2026-09-14  
App/Extension: 2.0.20  
Schema: 69 (no migration)  
Content Strategy: 3.3  
Production state: 1.7  
Frontend Contract: 1.4.0

## Production-only failure found

A bounded production canary reused the successful first ten stages of `The Feasible 3-Day Chongqing Route: Pacing, Taxis, and Vertical Navigation`. Recomposition completed and the durable pipeline advanced to WordPress delivery. The deployed WordPress endpoint rejected the package before creating a post with `INVALID_PAGE_SCHEMA: The content type is not supported by the current Content Contract.`

The package carried the CMS-internal value `itinerary`. The fixed Frontend repository revision exposes four public guide types in the WordPress theme (`survival-kit`, `city-guide`, `attraction-guide`, and `travel-guide`), but its generic Page JSON Schema represents `contentType` only as a string. The prior mock therefore proved schema shape and idempotency but could not reproduce this theme-level taxonomy check.

## Repair and permanent regression

Version 2.0.20 introduces one shared delivery taxonomy, applies it to deterministic page composition, model page output and retained-page Publish Package rebuilding, and adds the missing local business invariant. Unsupported unknown types are rejected locally. A matching WordPress delivery failure resolves to `compose_publish_page`, preserving every successful writing, evidence, QA, media and commercial artifact.

## Acceptance status

The final section will record the immutable build, production rollout, targeted recovery, WordPress Draft ID/status, persisted preview/edit URLs, desktop/mobile final-page inspection, SEO/GEO checks and post-fix production audit. No post may be published during this acceptance.
