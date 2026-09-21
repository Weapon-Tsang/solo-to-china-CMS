import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { openDatabase } from '../src/db.mjs';

test('API and worker roles run as two real processes against the same initialized database',async(t)=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'stc-process-roles-'));
  const databasePath=path.join(directory,'db.sqlite');
  const initialized=openDatabase(databasePath);initialized.close();
  const children=[];
  t.after(async()=>{
    for(const child of children) {
      if(child.exitCode===null) child.stdin.write('stop\n');
      await new Promise((resolve)=>child.once('exit',resolve));
    }
    fs.rmSync(directory,{recursive:true,force:true});
  });
  const launch=(role)=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.resolve('test-support/process-role-child.mjs')],{
      env:{...process.env,DATABASE_PATH:databasePath,TEST_PROCESS_ROLE:role,ADMIN_TOKEN:'local-test-token',
        WORDPRESS_SITE_URL:'',DEEPSEEK_API_KEY:'',OPENAI_API_KEY:'',GOOGLE_CLOUD_PROJECT:''},
      stdio:['pipe','pipe','pipe'],windowsHide:true,
    });
    children.push(child);
    let output='';
    child.stdout.on('data',(chunk)=>{
      output+=chunk;
      const match=output.match(new RegExp(`READY ${role} (\\d+)`));
      if(match)resolve({child,port:Number(match[1])});
    });
    child.once('error',reject);
    child.once('exit',(code)=>{if(!output.includes(`READY ${role}`))reject(new Error(`${role} exited ${code}`));});
  });
  const worker=await launch('worker');
  const api=await launch('api');
  assert.ok(worker.child.pid!==api.child.pid);
  assert.ok(api.port>0);
  const db=openDatabase(databasePath,{migrate:false});
  db.prepare(`INSERT INTO sources(id,adapter,canonical_url,title,captured_at,raw_text,raw_html,
    raw_payload_json,content_hash,created_at,updated_at)
    VALUES ('shared-source','manual','https://example.test/shared','Shared','2026-09-21','','','{}','hash','2026-09-21','2026-09-21')`).run();
  db.close();
  const response=await fetch(`http://127.0.0.1:${api.port}/api/sources?limit=20`,{
    headers:{authorization:'Bearer local-test-token'},
  });
  assert.equal(response.status,200);
  const payload=await response.json();
  assert.ok(payload.items.some((item)=>item.id==='shared-source'));
});
