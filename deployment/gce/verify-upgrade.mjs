// Offline deployment probe: no server, provider client, queue worker or WordPress calls.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const root = process.env.STC_PROBE_ROOT || '/var/lib/solo-to-china';
const work = process.env.STC_PROBE_WORK || '/ops';
const app = process.env.STC_PROBE_APP || '/app';
const tables = ['sources', 'capture_versions', 'source_assets', 'source_files', 'source_segments',
  'claims', 'evidence_spans', 'extraction_coverage', 'article_drafts', 'article_visuals'];
const mode = process.argv[2];
const fingerprint = (db) => Object.fromEntries(tables.filter(table =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
).map(table => {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name)
    .filter(column => !(['source_assets', 'source_files'].includes(table) && column === 'capture_version'));
  // Stable old columns and IDs must survive migration, including source content.
  const hash = crypto.createHash('sha256');
  let count = 0;
  for (const row of db.prepare(`SELECT ${columns.map(c => `"${c}"`).join(',')} FROM ${table} ORDER BY rowid`).iterate()) {
    hash.update(JSON.stringify(row) + '\n'); count++;
  }
  return [table, { count, sha256: hash.digest('hex') }];
}));
const check = db => {
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
};
const write = (name, value) => fs.writeFileSync(path.join(work, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
if (mode === 'backup') {
  const { createBackup, verifyBackup, drillBackup } = await import(pathToFileURL(path.join(app, 'src/backup.mjs')).href);
  const before = new DatabaseSync(`${root}/solo-to-china.sqlite`, { readOnly: true });
  check(before);
  const baseline = fingerprint(before);
  const schema = before.prepare('SELECT MAX(version) AS n FROM schema_migrations').get().n;
  before.close();
  write('baseline.json', baseline);
  const result = createBackup({ databasePath: `${root}/solo-to-china.sqlite`,
    backupDir: `${root}/backups`, sourceUploadsDir: `${root}/source-uploads`,
    generatedMediaDir: `${root}/generated-media`, retention: 999999,
    codeRevision: process.env.OLD_IMAGE, reason: 'pre-2.0.7-verified-upgrade' });
  const verified = verifyBackup(result.backupPath);
  write('backup.json', result);
  console.log(JSON.stringify({ stage: 'backup', schema, ...result, verified: verified.integrity, tables: baseline }));
  const drill = drillBackup(result.backupPath);
  const drillSummary = { stage: 'restore-drill', status: drill.drill,
    externalSideEffects: drill.externalSideEffects, evidencePreviewsOpened: drill.evidencePreviewsOpened,
    draftMediaOpened: drill.draftMediaOpened, deliveryProbe: drill.deliveryProbe.status };
  assert.equal(drill.drill, 'passed');
  write('restore-drill.json', drillSummary);
  console.log(JSON.stringify(drillSummary));
} else if (mode === 'rehearse' || mode === 'migrate') {
  const { openDatabase } = await import(pathToFileURL(path.join(app, 'src/db.mjs')).href);
  const baseline = JSON.parse(fs.readFileSync(`${work}/baseline.json`, 'utf8'));
  const backup = JSON.parse(fs.readFileSync(`${work}/backup.json`, 'utf8'));
  const target = mode === 'rehearse' ? `${work}/rehearsal.sqlite` : `${root}/solo-to-china.sqlite`;
  if (mode === 'rehearse') fs.copyFileSync(backup.databaseBackupPath, target, fs.constants.COPYFILE_EXCL);
  const start = performance.now();
  const db = openDatabase(target);
  check(db);
  const actual = fingerprint(db);
  assert.deepEqual(actual, baseline, 'Migration changed existing content, IDs or row counts');
  const schema = db.prepare('SELECT MAX(version) AS n FROM schema_migrations').get().n;
  assert.equal(schema, 66);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  const result = { stage: mode, schema, integrity: 'ok', foreignKeyErrors: 0,
    preservedContentFingerprints: true, migrationMs: Math.round(performance.now() - start), tables: actual };
  write(`${mode}.json`, result);
  console.log(JSON.stringify(result));
} else if (mode === 'restore') {
  const { verifyBackup } = await import(pathToFileURL(path.join(app, 'src/backup.mjs')).href);
  const backup = JSON.parse(fs.readFileSync(`${work}/backup.json`, 'utf8'));
  verifyBackup(backup.backupPath);
  // Preserve the failed attempt, including its journal, before restoring the paired old DB.
  // Keep the rename inside the data mount: /ops may be a different Docker mount.
  const retained = `${root}/failed-database-${Date.now()}`;
  fs.mkdirSync(retained);
  for (const suffix of ['', '-wal', '-shm']) {
    const filename = `${root}/solo-to-china.sqlite${suffix}`;
    if (fs.existsSync(filename)) fs.renameSync(filename, `${retained}/database.sqlite${suffix}`);
  }
  fs.copyFileSync(backup.databaseBackupPath, `${root}/solo-to-china.sqlite`, fs.constants.COPYFILE_EXCL);
  console.log(JSON.stringify({ stage: 'rollback-database', integrity: 'ok', retained }));
} else {
  throw new Error('Expected backup, rehearse, migrate or restore');
}
