# Browser interaction evidence — 2026-09-27

- Environment: Windows, Chromium via Playwright CLI, local `development` API, synthetic fixture of 1,000 sources / 10,000 claims / 300 drafts / 3,000 media metadata rows. No production data or Provider calls.
- Opened Sources and confirmed the first page showed 20 records.
- Clicked Next page; the UI showed `第 2 页` and `Benchmark source 979`.
- Opened source 979; its detail showed the expected synthetic claim list and raw capture text; closed the detail.
- Changed the page size from 20 to 50; the UI returned to `第 1 页` and selected 50. Saved [viewport screenshot](browser-pagination-real-interaction.png).
- The same fixture's API benchmark reported 30 valid samples for each path. P95: Sources 4.315 ms, Knowledge subjects 7.783 ms, Content 7.755 ms, Exceptions 4.781 ms, Dashboard summary 1.081 ms. The synthetic idle fixture does not establish production Worker latency.
- `EXPLAIN QUERY PLAN` still showed table scans and temporary sort B-trees for the sampled Sources and Content queries; keep this as a scale improvement item despite meeting the 1,000-source latency target.
- At a 390 × 844 mobile viewport, the six-tab backend menu was visible and functional. Switched Sources → Content → Sources, opened the first source card and confirmed its detail dialog and raw capture text, then closed it. Visual samples: [Sources](browser-mobile-sources.png), [source detail](browser-mobile-source-detail.png). This is a Chromium viewport test, not a physical phone or capture-extension pairing test.
