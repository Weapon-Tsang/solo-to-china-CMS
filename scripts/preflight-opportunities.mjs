// Run inside the exact candidate image, with a read-only preflight directory and no network.
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {SCHEMA_VERSION} from '../src/db.mjs';
const directory=process.argv[2];
const manifest=JSON.parse(fs.readFileSync(`${directory}/manifest.json`,'utf8'));
for(const [field,env] of [['image','STC_UPGRADE_IMAGE'],['revision','STC_UPGRADE_REVISION'],['version','STC_UPGRADE_VERSION']])
  assert.equal(manifest[field],process.env[env],`Preflight ${field} identity mismatch`);
assert.match(manifest.inputSnapshotSha256,/^[a-f0-9]{64}$/);
assert.equal(manifest.migration.schema,SCHEMA_VERSION);
assert.equal(manifest.migration.preservedContentFingerprints,true);
const filename=`${directory}/database.sqlite`;
assert.ok(!fs.existsSync(`${filename}-wal`) || fs.statSync(`${filename}-wal`).size===0,'Preflight requires a checkpointed database');
const hash=crypto.createHash('sha256');
// Keep this short-lived synchronous gate out of the async filesystem thread pool.
// A failed child audit must return a bounded exit status, not strand shutdown.
const descriptor=fs.openSync(filename,'r'),buffer=Buffer.alloc(1024*1024);
try {let bytes;while((bytes=fs.readSync(descriptor,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,bytes));}
finally {fs.closeSync(descriptor);}
assert.equal(hash.digest('hex'),manifest.databaseSha256,'Preflight database bytes changed');
const db=new DatabaseSync(filename,{readOnly:true});
assert.equal(db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v,SCHEMA_VERSION);
db.close();
const audit=spawnSync(process.execPath,[fileURLToPath(new URL('./audit-opportunity-qualification.mjs',import.meta.url)),
  filename,'--enforce'],{stdio:'inherit',timeout:180_000,killSignal:'SIGKILL'});
if(audit.error)console.error(`Opportunity preflight failed: ${audit.error.code || audit.error.message}`);
process.exitCode=audit.status ?? 1;
