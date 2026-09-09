# SoloToChina Content Production Strategy 1.6

Effective date: 2026-09-09  
Status: Active

## Purpose and immutable boundaries

Strategy 1.6 keeps the human-selected, evidence-first, rights-aware and draft-only boundaries of Strategy 1.5. Raw Sources, exact evidence spans, Claim history, editorial decisions and commercial data remain separate and auditable. No article is published automatically, and unsupported facts must not be invented to make an article look complete.

## Editorial sufficiency, not encyclopedic completeness

An article is ready when current, non-conflicted evidence can fulfill one clear and bounded reader promise. It does not need to contain every known fact about a destination. Missing facts outside the chosen promise do not block production; missing safety-critical or promise-critical facts still do.

The system supports three explicit production modes:

- `SOURCE_ADAPTATION`: one complete, rights-authorized Source can support an original English adaptation of its itinerary, selections, sequence and practical intent. Unrelated Claims or a second source are not required. The writer must not copy wording or add facts outside the evidence package.
- `TOPIC_FEATURE`: a focused subject such as food, lodging, a short route, photo locations, a list of must-see places or one practical subtopic can stand alone. Several distinct articles may cover the same broad destination or category when each has a different reader promise.
- `MULTI_SOURCE_SYNTHESIS`: use multiple independent Source Families only when the article promise genuinely requires broader corroboration or comparison.

Intake analysis should propose several specific, non-duplicative follow-up topics where the Source supports a useful series. Examples include a one-day itinerary, a three-day itinerary, a focused food installment, a hotel-area guide, an 18-photo-location list or a five-item local-food list. These are examples of shapes, not mandatory templates.

## Evidence extraction and coverage

Source segmentation remains loss-aware: text, PDF pages, images and video evidence are accounted for. Claim coverage is best effort at the segment level, not a demand that every sentence become a Claim. A text Claim whose quote cannot be located in its Source segment is excluded from downstream evidence. Other traceable Claims remain usable. The system retries only when a material text segment has no traceable Claim or a requested media modality was not actually processed; one retry with supported evidence may be accepted with an explicit audit record.

## Processing and provider pressure

The queue uses a small active working set. It finishes coverage, finalization and intake diagnostics for the leading Source before expanding more Sources. A provider-pressure response pauses new AI claims with exponential backoff and jitter, while queued records retain their real queue state. It must not rewrite every queued item as cooling down.

High-throughput extraction and classification use low model thinking. Planning, writing and independent review use medium thinking. Concurrency remains bounded and adaptive, and the global Vertex endpoint is preferred for availability.

## Production identity and rights

Every production artifact retains its Strategy version, draft revision, content hash and evidence hash. Source adaptation is allowed only when editing permission is recorded. Reader-facing output uses original English wording and human-readable Source references; internal Source and Claim IDs never appear in visible copy.

## Authorized source images and reader trust

Source images are eligible only when their authorization, Source URL and evidence relationship are recorded. A real-photo slot must match the named entity or subject; the system must not silently substitute the first available image. Captions and alt text describe the matched asset, while generated illustrations remain distinguishable from documentary evidence.

## Audited production path

`Source → Segments → traceable Claims → Knowledge → Intake Recommendation → Opportunity → human approval → Brief → Draft → QA → Final Page QA → WordPress Draft`

Recommendations remain the human decision gate. Approval applies to one exact Opportunity, and WordPress delivery remains draft-only.
