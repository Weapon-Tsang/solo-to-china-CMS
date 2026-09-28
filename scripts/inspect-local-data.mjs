import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../src/config.mjs";
import { inspectLocalHandoffState } from "../src/local-runtime.mjs";

const config = loadConfig();
if (config.deployment.runMode !== "migration-review") throw new Error("Set CMS_RUN_MODE=migration-review for read-only inspection.");
if (!config.deployment.dataRoot || !fs.existsSync(config.databasePath)) throw new Error("An existing external CMS_DATA_ROOT and database are required.");
const relative = path.relative(config.deployment.dataRoot, config.databasePath);
if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Database must be inside CMS_DATA_ROOT.");
const db = new DatabaseSync(config.databasePath, { readOnly: true });
try {
  db.exec("PRAGMA query_only=ON");
  const integrity = db.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row)[0]);
  const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
  const schemaVersion = db.prepare("SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations").get().version;
  const { handoff, reconciliationRequired } = inspectLocalHandoffState(db);
  console.log(JSON.stringify({ mode: "migration-review", dataRoot: config.deployment.dataRoot,
    databasePath: config.databasePath, schemaVersion, integrity, foreignKeyViolations: foreignKeys.length,
    handoff, reconciliationRequired, writes: false, worker: false, externalCalls: false }, null, 2));
  if (integrity.length !== 1 || integrity[0] !== "ok" || foreignKeys.length) process.exitCode = 1;
} finally { db.close(); }
