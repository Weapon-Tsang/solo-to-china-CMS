import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Repository } from '../src/repository.mjs';

const filename = path.resolve(process.argv[2] || '');
if (!/(?:work|replay|canary)\.sqlite$/i.test(path.basename(filename))) {
  throw new Error('Pass an explicit disposable production-copy work database.');
}
const db = new DatabaseSync(filename, { readOnly: true });
db.exec('PRAGMA query_only=ON');
try {
  const repo = new Repository(db);
  const run = () => {
    const start = performance.now();
    const page = repo.listSystemHealthWorkspace({ limit: 50 });
    return { milliseconds: Number((performance.now() - start).toFixed(3)), count: page.totalCount };
  };
  run();
  const samples = Array.from({ length: 30 }, run);
  const durations = samples.map((item) => item.milliseconds).sort((a, b) => a - b);
  const p = (fraction) => durations[Math.ceil(durations.length * fraction) - 1];
  const counts = new Set(samples.map((item) => item.count));
  const result = { version: 'stage01-real-db-exception-benchmark-1', data: 'disposable production snapshot work database',
    readOnly: true, schemaVersion: db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
    sampleCount: samples.length, resultCountsStable: counts.size === 1, resultCount: samples[0].count,
    samplesMs: samples.map((item) => item.milliseconds), p50Ms: p(0.5), p95Ms: p(0.95),
    scope: 'Repository page construction on local SQLite, no HTTP, browser, Worker, or Provider load' };
  console.log(JSON.stringify(result, null, 2));
  if (!result.resultCountsStable) process.exitCode = 1;
} finally { db.close(); }
