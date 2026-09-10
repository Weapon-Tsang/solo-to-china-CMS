import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const targetRoot = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const { openDatabase } = await import(pathToFileURL(path.join(targetRoot, "src", "db.mjs")));
const { Repository } = await import(pathToFileURL(path.join(targetRoot, "src", "repository.mjs")));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stc-b12-measure-"));
const db = openDatabase(path.join(directory, "measure.sqlite"));
try {
  const timestamp = "2026-09-10T00:00:00.000Z";
  const insert = db.prepare(`INSERT INTO topic_candidates(id,destination_slug,topic_key,proposed_title,rationale,
    coverage_score,evidence_count,conflict_count,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,0,0,'candidate',?,?)`);
  db.exec("BEGIN IMMEDIATE");
  for (let index = 0; index < 250; index += 1) insert.run(`topic-${index}`, "beijing", `topic-${index}`, `Guide ${index}`, "fixture", 80, timestamp, timestamp);
  db.exec("COMMIT");
  const repository = new Repository(db);
  repository.listContent();
  const started = performance.now();
  let response;
  for (let index = 0; index < 25; index += 1) response = { items: repository.listContent(), opportunities: [] };
  const durationMs = performance.now() - started;
  const result = {
    fixtureVersion: "b12-service-boundary-1",
    targetRoot,
    itemCount: response.items.length,
    iterations: 25,
    durationMs: Math.round(durationMs * 100) / 100,
    itemsPerSecond: Math.round((response.items.length * 25 / durationMs * 1000) * 100) / 100,
    apiResponseBytes: Buffer.byteLength(JSON.stringify(response)),
    dbQueryCount: null,
    dbQueryCountStatus: "not_instrumented",
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
