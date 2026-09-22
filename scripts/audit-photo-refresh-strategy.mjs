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
    mismatch.refresh_chain = db.prepare(`SELECT f.from_revision,f.to_revision,f.previous_strategy_version,
      f.reused_review_id,q.reviewer,q.strategy_version AS reused_review_strategy,
      cq.reviewer AS current_reviewer,cq.strategy_version AS current_review_strategy,
      cq.passed AS current_review_passed,cq.draft_content_hash AS current_review_hash,
      d.content_hash AS draft_content_hash
      FROM article_photo_refreshes f JOIN article_drafts d ON d.id=f.draft_id
      LEFT JOIN quality_reviews q ON q.id=f.reused_review_id
      LEFT JOIN quality_reviews cq ON cq.draft_id=f.draft_id AND cq.draft_revision=f.to_revision
        AND cq.reviewer=('reused_unchanged_text:' || f.reused_review_id)
      WHERE f.draft_id=? ORDER BY f.from_revision`).all(mismatch.id);
    mismatch.active_jobs = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE entity_id=? AND status IN ('queued','running')")
      .get(mismatch.id).n;
    const plan = plans.find((item) => item.draft_id === mismatch.id);
    if (plan?.reason !== 'article_brief_strategy_mismatch' || plan.disposition !== 'blocked') {
      throw new Error(`Unblocked canonical strategy mismatch: ${mismatch.id}`);
    }
  }
  console.log(JSON.stringify({
    database: path.basename(databasePath),
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
