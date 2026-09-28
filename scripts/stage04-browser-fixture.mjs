import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import {openDatabase} from '../src/db.mjs';
import {loadConfig} from '../src/config.mjs';
import {createApplication} from '../src/server.mjs';
import {seedCoverFixture} from '../test-support/cover-fixture.mjs';
import {markLocalDataRoot} from '../src/local-runtime.mjs';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cms-phase04-browser-'));
const database=path.join(directory,'test.sqlite');
const config=loadConfig({CMS_RUN_MODE:'development',CMS_DATA_ROOT:directory,DATABASE_PATH:database,
  HOST:'127.0.0.1',PORT:'0',CMS_PROCESS_ROLE:'api',MAINTENANCE_ENABLED:'false',LOG_LEVEL:'error',
  GENERATED_MEDIA_DIR:path.join(directory,'media'),SOURCE_UPLOADS_DIR:path.join(directory,'sources'),
  CAPTURE_MEDIA_UPLOADS_DIR:path.join(directory,'uploads'),ARTICLE_MEDIA_CHUNK_BYTES:'1048576',
  ADMIN_USERNAME:'stage04',ADMIN_PASSWORD:'stage04-local-only',SESSION_SECRET:'isolated-test-only',
  PUBLIC_CONTENT_SITE_URL:'https://example.invalid'});
markLocalDataRoot(config,'development');openDatabase(database).close();
const app=createApplication(config);
await seedCoverFixture(app.repository,path.join(directory,'media'));
fs.mkdirSync('output/playwright',{recursive:true});
const image='output/playwright/phase04-noise.png';
await sharp(crypto.randomBytes(1200*800*3),{raw:{width:1200,height:800,channels:3}}).png().toFile(image);
await app.start();
const stopFile=path.join(directory,'STOP');let stopped=false;
async function stop(){if(stopped)return;stopped=true;clearInterval(poll);clearTimeout(deadline);await app.stop();}
const poll=setInterval(()=>{if(fs.existsSync(stopFile))void stop();},500);
const deadline=setTimeout(()=>void stop(),15*60_000);
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
console.log(JSON.stringify({directory,stopFile,url:`http://127.0.0.1:${app.server.address().port}`,image,
  image_bytes:fs.statSync(image).size,pid:process.pid}));
