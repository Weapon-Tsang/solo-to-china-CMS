# CMS 2.0.11 Opportunity qualification audit - 2026-09-13

## Scope and production baseline

The audit began from the production App 2.0.10/2.0.11 database at schema 67 and Content Strategy 3.3. The original actionable Inbox contained 484 records: 243 Source-backed production paths and 241 Knowledge-derived opportunities. All 74 Sources were complete and current; no processing-gap Source was allowed to support an opportunity.

Production data was first audited read-only. Candidate corrections ran against a SQLite copy before deployment. The checks cover Source completion and capture version, current strategy, recommendation class, lifecycle and SEO state, declared Source paths, selected Knowledge facts, visibility/currentness/value/conflict state, independent Source families, readiness consistency, title/content type/publication mode/reader promise, generic topics, canonical intent, same-Source semantics, primary-city and nested-destination entity identity, topic keys, migration references, SQLite integrity and foreign keys.

## Findings

The 484 records were not all valid representations of distinct content opportunities.

- No original actionable record used unfinished Source evidence, a processing-gap Source, an invalid recommendation class, a skipped SEO action or a broken migration reference. The database passed integrity and foreign-key checks.
- Exact title/type/mode and exact canonical-key checks were insufficient: semantic duplicates remained behind bilingual titles, alternate canonical subjects and nested destination slugs.
- Eight Source-backed rows repeated another declared path from the same Source with the same destination, type, mode and compatible duration. Distinct reader promises, modes and material durations remained separate.
- Knowledge clustering split bilingual aliases and dominant entities. The first correction removed same-destination duplicates; a deeper audit then found seven additional redundant actionable rows spanning `chongqing` and `chongqing-jiefangbei`, including bilingual entity titles.
- Nine Knowledge rows over-counted independent support because completed-evidence filtering rebuilt independence from raw Source IDs instead of retained Source-family membership.
- Content-type inference could scan incidental supporting predicates, and the substring `eat` matched words such as `creative`, `great` and `weather`.
- Context-free subjects such as `venue`, `hotpot restaurant`, `pathway`, `featured restaurant` and `Day 3 itinerary` could create an opportunity solely from fact count.
- Coverage refresh could widen a Knowledge opportunity to destination-wide facts instead of retaining its selected cluster facts.

## Correction and recurring prevention

Knowledge clusters now union facts by resolved entity identity or normalized canonical subject, including known bilingual destination aliases. A Knowledge canonical intent uses that entity identity across a primary city and nested scopes. Source-backed adaptations keep their exact destination and declared path. Generic topics are rejected, and content type inference reads the resolved topic and complete tokens rather than incidental substrings.

Completed-evidence filtering restores `source_family_memberships`. Knowledge admission requires at least two usable facts and two independent Source families. A selected fact must exist, remain visible, be current or unknown-validity, be non-conflicted or resolved, contain a usable value and come from completed evidence. Coverage refresh remains restricted to stored `selectedFactKeys`.

Source-path reconciliation compares only rows with the same destination, content type and publication mode plus compatible duration. It preserves materially different reader promises. Replaced, duplicate and old-strategy records remain in the historical database with `INTERNAL`, `MERGED` or `SUPERSEDED` state; none are deleted.

Every existing-installation deployment now runs two network-isolated scripts before traffic is exposed:

1. `scripts/reconcile-opportunity-qualification.mjs` deterministically rebuilds topic clusters, Knowledge opportunities and coverage, and asserts that model-call, active-job, WordPress-job and draft counts do not change.
2. `scripts/audit-opportunity-qualification.mjs --enforce` blocks deployment on any current-strategy, Source completion, declared-path, fact usability, family independence, readiness, lifecycle, field-quality, generic-topic, duplicate, migration, database-integrity or foreign-key violation.

An evidence-gap opportunity remains qualified at the editorial-topic admission level but is not production-ready. It is labelled separately and cannot enter content production until its Coverage Matrix becomes ready. This is distinct from a processing gap, which remains system-owned and outside the actionable Inbox.

## Final production result

The final production database retains all 1,394 historical opportunity records. The actionable Inbox contains 413 qualified distinct opportunities: 235 Source-backed paths and 178 Knowledge opportunities. Compared with the original 484, 71 records no longer inflate the actionable total. Current historical states are 684 `SUPERSEDED`, 281 `INTERNAL`, 16 `MERGED` and 413 `ACTIONABLE`.

All 65 current `ARTICLE_CANDIDATE` Sources contribute the exact 243 declared stored paths: 235 actionable and eight linked as merged. No Source has a missing or unexpected production path. All 178 actionable Knowledge opportunities pass the two-usable-fact/two-independent-family rule. The enforced production report records:

- zero old-strategy, lifecycle, recommendation, processing-gap, SEO, invalid field, readiness-consistency or unfinished-evidence violations;
- zero missing or unusable selected Knowledge facts, fact-count mismatches, Source-family mismatches or Knowledge admission failures;
- zero exact, canonical, same-Source-signature, topic-key or cross-scope Knowledge duplicate groups;
- zero context-free generic Knowledge topics;
- zero missing Source/recommendation references, broken merged-primary links or canonical-key mismatches;
- SQLite integrity `ok`, schema 67 and zero foreign-key violations;
- enforced hard violation count: zero.

Of the 413 qualified topics, 257 are `CURRENT` and production-ready. The other 156 are explicit `EVIDENCE_GAP` holds; 35 currently score zero and one Source-backed topic has no selected Knowledge fact. These records satisfy opportunity admission through their current Source diagnostic or Knowledge cluster, but they cannot begin production and are not represented as ready. They remain visible because Strategy 3.3 explicitly allows an editor to approve a topic while evidence is still being completed.

## Validation

- `npm test`: 526 passed, 0 failed.
- `npm run check`: passed. Vite built 1,882 modules; JavaScript is 431.55 kB (134.90 kB gzip), CSS is 57.45 kB (10.51 kB gzip), and all 12 service-boundary files passed.
- Deployment regression tests cover deterministic reconciliation, rejection of a below-admission actionable row, dynamic application-version validation and backup/migration rollback safety.
- The final network-isolated production reconciliation processed 14 destination scopes in 368,866 ms. It changed actionable counts from 420 to 413, retained active jobs at five during the offline window, retained model-call count at 5,661, and retained zero WordPress jobs and zero article drafts. After startup, the inherited five jobs completed and the active queue returned to zero.
- Both public hosts returned 12/12 HTTP 200 responses for `/api/health` and `/api/ready`. Observed p50/p95 were 1,258.2/3,149.3 ms and 1,018.0/1,255.6 ms on `engine.solotochina.com`; 1,351.5/1,603.8 ms and 992.9/1,235.6 ms on `capture.solotochina.com`.
- The production container has zero restarts and zero fatal/uncaught/unhandled/panic log matches after deployment.

## Production rollout and storage

Code revisions `5163c40`, `85673a8`, `3cec22c` and final `c99c40094f8488187193451a07a7d2496f374cc1` were pushed to `codex/audit-v1.3`. Cloud Build `8294d361-9b30-4304-bde3-929c2bf1d4bf` produced immutable image `sha256:725c05425220e344a989d1028a9c0306848970dabeae5b7244ce415af82ee1b4`. Production runs that exact digest and revision as App 2.0.11; the runtime image was pinned while every other private configuration byte was preserved.

Verified snapshot `solo-to-china-2026-09-13T05-37-32-154Z.snapshot` contains a 2,218,086,400-byte database with SHA-256 `dbfa8431233d7236122b22f24591812a03c58f2b0546870cdd407a3f91b40987`, schema 67, integrity `ok` and 1,009 retained files. The offline restore drill passed, opened 1,318 evidence previews and made no external side effect.

The failed pre-exposure database copy from the earlier readiness-version rollback was verified obsolete and removed, freeing 2,340,270,080 bytes. Rehearsal databases were removed automatically. Artifact Registry was reduced to the active digest and the immediate rollback digest; obsolete 2.0.10 and undeployed/intermediate digests were deleted. The VM root fell from 11,641,450,496 bytes used (15%) to 9,298,579,456 bytes (12%); `/var/lib/docker` fell to 6,805,665,143 bytes. One verified data snapshot remains because GitHub restores code only, not the SQLite database or authorized uploads. One stopped immediate rollback container/image also remains; all older rollback containers and image layers are gone.

No Source, original media, historical opportunity or editorial decision was deleted. No opportunity was approved, no WordPress draft was created and no article was published. Temporary IAP SSH access was removed after verification.
