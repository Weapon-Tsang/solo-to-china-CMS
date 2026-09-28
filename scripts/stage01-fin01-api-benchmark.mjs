// Measure real loopback HTTP responses against one persistent local dataset.
import fs from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';

const [base, databasePath, outputPath, mode] = process.argv.slice(2);
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base || '') || !databasePath || !outputPath
  || !['idle', 'worker'].includes(mode)) throw new Error('Expected LOOPBACK_URL DB OUTPUT idle|worker');
if (fs.existsSync(outputPath)) throw new Error('Output must be a new path');
const db = new DatabaseSync(databasePath, { readOnly: true });
const routes = ['/api/sources?limit=20', '/api/knowledge/subjects?limit=20',
  '/api/content?limit=20', '/api/exceptions?limit=20', '/api/dashboard/summary'];
const nearest = (values, f) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * f) - 1];
const queue = () => db.prepare(`SELECT status,COUNT(*) AS n FROM jobs WHERE status IN ('queued','running','succeeded')
  GROUP BY status`).all();
const results = [];
try {
  for (const route of routes) {
    const samples = [];
    for (let i = -1; i < 30; i++) {
      const queueBefore = queue();
      const startedAt = new Date().toISOString();
      const start = performance.now();
      let status = 0, bytes = 0, error = null;
      try {
        const response = await fetch(base + route, { headers: { 'cache-control': 'no-cache' } });
        status = response.status;
        bytes = (await response.arrayBuffer()).byteLength;
        if (status !== 200) error = `HTTP_${status}`;
      } catch (failure) { error = String(failure?.message || failure); }
      const elapsedMs = Number((performance.now() - start).toFixed(3));
      const item = { index: i, startedAt, completedAt: new Date().toISOString(),
        elapsedMs, status, bytes, error, queueBefore, queueAfter: queue() };
      if (i >= 0) samples.push(item);
    }
    const durations = samples.map(item => item.elapsedMs);
    results.push({ route, samples, p50Ms: nearest(durations, 0.5), p95Ms: nearest(durations, 0.95),
      failed: samples.filter(item => item.error).length, targetP95Ms: 300,
      targetMet: samples.every(item => !item.error) && nearest(durations, 0.95) <= 300 });
  }
  const report = { format: 'stage01-fin01-api-benchmark-1', mode, startedAt: results[0]?.samples[0]?.startedAt,
    completedAt: new Date().toISOString(), node: process.version,
    machine: { platform: process.platform, arch: process.arch, cpus: os.cpus().length, totalMemoryBytes: os.totalmem() },
    dataset: { sources: db.prepare('SELECT COUNT(*) AS n FROM sources').get().n,
      claims: db.prepare('SELECT COUNT(*) AS n FROM claims').get().n,
      drafts: db.prepare('SELECT COUNT(*) AS n FROM article_drafts').get().n,
      mediaMetadata: db.prepare('SELECT COUNT(*) AS n FROM source_assets').get().n },
    percentileMethod: 'nearest-rank', definition: 'client fetch start to full arrayBuffer completion; failures included',
    workerEvidence: { queueAtEnd: queue() }, results };
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ mode, dataset: report.dataset,
    results: results.map(({ route, p50Ms, p95Ms, failed, targetMet }) => ({ route, p50Ms, p95Ms, failed, targetMet })) }));
  if (results.some(result => !result.targetMet)) process.exitCode = 1;
} finally { db.close(); }
