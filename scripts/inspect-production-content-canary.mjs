import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const databaseArg = process.argv[2] || "";
if (!databaseArg) throw new Error("Usage: node scripts/inspect-production-content-canary.mjs <canary|replay|work database>");
const databasePath = path.resolve(databaseArg);
if (!/(?:canary|replay|work)/i.test(path.basename(databasePath))) {
  throw new Error("Refusing to inspect a database whose filename does not contain canary, replay, or work.");
}

const db = new DatabaseSync(databasePath, { readOnly: true });
db.exec("PRAGMA query_only = ON");
const since = process.argv[3] || "1970-01-01T00:00:00.000Z";

const output = {
  database: path.basename(databasePath),
  queryOnly: db.prepare("PRAGMA query_only").get().query_only,
  jobs: db.prepare(`SELECT id,type,entity_id,status,dedupe_key,production_owner_opportunity_id,
    last_failure_code,substr(last_error,1,1000) AS last_error,created_at,completed_at
    FROM jobs WHERE created_at>=? ORDER BY created_at`).all(since),
  reviews: db.prepare(`SELECT id,draft_id,passed,score,substr(issues_json,1,5000) AS issues_json,created_at
    FROM quality_reviews WHERE created_at>=? ORDER BY created_at`).all(since),
  drafts: db.prepare(`SELECT id,brief_id,revision,title,content_hash,status,
    substr(body_markdown,1,12000) AS body_markdown,
    substr(evidence_ledger_json,1,12000) AS evidence_ledger_json,updated_at
    FROM article_drafts WHERE updated_at>=? ORDER BY updated_at`).all(since),
  metrics: db.prepare(`SELECT stage,status,error_code,input_tokens,output_tokens,latency_ms,created_at
    FROM model_call_metrics WHERE created_at>=? ORDER BY created_at`).all(since),
};

db.close();
console.log(JSON.stringify(output, null, 2));
