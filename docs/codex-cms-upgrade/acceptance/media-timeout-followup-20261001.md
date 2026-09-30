# 2.0.77 media timeout follow-up

Change class: PIPELINE / DATABASE_LOGIC / AI_PROVIDER (recognition retry).
Release class: CODE_ONLY_RELEASE; schema 83 and Content Strategy 3.9 unchanged.

The 2.0.76 verification did not run these two articles through real source-photo discovery to its terminal result. The user reported both records at 2/8 (25%). Live worker/ledger reads showed successful recognition calls interleaved with shared-lane waits, repeated destination-wide Knowledge decoding, and then a Museum recognition timeout after 361,171 ms. Its finished dispatch became `outcome_unknown`; the next acquire returned permanent `MEDIA_OUTCOME_UNKNOWN` despite recognition being a read-only operation.

The fix allows only **finished** `analyze_source_image` unknown outcomes, no longer holding the lane, to transition to failed on reacquire. Original error and cumulative dispatch spend remain recorded; the four-dispatch allowance is unchanged. In-flight/crashed calls without completion and generation/localization/QA retain their unknown-outcome protections. Article package/checkpoint reads fetch selected Knowledge keys before hydration. Current-job successful unique original counts appear in running/queued media headlines; failure guidance explains the distinction.

## Executed verification

- L1 Targeted Tests: PASS. Timeout/restart/budget exhaustion, crashed recognition protection, production-scale bounded reads, current-job progress counting.
- L2 Module Regression: PASS. 46 directly related tests plus 36 production-state/recovery-policy tests; `npm run check` passed. Final `release:check` passed all 50 mandatory offline checks with zero failures, including the complete unit/integration suite and isolated API smoke. Initial gate caught a handoff version-format mismatch, corrected and rerun before commit.
- L3 Production DB Replay: PASS. Read-only production export -> immutable baseline -> disposable work DB. All 16 real draft packages and generate-visuals dependency fingerprints matched the previous implementation. Museum package reading was 1,230 -> 335 ms; Zoo 1,627 -> 739 ms on the updated snapshot. Previous snapshot profile: total 2,494 -> 452 ms, Knowledge decoding 1,951 -> 5 ms. Measurements are local, not production latency guarantees.
- L3 real-failure replay: PASS. Exact dispatch `b974fd6f-f64e-4438-b043-43240a55abbe` reproduced old `MEDIA_OUTCOME_UNKNOWN`; the new executor acquired/completed a simulated retry in the disposable copy, retaining timeout evidence and spent=2/limit=4. No production/provider writes in this replay.
- L4 Browser E2E: PASS for the affected UI/recovery path on the production copy. Logged in, opened Content, clicked Museum retry, confirmed exactly image processing, checked a queued owner-bound article-bundle job and unchanged article bodies/WordPress records. Replayed the Zoo job's previously observed running state with its actual paid-call ledger; browser displayed 12 recognized originals. This running display is a local replay, not a claim that the live Zoo task remains running.
- L5 Real Provider Canary: PASS. One fixed Museum original, one actual Vertex Gemini 3.8 Flash dispatch, 16,826 ms overall. Started with a finished unknown recognition dispatch in an isolated temporary DB; retry succeeded with spent=2/limit=4/unknown=0. 3,372 input / 2,608 output tokens. Original SHA256 `267828b846d462a26b0fcb4e8c546be4d62c32f6e635c33b6c26b4e32fcbb144` preserved. No production DB or WordPress writes.
- L6 Full Production Replay: NOT TESTED. Capture -> QA -> final WordPress output for these two articles is not verified. The bounded real recognition canary does not prove either article can finish with the retained media.
- Post-Fix Exploratory Audit: ISSUES FOUND. No duplicate active owners/orphan active owner jobs in the replay. Zoo's live job finished with `MEDIA_REQUIRED_MANIFEST_MISSING` after recognition, a separate retained-media constraint. Museum failed with the above timeout recovery defect. A inspected Museum source card contains several places; whole-card relevance rejection is preserved. Crop selection from such cards is not implemented by this fix.

## Evidence and release status

Ignored local evidence: `output/production-media-followup-20260930/{semantic-replay.json,timeout-replay.json,canary.json,browser-result.json,module.log,policy.log,check.log,release-check-final.log}`. Production read snapshots and original bytes are kept outside tracked source.

Production release and recovery verification: pending. Do not describe these two articles as completed or claim all production interruptions are prevented from the above tests.
