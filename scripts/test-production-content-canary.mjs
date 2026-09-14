import path from "node:path";
import { createApplication } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";
import { executeContentRecovery } from "../src/services/content-recovery.mjs";

const args = parseArgs(process.argv.slice(2));
if (process.env.ALLOW_REAL_PROVIDER_CANARY !== "1") {
  throw new Error("Set ALLOW_REAL_PROVIDER_CANARY=1 to authorize this bounded paid-provider canary.");
}
if (!args.database) throw new Error("--database must identify a disposable production-copy work database.");
const databasePath = path.resolve(args.database);
if (!/(?:canary|replay|work)/i.test(path.basename(databasePath))) {
  throw new Error("The canary database filename must contain canary, replay, or work; the live production database is refused.");
}
if (!process.env.GOOGLE_CLOUD_PROJECT) throw new Error("GOOGLE_CLOUD_PROJECT is required for the Vertex canary.");

const config = loadConfig({
  ...process.env,
  DATABASE_PATH: databasePath,
  HOST: "127.0.0.1",
  PORT: "0",
  PROCESS_ISOLATION_ENABLED: "false",
  AI_CONCURRENCY_MODE: "fixed",
  AI_CONCURRENCY_INITIAL: "1",
  AI_CONCURRENCY_MAX: "1",
  AI_REQUEST_SPACING_MS: String(args.spacingMs),
  VERTEX_AI_BATCH_ENABLED: "false",
  IMAGE_ENABLED: "false",
  IMAGE_PROVIDER: "none",
  WORDPRESS_SITE_URL: "",
  WORDPRESS_USERNAME: "",
  WORDPRESS_APPLICATION_PASSWORD: "",
  FRONTEND_COMPONENT_REGISTRY_SOURCE: "canary://persisted-registry",
  FRONTEND_PAGE_SCHEMA_SOURCE: "canary://persisted-page-schema",
  FRONTEND_PUBLISH_PACKAGE_SCHEMA_SOURCE: "canary://persisted-publish-schema",
  MAINTENANCE_ENABLED: "false",
});

const app = createApplication(config);
const { repository, pipeline } = app;
const startedAt = new Date().toISOString();
const callsBefore = modelCallCount(repository);
const protectedBefore = protectedCounts(repository);
const startupJobs = repository.db.prepare("SELECT id FROM jobs WHERE status IN ('queued','running')").all();
if (startupJobs.length) {
  repository.db.prepare(`UPDATE jobs SET status='failed',failure_class='permanent_input',last_failure_code='CANARY_STARTUP_SKIPPED',
    last_error='Startup-only work was suppressed inside the disposable provider canary database.',
    locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,updated_at=datetime('now'),completed_at=datetime('now')
    WHERE status IN ('queued','running')`).run();
}

const requestedIds = args.opportunities;
const candidates = repository.listContent({ productionOnly: true })
  .filter((row) => !requestedIds.length || requestedIds.includes(row.opportunity_id))
  .filter((row) => row.production_state?.stage_status === "failed" || row.production_state?.stage_status === "interrupted")
  .slice(0, args.limit);
if (candidates.length !== args.limit) {
  repository.db.close();
  throw new Error(`Expected ${args.limit} failed/interrupted production records, found ${candidates.length}.`);
}

const flows = [];
try {
  for (const row of candidates) {
    const flow = {
      opportunityId: row.opportunity_id,
      title: row.title,
      initialStatus: row.production_state.stage_status,
      recoveryStage: null,
      recoveryStages: [],
      callsBefore: modelCallCount(repository) - callsBefore,
    };
    for (let cycle = 1; cycle <= args.recoveryCycles; cycle += 1) {
      const detail = repository.getContentProductionDetail(row.opportunity_id);
      const state = detail?.production_state || {};
      if (!["failed", "interrupted"].includes(state.stage_status)) break;
      const action = state.stage_status === "interrupted" ? "recover_next_stage" : "retry_failed_stage";
      const operation = executeContentRecovery(repository, row.opportunity_id, {
        action,
        revision: detail?.draft?.revision ?? row.draft_revision ?? undefined,
        idempotencyKey: `provider-canary:${startedAt}:${row.opportunity_id}:${cycle}`,
      }, "provider-canary");
      flow.recoveryStage ||= operation.resolvedStage;
      flow.recoveryStages.push(operation.resolvedStage);
      await drainOpportunity(repository, pipeline, row.opportunity_id, callsBefore, args.maxCalls, args.timeoutMs);
    }
    const detail = repository.getContentProductionDetail(row.opportunity_id);
    const finalState = detail?.production_state || {};
    flow.callsAfter = modelCallCount(repository) - callsBefore;
    flow.finalStatus = finalState.stage_status || null;
    flow.currentStage = finalState.current_stage || null;
    flow.nextStage = finalState.next_stage || null;
    flow.completedStages = finalState.completed_stages?.length || 0;
    flow.latestError = finalState.latest_error ? {
      code: finalState.latest_error.code,
      stage: finalState.latest_error.stage,
      reason: finalState.latest_error.reason,
    } : null;
    flows.push(flow);
  }
} finally {
  pipeline.stop();
}

const callsAfter = modelCallCount(repository);
const metrics = repository.db.prepare(`SELECT stage,status,error_code,COUNT(*) AS attempts,
  SUM(COALESCE(input_tokens,0)) AS input_tokens,SUM(COALESCE(output_tokens,0)) AS output_tokens,
  MAX(latency_ms) AS max_latency_ms FROM model_call_metrics WHERE created_at>=?
  GROUP BY stage,status,error_code ORDER BY stage,status,error_code`).all(startedAt);
const protectedAfter = protectedCounts(repository);
const immutableProtected = ["sources", "source_assets", "claims", "evidence_spans", "knowledge_facts", "experience_blocks", "approved_opportunities"];
const protectedDataPreserved = immutableProtected.every((key) => protectedAfter[key] === protectedBefore[key])
  && protectedAfter.failure_lessons >= protectedBefore.failure_lessons;
const activeJobs = repository.db.prepare("SELECT type,status,COUNT(*) AS count FROM jobs WHERE status IN ('queued','running') GROUP BY type,status").all();
const result = {
  version: "production-content-canary-1",
  startedAt,
  database: path.basename(databasePath),
  isolation: { productionDatabase: false, wordpressEnabled: false, visualGenerationEnabled: false, concurrency: 1, vertexBatch: false },
  startupJobsCancelledInCopy: startupJobs.length,
  flowCount: flows.length,
  modelCalls: callsAfter - callsBefore,
  maxModelCalls: args.maxCalls,
  maxRecoveryCyclesPerFlow: args.recoveryCycles,
  protectedDataPreserved,
  protectedBefore,
  protectedAfter,
  activeJobs,
  metrics,
  flows,
};
repository.db.close();
console.log(JSON.stringify(result, null, 2));
if (!result.protectedDataPreserved || activeJobs.length || flows.some((flow) => ["failed", "interrupted"].includes(flow.finalStatus))) process.exitCode = 1;

async function drainOpportunity(repo, worker, opportunityId, callsAtStart, maximumCalls, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (modelCallCount(repo) - callsAtStart >= maximumCalls) throw new Error(`Real-provider canary reached its ${maximumCalls}-call safety cap.`);
    const active = repo.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE production_owner_opportunity_id=? AND status IN ('queued','running')").get(opportunityId).count;
    if (!Number(active)) return;
    const ran = await worker.runOne();
    if (!ran) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for production-copy flow ${opportunityId}.`);
}

function modelCallCount(repo) {
  return Number(repo.db.prepare("SELECT COUNT(*) AS count FROM model_call_metrics").get().count || 0);
}

function protectedCounts(repo) {
  return Object.fromEntries([
    ["sources", "sources"], ["source_assets", "source_assets"], ["claims", "claims"],
    ["evidence_spans", "evidence_spans"], ["knowledge_facts", "knowledge_facts"], ["experience_blocks", "experience_blocks"],
    ["approved_opportunities", "content_opportunities WHERE approved_at IS NOT NULL"], ["failure_lessons", "failure_lessons"],
  ].map(([key, from]) => [key, Number(repo.db.prepare(`SELECT COUNT(*) AS count FROM ${from}`).get().count || 0)]));
}

function parseArgs(values) {
  const output = { database: "", limit: 5, maxCalls: 40, timeoutMs: 45 * 60 * 1_000, spacingMs: 1_000,
    recoveryCycles: 1, opportunities: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--database") output.database = values[++index] || "";
    else if (value === "--limit") output.limit = bounded(values[++index], 1, 7, "limit");
    else if (value === "--max-calls") output.maxCalls = bounded(values[++index], 1, 50, "max-calls");
    else if (value === "--timeout-minutes") output.timeoutMs = bounded(values[++index], 1, 120, "timeout-minutes") * 60 * 1_000;
    else if (value === "--spacing-ms") output.spacingMs = bounded(values[++index], 0, 60_000, "spacing-ms");
    else if (value === "--recovery-cycles") output.recoveryCycles = bounded(values[++index], 1, 4, "recovery-cycles");
    else if (value === "--opportunity") output.opportunities.push(values[++index] || "");
    else throw new Error(`Unknown argument: ${value}`);
  }
  return output;
}

function bounded(value, minimum, maximum, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error(`--${name} must be ${minimum}-${maximum}.`);
  return number;
}
