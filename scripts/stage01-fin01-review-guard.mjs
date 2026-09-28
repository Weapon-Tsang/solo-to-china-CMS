import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../src/config.mjs';
import { openDatabase } from '../src/db.mjs';
import { markLocalDataRoot } from '../src/local-runtime.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-fin01-review-'));
const config = loadConfig({ CMS_RUN_MODE: 'migration-review', CMS_DATA_ROOT: root });
markLocalDataRoot(config, 'migration-review');
const db = openDatabase(config.databasePath);
db.prepare(`INSERT INTO jobs(id,type,entity_id,status,available_at,created_at,updated_at)
  VALUES ('fin01-review-queued','extract_source','source-fixture','queued','2026-01-01','2026-01-01','2026-01-01')`).run();
db.close();
const hash = () => crypto.createHash('sha256').update(fs.readFileSync(config.databasePath)).digest('hex');
const beforeHash = hash();
const env = { ...process.env, CMS_RUN_MODE: 'migration-review', CMS_DATA_ROOT: root,
  DATABASE_PATH: config.databasePath, CMS_PROCESS_ROLE: 'worker', MAINTENANCE_ENABLED: 'true',
  KIMI_API_KEY: '', VERTEX_AI_ACCESS_TOKEN: '', GEMINI_API_KEY: '', WORDPRESS_SITE_URL: '' };
const worker = spawnSync(process.execPath, ['src/server.mjs'], {
  cwd: path.resolve('.'), env, encoding: 'utf8', timeout: 10_000,
});
const inspect = spawnSync(process.execPath, ['scripts/inspect-local-data.mjs'], {
  cwd: path.resolve('.'), env, encoding: 'utf8', timeout: 10_000,
});
const afterHash = hash();
const readOnly = openDatabase(config.databasePath, { readOnly: true });
const job = readOnly.prepare('SELECT id,type,status,attempts FROM jobs WHERE id=?').get('fin01-review-queued');
const metrics = readOnly.prepare('SELECT COUNT(*) AS n FROM model_call_metrics').get().n;
readOnly.close();
const report = { format: 'stage01-fin01-review-guard-1', at: new Date().toISOString(), root,
  databasePath: config.databasePath, worker: { pid: worker.pid || null, exitCode: worker.status,
    stderr: worker.stderr.slice(0, 1200), stdout: worker.stdout.slice(0, 1200),
    spawnError: worker.error?.message || null },
  inspection: { exitCode: inspect.status, report: inspect.status === 0 ? JSON.parse(inspect.stdout) : null,
    stderr: inspect.stderr.slice(0, 1200) }, beforeHash, afterHash, job, modelCalls: metrics,
  pass: worker.status !== 0 && inspect.status === 0 && beforeHash === afterHash
    && job.status === 'queued' && job.attempts === 0 && metrics === 0 };
console.log(JSON.stringify(report, null, 2));
if (!report.pass) process.exitCode = 1;
