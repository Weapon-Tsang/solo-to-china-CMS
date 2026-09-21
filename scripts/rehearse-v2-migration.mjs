import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, SCHEMA_VERSION } from '../src/db.mjs';

if (process.argv[2] !== '--isolated-baseline') throw new Error('Only an isolated, existing baseline is allowed.');
const argument=(name)=>process.argv.includes(name) ? process.argv[process.argv.indexOf(name)+1] || '' : '';
const baseline=path.resolve(argument('--baseline') || 'output/production-2.0.19/production-baseline.sqlite');
if (!fs.existsSync(baseline)) throw new Error('Isolated baseline is absent.');
const workRoot=path.resolve(argument('--work-root') || os.tmpdir());
if (!fs.statSync(workRoot).isDirectory()) throw new Error('Work root must be an existing directory.');
const directory=fs.mkdtempSync(path.join(workRoot,'stc-v2-migration-'));
const relative=path.relative(workRoot,directory);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.dirname(relative)!=='.') {
  throw new Error('Temporary migration directory escaped the explicit work root.');
}
const work=path.join(directory,'work.sqlite');
const tables=['sources','capture_versions','source_assets','source_files','source_segments',
  'claims','evidence_spans','article_drafts','article_visuals','wordpress_publications','jobs'];
function snapshot(db, { baselineVersion, baseline = null } = {}) {
  return Object.fromEntries(tables.map((table)=>{
    const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (!exists) return [table,null];
    const columns=baseline?.[table]?.columns || (baselineVersion<73 && table==='jobs' ? ['id'] : db.prepare(`PRAGMA table_info(${table})`).all().map((row)=>row.name)
      .filter((column)=>!(['source_assets','source_files'].includes(table)&&column==='capture_version')
        && !(table==='jobs'&&baselineVersion<76&&column==='pipeline_version')));
    const content=crypto.createHash('sha256');
    const ids=[];
    for (const row of db.prepare(`SELECT ${columns.map((column)=>`"${column}"`).join(',')} FROM ${table} ORDER BY rowid`).iterate()) {
      content.update(JSON.stringify(row)+'\n');
      ids.push(row.id);
    }
    return [table,{columns,count:ids.length,idsHash:crypto.createHash('sha256').update(JSON.stringify(ids)).digest('hex'),
      contentHash:content.digest('hex')}];
  }));
}
const source=new DatabaseSync(baseline,{readOnly:true});
let before,oldVersion;
try {
  oldVersion=source.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version;
  before=snapshot(source,{baselineVersion:oldVersion});
} finally { source.close(); }
let migrated=null;
let succeeded=false;
try {
  fs.copyFileSync(baseline,work);
  migrated=openDatabase(work);
  const after=snapshot(migrated,{baselineVersion:oldVersion,baseline:before});
  assert.deepEqual(after,before);
  assert.equal(migrated.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,SCHEMA_VERSION);
  assert.equal(migrated.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  migrated.close();
  migrated=null;
  migrated=openDatabase(work);
  assert.deepEqual(snapshot(migrated,{baselineVersion:oldVersion,baseline:before}),before);
  migrated.close();
  migrated=null;
  const unchanged=new DatabaseSync(baseline,{readOnly:true});
  try { assert.equal(unchanged.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,oldVersion); }
  finally { unchanged.close(); }
  process.stdout.write(JSON.stringify({baseline,workRoot,from:oldVersion,to:SCHEMA_VERSION,
    identity:after,integrity:'ok',repeatMigration:'idempotent',baselineUnchanged:true})+'\n');
  succeeded=true;
} finally {
  if (migrated) migrated.close();
  try { fs.rmSync(directory,{recursive:true,force:true,maxRetries:10,retryDelay:250}); }
  catch (error) {
    if (succeeded) throw error;
    process.stderr.write(`Cleanup also failed for ${directory}: ${error.message}\n`);
  }
}
