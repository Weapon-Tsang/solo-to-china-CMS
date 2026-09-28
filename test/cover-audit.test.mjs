import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {repositoryFixture} from '../test-support/repository-fixture.mjs';
import {planCoverCrop,evaluateCoverCandidate,selectCoverCandidate} from '../src/cover-policy.mjs';
import {auditDraftCover} from '../src/services/cover-audit.mjs';
import {mediaHash} from '../src/web-media.mjs';
import {normalizeXiaohongshuCapture} from '../src/adapters/xiaohongshu.mjs';
import os from 'node:os';
import {openDatabase} from '../src/db.mjs';
import {loadConfig} from '../src/config.mjs';
import {createApplication} from '../src/server.mjs';
import {inspectCoverContract} from '../src/cover-contract.mjs';

const geometry={safeRegion:{x:0.4,y:0.4,width:0.2,height:0.2},focalPoint:{x:0.5,y:0.5}};
const candidate=(overrides={})=>evaluateCoverCandidate({id:'photo',masterHash:'hash',qa:{status:'passed',file_hash:'hash'},
  width:1600,height:1000,geometry,relationshipVerified:true,
  analysis:{analysis_status:'ready',asset_kind:'documentary_photo',text_regions:[{role:'real_world_signage',text:'Long natural shop sign'}]},...overrides});

test('pinned contract integrity and strict fields never imply deployed receiver capabilities',()=>{
  const registry={contractVersion:'fixture'},page={properties:{metadata:{additionalProperties:false,properties:{featuredMediaId:{type:'integer'}}}}},publish={additionalProperties:false};
  const snapshot={frontend_commit_sha:'a'.repeat(40),contract_version:'fixture',registry_json:JSON.stringify(registry),
    page_schema_json:JSON.stringify(page),publish_package_schema_json:JSON.stringify(publish),artifact_checksum:mediaHash(JSON.stringify([registry,page,publish]))};
  const valid=inspectCoverContract(snapshot);assert.equal(valid.status,'pinned_cache_verified');
  assert.deepEqual(valid.fields,{featuredMediaId:true,cardTitle:false,deck:false});assert.equal(valid.delivery_enabled,false);
  assert.equal(inspectCoverContract({...snapshot,frontend_commit_sha:'main'}).status,'unverified_cache');
  assert.equal(inspectCoverContract({...snapshot,page_schema_json:'{}'}).integrity,false);
  assert.equal(inspectCoverContract({...snapshot,page_schema_json:'broken'}).status,'invalid_cache');
  assert.equal(inspectCoverContract(null).status,'missing');
});

test('cover plan preserves natural signs but rejects dense cards, screenshots, wrong entity and stale QA',()=>{
  assert.equal(candidate().eligible,true);
  for(const kind of ['handwritten_card','editorial_infographic','map_or_route','photo_collage','unknown']) {
    const result=candidate({analysis:{analysis_status:'ready',asset_kind:kind}});
    assert.equal(result.eligible,false);
  }
  assert.ok(candidate({analysis:{analysis_status:'ready',asset_kind:'documentary_photo',editor_ui_regions:[{}]}})
    .reasons.includes('COVER_INTERFACE_SCREENSHOT'));
  assert.ok(candidate({relationshipVerified:false}).reasons.includes('COVER_ENTITY_RELATION_UNCONFIRMED'));
  assert.ok(candidate({qa:{status:'passed',file_hash:'old'}}).reasons.includes('COVER_MASTER_QA_REQUIRED'));
  assert.equal(candidate({geometry:{}}).eligible,false);
  for(const qa of [null,undefined,false,0,'passed',[],{}]) {
    const result=candidate({qa});
    assert.equal(result.eligible,false);
    assert.ok(result.reasons.includes('COVER_MASTER_QA_REQUIRED'));
  }
});

test('cover locks never silently switch to another candidate and relevance is required before ordering',()=>{
  const current=candidate(),stored=candidate({id:'stored',origin:'stored'});
  assert.equal(selectCoverCandidate([stored,current]).selected,'photo');
  assert.equal(selectCoverCandidate([current,{...stored,locked:true}]).selected,'stored');
  assert.equal(selectCoverCandidate([current,{...stored,locked:true,eligible:false}]).reason,'COVER_LOCK_REQUIRES_ATTENTION');
  assert.equal(selectCoverCandidate([{...current,locked:true},{...stored,locked:true}]).reason,'COVER_MULTIPLE_LOCKS');
  assert.equal(selectCoverCandidate([candidate({relationshipVerified:false})]).selected,null);
});

test('16:9 plan is exact, bounded, EXIF-coordinate based and never enlarges a small source',()=>{
  for(const [width,height] of [[1600,1000],[1000,1600],[1200,675],[768,432],[300,300],[101,103]]) {
    const plan=planCoverCrop({width,height,...geometry,qualityConfirmed:true});
    assert.equal(plan.status,'planned');assert.equal(plan.crop.width*9,plan.crop.height*16);
    assert.equal(plan.width*9,plan.height*16);assert.ok(plan.width<=width && plan.height<=height);
    assert.ok(plan.crop.left+plan.crop.width<=width && plan.crop.top+plan.crop.height<=height);
  }
  assert.equal(planCoverCrop({width:600,height:800,...geometry}).reason,'COVER_SMALL_IMAGE_CONFIRMATION_REQUIRED');
  assert.equal(planCoverCrop({width:800,height:1600,...geometry,safeRegion:{x:0,y:0,width:1,height:1}}).reason,'COVER_SUBJECT_WOULD_BE_CROPPED');
  assert.equal(planCoverCrop({width:1200,height:800,...geometry,focalPoint:{x:2,y:0.5}}).reason,'COVER_SUBJECT_CONFIRMATION_REQUIRED');
});

test('real SQLite dry-run preserves draft, media, publication, jobs and calls; unavailable historical masters remain rejected',async t=>{
  const {db,directory,repository}=repositoryFixture(t);
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at)
    VALUES ('b','beijing','Guide','travelers','info','ready','now','now')`).run();
  db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at,revision,content_hash)
    VALUES ('d','b','Original title','old-slug','Preserve this body','{}','review','now','now',2,'bodyhash')`).run();
  const bytes=await sharp({create:{width:1200,height:675,channels:3,background:'blue'}}).png().toBuffer();
  const file=path.join(directory,'master.png');fs.writeFileSync(file,bytes);
  db.prepare(`INSERT INTO article_visuals(id,draft_id,slot,placement,purpose,alt_text,generation_prompt,aspect_ratio,status,
    created_at,updated_at,media_path,media_metadata_json) VALUES ('v','d',1,'hero','Guide','Guide','','16:9','generated','now','now',?,?)`)
    .run(file,JSON.stringify({quality_qa:{status:'passed',file_hash:mediaHash(bytes)},cover_geometry:{...geometry,master_hash:mediaHash(bytes)}}));
  const changes=()=>db.prepare('SELECT total_changes() n').get().n;
  const before=changes(),draft=db.prepare("SELECT * FROM article_drafts WHERE id='d'").get();
  const report=await auditDraftCover(db,'d',{expectedRevision:2});
  assert.equal(report.execution_enabled,false);assert.equal(report.selection.selected,null);
  assert.ok(report.candidates[0].reasons.includes('COVER_ENTITY_RELATION_UNCONFIRMED'));
  assert.equal(changes(),before);assert.deepEqual(db.prepare("SELECT * FROM article_drafts WHERE id='d'").get(),draft);
  assert.equal(mediaHash(fs.readFileSync(file)),mediaHash(bytes));
  await assert.rejects(auditDraftCover(db,'d',{expectedRevision:1}),{code:'COVER_REVISION_CONFLICT'});
  fs.unlinkSync(file);
  const missing=await auditDraftCover(db,'d');
  assert.ok(missing.candidates[0].reasons.includes('COVER_MASTER_UNAVAILABLE_OR_INVALID'));
  assert.equal(changes(),before);

  fs.writeFileSync(file,bytes);
  db.prepare(`INSERT INTO entity_aliases(id,destination_slug,alias_normalized,entity_key,canonical_subject,aliases_json,
    resolution_source,confidence,created_at,updated_at,entity_type,granularity)
    VALUES ('hall','beijing','east hall','hall','East Hall','[]','manual',1,'now','now','attraction','specific_entity')`).run();
  const source=repository.saveCapture(normalizeXiaohongshuCapture({url:'https://www.xiaohongshu.com/explore/cover-audit',
    title:'Cover audit source',text:'Photo 1 depicts East Hall.',images:[{url:'https://sns-img.xhscdn.com/cover.jpg',alt:'Hall'}]}));
  const asset=db.prepare('SELECT id FROM source_assets WHERE source_id=?').get(source.id);
  db.prepare(`UPDATE source_assets SET local_path=?,storage_status='saved',original_bytes_status='saved_original',
    durability_status='ORIGINAL_STORED',original_sha256=?,stored_sha256=? WHERE id=?`).run(file,mediaHash(bytes),mediaHash(bytes),asset.id);
  repository.saveSourceAssetAnalysis(asset.id,{analysis_status:'ready',asset_kind:'documentary_photo',
    text_regions:[],photo_regions:[],entities:[],reader_text_present:false,primary_subjects:['Hall'],confidence:0.9,analysis_version:'media-analysis-2'});
  repository.refreshSourceMediaBindings(source.id,{dryRun:false});
  db.prepare("UPDATE article_visuals SET source_asset_id=?,image_subject='East Hall',purpose='East Hall scene' WHERE id='v'").run(asset.id);
  const qualifiedBefore=changes();
  const qualified=await auditDraftCover(db,'d');
  assert.equal(qualified.selection.selected,'v');assert.equal(qualified.candidates[0].eligible,true);
  assert.equal(changes(),qualifiedBefore,'reading current bindings must not persist repairs');
  db.prepare("UPDATE sources SET raw_text='Photo 1 is not East Hall.' WHERE id=?").run(source.id);
  const revoked=await auditDraftCover(db,'d');
  assert.equal(revoked.selection.selected,null,'stale source bindings cannot retain cover eligibility');
});

test('actual authenticated HTTP cover audit is read-only and rejects stale revisions',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cms-cover-api-'));
  const databasePath=path.join(directory,'test.sqlite');openDatabase(databasePath).close();
  const app=createApplication(loadConfig({HOST:'127.0.0.1',PORT:'0',DATABASE_PATH:databasePath,CMS_DATA_ROOT:directory,
    CMS_PROCESS_ROLE:'api',ADMIN_TOKEN:'cover-fixture-only',MAINTENANCE_ENABLED:'false',LOG_LEVEL:'error'}));
  t.after(async()=>{await app.stop();fs.rmSync(directory,{recursive:true,force:true});});
  const db=app.repository.db;
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at)
    VALUES ('b','beijing','Guide','travelers','info','ready','now','now')`).run();
  db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at,revision)
    VALUES ('d','b','Title','slug','Body','{}','review','now','now',2)`).run();
  await app.start();
  db.prepare(`INSERT INTO article_visuals(id,draft_id,slot,placement,purpose,alt_text,generation_prompt,aspect_ratio,status,
    created_at,updated_at,media_metadata_json) VALUES ('pending-route','d',1,'body','Day 2','Day 2','','16:9','planned','now','now',?)`)
    .run(JSON.stringify({quality_qa:null,route_contract:{use:'day_route_diagram'}}));
  const url=`http://127.0.0.1:${app.server.address().port}/api/drafts/d/cover-audit`;
  assert.equal((await fetch(url)).status,401);
  const headers={authorization:'Bearer cover-fixture-only'};
  assert.equal((await fetch(`${url}?revision=1`,{headers})).status,409);
  assert.equal((await fetch(`${url}?revision=NaN`,{headers})).status,409);
  const before=db.prepare('SELECT total_changes() n').get().n;
  const response=await fetch(`${url}?revision=2`,{headers});assert.equal(response.status,200);
  const body=await response.json();assert.equal(body.execution_enabled,false);assert.equal(body.dry_run,true);
  assert.equal(body.candidates.length,1);
  assert.equal(body.candidates[0].eligible,false);
  assert.ok(body.candidates[0].reasons.includes('COVER_MASTER_QA_REQUIRED'));
  assert.equal(db.prepare('SELECT total_changes() n').get().n,before);
  assert.equal(db.prepare('SELECT count(*) n FROM model_call_metrics').get().n,0);
});
