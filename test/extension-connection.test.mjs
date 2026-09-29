import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as popupState from '../extension/popup-state.js';
import {classifyCaptureApiError, classifyTaskDisposition} from '../extension/sync-core.js';

test('receiver origin denial is distinct from an invalid token and pauses instead of retrying captures',()=>{
  const error=classifyCaptureApiError(403,{error:'Request origin is not allowed.'});
  assert.equal(error.code,'CAPTURE_ORIGIN_DENIED');
  assert.equal(classifyCaptureApiError(401,{error:'Invalid capture token.'}).code,'CAPTURE_UNAUTHORIZED');
  assert.equal(classifyTaskDisposition(error).action,'pause');
});

const event = () => ({ addListener() {}, removeListener() {} });
async function backgroundFixture(t, token = '') {
  const storage = { endpoint: 'https://capture.example.test', token };
  const area = data => ({ get: async defaults => Object.fromEntries(Object.entries(defaults).map(([k,v])=>[k,data[k] ?? v])), set: async values => Object.assign(data,values) });
  const previous = { chrome: globalThis.chrome, fetch: globalThis.fetch };
  let requests = 0, opened = 0;
  globalThis.chrome = {
    runtime: { onInstalled:event(), onStartup:event(), onMessage:event(), getManifest:()=>({version:'2.0.72'}) },
    alarms: { onAlarm:event(), create:async()=>{}, clear:async()=>true },
    storage: {local:area(storage), session:area({favoritesBrowserIdentity:'connection-test'})},
    tabs: {query:async()=>[{id:1,url:'https://www.xiaohongshu.com/board/fixture123'}], onUpdated:event(), onRemoved:event(), create:async()=>{opened++;return {id:2};}},
    permissions: {contains:async()=>true},
  };
  globalThis.fetch = async (url, options) => {
    requests++;
    assert.equal(new URL(url).pathname, '/api/captures/identity-check');
    assert.deepEqual(JSON.parse(options.body), {items:[]});
    return options.headers.authorization === 'Bearer valid-fixture-token'
      ? Response.json({items:[]}) : Response.json({error:'Unauthorized'}, {status:401});
  };
  const background = await import(`../extension/background.js?connection=${crypto.randomUUID()}`);
  await background.restoreAfterRestart();
  t.after(()=>{globalThis.chrome=previous.chrome;globalThis.fetch=previous.fetch;});
  return {background,storage,counts:()=>({requests,opened})};
}

test('new cloud extension without a token fails before network or collection work, and preserves the reason',async t=>{
  const f=await backgroundFixture(t);
  await assert.rejects(f.background.handleMessage({type:'START_SYNC'}),{code:'CAPTURE_TOKEN_MISSING'});
  assert.deepEqual(f.counts(),{requests:0,opened:0});
  const state=await f.background.handleMessage({type:'GET_STATE'});
  assert.equal(state.connectionIssue.code,'CAPTURE_TOKEN_MISSING');
  assert.equal(state.settings.tokenConfigured,false);
  assert.equal(state.session,null);
});

test('wrong token survives polling and popup reopening; replacing it verifies without creating a sync or leaking credentials',async t=>{
  const f=await backgroundFixture(t,'wrong-fixture-token');
  await assert.rejects(f.background.handleMessage({type:'START_SYNC'}),{code:'CAPTURE_UNAUTHORIZED'});
  for(let i=0;i<3;i++) {
    const state=await f.background.handleMessage({type:'GET_STATE'});
    assert.equal(state.connectionIssue.code,'CAPTURE_UNAUTHORIZED');
    assert.ok(!JSON.stringify(state).includes('wrong-fixture-token'));
  }
  await f.background.handleMessage({type:'SAVE_SETTINGS',settings:{token:'  valid-fixture-token  '}});
  assert.equal((await f.background.handleMessage({type:'CHECK_CONNECTION'})).ok,true);
  const state=await f.background.handleMessage({type:'GET_STATE'});
  assert.equal(state.connectionIssue,null);
  assert.equal(state.settings.tokenConfigured,true);
  assert.equal(state.session,null);
  assert.deepEqual(f.counts(),{requests:2,opened:0});
  assert.ok(!JSON.stringify(state).includes('valid-fixture-token'));
  await f.background.handleMessage({type:'SAVE_SETTINGS',settings:{token:''}});
  assert.equal(f.storage.token,'valid-fixture-token','empty password input must preserve the saved token');
});

const settle = () => new Promise(resolve=>setImmediate(resolve));
async function popupFixture(sendMessage) {
  const html=fs.readFileSync(new URL('../extension/popup.html',import.meta.url),'utf8');
  const elements=new Map([...html.matchAll(/id="([^"]+)"/g)].map(([,id])=>[id,{value:'',textContent:'',className:'',hidden:false,open:false,handlers:{},addEventListener(name,fn){this.handlers[name]=fn;}}]));
  let timer;
  const context=vm.createContext({...popupState,URL,Date,
    chrome:{runtime:{sendMessage}},
    document:{hidden:false,activeElement:null,querySelector:s=>elements.get(s.slice(1))||null,querySelectorAll:()=>[...elements.values()]},
    window:{addEventListener(){}},setInterval:fn=>{timer=fn;return 1;},clearInterval(){},
  });
  const source=fs.readFileSync(new URL('../extension/popup.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/,'');
  vm.runInContext(source,context);
  await settle();
  return {elements,async poll(){timer();await settle();},async click(id){await elements.get(id).handlers.click();await settle();}};
}
const state = (tokenConfigured=true) => ({ok:true,session:null,currentScope:{key:'fixture',label:'测试收藏夹'},settings:{endpoint:'https://capture.example.test',tokenConfigured},history:[]});

test('real popup keeps a command failure visible across timed refresh instead of displaying waiting',async()=>{
  const popup=await popupFixture(async message=>message.type==='GET_STATE'?state():{ok:false,error:{code:'CAPTURE_UNAUTHORIZED'}});
  await popup.click('sync');
  for(let i=0;i<3;i++)await popup.poll();
  assert.match(popup.elements.get('status').textContent,/采集令牌无效/);
  assert.equal(popup.elements.get('status').className,'error');
  assert.equal(popup.elements.get('connection-settings').open,true);
});

test('real popup explains a fresh cloud install before clicking sync and restores a persisted auth failure',async()=>{
  const missing=await popupFixture(async()=>state(false));
  assert.match(missing.elements.get('status').textContent,/尚未保存采集令牌/);
  assert.equal(missing.elements.get('connection-settings').open,true);
  const reopened=await popupFixture(async()=>({...state(),connectionIssue:{code:'CAPTURE_UNAUTHORIZED'}}));
  await reopened.poll();
  assert.match(reopened.elements.get('status').textContent,/采集令牌无效/);
});

test('polling during a pending connection check describes the pending operation, then preserves its failure',async()=>{
  let finish;
  const popup=await popupFixture(async message=>message.type==='GET_STATE'?state():await new Promise(resolve=>{finish=resolve;}));
  const command=popup.click('sync');
  await popup.poll();
  assert.match(popup.elements.get('status').textContent,/正在检查 CMS 连接/);
  finish({ok:false,error:{code:'CAPTURE_UNAUTHORIZED'}});
  await command;await popup.poll();
  assert.match(popup.elements.get('status').textContent,/采集令牌无效/);
});

test('saving clears the password input and connection check has its own success message',async()=>{
  const calls=[];
  const popup=await popupFixture(async message=>{calls.push(message.type);return message.type==='GET_STATE'?state():{ok:true};});
  popup.elements.get('token').value='fixture-password';
  await popup.click('save-settings');
  assert.equal(popup.elements.get('token').value,'');
  await popup.click('check-connection');
  await popup.poll();
  assert.match(popup.elements.get('status').textContent,/连接验证通过/);
  assert.ok(calls.includes('CHECK_CONNECTION'));
  assert.ok(!calls.includes('START_SYNC'));
});
