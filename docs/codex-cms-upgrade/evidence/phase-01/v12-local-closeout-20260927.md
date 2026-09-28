# Phase 01 v1.2 local closeout evidence — 2026-09-27

## Boundary and environment

- Mode: DEVELOPMENT; isolated local fixture only.
- Application: `2.0.70`; schema: `80`; Node: `v24.14.0`.
- Browser: Playwright CLI `0.1.21`, `HeadlessChrome/147.0.0.0`, Windows 10 x64 user agent.
- Fixture data root: `C:\Users\Mloong\AppData\Local\Temp\stc-phase01-v12-20260927-162632`.
- Fixture dataset id: `de34cada-b340-407b-95e9-40b08976d502`.
- Provider boundary: deterministic in-process fixture methods only; real model-call metric remained `0`.
- No production database, real Provider, WordPress write, Cloud Build, commit, push, or deployment was used.

## Real local Worker fixture

The fixture was created by `scripts/stage01-fin01-worker.mjs prepare-v12`, then drained by the real application Worker with only the provider boundary replaced.

- Normal source: `src_af741b981cec48a8840fb502424b9fd2` → `processed`, one traceable Claim.
- Review source: `src_2963be81c80c4941967aeacb9dbd2599` → source `exception`; segment `segment_98dc29f59f8e94686b90dd28` → `manual_review` / `review_needed` after exactly one targeted retry.
- Review reason: concrete entrance and walking route remained absent; the Worker stopped automatic retry and persisted the segment-level reason.
- Unknown request: dispatch `68e5c675-b7f7-4b55-b6cc-e2925fde3940` → `outcome_unknown` / `NETWORK_TIMEOUT` through the real media request executor.
- Unknown budget before restart: `spent=1`, `granted=0`, `limit=1`, `unknown=1`.
- Unknown budget after API process restart: `spent=1`, `granted=0`, `limit=1`, `unknown=1`.
- Foreign-key violations: `0`.

The permanent regression `an unknown exhausted dispatch cannot be unlocked by an operator grant` also passed, proving the server-side grant refusal remains enforced after a new executor opens the same SQLite database.

## Browser and API observations

The real local API served the built frontend. Playwright used the actual CMS UI and did not call component internals.

1. Sources showed one normal processed row and one row requiring attention.
2. Review detail explicitly said `待人工检查 · 材料覆盖不足`, `这不是处理成功或明确失败`, and `系统已停止自动重试`.
3. The segment exposed only bounded manual choices: `重试此分段` and `确认无需信息主张`; neither was clicked during this read-only acceptance run.
4. Settings → System Health returned 56 items. Page size 20 returned 20 rows; page size 50 returned 50 rows; the second 50-row page returned exactly 6 rows.
5. The last row was `媒体请求结果待核，已隔离` and said the CMS will not automatically resend, add budget, or mark the request successful/failed. No resend or budget-grant control was rendered.
6. API logs recorded bounded query results: 20 rows in 4 ms, 50 rows in 4 ms, and the final 6 rows in 6 ms. This is the query record for the SQL-side `LIMIT/OFFSET` implementation.
7. After terminating and restarting the API process against the same fixture database, the two sources, 56 health items, review state, and unknown request remained unchanged.
8. Browser console: 0 errors, 0 warnings.

Screenshots:

- `output/playwright/phase01-v12/01-sources.png`
- `output/playwright/phase01-v12/02-review-detail.png`
- `output/playwright/phase01-v12/03-health-page2-unknown.png`
- `output/playwright/phase01-v12/04-after-restart-sources.png`

Raw application logs remain in the fixture root under `logs/api.jsonl` and `logs/worker.jsonl`. The fixture was intentionally preserved for replay; it is not a production dataset.

## Pagination implementation record

`Repository.listSystemHealthWorkspace` now constructs a bounded SQL candidate CTE, applies search/severity filters before counting, and executes stable ordering with `LIMIT ? OFFSET ?`. It resolves owner metadata only for the current page. `SystemHealthPanel` requests pages directly from `/api/settings/system-health` and exposes 20/50 page-size controls; it no longer downloads all exceptions and slices them in the browser.

The regression API fixture contains 105 issues and verifies page sequences `20 + 20` without overlap and `50 + 50 + 5` with 105 unique keys, plus a warning-only query for the isolated unknown dispatch.

## Commands executed for this evidence

```text
node scripts/stage01-fin01-worker.mjs prepare-v12 <unique temp root>
node scripts/stage01-fin01-worker.mjs worker <root> --stop-when-drained
node scripts/stage01-fin01-worker.mjs inspect <root>
npm run build
node scripts/stage01-fin01-worker.mjs api <root>
Playwright CLI open/snapshot/click/select/screenshot/reload across an API restart
node --test test/server.test.mjs test/exceptions.test.mjs test/media-request-executor.test.mjs test/local-runtime.test.mjs test/frontend-localization.test.mjs
```

Targeted result at evidence capture: 50 passed, 0 failed.
