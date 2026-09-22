import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Repository } from '../src/repository.mjs';

const databasePath = path.resolve(process.argv[2] || '');
if (!/(?:work|replay|canary)/i.test(path.basename(databasePath))) {
  throw new Error('Pass an explicit disposable production-copy SQLite file.');
}
const db = new DatabaseSync(databasePath, { readOnly: true });
db.exec('PRAGMA query_only=ON');
try {
  const drafts = db.prepare('SELECT id,title FROM article_drafts ORDER BY created_at').all();
  const repository = new Repository(db);
  const plans = drafts.flatMap(({id}) => repository.planArticlePhotoRefresh([id]).items);
  const mismatches = db.prepare(`SELECT d.id,d.title,d.revision,d.strategy_version AS draft_strategy,
    b.strategy_version AS brief_strategy,
    (SELECT COUNT(*) FROM article_photo_refreshes f WHERE f.draft_id=d.id) AS refresh_count,
    (SELECT f.previous_strategy_version FROM article_photo_refreshes f WHERE f.draft_id=d.id
      ORDER BY f.to_revision DESC LIMIT 1) AS previous_strategy,
    (SELECT f.to_revision FROM article_photo_refreshes f WHERE f.draft_id=d.id
      ORDER BY f.to_revision DESC LIMIT 1) AS refresh_to_revision,
    (SELECT q.strategy_version FROM quality_reviews q WHERE q.draft_id=d.id
      AND q.draft_revision=d.revision ORDER BY q.created_at DESC LIMIT 1) AS review_strategy
    FROM article_drafts d JOIN content_briefs b ON b.id=d.brief_id
    WHERE d.strategy_version != b.strategy_version ORDER BY d.created_at`).all();
  for (const mismatch of mismatches) {
    const plan = plans.find((item) => item.draft_id === mismatch.id);
    if (plan?.reason !== 'article_brief_strategy_mismatch' || plan.disposition !== 'blocked') {
      throw new Error(`Unblocked canonical strategy mismatch: ${mismatch.id}`);
    }
  }
  console.log(JSON.stringify({
    database: path.basename(databasePath),
    quick_check: db.prepare('PRAGMA quick_check').get().quick_check,
    drafts: drafts.length,
    strategy_mismatches: mismatches,
    plan_dispositions: Object.fromEntries(['eligible','blocked','noop'].map((status) => [
      status, plans.filter((plan) => plan.disposition === status).length,
    ])),
    plans: plans.map(({draft_id,title,disposition,reason,revision,strategy_version}) => ({
      draft_id,title,disposition,reason,revision,strategy_version,
    })),
  }, null, 2));
} finally {
  db.close();
}
