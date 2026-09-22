// Guarded repair of published WordPress #69 from the three user-supplied route
// collages and their already-reviewed English image translations. No image or
// text model is called here. Rehearse on a disposable production DB copy first.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import sharp from 'sharp';
import {Repository} from '../src/repository.mjs';
import {transaction} from '../src/db.mjs';
import {buildContentAst} from '../src/content-blocks.mjs';
import {freezeRequiredMediaManifest,evaluatePublicationEligibility} from '../src/publication-eligibility.mjs';
import {wordpressReceiptFingerprint} from '../src/services/delivery-refresh.mjs';
import {now} from '../src/utils.mjs';

const DRAFT_ID='draft_ac2559c3c4c24d0bbee23daf89a2ddf0';
const POST_ID=69;
const SOURCE_KEY='editorial-route-20260923:three-day-chongqing';
const WORDPRESS_BASELINE={status:'publish',cms_draft_id:DRAFT_ID,
  modified_gmt:'2026-09-21 17:47:55',
  page_payload_hash:'cb87ead1d6e11fc6cc5bb50ddbc6743ad10b1052a94b1a2270f032328b5f807d'};
const DAYS=[
  {day:1,originalHash:'93e1ab0be1a39df52a9a307aa4644648ae82847c42e6b59d1e782c16312cc515',
    englishHash:'f63bc17e3359b0545166a3088d968b05b07e159ee4af553596074a6475820c9a',
    stops:['Mountain City Trail','Jiefangbei','Baixiangju','Raffles City','Hongyadong','Jiangtan Park'],
    originalLabels:['山城步道','解放碑','白象居','来福士','洪崖洞','江滩公园'],
    alt:'English Day 1 Chongqing route collage from Mountain City Trail through Jiefangbei, Baixiangju, Raffles City and Hongyadong to Jiangtan Park',
    caption:'Day 1 route illustration translated from the authorized user-supplied collage. Its photos and transfer times are illustrative; verify your entrance and route locally.'},
  {day:2,originalHash:'47aea2d3dff8c7129d8d0902191c05f74b88d8d765092113cb15bd8094c4b240',
    englishHash:'39f445a86b3fbaf7ead835076f1637b302696485caefd28d3d7541b9558b1e14',
    stops:['Huangjueya Old Street','Huangge Ancient Road','Longmenhao Old Street','Xiahaoli','Clock Tower Square','Liangjiang Xiao Ferry'],
    originalLabels:['黄桷垭老街','黄葛古道','龙门浩老街','下浩里','钟楼广场','两江小渡'],
    alt:'English Day 2 Chongqing route collage from Huangjueya and Huangge Ancient Road through Longmenhao and Xiahaoli to Liangjiang Xiao Ferry',
    caption:'Day 2 route illustration translated from the authorized user-supplied collage. The complete Huangge Ancient Road is not a 15-minute walk; check ferry operations on the day.'},
  {day:3,originalHash:'547f558873630bd84ae7dd77bba679faec16c7a31d05f4afe5f25ff14e4afedf',
    englishHash:'bcb02f7aef37d2486530af0aa0c65a2b43d08313f4e8f167b33e2efd39df917b',
    stops:['Eling Park','Liziba',"People's Great Hall",'Three Gorges Museum','Guanyinqiao','Beicang Cultural Park'],
    originalLabels:['鹅岭公园','李子坝','人民大礼堂','三峡博物馆','观音桥','北仓文创园'],
    alt:'English Day 3 Chongqing route collage from Eling Park and Liziba to the Great Hall, Three Gorges Museum, Guanyinqiao and Beicang',
    caption:'Day 3 route illustration translated from the authorized user-supplied collage. Metro and walking times are approximate; check venue hours locally.'},
];

const [mode,databaseArg,inputArg,confirmation,productionToken]=process.argv.slice(2);
if (!['plan','apply'].includes(mode) || !databaseArg || !inputArg) {
  throw new Error('usage: script plan|apply DB INPUT_DIR [CONFIRMATION] [PRODUCTION_TOKEN]');
}
const databasePath=path.resolve(databaseArg),inputDir=path.resolve(inputArg);
const livePath='/var/lib/solo-to-china/solo-to-china.sqlite';
const isLive=databasePath===livePath;
if (mode==='apply' && !isLive && !/editorial-replay-20260923-work\.sqlite$/.test(databasePath)) {
  throw new Error('Apply requires the exact disposable work DB or live DB.');
}
if (mode==='apply' && isLive && productionToken!=='THREE_DAY_EDITORIAL_PRODUCTION') {
  throw new Error('Live apply requires THREE_DAY_EDITORIAL_PRODUCTION.');
}
const file=(name)=>{
  if (!/^(?:day[123]-(?:original|en)\.png|post69-revised\.md)$/.test(name)) throw new Error('Unexpected input file.');
  return path.join(inputDir,name);
};
const hash=(bytes)=>crypto.createHash('sha256').update(bytes).digest('hex');
const imageInputs=await Promise.all(DAYS.map(async(day)=>{
  const original=fs.readFileSync(file(`day${day.day}-original.png`));
  const english=fs.readFileSync(file(`day${day.day}-en.png`));
  if (hash(original)!==day.originalHash || hash(english)!==day.englishHash) {
    throw new Error(`Day ${day.day} original or translation bytes changed.`);
  }
  const originalMeta=await sharp(original).metadata(),englishMeta=await sharp(english).metadata();
  if (originalMeta.format!=='png' || englishMeta.format!=='png'
    || originalMeta.width<900 || originalMeta.height<900
    || englishMeta.width<900 || englishMeta.height<900) {
    throw new Error(`Day ${day.day} image format/resolution invalid.`);
  }
  return {...day,original,english,originalMeta,englishMeta};
}));
const sourceBody=fs.readFileSync(file('post69-revised.md'),'utf8');
if (!sourceBody.startsWith('# The Feasible 3-Day Chongqing Route:')) throw new Error('Unexpected article title.');
const body=sourceBody.replace(/^# [^\n]+\n/,'')
  .replace(/^!\[[^\n]+\]\(day[123]-en\.png\)\s*$/gm,'')
  .replace(/^\*Day [123] visual route,[^\n]+\*\s*$/gm,'')
  .replace(/\n{3,}/g,'\n\n').trim();
for (const day of DAYS) {
  if (!body.includes(`## Day ${day.day}:`) || day.stops.some((stop)=>!body.includes(stop))) {
    throw new Error(`Article body omits a Day ${day.day} route stop.`);
  }
}
if (/\]\(day[123]-en\.png\)/.test(body)) throw new Error('Unresolved local image link in final body.');

const db=new DatabaseSync(databasePath,{readOnly:mode==='plan'});
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
if (mode==='plan') db.exec('PRAGMA query_only=ON');
const sourceRoot=isLive?'/var/lib/solo-to-china/source-uploads':'/work/source-uploads';
const generatedRoot=isLive?'/var/lib/solo-to-china/generated-media':'/work/generated-media';
const repo=new Repository(db,{sourceUploadsDir:sourceRoot,generatedMediaDir:generatedRoot});
try {
  const draft=db.prepare('SELECT * FROM article_drafts WHERE id=?').get(DRAFT_ID);
  const publication=db.prepare('SELECT post_id,status FROM wordpress_publications WHERE draft_id=?').get(DRAFT_ID);
  const active=db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE entity_id=? AND status IN ('queued','running')").get(DRAFT_ID).n;
  const owner=db.prepare(`SELECT production_owner_opportunity_id AS id FROM jobs
    WHERE entity_id=? AND production_owner_opportunity_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`).get(DRAFT_ID)?.id;
  const approved=owner && db.prepare('SELECT 1 FROM content_opportunities WHERE id=? AND approved_at IS NOT NULL').get(owner);
  const sourceExisting=db.prepare('SELECT id FROM sources WHERE source_identity=?').get(SOURCE_KEY);
  if (!draft || draft.revision!==3 || active!==0 || !approved || sourceExisting
    || publication?.post_id!==POST_ID || publication?.status!=='synced') {
    throw new Error('Route draft, owner, queue, source or WordPress mapping changed; stop and re-audit.');
  }
  const snapshot={draftId:DRAFT_ID,revision:draft.revision,contentHash:draft.content_hash,
    existingPostId:POST_ID,owner,bodyHash:hash(body),
    sourceOriginals:imageInputs.map(({day,originalHash,englishHash})=>({day,originalHash,englishHash})),
    wordpressBaseline:wordpressReceiptFingerprint(WORDPRESS_BASELINE)};
  const digest=hash(JSON.stringify(snapshot));
  if (mode==='plan') {
    console.log(JSON.stringify({mode,isLive,confirmation:digest,snapshot,
      title:draft.title,days:DAYS.map(({day,stops,alt,caption})=>({day,stops,alt,caption})),
      expectedNewSources:1,expectedNewAssets:3,expectedVisuals:3,
      expectedModelCallsBeforeAsyncReview:0},null,2));
  } else {
    if (confirmation!==digest) throw new Error('Confirmed plan changed; re-plan.');
    const result=transaction(db,()=>{
      const timestamp=now();
      const capture={adapter:'manual',externalId:SOURCE_KEY,sourceIdentity:SOURCE_KEY,
        sourceVersionIdentity:hash(imageInputs.map((day)=>day.originalHash).join(':')),
        canonicalUrl:'manual-source://editorial-route-20260923/three-day-chongqing',
        submittedUrl:'',originalUrl:'',finalUrl:'',sourceKind:'images',
        title:'User-supplied three-day Chongqing itinerary collages',
        authorName:'User-supplied editorial source',authorUrl:'',
        sourcePublisher:'User-supplied authorized editorial source',submittedBy:'administrator',
        publishedAt:null,capturedAt:timestamp,rawHtml:'',
        rawText:'User-supplied three-day Chongqing route collages. '+imageInputs.map((day)=>
          `Day ${day.day}: ${day.stops.join(' to ')}.`).join(' ')
          +' Transfer labels on the original images are illustrative, not validated journey times.',
        acquisitionOrigin:'user_supplied_editorial_media',
        submissionMetadata:{editorialMediaOnly:true,manifest:'three-day-route-20260923',
          terminalReason:'original route collages are visual evidence for an existing approved article; extraction intentionally not requested'},
        completeness:{overall:'complete'},
        rights:{authorizationStatus:'owner_confirmed',commercialUseAllowed:true,
          editingAllowed:true,redistributionAllowed:true,publishable:true,
          authorizationOrigin:'project_source_media_full_authorization',licenseScope:['editorial','production']},
        assets:imageInputs.map((day,index)=>({kind:'image',
          url:`manual-asset://editorial-route-20260923/day${day.day}-original.png`,
          mediaIdentity:`sha256:${day.originalHash}`,alt:`Chongqing Day ${day.day} route collage`,
          position:index,width:day.originalMeta.width,height:day.originalMeta.height,
          mimeType:'image/png',originalFilename:`day${day.day}-original.png`,
          originalSha256:day.originalHash,originalDataUrl:`data:image/png;base64,${day.original.toString('base64')}`,
          languageStatus:'mixed',nearbyText:day.stops.join('; '),captionText:day.caption,
          provenance:{originalFilename:`day${day.day}-original.png`,originalSha256:day.originalHash,
            suppliedBy:'user_attachment',translationSha256:day.englishHash,
            editorialSubject:`Chongqing Day ${day.day} route collage`,useInArticle:true}})),
        files:[]};
      const saved=repo.saveCapture(capture);
      if (saved.duplicate || !saved.mediaDurabilityComplete) throw new Error('Route-source capture incomplete.');
      const canceled=db.prepare("DELETE FROM jobs WHERE entity_id=? AND type='extract_source' AND status='queued'")
        .run(saved.id).changes;
      if (canceled!==1) throw new Error('Unexpected source-extraction queue state.');
      db.prepare("UPDATE sources SET status='media_only' WHERE id=?").run(saved.id);
      const assetIds=[];
      for (const day of imageInputs) {
        const asset=db.prepare('SELECT id,local_path,original_sha256 FROM source_assets WHERE source_id=? AND remote_url=?')
          .get(saved.id,`manual-asset://editorial-route-20260923/day${day.day}-original.png`);
        if (!asset || asset.original_sha256!==day.originalHash || !fs.existsSync(asset.local_path)) {
          throw new Error(`Stored Day ${day.day} original unavailable.`);
        }
        assetIds.push(asset.id);
        const analysis={source_sha256:day.originalHash,analysis_status:'ready',
          asset_kind:'editorial_infographic',
          text_regions:day.originalLabels.map((label,index)=>({region_id:`route_stop_${index+1}`,role:'editorial_text',
            language:'zh',readable:true,preserve:false,text:label})),
          photo_regions:[{region_id:'six_location_collage',subject:`Chongqing Day ${day.day} route scenes`}],
          entities:day.stops.map((name)=>({name})),editor_ui_regions:[],
          primary_subjects:[`Chongqing Day ${day.day} route collage`,...day.stops],
          language_by_region:day.stops.map((_,index)=>({region_id:`route_stop_${index+1}`,language:'zh'})),
          reader_text_present:true,confidence:0.9,analysis_version:'media-analysis-2',
          prompt_version:'operator_assisted_route_visual_review_20260923'};
        if (!repo.saveSourceAssetAnalysis(asset.id,analysis,{provider:'operator_assisted_editorial',
          model:'already-translated-user-supplied-collage',withinTransaction:true})) {
          throw new Error(`Day ${day.day} source image analysis was not saved.`);
        }
      }
      const pkg=repo.getDraftPackage(DRAFT_ID);
      const updated={...pkg.draft,body_markdown:body,
        meta_description:'A flexible three-day Chongqing route: Yuzhong riverfront on Day 1, south-bank heritage and an optional ferry on Day 2, Eling and Jiangbei on Day 3.',
        verification_notes:[...(pkg.draft.verification_notes || []),
          'Route order follows three user-supplied original collages, translated into English for this article. All transfer times and ferry operations require same-day verification.']};
      if (repo.saveDraft(draft.brief_id,updated,'operator_rewrite_from_user_route_maps',
        {deferReview:true,opportunityId:owner})!==DRAFT_ID) throw new Error('Unexpected route draft ID.');
      const current=repo.getDraftPackage(DRAFT_ID);
      const ast=buildContentAst({draft:current.draft,brief:current.brief,visuals:[],facts:current.facts});
      const anchors=DAYS.map((day)=>{
        const headingIndex=ast.nodes.findIndex((node)=>node.type==='heading'
          && node.visible_text.startsWith(`Day ${day.day}:`));
        if (headingIndex<0) throw new Error(`Day ${day.day} heading missing from content AST.`);
        const nextHeading=ast.nodes.findIndex((node,index)=>index>headingIndex && node.type==='heading');
        const paragraph=ast.nodes.slice(headingIndex+1,nextHeading<0?undefined:nextHeading)
          .find((node)=>node.type==='paragraph');
        if (!paragraph?.id) throw new Error(`Day ${day.day} section has no media anchor.`);
        return paragraph.id;
      });
      repo.replaceDraftVisuals(DRAFT_ID,imageInputs.map((day,index)=>({
        placement:'mid_article',purpose:`Illustrate the Day ${day.day} route in the article`,
        alt_text:day.alt,caption:day.caption,generation_prompt:'',aspect_ratio:'3:4',
        image_type:'infographic',image_role:'inline',image_subject:`Chongqing Day ${day.day} route collage`,
        acquisition_strategy:'recompose_editorial_card',factual_image_required:true,
        required_in_article:true,source_asset_id:assetIds[index],
        source_remote_url:`manual-asset://editorial-route-20260923/day${day.day}-original.png`,
        status:'planned',media_metadata:{anchor_content_node_id:anchors[index],
          required_visual_obligation:{required:true,reason:'user_supplied_three_day_route'},
          authorized_asset_match:{score:1,mode:'exact_user_supplied_route'},
          visual_decision:{action:'localize',visualClass:'editorial_infographic'},
          source_analysis:{analysis_status:'ready',asset_kind:'editorial_infographic',reader_text_present:true},
          source_sha256:day.originalHash,authorization_policy:'project_source_media_full_authorization',
          source_provenance:{source_asset_id:assetIds[index],original_stored:true,
            project_owner_confirmed:true,source_owner_confirmed:true,source_publishable:true,
            asset_owner_confirmed:true,asset_publishable:true}}})),draft.strategy_version);
      const visuals=repo.listDraftVisuals(DRAFT_ID);
      if (visuals.length!==3) throw new Error('Exactly three route maps are required.');
      fs.mkdirSync(generatedRoot,{recursive:true});
      for (let index=0;index<visuals.length;index++) {
        const day=imageInputs[index],visual=visuals[index];
        if (visual.source_asset_id!==assetIds[index]) throw new Error(`Day ${day.day} source binding changed.`);
        const target=path.join(generatedRoot,`${DRAFT_ID}-day${day.day}-english-${day.englishHash.slice(0,16)}.png`);
        if (fs.existsSync(target)) {
          if (hash(fs.readFileSync(target))!==day.englishHash) throw new Error(`Day ${day.day} derivative target differs.`);
        } else fs.copyFileSync(file(`day${day.day}-en.png`),target,fs.constants.COPYFILE_EXCL);
        repo.saveGeneratedVisual(visual.id,{mediaPath:target,mediaUrl:'',
          provider:'user_requested_model_translation',model:'imagegen_existing_reviewed_derivative',
          metadata:{sha256:day.englishHash,mime:'image/png',bytes:day.english.length,
            width:day.englishMeta.width,height:day.englishMeta.height,
            original_source_sha256:day.originalHash,
            translation_artifact:{status:'translated',source_hash:day.originalHash,output_hash:day.englishHash,
              provider:'imagegen',reviewed_at:timestamp,
              note:'English labels and route order visually checked against user-supplied original.'},
            binary_qa:{status:'passed',sha256:day.englishHash,mime_type:'image/png',
              dimensions:{width:day.englishMeta.width,height:day.englishMeta.height},byte_length:day.english.length},
            quality_qa:{status:'passed',file_hash:day.englishHash,
              reviewer:'operator_assisted_bilingual_route_visual_review',
              language:{status:'passed',reason:'The six route-stop labels are rendered in English.'},
              completeness:{status:'passed',reason:'All six stops and arrows are retained in source order.'},
              style:{status:'passed',reason:'The source collage remains legible at mobile width.'},
              semantic:{status:'passed',reason:'Translated stop names match the rewritten Day '+day.day+' article section; transfer times are qualified as estimates.'}}}},
          {expectedFingerprint:visual.asset_fingerprint});
      }
      freezeRequiredMediaManifest(db,DRAFT_ID);
      const gate=evaluatePublicationEligibility(db,DRAFT_ID);
      if (!gate.passed || gate.ready!==3) throw new Error(`Route media gate failed: ${JSON.stringify(gate)}`);
      const revision=db.prepare('SELECT revision,content_hash FROM article_drafts WHERE id=?').get(DRAFT_ID);
      if (revision.revision!==4) throw new Error('Route revision did not advance exactly once.');
      const baseline=wordpressReceiptFingerprint(WORDPRESS_BASELINE);
      const jobId=repo.enqueue('compose_frontend_page',DRAFT_ID,{
        dedupeKey:`delivery-refresh:editorial:${DRAFT_ID}:r4:${baseline}`,
        workloadClass:'historical_recovery',productionOwnerOpportunityId:owner,
        pipelineVersion:'article_bundle_v1'});
      if (!jobId) throw new Error('Route page-composition Job not queued.');
      return {draftId:DRAFT_ID,revision:revision.revision,contentHash:revision.content_hash,
        sourceId:saved.id,assetIds,visuals:repo.listDraftVisuals(DRAFT_ID)
          .map((visual)=>({id:visual.id,slot:visual.slot,status:visual.status,
            sourceAssetId:visual.source_asset_id,mediaPath:visual.media_path})),gate,jobId};
    });
    console.log(JSON.stringify({mode,isLive,confirmation:digest,result},null,2));
  }
} finally {db.close();}
