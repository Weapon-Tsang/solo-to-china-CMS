import fs from 'node:fs';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {execFileSync} from 'node:child_process';
import {openDatabase} from '/app/src/db.mjs';
import {previewRepair,applyRepair} from '/app/scripts/repair-opportunity-families.mjs';
const ids=['opportunity_859f07766f1202a7b54f3058','opportunity_9d066affac5209dd820dae5e','opportunity_e76caea56f5914a2d27a8f85','opportunity_716a5d141a6a239055100d06','opportunity_0ad2ce3a8a6125aa07ee8be4','opportunity_c1f5ed8caac9df16e20abf27'];
const target='/work/replay.sqlite';
fs.copyFileSync('/input/database.sqlite',target,fs.constants.COPYFILE_EXCL);
const write=(name,data)=>fs.writeFileSync('/work/'+name,JSON.stringify(data,null,2));
const fingerprints=db=>Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>{
 const h=crypto.createHash('sha256');let n=0;
 for(const row of db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).iterate()) {
  if(name==='content_opportunities'&&ids.includes(row.id)) {
   const a=JSON.parse(row.readiness_json),b=JSON.parse(row.coverage_json);
   delete a.sourceFamilyCount;if(b.readiness)delete b.readiness.sourceFamilyCount;
   row.readiness_json=JSON.stringify(a);row.coverage_json=JSON.stringify(b);
  }
  h.update(JSON.stringify(row));n++;
 }
 return [name,{count:n,sha256:h.digest('hex')}];
}));
let db=new DatabaseSync(target,{readOnly:true});
const schemaBefore=db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v;db.close();
db=openDatabase(target);db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
const schemaAfter=db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v;
const before=fingerprints(db);write('protected-before.json',before);
const identity={path:target,kind:'isolated-snapshot-replay'};
db.exec('BEGIN');const preview=previewRepair(db,ids,identity);db.exec('ROLLBACK');write('preview.json',preview);
try{execFileSync(process.execPath,['/app/scripts/audit-opportunity-qualification.mjs',target,'--enforce'],{maxBuffer:20e6,stdio:['ignore',fs.openSync('/work/audit-before.json','w'),fs.openSync('/work/audit-before.log','w')]});throw new Error('Bad baseline unexpectedly passed');}catch(e){if(e.status!==1)throw e;}
const applied=applyRepair(db,preview,identity);const repeated=applyRepair(db,preview,identity);
const after=fingerprints(db);write('protected-after.json',after);
if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Protected tables changed');
const integrity=db.prepare('PRAGMA integrity_check').all(),foreign=db.prepare('PRAGMA foreign_key_check').all();
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();
execFileSync(process.execPath,['/app/scripts/audit-opportunity-qualification.mjs',target,'--enforce'],{maxBuffer:20e6,stdio:['ignore',fs.openSync('/work/audit-after.json','w'),fs.openSync('/work/audit-after.log','w')]});
write('result.json',{schemaBefore,schemaAfter,applied,repeated,integrity,foreign,protectedTablesUnchanged:true,protectedTableCount:Object.keys(before).length,providerRequests:0,productionMutations:0});
console.log(fs.readFileSync('/work/result.json','utf8'));
