import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { loadConfig } from '../src/config.mjs';
import { createApplication } from '../src/server.mjs';
import { normalizeXiaohongshuCapture } from '../src/adapters/xiaohongshu.mjs';

test('T02-38/43: authenticated HTTP context readback is bounded, versioned, read-only and escaped as JSON',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cms-context-api-'));
  const databasePath=path.join(directory,'api.sqlite');openDatabase(databasePath).close();
  const app=createApplication(loadConfig({HOST:'127.0.0.1',PORT:'0',DATABASE_PATH:databasePath,
    CMS_PROCESS_ROLE:'api',ADMIN_TOKEN:'fixture-context-admin',MAINTENANCE_ENABLED:'false',LOG_LEVEL:'error'}));
  t.after(async()=>{
    await app.stop();
    const target=fs.realpathSync(directory);
    assert.equal(path.dirname(target),fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('cms-context-api-'));
    fs.rmSync(target,{recursive:true,force:true});
  });
  const raw='图1：湖广会馆庭院。\n'+'<script>untrusted evidence</script> '.repeat(600);
  const source=app.repository.saveCapture(normalizeXiaohongshuCapture({url:'https://www.xiaohongshu.com/explore/context-http',title:'Context',text:raw,
    images:[{url:'https://sns-img.xhscdn.com/context-http.jpg',captionText:'独立图注'}]}));
  const id=app.repository.getSource(source.id).assets[0].id;
  const db=app.repository.db;
  const before={jobs:db.prepare('SELECT COUNT(*) n FROM jobs').get().n,calls:db.prepare('SELECT COUNT(*) n FROM model_call_metrics').get().n};
  await app.start();
  const endpoint=`http://127.0.0.1:${app.server.address().port}/api/source-assets/${id}/context`;
  assert.equal((await fetch(endpoint)).status,401);
  const options={headers:{authorization:'Bearer fixture-context-admin'}};
  const diagnosticsEndpoint=endpoint.replace(/context$/,'media-diagnostics');
  assert.equal((await fetch(diagnosticsEndpoint)).status,401);
  const missingResponse=await fetch(diagnosticsEndpoint,options);
  assert.equal(missingResponse.status,200);
  const missing=await missingResponse.json();
  assert.ok(missing.reason_counts.ORIGINAL_MISSING);
  const invalid=path.join(directory,'invalid.jpg');fs.writeFileSync(invalid,'not image bytes');
  db.prepare('UPDATE source_assets SET local_path=?,mime_type=? WHERE id=?').run(invalid,'image/jpeg',id);
  const bad=await (await fetch(diagnosticsEndpoint,options)).json();
  assert.ok(bad.reason_counts.BYTES_INVALID);
  db.prepare("UPDATE source_assets SET mime_type='application/pdf',provenance_json=? WHERE id=?")
    .run(JSON.stringify({pdfPages:[2,4]}),id);
  const pdf=await (await fetch(diagnosticsEndpoint,options)).json();
  assert.equal(pdf.document_capability.status,'unsupported_independent_extraction');
  assert.deepEqual(pdf.document_capability.locator.pdfPages,[2,4]);
  assert.equal(pdf.document_capability.fallback.implemented,true);
  assert.equal(pdf.document_capability.fallback.article_adoption_implemented,false);
  db.prepare("UPDATE source_assets SET mime_type='image/jpeg',local_path='' WHERE id=?").run(id);
  const response=await fetch(endpoint,options);assert.equal(response.status,200);
  assert.match(response.headers.get('content-type'),/application\/json/);
  const packet=await response.json();assert.equal(packet.status,'context_pending');
  const query=new URLSearchParams({field:'source_text',contextHash:packet.assets[0].context_hash,start:'12000',maxChars:'512'});
  const page=await (await fetch(`${endpoint}?${query}`,options)).json();
  assert.equal(page.text,raw.slice(12000,12512));assert.equal(page.next_offset,12512);
  query.set('maxChars','12001');assert.equal((await fetch(`${endpoint}?${query}`,options)).status,400);
  query.set('maxChars','512');db.prepare('UPDATE sources SET raw_text=? WHERE id=?').run('Changed',source.id);
  const stale=await fetch(`${endpoint}?${query}`,options);assert.equal(stale.status,409);
  assert.equal((await stale.json()).code,'CONTEXT_STALE');
  const repairEndpoint=endpoint.replace(/context$/,'binding-repair');
  assert.equal((await fetch(repairEndpoint)).status,401);
  const preview=await (await fetch(repairEndpoint,options)).json();
  const applyOptions={method:'POST',headers:{...options.headers,'content-type':'application/json'},
    body:JSON.stringify({apply:true,expectedHash:preview.preview_hash})};
  assert.equal((await fetch(repairEndpoint,{...applyOptions,headers:{'content-type':'application/json'}})).status,401);
  assert.equal((await fetch(repairEndpoint,{...applyOptions,headers:{...applyOptions.headers,origin:'https://untrusted.invalid'}})).status,403);
  assert.equal((await fetch(repairEndpoint,{...applyOptions,body:'{}'})).status,400);
  const applied=await fetch(repairEndpoint,applyOptions);assert.equal(applied.status,200);
  assert.equal((await applied.json()).applied,true);
  db.prepare("UPDATE source_assets SET caption_text='Changed caption' WHERE id=?").run(id);
  assert.equal((await fetch(repairEndpoint,applyOptions)).status,409);
  assert.deepEqual({jobs:db.prepare('SELECT COUNT(*) n FROM jobs').get().n,calls:db.prepare('SELECT COUNT(*) n FROM model_call_metrics').get().n},before);
});
