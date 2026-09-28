import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { loadConfig } from "../src/config.mjs";
import { openDatabase } from "../src/db.mjs";
import { createApplication } from "../src/server.mjs";
import { markLocalDataRoot, requestLocalRuntimeStop } from "../src/local-runtime.mjs";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cms-phase01-bench-"));
const databasePath = path.join(directory, "solo-to-china.sqlite");
const outputIndex = process.argv.indexOf("--output");
const outputPath = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1] || "") : null;
const withWorkerLoad = process.argv.includes("--worker-load");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
let app;
let worker;
let loadProcess;
const awaitChildOutput = (child, pattern, label) => new Promise((resolve, reject) => {
  let output = "";
  const timer = setTimeout(() => reject(new Error(`${label} startup timed out: ${output}`)), 15_000);
  const receive = (chunk) => {
    output += chunk.toString();
    if (pattern.test(output)) { clearTimeout(timer); resolve(); }
  };
  child.stdout.on("data", receive);
  child.stderr.on("data", receive);
  child.once("error", reject);
  child.once("exit", (code) => reject(new Error(`${label} exited during startup (${code}): ${output}`)));
});
const awaitMessage = (child, type, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} did not report ${type}.`)), 15_000);
  const onMessage = (message) => {
    if (message?.type !== type) return;
    clearTimeout(timer);
    child.off("message", onMessage);
    resolve(message);
  };
  child.on("message", onMessage);
  child.once("error", reject);
});
try {
  markLocalDataRoot(loadConfig({ CMS_RUN_MODE: "development", CMS_DATA_ROOT: directory }), "development");
  const db = openDatabase(databasePath);
  try {
    const source = db.prepare(`INSERT INTO sources(id,adapter,canonical_url,title,captured_at,raw_text,raw_html,
      raw_payload_json,content_hash,created_at,updated_at) VALUES (?,'manual',?,?,?,?,?,?,?, ?,?)`);
    const claim = db.prepare(`INSERT INTO claims(id,source_id,normalized_key,subject,predicate,value_text,
      qualifiers_json,source_quote,confidence,created_at) VALUES (?,?,?,?,?,?,'[]','Synthetic benchmark claim',0.9,?)`);
    const asset = db.prepare(`INSERT INTO source_assets(id,source_id,kind,remote_url,position)
      VALUES (?,?,'image',?,?)`);
    const fact = db.prepare(`INSERT INTO knowledge_facts(id,destination_id,normalized_key,subject,predicate,
      consensus_status,preferred_value,support_count,contradiction_count,evidence_json,updated_at,canonical_subject,entity_key)
      VALUES (?,'bench-city',?,?,'visitor_tip','single_source',?,1,0,'[]',?,?,?)`);
    const candidate = db.prepare(`INSERT INTO topic_candidates(id,destination_slug,topic_key,proposed_title,
      rationale,coverage_score,evidence_count,conflict_count,status,created_at,updated_at)
      VALUES (?,'bench-city',?,?,'fixture',80,2,0,'drafted',?,?)`);
    const opportunity = db.prepare(`INSERT INTO content_opportunities(id,destination_slug,topic_key,strategy_version,
      candidate_id,title,content_type,readiness_score,readiness_json,coverage_json,status,approved_at,
      created_at,updated_at,lifecycle_state) VALUES (?,'bench-city',?,'3.9',? ,?,'practical_guide',80,
      '{"ready":true}','{}','approved_ready',?,?,?,'approved')`);
    const brief = db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,
      status,created_at,updated_at,candidate_id) VALUES (?,'bench-city',?,'solo traveler','informational','ready',?,?,?)`);
    const draft = db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,
      quality_report_json,status,created_at,updated_at,revision,content_hash)
      VALUES (?,?,?,?,?,'{}','review',?,?,1,?)`);
    const failed = db.prepare(`INSERT INTO jobs(id,type,entity_id,status,available_at,last_error,created_at,updated_at)
      VALUES (?,'process_source',?,'failed',?,'AI_PROVIDER fixture failure',?,?)`);
    const stamp = "2026-09-24T00:00:00.000Z";
    db.exec("INSERT OR IGNORE INTO destinations(id,slug,name,created_at,updated_at) VALUES ('bench-city','bench-city','Benchmark City','2026-09-24','2026-09-24')");
    db.exec("BEGIN IMMEDIATE");
    try {
      for (let i = 0; i < 1_000; i++) source.run(`source-${i}`, `manual-source://benchmark/${i}`,
        `Benchmark source ${i}`, stamp, "Synthetic text", "", "{}", `hash-${i}`, stamp, stamp);
      for (let i = 0; i < 10_000; i++) claim.run(`claim-${i}`, `source-${i % 1_000}`,
        `benchmark.fact.${i}`, `Benchmark place ${i % 500}`, "visitor tip", `Value ${i}`, stamp);
      for (let i = 0; i < 3_000; i++) asset.run(`asset-${i}`, `source-${i % 1_000}`,
        `https://example.test/benchmark/${i}.jpg`, i % 3);
      for (let i = 0; i < 1_000; i++) fact.run(`fact-${i}`, `benchmark.fact.${i}`,
        `Benchmark place ${i % 500}`, `Value ${i}`, stamp, `Benchmark place ${i % 500}`, `place-${i % 500}`);
      for (let i = 0; i < 300; i++) {
        candidate.run(`candidate-${i}`, `topic-${i}`, `Guide ${i}`, stamp, stamp);
        opportunity.run(`opportunity-${i}`, `topic-${i}`, `candidate-${i}`, `Guide ${i}`, stamp, stamp, stamp);
        brief.run(`brief-${i}`, `Guide ${i}`, stamp, stamp, `candidate-${i}`);
        draft.run(`draft-${i}`, `brief-${i}`, `Guide ${i}`, `guide-${i}`, "Synthetic body. ".repeat(300), stamp, stamp, `body-${i}`);
      }
      for (let i = 0; i < 50; i++) failed.run(`failed-${i}`, `source-${i}`, stamp, stamp, stamp);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } finally { db.close(); }

  app = createApplication(loadConfig({ CMS_RUN_MODE: "development", CMS_DATA_ROOT: directory,
    DATABASE_PATH: databasePath, CMS_PROCESS_ROLE: "api", HOST: "127.0.0.1", PORT: "0",
    MAINTENANCE_ENABLED: "false", NODE_TEST_CONTEXT: "1", LOG_LEVEL: "error" }));
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  await app.start();
  if (withWorkerLoad) {
    worker = spawn(process.execPath, [path.join(projectRoot, "src", "server.mjs")], {
      cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
        CMS_RUN_MODE: "development", CMS_DATA_ROOT: directory, DATABASE_PATH: databasePath,
        CMS_PROCESS_ROLE: "worker", MAINTENANCE_ENABLED: "false", NODE_TEST_CONTEXT: "1",
        KIMI_API_KEY: "", VERTEX_AI_ACCESS_TOKEN: "", LOG_LEVEL: "info" },
    });
    await awaitChildOutput(worker, /"event":"worker\.ready"/, "CMS Worker");
    loadProcess = spawn(process.execPath, [path.join(projectRoot, "scripts", "benchmark-local-stage01-load.mjs"), databasePath], {
      cwd: projectRoot, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    await awaitMessage(loadProcess, "ready", "synthetic load process");
  }
  if (process.argv.includes("--browser-hold")) {
    const stopFile = path.join(directory, ".browser-stop");
    console.log(JSON.stringify({ event: "browser_fixture_ready",
      url: `http://127.0.0.1:${app.server.address().port}`, dataset: "synthetic_phase01", stopFile }));
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        if (!fs.existsSync(stopFile)) return;
        clearInterval(timer);
        resolve();
      }, 250);
    });
  }
  const queryPlans = {
    sources: app.repository.db.prepare("EXPLAIN QUERY PLAN SELECT id,captured_at FROM sources ORDER BY captured_at DESC,id DESC LIMIT 21").all(),
    claims: app.repository.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM claims WHERE source_id=? ORDER BY created_at DESC LIMIT 20").all("source-1"),
    content: app.repository.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM content_opportunities WHERE approved_at IS NOT NULL ORDER BY updated_at DESC LIMIT 21").all(),
  };
  let sqlStatements = 0;
  const prepare = app.repository.db.prepare.bind(app.repository.db);
  app.repository.db.prepare = (...args) => {
    const statement = prepare(...args);
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return (...parameters) => {
        if (["get", "all", "run", "iterate"].includes(key)) sqlStatements += 1;
        return value.apply(target, parameters);
      };
    } });
  };
  eventLoop.enable();
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const routes = ["/api/sources?limit=20", "/api/knowledge/subjects?limit=20",
    "/api/content?limit=20", "/api/exceptions?limit=20", "/api/dashboard/summary"];
  const results = [];
  for (const route of routes) {
    const measure = async () => {
      sqlStatements = 0;
      const started = performance.now();
      const response = await fetch(base + route);
      const body = await response.arrayBuffer();
      if (response.status !== 200) throw new Error(`${route} returned HTTP ${response.status}`);
      return { ms: Number((performance.now() - started).toFixed(3)), bytes: body.byteLength,
        sqlStatements };
    };
    const warmup = await measure();
    const samples = [];
    for (let i = 0; i < 30; i++) samples.push(await measure());
    const values = samples.map((sample) => sample.ms);
    results.push({ route, warmup, samples, p50Ms: p(values, 0.5), p95Ms: p(values, 0.95),
      p95SqlStatements: p(samples.map((sample) => sample.sqlStatements), 0.95),
      targetP95Ms: 300, targetMet: p(values, 0.95) <= 300 });
  }
  eventLoop.disable();
  let loadMetrics = null;
  if (loadProcess) {
    if (!loadProcess.connected) throw new Error("Synthetic load process ended before benchmark collection completed.");
    const stopped = awaitMessage(loadProcess, "stopped", "synthetic load process");
    loadProcess.send("stop");
    loadMetrics = await stopped;
    if (loadProcess.exitCode === null) await new Promise((resolve) => loadProcess.once("exit", resolve));
    loadProcess = null;
  }
  if (worker) {
    requestLocalRuntimeStop(loadConfig({ CMS_RUN_MODE: "development", CMS_DATA_ROOT: directory,
      CMS_PROCESS_ROLE: "worker" }), "worker");
    if (worker.exitCode === null) await new Promise((resolve) => worker.once("exit", resolve));
    worker = null;
  }
  const report = { format: "cms-phase01-benchmark-1", createdAt: new Date().toISOString(),
    machine: { platform: process.platform, arch: process.arch, node: process.version,
      cpus: os.cpus().length, totalMemoryBytes: os.totalmem() },
    dataset: { sources: 1_000, claims: 10_000, drafts: 300, mediaMetadata: 3_000, knowledgeFacts: 1_000,
      failedJobs: 50, type: "synthetic fixture" },
    mode: "development", workerLoad: withWorkerLoad ? "cms_worker_plus_synthetic_read_cpu" : "idle",
    syntheticLoad: loadMetrics ? { queries: loadMetrics.queries, cycles: loadMetrics.cycles } : null,
    network: "loopback", warmupPerRoute: 1,
    validSamplesPerRoute: 30, percentileMethod: "nearest-rank", eventLoopDelayP95Ms: Number((eventLoop.percentile(95) / 1e6).toFixed(3)),
    queryPlans, results };
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  }
  console.log(JSON.stringify({ ...report, results: results.map(({ samples, ...summary }) => summary) }, null, 2));
} finally {
  if (loadProcess && loadProcess.exitCode === null) {
    if (loadProcess.connected) loadProcess.send("stop");
    else loadProcess.kill();
    await new Promise((resolve) => loadProcess.once("exit", resolve));
  }
  if (worker && worker.exitCode === null) {
    try { requestLocalRuntimeStop(loadConfig({ CMS_RUN_MODE: "development", CMS_DATA_ROOT: directory,
      CMS_PROCESS_ROLE: "worker" }), "worker"); }
    catch { worker.kill(); }
    await new Promise((resolve) => worker.once("exit", resolve));
  }
  if (app) await app.stop();
  const tempRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(directory);
  if (!resolved.startsWith(`${tempRoot}${path.sep}`) || !path.basename(resolved).startsWith("cms-phase01-bench-")) {
    throw new Error("Benchmark cleanup path escaped its temporary directory.");
  }
  if (process.argv.includes('--browser-hold') || process.argv.includes('--keep-fixture')) {
    console.log(JSON.stringify({ event: 'benchmark_fixture_preserved', root: resolved }));
  } else fs.rmSync(resolved, { recursive: true, force: true });
}
