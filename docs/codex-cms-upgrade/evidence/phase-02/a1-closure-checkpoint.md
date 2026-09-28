# A1 remaining-function continuation checkpoint — 2026-09-27

**A1_CHECKPOINT / PARTIAL / NOT_READY_FOR_A2**. This checkpoint supersedes earlier remaining-work lists only for the behaviors below. It does not accept phase 02 or authorize A2. Preserve all 68 requirements and 90 tests in the acceptance matrix.

## Code identity and authorization

- Root: `C:/Users/Mloong/Documents/ChatGPT/solo-to-china-CMS`; branch `main`; HEAD `e9f7c8e82ff760f4d18f2d2e0673452eb8744290`; origin `https://github.com/Weapon-Tsang/solo-to-china-CMS.git`.
- App 2.0.70, schema 81 unchanged; relationship policy `source-media-binding-4`.
- DEVELOPMENT only. No commit, push, cloud build, deployment, production export/write, WordPress write, paid Provider request or remote Batch submission. Earlier dirty work is preserved. The full working-tree diff includes earlier work and must not be attributed to this continuation.
- Input archived at `../../phases/phase-02-a1-remaining-v1.0-20260927.txt`.
- Prior `a1-repair-checkpoint.md` remains byte-identical: SHA-256 `90432a758c7d9e285a66e38448200b54d9744813955f0aa900a00a513da2b819`.

## Implemented, usable behavior

| Requirements / cases | Actual implementation and coverage |
|---|---|
| BIND-004/005/007; T02-36/39/43 | Five typed source relationships pass through preview, persistence, read validation and usage matching. Source assertions remain distinct from pixel evidence. Directly scoped positive/negative evidence creates conflicts; an unrelated negation or two different positive place names does not. Byte-identical current peer occurrences are bounded and checked for explicit contradictions. Negative-only evidence remains a candidate veto. Conflicts and historical revocations block high legacy scores and publication even when old slots have no binding IDs. |
| BIND-002/003/010; T02-35/37/38/43 | Actual retained DOM/PDF provenance is preserved without invented locators. One request shares a finite supplement budget of six reads / 36,000 extra characters across its assets. Supplemented evidence reaches actual realtime, Batch and reanalysis adapter payloads in mock-transport tests. Frozen context is reused. Existing unknown-submission quarantine and poll-with-frozen-model regressions pass. |
| BIND-001/006/008/012; T02-33/34/40/41/44/45 | Canonical entity/alias retrieval works without a contributed claim. Explicit IDs bypass the automatic 160-asset and 12-preview caps, including actual repair of the 181st existing slot. Whole-request overflow fails explicitly rather than silently losing selected IDs. Bounded unavailable/unindexed inventory is included in planning and writer snapshots; automatic pagination and remaining unknown inventory are explicit. Unindexed caption recall does not persist fabricated confirmed relationships. |
| BIND-001/012; T02-44/45 | Authenticated per-asset diagnostic API and Source UI inspect actual local-file presence, hash/signature and image metadata, scoped binding evidence, direct article slots and frozen packet references. Asset reason counts and slot counts have different units. Unchecked scopes and overflows are explicit. The file inspection limit is 32 MiB and metadata inspection is bounded at 40 million pixels; this does not claim complete pixel decoding. Missing files, invalid files, unavailable/unindexed material, retrieval misses and overly specific slot requirements are distinguished. |
| BIND-009/012; T02-42/45/63 | Existing CAS preview/apply, immutable rows, cross-revision revocation and original text/job protection retained. Restore regression now round-trips multiple relationship types. Historical transactional replay verifies idempotence and rolls back all changes. |
| BIND-011; T02-46 — PARTIAL | PDF diagnostics preserve actual parent hash and retained page/object/region locators where available. PDF remains document evidence, never an independent photograph because of an image-like kind or a converted extension. API/UI explicitly report unsupported independent extraction and that article/slot upload is not yet implemented; the capability includes source/capture identity for later binding. This is not an operational fallback upload flow. |

## Exact remaining acceptance boundaries

1. **BIND-011 / T02-46 remains an A1 blocker.** Existing `extractPdfDocument` reads text and flags visual operators per page; it does not retain a reliable independent-object/region inventory. This continuation does not add a generic PDF extraction system or classify full-page renders as photographs. No independent extracted asset was produced or validated. The diagnostic capability contract is implemented, but the required usable bound supplement path is not. Next executable work: implement a narrowly bounded supported embedded-raster path with real PDF fixtures and parent/page/object/file provenance if reliable using the existing parser, or complete the approved bound-supplement dependency in its authorized stage. Until one complete permitted path has evidence, do not mark T02-46 PASS or enter A2.
2. **D-owned MUP-001/002/006; T02-47–49:** article/slot upload, adoption and revision lifecycle are not implemented by the Source relationship-repair POST. Do not relabel that POST as article adoption. D work was explicitly excluded from this continuation.
3. **A2 integration of BIND-001/006/008/012; T02-33/34/40/41/44/45:** local repository/planning/writer and diagnostics subcases have evidence, but the complete route/product lifecycle is not executed. Selected/frozen slots remain subject to that integration. No whole-case PASS is inferred from these narrower tests.
4. **BIND-002/003/010; T02-35/37/38/43:** actual transport payload construction is tested with a mocked external boundary, not real Provider acceptance or quality. Historical replay happened to require zero supplemental reads; long-context behavior is covered by synthetic adapter payload fixtures. No paid-model evidence is claimed.
5. Whole-case T02-43 malicious-input/provider behavior and complete downstream lifecycle, T02-45 full product funnel, and T02-63 complete phase-wide restore remain outside the demonstrated subcases. Existing regression coverage must not be presented as whole-phase acceptance.

## Verification and reproducible evidence

| Layer | Status | Actual scope / evidence in this directory |
|---|---|---|
| L1 Targeted Tests | PASS | Affected relationship, context, availability, diagnostic API and repair regressions included in the final module run. Additional one-case actual mocked payload capture: `a1-closure-provider-payloads.log` and `.json`. |
| L2 Module Regression | PASS | 99/99, zero failures/skips: `a1-closure-complete-module.log`. Includes binding/repair/context/API/availability/content engine/article bundle/publication/pipeline/media/localization/Vertex Batch tests. `a1-closure-complete-check.log`: npm run check PASS. |
| L3 Production DB Replay | PASS, scoped historical copy | `a1-closure-acceptance-replay.json`: existing disposable work DB, 84 sources, 1,364 image assets, 627 relationship rows. Preview/apply equality, live validation, idempotence, protected rows, foreign keys, no orphan/stale-confirmed bindings and rollback restoration all PASS. No new production read/export. |
| L3 Availability audit | PASS, read-only | `a1-closure-final-availability-replay.json`: 12 Brief packages, 12 frozen packets, 1,748 live candidate entries, zero model calls. Entries are not unique images. This verifies DTO/read behavior, not real generation or semantic image quality. |
| L4 Browser E2E | PASS, scoped local fixture | `a1-closure-acceptance-browser.log` and `a1-closure-acceptance-diagnostics-browser.log`: 320/390/768/1024/1440 widths, Source preview/apply/keyboard/stale UI/PDF rejection and real diagnostic API interactions. Stale UI response injection is supplemented by real API CAS tests. Expected deliberate 409 responses are not unhandled page failures. Screenshots under `output/playwright/phase02-media-diagnostics-*.png`; narrow screenshot visually inspected. Not the D upload or A2 route flow. |
| L5 Real Provider Canary | NOT TESTED | Not authorized; zero paid Provider calls. |
| L6 Full Production Replay | NOT TESTED | Not authorized; no whole route, article-adoption or WordPress production chain. |
| Post-Fix Exploratory Audit | PASS, scoped | Found and fixed unrelated-negation overreach, high-score conflict bypass, revoked binding lost after caption removal and truncation of the 181st existing slot. Permanent regressions added. Historical relationship integrity and downstream protected row counts verified. |

Historical protection includes 1,454 total assets, 90 analyses, 5,334 claims, 12 drafts, 26 visuals, 12 writing packets, 18,415 jobs, 6,453 model-call metrics and 12 WordPress publication records. Replay modifies only the disposable work transaction and restores its prior state. Final per-image reason buckets: 121 ambiguous, 1,180 evidence missing, 32 entity unresolved, 28 source supported, 3 candidate. These are not counts of production failures or a claim that every source is suitable for a photo slot.

## Continuation and stop state

The independent PDF path remains incomplete; **A1 is PARTIAL and NOT_READY_FOR_A2**. Continue from BIND-011/T02-46 without redoing completed typed relations, Provider context or core retrieval work. Existing phase 01 / 02-PRE conclusions remain intact. No A2/B/C/D or phase 03 implementation is authorized by this checkpoint.

- `current_authorized_step=NONE`
- `phase_end_stop=true`
- Final process cleanup and code fingerprint evidence: `a1-closure-files.json` and `a1-closure-cleanup.log`.
