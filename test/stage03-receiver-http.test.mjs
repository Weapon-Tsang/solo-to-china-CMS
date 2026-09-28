import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { repositoryFixture } from '../test-support/repository-fixture.mjs';
import { seedCoverFixture } from '../test-support/cover-fixture.mjs';
import { ArticleMediaService } from '../src/services/article-media.mjs';
import { articleMediaDeliveryPlan, deliverArticleMedia } from '../src/services/article-media-delivery.mjs';
import { mediaHash } from '../src/web-media.mjs';
import { closeLocalPhotoAudit } from '../src/local-photo-audit.mjs';
import { validateRenderedHtmlArtifact } from '../src/final-html-validator.mjs';

import {receiverFixture} from '../test-support/stage03-media-receiver.mjs';

for(const behavior of ['success','lost','partial'])test(`T03-23/24/32 local HTTP body receiver: ${behavior}, actual bytes and rendered HTML`,async t=>{
  t.after(closeLocalPhotoAudit);
  const f=repositoryFixture(t),seed=await seedCoverFixture(f.repository,f.directory),db=f.db;
  const config={mediaDir:path.join(f.directory,'media'),captureMediaUploads:{uploadDir:path.join(f.directory,'uploads'),storageDir:path.join(f.directory,'originals')}};
  const service=new ArticleMediaService(f.repository,config);
  const created=await service.create(seed.draftId,{expected_revision:2,name:'hall.png',size:seed.bytes.length,mimeType:'image/png',sha256:seed.hash},'editor');
  await service.chunk(seed.draftId,created.id,0,seed.bytes,'editor',seed.hash);await service.complete(seed.draftId,created.id,'editor');
  const input={expected_revision:2,expected_media_revision:0,selections:[{upload_id:created.id,slot_id:seed.visualId,purpose:'body',kind:'photo',caption:'East Hall.',description:'Synthetic confirmed article photo.',factual_photo:true,no_reader_text:true,quality_confirmed:true}]};
  const plan=service.plan(seed.draftId,input,'editor');
  assert.equal((await service.confirm(seed.draftId,{...input,confirmed:true,plan_hash:plan.plan_hash,idempotency_key:`stage03_http_${behavior}_001`},'editor')).state,'local_ready');
  const registry={},schema={properties:{metadata:{properties:{featuredMediaId:{}}}}},publish={},checksum=mediaHash(JSON.stringify([registry,schema,publish]));
  db.prepare(`INSERT INTO frontend_contract_snapshots(id,source_repository,registry_source,page_schema_source,frontend_commit_sha,contract_version,schema_version,checksum,registry_json,page_schema_json,status,synced_at,publish_package_schema_json,artifact_checksum)
    VALUES ('fixed','fixture','fixture','fixture',?,'fixture','fixture',?,?,?,'active','now',?,?)`).run('a'.repeat(40),checksum,JSON.stringify(registry),JSON.stringify(schema),JSON.stringify(publish),checksum);
  db.prepare("UPDATE frontend_contract_state SET active_snapshot_id='fixed'").run();
  db.prepare(`INSERT INTO wordpress_publications(id,draft_id,site_url,post_id,status,created_at,updated_at,response_json)
    VALUES ('wp',?,'https://receiver.invalid',123,'synced','now','now',?)`).run(seed.draftId,JSON.stringify({status:'draft',page_payload_hash:'b'.repeat(64),modified_gmt:'2026-09-28T00:00:00'}));
  const before=db.prepare('SELECT * FROM article_drafts WHERE id=?').get(seed.draftId),prior=db.prepare('SELECT * FROM wordpress_publications').get();
  const remote=await receiverFixture(t,{title:before.title,body:before.body_markdown,page_hash:'b'.repeat(64),modified:'2026-09-28T00:00:00'},checksum,behavior);
  const delivery=articleMediaDeliveryPlan(db,seed.draftId);
  const options={receiver:remote.receiver,authorization:{mode:'release',scope:'body_media_only'},expectedPlanHash:delivery.plan_hash,outputDir:config.mediaDir};
  await assert.rejects(deliverArticleMedia(db,seed.draftId,{...options,authorization:{mode:'development'}}),{code:'MEDIA_DELIVERY_NOT_AUTHORIZED'});
  assert.equal(remote.state.uploads,0);
  if(behavior==='lost')await assert.rejects(deliverArticleMedia(db,seed.draftId,options),{code:'MEDIA_DELIVERY_OUTCOME_UNKNOWN'});
  const result=await deliverArticleMedia(db,seed.draftId,options);
  assert.equal(result.state,behavior==='partial'?'needs_review':'confirmed');
  if(behavior==='partial')assert.equal(db.prepare('SELECT wordpress_media_id FROM article_visuals WHERE id=?').get(seed.visualId).wordpress_media_id,null);
  else {
    const html=await(await fetch(remote.root+'/page')).text();
    const checked=validateRenderedHtmlArtifact({html,status:'preview',url:'https://receiver.invalid/?p=123&preview=true',httpStatus:200,expectedTitle:before.title,expectedFacts:[before.body_markdown],expectedMediaIds:[901],evidenceSource:'local_http_fixture'});
    assert.equal(checked.valid,true,JSON.stringify(checked.errors));
    await deliverArticleMedia(db,seed.draftId,options);
    assert.equal(service.list(seed.draftId,'editor').items[0].delivery_confirmed,true);
    const revision=service.list(seed.draftId,'editor').recovery;
    await service.resume(seed.draftId,revision.id,'editor');
    assert.equal(service.list(seed.draftId,'editor').recovery.receipt.delivery,'confirmed','local resume must retain the saved remote outcome');
  }
  assert.equal(remote.state.uploads,1);assert.equal(remote.state.writes,1);
  assert.equal(remote.state.body,before.body_markdown);
  assert.deepEqual(db.prepare('SELECT * FROM article_drafts WHERE id=?').get(seed.draftId),before);
  assert.deepEqual(db.prepare('SELECT * FROM wordpress_publications').get(),prior);
  assert.equal(db.prepare('SELECT count(*) n FROM model_call_metrics').get().n,0);
  console.log(JSON.stringify({behavior,scope:'CMS loopback receiver; not WordPress',uploads:remote.state.uploads,writes:remote.state.writes,reconciles:remote.state.reconciles,body_hash:mediaHash(before.body_markdown),provider_calls:0}));
});
