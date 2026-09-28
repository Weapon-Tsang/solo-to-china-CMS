import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {Sha256,hashBlob} from '../frontend/src/lib/file-hash.js';
test('incremental browser SHA256 matches native across boundaries, empty files and uneven chunks',async()=>{
  for(const length of [0,1,55,56,63,64,65,127,128,1024*1024+13]){
    const bytes=randomBytes(length),sha=new Sha256();for(let i=0;i<length;i+=17)sha.update(bytes.subarray(i,i+17));
    const native=createHash('sha256').update(bytes).digest('hex');assert.equal(sha.digest(),native);assert.equal(await hashBlob(new Blob([bytes])),native);
  }
});
