import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { recordVerifiedMedia, trustedMediaRecord } from '../src/media-storage.mjs';

test('Windows receipt replacement conflict accepts only an identical verified winner and removes its temp',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'stc-receipt-race-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const bytes=Buffer.from('verified fixture bytes');const hash=createHash('sha256').update(bytes).digest('hex');
  const reference=`media/${hash.slice(0,2)}/${hash}.png`;
  await fs.mkdir(path.dirname(path.join(root,reference)),{recursive:true});await fs.writeFile(path.join(root,reference),bytes);
  const receipt={sha256:hash,sizeBytes:bytes.length,mimeType:'image/png',kind:'image'};
  await recordVerifiedMedia(root,reference,receipt);
  const rename=fs.rename;
  fs.rename=async()=>{throw Object.assign(new Error('simulated Windows reader lock'),{code:'EPERM'});};
  try {
    const winner=await recordVerifiedMedia(root,reference,receipt);assert.equal(winner.sha256,hash);
    await assert.rejects(recordVerifiedMedia(root,reference,{...receipt,sizeBytes:bytes.length+1}),{code:'EPERM'});
    assert.ok(trustedMediaRecord(root,reference,hash));
    assert.equal((await fs.readdir(path.join(root,'.verified'))).filter(f=>f.endsWith('.tmp')).length,0);
    await fs.appendFile(path.join(root,reference),'changed');
    await assert.rejects(recordVerifiedMedia(root,reference,receipt),{code:'EPERM'});
  } finally {fs.rename=rename;}
});
