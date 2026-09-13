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

Schema 68 adds `production_record_controls` and `production_record_audit` transactionally. It performs no historical content scan, production reconciliation, Job creation, model request, Frontend synchronization or WordPress call. Archived/deleted controls are excluded from approved-opportunity startup reconciliation. This change was not deployed to production.

Test commands and final outcomes are recorded in the delivery report for the implementing task. No deployment command was run.
