# CMS 2.0.11 Opportunity qualification audit — 2026-09-13

## Scope and production baseline

This audit started from repository revision `f3c06052c21dacf1a414f14d839797655c073347` and the production App 2.0.10 database at schema 67 and Content Strategy 3.3. The production Inbox contained 484 actionable opportunities: 243 Source-backed paths and 241 Knowledge-derived opportunities. All 74 Sources were complete and current, and the active job queue was empty.

The audit was read-only against production. Every candidate correction was first applied to a SQLite `VACUUM INTO` copy. It checked Source completion and current capture versions, strategy versions, lifecycle and recommendation class, selected evidence, Source-family independence, coverage/readiness consistency, SEO action, canonical intent keys, same-Source and entity duplicates, topic keys, and migration references.

## Findings

The original 484 were not all correctly represented as distinct, correctly typed opportunities.

- No actionable row used an old strategy, unfinished Source evidence, a processing-gap state, a forbidden lifecycle/status, a skipped SEO action or an invalid recommendation class. Readiness values stayed in 0-100 and matched their JSON. Database integrity was `ok`, with zero foreign-key or migration-reference violations.
- Exact title/type/mode duplicates, duplicate topic keys and identical canonical keys were zero. The absence of exact duplicates masked semantic duplicates.
- Eight of the 243 Source-backed paths described the same intent as another path from the same Source, with the same destination, content type, publication mode and compatible duration. Different modes and materially different promises remained distinct.
- Knowledge clustering split bilingual aliases and alternate canonical subjects. The production baseline contained 38 same-destination duplicate dominant-entity groups covering 69 redundant Knowledge rows.
- Nine Knowledge rows over-counted independent support because completed-Source filtering discarded stored Source-family membership and rebuilt independence from Source IDs. All nine still met the two-family threshold after correction, but their stored readiness was wrong.
- Content type inference scanned all supporting predicates with substring patterns. This allowed incidental text to override the topic; the substring `eat` also matched `creative`, `great` and `weather`. A baseline dominant-entity audit flagged 149 of 241 Knowledge rows for type review.
- Context-free subjects such as `venue`, `hotpot restaurant`, `pathway`, `featured restaurant` and `Day 3 itinerary` could pass solely by having two facts from two families. English and Chinese destination names could also split into parallel city clusters.
- Coverage refresh could widen a Knowledge opportunity by matching title tokens across the whole destination rather than preserving its selected cluster facts.

## Correction

Knowledge clusters now union facts by canonical entity identity or normalized canonical subject, including known bilingual destination aliases. Replaced cluster opportunities are marked internal with `knowledge_cluster_replaced`; historical rows and decisions remain stored. Article eligibility requires two usable current facts, two independent Source families and a non-generic topic. Content type is derived from the destination/topic entity and complete title tokens before any fallback.

Completed-evidence filtering reconstructs independence keys from `source_family_memberships`. Coverage refresh intersects each Knowledge opportunity's stored `selectedFactKeys` with current completed facts, preventing destination-wide expansion.

Source-path reconciliation uses a conservative semantic comparison only for Source-backed rows with the same destination, content type and publication mode, plus compatible duration. It keeps a primary row and links redundant variants as `MERGED`; different modes and reader promises remain actionable.

## Reviewed production-copy projection

The final isolated projection contains 420 actionable opportunities: 235 Source-backed paths and 185 Knowledge opportunities. Of these, 257 are `CURRENT` and evidence-ready; 163 are intentionally visible `EVIDENCE_GAP` opportunities that may be approved but cannot enter production until coverage is ready. Thirty-six have readiness score 0 for the same explicit evidence-gap reason; they are not reported as production-ready.

All 65 current `ARTICLE_CANDIDATE` Sources contribute their complete 243 expected stored paths: 235 remain actionable and eight are linked as merged. No Source has a missing or unexpected stored path. All 185 Knowledge opportunities use completed current evidence and satisfy the two-fact/two-family admission rule. The final checks report:

- zero old-strategy, lifecycle, recommendation, processing-gap, SEO, readiness or unfinished-evidence violations;
- zero exact, canonical, same-Source-signature, topic-key or same-destination dominant-entity duplicate groups;
- zero Source-family eligibility failures or stored family over-counts;
- zero missing Source/recommendation references, broken merged-primary links or canonical-key mismatches;
- zero clear title/entity content-type mismatches and zero context-free generic titles.

The projection preserved all historical opportunities. Its 684 `SUPERSEDED`, 281 `INTERNAL` and nine `MERGED` rows are excluded from the actionable total.

## Local validation

- `npm test`: 523 passed, 0 failed.
- `npm run check`: passed; Vite built 1,882 modules, JavaScript 431.55 kB (134.90 kB gzip), CSS 57.45 kB (10.51 kB gzip), and all 12 service-boundary files passed.
- `test/major-refactor.test.mjs`: 13 passed, covering completed-Source admission, Source-family counting, alias collapse, topic scoping, generic rejection, type inference, historical retirement and conservative Source-path merging.
- The full 2.1 GB production-copy projection rebuilt all destination clusters, Knowledge opportunities and coverage without a model provider call. Production rollout timing and online checks are recorded below after deployment.

## Production rollout and rollback

Deployment evidence, immutable image digest, verified snapshot, live reconciliation duration, post-reconciliation counts, public probes and rollback pair are appended here after rollout. The reconciliation invokes only deterministic repository methods and does not approve an opportunity, call a model, create a WordPress draft or publish an article.
