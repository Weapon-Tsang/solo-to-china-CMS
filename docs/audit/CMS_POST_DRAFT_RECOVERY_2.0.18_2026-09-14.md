# CMS 2.0.18 post-Draft recovery audit

Date: 2026-09-14

App version: 2.0.18

Schema: 69

Content Strategy: 3.3

Production state: 1.5

## Production before-state

A complete query-only transaction on the production database reported seven approved production records, seven `needs_attention`, zero queued/running Jobs and zero writes. Five records have a current `revise_draft` failure with `MODEL_OUTPUT_LIMIT` created before App 2.0.17 was deployed. One record has a failed QA review plus a later `SOURCE_IMAGE_FORMAT_UNSUPPORTED` visual failure against a retained WebP original. One has a failed QA review plus a later invalid Frontend Page Payload. The latter two were incorrectly projected as an interrupted path to Commercial Composition even though QA had not passed.

The audit did not retry a Job, call a model, create a WordPress request, archive/delete a record or change Sources, original media, Claims, Knowledge, Evidence, Experience, approvals, Failure Lessons or production artifacts.

## Implementation

- `production_state` 1.5 gives a current failing QA result priority over later failures from its parallel page/image branch. A failed `revise_draft` attempt remains the most specific primary failure.
- The conditional `revise_draft` stage appears in the registry, progress and next-stage fields as soon as a current failing review requires it, even if no repair Job has yet been created.
- Completing or terminally failing a post-Draft parallel branch rechecks a deferred failing review and enqueues one revision-scoped bounded repair through the existing durable queue and `auto-quality-repair` dedupe key.
- Explicit visual-stage recovery includes failed slots. Vertex Gemini localization accepts a retained WebP original and sends its unchanged bytes with MIME `image/webp`; generated derivatives remain separate.
- Content Recovery details follow the same authoritative `production_state` failure. A later non-blocking branch failure is retained for diagnosis and in the production timeline.

## Safety and compatibility

This is a code-only release. Schema 69 needs no migration. Startup reconciliation remains disabled for historical production retries, so deployment cannot enqueue or call models for the seven records. No Frontend component, JSX or CSS is copied into the CMS. The active Frontend Contract remains the only page-schema authority.

## Verification

Pending final automated test, provider canary, production-like read-only replay, immutable-image deployment and post-rollout audit.
