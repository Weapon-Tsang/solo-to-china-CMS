import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadConfig} from '../src/config.mjs';
import {createApplication} from '../src/server.mjs';
import {openDatabase} from '../src/db.mjs';
import {classifyCaptureApiError} from '../extension/sync-core.js';

test('exact extension Origin permits only the authenticated empty identity check and creates no work',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'stc-origin-check-'));
  openDatabase(path.join(directory,'test.sqlite')).close();
  const origin='chrome-extension://fhgmkgadfofhhmjmjfojajhnnhdjjgin';
  const app=createApplication(loadConfig({HOST:'127.0.0.1',PORT:'0',DATABASE_PATH:path.join(directory,'test.sqlite'),
    CAPTURE_TOKEN:'isolated-origin-test-token',CAPTURE_ALLOWED_ORIGINS:origin,
    CMS_PROCESS_ROLE:'api',CMS_STARTUP_RECONCILIATION_ENABLED:'false',MAINTENANCE_ENABLED:'false',LOG_LEVEL:'error'}));
  await app.start();
  t.after(async()=>{await app.stop();const resolved=fs.realpathSync(directory);assert.ok(resolved.startsWith(fs.realpathSync(os.tmpdir())+path.sep));fs.rmSync(resolved,{recursive:true});});
  const url=`http://127.0.0.1:${app.server.address().port}/api/captures/identity-check`;
  const request=(requestOrigin,token)=>fetch(url,{method:'POST',headers:{origin:requestOrigin,'content-type':'application/json',authorization:`Bearer ${token}`},body:'{"items":[]}'});
  const good=await request(origin,'isolated-origin-test-token');
  assert.equal(good.status,200);assert.deepEqual(await good.json(),{items:[]});
  assert.equal(good.headers.get('access-control-allow-origin'),origin);
  const badToken=await request(origin,'wrong');assert.equal(badToken.status,401);
  const denied=await request('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','isolated-origin-test-token');
  assert.equal(denied.status,403);assert.equal(classifyCaptureApiError(denied.status,await denied.json()).code,'CAPTURE_ORIGIN_DENIED');
  const preflight=await fetch(url,{method:'OPTIONS',headers:{origin,'access-control-request-method':'POST','access-control-request-headers':'authorization,content-type'}});
  assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),origin);
  for(const table of ['sources','jobs','model_call_metrics'])assert.equal(app.repository.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
});
