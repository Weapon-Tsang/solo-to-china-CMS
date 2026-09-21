import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { Repository } from '../src/repository.mjs';
import { auditSourcePhoto, closeLocalPhotoAudit } from '../src/local-photo-audit.mjs';

const option=(name)=>{
  const index=process.argv.indexOf(name);
  return index<0 ? null : process.argv[index+1];
};
const database=path.resolve(option('--database') || '');
const mediaRoot=path.resolve(option('--media-root') || '');
const output=option('--output');
if (!/(?:work|replay)/i.test(path.basename(database)) || !fs.existsSync(database)
  || !fs.existsSync(path.join(mediaRoot,'source-uploads'))) {
  throw new Error('Use an existing disposable work/replay database and an extracted source-media root.');
}
const limit=Math.max(1,Math.min(5000,Number(option('--limit') || 5000)));
const planOnly=process.argv.includes('--plan-only');
const db=openDatabase(database);
const repository=new Repository(db);
const oldRoot='/var/lib/solo-to-china/source-uploads/';
const localRoot=path.join(mediaRoot,'source-uploads');
const baseCounts={drafts:db.prepare('SELECT COUNT(*) n FROM article_drafts').get().n,
  assets:db.prepare('SELECT COUNT(*) n FROM source_assets').get().n,
  modelCalls:db.prepare('SELECT COUNT(*) n FROM model_call_metrics').get().n};
const report={database,mediaRoot,baseCounts,audits:{scanned:0,eligible:0,needsReview:0,missing:0},articles:[]};
try {
  const rows=planOnly ? [] : db.prepare(`SELECT sa.id,sa.local_path,sa.original_sha256,COALESCE(saa.asset_kind,'unknown') asset_kind
    FROM current_source_assets sa LEFT JOIN source_asset_analyses saa ON saa.asset_id=sa.id
    WHERE sa.kind='image' AND sa.storage_status='saved' AND sa.original_bytes_status='saved_original'
      AND sa.durability_status='ORIGINAL_STORED' AND sa.source_id IN (
        SELECT DISTINCT linked.source_id FROM article_visuals av
        JOIN source_assets linked ON linked.id=av.source_asset_id
      ) ORDER BY sa.source_id,sa.position LIMIT ?`).all(limit);
  const updatePath=db.prepare('UPDATE source_assets SET local_path=? WHERE id=?');
  const cached=new Map();
  for (const row of rows) {
    report.audits.scanned++;
    if (!row.local_path.startsWith(oldRoot)) throw new Error(`Unexpected source path for ${row.id}`);
    const localPath=path.join(localRoot,...row.local_path.slice(oldRoot.length).split('/'));
    if (!fs.existsSync(localPath)) {report.audits.missing++;continue;}
    updatePath.run(localPath,row.id);
    const auditKey=`${row.original_sha256}:${row.asset_kind}`;
    let audit=cached.get(auditKey);
    if (!audit) {
      audit=await auditSourcePhoto(localPath,{assetKind:row.asset_kind});
      cached.set(auditKey,audit);
    }
    repository.saveLocalPhotoAudit(row.id,audit);
    if (audit.status==='eligible') report.audits.eligible++;
    else report.audits.needsReview++;
  }
  const ids=db.prepare('SELECT id FROM article_drafts ORDER BY created_at').all().map((row)=>row.id);
  for (const id of ids) {
    const plan=repository.planArticlePhotoRefresh([id]);
    report.articles.push({draftId:id,title:plan.items[0].title,status:plan.items[0].status,
      disposition:plan.items[0].disposition,reason:plan.items[0].reason,
      repairSlots:plan.items[0].media?.slots.filter((slot)=>slot.disposition==='repair').length || 0,
      removeSlots:plan.items[0].media?.slots.filter((slot)=>slot.disposition==='remove').length || 0,
      blockedSlots:plan.items[0].media?.slots.filter((slot)=>slot.disposition==='blocked').length || 0,
      modelCalls:plan.items[0].media?.slots.reduce((sum,slot)=>sum+slot.max_model_calls,0) || 0});
  }
  report.modelCallsAfter=db.prepare('SELECT COUNT(*) n FROM model_call_metrics').get().n;
  if (report.modelCallsAfter!==baseCounts.modelCalls) throw new Error('Local photo audit unexpectedly wrote model metrics.');
  report.integrity=db.prepare('PRAGMA quick_check').get().quick_check;
  if (output) fs.writeFileSync(path.resolve(output),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} finally {
  await closeLocalPhotoAudit();
  db.close();
}
