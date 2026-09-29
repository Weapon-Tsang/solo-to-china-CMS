import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import {repositoryFixture} from '../test-support/repository-fixture.mjs';
import {SCHEMA_VERSION} from '../src/db.mjs';

const bash=process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'bash';
test('actual upgrade control flow rejects bad preflight before service actions',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'family-release-order-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bin=path.join(root,'bin'),preflight=path.join(root,'preflight');
  fs.mkdirSync(bin);fs.mkdirSync(preflight);
  fs.writeFileSync(path.join(preflight,'manifest.json'),'{}');fs.writeFileSync(path.join(preflight,'database.sqlite'),'fixture');
  fs.writeFileSync(path.join(preflight,'boundary-plan.json'),'{}');
  fs.writeFileSync(path.join(bin,'docker'),'#!/bin/bash\nprintf "preflight\\n" >> "$EVENTS"\nexit "$GATE_EXIT"\n',{mode:0o755});
  // Stop after the first production action; no real service command can execute.
  fs.writeFileSync(path.join(bin,'systemctl'),'#!/bin/bash\nprintf "production-service-action\\n" >> "$EVENTS"\nexit 73\n',{mode:0o755});
  const slash=p=>p.replaceAll('\\','/').replace(/^([A-Za-z]):/,(_,drive)=>'/'+drive.toLowerCase());
  for(const [gateExit,expected] of [['1',['preflight']],['0',['preflight','production-service-action']]]) {
    const events=path.join(root,`events-${gateExit}`);
    const result=spawnSync(bash,['-c','export PATH="$MOCK_BIN:$PATH"; bash "$UPGRADE_SCRIPT"'],{encoding:'utf8',env:{...process.env,
      MOCK_BIN:slash(bin),UPGRADE_SCRIPT:slash(path.resolve('deployment/gce/upgrade-existing.sh')),EVENTS:slash(events),GATE_EXIT:gateExit,
      STC_UPGRADE_PREFLIGHT_DIR:slash(preflight).replace(/^([A-Za-z]):/,(_,drive)=>'/'+drive.toLowerCase()),
      STC_UPGRADE_PREPARED_DIR:slash(root),STC_UPGRADE_FAMILY_REPAIR:'approved-six-ids',
      STC_UPGRADE_IMAGE:'example.invalid/engine@sha256:'+'a'.repeat(64),STC_UPGRADE_REVISION:'b'.repeat(40),STC_UPGRADE_VERSION:'2.0.71'}});
    assert.equal(result.status,gateExit==='1'?1:73,result.stderr);
    assert.deepEqual(fs.readFileSync(events,'utf8').trim().split('\n'),expected);
  }
});

test('real preflight CLI returns success/failure promptly and rejects changed database identity',t=>{
  const {directory,db,repository}=repositoryFixture(t);
  const preflight=path.join(directory,'preflight');fs.mkdirSync(preflight);
  const manifest={image:'example.invalid/engine@sha256:'+'a'.repeat(64),revision:'b'.repeat(40),version:'2.0.71',
    inputSnapshotSha256:'c'.repeat(64),migration:{schema:SCHEMA_VERSION,preservedContentFingerprints:true}};
  const prepare=()=>{
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(path.join(directory,'test.sqlite'),path.join(preflight,'database.sqlite'));
    manifest.databaseSha256=crypto.createHash('sha256').update(fs.readFileSync(path.join(preflight,'database.sqlite'))).digest('hex');
    fs.writeFileSync(path.join(preflight,'manifest.json'),JSON.stringify(manifest));
  };
  const run=()=>spawnSync(process.execPath,['scripts/preflight-opportunities.mjs',preflight],{encoding:'utf8',timeout:15_000,
    env:{...process.env,STC_UPGRADE_IMAGE:manifest.image,STC_UPGRADE_REVISION:manifest.revision,STC_UPGRADE_VERSION:manifest.version}});
  prepare();
  let result=run();assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).enforcement.passed,true);
  db.prepare(`INSERT INTO content_opportunities(id,destination_slug,destination_scopes_json,topic_key,strategy_version,title,content_type,
    readiness_score,readiness_json,coverage_json,status,created_at,updated_at,inbox_state,lifecycle_state)
    VALUES ('bad','city','["city"]','city:bad',?,'Invalid evidence','practical_guide',0,'{}',
    '{"knowledgeEventGenerated":true,"selectedFactKeys":[]}','recommended','now','now','ACTIONABLE','recommended')`).run(repository.strategyVersion);
  prepare();result=run();assert.equal(result.error,undefined);assert.equal(result.status,1,result.stderr);
  assert.ok(JSON.parse(result.stdout).enforcement.hardViolationCount>0);
  manifest.databaseSha256='d'.repeat(64);fs.writeFileSync(path.join(preflight,'manifest.json'),JSON.stringify(manifest));
  result=run();assert.equal(result.status,1,result.stderr);assert.match(result.stderr,/database bytes changed/);
});
