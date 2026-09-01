# SoloToChina Content Production Strategy 1.2

## Overview

SoloToChina turns human-selected China-travel sources into original, evidence-bounded English content for independent international visitors. A saved source is never automatically treated as an article. The pipeline remains entity-first, fact-first, structured-first, and always keeps the final publishing decision with a human.

Strategy 1.2 succeeds Strategy 1.1 without rewriting it. The active version and concise evolution history are defined in `config/content-strategy.json`; earlier specifications remain immutable records of the rules that created earlier records.

## Core principles

- Human discovery and explicit capture only; never crawler behaviour.
- Claims and Knowledge retain source provenance. Commercial data remains outside Research.
- AI recommends an action; it does not publish or silently create an article.
- Only an explicit **Approve article** decision can start content planning.
- Missing, stale, conflicting, or unverified facts are omitted or marked `NEEDS_RESEARCH` rather than invented.

## Strategy evolution and record continuity

- The dashboard exposes an ordered strategy evolution log with an effective date, concise summary, and material changes in each version.
- New intake, recommendation, opportunity, brief, draft, QA, WordPress, and visual records carry the active Strategy `1.2` tag.
- Existing records retain the version that created them. An upgrade never backfills an older record as if it had followed a newer policy.
- Any future change requires a new immutable specification, a new manifest entry, a succinct change summary, test coverage, handoff updates, and a passing release check.

## Intake intelligence and recommendation

Every AI-processed source receives a strategy-tagged intake analysis. It records primary topic, entities, knowledge points, information density, completeness, article potential, duplicate likelihood, missing information, and a concise user-facing rationale. It produces one of `ARTICLE_CANDIDATE`, `KNOWLEDGE_ONLY`, `CLAIM_ONLY`, `CLUSTER_CANDIDATE`, `RESEARCH_REQUIRED`, `DUPLICATE`, `LOW_VALUE`, or `UNSURE`.

The recommendation offers five human decisions: approve article, knowledge only, add to cluster, research first, or ignore. Knowledge/claim extraction may still enrich the evidence base; only approval opens the article-planning job.

## Content opportunities and canonical content

Opportunities aggregate evidence across Claims, Knowledge, entities, and topics. Their readiness records coverage rather than treating a single post as sufficient research.

An approved opportunity creates Canonical Travel Content: content type, destination, intent, audience, query set, answer-first summary, highlights, practical tips, warnings, FAQ, answer blocks, image plan, SEO package, schema package, and verification state. The planner turns this structured object into a fact-linked outline; it does not write HTML directly.

## Authorized source images and reader trust

The content owner has confirmed that every image in an explicitly human-selected and saved Xiaohongshu source has authorization from the original author and the Xiaohongshu platform for SoloToChina publication. These source assets are classified as `USER_AUTHORIZED_SOURCE_ASSET` for this system. The authorization applies only to those explicitly saved source images; it does not cause discovery, collection, or use of images from other notes.

For an approved article, the system traces the article evidence ledger back to the saved source assets. When a source photo genuinely supports the relevant topic, location, scene, or surrounding evidence, it is the preferred real-world visual. It is uploaded as draft media to WordPress and stays linked to its source asset and source note for traceability. Accurate English alt text and an appropriate caption remain required.

An authorized source photo is not a substitute for factual verification: it may illustrate the evidence it supports, but it does not establish unsupported prices, hours, reservation rules, or other claims. Photos unrelated to the article evidence are not selected merely because they depict the same destination.

When no suitable evidence-linked real-world photo exists, the visual plan uses a deterministic data-backed map or infographic where the facts support one, then a non-factual original illustration if needed. Image generation is never used to fabricate a documentary-looking venue, street, landmark, hotel, meal, ticket, or route.

## Article, SEO, GEO, and Schema.org

Articles begin with a direct answer, use descriptive H2/H3 structure, include reader-facing key takeaways and FAQs, and avoid generic travel copy. SEO is natural-language intent matching: one primary keyword, secondary questions, concise metadata, canonical URL only when configured, and no invented internal links.

GEO uses clear questions, direct answers, consistent entities, structured facts, answer blocks, and scannable headings. Schema.org is deterministic from Canonical Content: WebPage, Article, BreadcrumbList, Organization, and ImageObject are emitted only when their underlying values exist. No coordinates, prices, booking rules, or other unknown values are fabricated.

## QA and publishing

QA checks strategy-version continuity, title/H1 contract, heading hierarchy, evidence and conflict safety, placeholder/HTML safety, SEO metadata, schema consistency, image strategy, and commercial isolation. Rendering uses structured content blocks and produces a WordPress payload tagged with the same strategy version. WordPress delivery remains draft-only.
