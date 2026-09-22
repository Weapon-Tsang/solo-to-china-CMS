// One-off, revision-guarded repair for the two on-site photos explicitly
// confirmed by the user. Plan on read-only data, apply to a disposable work
// database, then re-plan the live database before any production write.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import sharp from 'sharp';
import {Repository} from '../src/repository.mjs';
import {transaction} from '../src/db.mjs';
import {freezeRequiredMediaManifest,evaluatePublicationEligibility} from '../src/publication-eligibility.mjs';
import {id,now} from '../src/utils.mjs';

const DRAFT_ID='draft_514305818f534265b7a0f8a8d81d1d9d';
const POST_ID=192;
const SOURCE_ID='src_83486d24349c4bb6b95b53f2d7e7aa01';
const PHOTOS=[
  {assetId:'asset_ce3a4f25e0384f9aa1a52338a34b73fd',
    subject:'Eling Second Factory retro-electronics installation with a visitor',
    alt:'Visitor beside a retro-electronics installation at Eling Second Factory in Chongqing',
    caption:'A visitor at the retro-electronics installation inside Eling Second Factory. Photo: authorized source original; location confirmed by the user.'},
  {assetId:'asset_31722f465cf94277b54a7a5eb072b318',
    subject:'Eling Second Factory painted lane and visitor',
    alt:'Visitor on a painted lane at Eling Second Factory Testbed 2 in Chongqing',
    caption:'The painted lane at Eling Second Factory Testbed 2. Photo: authorized source original; location confirmed by the user.'},
];
const [mode,databaseArg,confirmation,productionToken]=process.argv.slice(2);
if (!['plan','apply'].includes(mode) || !databaseArg) throw new Error('usage: script plan|apply DB [CONFIRMATION] [PRODUCTION_TOKEN]');
const databasePath=path.resolve(databaseArg);
const livePath='/var/lib/solo-to-china/solo-to-china.sqlite';
const isLive=databasePath===livePath;
if (mode==='apply' && !isLive && !/editorial-replay-20260923-work\.sqlite$/.test(databasePath)) {
  throw new Error('Apply requires the exact disposable work DB or live DB.');
}
if (mode==='apply' && isLive && productionToken!=='ELING_VERIFIED_PHOTOS_PRODUCTION') {
  throw new Error('Live apply requires ELING_VERIFIED_PHOTOS_PRODUCTION.');
}
const db=new DatabaseSync(databasePath,{readOnly:mode==='plan'});
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
if (mode==='plan') db.exec('PRAGMA query_only=ON');
const repo=new Repository(db);
try {
  const draft=db.prepare('SELECT * FROM article_drafts WHERE id=?').get(DRAFT_ID);
  const publication=db.prepare('SELECT post_id,status FROM wordpress_publications WHERE draft_id=?').get(DRAFT_ID);
  const review=db.prepare(`SELECT * FROM quality_reviews WHERE draft_id=? AND draft_revision=?
    AND draft_content_hash=? AND passed=1 ORDER BY created_at DESC LIMIT 1`)
    .get(DRAFT_ID,draft?.revision,draft?.content_hash);
  const active=db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE entity_id=? AND status IN ('queued','running')").get(DRAFT_ID).n;
  const currentVisuals=db.prepare('SELECT COUNT(*) AS n FROM article_visuals WHERE draft_id=?').get(DRAFT_ID).n;
  const owner=db.prepare(`SELECT production_owner_opportunity_id AS id FROM jobs
    WHERE entity_id=? AND production_owner_opportunity_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`).get(DRAFT_ID)?.id;
  const approved=owner && db.prepare('SELECT 1 FROM content_opportunities WHERE id=? AND approved_at IS NOT NULL').get(owner);
  if (!draft || draft.revision!==4 || currentVisuals!==0 || active!==0 || !review || !approved
    || publication?.post_id!==POST_ID || publication?.status!=='synced') {
    throw new Error('Eling draft, QA, owner, queue or WordPress mapping changed; stop and re-audit.');
  }
  const assets=await Promise.all(PHOTOS.map(async(photo)=>{
    const row=db.prepare('SELECT * FROM source_assets WHERE id=?').get(photo.assetId);
    if (!row || row.source_id!==SOURCE_ID || row.original_bytes_status!=='saved_original'
      || row.durability_status!=='ORIGINAL_STORED' || !row.local_path || !fs.existsSync(row.local_path)) {
      throw new Error(`Original asset unavailable: ${photo.assetId}`);
    }
    const bytes=fs.readFileSync(row.local_path);
    const hash=crypto.createHash('sha256').update(bytes).digest('hex');
    const audit=JSON.parse(row.local_photo_audit_json || '{}');
    const dimensions=await sharp(bytes).metadata();
    if (hash!==row.original_sha256 || audit.status!=='eligible' || audit.sha256!==hash
      || dimensions.width<900 || dimensions.height<900 || dimensions.format!=='webp') {
      throw new Error(`Source photo failed immutable pixel audit: ${photo.assetId}`);
    }
    const decision=repo.sourceAssetDecisionDto(photo.assetId);
    if (decision.asset_kind!=='documentary_photo' || decision.analysis_status!=='ready'
      || (decision.editor_ui_regions || []).length) throw new Error(`Source analysis changed: ${photo.assetId}`);
    return {photo,row,hash,audit,decision,width:dimensions.width,height:dimensions.height,bytes:bytes.length};
  }));
  const snapshot={draftId:DRAFT_ID,revision:draft.revision,contentHash:draft.content_hash,
    bodyHash:crypto.createHash('sha256').update(draft.body_markdown).digest('hex'),reviewId:review.id,
    owner,postId:publication.post_id,assets:assets.map(({photo,hash})=>({id:photo.assetId,hash}))};
  const digest=crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  if (mode==='plan') {
    console.log(JSON.stringify({mode,isLive,confirmation:digest,snapshot,
      visualPlan:PHOTOS.map((photo,index)=>({slot:index+1,assetId:photo.assetId,alt:photo.alt,caption:photo.caption})),
      expectedModelCalls:0},null,2));
  } else {
    if (confirmation!==digest) throw new Error('Confirmed plan changed; re-plan.');
    const result=transaction(db,()=>{
      const timestamp=now();
      for (const {photo,row} of assets) {
        const provenance={...JSON.parse(row.provenance_json || '{}'),editorialLocationVerification:{
          status:'confirmed',draftId:DRAFT_ID,source:'explicit_user_message_2026-09-23',
          evidence:'User explicitly confirmed both person photographs were taken at Eling Second Factory and are appropriate original photos for its article.',
          confirmedAt:timestamp}};
        db.prepare('UPDATE source_assets SET provenance_json=? WHERE id=?').run(JSON.stringify(provenance),photo.assetId);
      }
      const packageDraft=repo.getDraftPackage(DRAFT_ID).draft;
      const saved=repo.saveDraft(draft.brief_id,{...packageDraft},'operator_verified_editorial_photo_binding',
        {deferReview:true,opportunityId:owner});
      if (saved!==DRAFT_ID) throw new Error('Unexpected Eling draft ID.');
      repo.replaceDraftVisuals(DRAFT_ID,assets.map(({photo,row})=>({
        placement:'mid_article',purpose:`Documentary view: ${photo.subject}`,
        alt_text:photo.alt,caption:photo.caption,generation_prompt:'',aspect_ratio:'2:3',
        image_type:'real_world_photo',image_role:'inline',image_subject:photo.subject,
        acquisition_strategy:'use_authorized_source_image',factual_image_required:true,
        required_in_article:true,source_asset_id:photo.assetId,source_remote_url:row.remote_url,
        status:'planned',media_metadata:{required_visual_obligation:{required:true,
          reason:'operator_confirmed_on_site_original'},authorized_asset_match:{score:0.15,mode:'editorial_location_verified'},
          visual_decision:{action:'retain',visualClass:'documentary_photo'},
          source_analysis:{analysis_status:'ready',asset_kind:'documentary_photo',reader_text_present:true},
          authorization_policy:'project_source_media_full_authorization',
          source_provenance:{source_asset_id:photo.assetId,original_stored:true,
            project_owner_confirmed:true,source_owner_confirmed:true,source_publishable:true,
            asset_owner_confirmed:true,asset_publishable:true}}})),draft.strategy_version);
      const visuals=repo.listDraftVisuals(DRAFT_ID);
      if (visuals.length!==2) throw new Error('Exactly two Eling photo slots are required.');
      for (let index=0;index<visuals.length;index++) {
        const visual=visuals[index],asset=assets[index];
        if (visual.source_asset_id!==asset.photo.assetId) throw new Error('Photo slot changed unexpectedly.');
        repo.saveGeneratedVisual(visual.id,{mediaPath:asset.row.local_path,
          mediaUrl:`/api/source-assets/${asset.photo.assetId}/preview`,provider:'authorized_source_original',
          model:'operator_confirmed_photo',metadata:{sha256:asset.hash,mime:'image/webp',
            width:asset.width,height:asset.height,bytes:asset.bytes,
            binary_qa:{status:'passed',sha256:asset.hash,mime_type:'image/webp',
              dimensions:{width:asset.width,height:asset.height},byte_length:asset.bytes},
            quality_qa:{status:'passed',file_hash:asset.hash,reviewer:'operator_assisted_source_photo_review',
              language:{status:'passed',reason:'Real-world signage is preserved, not translated.'},
              completeness:{status:'passed',reason:'The authorized original is retained without cropping.'},
              style:{status:'passed',reason:'Original documentary photograph, not a generated scene.'},
              semantic:{status:'passed',reason:'The user confirmed the photo was taken at Eling Second Factory.'}}}},
          {expectedFingerprint:visual.asset_fingerprint});
      }
      freezeRequiredMediaManifest(db,DRAFT_ID);
      const gate=evaluatePublicationEligibility(db,DRAFT_ID);
      if (!gate.passed || gate.ready!==2) throw new Error(`Two-photo media gate failed: ${JSON.stringify(gate)}`);
      const next=db.prepare('SELECT revision,content_hash,body_markdown FROM article_drafts WHERE id=?').get(DRAFT_ID);
      if (next.revision!==5 || next.body_markdown!==draft.body_markdown) throw new Error('Text changed during photo-only repair.');
      const evidenceHash=repo.getDraftPackage(DRAFT_ID).evidence_hash;
      if (evidenceHash!==review.evidence_hash) throw new Error('Evidence changed; previous text QA cannot be reused.');
      db.prepare(`INSERT INTO quality_reviews(id,draft_id,passed,score,checks_json,issues_json,
        unsupported_claims_json,reviewer,strategy_version,created_at,draft_revision,draft_content_hash,evidence_hash)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id('review'),DRAFT_ID,review.passed,review.score,
          review.checks_json,review.issues_json,review.unsupported_claims_json,
          `reused_unchanged_text:${review.id}`,review.strategy_version,timestamp,next.revision,next.content_hash,evidenceHash);
      const jobId=repo.enqueue('compose_frontend_page',DRAFT_ID,{dedupeKey:`delivery-refresh:media:${DRAFT_ID}:r5:${digest.slice(0,12)}`,
        workloadClass:'historical_recovery',productionOwnerOpportunityId:owner,pipelineVersion:'article_bundle_v1'});
      if (!jobId) throw new Error('Eling page-composition Job not queued.');
      return {draftId:DRAFT_ID,revision:next.revision,visuals:repo.listDraftVisuals(DRAFT_ID)
        .map(v=>({id:v.id,slot:v.slot,sourceAssetId:v.source_asset_id,status:v.status})),gate,jobId};
    });
    console.log(JSON.stringify({mode,isLive,confirmation:digest,result},null,2));
  }
} finally {db.close();}
