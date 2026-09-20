import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { openDatabase } from "../src/db.mjs";
import { Repository } from "../src/repository.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const databasePath = path.join(root, "output", "v3-preview", "cms-preview.sqlite");
if (process.argv[2] !== "--isolated-fixture") throw new Error("Only the isolated v3 preview database is allowed.");
const db = openDatabase(databasePath);
try {
  const count = db.prepare("SELECT COUNT(*) AS n FROM content_opportunities WHERE id LIKE 'v3-preview-%'").get().n;
  assert.ok(count >= 100, "A nonempty production-shaped fixture is required.");
  const repo = new Repository(db);
  let prepared = 0;
  const originalPrepare = db.prepare.bind(db);
  db.prepare = (...args) => { prepared += 1; return originalPrepare(...args); };
  const measure = (label, fn) => {
    const times = [];
    const statements = [];
    let bytes = 0;
    let rows = 0;
    for (let iteration = 0; iteration < 20; iteration += 1) {
      prepared = 0;
      const started = performance.now();
      const result = fn();
      times.push(performance.now() - started);
      statements.push(prepared);
      bytes = Buffer.byteLength(JSON.stringify(result));
      rows = result.items.length;
    }
    times.sort((a, b) => a - b);
    return { label, rows, responseBytes: bytes, sqlPrepareCount: Math.max(...statements),
      p50Ms: Number(times[9].toFixed(2)), p95Ms: Number(times[18].toFixed(2)) };
  };
  const results = [
    measure("legacy full workspace (comparison)", () => repo.listContentWorkspace({ productionOnly: true })),
    measure("first paged compact workspace", () => repo.listContentWorkspace({ productionOnly: true, limit: 50, offset: 0, compact: true })),
  ];
  process.stdout.write(`${JSON.stringify({ fixture: "isolated synthetic production-shaped data", opportunities: count,
    drafts: db.prepare("SELECT COUNT(*) AS n FROM article_drafts WHERE id LIKE 'v3-preview-%'").get().n,
    iterations: 20, queryMetric: "prepared SQL statements, including repeated per-row preparations", results }, null, 2)}\n`);
} finally { db.close(); }
