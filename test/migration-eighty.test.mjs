import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { openDatabase, SCHEMA_VERSION } from '../src/db.mjs';

test('migration 80 indexes exception source rows and recovered jobs without changing data', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stc-migration-80-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = fs.readFileSync(new URL('../src/db.mjs', import.meta.url), 'utf8')
    .replace(/^  if \(current < 81\) migrationEightyOne\(db\);$/m, '')
    .replace(/^  if \(current < 82\) migrationEightyTwo\(db\);$/m, '')
    .replace(/^  if \(current < 83\) migrationEightyThree\(db\);$/m, '')
    .replace(/^  if \(current < 80\) migrationEighty\(db\);$/m, '');
  const oldModule = path.join(directory, 'db-v79.mjs');
  fs.writeFileSync(oldModule, source);
  const { openDatabase: openV79 } = await import(pathToFileURL(oldModule).href);
  const filename = path.join(directory, 'migration.sqlite');
  let db = openV79(filename);
  db.prepare(`INSERT INTO sources(id,adapter,canonical_url,title,captured_at,raw_text,raw_html,
    raw_payload_json,content_hash,status,last_error,created_at,updated_at)
    VALUES ('source-1','manual','manual-source://migration-80','Failed source','now',?,'','{}','hash',
      'exception','AI_PROVIDER_TIMEOUT','now','now')`).run('x'.repeat(100_000));
  db.prepare(`INSERT INTO jobs(id,type,entity_id,status,available_at,created_at,updated_at)
    VALUES ('failed-job','extract_segment_claims','segment-1','failed','now','now','now')`).run();
  db.close();

  db = openDatabase(filename);
  try {
    assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, SCHEMA_VERSION);
    assert.equal(db.prepare("SELECT title FROM sources WHERE id='source-1'").get().title, 'Failed source');
    const sourcePlan = db.prepare(`EXPLAIN QUERY PLAN SELECT id,title,status,last_error,updated_at
      FROM sources WHERE status='exception'`).all().map((item) => item.detail).join(' ');
    assert.match(sourcePlan, /COVERING INDEX idx_sources_exception_list/);
    const recoveredPlan = db.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM jobs recovered
      WHERE recovered.type='extract_segment_claims' AND recovered.entity_id='segment-1'
        AND recovered.status='succeeded' AND recovered.updated_at>='now'`).all()
      .map((item) => item.detail).join(' ');
    assert.match(recoveredPlan, /idx_jobs_recovery_lookup/);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { db.close(); }
});
