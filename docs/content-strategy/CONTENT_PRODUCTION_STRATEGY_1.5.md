# SoloToChina Content Production Strategy 1.5

Effective date: 2026-09-08  
Status: Active

## Purpose and immutable boundaries

Strategy 1.5 keeps the human-selected, evidence-first and draft-only boundaries of Strategy 1.4. Raw sources, exact evidence spans, claim history, editorial decisions and commercial data remain separate and auditable. The system never turns a domain guess into official evidence and never allows a published WordPress post to be overwritten automatically.

## Evidence and production identity

Every production artifact carries an exact identity. A Research Draft has a revision and content hash. QA also records the evidence hash. Frontend Page, Commercial Composition and Final Publish Package record the draft revision and hash that produced them. Any draft or evidence change makes the old QA and downstream artifacts stale before another external write can occur.

Stable internal block provenance maps each final editorial block to its semantic role and the applicable Claim and Source IDs. Reader-facing pages use human-readable source titles, real public URLs and available published or verified dates. Internal source and claim IDs never appear in visible copy.

## Content sufficiency policy

Length, FAQ and visual requirements follow the content task, reader intent and available evidence. Short practical answers and how-to pages may be concise when they fully answer the task. City guides and itineraries require broader coverage. Word targets are ceilings and evidence-scaled review thresholds, not permission to pad or repeat content.

FAQ is optional. It is created only when the query intent raises real questions and the supplied evidence answers them. Any FAQPage structured data must match visible FAQ blocks exactly. A useful FAQ is retained even though Google removed its FAQ rich-result feature in May 2026.

Visual plans use a bounded range by task and evidence. Real-world images require entity/subject matching and authorized provenance. Maps and infographics remain incomplete until a real renderer produces their asset. Optional illustration failure may degrade gracefully; missing required factual media blocks delivery.

## Authorized source images and reader trust

Source images are eligible only when their authorization, source URL and evidence relationship are recorded. A real-photo slot must match the named entity or subject; the system must not silently substitute the first available image. Captions and alt text describe the matched asset, while generated illustrations remain visibly distinguishable from documentary evidence.

## Search and generative search policy

The system follows ordinary technical SEO and people-first content practices. It makes important content visible as text, keeps structured data consistent with the visible page, uses real internal links from the synchronized WordPress inventory and preserves canonical/robots ownership in WordPress. It does not promise ranking or AI citation from schema, FAQ, fixed word counts, artificial chunking or llms.txt.

Policy basis checked 2026-09-08:

- Google Search Central, “AI features and your website”: https://developers.google.com/search/docs/appearance/ai-features
- Google Search Central documentation updates: https://developers.google.com/search/updates (FAQ rich results removed; feature stopped displaying on 2026-05-07)
- Google Search structured-data guidelines: https://developers.google.com/search/docs/appearance/structured-data/sd-policies

## Audited production path

`Opportunity → Brief → Frontend Page Plan → Research Draft → Frontend Page Payload → QA → Commercial Overlay → Final Page QA → Final Publish Package → WordPress Draft`

Work is processed through owner-bound leases with heartbeat and expiry recovery. Model calls use bounded concurrency, provider-aware retry handling and hash-only provenance metrics. Media upload progress is persisted per item and unchanged visual assets survive text-only revisions.

Content opportunities identify create, update, merge or retire impact against the synchronized WordPress inventory. Update or merge impact remains an explicit editorial decision and never silently creates a duplicate or overwrites a published post.
