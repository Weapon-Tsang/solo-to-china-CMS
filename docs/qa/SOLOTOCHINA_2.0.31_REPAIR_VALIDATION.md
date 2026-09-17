# SoloToChina 2.0.31 Repair Validation

Date: 2026-09-16 (Asia/Shanghai)

This record implements the development scope in `SoloToChina_v2.0.30_Repair_Prompt_v1.2.txt` on top of the supplied, unchanged repository baselines. It does not claim a production release or a repair of the seven production drafts.

## Boundary and baseline

- CMS repository: `codex/audit-v1.3`, starting HEAD `b4c6f929feb9f05242e49d575b523ebb7c0b8736`.
- Frontend repository: `main`, starting HEAD `b282da52ee27c25147ea375477ee56f9d3aec40b`.
- CMS version after the development change: app/extension `2.0.31`, schema `71`, Content Strategy `3.5`.
- Frontend version after the development change: Parent `0.33.4`, Child `0.12.1`.
- No reset, commit, push, Cloud Build, deployment, production migration, production backfill, production database write, or production WordPress write was performed.
- The pre-existing Frontend modification in `docs/qa/evidence/release-artifacts.json` was preserved and was not treated as this repair's work.
- The local `data/solo-to-china.sqlite` is a development database with 3 Sources and 0 drafts. It is not a current production copy.

## Modules 0–12: implementation result

| Module | Development result |
| --- | --- |
| 0–2 | Baselines, permissions, old fixes, handoff and prior validation were checked. Tests are separated into local, historical replay, browser, provider and current-production layers. |
| 3 | Schema 71 adds capture-versioned `source_asset_analyses`. SQL reads, writes, hydration and decision DTOs now carry asset kind, region roles, text/photo/entity/UI regions, subjects, per-region languages, reader-text status, confidence and analysis identity. Unknown/high-resolution images must be analyzed instead of defaulting to text-free photos. |
| 4 | Planned, fallback and repair paths use the shared image decision. `design` no longer matches `sign`; natural signs can remain while author overlays in a storefront collage are localized. Separate transform prompts implement photo retain, photo-overlay localization, editorial-card recompose, collage recompose, map/route handling and illustration generation. |
| 5 | `sharp` performs full decode and pixel-budget checks. Binary, language, completeness, style and semantic QA are independent. Transformed images require a separate structured visual review; untested fields remain `not_tested`. Final identity includes output bytes and transform identity and never overwrites an old byte identity. |
| 6 | Mobile TOC is native `details/summary`, vertical and wrapping. Child `article.css`, `content-components.css`, Parent markup and versioned enqueue paths changed. Breadcrumb, header, footer and single-column minimum sizing were also corrected for 200% text. |
| 7 | Versioned `commercial-policy.json` implements contextual action plus one optional destination planning resource. Link-task score 70 does not gate an existing eligible asset. Empty outcomes and inventory exclusions are explicit; unknown traffic/revenue is not fabricated. |
| 8 | Delivery refresh now has a real `media` scope. It computes per-slot byte/analysis/QA fingerprints, can repair an equal-count bad slot, preserves qualified slots/body/page/post identities, and rejects stale late results. CLI targets are explicit whitelists and never create a missing database. |
| 9 | Permanent regressions cover real SQL DTO hydration, high-resolution unknown images, bounded sign matching, mixed collage regions, equal-count media repair, candidate recall beyond 24, full decode, independent QA, commercial policy/config, and the first-colon semantic component rule. |
| 10 | Analysis, recompose, photo-overlay and independent QA prompts are connected to the production pipeline, not stored as labels only. |
| 11 | This report records executed and unexecuted layers, historical seven-draft accounting, media dry-run, browser evidence and release/rollback boundaries. |
| 12 | Existing preview, publish, source/evidence, approval, lease, idempotency and draft-only boundaries remain covered by the full suite and Frontend runtime gate. |

## Main code paths

- Schema and DTO: `src/db.mjs`, `src/repository.mjs`, `src/ai/kimi.mjs`.
- Media execution and QA: `src/pipeline.mjs`, `src/visuals/vertex-imagen.mjs`.
- Scoped repair: `src/services/delivery-refresh.mjs`, `scripts/repair-content-delivery.mjs`.
- Commercial policy and replay: `config/commercial-policy.json`, `src/config.mjs`, `src/commercial.mjs`, `scripts/audit-commercial-replay.mjs`.
- Semantic component fix: `src/content-blocks.mjs`.
- Frontend TOC and reading styles: Parent `functions.php`, Child `assets/css/article.css` and `assets/css/content-components.css`.

## Test evidence

### CMS

- Targeted cross-module regression: **64/64 PASS**.
- Full repository suite: **674/674 PASS** in 38.998 seconds.
- `npm run check`: **PASS**; Vite production build and service-boundary check passed.
- Schema 59→71 deployment rehearsal test: **PASS** with preserved old rows/IDs and rollback guard.
- Schema 70→71 additive integration: **PASS**; `source_asset_analyses` persisted and hydrated through a real SQLite query, integrity `ok`, zero foreign-key violations, and no job/data rewrite.

### Frontend and browser

- `verify-upgrade.ps1 -BaseUrl http://127.0.0.1:9420`: **PASS** on the real Parent/Child theme in WordPress Playground PHP 8.3 / WordPress 7.0.4.
- Final static checks after the 200% text repair: Content Contract **PASS**, project verification **PASS**. Local PHP CLI was unavailable; actual PHP-WASM runtime checks passed.
- Browser widths 320, 360, 375, 390 and 430 CSS px: vertical item tops, 16px link text, `white-space: normal`, no TOC overflow and no document overflow.
- At 320px with the root font enlarged to 200%: document width 320, hero width 320, content width 320, no TOC or document overflow.
- JavaScript-disabled public page: H1, disclosure summary, all four TOC links and 1,844 characters of main content remained available.
- Local unthrottled 390×844 sample: 21 resources / 434,603 transfer bytes; 3 image requests / 122,522 bytes; 2 lazy images; DCL 887.5ms, load 901ms, observed LCP 864ms and CLS 0. These are local simulation results, not real iPhone/Android or production-network measurements.

Browser evidence:

- Before: `../solo-to-china/docs/qa/evidence/upgrade-article-390.png` shows the prior horizontal pill TOC (Parent 0.33.0 / Child 0.12.0 evidence set).
- After: `../solo-to-china/output/playwright/toc-after-320.png`, `toc-after-390.png`, `toc-after-430.png`.
- Enlarged text: `../solo-to-china/output/playwright/toc-after-320-text-200.png`.

## Four named image samples

The attachment names `IMG_2897.jpeg`, `IMG_2898.png`, `IMG_2899.jpeg`, and `IMG_2900.jpeg`, but those files were not attached and a recursive check under the supplied Download directory found none of them. The historical database contains server-only `/var/lib/solo-to-china/source-uploads/...` paths; their image bytes are not present in this workspace. The local `.env` has Kimi configuration but no Vertex/Google image credentials.

Therefore the four per-image chains—original → image-level analysis → real transform → independent language/completeness/style/semantic QA → final media → page slot—are **NOT TESTED**. Mock provider and generated local PNG/WebP tests passed, but are not reported as R49 evidence.

## Seven-draft commercial replay

Current production inventory and current WordPress readback are **NOT TESTED**. The following is explicitly a historical production-copy replay, not a statement about current inventory. The clean source was `production-2.0.23-replay.sqlite`; a disposable copy was migrated to schema 71. The audit used seven repeated `--draft` arguments, and reported `requested=7`, `found=7`, `audited=7`, `protected=7`. Inventory in that historical copy was 1 provider, 4 assets, 0 operational destination candidates; `currentness=not_asserted`.

| Historical draft | Intents | Inventory / eligible / selected / composed | Historical reason | Historical WP ID |
| --- | ---: | --- | --- | ---: |
| 3-Day Walking, `draft_3593…` | 8 | 0 / 0 / 0 / 0 | `asset_not_configured`; first unverified layer `asset_eligibility` | — |
| Hongyadong, `draft_363b…` | 6 | 0 / 0 / 0 / 0 | same | — |
| Metro Map, `draft_4ed1…` | 18 | 0 / 0 / 0 / 0 | same | — |
| 48-Hour, `draft_8ba3…` | 25 | 0 / 0 / 0 / 0 | same | 92019 (historical only) |
| Feasible 3-Day, `draft_ac25…` | 18 | 0 / 0 / 0 / 0 | same | — |
| Food Guide, `draft_ba8c…` | 5 | 0 / 0 / 0 / 0 | same | — |
| 2-Day Landmarks, `draft_da58…` | 30 | 0 / 0 / 0 / 0 | same | 92020 (historical only) |

All seven retained body hash, visual fingerprint and post mapping during commercial replay. Historical IDs 92019/92020 are not reused as current IDs.

## Historical media dry-run

The same clean disposable copy produced `mode=dry_run_read_only`, `scope=media`, `eligible=7`, `conflict=0`; it made no database write, enqueue, model call or WordPress call.

| Historical draft | Repair slots | Preserved slots | Maximum proposed model calls | Body protection |
| --- | ---: | ---: | ---: | --- |
| `draft_da58…` | 3 | 0 | 2 | `c1958c04…` |
| `draft_ba8c…` | 6 | 0 | 6 | `badd283c…` |
| `draft_ac25…` | 2 | 0 | 2 | `1a761aa1…` |
| `draft_8ba3…` | 3 | 0 | 3 | `4a6cfe59…` |
| `draft_4ed1…` | 2 | 0 | 2 | `24bca1e6…` |
| `draft_363b…` | 2 | 0 | 2 | `7e3f419c…` |
| `draft_3593…` | 3 | 0 | 3 | `a125ccd3…` |

This historical copy predates image-level analyses, so every old slot is accurately planned for analysis/fingerprint repair. A separate equal-count SQL-backed regression proves that one successful slot is preserved while only its stale peer is repaired. Replaying the later 2.0.29 work copy found its seven existing queued jobs and correctly stopped all seven with `active_job_exists` while still reporting their media plans.

## R01–R54 matrix

`PASS` below means the named development path and its applicable local test passed. `PARTIAL` names the missing real layer. It does not mean deployed.

| ID | Result | Evidence / limit |
| --- | --- | --- |
| R01 | PASS | Exact supplied branches/HEADs retained; no reset; schema 70 and prior stable page identity were upgraded additively. |
| R02 | PASS / PARTIAL | Preview/auth regressions pass locally, including a true anonymous 403 probe; current same-account production phone/desktop session not tested. |
| R03 | PASS / PARTIAL | Existing preview ticket/cache/noindex/canonical suite passes; production cache/CDN not tested. |
| R04 | PASS | Schema 71 SQL integration hydrates the real image decision DTO. |
| R05 | PASS | Unknown high-resolution images require analysis. |
| R06 | PASS | Shared decision and equal-count single-slot repair regression. |
| R07 | PASS | Token-bounded sign matching and mixed storefront collage regression. |
| R08 | PASS | Per-image languages persist and source-summary language is not substituted. |
| R09 | PASS / PARTIAL | Real recompose path and prompt are wired; four real image results not tested. |
| R10 | PASS / PARTIAL | Photo retain/localize prompts preserve scene/color; real provider sample not tested. |
| R11 | PASS / PARTIAL | Editor UI removal is in transform/QA contract; real sample not tested. |
| R12 | PASS / PARTIAL | Route/map transform preserves ordered facts in contract; real nine-grid sample not tested. |
| R13 | PASS / PARTIAL | Completeness/semantic QA is independent; real sample not tested. |
| R14 | PASS | Full decode rejects truncated/fake/undersized images and bounded raw pixel allocation is enforced. |
| R15 | PASS | Binary pass does not auto-pass four semantic QA dimensions. |
| R16 | PASS | Byte+transform immutable filenames; no overwrite. |
| R17 | PASS | Equal-count old-media repair; caption-only changes do not require pixel regeneration. |
| R18 | PASS | Existing decision/analysis metadata is retained for unchanged bindings. |
| R19 | PASS | Image type and final caption/alt derive from selected media semantics, not generic Source subjects. |
| R20 | PASS | Authorized candidate retrieval extends beyond the former first 24; no unrelated fill. |
| R21 | PASS / PARTIAL | Stable AST media node/section regressions pass; current production page placement not read back. |
| R22 | PASS | 320/360/375/390/430 actual-theme measurements. |
| R23 | PASS | TOC/document overflow false and vertical link coordinates verified. |
| R24 | PASS | Native disclosure works without JS; keyboard-native summary; 200%/long text no overflow. |
| R25 | PASS / PARTIAL | Actual fixture excludes tool/commercial headings and has unique TOC links; current seven DOM not tested. |
| R26 | PASS | Actual CSS URLs load Parent 0.33.4 and Child 0.12.1; computed styles verified. |
| R27 | PASS | H2/TOC wrap and simpler content styles are in active Child CSS. |
| R28 | PASS | Compact light text hero remains valid without treating an editorial card as a photo. |
| R29 | PASS | `09:00–17:00; last entry: 16:30` first-colon regression. |
| R30 | PASS | Existing real plan/AST and substitution suite remains green. |
| R31 | PASS | Existing Markdown/Gutenberg/escaping runtime suite remains green. |
| R32 | PASS / PARTIAL | Explicit whitelist reports 7/7/7 on the supplied historical copy; current production seven unavailable. |
| R33 | PASS | Audit labels the supplied copy `currentness=not_asserted` and separates provider/assets/candidates/exclusions. |
| R34 | PASS | Contract list visible text and metadata/URL exclusion regression. |
| R35 | PASS | Configured city PLANNER asset inserts with score-independent policy. |
| R36 | PASS | Destination resource works without booking words; missing inventory is `asset_not_configured`. |
| R37 | PASS | Negative context and local-metro/train regressions remain green. |
| R38 | PASS | Unknown metrics produce a visible score-0 gap without invented traffic/revenue or auto-task. |
| R39 | PASS | Eligibility diagnostics retain individual exclusion counts. |
| R40 | PASS | Country/destination/entity/route scope regressions remain green. |
| R41 | PASS | Placement normalizes before density and end resource is capped at one. |
| R42 | PASS / PARTIAL | Slot receipt/publish regressions pass; current seven visible DOM not tested. |
| R43 | PASS / PARTIAL | URL/disclosure/sponsored validation passes; no current production link readback. |
| R44 | PASS | Commercial refresh is bounded to commercial/publish/delivery; body/media identities retained. |
| R45 | PASS | `media` is a distinct bounded scope; presentation/commercial preserve visuals. |
| R46 | PASS | Read-only dry-run, explicit existing DB, explicit whitelist, no production apply. |
| R47 | PASS | Published/external-edit/revision/active-job/late-result stops covered. |
| R48 | PASS | Preview and admin traffic remain excluded by existing commercial event contract. |
| R49 | NOT TESTED | Four files and Vertex image credentials absent. |
| R50 | NOT TESTED | Current production seven and current post IDs unavailable; historical IDs not promoted. |
| R51 | PARTIAL | Real local attraction reading flow checked mobile/desktop; itinerary/food current pages and real devices not tested. |
| R52 | PARTIAL | Local browser requests/bytes/LCP/CLS/lazy/no-JS measured; real device/network profiles not tested. |
| R53 | PASS | Replay protection hashes show bodies/visuals/post mapping unchanged; no full-writing rerun. |
| R54 | PASS / RELEASE PENDING | App 2.0.31/schema 71/Strategy 3.5 and theme versions agree. Schema release still requires separate authorization and migration rehearsal. |

## Risk-based Definition of Done

| Layer | Status |
| --- | --- |
| Change class | `DATA_MIGRATION`, `DATABASE_LOGIC`, `PIPELINE`, `AI_PROVIDER`, `UI_ONLY` |
| L1 Targeted Tests | PASS |
| L2 Module Regression | PASS |
| L3 Production DB Replay | PASS on an explicitly historical production copy; current production copy NOT TESTED |
| L4 Browser E2E | PASS for the real local Parent/Child attraction fixture; current seven and real devices NOT TESTED |
| L5 Real Provider Canary | NOT TESTED |
| L6 Full Production-Like Replay | NOT TESTED; not required for an unapproved development-only turn |
| Post-Fix Exploratory Audit | PASS after fixing SQL intent persistence, raw CSS token usage, anonymous Playground probing and 200% overflow; current external state remains NOT TESTED |

## Release plan — not executed

1. Obtain a new explicit “部署到生产/发布到生产” authorization. Review and commit/push each repository separately; none exists from this task.
2. Frontend is a `CODE_ONLY_RELEASE`: package Parent 0.33.4 and Child 0.12.1, install both while keeping Child active, run the static/runtime gates, then verify actual stylesheet URLs/hashes and 320–430px public pages. Do not change WordPress article content during theme rollout.
3. CMS is a `DATA_MIGRATION_RELEASE` because schema 71 adds `source_asset_analyses`: run final tests, create and verify a paired database/files backup, perform an isolated restore drill and schema 70→71 rehearsal, build an immutable 2.0.31 image, run readiness/integrity/foreign-key/fingerprint checks, then switch traffic while retaining the previous image and paired snapshot.
4. After code rollout, obtain a fresh read-only current production copy and rerun the exact seven-ID commercial/media audit. Run the four-image bounded real-provider canary only with the supplied originals and approved provider budget.
5. Repair no old draft automatically. Present a fresh dry-run with current WP draft state/content precondition and execute only the specifically authorized article/scope. Re-read the same post and visible DOM after each item.

## Rollback plan — not executed

- CMS code/schema rollback: stop writers and restore the retained pre-release immutable image together with its verified database/source/generated-media snapshot. Do not lower schema markers in place or restore SQLite without referenced files.
- Frontend rollback: reinstall the retained prior Parent and Child packages together and purge only their versioned asset caches; verify the Child remains active.
- Single article rollback: use the pre-action article snapshot and `commercial_overlay_history`/prior visual and publish artifacts to restore only that draft's affected delivery layer, then update the same mapped WordPress draft ID. Preserve the Research Draft, Source/Claim/Evidence/approval history and shared assets. Stop instead of writing if the post is published, externally edited, remapped, or on a different revision. Never roll back the whole database for one article.

## Completion statement

- Development code: **implemented and locally verified within the limits above**.
- Four real image samples: **NOT TESTED**.
- Current production seven-draft inventory/DOM: **NOT TESTED**.
- Production deployment: **not performed**.
- Seven old drafts repaired: **not performed**.

