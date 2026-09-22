// One-time repair for drafts whose strategy was changed by the old photo-refresh path.
// Refuses any case without an unbroken, unchanged-text QA reuse chain.
import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Repository } from '../src/repository.mjs';
import { transaction } from '../src/db.mjs';

const TARGETS = [
  'draft_ba8ccf5e73a1425285676bfaa9a18287',
  'draft_ac2559c3c4c24d0bbee23daf89a2ddf0',
  'draft_359330e87f9c4f24b97fa88bf499d448',
  'draft_514305818f534265b7a0f8a8d81d1d9d',
];
const [mode, databaseArg, confirmation] = process.argv.slice(2);
if (!['plan','apply'].includes(mode) || !databaseArg) {
  throw new Error('usage: repair-photo-refresh-strategy.mjs plan|apply DB [CONFIRMATION]');
}
const databasePath = path.resolve(databaseArg);
if (mode === 'apply' && databasePath !== '/var/lib/solo-to-china/solo-to-china.sqlite'
  && !/(?:work|replay)/i.test(path.basename(databasePath))) {
  throw new Error('Apply requires the exact production DB or a disposable work/replay copy.');
}
const db = new DatabaseSync(databasePath, { readOnly: mode === 'plan' });
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
if (mode === 'plan') db.exec('PRAGMA query_only=ON');
try {
  const cases = TARGETS.map((id) => {
    const draft = db.prepare(`SELECT d.id,d.revision,d.strategy_version,d.content_hash,
      b.strategy_version AS brief_strategy FROM article_drafts d
      JOIN content_briefs b ON b.id=d.brief_id WHERE d.id=?`).get(id);
    if (!draft || draft.strategy_version !== '3.9' || !['3.3','3.8'].includes(draft.brief_strategy)) {
      throw new Error(`Unexpected draft or brief strategy: ${id}`);
    }
    const active = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE entity_id=? AND status IN ('queued','running')")
      .get(id).n;
    if (active) throw new Error(`Active job prevents strategy repair: ${id}`);
    const chain = db.prepare(`SELECT id,from_revision,to_revision,previous_strategy_version,reused_review_id
      FROM article_photo_refreshes WHERE draft_id=? ORDER BY from_revision`).all(id);
    if (!chain.length || chain[0].previous_strategy_version !== draft.brief_strategy
      || chain.at(-1).to_revision !== draft.revision) {
      throw new Error(`No complete canonical photo-refresh chain: ${id}`);
    }
    let expectedFrom = chain[0].from_revision;
    let priorReviewId = null;
    let evidenceHash = null;
    const cloneIds = [];
    for (const [index, step] of chain.entries()) {
      if (step.from_revision !== expectedFrom || step.to_revision !== expectedFrom + 1
        || (index && step.reused_review_id !== priorReviewId)
        || step.previous_strategy_version !== (index ? '3.9' : draft.brief_strategy)) {
        throw new Error(`Broken photo-refresh revision or review chain: ${id}`);
      }
      const previous = db.prepare('SELECT * FROM quality_reviews WHERE id=?').get(step.reused_review_id);
      const clones = db.prepare(`SELECT * FROM quality_reviews WHERE draft_id=? AND draft_revision=?
        ORDER BY created_at`).all(id,step.to_revision);
      const clone = clones.find((review) => review.reviewer === `reused_unchanged_text:${step.reused_review_id}`);
      if (!previous || !clone || clones.length !== 1 || !previous.passed || !clone.passed
        || previous.draft_revision !== step.from_revision || clone.strategy_version !== '3.9'
        || previous.draft_content_hash !== draft.content_hash
        || clone.draft_content_hash !== draft.content_hash
        || previous.evidence_hash !== clone.evidence_hash
        || (evidenceHash && clone.evidence_hash !== evidenceHash)
        || (index === 0 && (previous.strategy_version !== draft.brief_strategy
          || previous.reviewer.startsWith('reused_unchanged_text:')))) {
        throw new Error(`Unproven unchanged-text QA reuse: ${id}`);
      }
      evidenceHash = clone.evidence_hash;
      priorReviewId = clone.id;
      cloneIds.push(clone.id);
      expectedFrom = step.to_revision;
    }
    return { id, revision:draft.revision, contentHash:draft.content_hash,
      fromStrategy:'3.9', toStrategy:draft.brief_strategy,
      refreshIds:chain.map((step)=>step.id), cloneIds, evidenceHash };
  });
  const digest = crypto.createHash('sha256').update(JSON.stringify(cases)).digest('hex');
  if (mode === 'plan') console.log(JSON.stringify({mode,confirmation:digest,cases},null,2));
  else {
    if (confirmation !== digest) throw new Error('Confirmed strategy repair plan changed.');
    const modelCallsBefore = db.prepare('SELECT COUNT(*) AS n FROM model_call_metrics').get().n;
    transaction(db, () => {
      for (const item of cases) {
        const updatedDraft = db.prepare(`UPDATE article_drafts SET strategy_version=?
          WHERE id=? AND revision=? AND content_hash=? AND strategy_version=?`)
          .run(item.toStrategy,item.id,item.revision,item.contentHash,item.fromStrategy);
        if (updatedDraft.changes !== 1) throw new Error(`Draft changed: ${item.id}`);
        for (const reviewId of item.cloneIds) {
          const updatedReview = db.prepare(`UPDATE quality_reviews SET strategy_version=?
            WHERE id=? AND strategy_version='3.9'`).run(item.toStrategy,reviewId);
          if (updatedReview.changes !== 1) throw new Error(`QA changed: ${reviewId}`);
        }
      }
    });
    if (db.prepare('SELECT COUNT(*) AS n FROM model_call_metrics').get().n !== modelCallsBefore) {
      throw new Error('Unexpected model call during deterministic repair.');
    }
    const repository = new Repository(db);
    const plans = TARGETS.map((id) => repository.planArticlePhotoRefresh([id]).items[0]);
    if (plans.some((plan) => plan.reason === 'article_brief_strategy_mismatch')) {
      throw new Error('Strategy mismatch remains after repair.');
    }
    console.log(JSON.stringify({mode,confirmation:digest,changedDrafts:cases.length,
      changedClonedReviews:cases.reduce((sum,item)=>sum+item.cloneIds.length,0),
      modelCallsAdded:0,postRepairPlans:plans.map(({draft_id,disposition,reason})=>({draft_id,disposition,reason}))},null,2));
  }
} finally { db.close(); }
