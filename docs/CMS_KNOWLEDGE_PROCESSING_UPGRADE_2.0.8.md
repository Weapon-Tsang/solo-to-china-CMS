# CMS 2.0.8 Knowledge and source-processing upgrade

Target: App/Extension 2.0.8, Content Production Strategy 3.3, schema 67.

## Upgrade sequence

1. Record the active image digest, exact 40-character Git revision, health payload, queue depth and disk capacity. Create a disk snapshot.
2. Stop writers through the verified upgrade helper. Create a paired database-and-files backup, verify every manifest hash and complete the isolated restore drill.
3. Rehearse schema 66 to 67 on an isolated database copy. Require `PRAGMA integrity_check=ok`, zero foreign-key errors and unchanged content fingerprints/IDs.
4. Deploy the immutable 2.0.8 image with the existing persistent `/app/data` and `solo_to_china_data` mounts. Start on Docker network `none`; require readiness to report version 2.0.8, Strategy 3.3 and schema 67 before reconnecting the service network.
5. Check public health/readiness and authenticated Knowledge status. Confirm new Source intake is ahead of historical lanes and no unexpected failed job was introduced.
6. Run both production inventories as dry runs only:

```bash
node scripts/run-backfill.mjs processing-gaps
node scripts/run-backfill.mjs knowledge-resolution
```

Retain the report IDs, fingerprints and item lists. Do not add `--execute` during this rollout.

## Schema 67

Schema 67 adds workload context to durable jobs and creates Knowledge resolution events, verification jobs, Claim repair jobs, dirty Coverage scopes and Source recovery manifests. It reconstructs only `system_backfill_runs` to add the `knowledge_resolution` type; all existing rows are copied inside one transaction. It does not delete or rewrite Sources, source assets, Claims, evidence, drafts or publications.

## Configuration

`PROCESS_ISOLATION_ENABLED=true` is the production default and moves Knowledge aggregation, topic/coverage/opportunity rebuilds and scheduled backup work into Node child processes. Set it to `false` only as a rollback control if child spawning fails; the durable job will then use the existing in-process implementation on the next retry. `SOURCE_COMPLEXITY_ROUTING` stays disabled until a separate fragment-quality benchmark approves it.

## Rollback

If readiness fails before network attachment, keep the failed container stopped and restore the complete paired snapshot with the recorded 2.0.7 image. Never restore SQLite without its referenced files and never lower the schema marker in place. If the new image is rolled back after schema 67 has accepted writes, restore the entire pre-upgrade snapshot rather than mixing schema 67 data with older code.

This upgrade never publishes WordPress content, starts historical recovery, deletes Base64 fields or removes original evidence.
