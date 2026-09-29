import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Repository } from '../src/repository.mjs';
import { transaction } from '../src/db.mjs';
import { boilerplateTitleSubject, evidenceTitle } from '../src/editorial-title.mjs';
import { selectedFamilyProjection, createFamilyProjectionContext } from '../src/opportunity-family-evidence.mjs';

const parse = value => JSON.parse(value || '{}');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function previewTitleRepair(db) {
  const opportunities = db.prepare('SELECT * FROM content_opportunities ORDER BY id').all();
  const candidates = db.prepare('SELECT * FROM topic_candidates').all();
  const briefs = db.prepare('SELECT * FROM content_briefs').all();
  const jobs = db.prepare(`SELECT * FROM jobs WHERE status IN ('queued','running')
    OR id IN (SELECT job_id FROM vertex_batch_items WHERE status IN ('preparing','submitted'))`).all();
  const publications = db.prepare('SELECT * FROM wordpress_publications').all();
  let familyContext;
  const records = [];
  for (const opportunity of opportunities) {
    const subject = boilerplateTitleSubject(opportunity.title);
    if (!subject) continue;
    const coverage = parse(opportunity.coverage_json);
    const linked = candidates.some(candidate => candidate.opportunity_id === opportunity.id || candidate.id === opportunity.candidate_id);
    const protectedRecord = opportunity.approved_at || opportunity.candidate_id || coverage.approval || linked
      || !['recommended', 'deferred', 'suppressed'].includes(opportunity.status)
      || !['recommended', 'recommended_again', 'deferred'].includes(opportunity.lifecycle_state)
      || jobs.some(job => job.entity_id === opportunity.id || job.production_owner_opportunity_id === opportunity.id)
      || db.prepare('SELECT 1 FROM editorial_assemblies WHERE opportunity_id=? LIMIT 1').get(opportunity.id);
    const selected = protectedRecord ? [] : selectedFamilyProjection(db, opportunity,
      familyContext ||= createFamilyProjectionContext(db)).facts;
    records.push({ kind: 'opportunity', id: opportunity.id, before: opportunity.title,
      after: protectedRecord ? opportunity.title : evidenceTitle(subject, selected),
      blocked: Boolean(protectedRecord), reason: protectedRecord ? 'approved_or_production_bound' : 'unapproved_opportunity',
      fingerprint: hash(opportunity) });
  }
  for (const draft of db.prepare('SELECT * FROM article_drafts ORDER BY id').all()) {
    const subject = boilerplateTitleSubject(draft.title);
    if (!subject) continue;
    const brief = briefs.find(row => row.id === draft.brief_id);
    const candidate = candidates.find(row => row.id === brief?.candidate_id);
    const owners = opportunities.filter(row => row.candidate_id === candidate?.id || row.id === candidate?.opportunity_id);
    const entityIds = new Set([draft.id, brief?.id, candidate?.id, ...owners.map(row => row.id)].filter(Boolean));
    const published = publications.some(row => row.draft_id === draft.id)
      || db.prepare('SELECT 1 FROM frontend_publish_compositions WHERE draft_id=? AND wordpress_post_id IS NOT NULL LIMIT 1').get(draft.id)
      || /published|synced|wordpress|delivered/iu.test(draft.status)
      || owners.some(row => /published|delivered/iu.test(`${row.status} ${row.lifecycle_state}`));
    const active = jobs.some(job => entityIds.has(job.entity_id) || entityIds.has(job.production_owner_opportunity_id));
    const protectedRecord = published || active || !brief || !['review', 'approved', 'qa_failed'].includes(draft.status);
    const ledger = JSON.parse(draft.evidence_ledger_json || '[]');
    const selected = ledger.map(entry => entry.fact_snapshot).filter(Boolean);
    records.push({ kind: 'draft', id: draft.id, before: draft.title,
      after: protectedRecord ? draft.title : evidenceTitle(subject, selected), blocked: Boolean(protectedRecord),
      reason: published ? 'published_or_wordpress_bound' : active ? 'active_production_job' : protectedRecord ? 'production_or_unknown_state' : 'idle_unpublished_draft',
      fingerprint: hash({ draft, brief, candidate, owners }) });
  }
  return { version: 1, records, changed: records.filter(row => !row.blocked && row.before !== row.after).length,
    protected: records.filter(row => row.blocked).length };
}

export function applyTitleRepair(db, preview) {
  return transaction(db, () => {
    const current = previewTitleRepair(db);
    if (hash(current) !== hash(preview)) throw new Error('Stale title preview; regenerate after state/evidence changes');
    const repository = new Repository(db);
    const changed = [];
    for (const row of current.records.filter(row => !row.blocked && row.before !== row.after)) {
      if (row.kind === 'opportunity') db.prepare("UPDATE content_opportunities SET title=?,coverage_json=json_set(coverage_json,'$.titlePolicy','evidence-v1') WHERE id=?").run(row.after, row.id);
      else repository.updateDraftMetadata(row.id, { title: row.after }, { enqueueReview: false, preserveVisuals: true });
      changed.push({ kind: row.kind, id: row.id, before: row.before, after: row.after });
    }
    return { changed, protected: current.protected };
  });
}

// DEVELOPMENT tool: writes only to explicitly named disposable work databases.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [filename, ...flags] = process.argv.slice(2);
  if (!filename || flags.some(flag => flag !== '--apply-work-copy')) throw new Error('Usage: node scripts/repair-editorial-titles.mjs DATABASE [--apply-work-copy]');
  const apply = flags.includes('--apply-work-copy');
  if (!fs.existsSync(filename)) throw new Error('Database must already exist');
  if (apply && !/(?:^|[-_])work\.sqlite$/iu.test(path.basename(filename))) throw new Error('Apply requires a disposable *work.sqlite database');
  const db = new DatabaseSync(filename, { readOnly: !apply });
  try {
    const preview = previewTitleRepair(db);
    console.log(JSON.stringify(apply ? applyTitleRepair(db, preview) : preview, null, 2));
  } finally { db.close(); }
}
