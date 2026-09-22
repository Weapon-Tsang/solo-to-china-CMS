# CMS Content access incident — 2026-09-22

## Cause and changes

- Production v2.0.57 crashed when opening Content because `Badge` was referenced without an import in `frontend/src/views.jsx`. v2.0.58 imported it and added a render regression for remote WordPress published and draft rows.
- Article detail then spent a long time loading and returned 19,765,341 bytes for the Hongyadong opportunity. Full historical snapshot data accounted for 17,909,633 bytes. v2.0.59 returns at most 40 projected audit rows in the default detail, while the separate full history endpoint still retains the original evidence. The UI identifies a truncated list as the most recent 40 rows.

## Measured results

| Measurement | Before | After | Environment |
| --- | ---: | ---: | --- |
| Hongyadong detail response body | 19,765,341 bytes | 1,863,460 bytes | Production API, first measured request after each release |
| History part of detail | 17,909,633 bytes | 7,728 bytes | Production API |
| Detail API duration | 17,167 ms | 15,468 ms | Production API, cold-ish requests; affected by VM and SQLite cache |
| Repository detail duration | — | 2,793 ms | Read-only September 22 production database clone on local host |
| Browser Content list and detail | Blank list at v2.0.57 | Both rendered at v2.0.59 | Signed-in production browser, Hongyadong article |

The body reduction is approximately 90.6%. It does not imply the cold-request latency target is met. A warm direct production repository profile measured 2,839 ms for detail, while its first isolated list and Draft package reads took 9,238 ms and 4,949 ms. Subsequent browser detail rendered within a four-second observation window. Cold SQL and Draft package assembly remain candidates for a later performance change.

## Verification and release

- Targeted Content recovery and production state tests: 62 passed before the new bounded-history regression; the regression and production state suite then passed 31 tests.
- `npm run check`: PASS. `npm run release:check`: 50 mandatory PASS, 0 failures, 5 warnings, 5 unavailable external checks.
- Production database clone replay used a read-only SQLite connection and the actual affected opportunity ID. No production data was modified for this incident.
- Production `/api/ready`: HTTP 200, version `2.0.59`. The in-app browser showed the Content menu, list rows, the Hongyadong detail, WordPress status, timeline, page preview, and the latest 40 audit rows. Its only recorded console error referred to the old v2.0.57 JavaScript bundle.
- CMS code revision: `067044becf1989feba5e0508acc3c19e66cb9964`. Immutable image: `sha256:3b43f92d5dea63eda0d331dc704983b98d7b19088daf3410c6ba72bfd11071ad`. Startup metadata pins v2.0.59. Rollback containers: `engine-before-067044b` and `engine-worker-before-067044b`.

## Limits

Real Provider Canary and WordPress writes were not needed or performed. This incident fix restores Content access; it does not resolve the already recorded media blockers or guarantee that every historical article is publishable. Cold detail latency can still reach roughly 15 seconds.
