# CMS production-state hotfix 2.0.13 audit and implementation record

Date: 2026-09-13 (Asia/Shanghai). Code branch: `codex/audit-v1.3`. Production was first inspected on app/extension 2.0.12, schema 68, Content Strategy 3.3, revision `a592b720edb311f10d88bcfa01e98ab7a945f6cd`. After explicit authorization, production was upgraded to 2.0.13/schema 69 at revision `8e3b9a467c36ff6a3b0ff33d4b28cf8700db6303` and immutable image digest `sha256:b47514ea2b058ab9f743208e5be24d843def5c5a0543375db67adbf7f5e7cd47`.

## Read-only production audit before implementation

The complete operator prompt was read before access. The database inspection used a read-only connection with `PRAGMA query_only=ON`. Integrity was `ok`, `PRAGMA foreign_key_check` returned zero rows, the audit connection reported zero changes, and no application worker/recovery endpoint was run. Temporary IAP access was removed immediately after capture. The ignored evidence snapshots are `output/production-state-hotfix/production-state-before.json` (SHA-256 `B857819E4DCB04D213C2F32EB2D2C2665EF081A918B6F2408872B5767C7F7551`) and `retry-supplement-before.json` (SHA-256 `34AB8D61E2CD98118194C3E673305AD1E74286A5679EF87A88BFAB4DB46459F9`); the deterministic projected-after report is `production-state-after-dry-run.json` (SHA-256 `3A217116E5E8EA59F3C1B1C515257CC0B7D5D66EB688B900F914C52468B79FD8`).

Production contained 1,394 Opportunities, 7 rows with a persisted `approved_at`, 136 succeeded Jobs, 31 failed Jobs, zero queued/running production Jobs, and 5,666 model-call metric rows. The deployed `productionOnly` query returned 181 rows and all 181 were counted as `needs_attention`. Their disjoint classification was:

| Classification | Count | Finding |
| --- | ---: | --- |
| Never approved; admitted by Candidate presence/legacy lineage | 25 | False positive |
| Unapproved sibling inheriting a shared Candidate-level Job | 149 | Duplicate projection |
| Persisted approved and ready, but no production entry Job | 3 | Real approved instance; interrupted under the corrected contract |
| Persisted approved with an owner-resolvable failed production attempt | 4 | Real failed instance |
| Total | 181 | 174 unapproved, 7 approved |

The database therefore does not support changing six historical approval decisions merely from the statement that one item was recently approved. The hotfix preserves all seven persisted decisions and leaves any approval correction to an explicit later operator action.

The leak was the `productionOnly` admission branch `OR tc.id IS NOT NULL`, combined with a `hasLineage` test that treated `candidate_id` as production lineage. Candidate-scoped Job joins then made one failed Job visible through every Opportunity sharing that Candidate. Nineteen production Jobs were projected into more than one Opportunity. The UI display title used Draft title, then Candidate `proposed_title`, so siblings also appeared to repeat the same title; there were 20 repeated display-title groups even though only one exact Opportunity-title duplicate existed.

The corrected dry-run projection contains only the seven persisted approved Opportunities: four failed and three interrupted/ready-without-entry, for seven `needs_attention`. It excludes all 174 unapproved rows, has zero multi-owner Job projections and performs zero model, queue or WordPress calls. This is a projection, not a production mutation.

## The operator's single recovery click

The click is retained. Operation `recovery_1593d291deeb44aa95d1e48f29b29a93` recorded `recover_next_stage`. It created Editorial Assembly Job `job_cde3a3f8a4134037b9a1aaa9a6df8bb4` and recovery run `recovery_run_ffcfacd052a34b33ba6f7226bfa5193c`; that Job succeeded. It made exactly one Vertex editorial-assembly model request, metric `modelcall_2e44833c3f5448b1abf9bf0f29c6ca55` (71,813 input tokens and 1,035 output tokens). The old implementation then attached the Assembly to unapproved Opportunity `opportunity_4266df05273ce58332512746` instead of the approved owner `opportunity_330c863f063b8e4eb60e97bc`, and its downstream `plan_content` Job `job_8801e84a94b7490794d76fe5f4b490ce` lost the recovery-run ownership.

The downstream `plan_content` Job failed before any planning model request. Its retained raw error is:

```text
DESTINATION_TOPIC_MISMATCH: Planning is blocked because the topic explicitly names chongqing but is assigned to ciqikou-ancient-town. Correct the destination and rebuild its scoped evidence before retrying.
```

Thus this particular current failure was a deterministic destination/topic validation failure, not a token/output limit. The Assembly model call was the only new call attributable to the click; `plan_content` made none. The UI now presents this as a non-retryable destination correction requirement and exposes `model_called: false` for that failed stage.

## Implementation

Schema 69 adds `jobs.production_owner_opportunity_id` and owner/idempotency fields to `content_operation_history`. New Jobs and all child Jobs carry the exact approved Opportunity owner. Migration assigns only a uniquely provable historical owner; ambiguous Candidate-level history remains unowned and auditable. Editorial Assembly and operation rows receive the same unique-only correction. The migration is transactional, changes no approval, creates no Job and invokes no provider.

`production_state` contract version 1.1 is server-owned. It adds production instance/owner identity, owner-resolution status, separate recovery target, following stage labels and structured failure attribution. It projects Jobs, receipts, artifacts and model metrics only for that owner (with a unique-owner legacy fallback), does not count Candidate ID as lineage, and suppresses an old failure after a newer same-stage queued/running/succeeded attempt. Section counts derive from those same objects.

Recovery keys include owner, stage, entity/input identity and retry generation. Repeating an operation idempotency key returns the stored result; a matching active recovery is reused; no second Job or pipeline run occurs. Dependencies must be succeeded, completed upstream artifacts remain in place, and child Jobs inherit owner, recovery run, parent, route and priority through the existing durable pipeline.

Planning now loads the exact approved Opportunity package and prefers the Editorial Assembly selected fact keys. It deterministically deduplicates and ranks material facts, keeps conflict/freshness/date/negation/exception qualifiers and source independence, caps the package at 32 facts, 64 evidence snippets, 96 KiB and approximately 24,000 input tokens, and records an input manifest. The Brief response schema bounds all arrays and returns evidence keys instead of repeated evidence prose.

The mobile workbench renders cards below the `md` breakpoint, keeps statistics at 2-by-3, scrolls filters in one line, wraps titles/errors, exposes a full-width production detail sheet and places archive/delete under secondary actions. Internal stage keys and technical failure fields are collapsed. The Page Composition Preview remains a structural rendering of persisted Contract payload metadata; it contains no copied Frontend JSX/CSS. WordPress final preview/edit actions continue to use only persisted `preview_url` and `edit_url`.

Archive/delete semantics are unchanged in their safety boundary but are now owner-scoped. Archive retains all production artifacts. Delete removes the selected owner's derived production Jobs, Artifacts, Receipts and its disposable Assembly/Brief/Draft/review/visual/page/commercial/publish/local WordPress descendants only when ownership is unambiguous and no remote WordPress Draft exists. Sources, capture versions, original media, Claims, Knowledge, Evidence, Experience, recommendation/approval decisions, Failure Lessons, attempt archives, model accounting and audit/tombstones remain.

## Safety and rollout status

Immediately before rollout, a fresh read-only baseline at `2026-09-13T12:45:59Z` again reported integrity `ok`, zero foreign-key violations, schema 68, 5,666 model calls, zero active Jobs, zero active production Jobs, seven approved Opportunities and 10,717 Jobs. Its ignored evidence file is `output/deployment-2.0.13/production-state-predeploy-2013.json` (SHA-256 `5DCD3C5F9525A6140EC1FFABDA9D6314650E0818E6A246C2E8E94AD5F14F7A80`). The repeated dry-run projection contained seven approved rows, excluded 174 unapproved rows, and found zero duplicate production owners/Jobs; its SHA-256 is `E87DA51738D56D52CAA27A512453BBDF8BF130A1B7CF7ECD7360C1D266F97229`.

Cloud Build `3a778fe2-65b5-43be-b81c-18d350c5ce0b` produced the deployed digest. Before mutation, snapshot `stc-pre-2-0-13-8e3b9a4` reached READY and the offline application snapshot `solo-to-china-2026-09-13T12-53-09-321Z.snapshot` passed manifest verification and a restore drill across 1,009 retained files. Schema 68→69 rehearsal and production migration both reported integrity `ok`, zero foreign-key errors and identical fingerprints for Sources, capture versions, source assets/files/segments, Claims, Evidence, extraction coverage, Drafts and Visuals.

The required reconciliation ran inside a container with `--network none`. It processed 14 destinations deterministically, preserved all seven approvals, retained model-call count 5,666 and created no model or WordPress request. Normal startup completed deterministic topic/coverage/opportunity maintenance for five existing destinations; those were non-production Jobs and all succeeded. It did not retry any Content Workbench record or enqueue the 181 projections.

The authenticated production `/api/content` smoke test returned exactly seven records: three `pending_start` and four `needs_attention`, with explicit stage/progress/automatic-continuation/recovery/error attribution. The first manually retried record remains at 1/11, `plan_content` failed with `DESTINATION_TOPIC_MISMATCH`, and `model_called:false` for that failure. A stable post-deploy audit at `2026-09-13T13:20:58.881Z` reported schema 69, integrity `ok`, zero foreign-key violations, zero active Jobs, zero active production Jobs, zero owner violations, zero post-deploy model calls, zero post-deploy WordPress Jobs and model-call total still 5,666. Public engine health/readiness and capture health returned version 2.0.13, and Frontend Contract 1.4.0 was healthy at Frontend commit `f44ce1092ced93dfb47d9b3eae83d0d5e4b97086`.

No production record was archived, deleted or retried during rollout. No Source, original media, Claim, Knowledge, Evidence, Experience, approval, Failure Lesson or audit record was removed. The runtime retained the stopped 2.0.12 rollback container/image, the new READY disk snapshot and the verified application snapshot. After verification, Docker pruning left only current, immediate rollback and Cloudflared images; the superseded disk snapshot was deleted, VM utilization was 12%, temporary IAP firewall/tag access was removed, and only the immutable `ENGINE_IMAGE` line was updated in the private runtime environment.

Local verification passed `npm run check` (Vite production build, syntax and service boundaries), all 541 unit/integration/migration/static-UI tests, and `npm run release:check`. The release gate reported 51 mandatory checks passed, zero failures, four warnings and five explicitly external/not-tested checks. Its isolated API/UI server, clean migrations, schema 59→69 deployment rehearsal/paired restore, database integrity/foreign keys, fixed-SHA Frontend Contract, backup drill and Extension static checks passed. Paid model, production WordPress/theme, Search Console and real Chrome/Xiaohongshu checks were not run; the production deployment itself made no model or WordPress call.
