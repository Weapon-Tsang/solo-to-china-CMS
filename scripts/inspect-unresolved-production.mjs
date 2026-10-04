// SELECT-only, fixed regression corpus. Never starts workers or providers.
import {DatabaseSync} from 'node:sqlite';
import {Repository} from '../src/repository.mjs';
import fs from 'node:fs';
import path from 'node:path';

if(!process.argv[2])throw new Error('Explicit read-only database required.');
if(!path.resolve(process.argv[2]).startsWith(path.resolve('output')+path.sep))
  throw new Error('Inspect only a local replay copy; export the bounded production sample with SELECT-only SQL first.');
const db=new DatabaseSync(process.argv[2],{readOnly:true});
db.exec('PRAGMA query_only=ON; BEGIN');
const repository=new Repository(db);
const drafts=['draft_5a78fe03455e44ddac1b009e2301c8cb','draft_b736635093994a6f9501daf703362355'];
const sources=['src_6dc34bb235f94932be6587cd906ce317','src_00f770704f8d4635ab3b4a5fe53f963a'];
try {
  const report={version:1,collectedAt:new Date().toISOString(),productionWrites:0,drafts:[],experiences:[]};
  for(const draftId of drafts){
    const pack=repository.getDraftPackage(draftId);
    const brief=db.prepare('SELECT * FROM content_briefs WHERE id=?').get(pack.draft.brief_id);
    const assets=repository.authorizedSourceAssetsForBrief(brief,{packet:pack.writing_packet,limit:1000});
    report.drafts.push({draftId,pack,brief,assets,discovery:repository.sourceVisualDiscoveryCandidates(draftId),
      photoAudits:repository.sourceVisualPhotoAuditCandidates(draftId),repair:repository.mediaRepairPlan(draftId),
      visuals:repository.listDraftVisuals(draftId),
      candidates:db.prepare('SELECT * FROM visual_candidates WHERE draft_id=? ORDER BY created_at').all(draftId),
      files:assets.map(a=>({id:a.id,path:a.local_path,exists:Boolean(a.local_path&&fs.existsSync(a.local_path))}))});
  }
  for(const sourceId of sources)report.experiences.push(repository.getExperienceExtractionPackage(sourceId));
  report.unknownDispatch=db.prepare("SELECT * FROM media_dispatches WHERE id='bc3eda67-f65a-47c4-b82a-adde1b6d41e2'").get();
  report.unknownVisual=db.prepare("SELECT * FROM article_visuals WHERE id='visual_1c542c3e15834cb48656ce5e537f44bd'").get();
  report.lane=db.prepare('SELECT * FROM media_visual_lane WHERE id=1').get();
  console.log(JSON.stringify(report,(key,value)=> /(?:data_url|raw_payload_json)$/i.test(key)?undefined:value));
} finally{db.exec('ROLLBACK');db.close();}
