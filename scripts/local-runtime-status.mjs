import { loadConfig } from "../src/config.mjs";
import { localLogPath, localRuntimeStatus, readLocalDataRootIdentity, requestLocalRuntimeStop, unlockStaleLocalRuntimeLease } from "../src/local-runtime.mjs";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { SCHEMA_VERSION } from "../src/db.mjs";
import { VERSION } from "../src/version.mjs";

const config = loadConfig();
const command = process.argv[2] || "status";
if (!config.deployment.runMode || !config.deployment.dataRoot) throw new Error("CMS_RUN_MODE and CMS_DATA_ROOT are required.");
if (command === "status") {
  let database = { exists: fs.existsSync(config.databasePath), schemaVersion: null };
  if (database.exists) {
    const db = new DatabaseSync(config.databasePath, { readOnly: true });
    try {
      db.exec("PRAGMA query_only=ON");
      database = { ...database, schemaVersion: db.prepare("SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations").get().version };
    } catch (error) { database = { ...database, schemaError: error.code || error.message }; }
    finally { db.close(); }
  }
  console.log(JSON.stringify({ ...localRuntimeStatus(config), dataRoot: config.deployment.dataRoot,
    mode: config.deployment.runMode,
    role: config.processRole, releaseRoot: config.deployment.releaseRoot || null,
    databasePath: config.databasePath, dataRootIdentity: readLocalDataRootIdentity(config),
    database, appVersion: VERSION, expectedSchemaVersion: SCHEMA_VERSION }, null, 2));
}
else if (command === "unlock") {
  const role = process.argv[3];
  if (!role) throw new Error("Specify all, api, or worker for a stale lease.");
  console.log(JSON.stringify(unlockStaleLocalRuntimeLease(config, role), null, 2));
} else if (command === "stop") {
  const role = process.argv[3] || config.processRole;
  const requested = requestLocalRuntimeStop(config, role);
  if (requested.alreadyStopped) {
    console.log(JSON.stringify({ stopped: true, alreadyStopped: true, role }, null, 2));
    process.exit(0);
  }
  let stopped = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (!localRuntimeStatus(config).instances.some((instance) => instance.role === role && instance.alive)) {
      stopped = true;
      break;
    }
  }
  if (!stopped) throw new Error(`CMS ${role} did not acknowledge its stop request within 15 seconds; no process was killed.`);
  console.log(JSON.stringify({ stopped: true, role, pid: requested.pid }, null, 2));
} else if (command === "logs") {
  const role = process.argv[3] || config.processRole;
  const filename = localLogPath(config, role);
  if (!fs.existsSync(filename)) throw new Error(`No local CMS log exists for ${role}.`);
  const descriptor = fs.openSync(filename, "r");
  try {
    const size = fs.fstatSync(descriptor).size;
    const bytes = Math.min(size, 256 * 1024);
    const buffer = Buffer.alloc(bytes);
    fs.readSync(descriptor, buffer, 0, bytes, size - bytes);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    if (bytes < size) lines.shift();
    process.stdout.write(`${lines.filter(Boolean).slice(-100).join("\n")}\n`);
  } finally { fs.closeSync(descriptor); }
} else throw new Error("Usage: node scripts/local-runtime-status.mjs [status|stop <all|api|worker>|logs <all|api|worker>|unlock <all|api|worker>]");
