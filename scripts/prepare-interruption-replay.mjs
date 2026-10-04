import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {openDatabase} from '../src/db.mjs';
const dir=path.resolve('output/interruption-recovery-20261004');
const baseline=path.join(dir,'baseline.sqlite'),work=path.join(dir,'recovery-work.sqlite');
if(fs.existsSync(baseline)||fs.existsSync(work))throw new Error('Replay files already exist; preserve the baseline.');
const corpus=JSON.parse(fs.readFileSync(path.join(dir,'live-corpus-tables.json')));
const db=openDatabase(baseline);
db.exec('PRAGMA foreign_keys=OFF; BEGIN');
for(const [table,rows] of Object.entries(corpus.tables)){
  if(!/^[a-z_]+$/.test(table))throw new Error('Invalid table');
  for(const original of rows){
    // The export intentionally excludes raw capture payloads; all parsed evidence is retained.
    const row=table==='sources'?{raw_payload_json:'{}',...original}:original;
    const keys=Object.keys(row);db.prepare(`INSERT OR REPLACE INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k]));
  }
}
db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)');db.close();
fs.copyFileSync(baseline,work);
const local=openDatabase(work);
let found=0,missing=0;
for(const row of local.prepare('SELECT id,local_path,original_sha256 FROM source_assets').all()){
  if(!row.local_path)continue;
  const suffix=row.local_path.split('/source-uploads/')[1];
  const filename=suffix ? path.join('C:/s01-restore-20260927/source-uploads',suffix) : '';
  if(filename&&fs.existsSync(filename)&&(!row.original_sha256||crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')===row.original_sha256)){
    local.prepare('UPDATE source_assets SET local_path=? WHERE id=?').run(filename,row.id);found++;
  }else missing++;
}
local.close();
console.log(JSON.stringify({baseline,work,tables:Object.keys(corpus.tables).length,verifiedOriginals:found,unavailableOriginals:missing,productionWrites:0}));
