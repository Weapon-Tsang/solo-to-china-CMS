# CMS production error repair 2.0.14 audit and implementation record

Date: 2026-09-13 (Asia/Shanghai). Source branch: `codex/audit-v1.3`. Production remained on application/extension 2.0.13, schema 69, Content Strategy 3.3 and revision `8e3b9a467c36ff6a3b0ff33d4b28cf8700db6303` throughout this work.

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

## Migration, safety and rollout

Application/extension source version is 2.0.14. Schema remains 69; there is no migration. Startup behavior is unchanged and creates no historical production retry. All changes are code/UI/contract documentation only.

Temporary IAP firewall/tag access and remote `/tmp` audit files were removed after the evidence was copied. No production record was retried, archived, deleted or reconciled by this work; no Source, original media, Claim, Knowledge, Evidence, Experience, approval, Failure Lesson or audit record was changed. Production deployment was not executed.
