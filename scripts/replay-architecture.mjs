import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.mjs';
import { Repository } from '../src/repository.mjs';

const work = path.resolve(process.argv[2] || '');
const output = path.resolve(process.argv[3] || '');
if (!process.argv[2] || !process.argv[3] || !/work\.sqlite$/.test(work)
  || !work.startsWith(path.resolve('output/architecture-audit-') ) || !fs.existsSync(work)) {
  throw new Error('Pass the isolated output/architecture-audit-*/...work.sqlite and a report path.');
}
const db = openDatabase(work); // Migrations, if needed, touch only the disposable copy.
const repository = new Repository(db, { sourceUploadsDir:'C:/s01-restore-20260927/source-uploads' });
const all = (sql,...args) => db.prepare(sql).all(...args);
const count = table => db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
const protectedCounts = () => Object.fromEntries(['sources','source_assets','claims','article_drafts',
  'wordpress_publications','model_call_metrics'].map(table=>[table,count(table)]));
const before = protectedCounts();
const report = { version:'architecture-replay-1', baselineAsOf:'2026-09-23 (retained production restore)',
  productionWrites:0, providerCalls:0, wordpressWrites:0, schema:db.prepare('SELECT max(version) v FROM schema_migrations').get().v,
  counts:before, jobs:all('SELECT type,status,count(*) n FROM jobs GROUP BY type,status'),
  modelStages:all(`SELECT stage,provider,count(*) calls,SUM(input_tokens) input_tokens,SUM(output_tokens) output_tokens,
    MAX(input_tokens) largest_input_tokens,SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
    SUM(cost_usd) known_cost_usd,SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) unknown_cost_calls
    FROM model_call_metrics GROUP BY stage,provider ORDER BY calls DESC`),
  repeatedSuccessfulInputs:all(`SELECT stage,provider,count(*) calls,count(DISTINCT run_id) jobs
    FROM model_call_metrics WHERE status='succeeded' AND request_kind<>'cache_hit' AND input_hash<>''
    GROUP BY stage,provider,model,prompt_hash,schema_hash,input_hash,config_hash HAVING count(*)>1 ORDER BY calls DESC LIMIT 30`),
  providerStates:all('SELECT provider,model,consecutive_failures,backoff_until FROM provider_runtime_state'),
};
console.error('Production-copy baseline inspected; auditing source continuity and Knowledge reviews.');
try {
  const gaps=repository.runSourceProcessingGapRecovery();
  report.sourceGaps={gapCount:gaps.gapCount,actionCount:gaps.actionCount,excludedMediaOnlySources:gaps.excludedMediaOnlySources,categoryCounts:gaps.categoryCounts,
    items:gaps.items?.map(({sourceId,category,actions})=>({sourceId,category,actions}))};
  db.exec('BEGIN');
  try {
    const recovered=repository.runSourceProcessingGapRecovery({dryRun:false,approvedFromRunId:gaps.id});
    const jobs=all('SELECT type,entity_id,status FROM jobs WHERE recovery_run_id=?',recovered.id);
    assert.equal(jobs.length,gaps.actionCount);
    assert.ok(jobs.every(job=>job.status==='queued'));
    report.sourceRecoveryReplay={queued:jobs.length,jobs,excludedMediaOnlySources:recovered.excludedMediaOnlySources,
      rollback:true,providerCalls:0};
  } finally { db.exec('ROLLBACK'); }
  const knowledge=repository.runKnowledgeResolutionBackfill();
  report.knowledge={before:knowledge.beforeManualReviewCount,after:knowledge.projectedManualReviewCount,
    evaluated:knowledge.evaluatedCount,counts:knowledge.counts};
  report.productionOwners=all(`SELECT co.id,co.approved_at,co.status,co.candidate_id,ad.id draft_id,ad.status draft_status
    FROM content_opportunities co LEFT JOIN content_briefs cb ON cb.candidate_id=co.candidate_id
    LEFT JOIN article_drafts ad ON ad.brief_id=cb.id WHERE co.approved_at IS NOT NULL`);
  report.unapprovedProductionJobs=all(`SELECT j.id,j.type,j.status,j.production_owner_opportunity_id FROM jobs j
    LEFT JOIN content_opportunities co ON co.id=j.production_owner_opportunity_id
    WHERE j.status IN ('queued','running') AND j.production_owner_opportunity_id IS NOT NULL
      AND (co.id IS NULL OR co.approved_at IS NULL)`);
  report.staleCaptureExperiences=all(`SELECT eb.source_id,count(*) n FROM experience_blocks eb
    JOIN experience_extraction_runs er ON er.id=eb.extraction_run_id
    JOIN sources s ON s.id=eb.source_id WHERE er.capture_version<>s.capture_version GROUP BY eb.source_id`);
  report.orphanActiveSegments=all(`SELECT j.id,j.type FROM jobs j LEFT JOIN source_segments ss ON ss.id=j.entity_id
    WHERE j.status IN ('queued','running') AND j.type IN ('extract_segment_claims','audit_segment_coverage','retry_segment_extraction')
      AND ss.id IS NULL`);

  // Model the real queue's running/queued mix inside a rollback transaction.
  // Force only timing/state; never fabricate article evidence or call a model.
  db.exec('BEGIN');
  try {
    const heavy=db.prepare("SELECT id FROM jobs WHERE type='rebuild_knowledge' ORDER BY updated_at DESC LIMIT 1").get();
    const ingest=all("SELECT id FROM jobs WHERE type='extract_segment_claims' ORDER BY updated_at DESC LIMIT 3");
    assert.ok(heavy && ingest.length===3,'historical queue must contain real rebuild and ingest jobs');
    db.prepare("UPDATE jobs SET status='succeeded' WHERE status IN ('queued','running')").run();
    for (const row of [heavy,...ingest]) db.prepare(`UPDATE jobs SET status='queued',attempts=0,next_eligible_at=NULL,
      available_at='2000-01-01',created_at=?,execution_route='realtime',model_role='unassigned',locked_by=NULL,
      lease_expires_at=NULL WHERE id=?`).run(row===heavy?'2000-01-01':new Date().toISOString(),row.id);
    db.prepare("UPDATE jobs SET status='running',locked_by=?,lease_expires_at='2100-01-01' WHERE id=?")
      .run(repository.workerId,ingest[0].id);
    assert.equal(repository.claimJob(),null,'aged rebuild must drain rather than refill ingest');
    db.prepare("UPDATE jobs SET status='succeeded' WHERE id=?").run(ingest[0].id);
    const claimed=repository.claimJob();assert.equal(claimed.id,heavy.id);
    report.queueReplay={drained:true,nextType:claimed.type,realHistoricalJobs:4,rollback:true};
  } finally { db.exec('ROLLBACK'); }
  report.protectedCountsAfter=protectedCounts();
  assert.deepEqual(report.protectedCountsAfter,before);
  report.protectedCountsPreserved=true;
} catch(error) {
  report.failure={message:error.message,code:error.code};process.exitCode=1;
} finally {
  db.close();fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify({report:output,sourceGaps:report.sourceGaps,knowledge:report.knowledge,
  queueReplay:report.queueReplay,protectedCountsPreserved:report.protectedCountsPreserved,failure:report.failure}));
