// Bounded Stage 01 replay on a disposable copy of a restored local database.
// No .env is loaded. Every network and subprocess boundary is denied before
// application modules are imported; only the extractor interface is mocked.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import childProcess from 'node:child_process';

const restoredRoot = path.resolve(process.argv[2] || '');
const work = path.resolve(process.argv[3] || '');
const resume = process.argv[4] === '--resume';
const baseline = path.join(restoredRoot, 'solo-to-china.sqlite');
const markerPath = `${work}.stage01-replay.json`;
if (!fs.existsSync(baseline) || fs.existsSync(work) !== resume || work.startsWith(restoredRoot + path.sep)
  || work.startsWith(path.resolve('.') + path.sep) || (!resume && fs.existsSync(markerPath))) {
  throw new Error('Pass a restored local root and a distinct work database outside both the root and checkout.');
}
if (resume) {
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  if (marker.format !== 'stage01-disposable-worker-copy-1' || marker.baseline !== baseline || marker.work !== work) {
    throw new Error('Resume target does not match its disposable database marker.');
  }
}
const deny = () => { throw new Error('STAGE01_NETWORK_OR_SUBPROCESS_DENIED'); };
globalThis.fetch = deny;
http.request = deny; http.get = deny;
https.request = deny; https.get = deny;
net.connect = deny; net.createConnection = deny;
tls.connect = deny;
childProcess.spawn = deny; childProcess.exec = deny; childProcess.execFile = deny;
childProcess.fork = deny;

if (!resume) {
  fs.mkdirSync(path.dirname(work), { recursive: true });
  const source = new DatabaseSync(baseline, { readOnly: true });
  try { source.exec(`VACUUM INTO '${work.replaceAll("'", "''")}'`); }
  finally { source.close(); }
  fs.writeFileSync(markerPath, JSON.stringify({ format: 'stage01-disposable-worker-copy-1', baseline, work }) + '\n', { flag: 'wx' });
}

const [{ openDatabase }, { Repository }, { Pipeline }] = await Promise.all([
  import('../src/db.mjs'), import('../src/repository.mjs'), import('../src/pipeline.mjs'),
]);
const db = openDatabase(work);
const short = value => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
const allowed = new Set(['preflight_source', 'segment_source', 'extract_segment_claims',
  'audit_segment_coverage', 'retry_segment_extraction', 'finalize_source_extraction']);
const report = { version: 'stage01-worker-replay-1', input: 'restored local snapshot',
  destination: 'disposable database on separate volume', resumed: resume, networkAndSubprocessDenied: true,
  mockExtractorCalls: 0, steps: [], initialJobs: [], stopReason: null };
try {
  const repository = new Repository(db);
  const queued = resume
    ? { id: db.prepare("SELECT recovery_run_id AS id FROM jobs WHERE created_at >= '2026-09-27' AND recovery_run_id IS NOT NULL AND parent_job_id IS NULL GROUP BY recovery_run_id HAVING COUNT(*)=12 ORDER BY MAX(created_at) DESC LIMIT 1").get()?.id }
    : (() => { const dry = repository.runSourceProcessingGapRecovery();
      return repository.runSourceProcessingGapRecovery({ dryRun: false, approvedFromRunId: dry.id }); })();
  if (!queued.id) throw new Error('No exact twelve-job recovery run found.');
  const initial = db.prepare('SELECT id,type,entity_id,status,attempts FROM jobs WHERE recovery_run_id=? AND parent_job_id IS NULL ORDER BY id')
    .all(queued.id);
  if (initial.length !== 12 || initial.some(job => !['preflight_source', 'extract_segment_claims'].includes(job.type))) {
    throw new Error(`Unexpected recovery plan: ${initial.length} jobs.`);
  }
  report.initialJobs = initial.map(job => {
    const sourceId = job.type === 'preflight_source' ? job.entity_id
      : db.prepare('SELECT source_id FROM source_segments WHERE id=?').get(job.entity_id)?.source_id;
    const source = db.prepare('SELECT capture_version FROM sources WHERE id=?').get(sourceId);
    return { job: short(job.id), type: job.type, source: short(sourceId),
      captureVersion: source?.capture_version ?? null, initialStatus: job.status };
  });
  const realClaim = repository.claimJob.bind(repository);
  repository.claimJob = options => {
    const blocked = db.prepare("SELECT id,type FROM jobs WHERE status='queued' AND available_at < '9999-01-01'").all()
      .filter(job => !allowed.has(job.type));
    const defer = db.prepare("UPDATE jobs SET available_at='9999-01-01T00:00:00.000Z' WHERE id=? AND status='queued'");
    for (const job of blocked) defer.run(job.id);
    const claimed = realClaim(options);
    if (claimed) report.steps.push({ job: short(claimed.id), type: claimed.type });
    return claimed;
  };
  const extractor = {
    enabled: true, batchEnabled: false,
    config: { provider: 'gemini', model: 'stage01-local-mock', sourceUploadsDir: path.join(restoredRoot, 'source-uploads') },
    async extract(input) {
      report.mockExtractorCalls++;
      const raw = String(input.raw_text || '').trim();
      const quote = raw.slice(0, Math.min(80, raw.length)).trim();
      return { method: 'stage01-local-mock', model: 'stage01-local-mock', result: {
        source: { language: 'en', summary: 'Local replay only', destination_name: 'Unknown',
          destination_slug: 'unknown', traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.5 },
        claims: quote.length >= 12 ? [{ key: 'stage01.replay.literal', subject: 'Source text',
          predicate: 'literal excerpt', value: quote, qualifiers: [], confidence: 0.5, source_quote: quote }] : [],
        blueprint: { format: 'replay', hook: 'Replay', angle: 'Local', sections: [], strengths: [], gaps: [] },
      } };
    },
    async auditCoverage() { return { output: { uncovered_spans: [] } }; },
  };
  const pipeline = new Pipeline(repository, extractor, { maxConcurrent: 1,
    processIsolationEnabled: false, extractionConfig: { concurrencyMode: 'fixed', concurrencyInitial: 1, concurrencyMax: 1 } });
  const started = Date.now();
  for (let index = 0; index < 160 && Date.now() - started < 180_000; index++) {
    const worked = await pipeline.runOne();
    if (!worked) { report.stopReason = 'no_eligible_scoped_job'; break; }
  }
  if (!report.stopReason) report.stopReason = 'bounded_iterations_or_timeout';
  report.finalJobs = db.prepare(`SELECT id,type,status,attempts,last_failure_code FROM jobs WHERE id IN (${initial.map(() => '?').join(',')}) ORDER BY id`)
    .all(...initial.map(job => job.id)).map(job => ({ job: short(job.id), type: job.type,
      status: job.status, attempts: job.attempts, failureCode: job.last_failure_code || null }));
  report.generatedStages = db.prepare("SELECT type,status,COUNT(*) AS count FROM jobs WHERE created_at >= ? AND recovery_run_id=? GROUP BY type,status")
    .all(initial.map(job => db.prepare('SELECT created_at FROM jobs WHERE id=?').get(job.id).created_at).sort()[0], queued.id);
  report.unknownDispatches = db.prepare("SELECT COUNT(*) AS n FROM media_dispatches WHERE state='outcome_unknown'").get().n;
  report.foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all().length;
  report.modelMetricDelta = db.prepare("SELECT COUNT(*) AS n FROM model_call_metrics WHERE created_at >= '2026-09-27'").get().n;
  console.log(JSON.stringify(report, null, 2));
} finally { db.close(); }
