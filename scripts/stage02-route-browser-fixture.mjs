import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { createApplication } from '../src/server.mjs';
import { loadConfig } from '../src/config.mjs';
import { seedRouteProduction } from '../test-support/route-production-fixture.mjs';
import { publishedRouteFixture } from '../test-support/route-decision-fixture.mjs';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cms-a2-browser-'));
const databasePath=path.join(directory,'test.sqlite');openDatabase(databasePath).close();
const config=loadConfig({HOST:'127.0.0.1',PORT:'0',DATABASE_PATH:databasePath,CMS_DATA_ROOT:directory,
  SOURCE_UPLOADS_DIR:path.join(directory,'sources'),GENERATED_MEDIA_DIR:path.join(directory,'media'),
  CAPTURE_UPLOADS_DIR:path.join(directory,'capture'),CAPTURE_MEDIA_UPLOADS_DIR:path.join(directory,'capture-media'),
  CMS_PROCESS_ROLE:'api',MAINTENANCE_ENABLED:'false',LOG_LEVEL:'error',
  ADMIN_TOKEN:'a2-local-fixture-token',ADMIN_USERNAME:'a2-test',ADMIN_PASSWORD:'a2-local-test-only',
  SESSION_SECRET:'a2-local-isolated-session-secret'});
const app=createApplication(config),seed=process.argv.includes('--decisions')?publishedRouteFixture(app.repository):seedRouteProduction(app.repository);
const research=app.repository.getPlanningPackage(seed.candidateId,{opportunityId:seed.ownerId});
await app.repository.ensureRouteSchematic(research.route_bundle);
await app.start();
const stopFile=path.join(directory,'STOP');
console.log(JSON.stringify({directory,stopFile,url:`http://127.0.0.1:${app.server.address().port}`,candidate:seed.candidateId}));
let stopped=false;
const stop=async()=>{if(stopped)return;stopped=true;clearInterval(poll);clearTimeout(deadline);await app.stop();};
const poll=setInterval(()=>{if(fs.existsSync(stopFile))void stop();},500);
const deadline=setTimeout(()=>void stop(),20*60*1000);
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
