// Guarded one-time continuation after 2.0.61 fixes the audited-original gate.
import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Repository } from '../src/repository.mjs';
import { transaction } from '../src/db.mjs';
import { evaluatePublicationEligibility } from '../src/publication-eligibility.mjs';

const [mode, databaseArg, confirmation] = process.argv.slice(2);
if (!['plan','apply'].includes(mode) || !databaseArg) {
  throw new Error('usage: continue-editorial-after-release.mjs plan|apply DB [CONFIRMATION]');
}
const databasePath = path.resolve(databaseArg);
if (mode === 'apply' && databasePath !== '/var/lib/solo-to-china/solo-to-china.sqlite'
  && !/work/i.test(path.basename(databasePath))) throw new Error('Unexpected apply database.');
const db = new DatabaseSync(databasePath, { readOnly: mode === 'plan' });
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
if (mode === 'plan') db.exec('PRAGMA query_only=ON');
try {
  const targets = [
    { id:'draft_63924329268349768c466fea688d3e3a', revision:6, required:2 },
    { id:'draft_0ff3fa83e3c844fc807f8c8f1e1ffe88', revision:3, required:2 },
  ];
  const plans = targets.map((target) => {
    const draft = db.prepare(`SELECT ad.revision,ad.content_hash,ad.strategy_version,
      cb.strategy_version AS brief_strategy_version FROM article_drafts ad
      JOIN content_briefs cb ON cb.id=ad.brief_id WHERE ad.id=?`).get(target.id);
    const gate = evaluatePublicationEligibility(db,target.id);
    const latest = db.prepare(`SELECT id,type,status,last_failure_code,updated_at,
      production_owner_opportunity_id AS owner_id FROM jobs WHERE entity_id=?
      ORDER BY created_at DESC LIMIT 1`).get(target.id);
    const active = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE entity_id=? AND status IN ('queued','running')")
      .get(target.id).n;
    if (!draft || draft.revision !== target.revision || draft.strategy_version !== '3.7'
      || draft.brief_strategy_version !== '3.7' || !gate.passed || gate.ready !== target.required
      || latest?.type !== 'generate_visuals' || latest.status !== 'failed'
      || latest.last_failure_code !== 'MEDIA_INCOMPLETE' || !latest.owner_id || active) {
      throw new Error(`Continuation guard failed for ${target.id}`);
    }
    if (!db.prepare('SELECT 1 FROM content_opportunities WHERE id=? AND approved_at IS NOT NULL')
      .get(latest.owner_id)) throw new Error(`Approved owner missing for ${target.id}`);
    const currentReview = db.prepare(`SELECT 1 FROM quality_reviews WHERE draft_id=? AND draft_revision=?
      AND draft_content_hash=?`).get(target.id,target.revision,draft.content_hash);
    if (currentReview) throw new Error(`Current independent QA already exists for ${target.id}`);
    return { ...target, draft, latest, gate };
  });
  const snapshot = plans.map(({id,draft,latest,gate}) => ({ id, revision:draft.revision,
    contentHash:draft.content_hash, latestJob:latest.id, updatedAt:latest.updated_at,
    owner:latest.owner_id, manifestHash:gate.manifestHash }));
  const digest = crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  const report = { mode, confirmation:digest, targets:snapshot };
  if (mode === 'plan') console.log(JSON.stringify(report,null,2));
  else {
    if (confirmation !== digest) throw new Error('Confirmed plan changed.');
    const repo = new Repository(db);
    const queued = transaction(db, () => plans.map(({id,revision,latest}) => ({ id,
      jobId:repo.enqueue('compose_frontend_page',id,{
        dedupeKey:`operator-post-2.0.61-page:${id}:r${revision}`,
        productionOwnerOpportunityId:latest.owner_id,pipelineVersion:'article_bundle_v1',
        workloadClass:'historical_recovery',
      }),
    })));
    console.log(JSON.stringify({ ...report, queued },null,2));
  }
} finally { db.close(); }
