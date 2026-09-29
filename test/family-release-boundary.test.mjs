import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {repositoryFixture} from '../test-support/repository-fixture.mjs';
import {repairIds,assertRepairUnchanged,verifyBoundaryMedia,referenceHash,fileHash} from '../scripts/family-release-boundary.mjs';

test('maintenance refuses changed repair dependencies, rows and approval state',()=>{
  const plan={ids:repairIds,records:repairIds.map(id=>({id,recordFingerprint:'row',dependencyFingerprint:'dependency',before:3,after:2,blocked:false}))};
  assert.doesNotThrow(()=>assertRepairUnchanged(structuredClone(plan),plan));
  for(const patch of [{recordFingerprint:'new approval'},{dependencyFingerprint:'new membership'},{blocked:true},{after:1}]) {
    const changed=structuredClone(plan);Object.assign(changed.records[0],patch);
    assert.throws(()=>assertRepairUnchanged(changed,plan));
  }
});
test('boundary backup rejects media mutation even when names and sizes are unchanged',t=>{
  const {directory,db}=repositoryFixture(t),filename=path.join(directory,'media.txt');
  fs.writeFileSync(filename,'original');
  const manifest={files:[{category:'source_upload',originalPath:filename,archivePath:'files/media.txt',bytes:8,sha256:fileHash(filename)}]};
  const references=referenceHash(db);
  verifyBoundaryMedia(db,manifest,references);
  fs.writeFileSync(filename,'tampered');
  assert.throws(()=>verifyBoundaryMedia(db,manifest,references),/Media bytes changed/);
  assert.throws(()=>verifyBoundaryMedia(db,manifest,'changed-reference'),/Media references changed/);
});
