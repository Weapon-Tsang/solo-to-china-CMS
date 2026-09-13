import { openDatabase } from '../src/db.mjs';
import { Repository } from '../src/repository.mjs';
import { CONTENT_STRATEGY } from '../src/content-strategy.mjs';

const databasePath = process.argv[2] || process.env.DATABASE_PATH;
if (!databasePath) throw new Error('Database path is required');
const db = openDatabase(databasePath);
const repository = new Repository(db, { contentStrategy: CONTENT_STRATEGY });
const count = (sql) => Number(db.prepare(sql).get().n || 0);
const snapshot = () => ({
  actionable: count("SELECT COUNT(*) AS n FROM content_opportunities WHERE inbox_state='ACTIONABLE'"),
  sourceBacked: count("SELECT COUNT(*) AS n FROM content_opportunities WHERE inbox_state='ACTIONABLE' AND source_id IS NOT NULL"),
  knowledge: count("SELECT COUNT(*) AS n FROM content_opportunities WHERE inbox_state='ACTIONABLE' AND source_id IS NULL AND json_extract(coverage_json,'$.knowledgeEventGenerated')=1"),
  activeJobs: count("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')"),
  modelCalls: count('SELECT COUNT(*) AS n FROM model_call_metrics'),
  wordpressJobs: count("SELECT COUNT(*) AS n FROM jobs WHERE type='push_wordpress_draft'"),
  drafts: count('SELECT COUNT(*) AS n FROM article_drafts'),
});

const before = snapshot();
const destinations = db.prepare('SELECT slug FROM destinations ORDER BY slug').all().map((row) => row.slug);
const started = performance.now();
const rebuilt = [];
for (const destination of destinations) {
  const topicClusters = repository.rebuildTopicClusters(destination);
  const knowledge = repository.rebuildKnowledgeOpportunities(destination);
  const coverage = repository.rebuildCoverageMatrices(destination);
  rebuilt.push({ destination, topicClusters, knowledge, coverage });
}
const reconciliation = repository.reconcileRecommendationInbox();
const durationMs = Math.round(performance.now() - started);
const after = snapshot();
if (after.modelCalls !== before.modelCalls) throw new Error('Deterministic reconciliation created a model call');
if (after.activeJobs !== before.activeJobs) throw new Error('Deterministic reconciliation changed the active job queue');
if (after.wordpressJobs !== before.wordpressJobs || after.drafts !== before.drafts) {
  throw new Error('Deterministic reconciliation changed WordPress or draft state');
}
db.exec('PRAGMA wal_checkpoint(PASSIVE)');
db.close();
process.stdout.write(`${JSON.stringify({ generatedAt: new Date().toISOString(), databasePath,
  strategyVersion: CONTENT_STRATEGY.version, destinations: destinations.length, durationMs,
  before, after, reconciliation, rebuilt }, null, 2)}\n`);
