# CMS 2.0.24 full production recovery and final-preview acceptance

Date: 2026-09-14  
App/Extension: 2.0.24  
Schema: 69 (no migration)  
Content Strategy: 3.3  
Production state: 2.0  
Frontend Contract: 1.4.0

## Scope and safety boundary

This code-only release uses the seven approved production records as a permanent regression corpus and must validate the complete Approval → Editorial Assembly → Narrative Plan → Writing Packet → Draft → Page Plan → Page → independent QA/repair → Commercial → Publish Package → WordPress Draft path. It must not publish a WordPress post, delete production records, alter approvals, or rewrite Source, original media, Claims, Knowledge, Evidence, Experience or prior Failure Lessons.

All retained Source assets are authorized for editorial and production use under `AGENTS.md`. Missing historical item-level licence flags cannot suppress them. Durable bytes, destination/factual relevance, provenance, accessible media, accurate alt text and Frontend Contract validation remain mandatory; unrelated or broken media fail closed.

## Systemic lessons and repairs

1. A recovery Job is not proof of new work if its dependency hash omits the current QA blocker. Every Draft-regeneration entry now includes the authoritative QA report and current frozen writing inputs.
2. A model can return syntactically valid prose that loses planned structure. Exact planned labels are normalized to semantic H2 sections; an evidence-bearing section still missing after one structured correction fails before page composition.
3. Full internal packages are not safe stage DTOs. Writer and QA inputs are compact, and Narrative Planning now receives only the approved outline, at most 48 selected facts/two excerpts per fact and selected Experience Blocks, with a 32k-token/128 KiB local ceiling. The production-copy canary had exposed an approximately 177k-token narrative request.
4. A deterministic stage must not change its own durable input. Authorized visual seeding now occurs before artifact preparation, eliminating the first-attempt `STALE_PIPELINE_INPUT` created by page/visual composition itself.
5. A current QA pass proves that older planning/writing/page failures belong to a superseded revision. They remain audit history but cannot become the current recovery target; required-media and newer post-QA failures are not hidden.
6. Facts must form traveler decisions, not a database dump. Strategy 3.3 now explicitly requires condition/consequence/action logic, varied section rhythm, transparent uncertainty, natural SEO intent, self-contained GEO answers and visible/page/schema consistency.
7. Provider-valid JSON is not necessarily a valid production artifact. The first final-candidate replay rejected a Draft missing one required H2, then exposed three two-second recoveries that reused that rejected completion from the local response cache. Cache admission is now gated by the caller's semantic validator, rejected outputs are evicted, and the writer must emit every approved evidence-bearing heading exactly once in order.

## Verification record

Targeted production-derived regressions: PASS.  
Static/build/boundary checks: PASS.  
Final full local test suite: 612 passed, 0 failed.
Production database replay: PASS on an isolated copy; no production write or model/WordPress call.  
Real Vertex provider replay: in progress on an isolated production work database.  
WordPress Draft canary and desktop/mobile final preview: pending final immutable candidate.  
Production rollout and seven-record recovery: pending final acceptance.

The final section will record the immutable revision/image, exact stage results and provider usage, the seven production states, WordPress Draft IDs/statuses, preview/edit URLs, desktop/mobile visual checks, SEO/GEO checks, rollback reference and disk cleanup. No result may be described as production-complete while a required level remains pending.
