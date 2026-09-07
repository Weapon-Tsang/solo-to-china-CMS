# SoloToChina Content Production Strategy 1.4

Effective date: 2026-09-07  
Status: Active

## Authorized source images and reader trust

人工明确保存且已获授权的来源图片继续保留完整 provenance，并优先用于与正文事实直接相关的实景呈现。图片不得脱离对应来源、证据关系、替代文本和 WordPress media 映射。

## Purpose

Strategy 1.4 treats every manually selected Source as an evidence container rather than an article candidate. It upgrades extraction completeness and makes content production a durable, evidence-gated state machine.

## Immutable boundaries

- Sources remain human selected. The system does not crawl accounts, reuse cookies, bypass authentication or CAPTCHAs, or call private platform APIs.
- Raw Sources, original files, Claim history, and evidence provenance are retained.
- Research, Claims, Knowledge, and editorial decisions remain isolated from affiliate offers.
- Commercial components enter only after QA passes and only through active Frontend Contract slots.
- WordPress delivery creates or updates drafts only and never overwrites published posts.
- Previously confirmed authorization for saved Xiaohongshu text and images remains source provenance; no duplicate rights-review workflow is created.

## Research pipeline

`capture_source → preflight_source → segment_source → extract_segment_claims → audit_segment_coverage → retry_segment_extraction → finalize_source_extraction → analyze_source_family → resolve_entities → rebuild_knowledge → rebuild_topic_clusters → build_coverage_matrix → rebuild_content_opportunities → analyze_source_diagnostic`

Text sections, paragraph groups, PDF page groups, every saved image, and video evidence are represented as Source Segments. Each segment has a content and semantic hash. Evidence Spans point to the exact segment, page, image, time range, quote, or region supporting a Claim.

Extraction is exhaustive per segment: do not summarize, do not select representative facts, split compound propositions, and continue until no material supported travel fact remains uncovered. There is no source-level Claim cap. Every captured image is accounted for as processed, failed, or requiring retry.

Coverage auditing compares each material segment with its extracted Claims. A segment with material but uncovered evidence receives one targeted retry. Persistent gaps are surfaced for manual review and never silently treated as complete.

## Claim and Knowledge governance

Claims are atomic and preserve qualifiers, scope, negation, quantities, uncertainty, time, visitor type, booking channel, role, kind, cardinality, and knowledge eligibility. Entity identity remains separate from entity relations. Hard facts use authority, temporal provenance, compatible scope, recency, and independent Source Family evidence. Soft experience and recommendation Claims remain contextual and multivalue.

Sources belong to a family relation: `EXACT_DUPLICATE`, `NEAR_DUPLICATE`, `DERIVED_FROM`, `PARTIAL_OVERLAP`, or `INDEPENDENT`. A highly overlapping Source still contributes incremental Claims. Readiness counts independent families, not duplicate URLs.

Administrative removal is an auditable exclusion. It does not physically erase a Claim or its Evidence Span. Excluded Claims do not contribute to Knowledge; hidden Knowledge does not feed readiness or writing and can be restored.

## Opportunity and production state machine

Source Diagnostic describes evidence value but never directly creates an article. Claims and Knowledge form Topic Clusters and a content-type-specific Coverage Matrix. Required, important, and optional requirements are marked `covered`, `missing`, `stale`, `conflicted`, or `requires_verification`.

Each Content Opportunity has a stable topic key, scope, content type, Sources, Coverage Matrix, readiness result, and lifecycle. Approving a recommendation approves exactly its linked Opportunity:

- insufficient evidence: `approved_waiting_for_evidence`, not queued;
- sufficient evidence: `approved_ready`, then one exact Candidate is created and queued;
- production: `producing → drafted → qa_failed | ready_for_wordpress → wordpress_draft`;
- non-production: `knowledge_only`, `cluster`, `research_required`, `ignored`, or `suppressed`.

Approved waiting Opportunities are reconciled after extraction finalization, Knowledge/topic/coverage rebuilds, manual retries, and startup. Candidate lookup never falls back to the highest-scoring destination-wide topic. WordPress and Search Console collisions suppress the exact Opportunity before Candidate creation.

## Editorial and delivery layers

`Research Draft` is the readable writing and QA artifact. `Frontend Page Payload` is the semantic presentation artifact. `Final Publish Package` is the delivery artifact. They remain distinct.

The approved production path is:

`Opportunity → Brief → Frontend Page Plan → Research Draft → Frontend Page Payload → QA → Commercial Overlay → Final Publish Package → WordPress Draft`

The Frontend Contract remains authoritative for components and variants. In contract-aware mode, the final WordPress draft structure comes from Page Payload blocks. Legacy Markdown-to-Gutenberg conversion is used only when no Frontend Contract sources are configured.
