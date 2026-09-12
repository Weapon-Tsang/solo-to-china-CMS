import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openMediaResponse } from '../src/safe-media-http.mjs';
import { recoverRemoteOriginal } from '../src/source-media-store.mjs';
import { safeMediaPath } from '../src/media-storage.mjs';
import { png } from '../test-support/media-fixtures.mjs';

function requestFixture({remote='8.8.8.8',redirect,pins,visits}) {
  return (url,options,receive)=>{
    visits.push(String(url));
    options.lookup(url.hostname,{all:true},(_error,addresses)=>pins.push(addresses));
    assert.equal(options.agent,false);assert.equal(options.headers.authorization,undefined);
    const request=new EventEmitter();request.setTimeout=()=>{};
    let destroyed=false;
    request.destroy=error=>{destroyed=true;queueMicrotask(()=>request.emit('error',error));};
    request.end=()=>queueMicrotask(()=>{
      const socket=new EventEmitter();socket.remoteAddress=remote;request.emit('socket',socket);socket.emit('secureConnect');
      if(destroyed)return;
      const response=Readable.from([png]);response.statusCode=redirect?302:200;response.headers=redirect?{location:redirect}:{'content-type':'image/png'};receive(response);
    });
    return request;
  };
}
test('connection lookup is pinned; changed socket addresses and private redirect hops are rejected before body use',async()=>{
  let lookups=0;const pins=[],visits=[];
  const lookup=async()=>{lookups++;return [{address:'8.8.8.8',family:4}];};
  const requestImpl=requestFixture({pins,visits});
  const response=await openMediaResponse('https://media.example/image',{lookup,requestImpl});
  assert.equal(response.ok,true);response.cancel();assert.equal(lookups,1);assert.equal(pins[0][0].address,'8.8.8.8');
  await assert.rejects(openMediaResponse('https://media.example/image',{lookup,requestImpl:requestFixture({remote:'127.0.0.1',pins,visits})}),{code:'REMOTE_MEDIA_ADDRESS_CHANGED'});
  const before=visits.length;
  await assert.rejects(openMediaResponse('https://media.example/image',{lookup,requestImpl:requestFixture({redirect:'https://169.254.169.254/latest',pins,visits})}),{code:'REMOTE_MEDIA_ADDRESS_FORBIDDEN'});
  assert.equal(visits.length,before+1);
});
test('a pending DNS lookup obeys cancellation without opening a connection',async()=>{
  const controller=new AbortController();let connected=false;
  const promise=openMediaResponse('https://media.example/image',{signal:controller.signal,lookup:()=>new Promise(()=>{}),requestImpl:()=>{connected=true;}});
  controller.abort(new Error('cancel DNS'));await assert.rejects(promise,/cancel DNS/);assert.equal(connected,false);
});
test('remote originals stream through validation and remove incomplete temporary files on failure',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'stc-network-stream-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const response=bytes=>({ok:true,status:200,headers:{get:key=>key==='content-type'?'image/png':null},body:Readable.from([...bytes].map(byte=>Buffer.from([byte])))});
  const stored=await recoverRemoteOriginal({kind:'image',url:'https://media.example/image'},directory,{openResponse:async()=>response(png)});
  assert.deepEqual(fs.readFileSync(stored.localPath),png);
  await assert.rejects(recoverRemoteOriginal({kind:'image',url:'https://media.example/image'},directory,{maxBytes:20,openResponse:async()=>response(png)}),{code:'REMOTE_MEDIA_TOO_LARGE'});
  assert.deepEqual(fs.readdirSync(path.join(directory,'.media-recovery')),[]);
  const outside=path.join(directory,'outside'),root=path.join(directory,'root');fs.mkdirSync(outside);fs.mkdirSync(root);
  fs.symlinkSync(outside,path.join(root,'link'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>safeMediaPath(root,'link/asset.png'),{code:'INVALID_MEDIA_PATH'});
});
