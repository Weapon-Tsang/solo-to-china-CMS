import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { repositoryFixture } from '../test-support/repository-fixture.mjs';
import { normalizeXiaohongshuCapture } from '../src/adapters/xiaohongshu.mjs';
import { bindingSupportsPhoto, readMediaBindings } from '../src/repositories/media-bindings.mjs';
import { normalizeVisuals } from '../src/repository.mjs';
import { createBackup, restoreBackup } from '../src/backup.mjs';
import { openDatabase, SCHEMA_VERSION } from '../src/db.mjs';
import { freezeRequiredMediaManifest, evaluatePublicationEligibility } from '../src/publication-eligibility.mjs';

function alias(db,key='huguang',name='Huguang Guild Hall',names=['湖广会馆']) {
  db.prepare(`INSERT INTO entity_aliases(id,destination_slug,alias_normalized,entity_key,canonical_subject,aliases_json,resolution_source,confidence,created_at,updated_at)
    VALUES (?,'chongqing',?,?,?,?,'manual',1,'now','now')`).run(key,key,key,name,JSON.stringify(names));
  db.prepare("UPDATE entity_aliases SET entity_type='attraction',granularity='specific_entity' WHERE id=?").run(key);
}
function capture(repository, text='图1：湖广会馆庭院。', count=1, suffix='binding') {
  return repository.saveCapture(normalizeXiaohongshuCapture({url:`https://www.xiaohongshu.com/explore/${suffix}`,title:'Not image identity',text,
    images:Array.from({length:count},(_,i)=>({url:`https://sns-img.xhscdn.com/${suffix}-${i}.jpg`,alt:'traditional courtyard'}))}));
}
function ready(db,sourceId) {
  db.prepare(`UPDATE source_assets SET local_path='fixture-only.jpg',storage_status='saved',original_bytes_status='saved_original',
    durability_status='ORIGINAL_STORED',original_sha256='fixture',stored_sha256='fixture' WHERE source_id=?`).run(sourceId);
}
function analyze(repository, assetId) {
  repository.saveSourceAssetAnalysis(assetId,{analysis_status:'ready',asset_kind:'documentary_photo',primary_subjects:['traditional courtyard'],
    text_regions:[],photo_regions:[],entities:[],reader_text_present:false,confidence:0.8,analysis_version:'media-analysis-2'});
}

test('T02-36/39/43: typed evidence persists and only the supported use can match',t=>{
  const {repository,db}=repositoryFixture(t);alias(db);
  for (const [suffix,text,type,use,match] of [
    ['depiction','Photo 1 depicts Huguang Guild Hall.','depicts_entity','stop_photo',true],
    ['route','Photo 1 taken during the Huguang Guild Hall route.','captured_during_route','route_context_photo',true],
    ['topic','Photo 1 illustrates the topic Huguang Guild Hall.','illustrates_topic','stop_photo',false],
    ['mention','Photo 1 mentions Huguang Guild Hall.','mentions_entity','stop_photo',false],
  ]) {
    const source=capture(repository,text,1,suffix);ready(db,source.id);
    const id=repository.getSource(source.id).assets[0].id;analyze(repository,id);
    const preview=repository.refreshSourceMediaBindings(source.id);
    assert.equal(preview.assets[0].bindings[0].relation_type,type);
    repository.refreshSourceMediaBindings(source.id,{dryRun:false});
    const rows=readMediaBindings(db,id);assert.equal(rows[0].relation_type,type);
    assert.ok(rows[0].evidence[0].locator);
    const dto=repository.sourceAssetDecisionDto(id);
    assert.equal(bindingSupportsPhoto(dto,{entity_key:'huguang',media_purpose:use}),match);
    if(match) {
      const normalized=normalizeVisuals([{source_asset_id:id,image_type:'real_world_photo',image_subject:'Huguang Guild Hall',
        purpose:'Huguang Guild Hall scene',required:true,media_metadata:{media_purpose:use}}],
        {id:'typed-draft',title:'Huguang Guild Hall',body_markdown:'Huguang Guild Hall scene',strategy_version:'3.8'},
        {destination_slug:'chongqing',topic:'Huguang Guild Hall'},[dto],{content_type:'itinerary',visuals:{target:1,maximum:5}});
      assert.equal(normalized[0].source_asset_id,id);
      assert.equal(normalized[0].media_metadata.required_visual_gap,null);
      assert.ok(normalized[0].media_metadata.authorized_asset_match.source_binding_ids.includes(rows[0].id));
    }
    assert.equal(bindingSupportsPhoto(dto,{entity_key:'huguang',image_subject:'precise entrance'}),false);
    if(type==='captured_during_route') assert.equal(bindingSupportsPhoto(dto,{entity_key:'huguang',media_purpose:'stop_photo'}),false);
  }
});

test('T02-43: explicit opposing source statements persist as conflict, never score away',t=>{
  const {repository,db}=repositoryFixture(t);alias(db);
  const source=capture(repository,'Photo 1: Huguang Guild Hall.\nPhoto 1 is not Huguang Guild Hall.',1,'opposition');
  repository.refreshSourceMediaBindings(source.id,{dryRun:false});
  const row=db.prepare('SELECT * FROM media_bindings').get();
  assert.equal(row.status,'conflict');
  const evidence=JSON.parse(row.evidence_json);
  assert.ok(evidence.some(item=>item.polarity==='supports'));
  assert.ok(evidence.some(item=>item.polarity==='contradicts'));
  assert.equal(readMediaBindings(db,row.asset_id).length,0);
});

test('T02-43: same bytes retain a locatable opposing occurrence and invalidate a prior positive read',t=>{
  const {repository,db}=repositoryFixture(t);alias(db);
  const first=capture(repository,'Photo 1: Huguang Guild Hall.',1,'positive-peer');ready(db,first.id);
  repository.refreshSourceMediaBindings(first.id,{dryRun:false});
  const id=repository.getSource(first.id).assets[0].id;
  assert.equal(readMediaBindings(db,id).length,1);
  const second=capture(repository,'Photo 1 is not Huguang Guild Hall.',1,'negative-peer');ready(db,second.id);
  assert.equal(readMediaBindings(db,id).length,0);
  const repaired=repository.refreshSourceMediaBindings(first.id,{dryRun:false});
  assert.equal(repaired.assets[0].bindings[0].status,'conflict');
  assert.ok(repaired.assets[0].bindings[0].evidence.some(e=>e.locator.source_id===second.id));
});

test('T02-43: unrelated negation is not an explicit contradiction of the named place',t=>{
  const {repository,db}=repositoryFixture(t);alias(db);
  const source=capture(repository,'Photo 1: Huguang Guild Hall. This is not a ticket office.',1,'negation-scope');
  const result=repository.refreshSourceMediaBindings(source.id);
  assert.ok(result.assets[0].bindings.every(row=>row.status!=='conflict'));
});

test('T02-43: conflicting source evidence cannot re-enter matching through perfect pixel-name overlap',t=>{
  const {repository,db}=repositoryFixture(t);alias(db);
  const source=capture(repository,'Photo 1 is not Huguang Guild Hall.',1,'conflict-pixel');ready(db,source.id);
  const id=repository.getSource(source.id).assets[0].id;
  analyze(repository,id);
  db.prepare('UPDATE source_asset_analyses SET primary_subjects_json=? WHERE asset_id=?').run(JSON.stringify(['Huguang Guild Hall']),id);
  repository.refreshSourceMediaBindings(source.id,{dryRun:false});
  const rejected=db.prepare('SELECT status,evidence_json FROM media_bindings WHERE asset_id=?').get(id);
  assert.equal(rejected.status,'candidate');
  assert.ok(JSON.parse(rejected.evidence_json).every(e=>e.polarity==='contradicts'));
  const brief={destination_slug:'chongqing',entity_key:'huguang',topic:'Huguang Guild Hall'};
  const selected=normalizeVisuals([{source_asset_id:id,image_type:'real_world_photo',image_subject:'Huguang Guild Hall',
    purpose:'Huguang Guild Hall',required:true}],{id:'draft',title:'Huguang Guild Hall',body_markdown:'Huguang Guild Hall',strategy_version:'3.8'},
    brief,repository.authorizedSourceAssetsForBrief(brief,{additionalSourceIds:[source.id]}),{content_type:'attraction_guide',visuals:{target:1,maximum:5}});
  assert.ok(selected[0].media_metadata.required_visual_gap);
});

test('T02-33/34/40: explicit source relation retrieves a generic photo with no Claims and survives focused-article matching',t=>{
  const {repository,db}=repositoryFixture(t);alias(db);
  const source=capture(repository);ready(db,source.id);
  const id=repository.getSource(source.id).assets[0].id;analyze(repository,id);
  const before=db.prepare('SELECT COUNT(*) n FROM claims').get().n;
  const dry=repository.refreshSourceMediaBindings(source.id);
  assert.equal(dry.assets[0].bindings[0].status,'confirmed');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM media_bindings').get().n,0);
  repository.refreshSourceMediaBindings(source.id,{dryRun:false});
  const brief={destination_slug:'chongqing',entity_key:'huguang',topic:'Huguang Guild Hall'};
  const assets=repository.authorizedSourceAssetsForBrief(brief);
  assert.equal(assets.length,1);assert.equal(assets[0].source_bindings[0].entity_key,'huguang');
  assert.deepEqual(assets[0].primary_subjects,['traditional courtyard']);
  const selected=normalizeVisuals([{source_asset_id:id,image_type:'real_world_photo',image_subject:'Huguang Guild Hall courtyard',
    purpose:'Show the courtyard',required:true,media_metadata:{authorized_asset_match:{displaced_asset_ids:[id]}}}],
    {id:'draft',title:'Huguang Guild Hall visit',body_markdown:'A courtyard visit.',strategy_version:'3.8'},brief,assets,
    {content_type:'attraction_guide',visuals:{target:1,maximum:5}});
  assert.equal(selected[0].source_asset_id,id);
  assert.equal(selected[0].media_metadata?.required_visual_gap,null);
  assert.equal(selected[0].media_metadata.authorized_asset_match.source_binding_ids.length,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM claims').get().n,before);
});

test('T02-43: ambiguous cross-destination entities are separately retained and city-level names cannot confirm a stop',t=>{
  const {repository,db}=repositoryFixture(t);alias(db);
  db.prepare(`INSERT INTO entity_aliases SELECT 'duplicate-city','elsewhere',alias_normalized,entity_key,canonical_subject,
    aliases_json,resolution_source,confidence,created_at,updated_at,entity_type,granularity,location_json FROM entity_aliases WHERE id='huguang'`).run();
  const source=capture(repository);
  repository.refreshSourceMediaBindings(source.id,{dryRun:false});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM media_bindings').get().n,2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM media_bindings WHERE status='ambiguous'").get().n,2);
  alias(db,'city','Chongqing',['重庆']);
  db.prepare("UPDATE entity_aliases SET entity_type='city',granularity='city_level' WHERE id='city'").run();
  const generic=capture(repository,'图1：重庆。',1,'city-scope');
  assert.equal(repository.refreshSourceMediaBindings(generic.id).assets[0].bindings[0].status,'candidate');
});

test('T02-43: publication gate rejects a revoked source binding even when an old matching score is high',t=>{
  const {repository,db}=repositoryFixture(t);alias(db);
  const source=capture(repository);ready(db,source.id);
  repository.refreshSourceMediaBindings(source.id,{dryRun:false});
  const binding=db.prepare('SELECT id,asset_id FROM media_bindings').get();
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at)
    VALUES ('b','chongqing','Huguang','[]','informational','drafted','now','now')`).run();
  db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at,revision,content_hash)
    VALUES ('d','b','Huguang','huguang','Preserved body','{}','review','now','now',1,'body-hash')`).run();
  db.prepare(`INSERT INTO article_visuals(id,draft_id,slot,placement,purpose,alt_text,generation_prompt,aspect_ratio,status,
    created_at,updated_at,asset_fingerprint,image_type,image_role,acquisition_strategy,factual_image_required,source_asset_id,media_metadata_json)
    VALUES ('v','d',1,'inline','Show courtyard','Courtyard','','16:9','generated','now','now','plan','real_world_photo','support',
      'use_authorized_source_image',1,?,?)`).run(binding.asset_id,JSON.stringify({authorized_asset_match:{score:1,source_binding_ids:[binding.id]}}));
  freezeRequiredMediaManifest(db,'d');
  assert.ok(evaluatePublicationEligibility(db,'d').missing.every(item=>!item.failures?.includes('source_binding_stale_or_conflicted')));
  const originalText=db.prepare('SELECT raw_text FROM sources WHERE id=?').get(source.id).raw_text;
  db.prepare('UPDATE sources SET raw_text=? WHERE id=?').run('Changed evidence before any repair job.',source.id);
  assert.match(JSON.stringify(evaluatePublicationEligibility(db,'d')),/source_binding_stale_or_conflicted/);
  db.prepare('UPDATE sources SET raw_text=? WHERE id=?').run(originalText,source.id);
  db.prepare("UPDATE media_bindings SET status='revoked'").run();
  const gate=evaluatePublicationEligibility(db,'d');
  assert.equal(gate.passed,false);
  assert.match(JSON.stringify(gate),/source_binding_stale_or_conflicted/);
  db.prepare("UPDATE article_visuals SET image_subject='Huguang Guild Hall',media_metadata_json=? WHERE id='v'")
    .run(JSON.stringify({authorized_asset_match:{score:1}}));
  assert.match(JSON.stringify(evaluatePublicationEligibility(db,'d')),/source_binding_stale_or_conflicted/);
  assert.equal(db.prepare("SELECT body_markdown FROM article_drafts WHERE id='d'").get().body_markdown,'Preserved body');
  db.prepare("UPDATE sources SET raw_text='The caption was removed.' WHERE id=?").run(source.id);
  assert.match(JSON.stringify(evaluatePublicationEligibility(db,'d')),/source_binding_stale_or_conflicted/);
});

test('T02-42/43: a newly conflicting alias invalidates only the binding revision and preserves prior evidence',t=>{
  const {repository,db}=repositoryFixture(t);alias(db);
  const source=capture(repository);ready(db,source.id);
  repository.refreshSourceMediaBindings(source.id,{dryRun:false});
  const first=db.prepare('SELECT id,occurrence_id FROM media_bindings').get();
  alias(db,'different','A different hall',['湖广会馆']);
  repository.refreshSourceMediaBindings(source.id,{dryRun:false});
  assert.equal(db.prepare('SELECT status FROM media_bindings WHERE id=?').get(first.id).status,'stale');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM media_bindings WHERE status='ambiguous'").get().n,2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM media_occurrences').get().n,2);
});

test('T02-36/39: nearby mentions, uncertain captions and multi-place image references cannot certify a specific photo',t=>{
  const {repository,db}=repositoryFixture(t);alias(db);alias(db,'eling','Eling Park',['鹅岭公园']);
  for(const [suffix,text,status] of [['mention','湖广会馆，然后鹅岭公园。',null],
    ['uncertain','图1：可能是湖广会馆。','ambiguous'],['multiple','图1：湖广会馆和鹅岭公园。','ambiguous']]){
    const source=capture(repository,text,1,suffix);
    const report=repository.refreshSourceMediaBindings(source.id,{dryRun:false});
    assert.ok(report.assets[0].bindings.every(item=>item.status===status));
    const asset=repository.sourceAssetDecisionDto(repository.getSource(source.id).assets[0].id);
    assert.equal(asset.source_bindings.length,0);
  }
  const asset={asset_kind:'documentary_photo',source_bindings:[{status:'confirmed',relation_type:'source_asserts_location',
    allowed_uses:['stop_photo'],canonical_subject:'Huguang Guild Hall',entity_key:'huguang'}]};
  assert.equal(bindingSupportsPhoto(asset,{image_subject:'Huguang Guild Hall entrance'}),false);
  assert.equal(bindingSupportsPhoto({...asset,asset_kind:'editorial_infographic'},{image_subject:'Huguang Guild Hall'}),false);
});

test('T02-41: explicit IDs beyond 160 are preserved; automatic paging reports a remaining range',t=>{
  const {repository,db}=repositoryFixture(t);alias(db);
  const source=capture(repository,'A note without Claims.',181);ready(db,source.id);
  const ids=repository.getSource(source.id).assets.map(asset=>asset.id);
  const all=repository.authorizedSourceAssetsForBrief({destination_slug:'chongqing'},
    {packet:{context:{version:2,authorized_source_assets:ids.map(id=>({id}))}}});
  assert.equal(all.length,181);assert.equal(all.retrieval.explicit_count,181);
  const first=repository.authorizedSourceAssetsForBrief({destination_slug:'chongqing'},{additionalSourceIds:[source.id],limit:160});
  const second=repository.authorizedSourceAssetsForBrief({destination_slug:'chongqing'},{additionalSourceIds:[source.id],limit:160,offset:160});
  assert.equal(first.retrieval.has_more,true);assert.equal(second.retrieval.has_more,false);
  assert.equal(new Set([...first,...second].map(asset=>asset.id)).size,181);
});

test('T02-41: existing article slot retrieves its exact ID beyond the automatic source page',t=>{
  const {repository,db}=repositoryFixture(t);
  const source=capture(repository,'No image relationship asserted.',181,'exact-slot');ready(db,source.id);
  const assetId=repository.getSource(source.id).assets.at(-1).id;
  analyze(repository,assetId);
  db.prepare('UPDATE source_asset_analyses SET primary_subjects_json=? WHERE asset_id=?')
    .run(JSON.stringify(['Huguang Guild Hall courtyard']),assetId);
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at)
    VALUES ('exact-brief','chongqing','Huguang Guild Hall','[]','informational','drafted','now','now')`).run();
  db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at,revision,content_hash,strategy_version)
    VALUES ('exact-draft','exact-brief','Huguang Guild Hall','hall','Huguang Guild Hall courtyard','{}','review','now','now',1,'hash','3.8')`).run();
  db.prepare(`INSERT INTO article_visuals(id,draft_id,slot,placement,purpose,alt_text,generation_prompt,aspect_ratio,status,
    created_at,updated_at,asset_fingerprint,image_type,image_role,acquisition_strategy,factual_image_required,source_asset_id,media_metadata_json,image_subject)
    VALUES ('exact-visual','exact-draft',1,'inline','Huguang Guild Hall courtyard','Courtyard','','16:9','planned','now','now','plan',
    'real_world_photo','support','use_authorized_source_image',1,?,'{}','Huguang Guild Hall courtyard')`).run(assetId);
  const plan=repository.mediaRepairPlan('exact-draft',{strategyVersion:'3.8'});
  assert.equal(plan.slots[0].source_asset_id,assetId);
  assert.equal(plan.slots[0].disposition,'repair');
});

test('T02-42/43: only binding context changes, old relation remains stale, analysis and bytes are reused',t=>{
  const {repository,db}=repositoryFixture(t);alias(db);alias(db,'eling','Eling Park',['鹅岭公园']);
  const source=capture(repository);ready(db,source.id);
  const id=repository.getSource(source.id).assets[0].id;analyze(repository,id);
  repository.refreshSourceMediaBindings(source.id,{dryRun:false});
  const analysisBefore=db.prepare('SELECT * FROM source_asset_analyses WHERE asset_id=?').get(id);
  db.prepare("UPDATE sources SET raw_text='图1：鹅岭公园。' WHERE id=?").run(source.id);
  repository.refreshSourceMediaBindings(source.id,{dryRun:false});
  const asset=repository.sourceAssetDecisionDto(id);
  assert.equal(asset.source_bindings.length,1);assert.equal(asset.source_bindings[0].entity_key,'eling');
  assert.equal(db.prepare("SELECT status FROM media_bindings WHERE entity_key='huguang'").get().status,'stale');
  assert.deepEqual(db.prepare('SELECT * FROM source_asset_analyses WHERE asset_id=?').get(id),analysisBefore);
  const count=db.prepare('SELECT COUNT(*) n FROM media_occurrences').get().n;
  repository.refreshSourceMediaBindings(source.id,{dryRun:false});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM media_occurrences').get().n,count);
});

test('T02-63/70: snapshot and isolated review restore preserve context and binding fingerprints without jobs',t=>{
  const {repository,db,directory}=repositoryFixture(t);alias(db);
  const source=capture(repository,'Photo 1 depicts Huguang Guild Hall.\nPhoto 1 taken during the Huguang Guild Hall route.');
  repository.refreshSourceMediaBindings(source.id,{dryRun:false});
  assert.deepEqual(db.prepare('SELECT relation_type FROM media_bindings ORDER BY relation_type').all().map(r=>r.relation_type),
    ['captured_during_route','depicts_entity']);
  db.prepare('DELETE FROM jobs').run();
  const snapshot=createBackup({databasePath:path.join(directory,'test.sqlite'),backupDir:path.join(directory,'backup')});
  const restored=restoreBackup(snapshot.backupPath,path.join(directory,'restored'));
  assert.equal(restored.mode,'migration-review');
  const copy=openDatabase(restored.databasePath,{migrate:false});
  try{
    for(const table of ['media_occurrences','media_bindings'])assert.deepEqual(copy.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
    assert.equal(copy.prepare('SELECT COUNT(*) n FROM jobs').get().n,0);
    assert.equal(copy.prepare('PRAGMA foreign_key_check').all().length,0);
  }finally{copy.close();}
});

test('schema 81 is additive and does not backfill, buy analysis, or mutate old records',async t=>{
  const {directory}=repositoryFixture(t);
  const oldModule=path.join(directory,'schema80.mjs');
  fs.writeFileSync(oldModule,fs.readFileSync(new URL('../src/db.mjs',import.meta.url),'utf8')
    .replace(/^  if \(current < (\d+)\) migration\w+\(db\);$/gm,(line,version)=>Number(version)>=81?'':line));
  const old=await import(pathToFileURL(oldModule).href);
  const file=path.join(directory,'old.sqlite');old.openDatabase(file).close();
  const upgraded=openDatabase(file);
  try{
    assert.equal(upgraded.prepare('SELECT MAX(version) version FROM schema_migrations').get().version,SCHEMA_VERSION);
    for(const table of ['media_occurrences','media_bindings','jobs','model_call_metrics'])assert.equal(upgraded.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
  }finally{upgraded.close();}
});

test('T02-42/43: reads reject text, caption and alias changes before a repair job without mutating records',t=>{
  const {repository,db}=repositoryFixture(t);alias(db);
  const source=capture(repository);ready(db,source.id);
  const id=repository.getSource(source.id).assets[0].id;analyze(repository,id);
  repository.refreshSourceMediaBindings(source.id,{dryRun:false});
  const before=db.prepare('SELECT * FROM media_bindings').all();
  assert.equal(readMediaBindings(db,id).length,1);
  const text=db.prepare('SELECT raw_text FROM sources WHERE id=?').get(source.id).raw_text;
  db.prepare('UPDATE sources SET raw_text=? WHERE id=?').run('Changed context without a supported location.',source.id);
  assert.equal(readMediaBindings(db,id).length,0);
  db.prepare('UPDATE sources SET raw_text=? WHERE id=?').run(text,source.id);
  db.prepare('UPDATE source_assets SET caption_text=? WHERE id=?').run('A changed caption',id);
  assert.equal(readMediaBindings(db,id).length,0);
  db.prepare("UPDATE source_assets SET caption_text='' WHERE id=?").run(id);
  assert.equal(readMediaBindings(db,id).length,1);
  alias(db,'other','Other Hall',['湖广会馆']);
  assert.equal(readMediaBindings(db,id).length,0);
  assert.deepEqual(db.prepare('SELECT * FROM media_bindings').all(),before);
});

test('T02-42/43: reversible evidence edits restore the matching revision but never revive revoked decisions',t=>{
  const {repository,db}=repositoryFixture(t);alias(db);alias(db,'eling','Eling Park',['鹅岭公园']);
  const source=capture(repository);ready(db,source.id);
  const id=repository.getSource(source.id).assets[0].id;
  const original=db.prepare('SELECT raw_text FROM sources WHERE id=?').get(source.id).raw_text;
  const set=text=>{db.prepare('UPDATE sources SET raw_text=? WHERE id=?').run(text,source.id);
    repository.refreshSourceMediaBindings(source.id,{dryRun:false,assetIds:[id]});};
  set(original);const first=readMediaBindings(db,id)[0].id;
  set('图1：鹅岭公园。');assert.equal(readMediaBindings(db,id)[0].entity_key,'eling');
  set(original);assert.equal(readMediaBindings(db,id)[0].id,first);
  db.prepare("UPDATE media_bindings SET status='revoked' WHERE id=?").run(first);
  set('图1：鹅岭公园。');set(original);
  assert.equal(readMediaBindings(db,id).length,0);
  assert.equal(db.prepare('SELECT status FROM media_bindings WHERE id=?').get(first).status,'revoked');
  assert.throws(()=>repository.refreshSourceMediaBindings(source.id,{dryRun:false,assetIds:['foreign']}),{code:'CONTEXT_STALE'});
});

test('T02-39: entity identity cannot certify a different destination, uppercase entrance or whole-day diagram',()=>{
  const asset={asset_kind:'documentary_photo',source_bindings:[{status:'confirmed',relation_type:'source_asserts_location',
    allowed_uses:['stop_photo'],canonical_subject:'Huguang Guild Hall',entity_key:'hall',destination_slug:'chongqing'}]};
  assert.equal(bindingSupportsPhoto(asset,{entity_key:'hall',destination_slug:'chongqing',image_subject:'Courtyard'}),true);
  for (const request of [{destination_slug:'chengdu'},{image_subject:'ENTRANCE'},
    {image_subject:'Day 2 route diagram'},{media_purpose:'day_route_diagram'}]) {
    assert.equal(bindingSupportsPhoto(asset,{entity_key:'hall',...request}),false);
  }
});

test('T02-43: alias cache observes another connection and never retains rolled-back evidence',t=>{
  const {repository,db,directory}=repositoryFixture(t);alias(db);
  const source=capture(repository);ready(db,source.id);
  const id=repository.getSource(source.id).assets[0].id;
  repository.refreshSourceMediaBindings(source.id,{dryRun:false});
  assert.equal(readMediaBindings(db,id).length,1);
  const other=new DatabaseSync(path.join(directory,'test.sqlite'));
  try {alias(other,'other','Other Hall',['湖广会馆']);}finally{other.close();}
  assert.equal(readMediaBindings(db,id).length,0);
  db.prepare("DELETE FROM entity_aliases WHERE id='other'").run();
  assert.equal(readMediaBindings(db,id).length,1);
  db.exec('BEGIN');
  try {alias(db,'temporary','Temporary Hall',['湖广会馆']);assert.equal(readMediaBindings(db,id).length,0);}
  finally {db.exec('ROLLBACK');}
  assert.equal(readMediaBindings(db,id).length,1);
});
