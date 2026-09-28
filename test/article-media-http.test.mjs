import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openDatabase} from '../src/db.mjs';
import {loadConfig} from '../src/config.mjs';
import {createApplication} from '../src/server.mjs';
import {seedCoverFixture} from '../test-support/cover-fixture.mjs';
import {mediaHash} from '../src/web-media.mjs';

test('actual authenticated API streaming, ownership, CSRF, confirmation, lost receipt recovery and nonempty latency',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cms-manual-http-')),databasePath=path.join(directory,'test.sqlite');openDatabase(databasePath).close();
  const app=createApplication(loadConfig({HOST:'127.0.0.1',PORT:'0',DATABASE_PATH:databasePath,CMS_DATA_ROOT:directory,GENERATED_MEDIA_DIR:path.join(directory,'media'),SOURCE_UPLOADS_DIR:path.join(directory,'sources'),
    CAPTURE_MEDIA_UPLOADS_DIR:path.join(directory,'uploads'),CMS_PROCESS_ROLE:'api',MAINTENANCE_ENABLED:'false',LOG_LEVEL:'error',ADMIN_TOKEN:'manual-test-token',ADMIN_USERNAME:'editor',ADMIN_PASSWORD:'local-only-password',SESSION_SECRET:'fixture-session-secret'}));
  t.after(async()=>{await app.stop();fs.rmSync(directory,{recursive:true,force:true});});
  const seed=await seedCoverFixture(app.repository,path.join(directory,'media'));await app.start();
  const root=`http://127.0.0.1:${app.server.address().port}`,base=`${root}/api/drafts/${seed.draftId}/article-media`,auth={authorization:'Bearer manual-test-token'};
  assert.equal((await fetch(base)).status,401);
  const payload={expected_revision:2,name:'Photo.png',size:seed.bytes.length,sha256:seed.hash,mimeType:'image/png'};
  const send=(url,input,headers={})=>fetch(url,{method:'POST',headers:{...auth,'content-type':'application/json',...headers},body:JSON.stringify(input)});
  assert.equal((await send(`${base}/uploads`,payload,{origin:'https://evil.invalid'})).status,403);
  assert.equal((await send(`${base}/uploads`,payload,{'sec-fetch-site':'cross-site'})).status,403);
  const created=await(await send(`${base}/uploads`,payload)).json();assert.ok(created.id);assert.equal(created.upload.localPath,undefined);
  const session=`${base}/uploads/${created.id}`;
  assert.equal((await fetch(`${session}/chunks/0`,{method:'PUT',headers:{...auth,'x-chunk-sha256':seed.hash},body:seed.bytes})).status,200);
  const complete=await send(`${session}/complete`,{});assert.equal(complete.status,200);const stored=await complete.json();assert.equal(stored.state,'pending_confirmation');
  assert.equal((await(await fetch(session,{headers:auth})).json()).asset_id,stored.asset_id);
  const preview=await fetch(`${session}/preview`,{headers:auth});assert.equal(preview.status,200);assert.equal(preview.headers.get('cache-control'),'private, no-store');
  const input={expected_revision:2,expected_media_revision:0,selections:[{upload_id:created.id,slot_id:seed.visualId,purpose:'body',kind:'photo',caption:'East Hall.',description:'Confirmed scene.',factual_photo:true,no_reader_text:true,quality_confirmed:true}]};
  const plan=await(await send(`${base}/plan`,input)).json();assert.ok(plan.plan_hash);
  const denied=await send(`${base}/confirm`,{...input,plan_hash:plan.plan_hash,idempotency_key:'http_confirmation_01'});assert.equal(denied.status,400);
  const before=app.repository.db.prepare('SELECT body_markdown,revision,content_hash,title,slug FROM article_drafts').get();
  const adopted=await(await send(`${base}/confirm`,{...input,confirmed:true,plan_hash:plan.plan_hash,idempotency_key:'http_confirmation_01'})).json();assert.equal(adopted.state,'local_ready');
  assert.deepEqual(app.repository.db.prepare('SELECT body_markdown,revision,content_hash,title,slug FROM article_drafts').get(),before);
  const times=[];for(let i=0;i<30;i++){const start=performance.now();const response=await fetch(base,{headers:auth});const value=await response.json();assert.equal(value.total,1);times.push(performance.now()-start);}
  times.sort((a,b)=>a-b);console.log(JSON.stringify({nonempty_samples:30,p50_ms:times[14],p95_ms:times[28],provider_calls:app.repository.db.prepare('SELECT COUNT(*) n FROM model_call_metrics').get().n,
    body_hash:mediaHash(before.body_markdown),api_only:true}));
});
