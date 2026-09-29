// Run in the exact release image with --network none. Production volume is read-only.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createBackup,drillBackup} from '../src/backup.mjs';
import {openDatabase,SCHEMA_VERSION} from '../src/db.mjs';
import {VERSION} from '../src/version.mjs';
import {previewRepair,applyRepair} from './repair-opportunity-families.mjs';
import {fileHash,referenceHash,repairIds} from './family-release-boundary.mjs';
import {spawnSync} from 'node:child_process';

const root='/prepared',input=`${root}/input/solo-to-china.sqlite`,preflight=`${root}/preflight`;
const image=process.env.STC_UPGRADE_IMAGE,revision=process.env.STC_UPGRADE_REVISION;
assert.match(image,/@sha256:[a-f0-9]{64}$/);assert.match(revision,/^[a-f0-9]{40}$/);
fs.mkdirSync(preflight,{recursive:false});
const started=Date.now();
const backup=createBackup({databasePath:input,backupDir:`${root}/backups`,prune:false,
  sourceUploadsDir:'/var/lib/solo-to-china/source-uploads',generatedMediaDir:'/var/lib/solo-to-china/generated-media',
  captureUploadsDir:'/app/data/capture-uploads',captureMediaUploadsDir:'/app/data/capture-media-uploads',
  codeRevision:process.env.OLD_IMAGE,reason:'approved-family-release-premaintenance'});
console.log(JSON.stringify({stage:'prepared-complete-backup',elapsedMs:Date.now()-started}));
const drill=drillBackup(backup.backupPath);assert.equal(drill.drill,'passed');
console.log(JSON.stringify({stage:'prepared-restore-drill',status:drill.drill,elapsedMs:Date.now()-started}));
const snapshotManifest=`${backup.backupPath}/manifest.json`;
const baseline=new DatabaseSync(backup.databaseBackupPath,{readOnly:true});
const references=referenceHash(baseline);
const tables=['sources','capture_versions','source_assets','source_files','source_segments','claims','evidence_spans',
  'extraction_coverage','article_drafts','article_visuals','knowledge_facts','source_family_memberships','knowledge_resolutions','topic_clusters'];
const {createHash}=await import('node:crypto');
const fingerprints=(db,definitions=null)=>Object.fromEntries(tables.map(table=>{
  const columns=definitions?.[table]?.columns || baseline.prepare(`PRAGMA table_info(${table})`).all().map(r=>r.name)
    .filter(c=>!(['source_assets','source_files'].includes(table)&&c==='capture_version'));
  const h=createHash('sha256');let count=0;
  for(const row of db.prepare(`SELECT ${columns.map(c=>`"${c}"`).join(',')} FROM ${table} ORDER BY rowid`).iterate()) {h.update(JSON.stringify(row)+'\n');count++;}
  return [table,{columns,count,sha256:h.digest('hex')}];
}));
const before=fingerprints(baseline);baseline.close();
const database=`${preflight}/database.sqlite`;
fs.copyFileSync(backup.databaseBackupPath,database,fs.constants.COPYFILE_EXCL);
const migrationStart=Date.now(),db=openDatabase(database);
assert.deepEqual(fingerprints(db,before),before,'Migration changed protected inputs');
assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
const preview=previewRepair(db,repairIds,{kind:'premaintenance-rehearsal',image,revision});
assert.ok(preview.records.every(r=>!r.blocked&&r.changed));
const applied=applyRepair(db,preview,preview.identity);assert.equal(applied.changed,6);
assert.equal(applyRepair(db,preview,preview.identity).changed,0);
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();
const migrationMs=Date.now()-migrationStart;
fs.writeFileSync(`${preflight}/boundary-plan.json`,JSON.stringify({snapshot:backup.backupPath,
  snapshotManifestSha256:fileHash(snapshotManifest),references,expected:preview,
  restoreDrill:'passed',preparedAt:new Date().toISOString(),migrationMs},null,2),{flag:'wx'});
fs.writeFileSync(`${preflight}/manifest.json`,JSON.stringify({image,revision,version:VERSION,
  inputSnapshotSha256:fileHash(backup.databaseBackupPath),databaseSha256:fileHash(database),
  migration:{schema:SCHEMA_VERSION,preservedContentFingerprints:true},migrationMs},null,2),{flag:'wx'});
const gate=spawnSync(process.execPath,['/app/scripts/preflight-opportunities.mjs',preflight],
  {env:{...process.env,STC_UPGRADE_VERSION:VERSION},stdio:['ignore',fs.openSync(`${root}/audit.json`,'w'),fs.openSync(`${root}/audit.log`,'w')],
    timeout:180000,killSignal:'SIGKILL'});
assert.equal(gate.status,0,`Prepared gate failed: ${gate.error || gate.status}`);
console.log(JSON.stringify({stage:'prepared-ready',image,revision,migrationMs,elapsedMs:Date.now()-started,hardViolations:0}));
