import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db.mjs';
import { Repository } from '../src/repository.mjs';

// This script never starts a Worker/server or loads credentials. Its only input
// is an already authorized local snapshot; all writes stay in a new temp root.
const sourcePath=fs.realpathSync(process.argv[2] || '');
if(path.basename(sourcePath)!=='database.sqlite' || sourcePath.startsWith(`${process.cwd()}${path.sep}`))
  throw new Error('Pass an existing external snapshot database.sqlite.');
const digest=file=>{
  const hash=crypto.createHash('sha256');const fd=fs.openSync(file,'r');const buffer=Buffer.alloc(1024*1024);
  try{let count;while((count=fs.readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,count));}
  finally{fs.closeSync(fd);}return hash.digest('hex');
};
const workParent=fs.realpathSync(process.argv[3] || os.tmpdir());
const space=fs.statfsSync(workParent);
if(space.bavail*space.bsize<fs.statSync(sourcePath).size*2+512*1024*1024)throw new Error('Insufficient space for isolated baseline and work databases.');
const originalHash=digest(sourcePath);
const root=fs.mkdtempSync(path.join(workParent,'cms-phase02-media-replay-'));
const baseline=path.join(root,'baseline.sqlite');const work=path.join(root,'work.sqlite');
const source=new DatabaseSync(sourcePath,{readOnly:true});
const sourceSchema=source.prepare('SELECT MAX(version) version FROM schema_migrations').get().version;
try{source.exec(`VACUUM INTO '${baseline.replaceAll("'","''")}'`);}finally{source.close();}
fs.copyFileSync(baseline,work);
const baselineHash=digest(baseline);
const db=openDatabase(work);const repository=new Repository(db);
const protectedTables=['sources','source_assets','source_asset_analyses','claims','knowledge_facts','article_drafts',
  'article_visuals','jobs','model_call_metrics','wordpress_publications'];
const fingerprints=()=>Object.fromEntries(protectedTables.map(table=>{
  const hash=crypto.createHash('sha256');let count=0;
  for(const row of db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate()){hash.update(JSON.stringify(row));count++;}
  return [table,{count,sha256:hash.digest('hex')}];
}));
try{
  const before=fingerprints();const reasons={};let assets=0;let bindings=0;
  const started=performance.now();
  for(const {id} of db.prepare('SELECT id FROM sources ORDER BY id').all()){
    const dry=repository.refreshSourceMediaBindings(id);
    const result=repository.refreshSourceMediaBindings(id,{dryRun:false});
    if(JSON.stringify(dry.assets)!==JSON.stringify(result.assets))throw new Error('Dry-run differs from applied work-copy result.');
    for(const asset of result.assets){assets++;bindings+=asset.bindings.length;reasons[asset.reason]=(reasons[asset.reason] || 0)+1;}
  }
  const after=fingerprints();
  const firstCounts={occurrences:db.prepare('SELECT COUNT(*) n FROM media_occurrences').get().n,
    bindings:db.prepare('SELECT COUNT(*) n FROM media_bindings').get().n};
  for(const {id} of db.prepare('SELECT id FROM sources ORDER BY id').all())repository.refreshSourceMediaBindings(id,{dryRun:false});
  const nextCounts={occurrences:db.prepare('SELECT COUNT(*) n FROM media_occurrences').get().n,
    bindings:db.prepare('SELECT COUNT(*) n FROM media_bindings').get().n};
  const invariants={protectedRowsUnchanged:JSON.stringify(before)===JSON.stringify(after),
    idempotent:JSON.stringify(firstCounts)===JSON.stringify(nextCounts),
    originalSnapshotUnchanged:digest(sourcePath)===originalHash,baselineUnchanged:digest(baseline)===baselineHash,
    foreignKeysValid:db.prepare('PRAGMA foreign_key_check').all().length===0,
    noProviderCalls:after.model_call_metrics.count===before.model_call_metrics.count};
  const report={scope:'CMS_ONLY / local disposable historical database replay',schema:81,sourceSchema};
  Object.assign(report,{baselineCounts:Object.fromEntries(Object.entries(before).map(([name,row])=>[name,row.count])),
    assetsInspected:assets,bindingsProposed:bindings,reasons,rows:firstCounts,invariants,
    elapsedMs:Math.round(performance.now()-started),
    audit:{ambiguousBindings:db.prepare("SELECT COUNT(*) n FROM media_bindings WHERE status='ambiguous'").get().n,
      contextsPending:db.prepare("SELECT COUNT(*) n FROM media_occurrences WHERE status='context_pending'").get().n,
      staleConfirmedBindings:db.prepare("SELECT COUNT(*) n FROM media_bindings mb JOIN media_occurrences mo ON mo.id=mb.occurrence_id WHERE mb.status='confirmed' AND mo.status='stale'").get().n},
    limitations:['No actual Provider generation','No image byte semantic inspection','No production mutation','No route, manual-upload or WordPress acceptance'],
    retainedWorkDirectory:path.basename(root)});
  console.log(JSON.stringify(report,null,2));
  if(Object.values(invariants).some(value=>!value))process.exitCode=1;
}finally{db.close();}
