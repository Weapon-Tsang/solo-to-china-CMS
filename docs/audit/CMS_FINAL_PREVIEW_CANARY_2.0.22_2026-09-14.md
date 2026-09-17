# CMS 2.0.22 final-preview production acceptance

Date: 2026-09-14  
App/Extension: 2.0.22  
Schema: 69 (no migration)  
Content Strategy: 3.3  
Production state: 1.8  
Frontend Contract: 1.4.0

## Failure found by extended production testing

The 2.0.21 canary passed WordPress inline-entity compatibility but stopped at final artifact QA with `BLOCK_PROVENANCE_MISSING` for four blocks. Delivery normalization had changed their byte-level block signatures while the already verified Claim/Source/Evidence provenance correctly retained the original signatures.

## Repair invariant

Version 2.0.22 remaps delivery signatures only when the entire original block sequence still exactly matches its stored provenance. Stable block identities and evidence traces are preserved. Any substantive content change, missing entry or order mismatch still fails closed. New model pages generate provenance after normalization.

## Acceptance status

The final section will record the immutable build, production recovery, WordPress Draft status and IDs, edit and preview URLs, desktop/mobile rendering, heading and structured-data checks, and post-fix audit. Acceptance must not publish a post.
