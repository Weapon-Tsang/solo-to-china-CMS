import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openDatabase} from '../src/db.mjs';
import {loadConfig} from '../src/config.mjs';
import {createApplication} from '../src/server.mjs';
import {markLocalDataRoot} from '../src/local-runtime.mjs';
import {normalizeXiaohongshuCapture} from '../src/adapters/xiaohongshu.mjs';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cms-family-browser-'));
const config=loadConfig({CMS_RUN_MODE:'development',CMS_DATA_ROOT:directory,DATABASE_PATH:path.join(directory,'test.sqlite'),
  HOST:'127.0.0.1',PORT:'0',CMS_PROCESS_ROLE:'api',MAINTENANCE_ENABLED:'false',LOG_LEVEL:'error',
  GENERATED_MEDIA_DIR:path.join(directory,'media'),SOURCE_UPLOADS_DIR:path.join(directory,'sources'),
  ADMIN_USERNAME:'family',ADMIN_PASSWORD:'family-local-only',SESSION_SECRET:'isolated-test-only',
  PUBLIC_CONTENT_SITE_URL:'https://example.invalid'});
markLocalDataRoot(config,'development');openDatabase(config.databasePath).close();
const app=createApplication(config),repository=app.repository;
for(const [n,predicate] of [[1,'route'],[2,'payment'],[3,'schedule']]) {
  const value=`Verified ${predicate} information`;
  const saved=repository.saveCapture(normalizeXiaohongshuCapture({url:`https://www.xiaohongshu.com/explore/68abcdef00000000000000b${n}`,
    title:`Chengdu Metro ${predicate}`,text:value,images:[]}));
  repository.saveExtraction(saved.id,{source:{language:'en',summary:value,destination_name:'Chengdu',destination_slug:'chengdu',
    traveler_fit:['solo'],practical_tips:[],warnings:[],confidence:.9},claims:[{key:`chengdu.metro.family.${predicate}`,
    subject:'Chengdu Metro',predicate,value,qualifiers:[],source_quote:value,confidence:.9}],
    blueprint:{format:'guide',hook:'practical',angle:'independent travel',sections:[],strengths:[],gaps:[]}},'test','test');
  repository.saveExperienceExtraction(saved.id,{blocks:[]},'test');
}
repository.rebuildKnowledge('chengdu');
repository.db.prepare("UPDATE knowledge_facts SET validity_state='historical' WHERE normalized_key='chengdu.metro.family.schedule'").run();
repository.rebuildTopicClusters('chengdu');repository.rebuildKnowledgeOpportunities('chengdu');
await app.start();
let stopped=false;const stopFile=path.join(directory,'STOP');
async function stop(){if(stopped)return;stopped=true;clearInterval(poll);clearTimeout(deadline);await app.stop();}
const poll=setInterval(()=>{if(fs.existsSync(stopFile))void stop();},500);
const deadline=setTimeout(()=>void stop(),30*60_000);
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
console.log(JSON.stringify({directory,stopFile,url:`http://127.0.0.1:${app.server.address().port}`,pid:process.pid}));
