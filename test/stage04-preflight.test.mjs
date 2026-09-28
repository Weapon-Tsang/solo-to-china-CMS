import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {assessPreflight,inventory,secretFindings} from '../scripts/stage04-local-preflight.mjs';
import {inspectCoverContract} from '../src/cover-contract.mjs';

const snapshot=JSON.parse(fs.readFileSync(new URL('../test-support/fixtures/stage03-pinned-contract.json',import.meta.url)));
const valid={prerequisites:true,contract:inspectCoverContract(snapshot),manualEvidence:true,
  routeEvidence:true,backupCoverage:true,sourceSchema:78,targetSchema:83};
test('T04-01/02/14 precheck uses pinned CMS consumer artifact and never grants execution',()=>{
  assert.equal(valid.contract.frontend_commit_sha,'0c4b327287c016aee138f735a8a13eb2baa74542');
  assert.equal(valid.contract.artifact_sha256,'9154dc68540d9922c11109e4cfe00aee871d850e61124fd7edb624ee20b2c422');
  const plan=assessPreflight(valid);
  assert.equal(plan.local_status,'PRECHECK_INPUTS_PRESENT');
  assert.equal(plan.production_actions_enabled,false);assert.equal(plan.production_status,'WAITING_AUTH');
  assert.equal(plan.release_class,'DATA_MIGRATION_RELEASE');
  assert.equal(assessPreflight({...valid,sourceSchema:83}).release_class,'CODE_ONLY_RELEASE');
  assert.equal(assessPreflight({...valid,sourceSchema:null}).release_class,'SOURCE_SCHEMA_VERIFICATION_REQUIRED');
  assert.equal(assessPreflight({...valid,prerequisites:false}).local_status,'BLOCKED');
});
test('T04-15 unsupported fields and tampered fixed contract cannot enable delivery',()=>{
  assert.equal(valid.contract.fields.featuredMediaId,true);
  assert.equal(valid.contract.fields.cardTitle,false);assert.equal(valid.contract.fields.deck,false);
  const corrupt=inspectCoverContract({...snapshot,artifact_checksum:'0'.repeat(64)});
  assert.equal(assessPreflight({...valid,contract:corrupt}).local_status,'BLOCKED');
  assert.deepEqual(assessPreflight(valid).receiver,{status:'PENDING_ENV',cover_refresh:false,body_refresh:false,card_fields:false});
});
test('T04-16/18 missing manual evidence or restore coverage blocks local precheck, paid tests stay off',()=>{
  assert.deepEqual(assessPreflight({...valid,manualEvidence:false}).blockers,['BIND_MUP_EVIDENCE_MISSING']);
  assert.deepEqual(assessPreflight({...valid,backupCoverage:false}).blockers,['MANUAL_ROUTE_RESTORE_EVIDENCE_MISSING']);
  assert.equal(assessPreflight(valid).paid_canary,false);
});
test('T04-24/25 old manual acceptance cannot prove routes or authorize rewriting published text',()=>{
  const plan=assessPreflight({...valid,routeEvidence:false});
  assert.deepEqual(plan.blockers,['ROUTE_EVIDENCE_MISSING']);
  assert.equal(plan.route_external_fields,false);assert.equal(plan.automatic_body_rewrite,false);
});
test('artifact manifest binds bytes and rejects escapes; secret scan reports names without secret values',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cms-preflight-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'a.json'),'{}');
  const first=inventory(root,['a.json']);fs.writeFileSync(path.join(root,'a.json'),'{"changed":true}');
  assert.notEqual(inventory(root,['a.json'])[0].sha256,first[0].sha256);
  assert.throws(()=>inventory(root,['../outside']),/escapes/);
  const key=['gh','p_'].join('')+'a'.repeat(36);fs.writeFileSync(path.join(root,'a.json'),JSON.stringify({token:key}));
  const findings=secretFindings(root,inventory(root,['a.json']));
  assert.equal(findings[0].rule,'github_token');assert.equal(JSON.stringify(findings).includes(key),false);
});
