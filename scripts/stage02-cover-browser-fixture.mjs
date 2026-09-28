import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openDatabase} from '../src/db.mjs';
import {loadConfig} from '../src/config.mjs';
import {createApplication} from '../src/server.mjs';
import {seedCoverFixture} from '../test-support/cover-fixture.mjs';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cms-c-cover-browser-'));
const databasePath=path.join(directory,'test.sqlite');openDatabase(databasePath).close();
const mediaDir=path.join(directory,'media');
const app=createApplication(loadConfig({HOST:'127.0.0.1',PORT:'0',DATABASE_PATH:databasePath,CMS_DATA_ROOT:directory,
  GENERATED_MEDIA_DIR:mediaDir,SOURCE_UPLOADS_DIR:path.join(directory,'sources'),CAPTURE_UPLOADS_DIR:path.join(directory,'capture'),
  CAPTURE_MEDIA_UPLOADS_DIR:path.join(directory,'capture-media'),CMS_PROCESS_ROLE:'api',MAINTENANCE_ENABLED:'false',LOG_LEVEL:'error',
  ADMIN_TOKEN:'cover-local-fixture-token',ADMIN_USERNAME:'cover-test',ADMIN_PASSWORD:'cover-local-test-only',SESSION_SECRET:'cover-local-isolated-secret'}));
await seedCoverFixture(app.repository,mediaDir);
await app.start();
const stopFile=path.join(directory,'STOP');let stopped=false;
const stop=async()=>{if(stopped)return;stopped=true;clearInterval(poll);clearTimeout(deadline);await app.stop();};
const poll=setInterval(()=>{if(fs.existsSync(stopFile))void stop();},500);
const deadline=setTimeout(()=>void stop(),15*60*1000);
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
console.log(JSON.stringify({directory,databasePath,stopFile,url:`http://127.0.0.1:${app.server.address().port}`,pid:process.pid}));
