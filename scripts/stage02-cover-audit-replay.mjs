import fs from 'node:fs';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {auditDraftCover} from '../src/services/cover-audit.mjs';
import {mediaHash} from '../src/web-media.mjs';

const file=fs.realpathSync(process.argv[2] || '');
if(file!==fs.realpathSync('D:/cms-phase02-media-replay-xiKzH1/work.sqlite'))
  throw new Error('Only the existing authorized disposable work copy is permitted.');
const db=new DatabaseSync(file,{readOnly:true});
const tables=['sources','source_assets','article_drafts','article_visuals','writing_packets','jobs','model_call_metrics','wordpress_publications','media_bindings'];
const fingerprint=()=>Object.fromEntries(tables.map(table=>[table,mediaHash(JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()))]));
const before=fingerprint(),reports=[];
let contract;
try {
  db.exec('BEGIN');
  for(const draft of db.prepare('SELECT id,revision FROM article_drafts ORDER BY id').all()) {
    reports.push(await auditDraftCover(db,draft.id,{expectedRevision:draft.revision}));
  }
  contract=db.prepare(`SELECT frontend_commit_sha,contract_version,checksum,registry_json,page_schema_json
    FROM frontend_contract_snapshots WHERE status='active' ORDER BY synced_at DESC LIMIT 1`).get();
  if(contract)contract={frontend_commit_sha:contract.frontend_commit_sha,contract_version:contract.contract_version,
    checksum:contract.checksum,registry_sha256:mediaHash(contract.registry_json),page_schema_sha256:mediaHash(contract.page_schema_json),
    receiver_capabilities:'NOT_TESTED',source:'existing authorized historical database cache; not deployed version evidence'};
  assert.equal(db.prepare('SELECT total_changes() n').get().n,0);
} finally {
  if(db.isTransaction)db.exec('ROLLBACK');
  assert.deepEqual(fingerprint(),before);
  db.close();
}
console.log(JSON.stringify({scope:'C read-only historical cover dry-run; no pixel or receiver acceptance',
  reports,contract:contract || null,protected_tables:before,rollback:'PASS',writes:0,external_requests:0},null,2));
