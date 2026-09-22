import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
  return { first, second, directory };
}

test('only a hash-verified pending QA candidate can reconcile an unknown dispatch',t=>{
  const {first,second,directory}=setup(t);
  first.prepare(`INSERT INTO topic_candidates(id,destination_slug,topic_key,proposed_title,rationale,coverage_score,evidence_count,conflict_count,status,created_at,updated_at)
    VALUES ('qa-topic','beijing','qa','QA test','fixture',80,0,0,'drafted','now','now')`).run();
  first.prepare(`INSERT INTO content_opportunities(id,destination_slug,topic_key,strategy_version,candidate_id,title,
    readiness_score,readiness_json,status,approved_at,created_at,updated_at,lifecycle_state)
    VALUES ('qa-owner','beijing','qa','3.9','qa-topic','QA test',100,'{"ready":true}',
      'producing','now','now','now','producing')`).run();
  first.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at,candidate_id)
    VALUES ('qa-brief','beijing','Test','[]','informational','drafted','now','now','qa-topic')`).run();
  first.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at)
    VALUES ('qa-draft','qa-brief','Test','test','Preserved body','{}','needs_review','now','now')`).run();
  first.prepare(`INSERT INTO article_visuals(id,draft_id,slot,placement,purpose,alt_text,generation_prompt,status,created_at,updated_at)
    VALUES ('qa-visual','qa-draft',1,'hero','Test','Test','Test','failed','now','now')`).run();
  const bytes=Buffer.from('persisted candidate bytes');
  const candidateHash=crypto.createHash('sha256').update(bytes).digest('hex');
  const mediaPath=path.join(directory,'candidate.png');fs.writeFileSync(mediaPath,bytes);
  first.prepare(`INSERT INTO visual_candidates(id,visual_id,draft_id,transform_input_hash,output_hash,media_path,mime_type,byte_size,
    provider,model,status,created_at,updated_at) VALUES ('qa-candidate','qa-visual','qa-draft','transform',?,?,
      'image/png',?,'vertex','model','pending_qa','now','now')`).run(candidateHash,mediaPath,bytes.length);
  first.prepare(`INSERT INTO media_dispatches(id,scope_key,visual_id,substage,started_at_ms,state,error_code,created_at)
    VALUES ('qa-dispatch','vertex:project:model','qa-visual','visual_quality_qa',?,'outcome_unknown','PROVIDER_TIMEOUT','now')`)
    .run(Date.now()-300_000);
  const executor=createMediaRequestExecutor(second);
  const request={opportunityId:'qa-owner',visualId:'qa-visual',candidateId:'qa-candidate',candidateHash,
    dispatchId:'qa-dispatch',actor:'editor',reason:'Verified saved candidate and timeout',idempotencyKey:'qa-reconcile-1'};
  assert.throws(()=>executor.reconcileUnknownQa({...request,candidateHash:'wrong'}),{statusCode:409});
  assert.equal(executor.reconcileUnknownQa(request).idempotent,false);
  assert.equal(executor.reconcileUnknownQa(request).idempotent,true);
  assert.equal(first.prepare('SELECT state FROM media_dispatches WHERE id=?').get('qa-dispatch').state,'failed');
  assert.equal(first.prepare("SELECT COUNT(*) AS n FROM production_record_audit WHERE action='reconcile_unknown_visual_qa'").get().n,1);
  assert.throws(()=>executor.reconcileUnknownQa({...request,idempotencyKey:'qa-reconcile-2'}),{statusCode:409});
  first.prepare("UPDATE media_dispatches SET state='outcome_unknown',substage='generate_visual' WHERE id='qa-dispatch'").run();
  assert.throws(()=>executor.reconcileUnknownQa({...request,idempotencyKey:'qa-reconcile-3'}),{statusCode:409});
});

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

test('explicit grant is durable, idempotent and retains cumulative spent and quota cooldown', (t) => {
  const {first,second} = setup(t);
  let time=100_000;
  const config={rpm:2,maxDispatches:2,clock:()=>time};
  const params={provider:'vertex',model:'image-model',accountScope:'project',visualId:'visual-a',substage:'generate_visual'};
  const a=createMediaRequestExecutor(first,config);
  const b=createMediaRequestExecutor(second,config);
  a.acquire(params).finish({error:{status:429,code:'RESOURCE_EXHAUSTED'},responseReceived:true});
  time+=61_000;
  b.acquire(params).finish({error:{status:429,code:'RESOURCE_EXHAUSTED'},responseReceived:true});
  assert.throws(()=>a.acquire(params),{code:'MEDIA_BUDGET_EXHAUSTED'});
  const approved=a.grant({...params,additionalDispatches:1,actor:'editor',reason:'Reviewed failed image',idempotencyKey:'grant-1'});
  assert.deepEqual([approved.spent,approved.granted,approved.limit,approved.unknown],[2,1,3,0]);
  assert.equal(b.grant({...params,additionalDispatches:1,actor:'editor',reason:'Reviewed failed image',idempotencyKey:'grant-1'}).idempotent,true);
  assert.throws(()=>b.grant({...params,additionalDispatches:1,actor:'editor',reason:'Again',idempotencyKey:'grant-2'}),{statusCode:409});
  assert.throws(()=>b.acquire(params),{code:'MEDIA_RATE_WAIT'});
  time+=120_000;
  b.acquire(params).finish();
  assert.deepEqual([a.budget(params).spent,a.budget(params).granted],[3,1]);
  assert.throws(()=>a.acquire(params),{code:'MEDIA_BUDGET_EXHAUSTED'});
  const next=b.grant({...params,additionalDispatches:2,actor:'editor',reason:'QA needs more attempts',idempotencyKey:'grant-2'});
  assert.equal(next.limit,5);
  assert.equal(first.prepare('SELECT COUNT(*) AS n FROM media_budget_grants').get().n,2);
});

test('an unknown exhausted dispatch cannot be unlocked by an operator grant',t=>{
  const {first,second}=setup(t);
  const executor=createMediaRequestExecutor(first,{maxDispatches:1});
  const params={provider:'vertex',model:'image-model',accountScope:'project',visualId:'unknown-visual',substage:'generate_visual'};
  executor.acquire(params).finish({error:{code:'NETWORK_TIMEOUT'},responseReceived:false});
  const afterRestart=createMediaRequestExecutor(second,{maxDispatches:1});
  assert.equal(afterRestart.budget(params).unknown,1);
  assert.throws(()=>afterRestart.grant({...params,additionalDispatches:1,actor:'editor',reason:'Attempted override',
    idempotencyKey:'unknown-grant'}),{statusCode:409});
  assert.equal(second.prepare('SELECT COUNT(*) AS n FROM media_budget_grants').get().n,0);
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
