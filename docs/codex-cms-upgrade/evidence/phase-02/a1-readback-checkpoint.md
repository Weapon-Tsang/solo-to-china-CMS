# Phase 02 v1.4 — A1 context readback continuation

2026-09-27. Status: **BLOCKED_CONTEXT / A1_CHECKPOINT / NOT_ACCEPTED / STOPPED**.

This is another bounded A1 implementation, not completion of A1 or phase 02. The complete 68 requirements and 90 cases in `../../phases/phase-02.txt` and `../../acceptance/phase-02.md` remain authoritative. The input attachment is byte-identical to the saved specification (SHA-256 `d4c223aac6b29b0c6b65fda7d70d8925ef37bfa6faf038f75d2dffe5c37b39c1`); it was not rewritten. The specification explicitly permits a context checkpoint; remaining scope is preserved below. Continue in a new conversation in the same CMS workspace with the same complete TXT, not phase 03.

## Identity and prerequisites

- Root: `C:\Users\Mloong\Documents\ChatGPT\solo-to-china-CMS`; remote `https://github.com/Weapon-Tsang/solo-to-china-CMS.git`; branch `main`; HEAD `e9f7c8e82ff760f4d18f2d2e0673452eb8744290`.
- Windows, PowerShell, Node 24.14.0; application 2.0.70, local schema 81. Binding policy advances from `source-media-binding-1` to `source-media-binding-2`; no new schema migration or external contract version change.
- Existing phase 01, phase 02 A1 and 02-PRE uncommitted changes were preserved. Only the incremental work described here belongs to this continuation; do not attribute the entire Git diff to it. Final file hashes are in `a1-readback-files.json`.
- Latest phase 01 local acceptance and 02-PRE local browser acceptance permit this isolated development. The older `BLOCKED_02_PRE_EVIDENCE` note is historical and superseded. User-installed extension and production remain unverified.
- Initial prerequisite regression: `node --test test/media-context.test.mjs test/media-bindings.test.mjs test/local-runtime.test.mjs test/extension-run-control.test.mjs`, 42/42, exit 0. This does not rerun or recertify all of stage 01.
- DEVELOPMENT only. Real-model requests are expressly unauthorized by the phase specification. C: had about 0.77 GB free at inspection, so the historical replay and retained browser fixture use D: outside Git.
- Recorded test execution spans approximately 11:53–12:11 UTC (19:53–20:11 Asia/Shanghai); initial specification reading preceded these logs.

## Implemented and corrected

1. `src/media-context.mjs` now supports bounded retained-evidence readback. Requests pin an occurrence context hash, choose source text/caption/nearby/alt and a UTF-16 offset, and receive at most 12,000 characters (default 4,000) plus the next offset. Metadata truncation also records omitted ranges. Invalid fields/ranges are rejected; changed evidence returns `CONTEXT_STALE`. Source content remains untrusted evidence.
2. `Repository.readSourceMediaContext` and authenticated `GET /api/source-assets/:id/context` expose the packet and bounded ranges. Current assets use current source text; retained historical assets use their own capture record. Missing historical context is explicit. Reads enqueue no jobs, call no models and write no bindings.
3. The source detail now contains **图片与来源文字**: choose an image, choose the evidence field, page through retained text, or reload after an outdated fingerprint. Images are grouped by 12 without discarding image 13 and later. Requests abort on selection/unmount; errors are visible; text renders as text, not HTML. This is an evidence viewer, **not** the D/manual-upload workflow or a claim that all source-list data is server-paginated.
4. Binding reads now revalidate against current text/caption, byte identity, alias interpretation and binding policy before matching/publication. A context/alias edit fails closed before a repair job runs. A → B → A edits can restore the matching immutable evidence row; a revoked row is not revived. Scoped repair accepts current-source asset IDs only. Body text, pixel analysis and model budgets are not rewritten.
5. A general documentary-photo binding cannot certify a different destination, uppercase `ENTRANCE`, a map/diagram or a declared whole-day diagram use. These are narrow A1 guards; they do not implement the A2 route bundle or route consistency checks.
6. Exploratory auditing found repeated alias loading/normalization on binding reads. The alias catalog is now cached per database write generation, invalidated by this connection's writes or another connection's commits, and never cached during a transaction. Tests cover external-connection updates and rollback. Asset queries select context columns instead of loading unrelated payloads. Current text/metadata are still checked on every binding read.

## Verification

Change classes: **DATABASE_LOGIC + LOCAL_LOGIC + UI_ONLY**. This continuation does not change a model prompt/transport or request a new schema; earlier A1 AI_PROVIDER work still has its separate untested real-provider boundary.

| Layer | Result | Actual coverage |
|---|---|---|
| L1 Targeted Tests | PASS | Final 57/57 context/API/binding/publication/pipeline/media-analysis/frontend-localization tests; `a1-readback-final-targeted.log`. Final API cleanup guard retest 1/1: `a1-readback-api-final.log` |
| L2 Module Regression | PASS, scoped | The same affected module set plus `npm run check` exit 0 (`a1-readback-final-check.log`); no unrelated full-suite rerun |
| L3 Production DB Replay | PASS, scoped | Existing authorized historical local snapshot → isolated baseline → disposable work DB. 84 sources, 1,364 images, 627 bindings; no protected-row changes. Final code read-only dry-run compares all 627 with zero mismatches |
| L4 Browser E2E | PASS, scoped | Real local API and Edge via Playwright CLI; 320/390/768/1024/1440 widths, source open, image 1/13, previous/next evidence, caption change, keyboard activation, stale display and reload recovery. Does not cover MUP or route UI |
| L5 Real Provider Canary | NOT REQUIRED for this slice / NOT TESTED for phase 02 | No paid requests. Earlier unified model context contract remains unverified against a real Provider |
| L6 Full Production Replay | NOT TESTED | No route → media → manual-upload → WordPress business replay |
| Post-Fix Exploratory Audit | PASS, scoped | No FK violations, orphan bindings or stale-confirmed rows; exact persisted-vs-planned evidence comparison; alias cache invalidation and read cost checked. Not an audit of all system invariants |

Executed module command:

```powershell
node --test test/media-context.test.mjs test/media-context-api.test.mjs test/media-bindings.test.mjs test/publication-eligibility.test.mjs test/pipeline.test.mjs test/media-analysis.test.mjs test/frontend-localization.test.mjs
npm run check
git diff --check
```

All exit 0. `git diff --check` only reports existing line-ending conversion warnings. New files were inspected and syntax/build checked as appropriate. No new dependency was added.

### Historical replay and performance limits

```powershell
node scripts/stage02-media-binding-replay.mjs C:\Users\Mloong\AppData\Local\SoloToChinaStage01\baseline-20260923\database.sqlite D:\
node scripts/stage02-binding-read-audit.mjs D:\cms-phase02-media-replay-xiKzH1\work.sqlite
```

- `a1-readback-replay.json`: 627 proposed/persisted relations; 28 supported-image decisions, 121 ambiguous-image decisions, 3 candidate-image decisions. There are 596 ambiguous relation rows; these are different units. 18,415 jobs and 6,453 model-call records are preserved, not newly created calls. Source snapshot and local baseline hashes unchanged; second application idempotent; no Provider/WordPress connection.
- Final work directory is `D:\cms-phase02-media-replay-xiKzH1`; database copies remain outside Git. Previous checkpoints' databases are unchanged.
- `a1-readback-audit.json` preserves the first slow 30-sample measurement: P50 1,656.553 ms, P95 1,732.643 ms for a batch of **28** binding validations.
- `a1-readback-final-audit.json` preserves final 30 raw samples: P50 637.958 ms, P95 704.445 ms for that same batch; 28 accepted, 627 dry-run comparisons, zero mismatches. Intermediate results are also retained. The first sample includes cold alias compilation; later samples reuse it. This is a local relation-read measurement, **not** the stage 01 API/menu SLA or T02-67 upload-load benchmark. Larger candidate sets and real Worker load remain untested.
- Source supported does not mean visually identified or geographically verified. No image-byte semantic audit was performed.

### Browser reproduction and evidence

```powershell
node scripts/stage02-context-browser-fixture.mjs D:\
npx --no-install --package @playwright/cli playwright-cli -s=phase02context open <reported-loopback-url> --browser msedge
npx --no-install --package @playwright/cli playwright-cli -s=phase02context snapshot
npx --no-install --package @playwright/cli playwright-cli -s=phase02context run-code --filename=scripts/verify-stage02-context-browser.js
npx --no-install --package @playwright/cli playwright-cli -s=phase02context close
```

Use the fixture's reported `stopFile` to stop only that fixture; it also self-stops after 15 minutes. It creates a marked development data root, runs only an API process and uses synthetic source records. It never downloads the synthetic image URLs. The first setup attempt was rejected because the DB lacked a development identity marker; the script now marks its newly created directory before opening the DB. No production guard was relaxed.

Browser result: `a1-readback-browser.log`. Screenshots: `output/playwright/phase02-context-{320,390,768,1024,1440}.png`; 320/390/1440 were visually inspected. No page exception or horizontal dialog overflow occurred. An HTTP 409 is deliberately injected for browser error/reload behavior and appears as an expected browser resource console error; actual server staleness is independently tested by editing a fixture DB in the HTTP API test. This is not a physical-mobile-device test or an automated full accessibility audit.

## Remaining scope — not waived

- **A / PIPE:** full call graph/counting, shared media budget/retry/single-flight and all required-media gate cases still require systematic T02-01–08 acceptance. The current regression set does not certify the whole requirement set.
- **A1:** complete reason taxonomy and candidate/slot drilldown; actual operator binding repair/adoption workflow; bounded *automatic* missing-context supplementation (this slice provides local/API/UI evidence readback only); richer typed relationships and explicit conflict handling; PDF extraction or unsupported/manual-materialization path; complete pre-freeze media availability and all publication entrances. No new manual-confirmation lock system was implemented. Revocation tests in this slice concern the same immutable relation; cross-revision manual intent belongs to the remaining confirmation lifecycle.
- **A2:** route modes/fragments, approved route bundles, stop/leg occurrence identities, source/target hashes, evidence constraints, deterministic renderer, actual-text/diagram QA, version propagation, historical-body preservation and route/manual-upload UI are still incomplete/not accepted.
- **B/C:** master/derivative/WebP chain, independent cover selection/cropping, receipt reconciliation, fixed contract capability mapping and cover/body refresh checks remain unaccepted against the complete specification.
- **D:** manual upload UI/API/chunk sessions, no business-count cap, actual 101 valid images/large-image cases, streaming memory tests, adoption CAS/revisions/outbox, local continuation, budget inheritance, current-page media receipts, backup/review restore and load measurements remain incomplete. Source image browsing is not manual supplementation.
- **External:** real Provider, real local PHP/WordPress and deployed receiver capability proofs remain NOT TESTED. No new authorization was requested or inferred. Keep affected production features disabled until the relevant exact-scope gates are met.

## Side effects and handoff

Commit: no. Push/merge: no. Deploy/Cloud Build: no. New private production read/export: no. Paid model/image/Batch: no. Production WordPress write: no. Production migration/backfill/enablement: no. Cloud stop/delete or R2 work: no. Independent frontend repository modification: no. Only local fixture/work-copy writes and CMS source/doc edits occurred.

The named Playwright browser was closed; the fixture at `D:\cms-phase02-context-browser-AYi85V` was stopped via its own STOP marker and exited. Replay/audit/test commands finished; no user service was stopped. Fixture data and replay databases remain outside Git. Rollback must revert only this continuation's changes using its scoped inventory and preserved earlier files; do not reset/clean/stash the shared worktree. Do not roll a schema-81 database back into an older unsupported app.

`current_authorized_step=NONE`

`phase_end_stop=true`
