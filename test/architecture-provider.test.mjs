import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiClient } from '../src/ai/client.mjs';
import { createProviderRateLimiter } from '../src/ai/provider-rate-limiter.mjs';
import {createMediaRequestExecutor} from '../src/media-request-executor.mjs';
import {repositoryFixture} from '../test-support/repository-fixture.mjs';

const input = { name:'dispatch_regression', instructions:'Return JSON.', content:'fixed golden input',
  schema:{ type:'object', required:['answer'], properties:{ answer:{type:'string'} } } };
const config = provider => ({ provider, apiKey:'test', accessToken:'test', projectId:'test',
  baseUrl:'https://example.test/v1', model:'test-model', schemaModeRegistry:new Map() });
function reply(provider, output) {
  if (provider === 'vertex') return Response.json({ candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(output)}]}}] });
  if (provider === 'openai') return Response.json({ status:'completed', output:[{content:[{type:'output_text',text:JSON.stringify(output)}]}] });
  return Response.json({ choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}] });
}

for (const provider of ['vertex','kimi','deepseek','openai']) {
  test(`${provider}: every structured repair acquires and completes its own dispatch, cache reuse is free`, async () => {
    let calls=0, acquired=0;
    const receipts=[];
    const client=createAiClient(config(provider),async()=>reply(provider,++calls===1 ? {} : {answer:'ok'}));
    const request={...input,onProviderDispatch:()=>{ acquired++; return {finish:receipt=>receipts.push(receipt)}; }};
    assert.equal((await client.completeJson(request)).output.answer,'ok');
    await client.completeJson(request);
    assert.equal(calls,2); assert.equal(acquired,2); assert.equal(receipts.length,2);
    assert.equal(receipts[0].responseReceived,true); assert.ok(receipts[0].error);
    assert.equal(receipts[1].error,null);
  });
  test(`${provider}: exhausted durable budget stops an internal retry before HTTP dispatch`, async () => {
    let calls=0, permits=0;
    const metrics=[];
    const client=createAiClient({...config(provider),onModelCall:m=>metrics.push(m)},async()=>{calls++;return reply(provider,{});});
    await assert.rejects(client.completeJson({...input,onProviderDispatch:()=>{
      if (++permits>1) throw Object.assign(new Error('budget exhausted'),{code:'MEDIA_BUDGET_EXHAUSTED'});
      return {finish(){}};
    }}),{code:'MEDIA_BUDGET_EXHAUSTED'});
    assert.equal(calls,1); assert.equal(metrics.length,1,'a local gate is not a provider attempt');
  });
}

test('Vertex schema transport fallback is separately budgeted',async()=>{
  let calls=0, acquired=0;
  const receipts=[];
  const client=createAiClient(config('vertex'),async()=>++calls===1
    ? Response.json({error:{message:'unsupported responseSchema'}},{status:400}) : reply('vertex',{answer:'ok'}));
  await client.completeJson({...input,onProviderDispatch:()=>{acquired++;return {finish:r=>receipts.push(r)};}});
  assert.equal(calls,2);assert.equal(acquired,2);assert.equal(receipts[0].error.status,400);
});

test('cancellation releases a quota waiter promptly and does not reserve quota for it',async()=>{
  const limiter=createProviderRateLimiter({limits:{vertex:{rpm:1}}});
  await limiter.acquire({provider:'vertex',model:'test'});
  const controller=new AbortController();
  const waiting=limiter.acquire({provider:'vertex',model:'test',signal:controller.signal});
  await new Promise(resolve=>setImmediate(resolve));
  controller.abort(new Error('lease lost'));
  await assert.rejects(waiting,/lease lost/);
  assert.equal(limiter.snapshot()[0].requestsLastMinute,1);
});

test('cooldown received during a spacing wait is rechecked before admission',async()=>{
  let now=1_000, pauses=0;
  const limiter=createProviderRateLimiter({spacingMs:100,now:()=>now,sleep:async ms=>{
    now+=ms;
    if (++pauses===1) limiter.penalize({provider:'vertex',model:'test',retryAfterMs:10_000});
  }});
  await limiter.acquire({provider:'vertex',model:'test'});
  await limiter.acquire({provider:'vertex',model:'test'});
  assert.equal(now,11_100);
});

test('ordinary requests can wait for spacing without providing an AbortSignal',async()=>{
  const limiter=createProviderRateLimiter({spacingMs:2});
  await limiter.acquire({provider:'vertex',model:'test'});
  await limiter.acquire({provider:'vertex',model:'test'});
  assert.equal(limiter.snapshot()[0].requestsLastMinute,2);
});

test('cancellation while acquiring a permit settles it without claiming a provider response',async t=>{
  const {db}=repositoryFixture(t);const executor=createMediaRequestExecutor(db);
  const controller=new AbortController();let calls=0;
  const client=createAiClient(config('vertex'),async()=>{calls++;});
  await assert.rejects(client.completeJson({...input,signal:controller.signal,onProviderDispatch:async()=>{
    const permit=executor.acquire({provider:'vertex',model:'test',visualId:'cancelled',substage:'analyze_source_image'});
    controller.abort(new Error('lease lost'));return permit;
  }}),/lease lost/);
  assert.equal(calls,0);
  const dispatch=db.prepare('SELECT state,http_status,error_code FROM media_dispatches').get();
  assert.deepEqual({...dispatch},{state:'failed',http_status:null,error_code:'CANCELLED_BEFORE_DISPATCH'});
  assert.equal(db.prepare('SELECT owner_token FROM media_visual_lane WHERE id=1').get().owner_token,null);
});

test('cancelled input cannot acquire a paid permit or dispatch after admission',async()=>{
  const controller=new AbortController();let calls=0,permits=0;
  const client=createAiClient({...config('kimi'),beforeRequest:()=>controller.abort(new Error('lease lost'))},async()=>{calls++;});
  await assert.rejects(client.completeJson({...input,signal:controller.signal,onProviderDispatch:()=>{permits++;}}),/lease lost/);
  assert.equal(calls,0);assert.equal(permits,0);
});

test('durable permit waiting is separate from measured provider latency',async()=>{
  const originalNow=Date.now;let at=1_000_000;
  Date.now=()=>at;
  try {
    const metrics=[];
    const client=createAiClient({...config('vertex'),onModelCall:metric=>metrics.push(metric)},async()=>{
      at+=17;return reply('vertex',{answer:'ok'});
    });
    await client.completeJson({...input,onProviderDispatch:async()=>{at+=5000;return {finish(){}};}});
    assert.equal(metrics[0].retryWaitMs,5000);
    assert.equal(metrics[0].providerRequestMs,17);
  }finally{Date.now=originalNow;}
});

test('HTTP repairs consume durable dispatches; settled recognition fails while generation retains unknown outcome',async t=>{
  const {db}=repositoryFixture(t);let time=Date.now(),calls=0;
  const executor=createMediaRequestExecutor(db,{rpm:1000,windowMs:1,safetyMarginMs:0,maxDispatches:2,clock:()=>++time});
  const acquire=visualId=>()=>executor.acquire({provider:'vertex',model:'test',visualId,substage:'analyze_source_image'});
  const client=createAiClient(config('vertex'),async()=>reply('vertex',++calls===1?{}:{answer:'ok'}));
  await client.completeJson({...input,onProviderDispatch:acquire('source-image')});
  await client.completeJson({...input,onProviderDispatch:acquire('source-image')});
  assert.equal(executor.budget({visualId:'source-image',substage:'analyze_source_image'}).spent,2);
  assert.deepEqual(db.prepare('SELECT state FROM media_dispatches ORDER BY started_at_ms').all().map(r=>r.state),['failed','completed']);
  const failing=createAiClient(config('vertex'),async()=>{throw new TypeError('connection lost');});
  await assert.rejects(failing.completeJson({...input,onProviderDispatch:acquire('unknown-image')}));
  assert.equal(db.prepare("SELECT state FROM media_dispatches WHERE visual_id='unknown-image'").get().state,'failed');
  await assert.rejects(failing.completeJson({...input,onProviderDispatch:()=>executor.acquire({provider:'vertex',model:'test',
    visualId:'unknown-generation',substage:'generate_image'})}));
  assert.equal(db.prepare("SELECT state FROM media_dispatches WHERE visual_id='unknown-generation'").get().state,'outcome_unknown');
  assert.equal(db.prepare('SELECT owner_token FROM media_visual_lane WHERE id=1').get().owner_token,null);
});

test('a truncated Kimi event stream records its failed attempt and releases its durable lane',async t=>{
  const {db}=repositoryFixture(t);
  const executor=createMediaRequestExecutor(db);
  const metrics=[];
  const client=createAiClient({...config('kimi'),onModelCall:m=>metrics.push(m)},async()=>new Response(new ReadableStream({
    start(controller){controller.error(new Error('stream interrupted'));}
  }),{headers:{'content-type':'text/event-stream'}}));
  await assert.rejects(client.completeJson({...input,onProviderDispatch:()=>executor.acquire({provider:'kimi',model:'test',
    visualId:'interrupted-image',substage:'analyze_source_image'})}));
  assert.equal(metrics.length,1);assert.equal(metrics[0].status,'failed');
  assert.equal(db.prepare('SELECT state FROM media_dispatches').get().state,'failed');
  assert.equal(db.prepare('SELECT owner_token FROM media_visual_lane WHERE id=1').get().owner_token,null);
});
