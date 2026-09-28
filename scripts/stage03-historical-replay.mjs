import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db.mjs';
import { Repository } from '../src/repository.mjs';
import { ArticleMediaService } from '../src/services/article-media.mjs';
import { createDraftSeoInspection } from '../src/services/draft-seo-inspection.mjs';
import { mediaHash } from '../src/web-media.mjs';
import sharp from 'sharp';
import {auditDraftCover} from '../src/services/cover-audit.mjs';
import {editorialSeoContext} from '../src/services/editorial-seo-context.mjs';

const filename=fs.realpathSync(process.argv[2] || '');
if(filename!==fs.realpathSync('D:/cms-phase02-media-replay-xiKzH1/work.sqlite'))throw new Error('Only the existing disposable work copy is allowed.');
const db=new DatabaseSync(filename); // SQLite recovers any interrupted uncommitted journal before inspection.
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cms-phase03-historical-'));
const tableHash=table=>{const hash=crypto.createHash('sha256');let count=0;
  for(const row of db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate()){hash.update(JSON.stringify(row));count++;}
  return {count,sha256:hash.digest('hex')};};
const protectedTables=['article_drafts','article_visuals','wordpress_publications','jobs','model_call_metrics','media_bindings'];
const before=Object.fromEntries(protectedTables.map(table=>[table,tableHash(table)]));
const counts=()=>Object.fromEntries(['sources','source_assets','claims','article_drafts'].map(table=>[table,db.prepare(`SELECT count(*) n FROM ${table}`).get().n]));
const baselineCounts=counts(),schema=mediaHash(JSON.stringify(db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all()));
const samples=[],items=[];
try {
  db.exec('BEGIN IMMEDIATE');migrate(db);
  const migratedBaseline=Object.fromEntries(protectedTables.map(table=>[table,tableHash(table)]));
  const repository=new Repository(db),service=new ArticleMediaService(repository,{mediaDir:path.join(directory,'media'),
    captureMediaUploads:{uploadDir:path.join(directory,'uploads'),storageDir:path.join(directory,'originals')}});
  const inspection=createDraftSeoInspection(db,{siteUrl:'https://example.invalid',inspector:{inspect:()=>{throw new Error('No network allowed');}}});
  const bytes=await sharp({create:{width:1200,height:800,channels:3,background:'#e0e0e0'}}).png().toBuffer(),sha256=mediaHash(bytes);
  for(const draft of db.prepare('SELECT id,revision,body_markdown,title,slug,content_hash FROM article_drafts ORDER BY id').all()) {
    const brief=db.prepare('SELECT cb.* FROM content_briefs cb JOIN article_drafts ad ON ad.brief_id=cb.id WHERE ad.id=?').get(draft.id);
    const topic=repository.getTopicPackage(brief.candidate_id);
    const editorial=editorialSeoContext(db,{inventory:repository.listWordPressInventory(),proposal:topic?.approved_proposal,
      destination:brief.destination_slug,topic:brief.topic,siteUrl:'https://example.invalid',facts:topic?.facts || [],candidateId:brief.candidate_id,plan:JSON.parse(brief.plan_json || '{}')});
    assert.equal(editorial.external_calls,0);assert.equal(editorial.automatic,false);
    assert.ok(editorial.links.every(link=>link.public_accessibility==='confirmed'));
    const coverBefore=await auditDraftCover(db,draft.id);
    const started=performance.now(),state=service.list(draft.id,'replay');samples.push(performance.now()-started);
    const seo=inspection.read(draft.id);assert.equal(seo.observation,null);
    const created=await service.create(draft.id,{expected_revision:draft.revision,name:'synthetic-replay.png',mimeType:'image/png',size:bytes.length,sha256},'replay');
    await service.chunk(draft.id,created.id,0,bytes,'replay',sha256);await service.complete(draft.id,created.id,'replay');
    const input={expected_revision:draft.revision,expected_media_revision:state.media_revision,selections:[{upload_id:created.id,purpose:'body',kind:'text',caption:'Synthetic local replay only.',description:'Tests persistence, never historical image suitability.'}]};
    const plan=service.plan(draft.id,input,'replay');
    const result=await service.confirm(draft.id,{...input,confirmed:true,plan_hash:plan.plan_hash,idempotency_key:`phase03_${mediaHash(draft.id)}`},'replay');
    assert.equal(result.state,'waiting_attention');assert.equal(result.provider_calls,0);
    const coverAfter=await auditDraftCover(db,draft.id);
    assert.equal(coverAfter.candidates.find(c=>c.id===plan.selections[0].slot_id)?.eligible,false);
    assert.deepEqual(db.prepare('SELECT id,revision,body_markdown,title,slug,content_hash FROM article_drafts WHERE id=?').get(draft.id),draft);
    items.push({draft_id:draft.id,body_hash:mediaHash(draft.body_markdown),route_present:Boolean(state.route),media_revision:result.media_revision,
      editorial:{action:editorial.disposition.action,confirmed_links:editorial.links.length,unverified_targets:editorial.unverified_targets.length},
      cover_audit:{before_candidates:coverBefore.candidates.length,after_candidates:coverAfter.candidates.length,null_qa_rejected:true}});
  }
  for(const table of ['article_drafts','wordpress_publications','jobs','model_call_metrics','media_bindings'])assert.deepEqual(tableHash(table),migratedBaseline[table],table);
} finally {
  if(db.isTransaction)db.exec('ROLLBACK');
  for(const table of protectedTables)assert.deepEqual(tableHash(table),before[table]);
  assert.deepEqual(counts(),baselineCounts);
  assert.equal(mediaHash(JSON.stringify(db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all())),schema);
  db.close();
}
console.log(JSON.stringify({status:'PASS',scope:'existing historical disposable copy; synthetic uploads, no original pixels or full production replay',baselineCounts,items,
  menu_list_ms:samples,protected:before,rollback:'PASS',committed_writes:0,external_calls:0,directory},null,2));
