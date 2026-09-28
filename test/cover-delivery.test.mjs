import test from 'node:test';
import assert from 'node:assert/strict';
import {repositoryFixture} from '../test-support/repository-fixture.mjs';
import {seedCoverFixture} from '../test-support/cover-fixture.mjs';
import {mediaHash} from '../src/web-media.mjs';
import {auditDraftCover} from '../src/services/cover-audit.mjs';
import {previewCoverSelection,saveCoverSelection} from '../src/services/cover-selection.mjs';
import {coverDeliveryPlan,coverDeliveryPlanHash,deliverSelectedCover} from '../src/services/cover-delivery.mjs';
import {buildPublishPackage} from '../src/publish-page.mjs';
import {VertexImagen} from '../src/visuals/vertex-imagen.mjs';

test('explicit selected cover overrides a populated featured ID; strict schemas keep optional card text internal; capacity never truncates',()=>{
  const draft={id:'d',revision:2,title:'Formal title',slug:'formal-title',card_title:'Card',deck:'Deck',seo:{meta_title:'SEO title'}};
  const page={metadata:{pageId:'d',title:draft.title,slug:draft.slug,featuredMediaId:10},blocks:[]};
  const contract={contractVersion:'fixture',checksum:'hash',pageSchema:{schema:{properties:{metadata:{properties:{title:{},slug:{},featuredMediaId:{}}}}}}};
  const input={pagePayload:page,draft,contract,media:[{id:20,url:'https://example.org/cover.webp',role:'featured'}],selectedCover:{draft_id:'d',draft_revision:2,media_id:20}};
  const result=buildPublishPackage(input);assert.equal(result.page.metadata.featuredMediaId,20);assert.equal(result.page.metadata.cardTitle,undefined);assert.equal(result.page.metadata.deck,undefined);
  assert.equal(result.page.metadata.title,draft.title);assert.equal(result.seo.meta_title,'SEO title');assert.equal(page.metadata.featuredMediaId,10);
  assert.throws(()=>buildPublishPackage({...input,selectedCover:{...input.selectedCover,draft_revision:1}}),{code:'COVER_DELIVERY_IDENTITY_MISMATCH'});
  assert.throws(()=>buildPublishPackage({...input,media:Array.from({length:201},(_,i)=>({id:i+1}))}),{code:'MEDIA_CONTRACT_CAPACITY_EXCEEDED'});
});

test('durable cover-only protocol reconciles lost results without upload replay or changing prior article receipts',async t=>{
  const f=repositoryFixture(t),seed=await seedCoverFixture(f.repository,f.directory),db=f.db;
  const registry={},page={properties:{metadata:{properties:{featuredMediaId:{type:'integer'}}}}},publish={},checksum=mediaHash(JSON.stringify([registry,page,publish]));
  db.prepare(`INSERT INTO frontend_contract_snapshots(id,source_repository,registry_source,page_schema_source,frontend_commit_sha,contract_version,schema_version,checksum,registry_json,page_schema_json,status,synced_at,publish_package_schema_json,artifact_checksum)
    VALUES ('fixed','fixture','fixture','fixture',?,'fixture','fixture',?,?,?,'active','now',?,?)`).run('a'.repeat(40),checksum,JSON.stringify(registry),JSON.stringify(page),JSON.stringify(publish),checksum);
  db.prepare("UPDATE frontend_contract_state SET active_snapshot_id='fixed'").run();
  db.prepare(`INSERT INTO wordpress_publications(id,draft_id,site_url,post_id,status,created_at,updated_at,response_json)
    VALUES ('wp',?,'https://receiver.invalid',123,'synced','now','now',?)`).run(seed.draftId,JSON.stringify({featured_media_id:5,page_payload_hash:'b'.repeat(64),modified_gmt:'2026-09-28T00:00:00'}));
  const audit=await auditDraftCover(db,seed.draftId),input={visual_id:seed.visualId,expected_revision:2,expected_fingerprint:audit.input_fingerprint,master_hash:seed.hash,
    safe_region:{x:.4,y:.4,width:.2,height:.2},focal_point:{x:.5,y:.5},locked:true};
  const preview=await previewCoverSelection(db,seed.draftId,input,{outputDir:f.directory});await saveCoverSelection(db,seed.draftId,{...input,confirmed:true,preview_hash:preview.derivative.sha256},{outputDir:f.directory});
  const plan=coverDeliveryPlan(db,seed.draftId),before=db.prepare('SELECT * FROM wordpress_publications').get();let writes=0,reconciles=0,receipt;
  const receiver={verifiedCapabilities:async()=>({cover_only:true,compare_and_swap:true,idempotency_reconciliation:true,contract_hash:checksum,contract_commit:'a'.repeat(40),site_url:plan.site_url}),
    replaceCover:async request=>{writes++;assert.equal(mediaHash(request.bytes),plan.upload_hash);receipt={idempotency_key:request.idempotency_key,post_id:123,cms_draft_id:seed.draftId,cms_revision:2,prior_page_hash:plan.prior_page_hash,
      protected_content_hash:plan.protected_content_hash,upload_hash:plan.upload_hash,attachment_id:99,featured_media_id:99,page_payload_hash:'c'.repeat(64),modified_gmt:'2026-09-28T01:00:00'};throw new Error('Simulated response loss');},
    reconcile:async()=>{reconciles++;return receipt;}};
  const options={receiver,expectedPlanHash:coverDeliveryPlanHash(plan),authorization:{mode:'release',scope:'cover_only'}};
  await assert.rejects(deliverSelectedCover(db,seed.draftId,{...options,authorization:{mode:'development'}}),{code:'COVER_DELIVERY_NOT_AUTHORIZED'});assert.equal(writes,0);
  await assert.rejects(deliverSelectedCover(db,seed.draftId,options),{code:'COVER_OUTCOME_UNKNOWN'});
  assert.equal((await deliverSelectedCover(db,seed.draftId,options)).state,'confirmed');assert.equal(writes,1);assert.equal(reconciles,1);
  assert.equal((await deliverSelectedCover(db,seed.draftId,options)).state,'confirmed');assert.equal(writes,1);
  assert.deepEqual(db.prepare('SELECT * FROM wordpress_publications').get(),before);
});

test('cover illustration maximum is cumulative and rejected before provider credentials or dispatch',async()=>{
  const visual={id:'cover',image_type:'illustration',acquisition_strategy:'generate_illustration',aspect_ratio:'16:9',generation_prompt:'Packing objects',
    media_metadata:{cover_generation:{abstract_topic:'packing',authorized:true,qa_feedback:'Keep subjects away from edge.'}}};
  const generator=new VertexImagen({enabled:true,provider:'vertex_gemini',projectId:'fixture',publicBaseUrl:'https://fixture.invalid',
    coverCandidateHistory:async()=>[{output_hash:'first',status:'qa_failed'},{output_hash:'second',status:'qa_failed'}]});
  await assert.rejects(generator.generate(visual,{}),{code:'COVER_CANDIDATE_LIMIT'});
});
