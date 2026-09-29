// Offline deployment probe: no server, provider client, queue worker or WordPress calls.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = process.env.STC_PROBE_ROOT || '/var/lib/solo-to-china';
const work = process.env.STC_PROBE_WORK || '/ops';
const app = process.env.STC_PROBE_APP || '/app';
const prepared = process.env.STC_PROBE_PREPARED || '/prepared';
const tables = ['sources', 'capture_versions', 'source_assets', 'source_files', 'source_segments',
  'claims', 'evidence_spans', 'extraction_coverage', 'article_drafts', 'article_visuals'];
const mode = process.argv[2];
const fingerprint = (db, baseline = null) => Object.fromEntries(tables.filter(table =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
).map(table => {
  const columns = baseline?.[table]?.columns || db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name)
    .filter(column => !(['source_assets', 'source_files'].includes(table) && column === 'capture_version'));
  // Stable old columns and IDs must survive migration, including source content.
  const hash = crypto.createHash('sha256');
  let count = 0;
  for (const row of db.prepare(`SELECT ${columns.map(c => `"${c}"`).join(',')} FROM ${table} ORDER BY rowid`).iterate()) {
    hash.update(JSON.stringify(row) + '\n'); count++;
  }
  return [table, { count, sha256: hash.digest('hex'), columns }];
}));
const check = db => {
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
};
const write = (name, value) => fs.writeFileSync(path.join(work, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
if (mode === 'boundary-backup') {
  const {fileHash,verifyBoundaryMedia}=await import(pathToFileURL(path.join(app,'scripts/family-release-boundary.mjs')).href);
  const plan=JSON.parse(fs.readFileSync(`${prepared}/preflight/boundary-plan.json`,'utf8'));
  assert.equal(plan.restoreDrill,'passed');
  assert.ok(Date.now()-Date.parse(plan.preparedAt)<6*60*60*1000,'Prepared backup is too old');
  assert.equal(fileHash(`${plan.snapshot}/manifest.json`),plan.snapshotManifestSha256);
  const manifest=JSON.parse(fs.readFileSync(`${plan.snapshot}/manifest.json`,'utf8'));
  const filename=`${root}/solo-to-china.sqlite`,before=new DatabaseSync(filename);
  try {
    before.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    check(before);
    verifyBoundaryMedia(before,manifest,plan.references);
  } finally {before.close();}
  const databaseBackupPath=`${work}/boundary.sqlite`;
  fs.copyFileSync(filename,databaseBackupPath,fs.constants.COPYFILE_EXCL);
  const sha256=fileHash(databaseBackupPath);assert.equal(fileHash(filename),sha256);
  write('backup.json',{kind:'verified-boundary-database-and-prepared-media',databaseBackupPath,sha256,
    preparedSnapshot:plan.snapshot,snapshotManifestSha256:plan.snapshotManifestSha256,oldImage:process.env.OLD_IMAGE});
  console.log(JSON.stringify({stage:mode,integrity:'ok',currentDatabasePreserved:true,mediaMatchedPreparedSnapshot:true}));
} else if (mode === 'boundary-baseline') {
  const backup=JSON.parse(fs.readFileSync(`${work}/backup.json`,'utf8'));
  assert.equal(backup.kind,'verified-boundary-database-and-prepared-media');
  const original=new DatabaseSync(backup.databaseBackupPath,{readOnly:true});
  try {write('baseline.json',fingerprint(original));} finally {original.close();}
  console.log(JSON.stringify({stage:mode,readOnly:true}));
} else if (mode === 'family-repair') {
  const {repairBoundary}=await import(pathToFileURL(path.join(app,'scripts/family-release-boundary.mjs')).href);
  const plan=JSON.parse(fs.readFileSync(`${prepared}/preflight/boundary-plan.json`,'utf8'));
  console.log(JSON.stringify({stage:mode,...repairBoundary(`${root}/solo-to-china.sqlite`,plan.expected,work)}));
} else if (mode === 'backup') {
  const { createBackup, verifyBackup, drillBackup } = await import(pathToFileURL(path.join(app, 'src/backup.mjs')).href);
  const before = new DatabaseSync(`${root}/solo-to-china.sqlite`, { readOnly: true });
  check(before);
  const baseline = fingerprint(before);
  const schema = before.prepare('SELECT MAX(version) AS n FROM schema_migrations').get().n;
  before.close();
  write('baseline.json', baseline);
  const result = createBackup({ databasePath: `${root}/solo-to-china.sqlite`,
    backupDir: `${root}/backups`, sourceUploadsDir: `${root}/source-uploads`,
    generatedMediaDir: `${root}/generated-media`,
    captureUploadsDir: '/app/data/capture-uploads', captureMediaUploadsDir: '/app/data/capture-media-uploads',
    retention: 1, prune: false,
    codeRevision: process.env.OLD_IMAGE,
    reason: `pre-${process.env.NEW_VERSION || 'unknown'}-verified-upgrade`
  });
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
  const { openDatabase, SCHEMA_VERSION } = await import(pathToFileURL(path.join(app, 'src/db.mjs')).href);
  const backup = JSON.parse(fs.readFileSync(`${work}/backup.json`, 'utf8'));
  let baseline, baselineDone=null;
  if(mode==='migrate' && backup.kind==='verified-boundary-database-and-prepared-media') {
    // Read the exact frozen backup while migrating the separate live file. Both
    // complete hashes are still compared before the container can succeed.
    // Children share this offline container's lifetime and are killed on timeout.
    const original=new DatabaseSync(backup.databaseBackupPath,{readOnly:true});
    try {
      baseline=Object.fromEntries(tables.filter(table=>original.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
        .map(table=>[table,{columns:original.prepare(`PRAGMA table_info(${table})`).all().map(r=>r.name)
          .filter(c=>!(['source_assets','source_files'].includes(table)&&c==='capture_version'))}]));
    } finally {original.close();}
    const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'boundary-baseline'],{stdio:'inherit',windowsHide:true});
    baselineDone=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`Boundary baseline failed: ${code}`)));});
  } else baseline = JSON.parse(fs.readFileSync(`${work}/baseline.json`, 'utf8'));
  const target = mode === 'rehearse' ? `${work}/rehearsal.sqlite` : `${root}/solo-to-china.sqlite`;
  if (mode === 'rehearse') fs.copyFileSync(backup.databaseBackupPath, target, fs.constants.COPYFILE_EXCL);
  const start = performance.now();
  const db = openDatabase(target);
  check(db);
  const actual = fingerprint(db, baseline);
  const schema = db.prepare('SELECT MAX(version) AS n FROM schema_migrations').get().n;
  assert.equal(schema, SCHEMA_VERSION);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  if(baselineDone) {await baselineDone;baseline=JSON.parse(fs.readFileSync(`${work}/baseline.json`,'utf8'));}
  assert.deepEqual(actual, baseline, 'Migration changed existing content, IDs or row counts');
  const result = { stage: mode, schema, integrity: 'ok', foreignKeyErrors: 0,
    preservedContentFingerprints: true, migrationMs: Math.round(performance.now() - start), tables: actual };
  write(`${mode}.json`, result);
  console.log(JSON.stringify(result));
} else if (mode === 'restore') {
  const { verifyBackup } = await import(pathToFileURL(path.join(app, 'src/backup.mjs')).href);
  const backup = JSON.parse(fs.readFileSync(`${work}/backup.json`, 'utf8'));
  if(backup.kind==='verified-boundary-database-and-prepared-media') {
    const {fileHash}=await import(pathToFileURL(path.join(app,'scripts/family-release-boundary.mjs')).href);
    assert.equal(fileHash(backup.databaseBackupPath),backup.sha256,'Boundary backup changed');
  } else verifyBackup(backup.backupPath);
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
