import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { openDatabase } from '../src/db.mjs';
import { createMediaRequestExecutor, retryAfterDelayMs } from '../src/media-request-executor.mjs';

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stc-media-quota-'));
  const filename = path.join(directory, 'db.sqlite');
  const first = openDatabase(filename);
  const second = openDatabase(filename);
  t.after(() => { first.close(); second.close(); fs.rmSync(directory, { recursive:true, force:true }); });
  return { first, second };
}

test('shared SQLite enforces 2 RPM pacing without an initial burst', (t) => {
  const { first, second } = setup(t);
  let time = 0;
  const a = createMediaRequestExecutor(first, { rpm:2, clock:() => time });
  const b = createMediaRequestExecutor(second, { rpm:2, clock:() => time });
  const request = (executor, visualId) => executor.acquire({ provider:'vertex_gemini', model:'image-model',
    accountScope:'project', visualId, substage:'generate_visual' });
  const starts = [];
  const one = request(a, 'visual-1'); starts.push(one.startedAtMs);
  assert.throws(() => request(b, 'visual-2'), { code:'MEDIA_RATE_WAIT' });
  one.finish();
  assert.throws(() => request(b, 'visual-2'), { code:'MEDIA_RATE_WAIT' });
  time = 31_000;
  const two = request(b, 'visual-2'); starts.push(two.startedAtMs); two.finish();
  assert.throws(() => request(a, 'visual-3'), { code:'MEDIA_RATE_WAIT' });
  time = 62_000;
  const three = request(a, 'visual-3'); starts.push(three.startedAtMs); three.finish();
  assert.deepEqual(starts, [0, 31_000, 62_000]);
  assert.equal(first.prepare('SELECT COUNT(*) n FROM media_dispatches').get().n, 3);
});

test('429 cooldown and unknown outcomes persist through a new executor', (t) => {
  const { first, second } = setup(t);
  let time = 100_000;
  const config = { rpm:2, clock:() => time };
  const params = { provider:'vertex', model:'image-model', accountScope:'project', substage:'generate_visual' };
  const a = createMediaRequestExecutor(first, config);
  const one = a.acquire({ ...params, visualId:'visual-a' });
  one.finish({ error:{status:429,code:'RESOURCE_EXHAUSTED'}, responseReceived:true });
  const b = createMediaRequestExecutor(second, config);
  time += 31_000;
  assert.throws(() => b.acquire({ ...params, visualId:'visual-b' }), { code:'MEDIA_RATE_WAIT' });
  time += 30_000;
  const two = b.acquire({ ...params, visualId:'visual-b' });
  two.finish({ error:{code:'NETWORK_TIMEOUT'}, responseReceived:false });
  time += 31_000;
  assert.throws(() => a.acquire({ ...params, visualId:'visual-b' }), { code:'MEDIA_OUTCOME_UNKNOWN' });
  assert.equal(retryAfterDelayMs('120', 0), 120_000);
  assert.equal(retryAfterDelayMs(new Date(120_000).toUTCString(), 0), 120_000);
});

test('two real processes sharing one SQLite file never own the visual lane together', async (t) => {
  const { first } = setup(t);
  const filename = first.location || first.filename;
  // DatabaseSync does not expose its filename on all Node builds; the fixture
  // path is obtained from SQLite itself rather than a second assumed location.
  const dbPath = first.prepare('PRAGMA database_list').all().find((row) => row.name === 'main').file;
  const childPath = path.resolve('test-support/media-quota-child.mjs');
  const launch = (visualId) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childPath], { env:{...process.env,TEST_DATABASE_PATH:dbPath,TEST_VISUAL_ID:visualId},
      stdio:['pipe','pipe','pipe'],windowsHide:true });
    let output='';
    child.stdout.on('data',(chunk)=>{ output+=chunk; if(output.includes('\n')) resolve({child,result:output.trim()}); });
    child.once('error',reject);
  });
  const a = await launch('process-a');
  assert.equal(a.result, 'ACQUIRED');
  const b = await launch('process-b');
  assert.equal(b.result, 'MEDIA_RATE_WAIT');
  a.child.stdin.write('finish\n');
  await new Promise((resolve)=>a.child.once('exit',resolve));
  const simultaneous = first.prepare(`SELECT COUNT(*) AS n FROM media_dispatches WHERE state='dispatch_started'`).get().n;
  assert.equal(simultaneous, 0);
});
