# CMS 2.0.24 full production-provider canary — 2026-09-14

## Scope and isolation

This acceptance run uses a disposable SQLite copy of the production database and a dedicated generated-media directory. It never writes the live CMS database, never publishes WordPress content, suppresses unrelated copied queue work, fixes model concurrency at one, disables Vertex Batch, and caps model calls, recovery cycles, durable attempts and wall time. Protected Source, original media, Claims, Evidence, Knowledge, Experience and approvals are counted before and after every run.

The selected production text provider is `vertex / gemini-3.8-flash`. Kimi is not part of the 2.0.24 acceptance path. Visual generation and authorized-photo localization remain independently fixed to `vertex_gemini / gemini-3.1-flash-image`; a text-only fallback can never satisfy the visual gate.

## Findings converted into permanent controls

- Raw Vertex, Kimi and Flash Image transport/time-limit failures now retain the actual provider, a stable failure code and bounded `retryable_provider` semantics instead of becoming an unknown content failure.
- A Flash Image response with no image bytes is `EMPTY_IMAGE_OUTPUT` and retryable only inside the current durable Job. An explicit safety block is terminal and cannot fall back to fabricated or unrelated media.
- The provider canary now requires a real Flash Image media file with non-zero bytes and a SHA-256 digest when `--require-flash-image` is selected.
- Reader alt text can no longer expose internal Claim keys or a serialized evidence ledger. Deterministic fallback uses a clean authorized asset description or its evidence-linked subject and keeps the original Source provenance.
- The production visual report follows Opportunity → Candidate → Brief → Draft ownership; it no longer joins through a nonexistent Opportunity `draft_id`.
- The WordPress draft-only mock accepts real binary media uploads separately from the bounded JSON Publish Package and records both transport classes.
- Full Draft generation and bounded repair share one pre-downstream protected-value invariant. Each gets at most one exact corrective completion inside the current Job; a still-invalid repair fails closed and targets full Draft regeneration rather than scheduling images or pages from incomplete prose.

## Real provider evidence before the final immutable build

On the production-copy record “Chongqing 3-Day Walking Itinerary”, Gemini 3.8 Flash generated a new Draft. Its first structured completion failed local validation and the compatible correction succeeded inside the same durable Job. Independent QA then found the Draft had omitted the protected `route.guanyinqiao_exit7.to_food_street=3 minutes` fact. Recovery regenerated only the Draft from the frozen Writing Packet; the next revision passed QA with score 98.

Flash Image then produced two real localized PNG files while one relevant authorized Source photo was reused. The generated PNGs were 1,845,183 and 1,648,048 bytes. A fresh post-fix replay later proved partial service availability again: Draft generation succeeded, the first visual was stored, an empty-image response was classified, and the second visual received HTTP 429 until the single Job's 3/3 attempt budget was exhausted. The canary stopped without creating another recovery loop.

After the wait interval, the immutable canary retried only `generate_visuals`; Vertex capacity was available, the stage completed in 14.7 seconds, and the required Flash Image file was 1,722,954 bytes with SHA-256 `f4724964cec8c6150370b6458daaced3e8397ce36be4b61d86aa03c201d9f8c7`. Page composition then completed. QA correctly rejected the prose because the protected `3 minutes` duration was still absent. The automatic full-Draft regeneration again omitted that duration, and the next state projection surfaced an old `INVALID_DRAFT_REPAIR_SCOPE` instead of the current QA blocker. This adjacent production-like finding is now a permanent pre-downstream Draft/repair invariant and a cross-revision failure-supersession regression.

This 429 is a capacity result, not an article-quality or schema result. Vertex AI PayGo Gemini uses Dynamic Shared Quota, so there is no documented fixed local reset timestamp to poll. The bounded real canary is the acceptance probe; it must be retried later from the exact failed visual stage and must preserve the already generated Draft and first image.

## Verification status

- L1 targeted provider, durable Job, visual, alt-text and canary tests: PASS (84/84)
- L2 complete unit/integration regression: PASS (628/628)
- `npm run check`: PASS (production build, syntax and seven service boundaries)
- `npm run release:check`: PASS (50 mandatory checks, zero failures, five warnings, five explicitly external/not-tested conclusions)
- L3 production database replay: PASS for isolation, ownership, protected-data counts and targeted recovery
- L4 Browser E2E: pending immutable deployment
- L5 real provider canary: text PASS; Flash Image capacity-inconclusive after a stored real image and bounded 429
- L6 final page plus WordPress draft-only replay: pending the failed visual stage and final immutable image
- Post-fix exploratory audit: in progress; no production database mutation has been made by these pre-release canaries

## Release rule

This remains a schema-69 code-only release. It performs no migration, historical backfill, production-record deletion or automatic seven-record retry. Production recovery, after deployment, must operate on one approved Opportunity at a time. WordPress delivery is limited to `draft`; `publish` is forbidden.
