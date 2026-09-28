# A1 local binding repair and writer capability snapshot

2026-09-27. **A1_CHECKPOINT / PARTIAL / STOPPED / NOT_READY_FOR_A2**.

This is the latest continuation of `a1-readback-checkpoint.md`. Stage 01 and 02-PRE local acceptance remain valid. The archived v1.4 specification and all 68 requirements / 90 cases remain authoritative; A1 is not locally accepted.

## Identity and scope

- CMS root: `C:\Users\Mloong\Documents\ChatGPT\solo-to-china-CMS`; origin `https://github.com/Weapon-Tsang/solo-to-china-CMS.git`; main; HEAD `e9f7c8e82ff760f4d18f2d2e0673452eb8744290`.
- Windows / PowerShell / Node 24.14.0; app 2.0.70; schema 81. Binding policy advances to `source-media-binding-3`; no migration. Earlier policy rows require current scoped repair, not silent trust.
- Existing stage 01 / 02-PRE / A1 dirty worktree preserved. No reset/clean/stash/pull/commit/push. Current hashes are in `a1-repair-files.json`, not an instruction to restore an older hash.
- Historical 57 tests / 627 relations / five-width context viewer were read as prior evidence, not attributed to this run. New tests below executed approximately 12:28–12:48 UTC.

## Implemented

1. **BIND-002/003/010:** `supplementMediaContext` automatically reads retained local evidence, at most six reads / 36,000 additional characters per image. Captions and explicit image references are prioritized; locators, omitted ranges, exhaustion and counts persist in occurrence context. Exhaustion stays pending; partial quotes cannot confirm a relationship. This serves deterministic binding repair, not automatic Provider continuation.
2. **BIND-001/009/010:** authenticated `GET /api/source-assets/:id/binding-repair` previews old/new relationships, reason counts, local steps and up to 100 directly referencing article slots with `has_more`. `POST` requires `apply=true` and the exact preview hash, rechecks in a transaction and repairs the current asset only. Changes in evidence, aliases or reported slot state reject the preview. Auth/Origin/invalid request/stale DB cases are tested.
3. **BIND-009:** revoked asset/entity/type relationships remain revoked across context and policy changes. Automatic repair cannot reverse them. New reconfirmation and article-lock lifecycle is still pending.
4. **BIND-002/009:** image position participates in context fingerprints; reordering cannot reuse old positional evidence. Pixel analysis and original bytes remain unchanged.
5. **BIND-008:** `mediaAvailabilitySnapshot` carries supplied candidates, source/byte/capture identity, verified relationships, allowed uses, prohibited inferences, known record-level gaps and pagination boundary. It reaches planning/article-bundle input, freezes in writing-packet context and survives the legacy draft DTO. Frozen input never borrows a later live snapshot. Fixed the old DTO dropping bindings and the brief DTO omitting original receipt fields. This is not complete inventory/route acceptance.
6. **BIND-011, narrow guard:** PDF visual assets can have `kind=image`; MIME now prevents PDF photo repair and binding-based photo matching. Availability/UI report `PDF_ASSET_NOT_MATERIALIZED`. No embedded-image extraction or bound upload fallback has been implemented.
7. **CMS UI:** source detail → image → “检查来源关系” → evidence/diff → “按此预览修复关系”. Errors and pending evidence remain visible; stale previews disappear. This repairs source evidence, not article adoption, body text, frozen plans, model budgets or jobs.

## Verification actually executed

Classes: **DATABASE_LOGIC + LOCAL_LOGIC + UI_ONLY + AI_PROVIDER (writer input contract)**. Real calls prohibited.

| Layer | Result | Actual coverage |
|---|---|---|
| L1 | PASS | Final 75/75, `a1-repair-closeout-tests.log` |
| L2 | PASS, scoped | Eleven affected test files below; `npm run check` exit 0, `a1-repair-final-check.log`; diff check passes with existing CRLF warnings |
| L3 | PASS, scoped | Existing disposable work DB: 84 sources, 1,364 images, 627 relations; dry/apply equality, current read validation, protected rows unchanged, idempotence, full transaction rollback. `a1-repair-final-replay.json` |
| L3 writer read audit | PASS, scoped | Read-only 12 Brief / 12 frozen packet DTOs; 1,652 entries across packages, not unique images. `a1-availability-replay.json` |
| L4 | PASS, scoped | Actual local API + Edge, 320/390/768/1024/1440 px, preview/apply/keyboard/stale reload/PDF rejection. `a1-repair-browser-closeout.log` |
| L5 Real Provider | NOT TESTED | Mock payloads do not prove Provider acceptance or image semantics |
| L6 Full Production Replay | NOT TESTED | No complete route/media/adoption/WordPress chain |
| Exploratory audit | PASS, scoped | Position invalidation, cross-revision revocation, frozen/live separation, FK/orphan/stale-confirmed checks, preserved jobs/call records/body/visuals |

```powershell
node --test test/media-binding-repair.test.mjs test/media-context.test.mjs test/media-bindings.test.mjs test/media-context-api.test.mjs test/media-availability.test.mjs test/content-engine.test.mjs test/article-bundle.test.mjs test/publication-eligibility.test.mjs test/pipeline.test.mjs test/media-analysis.test.mjs test/frontend-localization.test.mjs
npm run check
node scripts/stage02-binding-repair-replay.mjs D:/cms-phase02-media-replay-xiKzH1/work.sqlite
node scripts/stage02-availability-read-audit.mjs D:/cms-phase02-media-replay-xiKzH1/work.sqlite
node scripts/stage02-context-browser-fixture.mjs D:/ --repair
npx --no-install --package @playwright/cli playwright-cli -s=a1repair open <reported-loopback-url> --browser msedge
npx --no-install --package @playwright/cli playwright-cli -s=a1repair snapshot
npx --no-install --package @playwright/cli playwright-cli -s=a1repair run-code --filename=scripts/verify-stage02-binding-repair-browser.js
git diff --check
```

Replay reuses the prior source→baseline→work lineage. Only work DB transaction writes occur, then rollback and fingerprint comparison. No new database copies or performance benchmarks. Historical long-context supplementation count is **zero**; that new behavior is proven by fixtures only. Historical 18,415 jobs and 6,453 model metrics are unchanged, not new calls. No media-byte semantic inspection.

Browser failures retained: initial stale-URL connection refusal after stopping a fixture; two `Session closed` failures from verifier request listener. Replacing its sandbox-unavailable URL constructor with string extraction resolved the listener issue. Final run has zero page exceptions; the two resource errors are deliberately injected stale 409 and real PDF 409. Screenshots: `output/playwright/phase02-binding-repair-{320,390,768,1024,1440}.png`; 320px visually inspected. Physical devices/full screen-reader/axe audit NOT TESTED.

## Exact remaining requirements and next actions

| IDs | Remaining actual behavior | Next action / acceptance |
|---|---|---|
| BIND-001/012 | Complete candidate/slot rejection taxonomy and counts; current preview covers one asset/direct visual references, not every frozen packet. Record-level flags do not inspect actual bytes. | Scoped audit distinguishing ORIGINAL_MISSING, BYTES_INVALID, RETRIEVAL_MISS, MATCH_REJECTED, SLOT_TOO_SPECIFIC and binding causes; T02-33/34/45. No menu-wide scans. |
| BIND-002 | Complete DOM/PDF page/object/region occurrence locators | Carry existing provenance into context; T02-35/37/43. Text readback and UI are already implemented. |
| BIND-003/010 | Provider realtime/batch/reanalysis bounded context continuation and budget/version handling | Capture actual mock payloads for omitted-context cases; T02-35/38/43. Deterministic repair supplementation is implemented; paid semantic supplementation remains disabled. |
| BIND-004/005/007 | Five relation types are allowed by schema, but automatic repair produces source_asserts_location only; explicit conflict evidence remains incomplete | **First next action:** implement typed relation/evidence validation in `src/repositories/media-bindings.mjs`; add T02-36/39/43 persistence/matching positives and negatives. Keep generic observations separate; unknown is not contradiction. |
| BIND-006/008 | Full relevant unavailable/unindexed inventory, entity-only planning selection, every explicit operator-ID bypass | Test claim-free entity retrieval and IDs beyond budgets through actual planning requests (T02-40/41/44). Snapshot currently describes supplied candidates only. |
| BIND-009/010 | Reconfirmation audit, article locks, new media revisions and frozen-plan repair consumption | A1 exposes immutable evidence and scoped diagnostic inputs; D owns MUP-006/008/009 confirmation/CAS/outbox/revisions, T02-50/57/58/60. Current source repair must not be labeled article adoption. |
| BIND-011 | Independent PDF image materialization or explicit unsupported capability plus usable bound fallback | Inspect existing PDF object/page inventory; extract bounded assets with original PDF hash/page/region or record unsupported; T02-46. D owns article/slot upload UI, MUP-001/002. MIME rejection alone is not full acceptance. |
| BIND-012 | Final typed relation diagnostics/metrics and affected backup fields | Regress only new fields/tables and review restore (T02-45/63). D/A2 retain upload/route restore T02-67/70/85. |

Integration ownership, not waived: A2/ROUTE-003–009 consumes availability with approved route identity; B/MEDIA owns real independent bytes/derivatives; C/COVER/CONTRACT owns purpose and receiver compatibility; D/MUP-006–009 owns operator adoption/revisions/resume. These are not A1 independent passes and were not implemented early. All full T02 rows remain unaccepted unless exact complete evidence exists.

## Handoff

No final failing application test is known in this slice. A2 is blocked by **unimplemented A1 behavior**, not by L5/L6 permission. This is a context checkpoint, not completion: next conversation continues **A1**, starting with typed relationships/conflicts, then the remaining table. Do not enter A2 or stage 03.

Before final handoff, all owned fixtures are stopped with their STOP markers and browser `a1repair` is closed. User services untouched; work DBs remain outside Git. Side effects: commit=no; push/merge=no; deployment/Cloud Build=no; production read/export/write=no; real model/Batch=no; WordPress write=no; public frontend edit=no.

`current_authorized_step=NONE`

`phase_end_stop=true`
