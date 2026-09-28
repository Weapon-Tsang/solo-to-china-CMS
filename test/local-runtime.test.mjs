import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { acquireLocalRuntimeLease, assertLocalCredentialReadiness, assertLocalRuntime, consumeLocalRuntimeStopRequest, localRuntimeStatus, markLocalDataRoot, promoteReviewedLocalDataRoot, readLocalDataRootIdentity, requestLocalRuntimeStop, unlockStaleLocalRuntimeLease } from "../src/local-runtime.mjs";
import { openDatabase } from "../src/db.mjs";
import { createApplication } from "../src/server.mjs";

test("explicit development uses external data root and rejects checkout paths before opening a database", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cms-runtime-"));
  try {
    const config = loadConfig({ CMS_RUN_MODE: "development", CMS_DATA_ROOT: root });
    assertLocalRuntime(config);
    markLocalDataRoot(config, "development");
    assert.equal(readLocalDataRootIdentity(config).kind, "development");
    assert.equal(config.vertex.googleAuthMode, "adc");
    assert.equal(config.databasePath, path.join(root, "solo-to-china.sqlite"));
    assert.throws(() => assertLocalRuntime(loadConfig({ CMS_RUN_MODE: "development", CMS_DATA_ROOT: config.root })), /outside the source checkout/);
    assert.throws(() => assertLocalRuntime(loadConfig({ CMS_RUN_MODE: "development", CMS_DATA_ROOT: root,
      SOURCE_UPLOADS_DIR: path.join(config.root, "data", "source-uploads") })), /sourceUploads must be inside/);
    assert.throws(() => assertLocalRuntime(loadConfig({ CMS_RUN_MODE: "development",
      CMS_DATA_ROOT: path.join(os.tmpdir(), "OneDrive", "cms-data") })), /non-synchronized filesystem/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("migration review refuses the writing server and stable mode refuses missing database", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cms-runtime-"));
  try {
    assert.throws(() => assertLocalRuntime(loadConfig({ CMS_RUN_MODE: "migration-review", CMS_DATA_ROOT: root })), /read-only/);
    assert.equal(loadConfig({ CMS_RUN_MODE: "local-production", NODE_ENV: "production", CMS_DATA_ROOT: root }).vertex.googleAuthMode, "adc");
    assert.equal(loadConfig({ NODE_ENV: "production" }).vertex.googleAuthMode, "metadata");
    assert.throws(() => assertLocalRuntime(loadConfig({ CMS_RUN_MODE: "local-production", CMS_DATA_ROOT: root,
      CMS_RELEASE_ROOT: path.join(root, "release") })), /database is missing/);
    assert.equal(fs.existsSync(path.join(root, "solo-to-china.sqlite")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an existing unmarked database cannot become development, and reviewed data needs explicit promotion", () => {
  const unmarkedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cms-unmarked-"));
  const reviewedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cms-reviewed-"));
  try {
    openDatabase(path.join(unmarkedRoot, "solo-to-china.sqlite")).close();
    assert.throws(() => assertLocalRuntime(loadConfig({ CMS_RUN_MODE: "development", CMS_DATA_ROOT: unmarkedRoot })), /unmarked existing CMS database/);
    const reviewed = loadConfig({ CMS_RUN_MODE: "migration-review", CMS_DATA_ROOT: reviewedRoot });
    markLocalDataRoot(reviewed, "migration-review");
    const db = openDatabase(reviewed.databasePath);
    db.prepare("INSERT INTO jobs(id,type,entity_id,status,available_at,created_at,updated_at) VALUES ('handoff-running','extract_source','fixture','running','2026-01-01','2026-01-01','2026-01-01')").run();
    db.close();
    assert.throws(() => promoteReviewedLocalDataRoot(reviewed), /Old host stop confirmation/);
    assert.throws(() => promoteReviewedLocalDataRoot(reviewed, { oldHostStopped: true }), /unresolved handoff state: runningJobs/);
    assert.equal(readLocalDataRootIdentity(reviewed).kind, "migration-review");
    const reconciled = openDatabase(reviewed.databasePath);
    reconciled.prepare("UPDATE jobs SET status='queued' WHERE id='handoff-running'").run();
    reconciled.prepare(`INSERT INTO vertex_batch_runs(id,model,location,status,next_poll_at,created_at,updated_at)
      VALUES ('handoff-batch','fixture','us-central1','submitted','2026-01-01','2026-01-01','2026-01-01')`).run();
    reconciled.close();
    assert.throws(() => promoteReviewedLocalDataRoot(reviewed, { oldHostStopped: true }), /unresolved handoff state: activeVertexBatches/);
    const batchReconciled = openDatabase(reviewed.databasePath);
    batchReconciled.prepare("UPDATE vertex_batch_runs SET status='succeeded' WHERE id='handoff-batch'").run();
    batchReconciled.prepare(`INSERT INTO media_dispatches(id,scope_key,visual_id,substage,started_at_ms,state,created_at)
      VALUES ('unknown-analysis','vertex:fixture:global:fixture','visual-fixture','analyze_source_image',1,'outcome_unknown','2026-01-01')`).run();
    batchReconciled.close();
    assert.throws(() => promoteReviewedLocalDataRoot(reviewed, { oldHostStopped: true }), /unresolved handoff state: unresolvedMediaDispatches/);
    assert.equal(readLocalDataRootIdentity(reviewed).kind, "migration-review");
    const afterRestart = openDatabase(reviewed.databasePath);
    assert.equal(afterRestart.prepare("SELECT state FROM media_dispatches WHERE id='unknown-analysis'").get().state, "outcome_unknown");
    afterRestart.prepare("UPDATE media_dispatches SET state='completed' WHERE id='unknown-analysis'").run();
    afterRestart.close();
    const result = promoteReviewedLocalDataRoot(reviewed, { oldHostStopped: true });
    assert.equal(result.kind, "local-production");
    assert.throws(() => assertLocalRuntime(loadConfig({ CMS_RUN_MODE: "development", CMS_DATA_ROOT: reviewedRoot })), /cannot use a local-production/);
  } finally {
    fs.rmSync(unmarkedRoot, { recursive: true, force: true });
    fs.rmSync(reviewedRoot, { recursive: true, force: true });
  }
});

test("local production refuses a Worker with unreadable stored credentials while allowing API recovery", () => {
  const config = { deployment: { runMode: "local-production" } };
  const routing = { encryptionErrorCode: "MODEL_CREDENTIAL_DECRYPT_FAILED",
    credentials: { deepseek: { source: "encrypted_database" } } };
  assert.throws(() => assertLocalCredentialReadiness(config, "worker", routing),
    (error) => error.code === "MODEL_CREDENTIAL_DECRYPT_FAILED");
  assert.doesNotThrow(() => assertLocalCredentialReadiness(config, "api", routing));
  assert.doesNotThrow(() => assertLocalCredentialReadiness({ deployment: { runMode: "development" } }, "worker", routing));
});

test("migration review inspects an existing database without changing its bytes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cms-review-"));
  try {
    const databasePath = path.join(root, "solo-to-china.sqlite");
    const db = openDatabase(databasePath);
    db.prepare("INSERT INTO jobs(id,type,entity_id,available_at,created_at,updated_at) VALUES ('review-queued','extract_source','fixture','2026-01-01','2026-01-01','2026-01-01')").run();
    db.prepare("INSERT INTO jobs(id,type,entity_id,status,available_at,created_at,updated_at) VALUES ('review-running','extract_source','fixture','running','2026-01-01','2026-01-01','2026-01-01')").run();
    db.close();
    const before = crypto.createHash("sha256").update(fs.readFileSync(databasePath)).digest("hex");
    const result = spawnSync(process.execPath, ["scripts/inspect-local-data.mjs"], {
      cwd: path.resolve("."), encoding: "utf8",
      env: { ...process.env, CMS_RUN_MODE: "migration-review", CMS_DATA_ROOT: root, DATABASE_PATH: databasePath },
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, "migration-review");
    assert.equal(report.writes, false);
    assert.equal(report.handoff.queuedJobs, 1);
    assert.equal(report.handoff.runningJobs, 1);
    assert.deepEqual(report.reconciliationRequired, ["runningJobs"]);
    assert.deepEqual(report.integrity, ["ok"]);
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(databasePath)).digest("hex"), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("local status reports mode, role, version and schema without exposing configuration secrets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cms-status-"));
  try {
    markLocalDataRoot(loadConfig({ CMS_RUN_MODE: "development", CMS_DATA_ROOT: root }), "development");
    openDatabase(path.join(root, "solo-to-china.sqlite")).close();
    const result = spawnSync(process.execPath, ["scripts/local-runtime-status.mjs", "status"], {
      cwd: path.resolve("."), encoding: "utf8",
      env: { ...process.env, CMS_RUN_MODE: "development", CMS_DATA_ROOT: root,
        CMS_PROCESS_ROLE: "api", ADMIN_TOKEN: "status-secret-fixture" },
    });
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout);
    assert.equal(status.mode, "development");
    assert.equal(status.role, "api");
    assert.equal(status.dataRootIdentity.kind, "development");
    assert.equal(status.database.schemaVersion, status.expectedSchemaVersion);
    assert.equal(status.databasePath, path.join(root, "solo-to-china.sqlite"));
    assert.equal(result.stdout.includes("status-secret-fixture"), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("one API and one Worker may share a data root, while duplicate roles and all-in-one are refused", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cms-lease-"));
  try {
    const base = { CMS_RUN_MODE: "development", CMS_DATA_ROOT: root };
    const api = loadConfig({ ...base, CMS_PROCESS_ROLE: "api" });
    const worker = loadConfig({ ...base, CMS_PROCESS_ROLE: "worker" });
    const all = loadConfig({ ...base, CMS_PROCESS_ROLE: "all" });
    const releaseApi = acquireLocalRuntimeLease(api);
    const releaseWorker = acquireLocalRuntimeLease(worker);
    try {
      assert.deepEqual(localRuntimeStatus(api).instances.map((item) => item.role), ["api", "worker"]);
      assert.throws(() => acquireLocalRuntimeLease(api), (error) => error.code === "CMS_INSTANCE_CONFLICT");
      assert.throws(() => acquireLocalRuntimeLease(all), (error) => error.code === "CMS_INSTANCE_CONFLICT");
      assert.throws(() => unlockStaleLocalRuntimeLease(api, "api"), /still alive/);
    } finally { releaseWorker(); releaseApi(); }
    const releaseAll = acquireLocalRuntimeLease(all);
    assert.throws(() => acquireLocalRuntimeLease(worker), (error) => error.code === "CMS_INSTANCE_CONFLICT");
    releaseAll();
    assert.equal(localRuntimeStatus(api).instances.length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("stale lease needs an explicit unlock and cannot be silently reused", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cms-lease-"));
  try {
    const config = loadConfig({ CMS_RUN_MODE: "development", CMS_DATA_ROOT: root });
    const release = acquireLocalRuntimeLease(config);
    release();
    const filename = path.join(root, ".cms-instances", "all.json");
    fs.writeFileSync(filename, JSON.stringify({ pid: 99_999_999, mode: "development" }));
    assert.throws(() => acquireLocalRuntimeLease(config), (error) => error.code === "CMS_INSTANCE_CONFLICT");
    assert.equal(localRuntimeStatus(config).instances[0].alive, false);
    assert.equal(unlockStaleLocalRuntimeLease(config, "all").removed, true);
    assert.equal(localRuntimeStatus(config).instances.length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a stop request is bound to the live instance nonce and does not kill a PID", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cms-stop-"));
  try {
    const config = loadConfig({ CMS_RUN_MODE: "development", CMS_DATA_ROOT: root, CMS_PROCESS_ROLE: "api" });
    const release = acquireLocalRuntimeLease(config);
    try {
      const request = requestLocalRuntimeStop(config, "api");
      assert.equal(request.pid, process.pid);
      assert.equal(requestLocalRuntimeStop(config, "api").alreadyRequested, true);
      assert.equal(consumeLocalRuntimeStopRequest(config, { role: "api", nonce: crypto.randomUUID() }), false);
      assert.equal(consumeLocalRuntimeStopRequest(config, release), false);
      requestLocalRuntimeStop(config, "api");
      assert.equal(consumeLocalRuntimeStopRequest(config, release), true);
      assert.equal(process.pid > 0, true);
    } finally { release(); }
    assert.equal(requestLocalRuntimeStop(config, "api").alreadyStopped, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("local stop command gracefully stops only its own API subprocess", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cms-stop-process-"));
  markLocalDataRoot(loadConfig({ CMS_RUN_MODE: "development", CMS_DATA_ROOT: root }), "development");
  openDatabase(path.join(root, "solo-to-china.sqlite")).close();
  const env = { ...process.env, CMS_RUN_MODE: "development", CMS_DATA_ROOT: root,
    CMS_PROCESS_ROLE: "api", HOST: "127.0.0.1", PORT: "0", MAINTENANCE_ENABLED: "false", NODE_TEST_CONTEXT: "1", LOG_LEVEL: "info" };
  const child = spawn(process.execPath, ["src/server.mjs"], { cwd: path.resolve("."), env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`API startup timed out: ${output}`)), 10_000);
      const onData = (chunk) => {
        output += chunk.toString();
        if (output.includes("server.started")) { clearTimeout(timeout); resolve(); }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`API exited before startup (${code}): ${output}`)));
    });
    const stop = spawnSync(process.execPath, ["scripts/local-runtime-status.mjs", "stop", "api"],
      { cwd: path.resolve("."), env, encoding: "utf8", timeout: 20_000 });
    assert.equal(stop.status, 0, stop.stderr);
    assert.equal(JSON.parse(stop.stdout).stopped, true);
    assert.equal(localRuntimeStatus(loadConfig(env)).instances.length, 0);
    const stopAgain = spawnSync(process.execPath, ["scripts/local-runtime-status.mjs", "stop", "api"],
      { cwd: path.resolve("."), env, encoding: "utf8", timeout: 20_000 });
    assert.equal(stopAgain.status, 0, stopAgain.stderr);
    assert.equal(JSON.parse(stopAgain.stdout).alreadyStopped, true);
    const logs = spawnSync(process.execPath, ["scripts/local-runtime-status.mjs", "logs", "api"],
      { cwd: path.resolve("."), env, encoding: "utf8" });
    assert.equal(logs.status, 0, logs.stderr);
    assert.match(logs.stdout, /server.started/);
    assert.match(logs.stdout, /server.stopped/);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("API and Worker applications coordinate before database open and release leases on stop", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cms-app-lease-"));
  try {
    markLocalDataRoot(loadConfig({ CMS_RUN_MODE: "development", CMS_DATA_ROOT: root }), "development");
    const databasePath = path.join(root, "solo-to-china.sqlite");
    openDatabase(databasePath).close();
    const base = { CMS_RUN_MODE: "development", CMS_DATA_ROOT: root,
      DATABASE_PATH: databasePath, MAINTENANCE_ENABLED: "false", NODE_TEST_CONTEXT: "1" };
    const api = createApplication(loadConfig({ ...base, CMS_PROCESS_ROLE: "api" }));
    let worker;
    try {
      worker = createApplication(loadConfig({ ...base, CMS_PROCESS_ROLE: "worker" }));
      assert.throws(() => createApplication(loadConfig({ ...base, CMS_PROCESS_ROLE: "all" })),
        (error) => error.code === "CMS_INSTANCE_CONFLICT");
      assert.deepEqual(localRuntimeStatus(loadConfig(base)).instances.map((item) => item.role), ["api", "worker"]);
    } finally { if (worker) await worker.stop(); await api.stop(); }
    assert.equal(localRuntimeStatus(loadConfig(base)).instances.length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a port conflict reports EADDRINUSE and releases only the failed application's lease", async () => {
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cms-port-first-"));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cms-port-second-"));
  let first;
  let second;
  try {
    const base = { CMS_RUN_MODE: "development", CMS_PROCESS_ROLE: "api",
      MAINTENANCE_ENABLED: "false", NODE_TEST_CONTEXT: "1", HOST: "127.0.0.1" };
    markLocalDataRoot(loadConfig({ CMS_RUN_MODE: "development", CMS_DATA_ROOT: firstRoot }), "development");
    markLocalDataRoot(loadConfig({ CMS_RUN_MODE: "development", CMS_DATA_ROOT: secondRoot }), "development");
    openDatabase(path.join(firstRoot, "solo-to-china.sqlite")).close();
    openDatabase(path.join(secondRoot, "solo-to-china.sqlite")).close();
    first = createApplication(loadConfig({ ...base, CMS_DATA_ROOT: firstRoot, PORT: "0" }));
    await first.start();
    const port = first.server.address().port;
    second = createApplication(loadConfig({ ...base, CMS_DATA_ROOT: secondRoot, PORT: String(port) }));
    await assert.rejects(second.start(), (error) => error.code === "EADDRINUSE");
    assert.equal(localRuntimeStatus(loadConfig({ ...base, CMS_DATA_ROOT: secondRoot })).instances.length, 0);
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);
  } finally {
    if (second) await second.stop();
    if (first) await first.stop();
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
  }
});
