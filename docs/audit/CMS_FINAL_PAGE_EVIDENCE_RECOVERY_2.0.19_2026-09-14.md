# CMS 2.0.19 final-page and WordPress-draft verification

Date: 2026-09-14  
Change class: DATABASE_LOGIC / PIPELINE / AI_PROVIDER  
Release type: CODE_ONLY_RELEASE  
Schema: 69 (unchanged)  
Content Strategy: 3.3 (unchanged)  
Production state: 1.6  
Frontend Contract: 1.4.0 (unchanged)

## Production baseline and isolation

The source database was copied read-only from production and every replay wrote only to disposable local databases. The canaries refuse filenames that do not contain `canary`, `replay`, or `work`. Real WordPress, image generation, Batch, production deployment and publication were disabled during pre-release replay.

Protected baseline counts were Sources 74, Source assets 1,318, Claims 5,147, Evidence spans 8,292, Knowledge facts 4,270, Experience blocks 518 and approved Opportunities 7. The final checks retained every count. Failure Lessons were allowed only to increase.

## Defects found by the real flow

1. A stale Page Payload could let a review artifact represent different visible content. Page composition is now a QA input and any changed page invalidates review reuse.
2. Section-level evidence inherited unrelated facts from the parent outline. Atomic blocks now receive only the Claims their visible text asserts; phantom and unmatched legacy ledger nodes are removed.
3. Current evidence variants and generic workflow qualifiers produced false final-page failures. Evidence comparison now protects meaningful values, conditions, dates and policies while allowing equivalent surface forms.
4. Vertex Draft output needed exact frozen fact and section enums. Provider output remains strictly validated locally and cannot introduce unfrozen facts or attach facts to the wrong planned section.
5. Legacy H3-only articles allowed bounded repair to replace one H2 parent and accidentally consume later sections. Planned headings are normalized to H2 before repair boundaries are calculated; the title H1 is removed, and heading jumps are corrected.
6. A provider review with warnings but no blockers could still return `passed=false`. Backend success now depends on the explicit blocker set, and the review prompt requires warning-only results to pass.
7. Historical Drafts already truncated by the old repair path had no accurate recovery instruction. `production_state` 1.6 detects the missing planned-section ratio and targets `generate_draft` from the retained Writing Packet.

## Real Provider replay

Five approved production flows representing metro navigation, neighborhood food, landmark routing, Hongyadong and a two-day itinerary were recovered on the production-copy database with Vertex concurrency 1, Batch disabled, image generation disabled and a bounded call cap. All five reached current QA plus Commercial Composition without a structured-request HTTP 400.

The final two-flow run used eight recorded provider attempts: one `article_draft_v2`, two bounded repairs including one transient HTTP 429 followed by success, and four successful `quality_review_v2` calls. Both records finished with no active Job and no current error. The historically truncated 48-hour itinerary recovered through `generate_draft`; the walking itinerary reused its existing Draft and resumed at review. The transient 429 exercised the existing finite retry/backoff path and did not restart upstream work.

## Final page and WordPress draft contract

The completed 48-hour itinerary continued through `compose_publish_page` and `push_wordpress_draft` against a local draft-only WordPress endpoint. The endpoint rejected any status other than `draft` and recorded exactly one authenticated, idempotency-keyed POST.

- Publish Package: 15,451 bytes
- Semantic page blocks: 45
- Contract: 1.4.0
- Contract validation errors: 0
- Final artifact/evidence errors: 0
- JSX/CSS/inline-style boundary violations: 0
- Stored preview URL: yes
- Stored edit URL: yes
- Final state: succeeded, 12 completed stages, no automatic continuation
- Remote publication: no

The CMS validates semantic structure, evidence, SEO/GEO fields, JSON-LD, media/link safety and responsive heading hierarchy. It does not copy, synthesize or render Frontend JSX/CSS. Final visual acceptance remains the responsibility of the real WordPress preview returned by the Frontend endpoint.

## Test status before release

- L1 Targeted Tests: PASS (production state, content recovery, model policy, evidence and repair regressions)
- L2 Module Regression: PASS
- L3 Production DB Replay: PASS
- L4 Browser E2E: pending production rollout
- L5 Real Provider Canary: PASS
- L6 Full Production-Like Replay: PASS through final Page Payload and a draft-only WordPress contract endpoint
- `npm test`: PASS, 591/591
- `npm run check`: PASS, including Vite production build and service-boundary checks
- `npm run release:check`: PASS, 50 mandatory checks, zero failures, five warnings and five explicitly external/not-tested checks
- Post-Fix Exploratory Audit: PASS on the disposable production copy; no active orphaned production Jobs and no protected-count loss

## Release and production acceptance

To be completed after immutable-image deployment. Production acceptance must create a WordPress **draft only**, inspect the returned final `preview_url` at desktop and mobile widths, retain `edit_url`, and must not publish a post.
