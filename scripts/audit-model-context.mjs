#!/usr/bin/env node
// Read-only model ledger audit: per-stage input size against context budgets,
// failure classes, repeated identical inputs and image-understanding coverage.
// Usage: node scripts/audit-model-context.mjs <database.sqlite> [--since=2026-09-01] [--json]
import { DatabaseSync } from "node:sqlite";
import { CONTEXT_BUDGETS, contextBudgetFor } from "../src/ai/context-budget.mjs";

const args = process.argv.slice(2);
const databasePath = args.find((value) => !value.startsWith("--")) || process.env.DATABASE_PATH;
const since = args.find((value) => value.startsWith("--since="))?.slice(8) || "0000";
const asJson = args.includes("--json");
if (!databasePath) {
  console.error("Usage: node scripts/audit-model-context.mjs <database.sqlite> [--since=YYYY-MM-DD] [--json]");
  process.exit(2);
}

const db = new DatabaseSync(databasePath, { readOnly: true });
const percentile = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null;

const rows = db.prepare(`SELECT stage, attempt_status, error_code, input_tokens, output_tokens, input_hash, request_kind
  FROM model_call_metrics WHERE created_at >= ?`).all(since);
const stages = new Map();
for (const row of rows) {
  const entry = stages.get(row.stage) || { stage: row.stage, calls: 0, failed: 0, inputs: [], output: 0,
    hashes: new Map(), failures: new Map() };
  entry.calls += 1;
  if (row.attempt_status === "failed") {
    entry.failed += 1;
    entry.failures.set(row.error_code || "unknown", (entry.failures.get(row.error_code || "unknown") || 0) + 1);
  }
  if (row.input_tokens != null) entry.inputs.push(Number(row.input_tokens));
  entry.output += Number(row.output_tokens || 0);
  if (row.request_kind !== "cache_hit") entry.hashes.set(row.input_hash, (entry.hashes.get(row.input_hash) || 0) + 1);
  stages.set(row.stage, entry);
}

const report = [...stages.values()].map((entry) => {
  const sorted = entry.inputs.sort((a, b) => a - b);
  const budget = contextBudgetFor(entry.stage);
  const p95 = percentile(sorted, 0.95);
  const repeatedCalls = [...entry.hashes.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  return {
    stage: entry.stage, calls: entry.calls, failed: entry.failed,
    failureRate: Number((entry.failed / Math.max(1, entry.calls)).toFixed(3)),
    inputTokensM: Number((sorted.reduce((sum, value) => sum + value, 0) / 1e6).toFixed(2)),
    p50: percentile(sorted, 0.5), p95, budget,
    overBudget: budget ? sorted.filter((value) => value > budget).length : null,
    repeatedIdenticalInputs: repeatedCalls,
    topFailures: [...entry.failures.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([code, count]) => `${code}:${count}`).join(" "),
  };
}).sort((a, b) => b.inputTokensM - a.inputTokensM);

const tableExists = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const imageCoverage = tableExists("source_asset_analyses") ? db.prepare(`SELECT
    (SELECT COUNT(*) FROM source_assets) AS assets,
    (SELECT COUNT(*) FROM source_asset_analyses WHERE analysis_status='ready') AS analyzed,
    (SELECT COUNT(*) FROM source_asset_analyses WHERE analysis_status='ready' AND analysis_version LIKE 'image-card%') AS image_cards
  `).get() : null;

if (asJson) {
  console.log(JSON.stringify({ databasePath, since, budgetVersion: CONTEXT_BUDGETS.version, stages: report, imageCoverage }, null, 2));
} else {
  console.log(`Model ledger since ${since} · budgets ${CONTEXT_BUDGETS.version}`);
  console.table(report);
  if (imageCoverage) console.log(`Image understanding: ${imageCoverage.analyzed}/${imageCoverage.assets} assets analyzed `
    + `(${imageCoverage.image_cards} from extraction image cards).`);
}
