import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { recoverLegacyVisualReceipts } from '../src/services/legacy-visual-receipts.mjs';

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const databasePath = process.env.DATABASE_PATH;
const mediaDir = process.env.GENERATED_MEDIA_DIR;
if (!path.isAbsolute(databasePath || '') || !path.isAbsolute(mediaDir || '')) {
  throw new Error('DATABASE_PATH and GENERATED_MEDIA_DIR must be absolute paths.');
}
const db = new DatabaseSync(databasePath, { readOnly: !apply });
try {
  db.exec('PRAGMA busy_timeout=5000');
  const requested=process.argv.slice(2).filter((arg)=>arg.startsWith('--draft='))
    .flatMap((arg)=>arg.slice('--draft='.length).split(',')).filter(Boolean);
  const draftIds=requested.length ? [...new Set(requested)]
    : db.prepare('SELECT id FROM article_drafts ORDER BY created_at').all().map((row)=>row.id);
  const result=[];
  for (const draftId of draftIds) {
    if (apply && db.prepare("SELECT 1 FROM jobs WHERE entity_id=? AND status IN ('queued','running') LIMIT 1")
      .get(draftId)) {
      result.push({draftId,skipped:'active_job'});
      continue;
    }
    const receipts=recoverLegacyVisualReceipts(db,draftId,mediaDir,{apply});
    result.push({draftId,receiptCount:receipts.length,visualIds:receipts.map((item)=>item.id)});
  }
  console.log(JSON.stringify({mode:apply?'apply':'dry_run',result},null,2));
} finally { db.close(); }
