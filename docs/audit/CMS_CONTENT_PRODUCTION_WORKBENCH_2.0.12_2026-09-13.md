# CMS content production workbench 2.0.12 implementation record

Date: 2026-09-13. Baseline: `codex/audit-v1.3` at `9961584`, App/Extension 2.0.11, Content Strategy 3.3, schema 67. The fetched `origin/main` tree omitted substantial later CMS functionality, so this upgrade preserves and extends the current branch rather than reverting to that older tree.

## Implemented lifecycle contract

The repository now computes `production_state` on the server. The projection combines approved Opportunity readiness; Candidate, Brief and Draft lineage; durable Job status and leases; reusable Pipeline Artifacts; Pipeline Step Receipts; current revision/content-hash outputs; quality results; Frontend Plan/Page/Publish compositions; WordPress acknowledgement; and production-record disposition. The workbench consumes this projection directly and does not derive state from the legacy status columns.

The visible lifecycle sections are Waiting to start, In progress, Needs attention, Completed and History. Stage status distinguishes waiting, queued, running, failed, interrupted, blocked and succeeded. The detail view is available before Draft generation and shows completed/current/next stages, progress, dependency groups, persisted-output reuse, automatic continuation, human action and the latest exact failure.

## Recovery and retention

Semantic recovery requests resolve to either the unresolved failed Job stage or the first missing downstream stage. The server verifies completed dependencies and enqueues only that stage with the existing Job, Artifact, Step Receipt, hash, lease and dedupe mechanisms. It does not construct a parallel pipeline and does not invalidate completed upstream outputs.

Archive cancels only active production Jobs and moves the record to History without deleting artifacts. Delete removes derived production Job/Artifact/Receipt and Brief/Draft/page/quality/visual/commercial/local-delivery descendants inside one transaction. It preserves the approved Opportunity, Candidate decision lineage, Sources and capture versions, original media, Claims, Knowledge, Evidence, Experience, recommendation decisions, Failure Lessons, failed-attempt archives, model-call accounting and audit. A deletion tombstone records removed identifiers/counts and retained families. A remote WordPress Draft prevents deletion.

## Preview boundary

Page Composition Preview displays only persisted structural blocks and their Contract metadata. It explicitly is not a final theme render and contains no copied or simulated Frontend JSX/CSS. Once WordPress returns a successful Draft acknowledgement, the CMS presents the stored `preview_url` and `edit_url` directly.

## Migration and deployment

Schema 68 adds `production_record_controls` and `production_record_audit` transactionally. It performs no historical content scan, production reconciliation, Job creation, model request, Frontend synchronization or WordPress call. Archived/deleted controls are excluded from approved-opportunity startup reconciliation.

Release commit `c50120df00776557bbe21d51d3c90f65d2a1b103` and the qualification-gate fix `a592b720edb311f10d88bcfa01e98ab7a945f6cd` were pushed to `origin/codex/audit-v1.3`. The full release gate passed with 51 mandatory checks, four explicit warnings, five unconfigured/not-tested external checks and zero failures. The regression test proves that an ACTIONABLE opportunity with `approved_at` may legitimately be in the `approved`, `producing` or `finished` production lifecycle while a genuinely invalid lifecycle is still rejected.

Cloud Build `310dcef1-ce11-45ca-9238-d426c411f308` produced immutable image `asia-east1-docker.pkg.dev/project-4bcb9146-c37b-43b0-b11/solo-to-china/engine@sha256:6b8ed193ff0e67b871b4252ae03f0aea7b0f16f768f8250f9c32ba657ed8ef97`. Before mutation, GCE snapshot `stc-pre-2-0-12-a592b72` reached READY. The verified application snapshot `solo-to-china-2026-09-13T10-18-13-263Z.snapshot` contains a 2,218,278,912-byte schema 67 database with SHA-256 `4d0b4f36ed124e897720b862026c65f09bf00c79d5a12c332eb4e5b619870d02`, integrity `ok`, 1009 files and matching protected table fingerprints. Its isolated restore drill opened 1318 Evidence previews with zero external side effects.

Schema 68 rehearsal and real migration both passed with database integrity `ok`, zero foreign-key errors and unchanged Source, capture, media-reference, segment, Claim, Evidence, coverage, Draft and visual fingerprints. The production admission gate reconciled 413 actionable opportunities to the same 413 rows: 257 ready, 156 held for evidence and zero hard violations. The new container passed isolated readiness before public attachment. Repeated public checks on both `engine.solotochina.com` and `capture.solotochina.com` returned version 2.0.12 and database ready; Frontend Contract 1.4.0 was healthy.

The first image attempt (`c50120d`, digest `sha256:4f6e57322bbef9628a10c8ba0f11c5afa33067125933b7617696252a7a9c335f`) correctly stopped at the admission gate and automatically restored 2.0.11. Diagnosis found one approved, producing opportunity that the old audit incorrectly treated as a pre-approval lifecycle. The gate was corrected and regression-tested before the successful second rollout; no gate was bypassed.

Post-rollout cleanup pinned only `ENGINE_IMAGE` in the private runtime environment and recorded the prior file at mode 0600 in the successful release directory. All other runtime configuration bytes were preserved. It removed the exact failed database and failed release (2,221,592,328 bytes total), increasing VM free space from 69,207,117,824 to 71,428,763,648 bytes. It also removed the superseded first GCE snapshot and two untagged registry images. The current 2.0.12 image, immediate 2.0.11 rollback image/container, latest READY disk snapshot, verified application backup, Sources, original media, Claims, Knowledge, Evidence, Experience and audit data remain retained. No WordPress content was published by the deployment.

One infrastructure warning remains: the GCE Guest Agent service account cannot write Cloud Logging entries. Serial-console deployment evidence remained available and the application is healthy; granting logging permission was outside this release's application scope.
