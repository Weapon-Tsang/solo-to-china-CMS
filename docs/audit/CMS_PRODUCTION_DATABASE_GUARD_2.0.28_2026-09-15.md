# CMS 2.0.28 production database guard and serial recovery

Date: 2026-09-15  
Schema: 69 (no migration)  
Content Strategy: 3.3  
Production state: 2.0  
Frontend Contract: 1.4.0

## Production finding and repair

The running 2.0.27 replacement container retained the persistent volume mount but omitted `DATABASE_PATH`. It therefore opened the image-local default database and returned zero Content rows even though the intact production database remained at `/var/lib/solo-to-china/solo-to-china.sqlite` in `solo_to_china_data`.

Version 2.0.28 now refuses production startup when `DATABASE_PATH` is omitted. It also refuses implicit creation of a missing production database unless `ALLOW_PRODUCTION_DATABASE_BOOTSTRAP=true` is explicitly selected for an intentional first deployment. The permanent regression proves that neither failure path creates a database file.

The final latest-code runtime also includes commit `0006a259fc9cbea80adecad6dabb10040cd1e2fd`, which normalizes persisted quality-review aliases at read time without rewriting audit history. Production runs immutable image `sha256:32cd9bc80698664568a89eff62a1cecff01ad43a75e997d99bc9b709ce56a7d2`; Cloud Build was `eb139518-4d86-411f-af60-2650a93f85fc`.

## Verification

- Change class: `LOCAL_LOGIC` plus code-only production deployment safety.
- L1 targeted server startup guard: PASS (14/14).
- L1 targeted Content Recovery alias regression on latest commit: PASS (29/29).
- L2 complete unit/integration regression: PASS (640/640 before the alias commit; the final release gate reran the complete suite successfully after it).
- `npm run check`: PASS, including production build and seven service boundaries.
- `npm run release:check`: PASS on the final latest commit (50 mandatory checks, zero failures, five warnings, five explicit external/not-tested conclusions).
- L3 production database read-only verification: PASS. The mounted database exposed exactly seven approved production rows and zero active Jobs after bounded startup reconciliation settled.
- L4 Browser E2E: NOT REQUIRED for the startup guard; authenticated WordPress browser preview remains a human/session boundary.
- L5 Real Provider Canary: NOT REQUIRED for the startup guard. The controlled production recovery did make real Vertex calls as described below.
- L6 Full Production Replay: NOT REQUIRED for this code-only guard.
- Post-fix exploratory audit: PASS for runtime mount identity, exact Content row count, queue ownership and draft-only status. No migration, bulk reconciliation, record deletion, archive or publication occurred.

## Serial production recovery

Before the first recovery, the real production queue was empty, no production Job was active, and real Vertex successes existed after the preceding 429 interval. `opportunity_2147a72065b016381a9c388b` recovered from its projected `revise_draft` breakpoint and completed as WordPress draft 83. The CMS retained both `https://solotochina.com/?p=83&preview=true` and `https://solotochina.com/wp-admin/post.php?post=83&action=edit`; authenticated WordPress REST confirmed post 83 remains `draft`. An unauthenticated preview request returned the expected draft-hidden 404 and the edit URL redirected to login; neither result implies publication.

The next serial record, `opportunity_b9ec578018c96b44fccc9444`, successfully completed Editorial Assembly, Content Plan, Narrative Plan, Writing Packet, Frontend Page Plan and a new Draft in recovery run `recovery_run_c40e4a5fb5134c6e8f0b61d976878712`. Two localized visual files were stored. The third visual exhausted its three in-Job attempts with Vertex Gemini image HTTP 429 at `2026-09-15T00:48:01.437Z`. The queue returned to zero and the exact recovery target is `generate_visuals`; no second recovery was created.

Current production summary is five completed WordPress drafts and two rows requiring attention. The remaining other row, `opportunity_870dc70e0b3956c91d79c6b9`, projects `generate_draft`. Monitoring stays silent until the 60-minute record cooldown has elapsed and a real Vertex success occurs after the latest visual 429; only then may the first row resume. Recovery remains strictly serial and WordPress remains draft-only.
