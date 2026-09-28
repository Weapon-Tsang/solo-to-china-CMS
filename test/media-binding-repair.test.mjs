import assert from 'node:assert/strict';
import test from 'node:test';
import { repositoryFixture } from '../test-support/repository-fixture.mjs';
import { normalizeXiaohongshuCapture } from '../src/adapters/xiaohongshu.mjs';
import { supplementMediaContext, buildMediaContext } from '../src/media-context.mjs';
import { readMediaBindings, bindingSupportsPhoto } from '../src/repositories/media-bindings.mjs';

function setup(t) {
  const fixture=repositoryFixture(t);
  const {repository,db}=fixture;
  db.prepare(`INSERT INTO entity_aliases(id,destination_slug,alias_normalized,entity_key,canonical_subject,aliases_json,
    resolution_source,confidence,created_at,updated_at,entity_type,granularity)
    VALUES ('hall','chongqing','hall','hall','Huguang Guild Hall','["湖广会馆"]','manual',1,'now','now','attraction','specific_entity')`).run();
  const source=repository.saveCapture(normalizeXiaohongshuCapture({url:'https://www.xiaohongshu.com/explore/repair-fixture',
    title:'Repair',text:'图1：湖广会馆庭院。',images:[{url:'https://sns-img.xhscdn.com/repair.jpg'}]}));
  return {...fixture,source,id:repository.getSource(source.id).assets[0].id};
}

test('T02-38: automatic local supplementation reads complete long captions and keeps exact locators',()=>{
  const source={id:'s',capture_version:1,raw_text:'Some context.'};
  const asset={id:'a',position:0,caption_text:'x'.repeat(1500)+' 湖广会馆庭院'};
  const before=buildMediaContext(source,[asset]);
  const result=supplementMediaContext(source,asset);
  assert.equal(before.status,'context_pending');
  assert.equal(result.status,'complete');
  assert.equal(result.assets[0].metadata[0].text,asset.caption_text);
  assert.equal(result.assets[0].context_hash,before.assets[0].context_hash);
  assert.equal(result.supplementation.model_calls,0);
  assert.equal(result.supplementation.reads[0].field,'caption');
  assert.equal(result.supplementation.reads[0].start,1000);
});

test('T02-38: exhausted automatic reads retain omitted ranges and never hide pending context',()=>{
  const source={id:'s',capture_version:1,raw_text:'图1：'+'x'.repeat(60000)+' 湖广会馆'};
  const result=supplementMediaContext(source,{id:'a',position:0});
  assert.equal(result.status,'context_pending');
  assert.equal(result.supplementation.added_chars,36000);
  assert.equal(result.supplementation.exhausted,true);
  assert.equal(result.used_chars,48000);
  assert.equal(result.text_budget_chars,48000);
  assert.ok(result.supplementation.read_count<=6);
  assert.deepEqual(result.omitted_ranges.map(row=>[row.start,row.end]),[[48000,source.raw_text.length]]);
  assert.equal(result.blocks[0].truncated,true);
  assert.throws(()=>supplementMediaContext(source,{id:'a'},{maxReads:7}),RangeError);
});

test('T02-43: changing image order changes the context fingerprint and cannot reuse old positional evidence',()=>{
  const source={id:'s',capture_version:1,raw_text:'图1：湖广会馆。\n图2：另一个位置。'};
  const before=buildMediaContext(source,[{id:'a',position:0}]);
  const after=buildMediaContext(source,[{id:'a',position:1}]);
  assert.notEqual(before.assets[0].context_hash,after.assets[0].context_hash);
  assert.notDeepEqual(before.assets[0].explicit_block_ids,after.assets[0].explicit_block_ids);
});

test('T02-42/45: repair previews are read-only, apply is idempotent and stale preview cannot write',t=>{
  const {repository,db,id,source}=setup(t);
  db.prepare('UPDATE source_assets SET caption_text=? WHERE id=?').run('说明 '.repeat(500)+'湖广会馆',id);
  const before={jobs:db.prepare('SELECT COUNT(*) n FROM jobs').get().n,calls:db.prepare('SELECT COUNT(*) n FROM model_call_metrics').get().n};
  const preview=repository.repairMediaBinding(id);
  assert.equal(preview.new_bindings[0].status,'confirmed');
  assert.ok(preview.supplementation.read_count>0);
  assert.equal(preview.reason_counts.ORIGINAL_MISSING,1);
  assert.equal(preview.reason_counts.ANALYSIS_MISSING,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM media_bindings').get().n,0);
  const applied=repository.repairMediaBinding(id,{apply:true,expectedHash:preview.preview_hash});
  assert.equal(applied.applied,true);
  const count=db.prepare('SELECT COUNT(*) n FROM media_bindings').get().n;
  repository.repairMediaBinding(id,{apply:true,expectedHash:applied.preview_hash});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM media_bindings').get().n,count);
  db.prepare('UPDATE sources SET raw_text=? WHERE id=?').run('Changed source evidence',source.id);
  assert.throws(()=>repository.repairMediaBinding(id,{apply:true,expectedHash:applied.preview_hash}),{code:'CONTEXT_STALE'});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM media_bindings').get().n,count);
  assert.deepEqual({jobs:db.prepare('SELECT COUNT(*) n FROM jobs').get().n,calls:db.prepare('SELECT COUNT(*) n FROM model_call_metrics').get().n},before);
});

test('T02-43: revocation survives context/policy revisions without restoring automatic adoption',t=>{
  const {repository,db,id,source}=setup(t);
  repository.refreshSourceMediaBindings(source.id,{dryRun:false});
  db.prepare("UPDATE media_bindings SET status='revoked',policy_version='previous-policy'").run();
  db.prepare("UPDATE sources SET raw_text=raw_text || ' extra context' WHERE id=?").run(source.id);
  const preview=repository.repairMediaBinding(id);
  assert.equal(preview.new_bindings[0].status,'revoked');
  repository.repairMediaBinding(id,{apply:true,expectedHash:preview.preview_hash});
  assert.deepEqual(readMediaBindings(db,id),[]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM media_bindings WHERE status='revoked'").get().n,2);
});

test('T02-38/45: evidence beyond the budget cannot produce a confirmed relation',t=>{
  const {repository,db,id,source}=setup(t);
  db.prepare('UPDATE sources SET raw_text=? WHERE id=?').run('图1：湖广会馆 '+ 'x'.repeat(60000),source.id);
  const preview=repository.repairMediaBinding(id);
  assert.equal(preview.context_status,'context_pending');
  assert.equal(preview.new_bindings.length,0);
  assert.equal(preview.reason_counts.CONTEXT_MISSING,1);
  assert.equal(preview.unresolved_action,'read_context_or_supply_evidence');
});

test('T02-38: unrelated omitted prose does not invalidate a complete direct image caption',t=>{
  const {repository,db,id,source}=setup(t);
  db.prepare('UPDATE source_assets SET caption_text=? WHERE id=?').run('Huguang Guild Hall',id);
  db.prepare('UPDATE sources SET raw_text=? WHERE id=?').run('Unrelated background '.repeat(6000),source.id);
  const preview=repository.repairMediaBinding(id);
  assert.equal(preview.context_status,'context_pending');
  assert.equal(preview.new_bindings[0].status,'confirmed');
});

test('T02-46: PDF visual input with image kind cannot be repaired or matched as an independent photograph',t=>{
  const {repository,db,id}=setup(t);
  db.prepare("UPDATE source_assets SET mime_type='application/pdf' WHERE id=?").run(id);
  assert.throws(()=>repository.repairMediaBinding(id),{code:'PDF_ASSET_NOT_MATERIALIZED'});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM media_bindings').get().n,0);
  assert.equal(bindingSupportsPhoto({mime_type:'application/pdf',asset_kind:'documentary_photo',source_bindings:[{
    status:'confirmed',relation_type:'source_asserts_location',allowed_uses:['stop_photo'],entity_key:'hall'}]}, {entity_key:'hall'}),false);
});

test('T02-45: affected slots are reported while draft and frozen manifest remain unchanged',t=>{
  const {repository,db,id}=setup(t);
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at)
    VALUES ('b','chongqing','Hall','[]','informational','drafted','now','now')`).run();
  db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at,revision,content_hash)
    VALUES ('d','b','Hall','hall','Keep this body','{}','review','now','now',3,'preserved')`).run();
  db.prepare(`INSERT INTO article_visuals(id,draft_id,slot,placement,purpose,alt_text,generation_prompt,aspect_ratio,status,
    created_at,updated_at,source_asset_id) VALUES ('v','d',1,'inline','Courtyard','Courtyard','','16:9','planned','now','now',?)`).run(id);
  const before=db.prepare("SELECT * FROM article_drafts WHERE id='d'").get();
  const visual=db.prepare("SELECT * FROM article_visuals WHERE id='v'").get();
  const preview=repository.repairMediaBinding(id);
  assert.equal(preview.affected_slots[0].draft_id,'d');
  assert.equal(preview.affected_slots[0].revision,3);
  repository.repairMediaBinding(id,{apply:true,expectedHash:preview.preview_hash});
  assert.deepEqual(db.prepare("SELECT * FROM article_drafts WHERE id='d'").get(),before);
  assert.deepEqual(db.prepare("SELECT * FROM article_visuals WHERE id='v'").get(),visual);
});
