import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {CaptureMediaUploadManager} from '../capture-media-upload.mjs';
import {safeMediaPath,inspectMediaFile} from '../media-storage.mjs';
import {mediaHash,prepareWebMedia} from '../web-media.mjs';
import {transaction} from '../db.mjs';
import {auditSourcePhoto} from '../local-photo-audit.mjs';
import {visualQaMentionsSpellingError} from '../visual-qa.mjs';
import {readCoverContract} from '../cover-contract.mjs';
import {manualRouteMediaDecision} from './manual-route-media.mjs';
import {validateRouteDraft} from '../route-bundle.mjs';
import {routeSchematicVisual,routeRenderInput,verifyStoredRouteVisual} from '../visuals/route-schematic.mjs';
import {readCoverSelection} from './cover-selection.mjs';

const json=value=>JSON.parse(value || '{}');
const fail=(code,message,statusCode=409)=>Object.assign(new Error(message),{code,statusCode});
const now=()=>new Date().toISOString();
const hash=value=>mediaHash(JSON.stringify(value));
const safeName=value=>path.basename(String(value || 'image')).replace(/[\x00-\x1f]/g,'').slice(0,180);
const draftFor=(db,id)=>{const draft=db.prepare('SELECT * FROM article_drafts WHERE id=?').get(id);if(!draft)throw fail('DRAFT_NOT_FOUND','文章不存在。',404);return draft;};
const revisionFor=(db,id,revision)=>db.prepare('SELECT * FROM article_media_revisions WHERE draft_id=? AND draft_revision=? ORDER BY media_revision DESC LIMIT 1').get(id,revision);
const visualRows=(db,id)=>db.prepare('SELECT * FROM article_visuals WHERE draft_id=? ORDER BY slot,id').all(id);
// Read the article's persisted route receipt only. Building a full brief here
// traverses research and media inventories on every upload/list request.
const articleRoute=(db,draft)=>{
  const rows=db.prepare(`SELECT DISTINCT rb.bundle_json FROM route_bundles rb JOIN route_artifacts ra
    ON ra.route_id=rb.route_id AND ra.route_revision=rb.revision
    WHERE ra.artifact_kind='draft' AND ra.content_hash=? AND json_extract(ra.receipt_json,'$.draft_id')=? LIMIT 2`).all(draft.content_hash,draft.id);
  if(rows.length>1)throw fail('ROUTE_OWNER_AMBIGUOUS','文章存在多个路线回执，需要核对所属内容。');
  return rows.length?json(rows[0].bundle_json):null;
};
const identity=(db,id)=>{const draft=draftFor(db,id);const routes=db.prepare(`SELECT rb.route_id,rb.revision,rb.content_hash FROM route_bundles rb
  JOIN content_briefs cb ON cb.candidate_id=rb.candidate_id WHERE cb.id=? ORDER BY rb.route_id,rb.revision`).all(draft.brief_id);
  return hash([draft.revision,draft.content_hash,draft.body_markdown,visualRows(db,id),revisionFor(db,id,draft.revision)?.id,routes]);};

/** The article endpoint owns sessions. No bearer upload token is persisted or restored. */
export class ArticleMediaService {
  constructor(repository,config) {
    this.repository=repository;this.db=repository.db;this.outputDir=config.mediaDir;
    this.providerAllowed=()=>config.manualMediaProviderRecoveryEnabled===true && config.deployment?.environment==='production' && !config.deployment.runMode;
    this.provider=null;this.continuePipeline=null;
    this.uploads=new CaptureMediaUploadManager({...config.captureMediaUploads,
      uploadDir:path.join(config.captureMediaUploads.uploadDir,'article'),maxBytes:Number.MAX_SAFE_INTEGER,
      chunkBytes:config.captureMediaUploads.articleChunkBytes ?? 8*1024*1024,retainChunks:true});
    this.lane=Promise.resolve();
  }
  serial(work){const next=this.lane.then(work);this.lane=next.catch(()=>{});return next;}
  row(id,draftId,actor) {
    const row=this.db.prepare('SELECT * FROM article_media_uploads WHERE id=? AND draft_id=?').get(id,draftId);
    if(!row)throw fail('UPLOAD_NOT_FOUND','上传会话不存在。',404);
    if(row.actor!==actor)throw fail('UPLOAD_OWNER_MISMATCH','只有上传者可以操作此会话。',403);
    const saved=json(row.upload_json);
    // Restores remap file references. Recreate the session under the current private root after fresh admin authentication.
    if(!row.asset_id && saved.localPath && !fs.existsSync(path.join(this.uploads.directory(id),'upload.json'))) {
      const directory=this.uploads.directory(id);fs.mkdirSync(directory,{recursive:true});
      const metadata=JSON.parse(fs.readFileSync(saved.localPath,'utf8'));
      if(metadata.uploadId!==id || metadata.protocolVersion!==1)throw fail('UPLOAD_RESTORE_INVALID','恢复会话身份不匹配。');
      fs.writeFileSync(path.join(directory,'upload.json'),JSON.stringify(metadata),{flag:'wx'});
      for(const part of saved.parts || []){if(mediaHash(fs.readFileSync(part.localPath))!==part.sha256)throw fail('UPLOAD_RESTORE_INVALID','恢复分块校验失败。');
        fs.copyFileSync(part.localPath,this.uploads.chunkPath(id,part.index),fs.constants.COPYFILE_EXCL);}
    }
    return row;
  }
  view(row){const adopted=row.asset_id?this.db.prepare("SELECT acquisition_strategy,media_url,caption,status,wordpress_media_id,media_metadata_json FROM article_visuals WHERE draft_id=? AND source_asset_id=? AND json_extract(media_metadata_json,'$.manual_article_selection.locked')=1").get(row.draft_id,row.asset_id):null;
    return {id:row.id,filename:row.filename,state:row.state,asset_id:row.asset_id,error:row.error,
    delivery_confirmed:Boolean(adopted?.wordpress_media_id&&json(adopted.media_metadata_json).manual_delivery_receipt?.media_id===adopted.wordpress_media_id),
    replacement:adopted?.acquisition_strategy==='render_route_schematic'?{kind:'approved_route_schematic',status:adopted.status,
      preview_url:adopted.status==='generated'?adopted.media_url:null,caption:adopted.caption}:null,
    adoption_status:row.asset_id&&this.db.prepare("SELECT 1 FROM article_visuals WHERE draft_id=? AND source_asset_id=? AND json_extract(media_metadata_json,'$.manual_article_selection.locked')=1").get(row.draft_id,row.asset_id)?'selected':'candidate',
    draft_revision:row.draft_revision,receipt:Object.fromEntries(Object.entries(json(row.receipt_json)).filter(([key])=>key!=='localPath')),
    upload:Object.fromEntries(Object.entries(json(row.upload_json)).filter(([key])=>!['localPath','parts'].includes(key))),
    preview_url:row.asset_id?`/api/drafts/${encodeURIComponent(row.draft_id)}/article-media/uploads/${row.id}/preview`:null};}
  list(draftId,actor,{offset=0,limit=25}={}) {
    const draft=draftFor(this.db,draftId);
    const route=articleRoute(this.db,draft);
    if(!Number.isSafeInteger(offset)||offset<0)throw fail('INVALID_PAGE','页码无效。',400);
    limit=Math.max(1,Math.min(50,Number(limit)||25));
    const latest=revisionFor(this.db,draftId,draft.revision);
    return {draft_revision:draft.revision,media_revision:latest?.media_revision || 0,fingerprint:identity(this.db,draftId),
      route:route?{approved_route_hash:route.approved_route_hash,days:route.days,stops:route.stops.map(s=>({entity_id:s.entity_id,name_en:s.name_en,name_zh:s.name_zh}))}:null,
      total:this.db.prepare('SELECT COUNT(*) n FROM article_media_uploads WHERE draft_id=? AND actor=?').get(draftId,actor).n,
      items:this.db.prepare('SELECT * FROM article_media_uploads WHERE draft_id=? AND actor=? ORDER BY created_at,id LIMIT ? OFFSET ?').all(draftId,actor,limit,offset).map(row=>this.view(row)),
      slots:visualRows(this.db,draftId).map(row=>({id:row.id,slot:row.slot,caption:row.caption,status:row.status,error:row.last_error,
        purpose:json(row.media_metadata_json).media_purpose || 'body',
        locked:Boolean(json(row.media_metadata_json).manual_article_selection?.locked),selection_id:json(row.media_metadata_json).manual_article_selection?.id || null,route:json(row.media_metadata_json).route_contract || null})),
      recovery:latest?{id:latest.id,state:latest.state,receipt:json(latest.receipt_json)}:null,
      approved_no_image:Boolean(this.db.prepare('SELECT approved_no_image FROM required_media_manifests WHERE draft_id=? AND revision=?').get(draftId,draft.revision)?.approved_no_image),
      retention_days:30,delivery:'CMS本地保存与处理不代表WordPress交付或线上刷新。'};
  }
  async create(draftId,input,actor) {
    const draft=draftFor(this.db,draftId);
    if(input.expected_revision!==draft.revision)throw fail('MEDIA_REVISION_STALE','文章版本已改变，请刷新。');
    if(!['image/jpeg','image/png','image/webp'].includes(input.mimeType))throw fail('UNSUPPORTED_MEDIA_TYPE','请选择 JPG、PNG 或 WebP。',400);
    const directory=this.uploads.temporaryRoot;fs.mkdirSync(directory,{recursive:true});
    const disk=fs.statfsSync(directory,{bigint:true});
    if(!Number.isSafeInteger(input.size)||input.size<1)throw fail('INVALID_SIZE','文件长度必须是安全整数。',400);
    if(disk.bavail*disk.bsize<BigInt(input.size)*2n+256n*1024n*1024n)throw fail('MEDIA_DISK_RESERVE','可用磁盘不足以保存原件和分块；请释放空间后重试。',507);
    const upload=await this.uploads.create({...input,kind:'image',protocolVersion:1});
    if(draftFor(this.db,draftId).revision!==draft.revision)throw fail('MEDIA_REVISION_STALE','创建期间文章版本改变。');
    this.db.prepare(`INSERT INTO article_media_uploads(id,draft_id,draft_revision,actor,state,filename,upload_json,created_at,updated_at)
      VALUES (?,?,?,?,'selected',?,?,?,?)`).run(upload.uploadId,draftId,draft.revision,actor,safeName(input.name),JSON.stringify({...upload,size:input.size,sha256:input.sha256,mimeType:input.mimeType,
        localPath:path.join(this.uploads.directory(upload.uploadId),'upload.json'),parts:[]}),now(),now());
    return this.view(this.row(upload.uploadId,draftId,actor));
  }
  async status(draftId,id,actor){const row=this.row(id,draftId,actor);
    if(row.asset_id){const receipt=json(row.receipt_json);await inspectMediaFile(this.previewFile(draftId,id,actor),{...receipt,size:receipt.sizeBytes,maxBytes:Number.MAX_SAFE_INTEGER});return {...this.view(row),progress:{receipt:this.view(row).receipt,receivedChunks:[]}};}
    return {...this.view(row),progress:await this.uploads.status(id)};}
  async chunk(draftId,id,index,bytes,actor,chunkHash) {
    const row=this.row(id,draftId,actor);
    if(['cancelled','pending_confirmation','ready'].includes(row.state))throw fail('UPLOAD_NOT_WRITABLE','此会话不再接收分块。');
    if(mediaHash(bytes)!==chunkHash)throw fail('CHUNK_HASH_MISMATCH','分块校验失败，请重传该块。',400);
    const disk=fs.statfsSync(this.uploads.temporaryRoot,{bigint:true});if(disk.bavail*disk.bsize<BigInt(bytes.length)+256n*1024n*1024n)throw fail('MEDIA_DISK_RESERVE','磁盘保护阈值不足，请暂停并释放空间。',507);
    const result=await this.uploads.writeChunk(id,index,bytes);
    const saved=json(this.row(id,draftId,actor).upload_json);
    const parts=(saved.parts || []).filter(part=>part.index!==index);parts.push({index,localPath:this.uploads.chunkPath(id,index),sha256:chunkHash});parts.sort((a,b)=>a.index-b.index);
    this.db.prepare("UPDATE article_media_uploads SET state=CASE WHEN state IN ('paused','cancelled') THEN state ELSE 'uploading' END,upload_json=?,error=NULL,updated_at=? WHERE id=?").run(JSON.stringify({...saved,parts}),now(),id);
    return result;
  }
  state(draftId,id,actor,state){const row=this.row(id,draftId,actor);if(row.state==='cancelled'&&state!=='cancelled')throw fail('UPLOAD_CANCELLED','已取消的会话不能恢复。');if(!['paused','cancelled','uploading'].includes(state))throw fail('INVALID_STATE','状态无效。',400);
    this.db.prepare("UPDATE article_media_uploads SET state=?,updated_at=? WHERE id=? AND asset_id IS NULL").run(state,now(),id);return this.view(this.row(id,draftId,actor));}
  complete(draftId,id,actor){return this.serial(async()=>{
    let row=this.row(id,draftId,actor);if(row.asset_id)return this.view(row);
    if(row.state==='cancelled')throw fail('UPLOAD_CANCELLED','上传已取消。');
    this.db.prepare("UPDATE article_media_uploads SET state='verifying',updated_at=? WHERE id=?").run(now(),id);
    try {
      const receipt=await this.uploads.complete(id),filename=safeMediaPath(this.uploads.storageRoot,receipt.storageRef);
      const info=await sharp(filename,{limitInputPixels:40_000_000,failOn:'error'}).metadata();
      if((info.pages || 1)>1)throw fail('MEDIA_ANIMATION_UNSUPPORTED','动画原件已存储，请另选静态图片。',400);
      await sharp(filename,{limitInputPixels:40_000_000,failOn:'error'}).stats();
      const assetId=`manual_asset_${id}`,sourceId=`manual_article_${id}`;
      transaction(this.db,()=>{
        if(this.row(id,draftId,actor).state==='cancelled')throw fail('UPLOAD_CANCELLED','验证期间会话已取消，原件未采用。');
        const provenance={kind:'manual_article_upload',draft_id:draftId,draft_revision:row.draft_revision,
          actor,received_at:now(),original_filename:row.filename,receipt,localPath:filename};
        this.db.prepare(`INSERT INTO sources(id,adapter,external_id,canonical_url,source_kind,title,captured_at,raw_text,raw_html,raw_payload_json,content_hash,status,created_at,updated_at)
          VALUES (?,'manual',?,?,'manual_article_upload',?,?,'','',?,?,'manual_article_stored',?,?)`)
          .run(sourceId,id,`urn:cms:manual-article:${id}`,row.filename,now(),JSON.stringify(provenance),receipt.sha256,now(),now());
        this.db.prepare(`INSERT INTO source_assets(id,source_id,kind,remote_url,position,local_path,mime_type,original_filename,width,height,
          original_sha256,stored_sha256,stored_size_bytes,storage_status,original_bytes_status,durability_status,capture_version,provenance_json,publishable,authorization_status,authorization_origin)
          VALUES (?,?,'image',?,0,?,?,?,?,?,?,?,?,'saved','saved_original','ORIGINAL_STORED',1,?,0,'authorized','manual_article_upload')`)
          .run(assetId,sourceId,`urn:cms:manual-asset:${id}`,filename,receipt.mimeType,row.filename,info.width,info.height,receipt.sha256,receipt.sha256,receipt.sizeBytes,JSON.stringify(provenance));
        this.repository.saveSourceAssetStorageRef(assetId,{originalStorageRef:receipt.storageRef});
        this.db.prepare(`INSERT INTO media_occurrences(id,asset_id,source_id,capture_version,original_sha256,context_hash,context_json,status,policy_version,created_at)
          VALUES (?,?,?,1,?,?,?,'complete','manual-article-1',?)`).run(`manual_occurrence_${id}`,assetId,sourceId,receipt.sha256,hash(provenance),JSON.stringify(provenance),now());
        this.db.prepare("UPDATE sources SET authorization_status='owner_confirmed',authorization_origin='manual_article_upload' WHERE id=?").run(sourceId);
        this.db.prepare("UPDATE article_media_uploads SET state='pending_confirmation',asset_id=?,receipt_json=?,error=NULL,updated_at=? WHERE id=?")
          .run(assetId,JSON.stringify({...receipt,localPath:filename,width:info.width,height:info.height}),now(),id);
      });
      return this.view(this.row(id,draftId,actor));
    } catch(error){this.db.prepare("UPDATE article_media_uploads SET state=CASE WHEN state='cancelled' THEN state ELSE 'failed' END,error=?,updated_at=? WHERE id=?").run(String(error.message),now(),id);throw error;}
  });}
  previewFile(draftId,id,actor){const row=this.row(id,draftId,actor);if(!row.asset_id)throw fail('MEDIA_NOT_STORED','原件尚未完成校验。');
    const asset=this.db.prepare('SELECT local_path FROM source_assets WHERE id=?').get(row.asset_id);
    if(!asset?.local_path)throw fail('MEDIA_NOT_STORED','原件路径不可用。');
    // Paths come solely from server-owned asset records, including verified restore remaps.
    const filename=path.resolve(asset.local_path);safeMediaPath(path.dirname(filename),path.basename(filename));return filename;}
  previewBytes(draftId,id,actor){return this.serial(()=>sharp(this.previewFile(draftId,id,actor),{limitInputPixels:40_000_000}).rotate().resize({width:800,withoutEnlargement:true}).webp().toBuffer());}
  plan(draftId,input,actor) {
    const draft=draftFor(this.db,draftId),latest=revisionFor(this.db,draftId,draft.revision);
    const route=articleRoute(this.db,draft);
    // A missing exact receipt is not proof that a routed article became a
    // non-route article. Keep original uploads available, but block adoption.
    if(!route && this.db.prepare(`SELECT 1 FROM route_bundles rb JOIN content_briefs cb
      ON cb.candidate_id=rb.candidate_id WHERE cb.id=? LIMIT 1`).get(draft.brief_id))
      throw fail('ROUTE_VERSION_STALE','正文缺少当前批准路线的对应回执，请先核对正文与路线版本。');
    if(input.expected_revision!==draft.revision || input.expected_media_revision!==(latest?.media_revision || 0))throw fail('MEDIA_REVISION_STALE','文章或媒体版本已改变。');
    if(!Array.isArray(input.selections)||!input.selections.length)throw fail('MEDIA_SELECTION_EMPTY','请选择至少一张已保存图片。',400);
    const used=new Set(),seen=new Set(),rows=visualRows(this.db,draftId);
    const selections=input.selections.map(item=>{
      const upload=this.row(item.upload_id,draftId,actor);
      if(!upload.asset_id || upload.draft_revision!==draft.revision)throw fail('MEDIA_UPLOAD_STALE','图片未保存或属于旧文章版本。');
      if(seen.has(upload.id))throw fail('DUPLICATE_SELECTION','同一图片只能确认一次。');seen.add(upload.id);
      if(!['body','cover'].includes(item.purpose)||!['photo','text','route','illustration'].includes(item.kind))throw fail('INVALID_MEDIA_PURPOSE','请选择用途和图片类型。',400);
      const target=item.slot_id?rows.find(row=>row.id===item.slot_id):null;
      if(item.slot_id&&!target)throw fail('MEDIA_SLOT_STALE','目标槽位不存在。');
      if(target && (json(target.media_metadata_json).media_purpose || 'body')!==item.purpose)throw fail('MEDIA_PURPOSE_CONFLICT','封面与正文使用独立槽位，请为此用途新增槽位。');
      const relationship=item.relationship || 'article_subject';
      if(!['article_subject','context','illustration'].includes(relationship))throw fail('INVALID_MEDIA_RELATIONSHIP','请选择图片与文章的关系。',400);
      if(target?.factual_image_required && (relationship!=='article_subject' || item.kind==='illustration'))
        throw fail('MEDIA_SUBJECT_REQUIRED','此槽位需要文章对象的真实图片，请选择对象实拍或新增其他槽位。',400);
      // Describe the editorial use, not unobserved pixels or a failed slot's
      // imagined scene. An operator need not write English to adopt an image.
      const kindLabel={photo:'photograph',text:'information image',route:'route image',illustration:'illustration'}[item.kind];
      const caption=String(item.caption || '').trim() || `Editor-selected ${kindLabel} for this article.`;
      const description=String(item.description || '').trim() || {article_subject:'Editor selected this image of the article subject.',context:'Editor selected this image as related context.',illustration:'Editor selected this image as an editorial illustration.'}[relationship];
      if(caption.length>2000 || description.length>4000)throw fail('MEDIA_CONTEXT_TOO_LONG','图片说明超出长度限制。',400);
      const slotId=target?.id || `manual_visual_${upload.id}_${item.purpose}`;
      if(!target && rows.some(row=>row.id===slotId))throw fail('MEDIA_ALREADY_SELECTED','此图片已按该用途采用；请明确选择要替换的位置。');
      if(used.has(slotId))throw fail('DUPLICATE_SLOT','每个槽位只能选择一张图片。');used.add(slotId);
      const previous=target && json(target.media_metadata_json).manual_article_selection;
      if(previous?.locked && item.replace_selection_id!==previous.id)throw fail('MEDIA_LOCKED','替换已锁定图片需要确认当前选择。');
      const local=item.kind==='photo' && relationship!=='illustration' && item.no_reader_text!==false && item.factual_photo!==false && !/[\u3400-\u9fff]/u.test(caption);
      const routeDecision=manualRouteMediaDecision(route,item,target?json(target.media_metadata_json).route_contract:null);
      if(item.route_action && item.route_action!=='recompose_approved')throw fail('INVALID_ROUTE_ACTION','未知路线媒体操作。',400);
      if(item.route_action==='recompose_approved') {
        if(!route || item.approved_route_hash!==route.approved_route_hash || item.kind!=='route' || item.purpose!=='body')
          throw fail('ROUTE_RECOMPOSITION_SCOPE','重编只适用于当前批准路线的正文示意图。');
        if(target?.factual_image_required || json(target?.media_metadata_json).required_visual_obligation?.kind==='photo'
          || route.media_obligations.some(o=>o.required&&o.kind!=='schematic'&&(o.slot_id===target?.id || (o.asset_id&&o.asset_id===target?.source_asset_id))))
          throw fail('ROUTE_FACTUAL_MEDIA_REQUIRED','示意图不能替代必需实拍。');
        this.repository.assertDraftRouteCurrent(draftId);validateRouteDraft(route,draft);
        const schematic=routeSchematicVisual(route);
        return {upload_id:upload.id,asset_id:upload.asset_id,slot_id:slotId,replaces:target?.id || null,purpose:'body',kind:'route',
          caption:schematic.caption,alt_text:schematic.alt_text,description:'Approved route sequence schematic',anchor:target?.placement || 'mid_article',
          local_photo:false,route_action:'recompose_approved',route_blocked:false,
          original_decision:target?json(target.media_metadata_json).manual_article_selection?.route_decision || routeDecision:routeDecision,
          route_decision:{blocked:false,contract:schematic.media_metadata.route_contract},
          schematic_metadata:schematic.media_metadata,render_preview:routeRenderInput(route),original_hash:json(upload.receipt_json).sha256};
      }
      if(route && routeDecision && !routeDecision.blocked){this.repository.assertDraftRouteCurrent(draftId);validateRouteDraft(route,draft);}
      return {upload_id:upload.id,asset_id:upload.asset_id,slot_id:slotId,replaces:target?.id || null,purpose:item.purpose,kind:item.kind,
        ...(item.kind==='route'?{route_day_id:item.route_day_id || null,embedded_day_label:item.embedded_day_label || ''}:{}),
        caption,description,relationship,anchor:target?.placement || (['after_intro','mid_article','before_faq','closing'].includes(item.anchor)?item.anchor:'after_intro'),
        local_photo:local,quality_confirmed:item.quality_confirmed===true,route_blocked:Boolean(routeDecision?.blocked),route_decision:routeDecision,
        original_hash:json(upload.receipt_json).sha256};
    });
    const plan={draft_id:draftId,draft_revision:draft.revision,media_revision:latest?.media_revision || 0,
      fingerprint:identity(this.db,draftId),selections,remaining_slots:rows.filter(row=>!used.has(row.id)&&row.status!=='generated').map(row=>row.id),
      steps:selections.map(s=>({slot_id:s.slot_id,status:s.route_action==='recompose_approved'?'LOCAL_ROUTE_RECOMPOSITION':s.route_blocked?s.route_decision.code:s.purpose==='cover'?'COVER_GEOMETRY_REQUIRED':s.local_photo?'LOCAL_VALIDATION_AND_WEB_DERIVATIVE':'WAITING_AUTH',
        paid_steps:s.local_photo||s.route_action==='recompose_approved'?[]:['translation_or_visual_review'],budget_scope:s.slot_id})),body_change:false,external_calls:0};
    const displayed=rows.filter(row=>json(row.media_metadata_json).media_purpose!=='cover').length+selections.filter(s=>!s.replaces&&s.purpose==='body').length;
    const capacity=readCoverContract(this.db).media_capacity || 200;
    plan.capacity={displayed,maximum:capacity,excess:Math.max(0,displayed-capacity),scope:'display_contract_only_original_uploads_unlimited'};
    return {...plan,plan_hash:hash(plan)};
  }
  confirm(draftId,input,actor){return this.serial(async()=>{
    if(input.confirmed!==true || !/^[a-zA-Z0-9_-]{16,100}$/.test(input.idempotency_key || ''))throw fail('MEDIA_CONFIRMATION_REQUIRED','需要确认和有效幂等标识。',400);
    const previous=this.db.prepare('SELECT * FROM article_media_revisions WHERE idempotency_key=?').get(input.idempotency_key);
    if(previous){if(previous.draft_id!==draftId||previous.plan_hash!==input.plan_hash||previous.actor!==actor)throw fail('IDEMPOTENCY_CONFLICT','确认标识已被不同计划使用。');return this.recovery(previous.id);}
    const plan=this.plan(draftId,input,actor);if(plan.plan_hash!==input.plan_hash)throw fail('MEDIA_PLAN_STALE','计划已改变，请重新预览。');
    if(plan.capacity.excess)throw fail('MEDIA_CONTRACT_CAPACITY_EXCEEDED',`本篇展示合同最多 ${plan.capacity.maximum} 张，当前 ${plan.capacity.displayed} 张；请明确减少 ${plan.capacity.excess} 张采用项。上传原件全部保留。`);
    for(const selected of plan.selections){const receipt=json(this.row(selected.upload_id,draftId,actor).receipt_json);
      await inspectMediaFile(this.previewFile(draftId,selected.upload_id,actor),{...receipt,size:receipt.sizeBytes,maxBytes:Number.MAX_SAFE_INTEGER});}
    if(identity(this.db,draftId)!==plan.fingerprint)throw fail('MEDIA_PLAN_STALE','校验期间媒体发生改变。');
    const id=randomUUID();
    transaction(this.db,()=>{
      if(identity(this.db,draftId)!==plan.fingerprint)throw fail('MEDIA_PLAN_STALE','提交前媒体发生改变，请重新预览。');
      let order=this.db.prepare('SELECT COALESCE(MAX(slot),0) n FROM article_visuals WHERE draft_id=?').get(draftId).n;
      for(const selected of plan.selections){
        this.db.prepare('UPDATE source_assets SET publishable=1 WHERE id=?').run(selected.asset_id);
        this.db.prepare('UPDATE sources SET publishable=1 WHERE id=(SELECT source_id FROM source_assets WHERE id=?)').run(selected.asset_id);
        const row=this.db.prepare('SELECT * FROM article_visuals WHERE id=?').get(selected.slot_id);
        const original=this.previewFile(draftId,selected.upload_id,actor);
        const metadata=row?json(row.media_metadata_json):{};
        const history=[...(metadata.manual_article_history || []),...(row?[{row,localPath:row.media_path || undefined,at:now()}]:[])];
        const selection={...selected,id,locked:true,actor,confirmed_at:now(),draft_revision:plan.draft_revision,media_revision:plan.media_revision+1};
        const next={...metadata,manual_article_history:history,manual_article_selection:selection,
          ...(selected.schematic_metadata || {}),
          ...(selected.route_decision?.contract?{route_contract:selected.route_decision.contract}:{}),
          media_purpose:selected.purpose,quality_qa:null,binary_qa:null,web_derivative:null,
          cover_active_id:null,cover_locked:false,
          source_analysis:null,authorized_asset_match:null,visual_decision:null};
        const fingerprint=hash([selected,id]);
        if(!row)this.db.prepare(`INSERT INTO article_visuals(id,draft_id,slot,placement,purpose,alt_text,caption,generation_prompt,status,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,'','planned',?,?)`).run(selected.slot_id,draftId,++order,selected.anchor,selected.description,selected.caption,selected.caption,now(),now());
        this.db.prepare(`UPDATE article_visuals SET source_asset_id=?,asset_fingerprint=?,media_metadata_json=?,media_path=?,media_url=NULL,
          wordpress_media_id=NULL,wordpress_media_url=NULL,status='planned',alt_text=?,caption=?,last_error=?,retry_at=NULL,
          acquisition_strategy='manual_article_selection',updated_at=? WHERE id=?`)
          .run(selected.asset_id,fingerprint,JSON.stringify(next),original,selected.caption,selected.caption,plan.steps.find(s=>s.slot_id===selected.slot_id).status,now(),selected.slot_id);
        if(selected.route_action==='recompose_approved')this.db.prepare("UPDATE article_visuals SET acquisition_strategy='render_route_schematic',alt_text=? WHERE id=?").run(selected.alt_text,selected.slot_id);
      }
      const old=this.db.prepare('SELECT * FROM required_media_manifests WHERE draft_id=? AND revision=?').get(draftId,plan.draft_revision);
      const slots=visualRows(this.db,draftId).filter(row=>json(row.media_metadata_json).media_purpose!=='cover').map(row=>({slotId:row.id,slot:row.slot,
        required:old?JSON.parse(old.slots_json).find(s=>s.slotId===row.id)?.required!==false:true,
        factualImageRequired:Boolean(row.factual_image_required),sourceAssetId:row.source_asset_id || null,acquisitionStrategy:row.acquisition_strategy,
        planFingerprint:row.asset_fingerprint,...(json(row.media_metadata_json).route_contract?{routeContract:json(row.media_metadata_json).route_contract}:{})}));
      const manifest={version:2,draftId,revision:plan.draft_revision,mediaRevision:plan.media_revision+1,contentHash:draftFor(this.db,draftId).content_hash,
        minimumRequired:slots.filter(s=>s.required).length,approvedNoImage:!slots.length&&Boolean(old?.approved_no_image),slots};
      manifest.manifestHash=hash(manifest);
      this.db.prepare(`INSERT INTO article_media_revisions(id,draft_id,draft_revision,media_revision,plan_hash,idempotency_key,actor,manifest_json,receipt_json,state,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,'local_pending',?)`).run(id,draftId,plan.draft_revision,plan.media_revision+1,plan.plan_hash,input.idempotency_key,actor,JSON.stringify(manifest),JSON.stringify({plan,items:[],provider_calls:0,delivery:'WAITING_AUTH'}),now());
    });
    const local=await this.runLocal(id);
    return this.providerAllowed()?this.runProvider(id):local;
  });}
  recovery(id){const row=this.db.prepare('SELECT * FROM article_media_revisions WHERE id=?').get(id);return row?{id:row.id,state:row.state,media_revision:row.media_revision,...json(row.receipt_json)}:null;}
  async runLocal(id) {
    const revision=this.db.prepare('SELECT * FROM article_media_revisions WHERE id=?').get(id);
    const receipt=json(revision.receipt_json);const items=[];
    if(!receipt.plan)return this.recovery(id);
    for(const selected of receipt.plan.selections){
      const row=this.db.prepare('SELECT * FROM article_visuals WHERE id=?').get(selected.slot_id),metadata=json(row?.media_metadata_json);
      if(draftFor(this.db,revision.draft_id).revision!==revision.draft_revision || metadata.manual_article_selection?.id!==id){items.push({slot_id:selected.slot_id,state:'STALE'});continue;}
      if(selected.route_decision && !selected.route_blocked)try{this.repository.assertDraftRouteCurrent(revision.draft_id);}
      catch(error){items.push({slot_id:selected.slot_id,state:error.code || 'ROUTE_VERSION_STALE'});continue;}
      let state=receipt.plan.steps.find(s=>s.slot_id===selected.slot_id).status;
      if(state==='COVER_GEOMETRY_REQUIRED') {
        const cover=readCoverSelection(this.db,revision.draft_id);
        if(cover?.visual_id===selected.slot_id&&cover.revision===revision.draft_revision
          && cover.derivative?.parent_hash===selected.original_hash)try {
          await inspectMediaFile(cover.derivative.localPath,{sha256:cover.derivative.sha256,kind:'image',maxBytes:Number.MAX_SAFE_INTEGER});
          items.push({slot_id:selected.slot_id,state:'ready'});continue;
        }catch(error){items.push({slot_id:selected.slot_id,state:'COVER_DERIVATIVE_INVALID'});continue;}
      }
      if(state==='LOCAL_ROUTE_RECOMPOSITION')try {
        const currentDraft=draftFor(this.db,revision.draft_id);
        const route=articleRoute(this.db,currentDraft);
        validateRouteDraft(route,currentDraft);
        if(row.status==='generated'&&metadata.manual_local_receipt?.selection_id===id) {
          verifyStoredRouteVisual(this.db,route,row,metadata);
          const web=metadata.manual_local_receipt.derivative;
          await inspectMediaFile(web.localPath,{sha256:web.sha256,kind:'image',maxBytes:Number.MAX_SAFE_INTEGER});
          items.push({slot_id:selected.slot_id,state:'ready'});continue;
        }
        const attempts=Number(metadata.recovery_budget?.deterministic_recovery || 0);
        if(attempts>=3)throw fail('ROUTE_RENDER_BUDGET_EXHAUSTED','本槽位已达到本地渲染重试上限，请检查具体失败原因。');
        // Charge durably before work. New selections and restarts retain this
        // cumulative slot budget; the renderer receives the pre-attempt row.
        metadata.recovery_budget={...metadata.recovery_budget,deterministic_recovery:attempts+1};
        const charged=this.db.prepare('UPDATE article_visuals SET media_metadata_json=? WHERE id=? AND asset_fingerprint=? AND media_metadata_json=?')
          .run(JSON.stringify(metadata),selected.slot_id,row.asset_fingerprint,row.media_metadata_json);
        if(!charged.changes)throw fail('MEDIA_REVISION_STALE','其他处理已更新此槽位。');
        const result=await this.repository.renderDraftRouteVisual(row);
        const mother=fs.readFileSync(result.mediaPath),motherHash=mediaHash(mother);
        const derivative=await prepareWebMedia({bytes:mother,contentType:'image/png',outputDir:this.outputDir,kind:'text',purpose:'body',
          qa:{status:'passed',file_hash:motherHash},originalHash:motherHash});
        this.repository.assertDraftRouteCurrent(revision.draft_id);
        validateRouteDraft(articleRoute(this.db,draftFor(this.db,revision.draft_id)),draftFor(this.db,revision.draft_id));
        const next={...metadata,...result.metadata,manual_local_receipt:{original_hash:motherHash,derivative:derivative.receipt,
          retained_upload_hash:selected.original_hash,selection_id:id,provider_calls:0,review_basis:'deterministic_approved_route_renderer'}};
        const promoted=this.db.prepare("UPDATE article_visuals SET status='generated',media_path=?,media_url=?,media_metadata_json=?,last_error=NULL WHERE id=? AND asset_fingerprint=?")
          .run(result.mediaPath,result.mediaUrl,JSON.stringify(next),selected.slot_id,row.asset_fingerprint);
        if(!promoted.changes)throw fail('MEDIA_REVISION_STALE','生成期间媒体版本改变。');
        state='ready';
      }catch(error){state=error.code || 'LOCAL_PROCESSING_FAILED';this.db.prepare('UPDATE article_visuals SET last_error=? WHERE id=? AND asset_fingerprint=?').run(String(error.message),selected.slot_id,row.asset_fingerprint);}
      const quality=metadata.quality_qa;
      if(state==='WAITING_AUTH' && !visualQaMentionsSpellingError(quality) && quality?.file_hash && fs.existsSync(row.media_path)
        && quality.file_hash===mediaHash(fs.readFileSync(row.media_path))
        && (quality.status==='passed'||['language','completeness','style','semantic'].every(key=>quality[key]?.status==='passed')))state='ready';
      if(state==='LOCAL_VALIDATION_AND_WEB_DERIVATIVE' || (state==='COVER_GEOMETRY_REQUIRED' && selected.local_photo))try {
        const original=this.previewFile(revision.draft_id,selected.upload_id,revision.actor);
        if(fs.statSync(original).size>128*1024*1024)throw fail('MEDIA_PROCESSING_RESOURCE_LIMIT','原件已保全；当前本地转码内存保护要求分离大文件处理。');
        const bytes=fs.readFileSync(original);
        if(mediaHash(bytes)!==selected.original_hash)throw fail('MEDIA_ORIGINAL_CHANGED','原件发生变化。');
        const priorAudit=metadata.manual_local_receipt?.photo_audit;
        const photoAudit=priorAudit?.sha256===selected.original_hash?priorAudit:await auditSourcePhoto(original,{assetKind:'documentary_photo',alwaysCheckText:true});
        if(photoAudit.reasons.some(reason=>!['resolution_low','focus_low','detail_low'].includes(reason)))throw fail('MANUAL_PHOTO_TEXT_REVIEW','检测到密集文字，需转入文字图处理，不可作为普通照片直接采用。');
        if(photoAudit.reasons.length && !selected.quality_confirmed)throw fail('MANUAL_PHOTO_QUALITY_REVIEW','本地清晰度指标偏低，请明确核对质量后重新确认。');
        const upload=this.row(selected.upload_id,revision.draft_id,revision.actor),stored=json(upload.receipt_json);
        const derivative=await prepareWebMedia({bytes,contentType:stored.mimeType,outputDir:this.outputDir,kind:'photo',purpose:'body',
          qa:{status:'passed',file_hash:selected.original_hash},originalHash:selected.original_hash});
        const current=this.db.prepare('SELECT * FROM article_visuals WHERE id=?').get(selected.slot_id);
        if(current?.asset_fingerprint!==row.asset_fingerprint || draftFor(this.db,revision.draft_id).revision!==revision.draft_revision)throw fail('MEDIA_REVISION_STALE','处理期间版本改变。');
        await inspectMediaFile(original,{sha256:selected.original_hash,kind:'image',maxBytes:Number.MAX_SAFE_INTEGER});
        if(selected.route_decision){this.repository.assertDraftRouteCurrent(revision.draft_id);
          const currentDraft=draftFor(this.db,revision.draft_id);validateRouteDraft(articleRoute(this.db,currentDraft),currentDraft);}
        const next={...metadata,manual_local_receipt:{original_hash:selected.original_hash,derivative:derivative.receipt,provider_calls:0,photo_audit:photoAudit,
          review_basis:'administrator_photo_and_no_reader_text_assertion_plus_full_local_decode',selection_id:id}};
        // Mother remains the exact original. The separately verified web receipt is not a fabricated model QA.
        const promoted=this.db.prepare("UPDATE article_visuals SET status='generated',media_url=?,media_metadata_json=?,last_error=NULL WHERE id=? AND asset_fingerprint=?")
          .run(`/api/drafts/${revision.draft_id}/article-media/uploads/${selected.upload_id}/preview`,JSON.stringify(next),selected.slot_id,row.asset_fingerprint);
        if(!promoted.changes)throw fail('MEDIA_REVISION_STALE','提交时媒体版本改变。');
        this.db.prepare("UPDATE article_media_uploads SET state='ready',updated_at=? WHERE id=?").run(now(),selected.upload_id);
        state=selected.purpose==='cover'?'COVER_GEOMETRY_REQUIRED':'ready';
      }catch(error){state=error.code || 'LOCAL_PROCESSING_FAILED';this.db.prepare('UPDATE article_visuals SET last_error=? WHERE id=? AND asset_fingerprint=?').run(String(error.message),selected.slot_id,row.asset_fingerprint);}
      items.push({slot_id:selected.slot_id,state});
    }
    const page=this.db.prepare('SELECT payload_json FROM frontend_page_compositions WHERE draft_id=?').get(revision.draft_id);
    const next={...receipt,items,provider_calls:receipt.provider_calls || 0,delivery:receipt.delivery_attempt?receipt.delivery:'WAITING_AUTH',page_media_patch:{base_page_hash:page?hash(page.payload_json):null,
      body_changed:false,affected_slot_ids:receipt.plan.selections.filter(s=>s.purpose==='body').map(s=>s.slot_id),status:'WAITING_DELIVERY_RECEIPTS'}};
    this.db.prepare('UPDATE article_media_revisions SET state=?,receipt_json=? WHERE id=?').run(items.every(item=>item.state==='ready')?'local_ready':'waiting_attention',JSON.stringify(next),id);
    return this.recovery(id);
  }
  resume(draftId,id,actor){return this.serial(()=>{const row=this.db.prepare('SELECT * FROM article_media_revisions WHERE id=? AND draft_id=?').get(id,draftId);
    if(!row||row.actor!==actor)throw fail('RECOVERY_NOT_FOUND','恢复记录不可用。',403);return this.runLocal(id).then(local=>this.providerAllowed()?this.runProvider(id):local);});}
  async runProvider(id) {
    if(!this.providerAllowed() || !this.provider?.enabled)return this.recovery(id);
    const revision=this.db.prepare('SELECT * FROM article_media_revisions WHERE id=?').get(id),receipt=json(revision.receipt_json);
    if(!receipt.plan)return this.recovery(id);
    for(const selected of receipt.plan.selections){
      const item=receipt.items.find(item=>item.slot_id===selected.slot_id);
      if(item?.state!=='WAITING_AUTH'||selected.kind!=='text'||selected.route_blocked||selected.purpose!=='body')continue;
      const row=this.db.prepare('SELECT * FROM article_visuals WHERE id=?').get(selected.slot_id),metadata=json(row.media_metadata_json);
      if(metadata.manual_article_selection?.id!==id || draftFor(this.db,revision.draft_id).revision!==revision.draft_revision){item.state='STALE';continue;}
      try{
        const asset=this.db.prepare('SELECT * FROM source_assets WHERE id=?').get(selected.asset_id);
        await inspectMediaFile(asset.local_path,{sha256:selected.original_hash,mimeType:asset.mime_type,kind:'image',maxBytes:Number.MAX_SAFE_INTEGER});
        if(!this.providerAllowed())break;
        const visual={...row,acquisition_strategy:'localize_source_image',source_asset_local_path:asset.local_path,source_asset_mime_type:asset.mime_type};
        const result=await this.provider.localizeSourceImage(visual,draftFor(this.db,revision.draft_id),{expectedFingerprint:row.asset_fingerprint,
          idempotencyKey:`manual:${id}:${row.id}`,telemetryContext:{entityId:row.id,visualId:row.id,sourceAssetId:selected.asset_id}});
        const quality=result.metadata?.quality_qa,fileHash=mediaHash(fs.readFileSync(result.mediaPath));
        const qaPassed=quality?.status==='passed'||['language','completeness','style','semantic'].every(key=>quality?.[key]?.status==='passed');
        if(!qaPassed || visualQaMentionsSpellingError(quality) || quality.file_hash!==fileHash)throw fail('MANUAL_TRANSLATION_QA_REQUIRED','Translated mother lacks independent QA.');
        const current=this.db.prepare('SELECT * FROM article_visuals WHERE id=?').get(row.id);
        if(current.asset_fingerprint!==row.asset_fingerprint || draftFor(this.db,revision.draft_id).revision!==revision.draft_revision)throw fail('STALE_VISUAL_RESULT','Manual selection changed during provider work.');
        const receiptMetadata={...metadata,...result.metadata,manual_article_selection:metadata.manual_article_selection,manual_article_history:metadata.manual_article_history};
        this.db.prepare("UPDATE article_visuals SET media_path=?,media_url=?,media_metadata_json=?,status='generated',last_error=NULL WHERE id=? AND asset_fingerprint=?")
          .run(result.mediaPath,result.mediaUrl,JSON.stringify(receiptMetadata),row.id,row.asset_fingerprint);item.state='ready';
      }catch(error){item.state=error.code || 'PROVIDER_RECOVERY_FAILED';item.error=String(error.message);}
    }
    receipt.provider_calls=this.db.prepare(`SELECT COUNT(*) n FROM media_dispatches WHERE visual_id IN
      (SELECT id FROM article_visuals WHERE draft_id=?)`).get(revision.draft_id).n;
    if(!receipt.delivery_attempt)receipt.delivery='WAITING_RECEIVER_CAPABILITY';
    this.db.prepare('UPDATE article_media_revisions SET state=?,receipt_json=? WHERE id=?').run(receipt.items.every(item=>item.state==='ready')?'local_ready':'waiting_attention',JSON.stringify(receipt),id);
    // External delivery remains separately gated; this cannot publish an article.
    return this.recovery(id);
  }
  revoke(draftId,input,actor){return this.serial(()=>{
    const draft=draftFor(this.db,draftId),latest=revisionFor(this.db,draftId,draft.revision);
    if(input.confirmed!==true || !String(input.reason || '').trim())throw fail('MEDIA_REVOKE_CONFIRMATION_REQUIRED','撤销需要明确确认并填写原因。',400);
    const prior=this.db.prepare('SELECT * FROM article_media_revisions WHERE idempotency_key=?').get(`revoke_${input.selection_id}`);
    if(prior){if(prior.draft_id!==draftId || prior.actor!==actor || prior.plan_hash!==hash(input))throw fail('IDEMPOTENCY_CONFLICT','撤销请求与已有记录不一致。');return this.recovery(prior.id);}
    if(!latest || input.selection_id!==latest.id || input.expected_revision!==draft.revision || input.expected_media_revision!==latest.media_revision
      || input.fingerprint!==identity(this.db,draftId))throw fail('MEDIA_REVISION_STALE','媒体状态改变，请刷新后核对撤销。');
    const rows=visualRows(this.db,draftId).filter(row=>json(row.media_metadata_json).manual_article_selection?.id===latest.id);
    if(!rows.length)throw fail('MEDIA_REVOKE_NOT_ACTIVE','该选择已不再有效。');
    const id=randomUUID(),key=`revoke_${latest.id}`,snapshot=rows.map(row=>({row,localPath:row.media_path || undefined}));
    transaction(this.db,()=>{
      if(identity(this.db,draftId)!==input.fingerprint)throw fail('MEDIA_REVISION_STALE','提交前媒体状态改变。');
      for(const row of rows){const history=json(row.media_metadata_json).manual_article_history || [],previous=history.at(-1);
        this.db.prepare("UPDATE article_media_uploads SET state='pending_confirmation' WHERE id=?").run(json(row.media_metadata_json).manual_article_selection.upload_id);
        if(previous?.row){const restored={...previous.row,media_path:previous.localPath || previous.row.media_path};const columns=Object.keys(restored).filter(key=>key!=='id');
          this.db.prepare(`UPDATE article_visuals SET ${columns.map(key=>`${key}=?`).join(',')} WHERE id=?`).run(...columns.map(key=>restored[key]),row.id);
        }else this.db.prepare('DELETE FROM article_visuals WHERE id=?').run(row.id);
      }
      const old=this.db.prepare('SELECT manifest_json FROM article_media_revisions WHERE draft_id=? AND draft_revision=? AND media_revision<? ORDER BY media_revision DESC LIMIT 1').get(draftId,draft.revision,latest.media_revision);
      const baseline=this.db.prepare('SELECT * FROM required_media_manifests WHERE draft_id=? AND revision=?').get(draftId,draft.revision);
      const manifest=old?json(old.manifest_json):{version:2,draftId,revision:draft.revision,contentHash:draft.content_hash,
        slots:baseline?JSON.parse(baseline.slots_json):[],minimumRequired:baseline?.minimum_required || 0,approvedNoImage:Boolean(baseline?.approved_no_image)};
      manifest.mediaRevision=latest.media_revision+1;manifest.manifestHash=hash(manifest);
      const receipt={action:'revoke',revoked_selection_id:latest.id,actor,reason:input.reason,snapshot,provider_calls:0,items:[],delivery:'WAITING_AUTH'};
      this.db.prepare(`INSERT INTO article_media_revisions(id,draft_id,draft_revision,media_revision,plan_hash,idempotency_key,actor,manifest_json,receipt_json,state,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,'revoked',?)`).run(id,draftId,draft.revision,manifest.mediaRevision,hash(input),key,actor,JSON.stringify(manifest),JSON.stringify(receipt),now());
    });return this.recovery(id);
  });}
}
