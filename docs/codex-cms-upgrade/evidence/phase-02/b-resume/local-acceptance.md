# B continuation acceptance — 2026-09-28

B_LOCAL_ACCEPTED (local scope). Prior b/local-acceptance.md remains historical evidence.

Change class: LOCAL_LOGIC. web-media-2 binds original_hash in the cache key, validates receipt policy/lineage/decoded dimensions/byte count, diagnoses broken cache reads, strips IPTC as well as EXIF/XMP/ICC, and rounds fractional crop edges outward to preserve the validated safe region. Existing v1 files are retained; new transforms use separate keys.

L1 Targeted Tests: PASS (34/34, targeted.log).
L2 Module Regression: PASS (web media, HTTP delivery, media delivery, publication eligibility in the same 34-test run).
check/build: PASS (check.log).
L3 Production DB Replay: NOT REQUIRED for this deterministic cache increment; prior B metadata replay retained. Historical pixel conversion remains NOT TESTED: 26 unavailable recorded paths; bounded inspection found no verified replacement mapping.
L4 Browser E2E: NOT REQUIRED for this increment; prior B browser evidence retained.
L5 Real Provider Canary: NOT REQUIRED for this increment; prior B remote semantic quality remains NOT TESTED.
L6 Full Production Replay: NOT TESTED.
Post-Fix Exploratory Audit: PASS for adjacent cache provenance/receipt corruption/missing file/fractional edge regressions; historical media availability remains ISSUES FOUND.

No commits, push, deployment, production operations, paid calls, schema migration, or new historical copy. A1/A2 were not rerun. User subsequently authorized proceeding to C after B; D remains excluded.
