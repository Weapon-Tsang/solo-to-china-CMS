import assert from "node:assert/strict";
import test from "node:test";
import { indexedDB } from 'fake-indexeddb';
import { mediaJournal } from '../extension/media-journal.js';
import { applyIdentityBatch, createSession, mediaIdentitiesToRepair, transitionTask } from "../extension/sync-core.js";

test('text/DOM recapture re-persists all media for the new capture version',()=>{
  assert.equal(mediaIdentitiesToRepair({sourceId:'existing',repairActions:['RECAPTURE_TEXT_DOM'],repairMediaIdentities:[]}),null);
  assert.deepEqual([...mediaIdentitiesToRepair({sourceId:'existing',repairActions:['BROWSER_MEDIA_REPAIR'],repairMediaIdentities:['image-2']})],['image-2']);
  assert.equal(mediaIdentitiesToRepair({sourceId:null,repairMediaIdentities:[]}),null);
  let session=createSession({scope:{key:'scope:repair',url:'https://www.xiaohongshu.com/user/profile/test?tab=fav'},mode:'repair'});
  session=applyIdentityBatch(session,[{externalId:'existing-note',url:'https://www.xiaohongshu.com/explore/existing-note'}],[{
    externalId:'existing-note',known:false,sourceExists:true,sourceId:'existing',requiredActions:['RECAPTURE_TEXT_DOM'],
    repairMedia:{missingOriginals:[]},
  }]);
  assert.equal(session.queue.length,1);
  assert.equal(mediaIdentitiesToRepair(session.queue[0]),null);
});

test("MV3 module restart automatically requeues and drives an in-flight task without popup Resume", async () => {
  mediaJournal.factory = indexedDB;
  const storage = {};
  let createdTabs = 0;
  const listener = () => ({ addListener() {}, removeListener() {} });
  globalThis.chrome = {
    runtime: {
      onInstalled: listener(), onStartup: listener(), onMessage: listener(),
      getManifest: () => ({ version: "2.0.5" }),
    },
    alarms: { onAlarm: listener(), create: async () => {}, clear: async () => true },
    storage: { local: {
      get: async (defaults) => Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, storage[key] ?? value])),
      set: async (values) => Object.assign(storage, values),
    } },
    tabs: {
      query: async () => [],
      get: async (id) => ({ id, status: "complete", url: "https://www.xiaohongshu.com/explore/restart-active" }),
      update: async (id, options) => ({ id, status: "complete", url: options.url }),
      create: async (options) => ({ id: ++createdTabs, status: "complete", url: options.url }),
      remove: async () => {}, onUpdated: listener(), onRemoved: listener(),
    },
    scripting: { executeScript: async (options) => options.files ? [] : [{ result: {
      ok: false, error: { code: "NOTE_UNAVAILABLE", message: "fixture unavailable", retryable: false },
    } }] },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  try {
    const background = await import(`../extension/background.js?recovery=${Date.now()}`);
    const scope = { key: "scope:restart", url: "https://www.xiaohongshu.com/user/profile/test?tab=fav", label: "Favorites" };
    let session = createSession({ scope, settings: { concurrencyMode: "custom", customConcurrency: 2 } });
    session.phase = "acquisition";
    session.discoveryComplete = true;
    session = applyIdentityBatch(session, [
      { externalId: "restart-done", url: "https://www.xiaohongshu.com/explore/restart-done" },
      { externalId: "restart-active", url: "https://www.xiaohongshu.com/explore/restart-active" },
    ], [{ externalId: "restart-done", known: false }, { externalId: "restart-active", known: false }]);
    session = transitionTask(session, session.queue[0].taskId, "captured");
    session = transitionTask(session, session.queue[1].taskId, "extracting", {
      leaseId: "stale-lease", workerId: "old-worker", leaseStartedAt: session.startedAt,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    storage.favoritesSyncState = session;

    await background.restoreAfterRestart();
    for (let attempt = 0; attempt < 100 && storage.favoritesSyncState?.status === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(storage.favoritesSyncState.status, "completed_with_failures");
    assert.equal(storage.favoritesSyncState.stats.captured, 1);
    assert.equal(storage.favoritesSyncState.stats.failed, 1);
    assert.notEqual(storage.favoritesSyncState.status, "paused_recovered");
    assert.ok(createdTabs >= 1, "automatic drive should rebuild/use a worker tab");
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('frame replacement during execute reinjects once and preserves the task retry budget',async()=>{
  const listener=()=>({addListener(){},removeListener(){}});
  let calls=0;
  let injections=0;
  globalThis.chrome={
    runtime:{onInstalled:listener(),onStartup:listener(),onMessage:listener(),getManifest:()=>({version:'2.0.47'})},
    alarms:{onAlarm:listener(),create:async()=>{},clear:async()=>true},
    storage:{local:{get:async(defaults)=>defaults,set:async()=>{}}},
    tabs:{get:async(id)=>({id,status:'complete'}),onUpdated:listener(),onRemoved:listener()},
    scripting:{executeScript:async(options)=>{
      if(options.files){injections++;return [];}
      calls++;
      if(calls===1)throw new Error('Frame with ID 0 was removed.');
      return [{result:{ok:true}}];
    }},
  };
  const background=await import(`../extension/background.js?frame=${Date.now()}`);
  assert.equal((await background.execute(7,()=>42)).ok,true);
  assert.equal(calls,2);
  assert.equal(injections,1);
});

test('an unsupported Favorites layout pauses discovery with an actionable error',async()=>{
  const listener=()=>({addListener(){},removeListener(){}});
  const scope={key:'scope:board',url:'https://www.xiaohongshu.com/board/board123',label:'Favorites'};
  const storage={};
  globalThis.chrome={
    runtime:{onInstalled:listener(),onStartup:listener(),onMessage:listener(),getManifest:()=>({version:'2.0.69'})},
    alarms:{onAlarm:listener(),create:async()=>{},clear:async()=>true},
    storage:{local:{get:async(defaults)=>Object.fromEntries(Object.entries(defaults).map(([key,value])=>[key,storage[key]??value])),
      set:async(values)=>Object.assign(storage,values)}},
  };
  const background=await import(`../extension/background.js?driver=${Date.now()}`);
  storage.favoritesSyncState=createSession({scope});
  await background.handleDriverError({code:'SELECTOR_MISMATCH',message:'No note cards recognized.',retryable:false});
  assert.equal(storage.favoritesSyncState.status,'paused_error');
  assert.equal(storage.favoritesSyncState.lastError.code,'SELECTOR_MISMATCH');
  assert.equal(storage.favoritesSyncState.driveRetryAt,null);
});

test('watchdog does not requeue an active browser task just because the session has been quiet',async()=>{
  const listener=()=>({addListener(){},removeListener(){}});
  const storage={};
  globalThis.chrome={
    runtime:{onInstalled:listener(),onStartup:listener(),onMessage:listener(),getManifest:()=>({version:'2.0.69'})},
    alarms:{onAlarm:listener(),create:async()=>{},clear:async()=>true},
    storage:{local:{get:async(defaults)=>Object.fromEntries(Object.entries(defaults).map(([key,value])=>[key,storage[key]??value])),
      set:async(values)=>Object.assign(storage,values)}},
    tabs:{query:async()=>[],get:async(id)=>({id,status:'complete'}),onUpdated:listener(),onRemoved:listener()},
  };
  const background=await import(`../extension/background.js?watchdog=${Date.now()}`);
  const scope={key:'scope:watchdog',url:'https://www.xiaohongshu.com/board/board123',label:'Favorites'};
  let session=createSession({scope,settings:{concurrencyMode:'custom',customConcurrency:1,taskLeaseMs:180_000}});
  session.phase='acquisition';
  session.discoveryComplete=true;
  session=applyIdentityBatch(session,[{externalId:'slow-note',url:'https://www.xiaohongshu.com/explore/slow-note'}],[{externalId:'slow-note',known:false}]);
  const task=session.queue[0];
  session=transitionTask(session,task.taskId,'extracting',{leaseId:'live-lease',workerId:'worker-1',
    leaseStartedAt:new Date(Date.now()-150_000).toISOString(),leaseExpiresAt:new Date(Date.now()+30_000).toISOString(),
    updatedAt:new Date(Date.now()-150_000).toISOString()});
  session.lastProgressAt=new Date(Date.now()-150_000).toISOString();
  storage.favoritesSyncState=session;

  await background.watchdog();

  assert.equal(storage.favoritesSyncState.queue[0].status,'extracting');
  assert.equal(storage.favoritesSyncState.queue[0].leaseId,'live-lease');
});
