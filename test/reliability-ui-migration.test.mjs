import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, SCHEMA_VERSION } from '../src/db.mjs';
import { createSummaryCache } from '../src/services/summary-cache.mjs';
import { startStatusPolling } from '../frontend/src/lib/request-coordinator.js';

test('summary TTL coalesces repeated reads and mutations invalidate immediately', () => {
  let now=0, calls=0;
  const cache=createSummaryCache({clock:()=>now});
  const compute=()=>++calls;
  for(let i=0;i<100;i++) assert.equal(cache.read(compute),1);
  now=15001; assert.equal(cache.read(compute),2);
  cache.invalidate(); assert.equal(cache.read(compute),3);
});

test('status polling backs off when hidden, refreshes on return, and never overlaps or resumes after disposal', async () => {
  const timers=new Map(), listeners=new Map(); let sequence=0,calls=0,resolve;
  const document={hidden:false,addEventListener:(k,v)=>listeners.set(k,v),removeEventListener:k=>listeners.delete(k)};
  const stop=startStatusPolling({document,active:true,setTimer:(fn,delay)=>{timers.set(++sequence,{fn,delay});return sequence;},
    clearTimer:id=>timers.delete(id),refresh:()=>{calls++;return new Promise(done=>{resolve=done;});}});
  assert.equal([...timers.values()][0].delay,7500);
  document.hidden=true;listeners.get('visibilitychange')();
  assert.equal([...timers.values()][0].delay,120000);
  document.hidden=false;listeners.get('visibilitychange')();listeners.get('visibilitychange')();
  assert.equal(calls,1);assert.equal(timers.size,0);
  stop();resolve();await Promise.resolve();await Promise.resolve();
  assert.equal(timers.size,0);assert.equal(listeners.size,0);
});

test('schema 59 upgrades atomically, retries after interruption, reopens idempotently, and preserves existing jobs', async t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'stc-migration-61-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const source=fs.readFileSync(new URL('../src/db.mjs',import.meta.url),'utf8');
  const v59=source.replace(/^  if \(current < (\d+)\).*$/gm,(line,v)=>Number(v)>=60?'':line);
  const legacyPath=path.join(directory,'db59.mjs');fs.writeFileSync(legacyPath,v59);
  const legacyModule=await import(pathToFileURL(legacyPath).href);
  const filename=path.join(directory,'migration.sqlite');
  let db=legacyModule.openDatabase(filename);
  db.prepare("INSERT INTO jobs(id,type,entity_id,status,created_at,updated_at,available_at) VALUES ('old','rebuild_knowledge','beijing','queued','2026-09-12','2026-09-12','2026-09-12')").run();
  db.close();
  // A process dying before COMMIT rolls back its added column; reopen must
  // apply both complete migrations without manual cleanup or partial defaults.
  db=new DatabaseSync(filename);db.exec('BEGIN IMMEDIATE; ALTER TABLE jobs ADD COLUMN dirty_revision INTEGER NOT NULL DEFAULT 0;');db.close();
  for(let i=0;i<2;i++) {
    db=openDatabase(filename);
    assert.equal(db.prepare('SELECT MAX(version) n FROM schema_migrations').get().n,SCHEMA_VERSION);
    const row=db.prepare("SELECT * FROM jobs WHERE id='old'").get();
    assert.equal(row.status,'queued');assert.equal(row.dirty_revision,0);assert.equal(row.claimed_revision,0);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM production_attempt_archives').get().n,0);db.close();
  }
});
