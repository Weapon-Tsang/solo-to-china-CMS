// One bounded QA retry after two other production article reviews succeeded.
import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Repository } from '../src/repository.mjs';
import { transaction } from '../src/db.mjs';
import { evaluatePublicationEligibility } from '../src/publication-eligibility.mjs';

const [mode,databaseArg,confirmation] = process.argv.slice(2);
if (!['plan','apply'].includes(mode) || !databaseArg) throw new Error('usage: retry-ferry-review-once.mjs plan|apply DB [CONFIRMATION]');
const filename = path.resolve(databaseArg);
if (mode === 'apply' && filename !== '/var/lib/solo-to-china/solo-to-china.sqlite'
  && !/work/i.test(path.basename(filename))) throw new Error('Unexpected apply database.');
const db = new DatabaseSync(filename, { readOnly:mode === 'plan' });
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
if (mode === 'plan') db.exec('PRAGMA query_only=ON');
try {
  const id = 'draft_d48d54a4cac54f05b5e287f87fac6e00';
  const draft = db.prepare(`SELECT ad.revision,ad.strategy_version,ad.content_hash,
    cb.strategy_version AS brief_strategy_version FROM article_drafts ad
    JOIN content_briefs cb ON cb.id=ad.brief_id WHERE ad.id=?`).get(id);
  const gate = evaluatePublicationEligibility(db,id);
  const latest = db.prepare(`SELECT id,type,status,last_failure_code,last_error,updated_at,
    production_owner_opportunity_id AS owner_id FROM jobs WHERE entity_id=? ORDER BY created_at DESC LIMIT 1`).get(id);
  const active = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE entity_id=? AND status IN ('queued','running')")
    .get(id).n;
  const independentReview = db.prepare(`SELECT 1 FROM quality_reviews WHERE draft_id=? AND draft_revision=?
    AND draft_content_hash=?`).get(id,2,draft?.content_hash);
  const successfulPeerReviews = db.prepare(`SELECT COUNT(DISTINCT entity_id) AS n FROM jobs
    WHERE type='review_draft' AND status='succeeded' AND updated_at>? AND entity_id IN (?,?)`)
    .get(latest?.updated_at || '', 'draft_63924329268349768c466fea688d3e3a',
      'draft_0ff3fa83e3c844fc807f8c8f1e1ffe88').n;
  if (!draft || draft.revision !== 2 || draft.strategy_version !== '3.8'
    || draft.brief_strategy_version !== '3.8' || !gate.passed || gate.ready !== 3
    || latest?.type !== 'review_draft' || latest.status !== 'failed'
    || latest.last_failure_code !== 'PROVIDER_REQUEST_FAILED' || !latest.last_error?.includes('(500)')
    || !latest.owner_id || active || independentReview || successfulPeerReviews !== 2
    || !db.prepare('SELECT 1 FROM content_opportunities WHERE id=? AND approved_at IS NOT NULL').get(latest.owner_id)) {
    throw new Error('Ferry review canary guard failed.');
  }
  const snapshot = { id,revision:draft.revision,contentHash:draft.content_hash,
    strategy:draft.strategy_version,manifestHash:gate.manifestHash,
    latestFailedJob:latest.id,latestUpdatedAt:latest.updated_at,owner:latest.owner_id,
    successfulPeerReviews };
  const digest = crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  if (mode === 'plan') console.log(JSON.stringify({mode,confirmation:digest,snapshot},null,2));
  else {
    if (confirmation !== digest) throw new Error('Confirmed plan changed.');
    const queued = transaction(db, () => {
      const repo = new Repository(db);
      const jobId = repo.enqueue('review_draft',id,{
        dedupeKey:`operator-ferry-review-after-2-peers:${id}:r2`,productionOwnerOpportunityId:latest.owner_id,
        pipelineVersion:'article_bundle_v1',workloadClass:'historical_recovery',
      });
      db.prepare("UPDATE jobs SET max_attempts=1 WHERE id=? AND status='queued'").run(jobId);
      return { jobId,maxAttempts:1 };
    });
    console.log(JSON.stringify({mode,confirmation:digest,snapshot,queued},null,2));
  }
} finally { db.close(); }
