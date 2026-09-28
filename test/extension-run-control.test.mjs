import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, classifyCaptureApiError } from '../extension/sync-core.js';
import { bounded, sameRun, tabMatches } from '../extension/run-control.js';

const scope = {key:'scope-test',url:'https://www.xiaohongshu.com/board/test123',label:'Fixture'};
const event = () => { const listeners = new Set(); return { addListener: f => listeners.add(f), removeListener: f => listeners.delete(f), emit: (...args) => { for (const f of listeners) f(...args); } }; };
async function fixture(t) {
  const storage = {}; const tabs = new Map(); const events = []; let next = 10;
  const area = data => ({get:async defaults => structuredClone(Object.fromEntries(Object.entries(defaults).map(([k,v])=>[k,data[k]??v]))),set:async value=>Object.assign(data,structuredClone(value))});
  const removed = event();
  globalThis.chrome = {
    storage:{local:area(storage),session:area({favoritesBrowserIdentity:'test-browser'})},
    runtime:{onInstalled:event(),onStartup:event(),onMessage:event(),getManifest:()=>({version:'2.0.71'})},
    alarms:{onAlarm:event(),create:async()=>{},clear:async()=>true},
    scripting:{executeScript:async()=>[]},
    tabs:{onRemoved:removed,onUpdated:event(),query:async()=>[],get:async id=>{if(!tabs.has(id))throw Error('No tab');return tabs.get(id);},
      create:async options=>{const tab={id:next++,windowId:1,status:'complete',...options};tabs.set(tab.id,tab);events.push(['create',tab.id]);return tab;},
      remove:async id=>{tabs.delete(id);events.push(['remove',id]);removed.emit(id,{isWindowClosing:false});}}
  };
  const nativeFetch=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({items:[]});
  const background=await import(`../extension/background.js?control=${crypto.randomUUID()}`);
  await background.restoreAfterRestart();
  const session=createSession({scope});
  Object.assign(session,{runRevision:1,controlSchema:1,browserIdentity:'test-browser',discoveryTabId:1,
    tabOwnership:{1:{tabId:1,windowId:1,url:scope.url,role:'discovery',owned:false}}});
  tabs.set(1,{id:1,windowId:1,url:scope.url,status:'complete'}); storage.favoritesSyncState=session;
  t.after(async()=>{await background.handleMessage({type:'CANCEL_SYNC'});await new Promise(r=>setTimeout(r,10));globalThis.fetch=nativeFetch;});
  return {background,storage,tabs,events,removed,session};
}
test('XP-01/02/04: owned page removal persists pause across watchdog and restart; unrelated removal is ignored',async t=>{
  const f=await fixture(t);
  f.removed.emit(88,{});await new Promise(r=>setTimeout(r,10));assert.equal(f.storage.favoritesSyncState.status,'running');
  f.tabs.delete(1);f.removed.emit(1,{isWindowClosing:true});
  for(let i=0;i<50&&f.storage.favoritesSyncState.status==='running';i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(f.storage.favoritesSyncState.status,'paused_tab_closed');
  for(let i=0;i<3;i++){await f.background.watchdog();await f.background.restoreAfterRestart();}
  assert.equal(f.events.filter(e=>e[0]==='create').length,0);
  assert.equal(f.storage.favoritesSyncState.autoBlocked,true);
});
test('XP-06: late create is disposed and cannot register into paused revision',async t=>{
  const f=await fixture(t);let release;
  const original=chrome.tabs.create;
  chrome.tabs.create=options=>new Promise(resolve=>{release=async()=>resolve(await original(options));});
  const pending=f.background.createOwnedTab(f.session,'https://www.xiaohongshu.com/explore/test','worker');
  while(!release)await new Promise(r=>setTimeout(r,1));
  await f.background.handleMessage({type:'PAUSE_SYNC'});await release();
  await assert.rejects(pending,{code:'RUN_REVOKED'});
  assert.equal(f.tabs.size,1);assert.equal(f.storage.favoritesSyncState.status,'paused_by_user');
  assert.equal(Object.keys(f.storage.favoritesSyncState.tabOwnership).length,1);
});
test('XP-03/16: cleanup never closes borrowed or repurposed pages and is idempotent',async t=>{
  const f=await fixture(t);
  const tab=await f.background.createOwnedTab(f.session,'https://www.xiaohongshu.com/explore/test','worker');
  f.tabs.get(tab.id).url='https://example.org/';
  await f.background.closeWorkerTabs(f.storage.favoritesSyncState);await f.background.closeWorkerTabs(f.storage.favoritesSyncState);
  assert.equal(f.tabs.size,2);assert.equal(f.events.filter(e=>e[0]==='remove').length,0);
  delete f.storage.favoritesSyncState.browserIdentity;
  await f.background.restoreAfterRestart();assert.equal(f.storage.favoritesSyncState.status,'paused_tab_closed');
});
test('XP-08: local pause does not await unreachable reporting and old discovery cannot overwrite queue',async t=>{
  const f=await fixture(t);let reportStarted=false;
  globalThis.fetch=async()=>{reportStarted=true;throw Error('offline');};
  const old=structuredClone(f.session);old.queue=[];
  f.storage.favoritesSyncState.queue=[{taskId:'success',status:'captured',identityKey:'xhs:done'}];
  const started=performance.now();const paused=await f.background.handleMessage({type:'PAUSE_SYNC'});
  assert.equal(paused.ok,true);assert.ok(performance.now()-started<1000);
  await f.background.persistProgress(old);
  assert.equal(f.storage.favoritesSyncState.queue.length,1);assert.equal(f.storage.favoritesSyncState.status,'paused_by_user');
  await new Promise(r=>setTimeout(r,5));assert.ok(reportStarted);
});
test('XP-08/09: automatic offline preflight never opens a tab; read-only and auth remain distinct',async t=>{
  const f=await fixture(t);f.storage.favoritesSyncState.status='completed';
  f.storage.favoritesSyncSettings={autoSync:'daily',lastScopeUrl:scope.url,lastScopeKey:scope.key};
  globalThis.fetch=async()=>{throw Error('offline');};
  await assert.rejects(f.background.startAutomaticSync(),{code:'CAPTURE_SERVER_UNAVAILABLE'});
  assert.equal(f.events.length,0);
  assert.equal(classifyCaptureApiError(403,{error:'migration-review is read-only'}).code,'CAPTURE_READ_ONLY');
  assert.equal(classifyCaptureApiError(401,{}).code,'CAPTURE_UNAUTHORIZED');
});
test('XP-10: cancellation removes load listeners; DOM deadline rejects a never-returning script',async t=>{
  const f=await fixture(t);f.tabs.get(1).status='loading';
  const controller=new AbortController();
  const waiting=f.background.waitForTab(1,30_000,controller.signal);
  controller.abort();await assert.rejects(waiting);
  chrome.scripting.executeScript=()=>new Promise(()=>{});
  await assert.rejects(f.background.execute(1,()=>null,undefined,undefined,20),{code:'DOM_TIMEOUT'});
});
test('XP-05/06: double Resume creates one replacement and increments the persisted fence once',async t=>{
  const f=await fixture(t);
  await f.background.handleMessage({type:'PAUSE_SYNC'});f.tabs.delete(1);
  const before=f.storage.favoritesSyncState.runRevision;
  const replies=await Promise.all([f.background.handleMessage({type:'RESUME_SYNC'}),f.background.handleMessage({type:'RESUME_SYNC'})]);
  assert.ok(replies.every(reply=>reply.ok));
  assert.equal(f.events.filter(e=>e[0]==='create').length,1);
  assert.equal(f.storage.favoritesSyncState.runRevision,before+1);
  await f.background.handleMessage({type:'PAUSE_SYNC'});
});
test('XP-04: cancelled scope stays blocked for a new automatic session',async t=>{
  const f=await fixture(t);f.storage.favoritesSyncSettings={autoSync:'daily',lastScopeUrl:scope.url,lastScopeKey:scope.key};
  await f.background.handleMessage({type:'CANCEL_SYNC'});
  const response=await f.background.startAutomaticSync();
  assert.equal(response,undefined);
  assert.equal(f.events.filter(e=>e[0]==='create').length,0);
  assert.equal(f.storage.favoritesSyncState.status,'cancelled');
});
test('XP-08: reporting retry is durable and capped without reviving a paused run',async t=>{
  const f=await fixture(t);let calls=0;
  globalThis.fetch=async()=>{calls++;throw Error('offline');};
  await f.background.handleMessage({type:'PAUSE_SYNC'});
  for(let attempt=1;attempt<=3;attempt++){
    for(let i=0;i<40&&calls<attempt;i++)await new Promise(r=>setTimeout(r,2));
    await new Promise(r=>setTimeout(r,10));
    if(f.storage.favoritesReportOutbox)f.storage.favoritesReportOutbox.nextAt=0;
    await f.background.watchdog();
  }
  await new Promise(r=>setTimeout(r,10));
  assert.equal(calls,3);assert.equal(f.storage.favoritesReportOutbox,null);
  assert.equal(f.storage.favoritesSyncState.status,'paused_by_user');
});
test('XP-06: simultaneous manual starts share one preflight and one session',async t=>{
  const f=await fixture(t);f.storage.favoritesSyncState.status='completed';
  chrome.tabs.query=async()=>[f.tabs.get(1)];let preflights=0;
  globalThis.fetch=async()=>{preflights++;await new Promise(r=>setTimeout(r,10));return Response.json({items:[]});};
  const replies=await Promise.all([f.background.handleMessage({type:'START_SYNC'}),f.background.handleMessage({type:'START_SYNC'})]);
  assert.ok(replies.every(r=>r.ok));assert.equal(replies[0].session.sessionId,replies[1].session.sessionId);
  assert.equal(preflights,1);assert.equal(f.events.filter(e=>e[0]==='create').length,0);
  await f.background.handleMessage({type:'PAUSE_SYNC'});
});
test('XP-09: missing CMS host permission fails before network or tab creation',async t=>{
  const f=await fixture(t);f.storage.favoritesSyncState.status='completed';
  chrome.permissions={contains:async()=>false};let requests=0;
  globalThis.fetch=async()=>{requests++;return Response.json({items:[]});};
  await assert.rejects(f.background.handleMessage({type:'START_SYNC'}),{code:'CAPTURE_HOST_PERMISSION'});
  assert.equal(requests,0);assert.equal(f.events.length,0);
});
test('run fence includes status and revision; matching URL alone cannot establish ownership',()=>{
  assert.equal(sameRun({sessionId:'s',runRevision:2,status:'running'},{sessionId:'s',runRevision:1}),false);
  assert.equal(tabMatches({id:2,windowId:1,url:scope.url},{tabId:1,windowId:1,url:scope.url}),false);
});
test('bounded waits stop without accepting late values',async()=>{
  let done;const pending=bounded(()=>new Promise(r=>{done=r;}),{timeoutMs:10,code:'TEST_TIMEOUT'});
  await assert.rejects(pending,{code:'TEST_TIMEOUT'});done('late');
});
