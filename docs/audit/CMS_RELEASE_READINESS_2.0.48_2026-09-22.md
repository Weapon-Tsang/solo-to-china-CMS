# CMS 2.0.48 release readiness — 2026-09-22

Branch: `codex/integrated-pipeline-v2-release`. Production was observed running 2.0.46 on schema 73. This candidate targets schema 77 and Content Strategy 3.8; it remains unmerged and undeployed.

## New grant and recovery evidence

- Schema 77 adds `media_budget_grants`: immutable grant identity, visual and substage, 1–4 extra calls, actor, reason, spent count and idempotency key. The total extra allowance per image step is 12. All spent calls remain in `media_dispatches`; unknown outcomes cannot be granted around, and persisted quota pacing and 429 cooldown remain authoritative.
- The authenticated article detail returns spent/granted/limit/unknown counts. The administration action grants only an exhausted step on the current article with a `MEDIA_BUDGET_EXHAUSTED` failure. The editor must then choose recovery from the failed stage.
- Targeted executor tests cover two SQLite connections, cross-process lane ownership, 2 RPM starts at 0/31/62 seconds, 429 cooldown, unknown outcomes, exhausted budget, repeated grant, incremental grant and preserved prior dispatches. A local API test covers authentication, unrelated visual refusal, duplicate request and audited spend at grant time. The frontend build passes.
- A local headed Playwright session logged into a disposable API-only fixture, opened Content and the failed article detail, entered a reason, selected two extra calls and clicked the grant action. Reopening the detail no longer offered another grant before those calls were used. The SQLite audit row recorded actor `admin`, two approved calls and `spent_at_grant=4`; dispatch count stayed four and the article body bytes were unchanged. This is UI-to-database evidence for the grant action, not the complete media recovery chain.
- `npm run release:check` passed all 50 mandatory offline checks (five warnings, five external/production dimensions untested). Unit/integration duration was 40.35 seconds against a 30-second warning threshold. The first run failed only because the 2.0.48 handoff version line was missing; it was corrected and the complete gate passed on rerun.
- Follow-up fault injection exposed a required-image bypass: `generate_visuals` had checked `visual.media_metadata` on a raw SQLite row instead of parsing `media_metadata_json`. After fixing it, a local regression exercises one saved image, two 429 responses on the second image, exhausted budget with `needs_review`, an explicit grant, a newly created executor and recovery of only the second image. The first image SHA-256 and original body stay unchanged. This regression does not include the real Provider, full article bundle, independent review or WordPress delivery.
- After that fix, the complete offline release gate passed again: 50 mandatory checks, zero failures, five warnings and five external/production dimensions untested. The unit/integration group took 39.44 seconds, above its 30-second warning threshold. A separate test confirms an unknown exhausted dispatch cannot be unlocked by a grant.
- The local media-stage replay also checks the publication eligibility gate before and after recovery: it returns `MEDIA_INCOMPLETE` at exhaustion and passes once the second image has persisted binary/quality proofs. Delivery-phase receipts and a WordPress upsert remain outside that replay.
- The 2026-09-21 snapshot was previously verified and restore drilled (1,207 files; 1,423 media references). It is a dated baseline, not a fresh pre-deployment backup. A new local disposable schema 73→77 replay against that snapshot baseline preserved old content and identifiers across 11 tables, including 16,190 Jobs; integrity passed, a second open was idempotent and the baseline stayed at schema 73.

## Outstanding release gates

| Gate | Status |
|---|---|
| Full bundle → media 429 exhaustion → process restart → explicit grant → only missing image → independent QA → one mock WordPress draft (M35, X01–X07) | PARTIAL: local media-stage fault injection; full chain NOT TESTED |
| Real Provider schema and semantic canary | NOT TESTED; the original v2.0 brief excludes paid calls without explicit authorization |
| Active production Worker browser menus, pagination and response P50/P95 | NOT TESTED |
| 72-item ledger | Incomplete; see `INTEGRATED_PIPELINE_PERFORMANCE_2026-09-21.md`, retaining partial/untested entries |
| Fresh paired pre-upgrade backup, restore drill, current-data fingerprint and reversible migration | NOT DONE for this new candidate |
| Immutable production image build and isolated API/Worker readiness for 2.0.48 | NOT DONE |

**NO-GO pending the listed gates.** User authorization exists for commit, push, merge, production deployment and remote branch cleanup, but it does not change the v2.0 acceptance criteria or authorize paid Provider requests. Do not merge or deploy while the current gate remains incomplete. A release must stop both roles, take and drill a new paired database/media backup, rehearse schema 73→77, preserve the 2.0.46 image and stopped container, start isolated API and Worker from one immutable digest, check readiness, then switch traffic. Rollback stops both roles, preserves new database/WAL/media and receipts for diagnosis, and restores the matched old database/media with the 2.0.46 image; old code cannot open schema 77.
