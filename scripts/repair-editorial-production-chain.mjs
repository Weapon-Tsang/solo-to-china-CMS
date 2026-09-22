// One-off, revision-guarded repair for the 2026-09-22 editorial-media import.
// Plan against a read-only DB, rehearse on a disposable production copy, then apply live.
import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Repository } from '../src/repository.mjs';
import { transaction } from '../src/db.mjs';
import { evaluatePublicationEligibility } from '../src/publication-eligibility.mjs';

const [mode, databaseArg, confirmation] = process.argv.slice(2);
if (!['plan', 'apply'].includes(mode) || !databaseArg) {
  throw new Error('usage: repair-editorial-production-chain.mjs plan|apply DB [CONFIRMATION]');
}
const databasePath = path.resolve(databaseArg);
const isLive = databasePath === '/var/lib/solo-to-china/solo-to-china.sqlite';
if (mode === 'apply' && !isLive && !/work/i.test(path.basename(databasePath))) {
  throw new Error('Apply requires the exact production DB or an explicitly named disposable work DB.');
}
const db = new DatabaseSync(databasePath, { readOnly: mode === 'plan' });
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
if (mode === 'plan') db.exec('PRAGMA query_only=ON');
const repo = new Repository(db);
const targets = [
  { draftId: 'draft_63924329268349768c466fea688d3e3a', revision: 6,
    action: 'refresh_media', visualCount: 2, strategy: '3.7' },
  { draftId: 'draft_0ff3fa83e3c844fc807f8c8f1e1ffe88', revision: 3,
    action: 'refresh_media', visualCount: 2, strategy: '3.7' },
  { draftId: 'draft_d48d54a4cac54f05b5e287f87fac6e00', revision: 2,
    action: 'review_after_quota_cooldown', visualCount: 3, strategy: '3.8' },
];
try {
  const plans = targets.map((target) => {
    const draft = db.prepare(`SELECT ad.id,ad.revision,ad.strategy_version,ad.content_hash,ad.status,
      cb.strategy_version AS brief_strategy_version FROM article_drafts ad
      JOIN content_briefs cb ON cb.id=ad.brief_id WHERE ad.id=?`).get(target.draftId);
    if (!draft || draft.revision !== target.revision || draft.brief_strategy_version !== target.strategy) {
      throw new Error(`Draft or brief changed: ${target.draftId}`);
    }
    if (db.prepare("SELECT 1 FROM jobs WHERE entity_id=? AND status IN ('queued','running')").get(target.draftId)) {
      throw new Error(`Active draft Job exists: ${target.draftId}`);
    }
    const owner = db.prepare(`SELECT production_owner_opportunity_id AS id FROM jobs
      WHERE entity_id=? AND production_owner_opportunity_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`).get(target.draftId)?.id;
    if (!owner || !db.prepare('SELECT 1 FROM content_opportunities WHERE id=? AND approved_at IS NOT NULL').get(owner)) {
      throw new Error(`Approved production owner missing: ${target.draftId}`);
    }
    const visuals = db.prepare('SELECT id,status,source_asset_id FROM article_visuals WHERE draft_id=? ORDER BY slot')
      .all(target.draftId);
    if (visuals.length !== target.visualCount || visuals.some((v) => v.status !== 'generated' || !v.source_asset_id)) {
      throw new Error(`Expected generated source visuals missing: ${target.draftId}`);
    }
    const latest = db.prepare(`SELECT id,type,status,last_failure_code,last_error,updated_at FROM jobs
      WHERE entity_id=? ORDER BY created_at DESC LIMIT 1`).get(target.draftId);
    const eligibility = evaluatePublicationEligibility(db, target.draftId);
    if (target.action === 'refresh_media') {
      if (draft.strategy_version !== target.strategy || latest?.type !== 'compose_frontend_page'
        || latest.status !== 'failed' || latest.last_failure_code !== 'MEDIA_INCOMPLETE'
        || eligibility.passed || eligibility.code !== 'MEDIA_INCOMPLETE'
        || eligibility.missing.some((item) => item.reasons.some((reason) =>
          !['binary_qa_missing', 'quality_qa_missing_or_stale'].includes(reason)))) {
        throw new Error(`Media-revision repair guard failed: ${target.draftId}`);
      }
    } else if (draft.strategy_version !== '3.9' || latest?.type !== 'review_draft'
      || latest.status !== 'failed' || !latest.last_error?.includes('(429)')
      || !eligibility.passed
      || db.prepare('SELECT 1 FROM quality_reviews WHERE draft_id=? AND draft_revision=? LIMIT 1')
        .get(target.draftId, target.revision)) {
      throw new Error(`Quota-review repair guard failed: ${target.draftId}`);
    }
    return { ...target, draft, owner, latest, eligibility,
      visualIds: visuals.map((visual) => visual.id) };
  });
  const snapshot = plans.map(({ draftId, action, draft, latest, visualIds, owner }) => ({
    draftId, action, revision: draft.revision, contentHash: draft.content_hash,
    strategy: draft.strategy_version, briefStrategy: draft.brief_strategy_version,
    latestJobId: latest.id, latestUpdatedAt: latest.updated_at, visualIds, owner,
  }));
  const digest = crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  const output = { mode, productionDatabase: isLive, confirmation: digest, targets: plans.map((plan) => ({
    draftId: plan.draftId, action: plan.action, revision: plan.revision,
    draftStrategy: plan.draft.strategy_version, briefStrategy: plan.draft.brief_strategy_version,
    latestJob: plan.latest, mediaGate: plan.eligibility,
  })) };
  if (mode === 'plan') {
    console.log(JSON.stringify(output, null, 2));
  } else {
    if (confirmation !== digest) throw new Error('Live state differs from confirmed plan.');
    const queued = transaction(db, () => plans.map((plan) => {
      if (plan.action === 'review_after_quota_cooldown') {
        const changed = db.prepare(`UPDATE article_drafts SET strategy_version=? WHERE id=? AND revision=? AND strategy_version='3.9'`)
          .run(plan.strategy, plan.draftId, plan.revision).changes;
        if (changed !== 1) throw new Error(`Strategy correction raced: ${plan.draftId}`);
      }
      const type = plan.action === 'refresh_media' ? 'generate_visuals' : 'review_draft';
      const jobId = repo.enqueue(type, plan.draftId, {
        dedupeKey: `operator-editorial-chain:${plan.draftId}:r${plan.revision}:${type}`,
        productionOwnerOpportunityId: plan.owner, pipelineVersion: 'article_bundle_v1',
        workloadClass: 'historical_recovery',
      });
      if (type === 'review_draft') {
        // The previous job spent three attempts within a minute on 429. Allow a
        // quota cooldown, then make exactly one bounded canary request.
        const earliest = Date.parse(plan.latest.updated_at) + 20 * 60_000;
        const availableAt = new Date(Math.max(Date.now() + 60_000, earliest)).toISOString();
        db.prepare("UPDATE jobs SET available_at=?,next_eligible_at=?,max_attempts=1 WHERE id=? AND status='queued'")
          .run(availableAt, availableAt, jobId);
        return { draftId: plan.draftId, jobId, type, availableAt, maxAttempts: 1 };
      }
      return { draftId: plan.draftId, jobId, type };
    }));
    console.log(JSON.stringify({ ...output, queued }, null, 2));
  }
} finally {
  db.close();
}
