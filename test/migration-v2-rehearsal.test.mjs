import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { SCHEMA_VERSION } from '../src/db.mjs';

test('schema-73 replay preserves old Job fields while adding pipeline_version', async (t) => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'stc-v2-rehearsal-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const oldSource=fs.readFileSync(new URL('../src/db.mjs',import.meta.url),'utf8')
    .replace(/^  if \(current < (\d+)\).*$/gm,(line,version)=>Number(version)>73?'':line);
  const oldModule=path.join(directory,'db73.mjs');fs.writeFileSync(oldModule,oldSource);
  const {openDatabase:openV73}=await import(pathToFileURL(oldModule).href);
  const baseline=path.join(directory,'baseline.sqlite');
  const db=openV73(baseline);
  db.prepare(`INSERT INTO jobs(id,type,entity_id,status,attempts,max_attempts,available_at,created_at,updated_at)
    VALUES ('historic-job','extract_segment_claims','segment','failed',3,3,'2026-09-01','2026-09-01','2026-09-02')`).run();
  db.close();
  const result=spawnSync(process.execPath,['scripts/rehearse-v2-migration.mjs','--isolated-baseline',
    '--baseline',baseline,'--work-root',directory],{cwd:path.resolve(''),encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout);
  assert.equal(report.from,73);
  assert.equal(report.to,SCHEMA_VERSION);
  assert.equal(report.identity.jobs.count,1);
  assert.equal(report.baselineUnchanged,true);
  assert.deepEqual(fs.readdirSync(directory).filter(name=>name.startsWith('stc-v2-migration-')),[]);
});
