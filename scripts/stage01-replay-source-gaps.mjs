import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db.mjs';
import { Repository } from '../src/repository.mjs';

const baseline = path.resolve(process.argv[2] || '');
const work = path.resolve(process.argv[3] || '');
const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!baseline.endsWith(`${path.sep}database.sqlite`) || !fs.existsSync(baseline)
  || !/source-gap-work\.sqlite$/i.test(path.basename(work)) || fs.existsSync(work)
  || work.startsWith(`${checkout}${path.sep}`) || baseline === work) {
  throw new Error('Pass an extracted snapshot database and a new external source-gap-work.sqlite path.');
}
fs.mkdirSync(path.dirname(work), { recursive: true });
const source = new DatabaseSync(baseline, { readOnly: true });
try {
  source.exec(`VACUUM INTO '${work.replaceAll("'", "''")}'`);
} finally { source.close(); }

const db = openDatabase(work);
try {
  const repository = new Repository(db);
  const count = (table) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
  const protectedTables = ['sources', 'source_assets', 'claims', 'knowledge_facts', 'article_drafts',
    'wordpress_publications', 'model_call_metrics'];
  const before = Object.fromEntries(protectedTables.map((table) => [table, count(table)]));
  const jobsBefore = count('jobs');
  const dry = repository.runSourceProcessingGapRecovery();
  const executed = repository.runSourceProcessingGapRecovery({ dryRun: false, approvedFromRunId: dry.id });
  const after = Object.fromEntries(protectedTables.map((table) => [table, count(table)]));
  const jobsAfter = count('jobs');
  const actualQueued = Number(db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE recovery_run_id=? AND status='queued'`)
    .get(executed.id).n);
  const invariants = {
    protectedCountsPreserved: JSON.stringify(before) === JSON.stringify(after),
    queueMatchesActions: actualQueued === dry.actionCount,
    noProviderCalls: before.model_call_metrics === after.model_call_metrics,
    noWordPressWrites: before.wordpress_publications === after.wordpress_publications,
  };
  const report = { version: 'stage01-source-gap-replay-1', source: 'disposable production snapshot copy',
    databaseWritten: 'local disposable work database only', schemaVersion: db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v,
    baselineCounts: before, jobsBefore, jobsAfter, gapCount: dry.gapCount,
    actionableSources: dry.sourceCount, actionCount: dry.actionCount,
    categoryCounts: dry.categoryCounts, actualQueued, invariants };
  console.log(JSON.stringify(report, null, 2));
  if (Object.values(invariants).some((value) => !value)) process.exitCode = 1;
} finally { db.close(); }
