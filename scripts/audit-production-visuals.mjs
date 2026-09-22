import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Repository} from '../src/repository.mjs';

const databasePath=path.resolve(process.argv[2] || '');
if (!/(?:replay|work|canary)/i.test(path.basename(databasePath))) {
  throw new Error('Pass an explicit production-copy replay/work/canary SQLite file. The live database is refused.');
}
const db=new DatabaseSync(databasePath,{readOnly:true});
db.exec('PRAGMA query_only=ON');
const generic=new Set(['photo','image','chongqing','travel','guide','city','street','article','source','visual']);
const drafts=db.prepare(`SELECT d.id,d.title,d.status,d.revision,d.strategy_version,
  COUNT(v.id) AS visual_count,SUM(CASE WHEN v.status='generated' THEN 1 ELSE 0 END) AS generated_count
  FROM article_drafts d LEFT JOIN article_visuals v ON v.draft_id=d.id
  GROUP BY d.id ORDER BY d.created_at`).all();
const manifests=db.prepare('SELECT draft_id,revision,minimum_required,slots_json FROM required_media_manifests').all();
const visuals=db.prepare(`SELECT v.id,v.draft_id,v.slot,v.status,v.caption,v.alt_text,v.image_subject,v.source_asset_id,
  saa.asset_kind,saa.analysis_status,saa.primary_subjects_json FROM article_visuals v
  LEFT JOIN source_asset_analyses saa ON saa.asset_id=v.source_asset_id`).all();
const byVisual=new Map(visuals.map((row)=>[row.id,row]));
const missingManifestSlots=manifests.flatMap((manifest)=>{
  const draft=drafts.find((row)=>row.id===manifest.draft_id);
  if (!draft || Number(draft.revision)!==Number(manifest.revision)) return [];
  return parse(manifest.slots_json,[]).filter((slot)=>slot.required && !byVisual.has(slot.slotId))
    .map((slot)=>({draft_id:manifest.draft_id,slot:slot.slot,slot_id:slot.slotId}));
});
const unknownQa=db.prepare(`SELECT md.id AS dispatch_id,md.visual_id,md.error_code,md.started_at_ms,
  vc.id AS candidate_id,vc.output_hash AS candidate_hash,vc.media_path,vc.status AS candidate_status
  FROM media_dispatches md LEFT JOIN visual_candidates vc ON vc.visual_id=md.visual_id
    AND vc.status='pending_qa' WHERE md.state='outcome_unknown' AND md.substage='visual_quality_qa'
  ORDER BY md.started_at_ms DESC`).all();
const cardKinds=new Set(['photo_collage','editorial_infographic','map_or_route','handwritten_card']);
const suspiciousVisuals=visuals.filter((visual)=>visual.analysis_status==='ready' && cardKinds.has(visual.asset_kind))
  .map((visual)=>{
    const requested=tokens(visual.image_subject);
    const depicted=tokens(parse(visual.primary_subjects_json,[]).join(' '));
    const specific=[...requested].filter((token)=>!generic.has(token));
    const overlap=specific.filter((token)=>depicted.has(token));
    return {draft_id:visual.draft_id,visual_id:visual.id,slot:visual.slot,status:visual.status,
      image_subject:visual.image_subject,pixel_subjects:parse(visual.primary_subjects_json,[]),caption:visual.caption,
      overlap:overlap.length,specific_tokens:specific.length};
  }).filter((item)=>item.specific_tokens>=1 && item.overlap===0);
const activeJobs=db.prepare("SELECT id,type,entity_id,status FROM jobs WHERE status IN ('queued','running')").all();
const modelStages=db.prepare(`SELECT stage,COUNT(*) AS calls,SUM(COALESCE(input_tokens,0)) AS input_tokens,
  SUM(COALESCE(output_tokens,0)) AS output_tokens,MAX(input_tokens) AS max_input_tokens
  FROM model_call_metrics WHERE created_at>=datetime('now','-14 days') GROUP BY stage ORDER BY input_tokens DESC LIMIT 12`).all();
const repository=new Repository(db);
const oldPage=repository.getEntityResolutionPackage('chongqing',300);
const newPage=repository.getEntityResolutionPackage('chongqing',80);
const oldAliases=repository.listEntityAliases('chongqing');
const entityContextSample={destination:'chongqing',old_claims:oldPage.claims.length,
  old_aliases:oldAliases.length,old_input_bytes:Buffer.byteLength(JSON.stringify({...oldPage,known_aliases:oldAliases})),
  new_claims:newPage.claims.length,new_aliases:newPage.known_aliases.length,
  new_input_bytes:Buffer.byteLength(JSON.stringify(newPage))};
const result={version:'production-visual-audit-1',database:path.basename(databasePath),read_only:true,
  quick_check:db.prepare('PRAGMA quick_check').get(),draft_count:drafts.length,visual_count:visuals.length,
  zero_visual_drafts:drafts.filter((draft)=>draft.visual_count===0),missing_manifest_slots:missingManifestSlots,
  unknown_qa_dispatches:unknownQa,suspicious_analyzed_cards:suspiciousVisuals,active_jobs:activeJobs,
  model_stages:modelStages,entity_context_sample:entityContextSample};
db.close();
console.log(JSON.stringify(process.argv.includes('--summary') ? {
  draft_count:result.draft_count,visual_count:result.visual_count,
  zero_visual_count:result.zero_visual_drafts.length,missing_manifest_slot_count:result.missing_manifest_slots.length,
  unknown_qa_count:result.unknown_qa_dispatches.length,suspicious_card_count:result.suspicious_analyzed_cards.length,
  active_job_count:result.active_jobs.length,entity_context_sample:result.entity_context_sample,
} : result,null,2));

function parse(value,fallback){try{return JSON.parse(value || '');}catch{return fallback;}}
function tokens(value){return new Set(String(value || '').toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) || []);}
