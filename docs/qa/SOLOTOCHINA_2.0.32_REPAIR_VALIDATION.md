# SoloToChina 2.0.32 Repair v1.1 Validation

Date: 2026-09-17 (Asia/Shanghai)

This record replaces the v1.0 repair contract with `SoloToChina_Combined_Repair_Prompt_v1.1.txt`. Work continued on `codex/audit-v1.3` without resetting the branch or discarding valid earlier changes.

## Scope and safety boundary

- Change class: `DATABASE_LOGIC`, `PIPELINE`, `AI_PROVIDER`, `DATA_MIGRATION`, and bounded admin UI.
- Application/extension: `2.0.32`; schema: `72`; Content Strategy: `3.6`.
- Migration 72 is additive. It does not enqueue jobs, call a provider, write WordPress, or rewrite historical certainty.
- Asset saves only version the asset and mark matching commercial compositions stale. Execution requires a separate fingerprinted `delivery-refresh` preview and confirmation.
- No historical production article repair or backfill is authorized by this release. Current production failures remain diagnostic records until separately approved.

## Implemented repair boundaries

1. `FINAL_PAGE_INVALID` now retains deterministic execution kind, original validator errors and paths, draft/contract/overlay/asset identities, input/candidate hashes, owner/run/job attempt, code revision and failure time in durable job diagnostics.
2. Image analysis/translation/transform/generation/visual-QA calls retain actual provider, model, substage, HTTP/provider outcome, request identity when supplied, dispatch evidence and source/visual/run links. Dispatch intent is written before fetch and updated in the same ledger row.
3. A valid transformed image is stored as an immutable private `pending_qa` candidate before semantic QA. A transient QA failure resumes QA against the same bytes/hash; it does not repeat translation, transformation or image generation. Missing/tampered/stale candidates fail closed.
4. Failure attribution distinguishes deterministic `not_applicable`, locally gated `not_attempted`, cache reuse, provider response, dispatch-started outcome `unknown`, and legacy telemetry `unknown`.
5. Affiliate assets have optimistic PATCH, semantic no-op detection, immutable versions, exact tracking-URL retention, conditional embed/image fields, usage and delivery evidence, current-versus-historical asset revision, and two-stage commercial refresh.
6. Existing frozen-evidence, recovery-scope, commercial isolation, remote-edit, idempotency and last-good artifact protections remain active.

## Test evidence before release

- Repair-focused regression: 62 directly affected deployment/telemetry/production-state tests passed after the final telemetry lifecycle additions.
- Full repository suite: **701/701 PASS** in 37.450 seconds.
- `npm run check`: **PASS** (production Vite build, syntax and service-boundary gate).
- `npm run release:check`: **PASS**, 50 mandatory checks, 0 failures; fixed-SHA Frontend Contract, isolated API/UI smoke, schema migration chain and offline snapshot restore drill passed.
- Browser E2E at 390×844: long signed/tracking URL remained byte-identical, revision advanced, usage remained independent of events, no horizontal document overflow (`390/390`), and console errors/warnings were `0/0`.
- Browser request log contained only local health/dashboard/commercial GET/PATCH calls; no model or WordPress request occurred.
- Historical production-copy commercial replay: 7 requested / 7 found / 7 protected; body, visual and WordPress identity hashes unchanged; 0 model and 0 WordPress calls. The copy's inventory was historical and currentness was not asserted.
- Production baseline before deployment: app `2.0.31`, strategy `3.5`, schema `71`, integrity `ok`, foreign-key errors `0`, Sources `74`, drafts `8`, jobs `14701`, active jobs `0`, failed jobs `1112`, model-call rows `6050`, WordPress publication rows `7`.

## v1.1 acceptance matrix

`PASS` means the applicable deterministic, SQLite, mock-provider or browser contract passed. External provider and live WordPress assertions are listed separately and are never inferred from mocks.

| ID | Result | Evidence |
| --- | --- | --- |
| E01 | PASS | Evidence-node reconciliation accepts equivalent adjacent/combined assertion structure. |
| E02 | PASS | Audience/value swaps remain blocking mutations. |
| E03 | PASS | Typed currency, duration and floor normalization share page/body rules. |
| E04 | PASS | Negation inversion blocks; ambiguity remains bounded review. |
| E05 | PASS | Frozen revision evidence stays authoritative while live differences are separate. |
| E06 | PASS | Changed protected values and unmapped assertions remain blockers. |
| E07 | PASS | AST, page, QA and read paths retain one frozen revision; GET is read-only. |
| E08 | PASS | Missing frozen scope does not silently substitute live Knowledge. |
| E09 | PASS | Recovery run/owner propagates through retries, cache and child work. |
| E10 | PASS | Missing historical correlation is `unknown`, never fabricated attempt zero. |
| C01 | PASS | Asset scope impact includes matching consumers and excludes unrelated scope. |
| C02 | PASS | Semantic no-op creates no revision, overlay, task or external write. |
| C03 | PASS | URL/title/validity edits change content identity and retain old versions. |
| C04 | PASS | Scope edits calculate the union of old consumers and new matches. |
| C05 | PASS | Delivery refresh dedupes/serializes a draft under the latest confirmed inventory fingerprint. |
| C06 | PASS | Contract-native commercial components validate without rewriting editorial content. |
| C07 | PASS | Asset and embed validation rejects invalid boundaries before replacing the last good version. |
| C08 | PASS | Commercial replay preserves body/evidence/media and performs zero model calls. |
| C09 | PASS | Invalid new final candidate remains diagnostic; last-good artifacts are not relabeled. |
| C10 | PASS | WordPress identity/idempotency tests cover timeout and ambiguous remote outcomes. |
| C11 | PASS | Published, externally edited and identity-conflicting posts are not overwritten. |
| C12 | PASS | Disable/expiry/category/scope changes retain version history and identify old consumers. |
| R01 | PASS | Recovery confirmation binds target, revision and dependency fingerprint; stale confirmation is 409. |
| R02 | PASS | Superseded media failures do not reappear after later delivery recovery. |
| R03 | PASS | Current damaged required media blocks commercial refresh without silent regeneration. |
| R04 | PASS | Durable job/operation lineage distinguishes new work from historical projection. |
| R05 | PASS | Automatic, manual, deferred and cache paths retain owner/run/scope. |
| R06 | PASS | Editorial delivery and later commercial-update states remain separate. |
| R07 | PASS | Repeated/concurrent refresh uses atomic activity checks and fresh inventory confirmation. |
| A01 | PASS | Edit retains asset ID, omitted fields and exact tracking parameters; reload returns revisioned data. |
| A02 | PASS | Stale revision is 409; missing ID is 404 and never creates an asset. |
| A03 | PASS | Operational disabled/expired assets remain available from management reads; task history is retained. |
| A04 | PASS | Usage derives from slots/receipts with selected, delivered and DOM states independent of events. |
| A05 | PASS | Distinct article and slot counts use the same frozen asset revision in both directions. |
| A06 | PASS | Missing remote DOM evidence is `unknown`; storage receipt is not promoted to DOM proof. |
| A07 | PASS | Old delivered URLs retain the old asset version/hash after an edit. |
| A08 | PASS | Desktop/mobile edit, usage and impact flow passed; long URL did not overflow. |
| A09 | PASS | Admin auth, safe URL/embed validation, remote conflict and preview fingerprint tests passed. |
| A10 | PASS | GET endpoints are read-only/paginated and create no job or paid call. |
| D01 | PASS | Outer/subcode/path/schema/keyword/asset/slot/contract details persist through DTO/UI-safe diagnostics. |
| D02 | PASS | Final-page deterministic failure precedes media upload/provider/WordPress work and creates no model row. |
| D03 | PASS | Failure candidate hashes and original contract/input identities persist without replacing last-good artifacts. |
| D04 | PASS | Local validation is `not_applicable`; mixed/legacy missing evidence remains `unknown`. |
| D05 | PASS | Provider-response evidence remains sent even without remote request ID or token usage. |
| D06 | PASS | 400/403/429/503 retain original HTTP reason; 429 is not labeled quota exhaustion without evidence. |
| D07 | PASS | Transform and QA calls retain their own actual models/substages; job attempt and call counts are separate. |
| D08 | PASS | Transform 1 + QA 429 + QA success uses one immutable candidate and does not regenerate. |
| D09 | PASS | Conclusive four-dimension QA detail is retained and candidate stays non-public; retry remains slot-bounded. |
| D10 | PASS | Transform failure/invalid bytes create no resumable candidate. |
| D11 | PASS | Controlled fetch/Retry-After tests bound real HTTP attempts without paid waits or nested visual retries. |
| D12 | PASS | Resume, missing bytes and hash mismatch are tested; stale fingerprints/leases cannot promote a candidate. |
| D13 | PASS | Job ID, attempt, recovery scope and actual call times drive current/history labels. |
| D14 | PASS | Jobless historical review remains legacy unknown and does not manufacture telemetry. |
| D15 | PASS | Local gate=`not_attempted`, durable dispatch=`unknown` until completion, cache=`cache_hit`. |
| D16 | PASS | Safe diagnostic redaction and mobile technical/asset views passed; GET stays side-effect free. |

## Risk-based Definition of Done

| Layer | Status |
| --- | --- |
| L1 Targeted Tests | PASS |
| L2 Module Regression | PASS; 701/701 plus build/static/service boundaries |
| L3 Production DB Replay | PASS on isolated historical production copy; current-production migration rehearsal is part of the release gate |
| L4 Browser E2E | PASS on local 390×844 admin flow; live production browser smoke pending deployment |
| L5 Real Provider Canary | PENDING bounded production-copy canary; no result inferred from mocks |
| L6 Full Production-Like Replay | PASS for offline release gate and isolated capture/API/UI/backup replay; real external writes disabled |
| Post-Fix Exploratory Audit | PENDING post-deployment read-only comparison |

## Release and rollback

The DATA_MIGRATION release uses the immutable image and `upgrade-existing.sh`: paired system backup, hash verification, offline restore drill, schema rehearsal on the actual backup, production migration, opportunity gate, original-media/env hash check, isolated container readiness, then network switch. The prior stopped container/image and verified paired snapshot remain the rollback unit. No historical recovery or WordPress content write is part of deployment.

If the new container fails before exposure, the helper restores the paired old database/files and old container. After exposure, rollback stops traffic/writers and preserves the new database/files before restoring the prior code plus its paired snapshot; schema markers are never lowered in place.

Deployment evidence and the final L1–L6 statuses are appended after the immutable production rollout.
