import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import {Pipeline} from '../src/pipeline.mjs';
import { repositoryFixture } from '../test-support/repository-fixture.mjs';
import {png} from '../test-support/media-fixtures.mjs';

test('an article may checkpoint analysis for its frozen historical source asset', (t) => {
  const {db,repository}=repositoryFixture(t);
  db.prepare(`INSERT INTO sources(id,adapter,canonical_url,captured_at,raw_text,raw_html,
    raw_payload_json,content_hash,capture_version,created_at,updated_at)
    VALUES ('source','manual','https://example.test/source','now','text','html','{}','hash',3,'now','now')`).run();
  db.prepare(`INSERT INTO source_assets(id,source_id,kind,remote_url,position,local_path,
    capture_version,original_bytes_status,durability_status,original_sha256)
    VALUES ('old-asset','source','image','https://example.test/old.png',0,'/stored/old.png',
    2,'saved_original','ORIGINAL_STORED',?)`).run('a'.repeat(64));
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at)
    VALUES ('brief','chongqing','Guide','travelers','informational','ready','now','now')`).run();
  db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,
    status,created_at,updated_at,revision,content_hash)
    VALUES ('draft','brief','Guide','guide','Body','{}','needs_review','now','now',1,'hash')`).run();
  db.prepare(`INSERT INTO article_visuals(id,draft_id,slot,placement,purpose,alt_text,generation_prompt,
    aspect_ratio,status,created_at,updated_at,asset_fingerprint,image_type,image_role,
    acquisition_strategy,factual_image_required,source_asset_id,media_metadata_json)
    VALUES ('visual','draft',1,'hero','Guide image','Guide image','','16:9','planned','now','now',
    'plan-hash','infographic','hero','analyze_source_image',1,'old-asset','{}')`).run();
  const analysis={analysis_status:'ready',asset_kind:'editorial_infographic',reader_text_present:true,
    text_regions:[{region_id:'title',text:'重庆',role:'author_overlay',language:'zh',readable:true,preserve:false}],
    analysis_version:'media-analysis-2'};
  assert.equal(repository.saveSourceAssetAnalysis('old-asset',analysis),false,
    'ordinary current-capture source processing must not write historical analysis');
  assert.equal(repository.saveSourceAssetAnalysis('old-asset',analysis,{forVisualId:'visual'}),true);
  assert.equal(db.prepare("SELECT capture_version,analysis_status FROM source_asset_analyses WHERE asset_id='old-asset'")
    .get().capture_version,2);
  db.prepare("UPDATE article_visuals SET status='failed' WHERE id='visual'").run();
  assert.equal(repository.saveSourceAssetAnalysis('old-asset',analysis,{forVisualId:'visual'}),false,
    'a failed visual cannot buy or accept a new historical analysis checkpoint');
  db.prepare("UPDATE article_visuals SET status='generated' WHERE id='visual'").run();
  assert.deepEqual(repository.sourceVisualReanalysisCandidates('draft').map((row)=>({...row})),[
    {visual_id:'visual',source_asset_id:'old-asset'}
  ],'a legacy card attached to a historical article requires pixel re-analysis');
  assert.equal(repository.saveSourceAssetAnalysis('old-asset',{
    ...analysis,prompt_version:'media-analysis-prompt-3',primary_subjects:['Chongqing travel advisory card']
  },{forDraftId:'draft',forVisualId:'visual'}),true);
  assert.deepEqual(repository.sourceVisualReanalysisCandidates('draft'),[],
    'the verified analysis is durable and is not charged again');
});

test('an empty historical article plan discovers a frozen original once and uses only its pixel subject', async (t) => {
  const {db,repository,directory}=repositoryFixture(t);
  const file=path.join(directory,'original.png');
  fs.writeFileSync(file,png);
  const sha=createHash('sha256').update(png).digest('hex');
  db.prepare(`INSERT INTO sources(id,adapter,canonical_url,captured_at,raw_text,raw_html,
    raw_payload_json,content_hash,capture_version,created_at,updated_at)
    VALUES ('source','manual','https://example.test/source','now','text','html','{}','hash',2,'now','now')`).run();
  db.prepare(`INSERT INTO source_assets(id,source_id,kind,remote_url,position,local_path,mime_type,
    capture_version,storage_status,original_bytes_status,durability_status,original_sha256,width,height)
    VALUES ('frozen-photo','source','image','https://example.test/photo.png',0,?,'image/png',
    1,'saved','saved_original','ORIGINAL_STORED',?,1200,800)`).run(file,sha);
  db.prepare(`INSERT INTO topic_candidates(id,destination_slug,topic_key,proposed_title,rationale,
    coverage_score,evidence_count,conflict_count,created_at,updated_at)
    VALUES ('candidate','chongqing','ciqikou-food','Ciqikou Street Food Guide','fixture',
    1,1,0,'now','now')`).run();
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at,
    strategy_version,candidate_id) VALUES ('brief','chongqing','Ciqikou Street Food Guide','travelers','informational',
    'ready','now','now','3.8','candidate')`).run();
  db.prepare(`INSERT INTO narrative_plans(id,brief_id,created_at,updated_at)
    VALUES ('narrative','brief','now','now')`).run();
  db.prepare(`INSERT INTO writing_packets(id,brief_id,narrative_plan_id,packet_text,evidence_ledger_json,
    selected_fact_keys_json,selected_experience_block_ids_json,input_hash,created_at,updated_at,context_json)
    VALUES ('packet','brief','narrative','','[]','[]','[]','hash','now','now',?)`).run(JSON.stringify({version:2,
      authorized_source_assets:[{id:'frozen-photo'}],content_policy:{visuals:{minimum:0,target:1,maximum:3}}}));
  db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,
    status,created_at,updated_at,revision,content_hash,strategy_version)
    VALUES ('draft','brief','Ciqikou Street Food Guide','ciqikou-food',
    'Ciqikou street food market offers local snacks.','{}','needs_review','now','now',1,'hash','3.8')`).run();
  assert.deepEqual(repository.listDraftVisuals('draft'),[]);
  assert.deepEqual(repository.sourceVisualDiscoveryCandidates('draft'),['frozen-photo']);
  const draftPackage=repository.getDraftPackage('draft');
  assert.ok(draftPackage);
  db.prepare(`INSERT INTO quality_reviews(id,draft_id,passed,score,checks_json,issues_json,
    unsupported_claims_json,reviewer,strategy_version,created_at,draft_revision,draft_content_hash,evidence_hash)
    VALUES ('review','draft',1,100,'{}','[]','[]','fixture','3.8','now',1,'hash',?)`)
    .run(draftPackage.evidence_hash);
  const refresh=repository.planArticlePhotoRefresh(['draft']);
  assert.equal(refresh.items[0].disposition,'eligible');
  assert.equal(refresh.items[0].reason,'source_original_discovery');
  assert.deepEqual(refresh.items[0].discovery_candidate_ids,['frozen-photo']);
  let analyses=0;
  const reviewer={async analyzeMediaAsset(asset){analyses++;return {method:'fixture',model:'fixture',result:{
    analysis_status:'ready',asset_kind:'documentary_photo',reader_text_present:false,
    primary_subjects:['Ciqikou street food market'],photo_regions:[],text_regions:[],entities:[],
    editor_ui_regions:[],language_by_region:[],confidence:.95,analysis_version:'media-analysis-2',
    prompt_version:'media-analysis-prompt-2',source_sha256:asset.original_sha256}};}};
  const pipeline=new Pipeline(repository,{config:{}},{visualReviewer:reviewer,visuals:{enabled:true}});
  const jobId=repository.enqueue('generate_visuals','draft');
  assert.equal(await pipeline.runOne(),true,JSON.stringify({job:db.prepare('SELECT status,last_error FROM jobs WHERE id=?').get(jobId),
    analysis:db.prepare('SELECT analysis_status,asset_kind,primary_subjects_json FROM source_asset_analyses WHERE asset_id=?').get('frozen-photo'),
    visuals:repository.listDraftVisuals('draft')}));
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(jobId).status,'succeeded');
  const visuals=repository.listDraftVisuals('draft');
  assert.equal(visuals.length,1);
  assert.equal(visuals[0].source_asset_id,'frozen-photo');
  assert.equal(visuals[0].caption,'Ciqikou street food market');
  assert.equal(visuals[0].status,'generated');
  assert.equal(analyses,1);
  assert.deepEqual(repository.sourceVisualDiscoveryCandidates('draft'),[],
    'the durable pixel analysis is not repurchased by a later retry');
  db.prepare(`INSERT INTO topic_candidates(id,destination_slug,topic_key,proposed_title,rationale,
    coverage_score,evidence_count,conflict_count,created_at,updated_at)
    VALUES ('other-candidate','hong-kong','hong-kong-towers','Hong Kong Street Towers','fixture',
    1,1,0,'now','now')`).run();
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at,
    strategy_version,candidate_id) VALUES ('other-brief','hong-kong','Hong Kong Street Towers','travelers','informational',
    'ready','now','now','3.8','other-candidate')`).run();
  db.prepare(`INSERT INTO narrative_plans(id,brief_id,created_at,updated_at)
    VALUES ('other-narrative','other-brief','now','now')`).run();
  db.prepare(`INSERT INTO writing_packets(id,brief_id,narrative_plan_id,packet_text,evidence_ledger_json,
    selected_fact_keys_json,selected_experience_block_ids_json,input_hash,created_at,updated_at,context_json)
    VALUES ('other-packet','other-brief','other-narrative','','[]','[]','[]','hash','now','now',?)`)
    .run(JSON.stringify({version:2,authorized_source_assets:[{id:'frozen-photo'}],
      content_policy:{visuals:{minimum:0,target:1,maximum:3}}}));
  db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,
    status,created_at,updated_at,revision,content_hash,strategy_version)
    VALUES ('other-draft','other-brief','Hong Kong Street Towers','hong-kong-towers',
    'Walk below Hong Kong street towers.','{}','needs_review','now','now',1,'other-hash','3.8')`).run();
  const unrelatedJob=repository.enqueue('generate_visuals','other-draft');
  assert.equal(await pipeline.runOne(),false);
  const unrelated=db.prepare('SELECT status,last_error FROM jobs WHERE id=?').get(unrelatedJob);
  assert.equal(unrelated.status,'failed');
  assert.match(unrelated.last_error,/No pixel-verified relevant source image/);
  assert.deepEqual(repository.listDraftVisuals('other-draft'),[]);
  assert.equal(analyses,1,'an unrelated article must not buy the same analysis again');
  const newIds=[];
  for (let index=0;index<4;index++) {
    const id=`uninspected-${index}`;
    const bytes=await sharp({create:{width:1,height:1,channels:3,
      background:{r:index*40+10,g:20,b:30}}}).png().toBuffer();
    const filename=path.join(directory,`${id}.png`);
    fs.writeFileSync(filename,bytes);
    db.prepare(`INSERT INTO source_assets(id,source_id,kind,remote_url,position,local_path,mime_type,
      capture_version,storage_status,original_bytes_status,durability_status,original_sha256,width,height)
      VALUES (?,'source','image',?,?,?,'image/png',1,'saved','saved_original','ORIGINAL_STORED',?,1200,800)`)
      .run(id,`https://example.test/${id}.png`,index+1,filename,createHash('sha256').update(bytes).digest('hex'));
    newIds.push(id);
  }
  db.prepare('UPDATE writing_packets SET context_json=? WHERE id=?').run(JSON.stringify({version:2,
    authorized_source_assets:[{id:'frozen-photo'},...newIds.map(id=>({id}))],
    content_policy:{visuals:{minimum:0,target:1,maximum:3}}}),'other-packet');
  assert.equal(repository.sourceVisualDiscoveryCandidates('other-draft').length,3);
  const budgetJob=repository.enqueue('generate_visuals','other-draft',{dedupeKey:'bounded-discovery'});
  assert.equal(await pipeline.runOne(),false);
  assert.equal(db.prepare('SELECT last_failure_code FROM jobs WHERE id=?').get(budgetJob).last_failure_code,
    'MEDIA_DISCOVERY_BUDGET_EXHAUSTED');
  assert.equal(analyses,4,'one earlier analysis and only three new calls are permitted in this run');
  assert.equal(repository.sourceVisualDiscoveryCandidates('other-draft').length,1);
  const extraId='uninspected-after-rate-wait';
  const extraBytes=await sharp({create:{width:1,height:1,channels:3,
    background:{r:222,g:33,b:44}}}).png().toBuffer();
  const extraPath=path.join(directory,`${extraId}.png`);
  fs.writeFileSync(extraPath,extraBytes);
  db.prepare(`INSERT INTO source_assets(id,source_id,kind,remote_url,position,local_path,mime_type,
    capture_version,storage_status,original_bytes_status,durability_status,original_sha256,width,height)
    VALUES (?,'source','image',?,?,?,'image/png',1,'saved','saved_original','ORIGINAL_STORED',?,1200,800)`)
    .run(extraId,`https://example.test/${extraId}.png`,9,extraPath,
      createHash('sha256').update(extraBytes).digest('hex'));
  db.prepare('UPDATE writing_packets SET context_json=? WHERE id=?').run(JSON.stringify({version:2,
    authorized_source_assets:[{id:'frozen-photo'},...newIds.map(id=>({id})),{id:extraId}],
    content_policy:{visuals:{minimum:0,target:1,maximum:3}}}),'other-packet');
  const resumedJob=repository.enqueue('generate_visuals','other-draft',{dedupeKey:'resumed-bounded-discovery'});
  for (const id of newIds.slice(0,2)) repository.recordModelCall({stage:'source_asset_media_analysis',
    provider:'vertex',model:'test',runId:resumedJob,entityId:id,requestKind:'provider',status:'succeeded'});
  assert.equal(repository.sourceMediaAnalysisProviderCalls(resumedJob),2);
  assert.equal(repository.sourceVisualDiscoveryCandidates('other-draft').length,2);
  assert.equal(await pipeline.runOne(),false);
  assert.equal(db.prepare('SELECT last_failure_code FROM jobs WHERE id=?').get(resumedJob).last_failure_code,
    'MEDIA_DISCOVERY_BUDGET_EXHAUSTED');
  assert.equal(analyses,5,'a resumed Job may inspect only the one remaining budgeted source');
  assert.equal(repository.sourceVisualDiscoveryCandidates('other-draft').length,1);
});
