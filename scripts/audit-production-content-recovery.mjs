import path from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { Repository } from '../src/repository.mjs';
import { executeContentRecovery } from '../src/services/content-recovery.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.database) throw new Error('--database must identify a disposable production-copy work database.');
const databasePath = path.resolve(args.database);
if (!/(?:canary|replay|work)/i.test(path.basename(databasePath))) {
  throw new Error('The replay database filename must contain canary, replay, or work; the live production database is refused.');
}

const db = openDatabase(databasePath);
const repository = new Repository(db);
repository.configureProductionCapabilities({
  visuals:Boolean(db.prepare('SELECT 1 FROM article_visuals LIMIT 1').get()),
  frontendContract:Boolean(db.prepare('SELECT 1 FROM frontend_page_compositions LIMIT 1').get()),
  wordpress:Boolean(db.prepare('SELECT 1 FROM wordpress_publications LIMIT 1').get()),
});
const protectedBefore = protectedCounts(repository);
const modelCallsBefore = modelCallCount(repository);
const initialActiveJobs = repository.db.prepare(
  "SELECT id,type,status,production_owner_opportunity_id FROM jobs WHERE status IN ('queued','running')",
).all();
if (initialActiveJobs.length) {
  repository.db.close();
  throw new Error(`Recovery replay requires a quiescent copy; found ${initialActiveJobs.length} active jobs.`);
}

const rows = repository.listContent({ productionOnly: true })
  .filter((row) => ['failed', 'interrupted'].includes(row.production_state?.stage_status));
if (!rows.length) {
  repository.db.close();
  throw new Error('Recovery replay found no failed or interrupted production records.');
}

const replayId = args.replayId || `offline-replay-${new Date().toISOString()}`;
const results = [];
for (const row of rows) {
  const detailBefore = repository.getContentProductionDetail(row.opportunity_id);
  const stateBefore = detailBefore?.production_state || row.production_state;
  const action = stateBefore.stage_status === 'interrupted' ? 'recover_next_stage' : 'retry_failed_stage';
  const idempotencyKey = `${replayId}:${row.opportunity_id}:${action}`;
  const input = {
    action,
    revision: detailBefore?.draft?.revision ?? row.draft_revision ?? undefined,
    idempotencyKey,
  };
  const first = executeContentRecovery(repository, row.opportunity_id, input, 'offline-production-replay');
  const second = executeContentRecovery(repository, row.opportunity_id, input, 'offline-production-replay');
  const job = repository.db.prepare(
    'SELECT id,type,status,entity_id,production_owner_opportunity_id,recovery_run_id FROM jobs WHERE id=?',
  ).get(first.jobId);
  if (!first.jobId || !first.queued || second.jobId !== first.jobId || !second.idempotent) {
    throw new Error(`Recovery idempotency invariant failed for ${row.opportunity_id}.`);
  }
  if (!job || job.type !== first.resolvedStage || job.production_owner_opportunity_id !== row.opportunity_id) {
    throw new Error(`Recovery owner/stage invariant failed for ${row.opportunity_id}.`);
  }
  results.push({
    opportunityId: row.opportunity_id,
    title: row.title,
    action,
    failedStage: stateBefore.latest_error?.stage || stateBefore.current_stage || null,
    recoveryTarget: stateBefore.recovery_target || null,
    resolvedStage: first.resolvedStage,
    preservedStages: first.preservedStages || [],
    job,
    idempotentReplay: {
      sameJob: second.jobId === first.jobId,
      idempotent: Boolean(second.idempotent),
      queuedAgain: Boolean(second.queued),
    },
  });
}

const protectedAfter = protectedCounts(repository);
const modelCallsAfter = modelCallCount(repository);
const protectedDataPreserved = Object.keys(protectedBefore).every((key) => protectedBefore[key] === protectedAfter[key]);
const ownerCounts = repository.db.prepare(`SELECT production_owner_opportunity_id AS opportunity_id,COUNT(*) AS active_jobs
  FROM jobs WHERE status IN ('queued','running') GROUP BY production_owner_opportunity_id`).all();
const output = {
  version: 'production-content-recovery-replay-1',
  database: path.basename(databasePath),
  replayId,
  productionDatabaseWritten: false,
  modelCalls: modelCallsAfter - modelCallsBefore,
  wordpressWrites: 0,
  protectedDataPreserved,
  protectedBefore,
  protectedAfter,
  recoveredRecords: results.length,
  ownerCounts,
  results,
};
repository.db.close();
console.log(JSON.stringify(output, null, 2));
if (!protectedDataPreserved || output.modelCalls !== 0 || ownerCounts.some((row) => Number(row.active_jobs) !== 1)) {
  process.exitCode = 1;
}

function modelCallCount(repo) {
  return Number(repo.db.prepare('SELECT COUNT(*) AS count FROM model_call_metrics').get().count || 0);
}

function protectedCounts(repo) {
  return Object.fromEntries([
    ['sources', 'sources'],
    ['source_assets', 'source_assets'],
    ['claims', 'claims'],
    ['evidence_spans', 'evidence_spans'],
    ['knowledge_facts', 'knowledge_facts'],
    ['experience_blocks', 'experience_blocks'],
    ['approved_opportunities', 'content_opportunities WHERE approved_at IS NOT NULL'],
    ['failure_lessons', 'failure_lessons'],
  ].map(([key, from]) => [key, Number(repo.db.prepare(`SELECT COUNT(*) AS count FROM ${from}`).get().count || 0)]));
}

function parseArgs(values) {
  const output = { database: '', replayId: '' };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--database') output.database = values[++index] || '';
    else if (value === '--replay-id') output.replayId = values[++index] || '';
    else throw new Error(`Unknown argument: ${value}`);
  }
  return output;
}
