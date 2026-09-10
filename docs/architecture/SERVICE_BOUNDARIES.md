# Service boundaries

This is a gradual in-process split. `src/repository.mjs` remains the compatible public facade and all services continue to share the existing SQLite database and transaction helper. There is no new service, database, route family, or deployment unit.

| Boundary | Responsibility | Current implementation entry points |
| --- | --- | --- |
| Source / Evidence | Capture admission, source assets, evidence spans, coverage | `src/adapters/`, `src/capture-upload.mjs`, `src/source-preflight.mjs`, `src/evidence-validator.mjs`, `src/evidence-consensus.mjs` |
| Knowledge | Claim semantics, entity identity, knowledge resolution | `src/claim-resolution.mjs`, `src/entity-resolution.mjs` |
| Editorial | Human assignments, task pagination, independent readiness dimensions | `src/editorial-assignments.mjs`, `src/services/operations-workspace.mjs` |
| Job / Batch | Queue policy, provider attempts, artifact reuse | `src/job-policy.mjs`, `src/ai/stage-policy.mjs` |
| Publishing | Page composition, SEO/schema, media, WordPress delivery | `src/publish-page.mjs`, `src/seo-geo.mjs`, `src/media-delivery.mjs`, `src/final-html-validator.mjs`, `src/wordpress.mjs` |
| Commercial | Assets, overlay, event attribution and money semantics | `src/commercial.mjs`, `src/affiliate-queue.mjs`, `src/repositories/commercial-events.mjs` |
| Statistics | Offline release and runtime reporting | `src/release-check.mjs` |

The first extraction keeps pure task presentation/pagination in the Editorial service, commercial event persistence/reporting in a Repository child module, and content quality UI state in `frontend/src/workspaces/content-quality-status.jsx`. Transactional methods stay behind the facade until their behavior has a focused contract test; moving them is not a reason to change tables or API payload compatibility.

`config/service-boundaries.json` is machine-readable. `npm run boundaries:check` rejects Source/Evidence or Knowledge imports of Commercial modules. The facade and pipeline may coordinate boundaries, but Research aggregation must never read affiliate tables.

## Baseline and comparison

The fixed 250-item/25-iteration fixture was run against commit `9929fbb` before the split and against the working tree after the split. The API response remained 181,950 bytes with 250 items. The measured runs took 28.01 ms before and 28.15 ms after (223,108.31 and 222,024.08 fixture items/second respectively). These are local sample observations, not a claimed production improvement. Database query count remains `null`/`not_instrumented`; no estimate is substituted. Re-run `node scripts/measure-service-boundaries.mjs` under the same environment for later comparisons.

Repository facade size moved from 403,738 bytes at `9929fbb` to 407,636 bytes during the B08/B09 compatibility work; the extracted Commercial child module is 3,614 bytes. `frontend/src/views.jsx` moved from 138,289 to 138,892 bytes while the extracted status workspace is 2,551 bytes. File size is recorded for maintainability context only and is not treated as a performance result.
