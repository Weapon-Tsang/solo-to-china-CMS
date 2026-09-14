# CMS 2.0.21 WordPress inline-content and final-preview acceptance

Date: 2026-09-14  
App/Extension: 2.0.21  
Schema: 69 (no migration)  
Content Strategy: 3.3  
Production state: 1.8  
Frontend Contract: 1.4.0

## Production-only failure found

The 2.0.20 canary successfully rebuilt `itinerary` as `travel-guide`, then WordPress rejected block 5 at `page.blocks[5].data.content` with `INVALID_COMPONENT_DATA`. The text contained a safe apostrophe encoded as `&#39;`. The deployed theme compares sanitized inline HTML to the input byte-for-byte; WordPress canonicalizes that entity as `&#039;`, so the generic local HTML validator had accepted a representation that the remote sanitizer rewrote and rejected. No WordPress post was created.

## Repair

Version 2.0.21 canonicalizes this sanitizer-stable entity in deterministic composition, model output and retained Publish Package rebuilding. It adds a local negative regression for `&#39;`, a positive regression for `&#039;`, and routes the remote failure to `compose_publish_page`. Rendered prose, evidence, SEO/GEO semantics and Frontend rendering ownership remain unchanged.

## Acceptance status

The final section will record the immutable build and rollout, targeted recovery, WordPress Draft status/ID, preview and edit URLs, desktop/mobile page inspection, technical SEO/GEO checks and post-fix production audit. Acceptance must not publish the post.
