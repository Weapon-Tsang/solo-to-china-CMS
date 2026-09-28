import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import sharp from 'sharp';
import {migrate} from '../src/db.mjs';
import {Repository} from '../src/repository.mjs';
import {ArticleMediaService} from '../src/services/article-media.mjs';
import {mediaHash} from '../src/web-media.mjs';
const filename=fs.realpathSync(process.argv[2] || '');
if(filename!==fs.realpathSync('D:/cms-phase02-media-replay-xiKzH1/work.sqlite'))throw new Error('Only the existing approved disposable work database is allowed.');
const db=new DatabaseSync(filename),directory=fs.mkdtempSync(path.join(os.tmpdir(),'cms-d-historical-'));
const tables=['sources','source_assets','article_drafts','article_visuals','writing_packets','jobs','model_call_metrics','wordpress_publications','media_bindings','schema_migrations'];
const fingerprint=()=>Object.fromEntries(tables.map(table=>[table,mediaHash(JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()))]));
const schema=()=>mediaHash(JSON.stringify(db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all()));
const before=fingerprint(),beforeSchema=schema(),items=[];let transientVersion;
try{
  db.exec('BEGIN IMMEDIATE');migrate(db);transientVersion=db.prepare('SELECT MAX(version) n FROM schema_migrations').get().n;
  const repository=new Repository(db),service=new ArticleMediaService(repository,{mediaDir:path.join(directory,'media'),captureMediaUploads:{uploadDir:path.join(directory,'uploads'),storageDir:path.join(directory,'originals')}});
  const bytes=await sharp({create:{width:1200,height:800,channels:3,background:'#e0e0e0'}}).png().toBuffer(),sha256=mediaHash(bytes);
  for(const draft of db.prepare('SELECT id,revision,body_markdown,title,slug,content_hash FROM article_drafts ORDER BY id').all()){
    const created=await service.create(draft.id,{expected_revision:draft.revision,name:'synthetic-replay-only.png',mimeType:'image/png',size:bytes.length,sha256},'transaction-replay');
    await service.chunk(draft.id,created.id,0,bytes,'transaction-replay',sha256);await service.complete(draft.id,created.id,'transaction-replay');
    const target=db.prepare('SELECT id FROM article_visuals WHERE draft_id=? ORDER BY slot LIMIT 1').get(draft.id);
    const input={expected_revision:draft.revision,expected_media_revision:0,selections:[{upload_id:created.id,slot_id:target?.id,purpose:'body',kind:'text',
      caption:'Synthetic replay fixture, never for publication.',description:'Transaction mechanics only; no assertion of historical pixel or semantic suitability.'}]};
    const plan=service.plan(draft.id,input,'transaction-replay'),result=await service.confirm(draft.id,{...input,confirmed:true,plan_hash:plan.plan_hash,idempotency_key:`replay_${mediaHash(draft.id)}`},'transaction-replay');
    assert.deepEqual(db.prepare('SELECT id,revision,body_markdown,title,slug,content_hash FROM article_drafts WHERE id=?').get(draft.id),draft);
    items.push({draft_id:draft.id,revision:draft.revision,body_hash:mediaHash(draft.body_markdown),slot:target?.id || 'new_slot',state:result.state,item_states:result.items.map(x=>x.state),provider_calls:0});
  }
  for(const table of ['writing_packets','jobs','model_call_metrics','wordpress_publications','media_bindings'])assert.equal(fingerprint()[table],before[table]);
}finally{if(db.isTransaction)db.exec('ROLLBACK');assert.deepEqual(fingerprint(),before);assert.equal(schema(),beforeSchema);db.close();}
console.log(JSON.stringify({scope:'Existing historical graph, transient schema83 plus manual upload/confirmation inside outer rollback. Synthetic images are NOT historical image acceptance.',
  directory,transient_schema:transientVersion,items,rollback:'PASS',schema_restored:true,protected_tables:before,committed_writes:0,external_calls:0,historical_pixels:'NOT TESTED: original Linux media paths unavailable'},null,2));
