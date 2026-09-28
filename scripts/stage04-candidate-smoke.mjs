// Local synthetic candidate only. Parent must provide a clean allowlisted environment.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
const [release,data,evidence]=process.argv.slice(2).map(p=>path.resolve(p));
if(fs.existsSync(data))throw new Error('Synthetic data root must be new');
let blocked=0;
const deny=()=>{blocked++;throw new Error('Business network disabled in candidate smoke');};
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
  const opts=Array.isArray(args[0])?args[0][0]:args[0];
  const host=typeof opts==='object'?opts.host:typeof args[1]==='string'?args[1]:'localhost';
  if(!['127.0.0.1','localhost','::1'].includes(host))return deny();
  return connect.apply(this,args);
};
tls.connect=deny;
const originalFetch=globalThis.fetch;
globalThis.fetch=(input,options)=>{
  if(new URL(typeof input==='string'?input:input.url).hostname!=='127.0.0.1')return deny();
  return originalFetch(input,options);
};
syncBuiltinESMExports();
const fromRelease=p=>import(pathToFileURL(path.join(release,p)).href);
const require=createRequire(path.join(release,'package.json'));
const sharpPath=require.resolve('sharp');
assert.ok(sharpPath.startsWith(path.join(release,'node_modules')+path.sep));
const sharp=require('sharp');
const {loadConfig}=await fromRelease('src/config.mjs');
const {markLocalDataRoot,assertLocalRuntime}=await fromRelease('src/local-runtime.mjs');
const {openDatabase,SCHEMA_VERSION}=await fromRelease('src/db.mjs');
const {createApplication}=await fromRelease('src/server.mjs');
const {createBackup,restoreBackup}=await fromRelease('src/backup.mjs');
const {FrontendContractConsumer}=await fromRelease('src/frontend-contract.mjs');
const config=loadConfig({CMS_RUN_MODE:'development',CMS_DATA_ROOT:data,CMS_PROCESS_ROLE:'api',
  HOST:'127.0.0.1',PORT:'0',MAINTENANCE_ENABLED:'false',LOG_LEVEL:'error',
  ADMIN_USERNAME:'candidate-smoke',ADMIN_PASSWORD:'synthetic-local-only',SESSION_SECRET:'synthetic-local-only',
  PUBLIC_CONTENT_SITE_URL:'https://example.invalid'});
markLocalDataRoot(config,'development');openDatabase(config.databasePath).close();
let app;let result;
try{
  app=createApplication(config);
  const contractRoot=path.join(evidence,'fixed-contract');
  const gate=JSON.parse(fs.readFileSync(path.join(release,'config/release-gate.json'))).frontend;
  const consumer=new FrontendContractConsumer(app.repository,{
    registrySource:path.join(contractRoot,'component-registry.json'),pageSchemaSource:path.join(contractRoot,'page-schema.json'),
    publishPackageSchemaSource:path.join(contractRoot,'cms-publish-package.schema.json'),frontendCommitSha:gate.commitSha,sourceRepository:gate.repository});
  await consumer.sync();assert.equal(consumer.active.artifact_checksum,gate.artifactSha256);
  const bytes=await sharp({create:{width:32,height:24,channels:3,background:'#779988'}}).webp().toBuffer();
  const metadata=await sharp(bytes).metadata();assert.equal(metadata.width,32);
  await app.start();
  const response=await fetch(`http://127.0.0.1:${app.server.address().port}/api/health`);
  const health=await response.json();assert.equal(response.status,200);
  assert.equal(health.version,JSON.parse(fs.readFileSync(path.join(release,'package.json'))).version);
  assert.equal(app.repository.db.prepare('SELECT MAX(version) n FROM schema_migrations').get().n,SCHEMA_VERSION);
  assert.equal(app.repository.db.prepare('SELECT COUNT(*) n FROM jobs').get().n,0);
  result={status:'PASS',release,data,node:process.version,platform:process.platform,arch:process.arch,
    sharpPath,sharp:sharp.versions,media:{format:metadata.format,bytes:bytes.length},health,schema:SCHEMA_VERSION,
    contract:{commit:gate.commitSha,artifactSha256:consumer.active.artifact_checksum},jobs:0,blockedExternalAttempts:blocked};
}finally{await app?.stop();}
const backup=createBackup({databasePath:config.databasePath,backupDir:path.join(data,'backups'),sourceUploadsDir:config.sourceUploadsDir,generatedMediaDir:config.generatedMediaDir});
const restored=restoreBackup(backup.backupPath,`${data}-review`);
assert.throws(()=>assertLocalRuntime(loadConfig({CMS_RUN_MODE:'migration-review',CMS_DATA_ROOT:restored.restoredRoot,CMS_PROCESS_ROLE:'api'})),/read-only/);
const review=spawnSync(process.execPath,[path.join(release,'scripts/inspect-local-data.mjs')],{cwd:release,
  env:{...process.env,CMS_RUN_MODE:'migration-review',CMS_DATA_ROOT:restored.restoredRoot},encoding:'utf8',windowsHide:true});
assert.equal(review.status,0,review.stderr);
result.review=JSON.parse(review.stdout);result.stopped=true;result.blockedExternalAttempts=blocked;
assert.equal(blocked,0);
fs.writeFileSync(path.join(evidence,'candidate-smoke.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({status:'PASS',release,data,schema:SCHEMA_VERSION,stopped:true,externalCalls:0}));
