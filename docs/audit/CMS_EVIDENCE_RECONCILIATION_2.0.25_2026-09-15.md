# CMS 2.0.25 evidence-ledger reconciliation — 2026-09-15

## Production finding

After 2.0.24 deployment, six workbench rows still showed their persisted historical failures because a code-only rollout intentionally performs no automatic recovery. A single controlled retry of `opportunity_24a5d6f2e8fc25941b477a92` proved that Vertex accepted the current OpenAPI structured request and generated complete JSON. The new terminal was local `DRAFT_EVIDENCE_VALUE_INVALID`: the model's internal ledger cited `route.chaotianmen_to_hongyadong.pedestrian_path=1F` and `itinerary.nanan.duration=10 hours`, while the reader-visible article did not use those optional background facts.

The failure was not a destination, Source, Evidence or Vertex transport error. It exposed stochastic ledger over-reporting that the earlier successful canary did not emit. Treating every selected background fact as mandatory prose would reintroduce database-dump writing, so the invariant is instead: a ledger may cite only facts actually expressed by the article, while every planned evidence-bearing section must retain at least one honest approved claim.

## Repair

Before Draft persistence, known section-allowed claims with absent protected values are removed only when another usable claim still supports that section. The final supporting claim is never pruned and continues through the existing exact correction/fail-closed path. Section labels come from the approved outline and Source IDs come from frozen fact snapshots, not model-authored ownership. No prose, fact, approval or upstream artifact is changed.

## Verification

- L1 targeted Draft/evidence/recovery tests: PASS (69/69)
- L2 complete unit/integration regression: PASS (633/633)
- `npm run check`: PASS, including production build and seven service boundaries
- `npm run release:check`: PASS (50 mandatory checks, zero failures, five warnings, five external/not-tested conclusions)
- L3 production database replay: PASS on `prod-2.0.25-walking-canary.sqlite`; 74 Sources, 1,318 Source assets, 5,147 Claims, 8,292 Evidence spans, 4,270 Knowledge facts, 518 Experience blocks, seven approvals and 42 Failure Lessons were unchanged
- L5 real provider canary: PASS with `vertex / gemini-3.8-flash`; the selected flow completed Draft, Frontend Page, independent QA and Commercial composition with four measured calls and no 429
- L4 Browser E2E: NOT TESTED in this candidate run
- L6 WordPress draft delivery: NOT REQUIRED for this Draft-admission change; 2.0.24 already passed isolated Contract/draft-only delivery, and production acceptance will validate each recovered record through the real `preview_url` and `edit_url`
- Post-fix exploratory audit: PASS for the selected production-copy flow; no active Job or current failure remained

The canary image was `sha256:29a6bbdc8d5b470ff4e3e3d0435b79433177c557ae37ae218051736a94abccca`; the final immutable image, rebuilt from the same code plus this audit record, is `sha256:9a3086d97b08ab7501468d28e89ab2bbce3926d8eaee798d1cb7dbf9cd95d74a`. This is a schema-69 code-only release: no migration, reconciliation, production-record deletion, bulk retry or automatic WordPress publication is permitted.
