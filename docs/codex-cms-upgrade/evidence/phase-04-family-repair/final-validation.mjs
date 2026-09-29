import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {execFileSync} from 'node:child_process';
import {previewRepair,applyRepair} from '/app/scripts/repair-opportunity-families.mjs';
const old=JSON.parse(fs.readFileSync('/work/preview.json'));
const codeIdentity=JSON.parse(fs.readFileSync('/work/code-identity-verified.json'));
for(const [name,expected] of Object.entries(codeIdentity))assert.equal(crypto.createHash('sha256').update(fs.readFileSync('/app/'+name)).digest('hex'),expected,name);
const codeManifestSha256=crypto.createHash('sha256').update(fs.readFileSync('/work/code-identity-verified.json')).digest('hex');
const db=new DatabaseSync('/work/replay.sqlite');
const baseline=new DatabaseSync('/input/database.sqlite',{readOnly:true});
const prior=process.argv.includes('--reuse-migration-comparison')?JSON.parse(fs.readFileSync('/work/final-validation.json')):null;
if(prior) {
  const oldIdentity=JSON.parse(fs.readFileSync('/work/code-identity-before-final.json'));
  assert.equal(oldIdentity['src/db.mjs'],codeIdentity['src/db.mjs'],'Migration code changed; full comparison required');
}
const protectedTables=prior?[]:['sources','capture_versions','source_assets','source_files','source_segments','claims','evidence_spans','extraction_coverage','article_drafts','article_visuals','knowledge_facts','source_family_memberships','knowledge_resolutions','topic_clusters'];
const fingerprints=prior?.migrationProtectedFingerprints || {};
for(const table of protectedTables) {
 const columns=baseline.prepare(`PRAGMA table_info(${table})`).all().map(r=>r.name).filter(c=>!(['source_assets','source_files'].includes(table)&&c==='capture_version'));
 if(!columns.length)continue;
 const fp=d=>{const h=crypto.createHash('sha256');let count=0;for(const row of d.prepare(`SELECT ${columns.map(c=>`"${c}"`).join(',')} FROM ${table} ORDER BY rowid`).iterate()){h.update(JSON.stringify(row));count++;}return {count,sha256:h.digest('hex')};};
 const before=fp(baseline),after=fp(db);assert.deepEqual(after,before,table);fingerprints[table]=after;
}
baseline.close();
// Reconstitute only the known bad derived counts on the disposable work DB, to
// exercise the final tool version. No original or protected values are replaced.
db.exec('BEGIN IMMEDIATE');
for(const r of old.records)db.prepare("UPDATE content_opportunities SET readiness_json=json_set(readiness_json,'$.sourceFamilyCount',?),coverage_json=json_set(coverage_json,'$.readiness.sourceFamilyCount',?) WHERE id=?").run(r.before,r.before,r.id);
db.exec('COMMIT');
const preview=previewRepair(db,old.ids,old.identity);
assert.ok(preview.records.every(r=>!r.linkedProduction&&!r.blocked));
fs.writeFileSync('/work/preview-final.json',JSON.stringify(preview,null,2));
const applied=applyRepair(db,preview,old.identity),repeated=applyRepair(db,preview,old.identity);
assert.equal(applied.changed,6);assert.equal(repeated.changed,0);
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();
const manifest=JSON.parse(fs.readFileSync('/work/preflight-good/manifest.json'));
 const hash=crypto.createHash('sha256'),fd=fs.openSync('/work/replay.sqlite','r'),buffer=Buffer.alloc(1024*1024);
 try{let bytes;while((bytes=fs.readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,bytes));}finally{fs.closeSync(fd);}
manifest.databaseSha256=hash.digest('hex');
manifest.codeManifestSha256=codeManifestSha256;
fs.writeFileSync('/work/preflight-good/manifest.json',JSON.stringify(manifest));
for(const kind of ['bad','good']) {
 let status=0;
 try{execFileSync(process.execPath,['/app/scripts/preflight-opportunities.mjs',`/work/preflight-${kind}`],{timeout:240_000,killSignal:'SIGKILL',stdio:['ignore',fs.openSync(`/work/verified-${kind}.json`,'w'),fs.openSync(`/work/verified-${kind}.log`,'w')]});}catch(e){status=e.status;}
 assert.equal(status,kind==='bad'?1:0);
 const audit=JSON.parse(fs.readFileSync(`/work/verified-${kind}.json`));
 assert.equal(audit.enforcement.hardViolationCount,kind==='bad'?6:0);
}
fs.writeFileSync('/work/final-validation.json',JSON.stringify({applied,repeated,migrationProtectedFingerprints:fingerprints,
  exactFinalGate:{bad:6,good:0},codeManifestSha256,migrationComparisonReused:Boolean(prior),productionActions:0,providerCalls:0},null,2));
console.log('Final code migration fingerprint comparison, exact-ID repair, idempotence and full bad/good gates passed');
