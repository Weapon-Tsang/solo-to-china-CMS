// Isolated real MV3 + real CMS acceptance. No user profile, .env or provider.
// Usage: node scripts/verify-extension-pre-browser.mjs <absolute playwright module>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { loadConfig } from '../src/config.mjs';
import { createApplication } from '../src/server.mjs';
import { openDatabase } from '../src/db.mjs';

const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stc-02pre-'));
const extension = path.join(root,'extension');
fs.cpSync('extension',extension,{recursive:true});
const baseline=process.argv.includes('--baseline');
if(baseline)for(const file of fs.readdirSync('extension')){
  try {fs.writeFileSync(path.join(extension,file),execFileSync('git',['show',`HEAD:extension/${file}`],{stdio:['ignore','pipe','ignore']}));} catch { /* New helper is unused by the baseline. */ }
}
const manifest = JSON.parse(fs.readFileSync(path.join(extension,'manifest.json')));
manifest.host_permissions.push('http://127.0.0.1/*'); // isolated ephemeral fixture port only
manifest.background.service_worker='background-test.js';
fs.writeFileSync(path.join(extension,'background-test.js'),`import * as control from './background.js'; globalThis.__stcTest = control;`);
fs.writeFileSync(path.join(extension,'manifest.json'),JSON.stringify(manifest,null,2));
const evidence = path.resolve('docs/codex-cms-upgrade/evidence/phase-02-pre-extension');
const screenshots = path.resolve('output/playwright/phase02-pre');fs.mkdirSync(screenshots,{recursive:true});
const result = {root,extension,profile:path.join(root,'profile'),version:manifest.version,startedAt:new Date().toISOString(),
  buildDifference:'Isolated manifest adds http://127.0.0.1/* for ephemeral CMS port and test-only module bridge background-test.js importing unmodified production background; bridge invokes real exported deadline methods for fault injection.',
  checks:[],tabEvents:[],apiEvents:[],blockedNetwork:[]};
let context,app;
let fixtureServer;
const png = await sharp({create:{width:600,height:400,channels:3,background:'#98b5cf'}}).png().toBuffer();
const largePng = process.argv.includes('--faults') ? await sharp(randomBytes(1300*1300*3),{raw:{width:1300,height:1300,channels:3}}).png().toBuffer() : png;
let collectionEnd=true;
let fixtureNote='fixture001';
const scope='https://www.xiaohongshu.com/board/fixture123';
const html= url=>url.includes('/explore/') ? `<!doctype html><meta charset="utf-8"><main id="noteContainer"><h1 id="detail-title">Beijing fixture walk</h1><div id="detail-desc">Authorized synthetic travel note with enough visible text for the real capture pipeline. Walk along the lake and visit the pavilion.</div><figure><img src="https://sns-img.xhscdn.com/${url.includes('fixture004')?'chunked':'fixture1'}.png" width="600" height="400" alt="Pavilion"><figcaption>Lake pavilion</figcaption></figure><figure><img src="https://sns-img.xhscdn.com/fixture2.png" width="600" height="400" alt="Garden"><figcaption>Garden path</figcaption></figure></main>`
  : `<!doctype html><meta charset="utf-8"><h1>Synthetic collection</h1><section class="note-item"><a href="https://www.xiaohongshu.com/explore/${fixtureNote}">Fixture note</a></section>${collectionEnd?'<p class="end-tip">没有更多</p>':'<p>Loading further collection entries</p>'}`;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
try {
  const cert=path.join(root,'fixture-cert.pem'),key=path.join(root,'fixture-key.pem');
  execFileSync('C:/Program Files/Git/usr/bin/openssl.exe',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=fixture.local'],{stdio:'ignore'});
  fixtureServer=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)},(req,res)=>{
    const host=String(req.headers.host||'').split(':')[0];
    if(req.url.includes('loadstall001'))return;
    if(req.url.includes('bodystall001')){res.writeHead(200,{'content-type':'application/json'});res.write('{');return;}
    if(host==='www.xiaohongshu.com'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(html(req.url));}
    else if(host==='sns-img.xhscdn.com'){res.writeHead(200,{'content-type':'image/png'});res.end(req.url.includes('chunked')?largePng:png);}
    else {res.writeHead(403);res.end('fixture network denied');}
  });
  await new Promise(r=>fixtureServer.listen(0,'127.0.0.1',r));
  const fixturePort=fixtureServer.address().port;
  result.networkBoundary=`All browser DNS maps to 127.0.0.1:${fixturePort}; only fixture hosts served; no proxy; TLS test certificate ignored only in test browser.`;
  const launchOptions={headless:true,channel:'chromium',
    args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--disable-background-networking','--no-proxy-server','--ignore-certificate-errors',`--host-resolver-rules=MAP * 127.0.0.1:${fixturePort}, EXCLUDE 127.0.0.1`]};
  context=await chromium.launchPersistentContext(result.profile,launchOptions);
  result.browser=context.browser()?.version();
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname.includes('loadstall001')||url.pathname.includes('bodystall001'))return route.continue();
    if(url.protocol==='chrome-extension:')return route.continue();
    if(url.hostname==='127.0.0.1')return route.continue();
    if(url.hostname==='www.xiaohongshu.com')return route.fulfill({contentType:'text/html',body:html(url.href)});
    if(url.hostname==='sns-img.xhscdn.com')return route.fulfill({contentType:'image/png',body:url.pathname.includes('chunked')?largePng:png});
    result.blockedNetwork.push(url.origin);return route.abort();
  });
  let sw=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:20_000});
  const id=new URL(sw.url()).host;result.extensionId=id;
  const config=loadConfig({HOST:'127.0.0.1',PORT:'0',CMS_DATA_ROOT:root,CMS_PROCESS_ROLE:'api',
    CAPTURE_TOKEN:'isolated-fixture-token',CAPTURE_ALLOWED_ORIGINS:`chrome-extension://${id}`,MAINTENANCE_ENABLED:'false',LOG_LEVEL:'error'});
  openDatabase(config.databasePath).close();
  app=createApplication(config);await app.start();
  const endpoint=`http://127.0.0.1:${app.server.address().port}`;result.cms={endpoint,database:config.databasePath,role:config.processRole};
  app.server.on('request',(req,res)=>res.on('finish',()=>result.apiEvents.push({at:Date.now(),method:req.method,path:req.url,status:res.statusCode})));
  await sw.evaluate(async endpoint=>{
    await chrome.storage.local.set({endpoint,token:'isolated-fixture-token',favoritesSyncSettings:{endpoint,token:'isolated-fixture-token',concurrencyMode:'custom',customConcurrency:1,autoSync:'off'}});
    chrome.tabs.onCreated.addListener(tab=>console.log('fixture-tab-created',tab.id));
  },endpoint);
  context.on('page',p=>{result.tabEvents.push({event:'created',at:Date.now()});p.on('close',()=>result.tabEvents.push({event:'closed',at:Date.now()}));});
  const state=()=>sw.evaluate(async()=> (await chrome.storage.local.get('favoritesSyncState')).favoritesSyncState);
  let control=await context.newPage();await control.goto(`chrome-extension://${id}/popup.html`);
  const command=message=>control.evaluate(message=>chrome.runtime.sendMessage(message),message);
  const waitState=async predicate=>{let s;for(let i=0;i<180;i++){s=await state();if(predicate(s))return s;await delay(500);}throw Error(`state timeout: ${JSON.stringify(s)}`);};
  let collection=await context.newPage();await collection.goto(scope);await collection.bringToFront();
  assert.equal((await command({type:'START_SYNC',mode:'full'})).ok,true);
  await control.close();
  let s=await waitState(s=>s?.status?.startsWith('completed')||s?.status?.startsWith('paused'));
  result.firstCapture=s;
  assert.equal(s.status,'completed');assert.equal(s.stats.captured+s.stats.duplicate,1);
  control=await context.newPage();await control.goto(`chrome-extension://${id}/popup.html`);
  assert.equal((await state()).sessionId,s.sessionId);
  result.checks.push({id:'XP-07',status:'PASS',detail:'Closed popup while capture active; capture completed; reopened popup kept same session.'});
  const sources=app.repository.db.prepare('SELECT id,raw_text,capture_version FROM sources').all();
  const assets=app.repository.db.prepare('SELECT * FROM source_assets').all();
  result.durableSources=sources.map(row=>({id:row.id,textChars:row.raw_text?.length,captureVersion:row.capture_version}));
  result.durableAssets=assets.map(row=>({id:row.id,kind:row.kind,metadata:row.metadata_json}));
  assert.equal(sources.length,1);assert.ok(assets.length>=2);
  result.checks.push({id:'XP-18',status:'PASS',captured:s.stats.captured,assets:assets.length});
  // Start another scope window without an end marker and close during discovery.
  collectionEnd=false;await collection.reload();await collection.bringToFront();
  assert.equal((await command({type:'START_SYNC',mode:'full'})).ok,true);
  await collection.close();
  if(baseline){
    let tabs=[];
    for(let i=0;i<50;i++){await delay(250);tabs=await sw.evaluate(()=>chrome.tabs.query({}));if(tabs.some(t=>(t.url||t.pendingUrl)===scope))break;}
    s=await state();
    result.baselineClose={status:s.status,discoveryTabId:s.discoveryTabId,reopened:tabs.filter(t=>(t.url||t.pendingUrl)===scope).length};
    assert.equal(s.status,'running');assert.ok(result.baselineClose.reopened>=1);
    app.server.prependListener('request',(req,res)=>{if(req.url==='/api/favorites-sync-runs')res.end=()=>res;});
    const started=Date.now();const paused=await command({type:'PAUSE_SYNC'});
    result.baselinePause={elapsedMs:Date.now()-started,ok:paused.ok};
    assert.ok(result.baselinePause.elapsedMs>=40_000);
    result.checks.push({id:'BASELINE',status:'PASS',detail:'Original HEAD reproduced replacement discovery and delayed pause acknowledgement.'});
    throw Object.assign(new Error('baseline evidence complete'),{baselineComplete:true});
  }
  s=await waitState(s=>s?.status==='paused_tab_closed');
  const stoppedAt=Date.now();const pagesAtStop=result.tabEvents.filter(e=>e.event==='created').length;
  result.checks.push({id:'XP-02',status:'PASS',kind:'discovery close',queue:s.queue.length});
  const popup=await context.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.waitForFunction(()=>document.querySelector('#status')?.textContent.includes('暂停'));
  await popup.screenshot({path:path.join(screenshots,'paused-tab-closed.png')});
  assert.match(await popup.locator('#status').innerText(),/暂停/);
  await popup.close();
  const quick=process.argv.includes('--quick');
  if(process.argv.includes('--deadline-extras')){
    await sw.evaluate(async()=>{
      const tab=await chrome.tabs.create({url:'https://www.xiaohongshu.com/explore/loadstall001',active:false});
      const at=Date.now();
      void globalThis.__stcTest.waitForTab(tab.id,30_000).catch(error=>chrome.storage.local.set({loadDeadlineResult:{code:error.code,elapsedMs:Date.now()-at,tabId:tab.id}}));
      void globalThis.__stcTest.apiJson('https://sns-img.xhscdn.com/bodystall001',{method:'GET'},'').catch(error=>chrome.storage.local.set({bodyDeadlineResult:{code:error.code,elapsedMs:Date.now()-at}}));
    });
    await delay(31_000);
    const deadlines=await sw.evaluate(()=>chrome.storage.local.get(['loadDeadlineResult','bodyDeadlineResult']));
    assert.equal(deadlines.loadDeadlineResult.code,'TAB_LOAD_TIMEOUT');assert.ok(deadlines.loadDeadlineResult.elapsedMs>=30_000);
    assert.equal(deadlines.bodyDeadlineResult.code,'RESPONSE_STALLED');assert.ok(deadlines.bodyDeadlineResult.elapsedMs>=15_000);
    await sw.evaluate(id=>chrome.tabs.remove(id),deadlines.loadDeadlineResult.tabId);
    result.checks.push({id:'XP-10',status:'PASS',kind:'real page load 30s and streamed body idle 15s',...deadlines});
  }
  let deadlinePage;
  if(!quick){
    deadlinePage=await context.newPage();await deadlinePage.goto('https://www.xiaohongshu.com/explore/deadline001');
    await sw.evaluate(async()=>{
      const [tab]=await chrome.tabs.query({url:'https://www.xiaohongshu.com/explore/deadline001'});
      const at=Date.now();
      void globalThis.__stcTest.execute(tab.id,()=>new Promise(()=>{})).then(
        ()=>chrome.storage.local.set({deadlineResult:{unexpectedSuccess:true}}),
        error=>chrome.storage.local.set({deadlineResult:{code:error.code,elapsedMs:Date.now()-at}}));
    });
  }
  // Two real minute watchdog cycles, no timing acceleration.
  for(let i=0;i<(quick?0:5);i++){await delay(26_000);process.stdout.write(`watchdog observation ${i+1}/5\n`);}
  s=await state();assert.equal(s.status,'paused_tab_closed');
  assert.equal(result.tabEvents.filter(e=>e.event==='created').length,pagesAtStop+(quick?1:2)+(process.argv.includes('--deadline-extras')?1:0));
  const diagnostics=await sw.evaluate(async()=> (await chrome.storage.local.get('favoritesSyncDiagnostics')).favoritesSyncDiagnostics);
  result.diagnostics=diagnostics;
  if(!quick)assert.ok(diagnostics.filter(e=>e.event==='watchdog'&&Date.parse(e.at)>=stoppedAt).length>=2);
  result.checks.push({id:'XP-01',status:quick?'NOT_RUN':'PASS',observationMs:Date.now()-stoppedAt,watchdogTicks:diagnostics.filter(e=>e.event==='watchdog'&&Date.parse(e.at)>=stoppedAt).length});
  if(!quick){
    await delay(22_000);
    const deadline=await sw.evaluate(async()=> (await chrome.storage.local.get('deadlineResult')).deadlineResult);
    assert.equal(deadline.code,'DOM_TIMEOUT');assert.ok(deadline.elapsedMs>=150_000&&deadline.elapsedMs<160_000);
    result.checks.push({id:'XP-10',status:'PASS',kind:'real executeScript unresolved promise',...deadline});
    await deadlinePage.close();
  }
  // CDP terminates only the test extension service worker; wake through popup runtime.
  const cdp=await context.browser().newBrowserCDPSession();
  const targets=await cdp.send('Target.getTargets');
  const worker=targets.targetInfos.find(t=>t.type==='service_worker'&&t.url.includes(id));
  await cdp.send('Target.closeTarget',{targetId:worker.targetId});
  const freshPopup=await context.newPage();await freshPopup.goto(`chrome-extension://${id}/popup.html`);
  await freshPopup.waitForTimeout(1000);sw=context.serviceWorkers().find(w=>w.url().includes(id))||await context.waitForEvent('serviceworker');
  assert.equal((await state()).status,'paused_tab_closed');
  result.checks.push({id:'XP-04',status:'PASS',restart:'CDP closed worker; popup runtime woke extension'});
  // Double Resume single-flight; pause uses actual popup button, CMS reporting offline.
  collectionEnd=false;
  const resumed=await Promise.all([command({type:'RESUME_SYNC'}),command({type:'RESUME_SYNC'})]);
  result.resumed=resumed;
  assert.ok(resumed.every(r=>r.ok),JSON.stringify(resumed));
  const tabs=await sw.evaluate(()=>chrome.tabs.query({}));
  assert.equal(tabs.filter(t=>t.url===scope||t.pendingUrl===scope).length,1);
  result.checks.push({id:'XP-05',status:'PASS'});
  const stableSession=await state();
  const unrelated=await context.newPage();await unrelated.goto('about:blank');await unrelated.close();
  assert.equal((await state()).status,'running');
  result.checks.push({id:'XP-02',status:'PASS',kind:'unrelated page close leaves running state'});
  if(!quick){
    for(let i=0;i<6&&(await state()).status==='running';i++){await delay(26_000);process.stdout.write(`no-progress observation ${i+1}/6\n`);}
    s=await state();result.stallState=s;
    assert.equal(s.status,'paused_error');assert.equal(s.lastError.code,'DISCOVERY_STALLED');
    result.checks.push({id:'XP-12',status:'PASS',kind:'actual repeated DOM and real production no-progress budget',budgetMs:s.config.watchdogStallMs});
  }
  await command({type:'CANCEL_SYNC'});
  fixtureNote='fixture002';collectionEnd=true;
  collection=await context.newPage();await collection.goto(scope);await collection.bringToFront();
  assert.equal((await command({type:'START_SYNC',mode:'full'})).ok,true);
  s=await waitState(s=>s?.workerTabs?.some(Boolean));
  const workTabId=s.workerTabs.find(Boolean);
  await sw.evaluate(id=>chrome.tabs.remove(id),workTabId);
  s=await waitState(s=>s?.status==='paused_tab_closed');assert.ok(s.queue.length>0);
  result.checks.push({id:'XP-02',status:'PASS',kind:'actual worker tab removal',queue:s.queue.length});
  await command({type:'RESUME_SYNC'});
  s=await waitState(s=>s?.status?.startsWith('completed')||s?.status?.startsWith('paused'));
  assert.equal(s.status,'completed');
  result.checks.push({id:'XP-05',status:'PASS',kind:'resume after missing worker slot',captured:s.stats.captured});
  fixtureNote='fixture003';collectionEnd=false;
  const captureWindow=await sw.evaluate(url=>chrome.windows.create({url,focused:true}),scope);
  await delay(500);
  assert.equal((await command({type:'START_SYNC',mode:'full'})).ok,true);
  await sw.evaluate(id=>chrome.windows.remove(id),captureWindow.id);
  s=await waitState(s=>s?.status==='paused_tab_closed');
  result.checks.push({id:'XP-02',status:'PASS',kind:'actual whole window removal'});
  if(process.argv.includes('--faults')){
    await command({type:'CANCEL_SYNC'});fixtureNote='fixture004';collectionEnd=true;
    let heldChunk=null;
    const holdChunk=(req,res)=>{
      if(!heldChunk&&req.url.includes('/chunks/1')){
        res.end=()=>{heldChunk={path:req.url,response:res};return res;};
      }
    };
    app.server.prependListener('request',holdChunk);
    collection=await context.newPage();await collection.goto(scope);await collection.bringToFront();
    await command({type:'START_SYNC',mode:'full'});
    for(let i=0;i<200&&!heldChunk;i++)await delay(100);
    assert.ok(heldChunk,'multi-chunk upload reached second durable chunk');
    const heldPath=heldChunk.path;
    await command({type:'PAUSE_SYNC'});heldChunk.response.destroy();app.server.removeListener('request',holdChunk);
    const journalBefore=await sw.evaluate(async()=>{
      return new Promise((resolve,reject)=>{const req=indexedDB.open('stc-capture-journal-v1');req.onsuccess=()=>{const db=req.result;const read=db.transaction('records').objectStore('records').getAll();read.onsuccess=()=>{resolve(read.result.map(record=>({hasBytes:Boolean(record.bytes),uploadId:record.upload?.uploadId,hasCapture:Boolean(record.capture)})));db.close();};read.onerror=()=>reject(read.error);};req.onerror=()=>reject(req.error);});
    });
    const restartTargets=await cdp.send('Target.getTargets');
    await cdp.send('Target.closeTarget',{targetId:restartTargets.targetInfos.find(t=>t.type==='service_worker'&&t.url.includes(id)).targetId});
    await control.reload();await delay(300);sw=context.serviceWorkers().find(w=>w.url().includes(id))||await context.waitForEvent('serviceworker');
    assert.equal((await state()).status,'paused_by_user');
    const resumeAt=Date.now();await command({type:'RESUME_SYNC'});
    s=await waitState(s=>s?.status?.startsWith('completed')||s?.status?.startsWith('paused'));
    assert.equal(s.status,'completed');
    assert.equal(result.apiEvents.filter(e=>e.at>=resumeAt&&e.method==='PUT'&&e.path===heldPath).length,0);
    result.checks.push({id:'XP-15',status:'PASS',bytes:largePng.length,journalStores:journalBefore,heldPath,resumeAt,detail:'Second chunk durably received but ack withheld; pause + real worker restart + resume; second chunk not retransmitted.'});
    fixtureNote='fixture005';let lostReceipt=false;
    const loseReceipt=(req,res)=>{
      if(req.url!=='/api/captures')return;
      const end=res.end.bind(res);res.end=(body,...args)=>{
        let receipt;try{receipt=JSON.parse(String(body));}catch{}
        if(!lostReceipt&&receipt?.mediaDurabilityComplete&&receipt?.completenessStatus==='complete'){
          lostReceipt=true;res.destroy();return res;
        }
        return end(body,...args);
      };
    };
    app.server.prependListener('request',loseReceipt);
    collection=await context.newPage();await collection.goto(scope);await collection.bringToFront();
    await command({type:'START_SYNC',mode:'full'});
    s=await waitState(s=>s?.status?.startsWith('completed')||s?.status?.startsWith('paused'));
    app.server.removeListener('request',loseReceipt);
    assert.ok(lostReceipt);assert.equal(s.status,'completed');assert.equal(s.stats.duplicate,1);
    const sourceCount=app.repository.db.prepare("SELECT count(*) n FROM sources WHERE external_id='fixture005'").get().n;
    assert.equal(sourceCount,1);
    result.checks.push({id:'XP-14',status:'PASS',sourceCount,attempts:s.queue[0]?.attempts,detail:'Final capture persisted, socket destroyed before receipt; receiver idempotency returned duplicate without new source (Chromium retried transport inside attempt 1).'});
  }
  // Read-only/401/Origin classifications use real receiver and real message path.
  await command({type:'CANCEL_SYNC'});
  const beforeBadAuth=result.tabEvents.filter(e=>e.event==='created').length;
  await sw.evaluate(()=>chrome.storage.local.set({favoritesSyncSettings:{endpoint:'',token:''}}));
  await command({type:'SAVE_SETTINGS',settings:{endpoint,token:'wrong-fixture-token',autoSync:'off'}});
  const denied=await command({type:'START_SYNC',mode:'full'});
  assert.equal(denied.error.code,'CAPTURE_UNAUTHORIZED');
  assert.equal(result.tabEvents.filter(e=>e.event==='created').length,beforeBadAuth);
  await command({type:'SAVE_SETTINGS',settings:{endpoint,token:'isolated-fixture-token',autoSync:'off'}});
  result.checks.push({id:'XP-09',status:'PASS',kind:'real CMS 401 before navigation',code:denied.error.code});
  const originDenied=await fetch(endpoint+'/api/captures/identity-check',{method:'POST',headers:{origin:'chrome-extension://unapprovedfixture','content-type':'application/json',authorization:'Bearer isolated-fixture-token'},body:'{"items":[]}'});
  assert.equal(originDenied.status,403);
  result.checks.push({id:'XP-09',status:'PASS',kind:'unapproved Origin',httpStatus:403});
  collectionEnd=false;
  collection=await context.newPage();await collection.goto(scope);await collection.bringToFront();
  await command({type:'START_SYNC',mode:'full'});
  s=await state();
  await sw.evaluate(({id,url})=>chrome.tabs.update(id,{url}),{id:s.discoveryTabId,url:scope+'#spa'});
  await delay(300);assert.equal((await state()).status,'running');
  await sw.evaluate(id=>chrome.tabs.update(id,{url:'https://www.xiaohongshu.com/login'}),s.discoveryTabId);
  await waitState(s=>s?.status==='paused_login_required');
  result.checks.push({id:'XP-13',status:'PASS',kind:'same-scope SPA hash preserves running; login navigation pauses'});
  const previous=await state();
  await sw.evaluate(async()=>{
    const s=(await chrome.storage.local.get('favoritesSyncState')).favoritesSyncState;
    s.status='running';s.discoveryTabId=999999999;delete s.browserIdentity;
    await chrome.storage.local.set({favoritesSyncState:s});await globalThis.__stcTest.restoreAfterRestart();
  });
  s=await state();assert.equal(s.status,'paused_tab_closed');assert.equal(s.queue.length,previous.queue.length);
  result.checks.push({id:'XP-16',status:'PASS',kind:'legacy running persisted in real storage; invalid tab/browser identity pauses preserving queue'});
  assert.equal((await command({type:'RESUME_SYNC'})).ok,true);
  await app.stop();app=null;
  await freshPopup.reload();await freshPopup.locator('#pause').waitFor({state:'visible'});
  const pauseAt=Date.now();await freshPopup.locator('#pause').click();
  await waitState(s=>s?.status==='paused_by_user');
  const pauseMs=Date.now()-pauseAt;assert.ok(pauseMs<=1000,`pause ${pauseMs}ms`);
  result.checks.push({id:'XP-08',status:'PASS',pauseMs});
  await freshPopup.screenshot({path:path.join(screenshots,'offline-pause.png')});
  await context.close();
  context=await chromium.launchPersistentContext(result.profile,launchOptions);
  const restartedPopup=await context.newPage();await restartedPopup.goto(`chrome-extension://${id}/popup.html`);
  sw=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:20_000});
  await restartedPopup.waitForFunction(()=>document.querySelector('#status')?.textContent.includes('暂停'));
  assert.equal((await state()).status,'paused_by_user');
  const restartTabs=await sw.evaluate(()=>chrome.tabs.query({}));
  assert.equal(restartTabs.filter(t=>(t.url||'').startsWith('https://www.xiaohongshu.com/')).length,0);
  result.checks.push({id:'XP-04',status:'PASS',restart:'Full browser process close/relaunch using same test profile; paused state retained; zero capture tabs.'});
  result.status='PASS';
} catch(error){if(error.baselineComplete)result.status='PASS';else {result.status='FAIL';result.error={message:error.message,stack:error.stack};process.exitCode=1;}}
finally {
  if(context)await context.close();if(app)await app.stop();
  if(fixtureServer)await new Promise(r=>fixtureServer.close(r));
  result.finishedAt=new Date().toISOString();
  result.loadedHashes=Object.fromEntries(fs.readdirSync(extension).map(f=>[f,createHash('sha256').update(fs.readFileSync(path.join(extension,f))).digest('hex')]));
  const filename=path.join(evidence,baseline?'browser-baseline.json':'browser.json');
  if(fs.existsSync(filename))fs.copyFileSync(filename,path.join(evidence,`browser-attempt-${Date.now()}.json`));
  fs.writeFileSync(filename,JSON.stringify(result,null,2));
  console.log(JSON.stringify({status:result.status,root,checks:result.checks,error:result.error},null,2));
}
