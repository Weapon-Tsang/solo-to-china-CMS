# 2.0.78 required source-photo recovery

Change class: PIPELINE / DATABASE_LOGIC. Same-schema CODE_ONLY_RELEASE; schema 83 / Content Strategy 3.9 unchanged.

The screenshots identify two approved articles blocked during required original-photo selection. Investigation found three deterministic recovery defects: cached recognized photos were not locally audited; a failed required visual slot prematurely stopped continued discovery; and an earlier low-quality original could mask a later qualified, relevant original. Recovery now audits cached originals in durable local batches, continues until the required slot is satisfied or bounded discovery ends, and considers a qualified relevant original before an unqualified exact selection. Qualified immutable derivatives and factual/location gates are preserved.

Tiny images receive a negative-only local resolution check before paid recognition. Passing dimensions does not establish image identity, authorization or delivery quality. SHA-matched rejections are reused; local-only progress defers without consuming a job attempt or provider allowance. No new provider schema/prompt/model is introduced. An unchanged no-relevant-image retry is refused even when a failed required slot exists; newly auditable/discoverable or actually repairable media can still recover.

## Actual source inputs

The affected drafts expose 147 distinct authorized retained originals (38 for Museum, within Zoo's 147). Those original files were read from production without mutation, copied locally and individually SHA256 verified. A contact-sheet inspection found city-wide itinerary/guide collages, comment emojis and dogs, low-resolution panda photos, and a Museum photo embedded in a multi-place guide card. No replacement image was fabricated, upscaled to simulate quality, or silently substituted.

Two recognized panda originals are 640x480 and 640x853; both fail the existing local photo resolution gate. Their location metadata also does not establish an exact Chongqing Zoo scene. The Museum picture inside its Day-4 collage is only roughly 335x189 within a 1080x1443 card; a crop does not satisfy the existing original-photo quality requirement. Fixing recovery is not equivalent to supplying a qualified original for either article.

## Verification before release

- L1 Targeted Tests: PASS. Cached recognition audit with zero additional paid calls; fourth-image discovery with a persisted failed required slot; cached local audit continuation to a qualified fourth original; negative-only resolution screen; refusal of unchanged recovery. Production screenshot cases are permanent regressions.
- L2 Module Regression: PASS for the 124 directly related tests, with additional resolution and recovery regressions and the complete release gate recorded in ignored evidence. Final `npm run release:check`: PASS, all 50 mandatory checks, zero failures. A fixture accidentally used duplicate original hashes and was corrected; discovery intentionally deduplicates identical bytes. The legacy required-gap assertion now expects the more specific no-relevant-image terminal reason.
- L3 Production DB Replay: PASS. A read-only production-derived baseline was copied to a disposable work DB; 147 exact original files verified. Both affected owners ran image-stage recovery to explicit `MEDIA_DISCOVERY_NO_RELEVANT_IMAGE`, with no active jobs, duplicate active owners or orphan active owners. Unchanged retries refused. All article bodies, source rows, Knowledge and WordPress receipts preserved. No real provider or production writes in this replay. Thirteen remaining card recognitions use an offline manual-corpus fixture; this is deterministic pipeline replay, not a real-provider success claim.
- L4 Browser E2E: NOT TESTED in this run so far. The local API is ready; the browser reports connection refused, then rejects its internal data URL. Do not label API verification as browser E2E.
- L5 Real Provider Canary: NOT REQUIRED for the deterministic code changes; actual production recovery results will separately record real paid requests and terminal outcomes.
- L6 Full Production Replay: NOT TESTED. Neither affected article has yet been verified through successful final page/WordPress delivery with qualified media. Offline gate/fixtures and a single image recognition cannot establish article completion.
- Post-Fix Exploratory Audit: ISSUES FOUND. Genuine retained-media input gaps remain. The disposable recovery leaves no active/orphan/duplicate-owner jobs. Live audit is recorded after deployment/testing.

Ignored evidence is under `output/content-media-completion-20261001/`. Production release and real terminal recovery results are appended after execution; no production completion is claimed in this pre-release record.
