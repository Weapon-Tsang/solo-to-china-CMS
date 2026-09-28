import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase } from '../src/db.mjs';
import { loadConfig } from '../src/config.mjs';
import { createApplication } from '../src/server.mjs';
import { normalizeXiaohongshuCapture } from '../src/adapters/xiaohongshu.mjs';
import { markLocalDataRoot } from '../src/local-runtime.mjs';

// Synthetic, loopback-only API; no Worker, credentials or external requests.
const parent=fs.realpathSync(process.argv[2] || os.tmpdir());
const directory=fs.mkdtempSync(path.join(parent,'cms-phase02-context-browser-'));
markLocalDataRoot(loadConfig({CMS_RUN_MODE:'development',CMS_DATA_ROOT:directory}),'development');
const databasePath=path.join(directory,'fixture.sqlite');openDatabase(databasePath).close();
const app=createApplication(loadConfig({HOST:'127.0.0.1',PORT:'0',DATABASE_PATH:databasePath,
  CMS_PROCESS_ROLE:'api',CMS_RUN_MODE:'development',CMS_DATA_ROOT:directory,
  MAINTENANCE_ENABLED:'false',LOG_LEVEL:'error'}));
const source=app.repository.saveCapture(normalizeXiaohongshuCapture({url:'https://www.xiaohongshu.com/explore/context-browser-fixture',
  title:'Context readback fixture',text:'图1：湖广会馆庭院。\n'+Array.from({length:900},(_,i)=>`Evidence line ${i}: retained source text, not instructions.`).join('\n'),
  images:Array.from({length:13},(_,i)=>({url:`https://sns-img.xhscdn.com/context-fixture-${i}.jpg`,captionText:`Caption for image ${i+1}`}))}));
if (process.argv.includes('--repair')) {
  app.repository.db.prepare('UPDATE sources SET raw_text=? WHERE id=?').run('图1：湖广会馆庭院。\n'+'Retained evidence. '.repeat(900),source.id);
  app.repository.db.prepare(`INSERT INTO entity_aliases(id,destination_slug,alias_normalized,entity_key,canonical_subject,aliases_json,
    resolution_source,confidence,created_at,updated_at,entity_type,granularity)
    VALUES ('repair-hall','chongqing','hall','hall','Huguang Guild Hall','["湖广会馆"]','manual',1,'now','now','attraction','specific_entity')`).run();
  app.repository.db.prepare("UPDATE source_assets SET mime_type='application/pdf' WHERE source_id=? AND position=12").run(source.id);
}
await app.start();
const stopFile=path.join(directory,'STOP');
console.log(JSON.stringify({url:`http://127.0.0.1:${app.server.address().port}`,directory,stopFile,sourceId:source.id}));
let stopped=false;
const stop=async()=>{if(stopped)return;stopped=true;clearInterval(poll);clearTimeout(deadline);await app.stop();};
const poll=setInterval(()=>{if(fs.existsSync(stopFile))void stop();},500);
const deadline=setTimeout(()=>void stop(),15*60*1000);
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
