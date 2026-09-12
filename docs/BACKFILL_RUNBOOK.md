# Backfill runbook

All backfills are idempotent, auditable and dry-run by default. Run them on the persistent production database only after a verified snapshot. Historical jobs use low queue priority so new captures and approved editorial work continue moving.

## Commands

```powershell
npm run backfill -- media
npm run backfill -- experience
npm run backfill -- recommendations
npm run backfill -- failed-production-cleanup
npm run backfill -- processing-gaps
npm run backfill -- knowledge-resolution
```

Add `--execute` only after reviewing the dry-run counts and sample records. The 2.0.8 production rollout explicitly keeps `processing-gaps` and `knowledge-resolution` in dry-run:

```powershell
npm run backfill -- media --execute
npm run backfill -- experience --execute
npm run backfill -- recommendations --execute
```

The failed-production cleanup has an extra approval boundary. Record the dry-run ID, inspect every `migrationReview` item, then execute only against that exact report:

```powershell
npm run backfill -- failed-production-cleanup --execute --approved-from backfill_...
```

## Meaning

- `media`: inventories every non-durable original, queues server-recoverable assets and reports browser-required/unavailable assets. Browser Repair Sync handles the former when public recovery cannot.
- `experience`: queues eligible processed Sources without a succeeded Experience run and tracks the run until succeeded or terminally failed.
- `recommendations`: rebuilds topic clusters, Knowledge-event opportunities, coverage and approved readiness without changing human decisions.
- `processing-gaps`: inventories every Source stage and proposes only the first missing stage. Execution requires the exact current dry-run ID and fingerprint.
- `knowledge-resolution`: projects automatic, verification, repair and true-human outcomes without changing review rows. Execution requires the exact dry-run ID.
- `failed-production-cleanup`: migrates safe historical failed Drafts into the Failure Lesson / `recommended_again` lifecycle. Published records and records without a linked opportunity are report-only migration review items.

## Verification and rollback

Before execution, run `npm run backup` and `npm run backup:verify`. After execution, check Settings → Advanced maintenance, queue depth, exception counts and a sample Source/Opportunity. The system does not offer an automatic destructive rollback for backfills; restore the complete versioned snapshot (database and files together) if an operator-approved run must be reversed.
