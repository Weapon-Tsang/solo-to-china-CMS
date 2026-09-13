# CMS production error repair 2.0.14 audit and implementation record

Date: 2026-09-13 (Asia/Shanghai). Source branch: `codex/audit-v1.3`. The implementation was audited against production application/extension 2.0.13 before the separately authorized rollout of 2.0.14 revision `9341a30ea07ac16fa2803a8aed5f27c776106c17`; schema remains 69 and Content Strategy remains 3.3.

## Read-only production evidence

The follow-up audit opened the production SQLite database read-only and enabled `PRAGMA query_only=ON`. It ran no application worker, recovery endpoint, reconciliation, archive, deletion, model or WordPress request. The saved ignored evidence is `output/error-audit-2.0.13/current-error-audit.json`, SHA-256 `2D6E63528816D940B62D12A854F6A82FA092EC32E7D84C170915E0B04165BCBF`, generated at `2026-09-13T13:46:11.403Z`. Integrity was `ok`, foreign-key violations were zero, the schema version was 69, there were seven persisted approvals, 5,677 model-attempt metrics and zero queued/running Jobs (including zero active production Jobs). All seven approved records were in `needs_attention`; no unapproved record had leaked back into the workbench.

The user's interactions since the stable 2.0.13 post-deploy baseline increased model-attempt metrics from 5,666 to 5,677. The eleven rows are fully accounted for: three Editorial Assembly successes, six rejected `content_brief` transport attempts for three records, and two rejected `narrative_plan` transport attempts for one retry. Each affected planning/narrative Job shows the same sequence: attempt 1 `SCHEMA_MODE_UNSUPPORTED`, then attempt 2 HTTP `400`, with no input/output token usage on either rejected attempt. The retained Job error is `Vertex Gemini request failed (400): Request contains an invalid argument.` This proves that provider requests were sent, but the stored provider response does not confirm that generation began. The 2.0.13 UI's `model_called:true` was therefore too strong.

Current record classification at the audit point:

| Opportunity | Current evidence-backed finding |
| --- | --- |
| `opportunity_24a5d6f2e8fc25941b477a92` | Editorial Assembly succeeded; `plan_content` was rejected by both Vertex schema transports before confirmed generation. |
| `opportunity_2147a72065b016381a9c388b` | Same `plan_content` schema-transport rejection. |
| `opportunity_870dc70e0b3956c91d79c6b9` | Same `plan_content` schema-transport rejection; screenshot request ID matches metric `modelcall_08a73bbd398c425c8409be9a9d319221`. |
| `opportunity_b3037c5a4c18a00b87fa05c9` | Brief is preserved; the newest `plan_narrative` retry was rejected by both schema transports. |
| `opportunity_330c863f063b8e4eb60e97bc` | Deterministic `DESTINATION_TOPIC_MISMATCH`: city-wide Chongqing title assigned to `ciqikou-ancient-town`; `plan_content` made no model request. |
| `opportunity_7c882eef78edb2ffb874e06a` | Old `plan_content` output-limit Job has no Editorial Assembly under the current registry; title also explicitly says Chongqing while the approved destination is `beijing-palace-museum`. Destination correction must occur before another Assembly/model call. |
| `opportunity_b9ec578018c96b44fccc9444` | Old Page Plan output-limit failure has a Brief but no Narrative or Writing Packet. Retrying Page Plan is invalid; the first current-contract gap is `plan_narrative`. |

The red prerequisite toasts in the screenshots were contract drift, not missing user input: `production_state` exposed the historical failed stage as `recovery_target`, while `executeContentRecovery` independently checked current dependencies and rejected the same target. This produced `assemble_editorial`/`assemble_writing_packet` prerequisite errors after the UI had offered “重试失败步骤”.

## Implementation

`production_state` 1.2 validates an explicit title/destination mismatch before offering any production recovery. It also checks whether the newest unresolved failed Job has every dependency required by the current stage registry. If not, the Job is retained as `latest_historical_error`, its timeline entry becomes non-blocking waiting/history metadata, live status becomes `interrupted`, and `recovery_target` becomes the first missing stage. Both recovery commands now consume that single server-owned target. Stale clients receive a Chinese refresh/current-target conflict rather than raw internal keys.

Failure attribution now returns `provider_request_sent`, `model_execution` (`confirmed`, `rejected_before_generation`, `not_requested` or `unknown`) and the failure-stage label. Planning/narrative HTTP 400 errors explain the structured-interface incompatibility directly and state that it is not evidence of bad article facts.

The Vertex client retains native JSON Schema and OpenAPI Schema as its first two transports. When both return HTTP 400, it removes the provider-side schema, sends the unchanged contract in the system instruction with JSON MIME, and validates the result against the original local JSON Schema. Transport negotiation does not consume the bounded semantic output-repair attempts. This code path runs only for an explicitly queued stage; it does not create or retry production Jobs itself.

Production details expose the existing audited destination-correction workflow for `DESTINATION_TOPIC_MISMATCH`. Correction is deterministic, recalculates evidence, and requires scope reconfirmation. No correction was executed against production in this implementation pass.

The mobile secondary menu now opens upward inside the existing card and uses explicit `z-40`/`z-50` stacking. At a 393×852 browser viewport its rendered bounds were top 635.48, bottom 721.48 while the card bounds were top 454.61, bottom 773.48; the menu was fully inside the clipping rectangle and visible above subsequent cards. No Frontend renderer, JSX or CSS was copied into the CMS.

## Verification

- `npm test`: 546 passed, zero failed.
- `npm run check`: production Vite build, syntax checks and service-boundary checks passed.
- `npm run release:check`: 50 mandatory checks passed, zero failed, five warnings and five explicitly external/not-tested checks. The warnings are the 30-second unit-test advisory, unavailable external credentials and the known experimental SQLite warning; correctness gates passed.
- Mobile UI: the in-app browser fixture verified the menu geometry at 393×852 and verified the production-detail wording for request submission versus pre-generation rejection.

## Migration and safety

Application/extension version is 2.0.14. Schema remains 69; there is no migration. Startup behavior is unchanged and creates no historical production retry. All implementation changes are code/UI/contract documentation only.

No production record was retried, archived, deleted or scope-corrected by the implementation or rollout; no Source, original media, Claim, Knowledge, Evidence, Experience, approval, Failure Lesson or audit record was deleted.

## Authorized production rollout

After explicit deployment authorization, commit `9341a30ea07ac16fa2803a8aed5f27c776106c17` was pushed to `origin/codex/audit-v1.3`. Cloud Build `32a28924-4fd6-4f84-b021-d5dadcfb5ed9` built `asia-east1-docker.pkg.dev/project-4bcb9146-c37b-43b0-b11/solo-to-china/engine:2.0.14`; production runs its immutable digest `sha256:05db2059e2212bc75ffec8806b3dc651c98d20c53ae598b5ce7ecb50969b2c9c`, and `.env.production` is pinned to that digest with all other runtime configuration bytes preserved.

Before replacement, the query-only audit reported SQLite integrity `ok`, zero foreign-key errors, schema 69, seven approvals, zero active Jobs, zero active production Jobs, 10,847 total Jobs, 5,677 model-call metrics and zero WordPress Jobs. GCE snapshot `stc-pre-2-0-14-9341a30` reached READY. The upgrade then created application snapshot `solo-to-china-2026-09-13T14-57-27-804Z.snapshot` (2,219,425,792 bytes, SHA-256 `e0982717bf57e962b2975899e7560ef8c477e72f8112671dfbd979e7e5b09faa`, 1,009 files), verified it, and completed a network-isolated restore drill with external side effects disabled. Schema 69 rehearsal and production open both returned integrity `ok`, zero foreign-key errors and unchanged fingerprints for 74 Sources, 149 capture versions, 1,318 assets, 2,275 segments, 5,147 Claims, 8,292 evidence rows, zero Drafts and zero visuals. The deterministic offline qualification gate retained 413 actionable opportunities: 257 ready, 156 evidence gaps and zero hard violations.

The replacement passed isolated readiness before network attachment. Public `/api/health` and `/api/ready` then returned version 2.0.14 and ready state; Frontend Contract 1.4.0 remained healthy. The authenticated Content smoke returned exactly seven approved rows, all with backend-owned `production_state` 1.2 and explicit current/recovery semantics. The stable post-rollout query-only audit reported integrity `ok`, zero foreign-key errors, zero active Jobs, zero active production Jobs, unchanged 5,677 model-call metrics and zero WordPress Jobs. The 52 new completed Jobs were deterministic, unowned startup maintenance for topic/Contract/coverage/opportunity projection and reconciliation; they neither called a model nor retried a production owner.

The retained rollback set is stopped container `engine-before-9341a30`, READY disk snapshot `stc-pre-2-0-14-9341a30`, and the verified application snapshot above. Successful-upgrade cleanup removed rehearsal databases, obsolete containers and unused Docker layers, retained only one application snapshot, and deleted superseded GCE snapshot `stc-pre-2-0-13-8e3b9a4`. Final VM disk use is 9,343,717,376 of 84,293,791,744 bytes (12%). Temporary IAP access and remote `/tmp` artifacts were removed after evidence capture.

Ignored local evidence: pre-deploy audit SHA-256 `77B0182C098889892D45ECA4BAC6E0423778F6F04088401C49DEED0526C22675`; post-deploy audit `CEF7E1DF204A2A931A67DCD46FE14FFF2072B6B5560A46B3C058D92B033D0F08`; authenticated API smoke `E48F0F14C0A04A787A031CFAAF3F52FB9EB14A97C199F855E95E7C57BE4BA374`; deployment evidence archive `F23976B5264876F2E8850C169577CA060594FF9F8AC924B05E4A3E823C1D2A94`.
