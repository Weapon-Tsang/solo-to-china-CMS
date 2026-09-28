import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {assertFixedContractIdentity} from '../scripts/fixed-contract-identity.mjs';

const gate=JSON.parse(fs.readFileSync('config/release-gate.json')).frontend;
const names=['component-registry.json','page-schema.json','cms-publish-package.schema.json'];
test('CI checkout agrees with fixed commit and real artifact bytes; mutations fail',()=>{
  assert.ok(fs.readFileSync('.github/workflows/release-gate.yml','utf8').includes(`ref: ${gate.commitSha}`));
  const docs=names.map(name=>JSON.parse(fs.readFileSync(`docs/codex-cms-upgrade/evidence/phase-04-fixes/fixed-contract/${name}`)));
  assert.equal(assertFixedContractIdentity(docs,gate.artifactSha256),gate.artifactSha256);
  assert.throws(()=>assertFixedContractIdentity(docs,'0'.repeat(64)),/SHA256 mismatch/);
  for(let i=0;i<docs.length;i++){const changed=structuredClone(docs);changed[i].description='tampered';assert.throws(()=>assertFixedContractIdentity(changed,gate.artifactSha256),/SHA256 mismatch/);}
  const cache=JSON.parse(fs.readFileSync('test-support/fixtures/stage03-pinned-contract.json'));
  assert.equal(cache.artifact_checksum,gate.artifactSha256,'CI already pins the real source of the verified cached bytes');
  assert.notEqual(cache.frontend_commit_sha,gate.commitSha,'historical mislabeled provenance is retained, not silently rewritten');
  assert.deepEqual(docs[2].properties.publication.properties.status.enum,['draft','publish']);
});
