import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db.mjs";
import { VERSION } from "../src/version.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cms-local-release-isolation-"));
const sourceRoot = path.join(fixtureRoot, "temporary-source");
const hiddenSourceRoot = path.join(fixtureRoot, "source-moved-away");
const releaseRoot = path.join(fixtureRoot, "release");
const updatedSourceRoot = path.join(fixtureRoot, "updated-source");
const updatedReleaseRoot = path.join(fixtureRoot, "updated-release");
const dataRoot = path.join(fixtureRoot, "data");
let server = null;

function run(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: "utf8", timeout: 180_000, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${program} ${args.join(" ")} failed: ${result.error?.message || result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function waitForServer(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Isolated API startup timed out: ${output}`)), 20_000);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = /"event":"server\.started"[^\n]*"port":(\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Isolated API exited (${code}): ${output}`)); });
  });
}

try {
  fs.mkdirSync(sourceRoot);
  fs.mkdirSync(dataRoot);
  for (const entry of ["src", "config", "dist", "extension", "vendor", "public", "package.json", "package-lock.json"]) {
    fs.cpSync(path.join(projectRoot, entry), path.join(sourceRoot, entry), { recursive: true, errorOnExist: true });
  }
  fs.mkdirSync(path.join(sourceRoot, "scripts"));
  for (const entry of ["prepare-local-release.mjs", "inspect-local-data.mjs", "local-runtime-status.mjs", "promote-local-data.mjs"]) {
    fs.copyFileSync(path.join(projectRoot, "scripts", entry), path.join(sourceRoot, "scripts", entry));
  }
  fs.mkdirSync(path.join(sourceRoot, "docs"));
  fs.cpSync(path.join(projectRoot, "docs", "content-strategy"), path.join(sourceRoot, "docs", "content-strategy"), { recursive: true });
  const databasePath = path.join(dataRoot, "solo-to-china.sqlite");
  openDatabase(databasePath).close();
  const env = { ...process.env, CMS_DATA_ROOT: dataRoot, CMS_RELEASE_ROOT: releaseRoot,
    CMS_RUN_MODE: "local-production", CMS_PROCESS_ROLE: "api", NODE_ENV: "production",
    NODE_TEST_CONTEXT: "1", HOST: "127.0.0.1", PORT: "0", MAINTENANCE_ENABLED: "false",
    WORDPRESS_SITE_URL: "", KIMI_API_KEY: "", VERTEX_AI_ACCESS_TOKEN: "", LOG_LEVEL: "info" };
  run(process.execPath, [path.join(sourceRoot, "scripts", "prepare-local-release.mjs")],
    { cwd: sourceRoot, env });
  fs.renameSync(sourceRoot, hiddenSourceRoot);
  server = spawn(process.execPath, [path.join(releaseRoot, "src", "server.mjs")],
    { cwd: releaseRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  const port = await waitForServer(server);
  const health = await fetch(`http://127.0.0.1:${port}/api/health`);
  if (health.status !== 200) throw new Error(`Isolated API health returned ${health.status}.`);
  const status = JSON.parse(run(process.execPath, [path.join(releaseRoot, "scripts", "local-runtime-status.mjs"), "status"],
    { cwd: releaseRoot, env }));
  if (status.releaseRoot !== releaseRoot || status.dataRootIdentity?.kind !== "local-production"
    || status.databasePath !== databasePath) throw new Error("Isolated release status did not identify its own release and data root.");
  fs.cpSync(hiddenSourceRoot, updatedSourceRoot, { recursive: true, errorOnExist: true });
  const versionFile = path.join(updatedSourceRoot, "src", "version.mjs");
  fs.writeFileSync(versionFile, fs.readFileSync(versionFile, "utf8")
    .replace(JSON.stringify(VERSION), JSON.stringify(`${VERSION}-stage01-smoke`)));
  const updatedEnv = { ...env, CMS_RELEASE_ROOT: updatedReleaseRoot };
  run(process.execPath, [path.join(updatedSourceRoot, "scripts", "prepare-local-release.mjs")],
    { cwd: updatedSourceRoot, env: updatedEnv });
  if ((await fetch(`http://127.0.0.1:${port}/api/health`)).status !== 200) {
    throw new Error("Preparing updated code interrupted the existing API.");
  }
  const stopped = JSON.parse(run(process.execPath, [path.join(releaseRoot, "scripts", "local-runtime-status.mjs"), "stop", "api"],
    { cwd: releaseRoot, env }));
  if (!stopped.stopped) throw new Error("Isolated release did not stop gracefully.");
  if (server.exitCode === null) await new Promise((resolve) => server.once("exit", resolve));
  server = null;
  server = spawn(process.execPath, [path.join(updatedReleaseRoot, "src", "server.mjs")],
    { cwd: updatedReleaseRoot, env: updatedEnv, stdio: ["ignore", "pipe", "pipe"] });
  const updatedPort = await waitForServer(server);
  const updatedHealth = await fetch(`http://127.0.0.1:${updatedPort}/api/health`);
  if (updatedHealth.status !== 200) throw new Error(`Updated isolated API health returned ${updatedHealth.status}.`);
  const updatedStatus = JSON.parse(run(process.execPath,
    [path.join(updatedReleaseRoot, "scripts", "local-runtime-status.mjs"), "status"],
    { cwd: updatedReleaseRoot, env: updatedEnv }));
  if (updatedStatus.appVersion !== `${VERSION}-stage01-smoke` || updatedStatus.databasePath !== databasePath
    || updatedStatus.dataRootIdentity?.datasetId !== status.dataRootIdentity.datasetId) {
    throw new Error("Updated release did not preserve data-root identity or load the new code.");
  }
  run(process.execPath, [path.join(updatedReleaseRoot, "scripts", "local-runtime-status.mjs"), "stop", "api"],
    { cwd: updatedReleaseRoot, env: updatedEnv });
  if (server.exitCode === null) await new Promise((resolve) => server.once("exit", resolve));
  server = null;
  console.log(JSON.stringify({ result: "PASS", sourceMovedBeforeStartup: true, healthStatus: health.status,
    originalAppVersion: status.appVersion, updatedAppVersion: updatedStatus.appVersion,
    sameDatasetAfterUpdate: true, schemaVersion: updatedStatus.database.schemaVersion,
    oldApiAliveDuringNewPrepare: true, stop: "graceful" }, null, 2));
} finally {
  if (server && server.exitCode === null) {
    server.kill();
    await new Promise((resolve) => server.once("exit", resolve));
  }
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
