import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {openDatabase} from '../src/db.mjs';
import {loadConfig} from '../src/config.mjs';
import {createApplication} from '../src/server.mjs';
import {seedCoverFixture} from '../test-support/cover-fixture.mjs';
import {receiverFixture} from '../test-support/stage03-media-receiver.mjs';
import {freezeRequiredMediaManifest} from '../src/publication-eligibility.mjs';
import {articleMediaDeliveryPlan,deliverArticleMedia} from '../src/services/article-media-delivery.mjs';
import {mediaHash} from '../src/web-media.mjs';
import {validateRenderedHtmlArtifact} from '../src/final-html-validator.mjs';
import {readCoverSelection} from '../src/services/cover-selection.mjs';
import {coverDeliveryPlan,coverDeliveryPlanHash,deliverSelectedCover} from '../src/services/cover-delivery.mjs';

// Explicitly isolated test driver. No credentials or real receiver adapter.
// Browser actions use normal CMS endpoints; only the missing remote boundary
// is supplied by the loopback receiver and this deterministic outbox consumer.
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cms-phase03-delivery-'));
const databasePath=path.join(directory,'test.sqlite');openDatabase(databasePath).close();
const config=loadConfig({HOST:'127.0.0.1',PORT:'0',DATABASE_PATH:databasePath,CMS_DATA_ROOT:directory,
  GENERATED_MEDIA_DIR:path.join(directory,'media'),SOURCE_UPLOADS_DIR:path.join(directory,'sources'),
  CAPTURE_MEDIA_UPLOADS_DIR:path.join(directory,'uploads'),CAPTURE_UPLOADS_DIR:path.join(directory,'capture'),
  CMS_PROCESS_ROLE:'api',MAINTENANCE_ENABLED:'false',LOG_LEVEL:'error',ADMIN_USERNAME:'stage03',
  ADMIN_PASSWORD:'stage03-fixture-only',ADMIN_TOKEN:'stage03-local-only',SESSION_SECRET:'stage03-local-session'});
const app=createApplication(config),db=app.repository.db;
const mediaDir=path.join(directory,'media');
const seed=await seedCoverFixture(app.repository,mediaDir);
const coverOnly=process.argv.includes('--cover-only');
const withExistingCover=process.argv.includes('--with-existing-cover');
if(coverOnly)db.prepare("UPDATE article_visuals SET media_metadata_json=json_set(media_metadata_json,'$.media_purpose','cover') WHERE id=?").run(seed.visualId);
freezeRequiredMediaManifest(db,seed.draftId,{approvedNoImage:coverOnly});
db.prepare("UPDATE article_visuals SET status='failed',media_url=NULL,last_error='Synthetic required slot missing' WHERE id=?").run(seed.visualId);
const pinned=JSON.parse(fs.readFileSync(new URL('../test-support/fixtures/stage03-pinned-contract.json',import.meta.url)));
const [registry,pageSchema,publishPackageSchema]=[pinned.registry_json,pinned.page_schema_json,pinned.publish_package_schema_json].map(JSON.parse);
assert.equal(mediaHash(JSON.stringify([registry,pageSchema,publishPackageSchema])),pinned.artifact_checksum);
app.repository.saveFrontendContractSnapshot({sourceRepository:'Weapon-Tsang/solo-to-china',registrySource:'pinned-cache',pageSchemaSource:'pinned-cache',
  frontendCommitSha:pinned.frontend_commit_sha,contractVersion:pinned.contract_version,schemaVersion:pinned.schema_version,
  checksum:pinned.checksum,artifactChecksum:pinned.artifact_checksum,registry,pageSchema,publishPackageSchema,
  publishPackageVersion:pinned.publish_package_version,activate:true});
const before=db.prepare('SELECT * FROM article_drafts WHERE id=?').get(seed.draftId);
const cleanup=[];
const remote=await receiverFixture({after:fn=>cleanup.push(fn)},
  {title:before.title,body:before.body_markdown,page_hash:'b'.repeat(64),modified:'2026-09-28T00:00:00',contractCommit:pinned.frontend_commit_sha},pinned.artifact_checksum,'success');
assert.match(remote.root,/^http:\/\/127\.0\.0\.1:\d+$/);
let baseline={status:'draft',page_payload_hash:'b'.repeat(64),modified_gmt:'2026-09-28T00:00:00'};
if(withExistingCover) {
  const bytes=await sharp(seed.bytes).resize(1200,675).webp().toBuffer();
  const receipt=await remote.receiver.replaceCover({idempotency_key:'fixture-existing-cover',content_type:'image/webp',bytes,
    plan:{scope:'cover_only',post_id:123,draft_id:seed.draftId,draft_revision:2,prior_page_hash:baseline.page_payload_hash,
      prior_modified_gmt:baseline.modified_gmt,protected_content_hash:mediaHash(before.body_markdown),upload_hash:mediaHash(bytes)}});
  baseline={...baseline,page_payload_hash:receipt.page_payload_hash,modified_gmt:receipt.modified_gmt,featured_media_id:receipt.featured_media_id};
}
db.prepare(`INSERT INTO wordpress_publications(id,draft_id,site_url,post_id,status,created_at,updated_at,response_json)
  VALUES ('wp',?,'https://receiver.invalid',123,'synced','now','now',?)`).run(seed.draftId,
  JSON.stringify(baseline));
const publication=db.prepare('SELECT * FROM wordpress_publications').get();
fs.mkdirSync('output/playwright',{recursive:true});fs.copyFileSync(seed.master,'output/playwright/phase03-delivery-photo.png');
await app.start();
let busy=false,done=false,stopped=false;
const stopFile=path.join(directory,'STOP'),resultFile=path.join(directory,'result.json');
async function consume(){
  if(busy||done)return;busy=true;
  try {
    const row=coverOnly?readCoverSelection(db,seed.draftId):db.prepare("SELECT * FROM article_media_revisions WHERE state='local_ready' ORDER BY media_revision DESC LIMIT 1").get();
    if(!row)return;
    const plan=coverOnly?coverDeliveryPlan(db,seed.draftId):articleMediaDeliveryPlan(db,seed.draftId);
    if(!coverOnly)assert.equal(plan.ready,true,JSON.stringify(plan));
    const deliver=coverOnly?deliverSelectedCover:deliverArticleMedia;
    const options={receiver:remote.receiver,expectedPlanHash:coverOnly?coverDeliveryPlanHash(plan):plan.plan_hash,outputDir:mediaDir,
      authorization:{mode:'release',scope:coverOnly?'cover_only':'body_media_only'}};
    await assert.rejects(deliver(db,seed.draftId,{...options,authorization:{mode:'development'}}),{code:coverOnly?'COVER_DELIVERY_NOT_AUTHORIZED':'MEDIA_DELIVERY_NOT_AUTHORIZED'});
    assert.equal(remote.state.uploads,withExistingCover?1:0);
    const delivered=await deliver(db,seed.draftId,options);
    assert.equal(delivered.state,'confirmed');
    await deliver(db,seed.draftId,options);
    const html=await(await fetch(remote.root+'/page')).text();
    const inspection=validateRenderedHtmlArtifact({html,status:'preview',url:'https://receiver.invalid/?p=123&preview=true',
      httpStatus:200,expectedH1:before.title,expectedFacts:[before.body_markdown],expectedMediaIds:withExistingCover?[901,902]:[901]});
    assert.equal(inspection.valid,true,JSON.stringify(inspection.errors));
    for(const image of [...remote.state.media,...(remote.state.cover?[remote.state.cover]:[])]) {
      const response=await fetch(remote.root+new URL(image.url).pathname),bytes=Buffer.from(await response.arrayBuffer());
      assert.equal(response.status,200);assert.equal(mediaHash(bytes),image.upload_hash);
      assert.equal((await sharp(bytes).metadata()).width,image.width);
    }
    assert.deepEqual(db.prepare('SELECT * FROM article_drafts WHERE id=?').get(seed.draftId),before);
    assert.deepEqual(db.prepare('SELECT * FROM wordpress_publications').get(),publication);
    assert.equal(db.prepare('SELECT count(*) n FROM model_call_metrics').get().n,0);
    assert.equal(remote.state.uploads,withExistingCover?2:1);assert.equal(remote.state.writes,withExistingCover?2:1);
    if(withExistingCover)assert.equal(remote.state.cover.media_id,baseline.featured_media_id,'body-only refresh retains the actual independently uploaded cover');
    fs.writeFileSync(path.join(directory,'page.html'),html);
    fs.writeFileSync(resultFile,JSON.stringify({status:'PASS',scope:'browser CMS + real files + deterministic fixture outbox + loopback receiver; not real WordPress',
      variant:coverOnly?'cover_only':withExistingCover?'body_with_existing_cover':'body_only',contract:pinned.frontend_commit_sha,body_hash:mediaHash(before.body_markdown),plan,delivered,
      uploads:remote.state.uploads,writes:remote.state.writes,provider_calls:0,inspection},null,2));done=true;
  }catch(error){fs.writeFileSync(resultFile,JSON.stringify({status:'FAIL',error:String(error.stack)}));done=true;}
  finally{busy=false;}
}
async function stop(){if(stopped||busy)return;stopped=true;clearInterval(poll);clearTimeout(deadline);await app.stop();
  try {
    if(done&&JSON.parse(fs.readFileSync(resultFile)).status==='PASS') {
      const response=await fetch(remote.root+'/page');assert.equal(response.status,200);
      assert.equal(await response.text(),fs.readFileSync(path.join(directory,'page.html'),'utf8'));
      for(const image of [...remote.state.media,...(remote.state.cover?[remote.state.cover]:[])])
        assert.equal(mediaHash(Buffer.from(await(await fetch(remote.root+new URL(image.url).pathname)).arrayBuffer())),image.upload_hash);
      fs.writeFileSync(path.join(directory,'offline.json'),JSON.stringify({status:'PASS',cms_stopped:true,receiver_html_and_image_bytes_available:true,wordpress:false}));
    }
  }catch(error){fs.writeFileSync(path.join(directory,'offline.json'),JSON.stringify({status:'FAIL',error:String(error)}));}
  finally{for(const fn of cleanup)await fn();}
}
const poll=setInterval(()=>fs.existsSync(stopFile)?void stop():void consume(),300);
const deadline=setTimeout(()=>void stop(),30*60_000);
console.log(JSON.stringify({directory,stopFile,resultFile,url:`http://127.0.0.1:${app.server.address().port}`,pid:process.pid}));
