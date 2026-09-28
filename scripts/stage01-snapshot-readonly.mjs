import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const source = process.env.STC_STAGE01_SOURCE_DB || "/src/solo-to-china.sqlite";
const target = process.env.STC_STAGE01_SNAPSHOT_DB || "/out/baseline.sqlite";
if (!fs.existsSync(source) || fs.existsSync(target)) throw new Error("Snapshot source is absent or target already exists.");

const input = new DatabaseSync(source, { readOnly: true });
try {
  input.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
} finally { input.close(); }

const snapshot = new DatabaseSync(target, { readOnly: true });
try {
  snapshot.exec("PRAGMA query_only=ON");
  const integrity = snapshot.prepare("PRAGMA integrity_check").get().integrity_check;
  const schema = snapshot.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version;
  const count = (table) => snapshot.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total;
  console.log(JSON.stringify({ snapshot: "read_only_source", integrity, schema,
    sources: count("sources"), jobs: count("jobs"), drafts: count("article_drafts"),
    bytes: fs.statSync(target).size }));
  if (integrity !== "ok") process.exitCode = 1;
} finally { snapshot.close(); }
