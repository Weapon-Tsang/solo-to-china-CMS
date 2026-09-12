import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBackup, drillBackup } from "../src/backup.mjs";
import { openDatabase } from "../src/db.mjs";
import { CONTENT_STRATEGY } from "../src/content-strategy.mjs";
import { compareRenderedVariants, validateRenderedHtmlArtifact } from "../src/final-html-validator.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const releaseGate = JSON.parse(fs.readFileSync(path.join(root, "config", "release-gate.json"), "utf8"));
const timeoutMs = releaseGate.performance.isolatedSmokeFailureMs;
const smokeOnly = process.argv.includes("--smoke-only");
let report;

async function main() {
  report.heading();
  report.check("Environment", "Node runtime", () => {
    const major = Number.parseInt(process.versions.node.split(".")[0], 10);
    if (!Number.isInteger(major) || major < 24) throw new Error(`Node 24+ is required (found ${process.version}).`);
    return process.version;
  });
  report.check("Environment", "Dependencies installed", () => {
    if (!fs.existsSync(path.join(root, "node_modules"))) throw new Error("node_modules is missing. Run npm ci first.");
    if (!fs.existsSync(path.join(root, "package-lock.json"))) throw new Error("package-lock.json is missing.");
  });

  let buildReady = smokeOnly;
  if (!smokeOnly) {
    const staticCheck = npmInvocation(["run", "check"]);
    const unitTests = npmInvocation(["test"]);
    const crossRepoCheck = npmInvocation(["run", "test:cross-repo"]);
    const staticResult = await report.command("Code", "Static checks and Vite production build", staticCheck.command, staticCheck.args, 120_000);
    buildReady = staticResult.ok;
    const unitResult = await report.command("Code", "Unit and integration tests", unitTests.command, unitTests.args,
      releaseGate.performance.unitTestFailureMs);
    if (unitResult.ok && unitResult.durationMs > releaseGate.performance.unitTestWarningMs) {
      report.warning("Performance", "Unit-test duration budget",
        `${unitResult.durationMs} ms exceeded the ${releaseGate.performance.unitTestWarningMs} ms warning budget; correctness still passed.`);
    } else if (unitResult.ok) {
      report.pass("Performance", "Unit-test duration budget",
        `${unitResult.durationMs} ms; baseline ${releaseGate.performance.baseline.durationMs} ms under documented sample conditions`);
    }
    const crossRepoResult = await report.command("Code", "Fixed-SHA Frontend Contract gate", crossRepoCheck.command, crossRepoCheck.args, 120_000);
    const versionResult = await report.command("Database", "Version alignment and clean migration chain", process.execPath, ["src/release-check.mjs"], 30_000);
    recordQualityDimensions({ unitTestsPassed: unitResult.ok, crossRepoPassed: crossRepoResult.ok, versionPassed: versionResult.ok });
  } else {
    report.warning("Environment", "Smoke-only mode", "Build, static checks, and unit tests were intentionally skipped.");
  }

  if (buildReady) await verifyBuildOutput();
  else {
    report.notTested("Build", "dist asset validation", "Production build did not pass.");
    report.notTested("Server", "Isolated server/API/Web smoke tests", "Production build did not pass.");
  }

  if (buildReady && report.sectionPassed("Build")) await runIsolatedSmoke();
  await runExtensionChecks();
  report.warning("External Services", "Kimi", "Not called; the isolated server runs without KIMI_API_KEY.");
  report.warning("External Services", "WordPress production", "Not called; the isolated server runs without WordPress credentials.");
  report.warning("External Services", "Search Console production", "Not called; the isolated server runs without Google credentials.");
  report.notTested("Chrome Extension", "Real Chrome Load Unpacked", "Requires a human Chrome profile and an explicit user click.");
  report.notTested("Chrome Extension", "Real Xiaohongshu capture", "Requires a user-selected, already-open note in a real tab.");
  report.notTested("Search Outcomes", "Rankings, traffic, indexing, and AI citations", "Not verifiable in offline CI and never inferred from schema or content checks.");
  report.warning("Logs", "Node SQLite ExperimentalWarning", "Known Node runtime warning; it is recorded but not treated as a release failure.");
  report.finish();
}

async function verifyBuildOutput() {
  const dist = path.join(root, "dist");
  report.check("Build", "dist directory", () => assertFile(dist, "dist directory", true));
  const indexPath = path.join(dist, "index.html");
  report.check("Build", "dist/index.html", () => assertFile(indexPath, "dist/index.html"));
  let html = "";
  report.check("Build", "Frontend entrypoint", () => {
    html = fs.readFileSync(indexPath, "utf8");
    if (!/<div\s+id=["']root["']/.test(html)) throw new Error("index.html does not contain the React root element.");
  });
  report.check("Build", "JavaScript assets", () => verifyReferencedAssets(html, ".js"));
  report.check("Build", "CSS assets", () => verifyReferencedAssets(html, ".css"));
}

async function runIsolatedSmoke() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-to-china-release-smoke-"));
  const databasePath = path.join(directory, "release-smoke.sqlite");
  const backupDir = path.join(directory, "backups");
  let child = null;
  let stdout = "";
  let stderr = "";
  try {
    const port = await availablePort();
    child = spawn(process.execPath, ["src/server.mjs"], {
      cwd: root,
      env: isolatedEnvironment({ port, databasePath, backupDir }),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    if (!child?.pid) throw new Error("Node did not return a child-process PID.");
    report.pass("Server", "Server process started", `PID ${child.pid} captured`);
    const baseUrl = `http://127.0.0.1:${port}`;
    const health = await waitForReadiness(baseUrl, child, () => `${stdout}\n${stderr}`);
    report.pass("Server", "HTTP listener ready", `health endpoint responded on port ${port}`);
    verifyHealth(health);
    report.pass("API", "/api/health", "200 JSON, ok=true, version aligned");

    const ready = await getJson(`${baseUrl}/api/ready`);
    if (ready.status !== 200 || ready.body?.ready !== true) throw new Error(`/api/ready returned ${ready.status}.`);
    report.pass("API", "/api/ready", "200 JSON, ready=true");

    await smokeReadApis(baseUrl);
    await smokeCaptureApi(baseUrl);
    await smokeWebUi(baseUrl);
    await stopChild(child);
    child = null;
    verifyTemporaryDatabase(databasePath);
    report.pass("Database", "Temporary SQLite database", "schema, migrations, capture insert/update/select, foreign keys, and integrity verified");
    const backup = createBackup({ databasePath, backupDir, sourceUploadsDir: path.join(directory, "source-uploads"),
      generatedMediaDir: path.join(directory, "generated-media"), retention: 2, codeRevision: "release-gate", reason: "release-gate" });
    const drill = drillBackup(backup.backupPath);
    if (drill.drill !== "passed" || drill.externalSideEffects !== false) throw new Error("System snapshot restore drill did not remain offline.");
    report.pass("Backup", "System snapshot restore drill",
      `${drill.restored.fileCount} hashed file(s), ${drill.references.length} database reference(s), external side effects disabled`);
    report.pass("Logs", "Server stdout/stderr captured", `${stdout.length} stdout bytes, ${stderr.length} stderr bytes`);
    report.check("Logs", "No fatal server exceptions", () => assertCleanLogs(`${stdout}\n${stderr}`));
  } catch (error) {
    report.fail("Server", "Isolated smoke test", error.message || String(error));
  } finally {
    if (child) {
      try { await stopChild(child); } catch (error) { report.fail("Server", "Automatic test-server shutdown", error.message || String(error)); }
    }
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      if (fs.existsSync(directory)) throw new Error("Temporary directory remains after cleanup.");
      report.pass("Database", "Temporary database cleanup", "Removed isolated release-check data.");
    } catch (error) {
      report.fail("Database", "Temporary database cleanup", error.message || String(error));
    }
  }
}

function recordQualityDimensions({ unitTestsPassed, crossRepoPassed, versionPassed }) {
  if (unitTestsPassed && versionPassed) {
    report.pass("Quality Dimensions", "Schema syntax and contract structure", "Offline schema, migration, and negative-fixture tests executed.");
    report.pass("Quality Dimensions", "Visible content and factual relationships", "Evidence/provenance validators and content integration fixtures executed.");
  } else {
    report.notTested("Quality Dimensions", "Schema syntax and factual relationships", "The required offline test or version gate failed.");
  }
  if (crossRepoPassed) report.pass("Quality Dimensions", "CMS/Frontend contract compatibility", `Frontend ${releaseGate.frontend.commitSha} executed.`);
  else report.notTested("Quality Dimensions", "CMS/Frontend contract compatibility", "The fixed-SHA contract gate failed or was unavailable.");
  const fixturePath = path.join(root, releaseGate.finalHtmlFixture.path);
  report.check("Quality Dimensions", "Fixed published HTML fixture", () => {
    const html = fs.readFileSync(fixturePath, "utf8");
    const result = validateRenderedHtmlArtifact({
      html, status: "publish", url: releaseGate.finalHtmlFixture.url, httpStatus: 200,
      robotsTxt: "User-agent: *\nDisallow: /wp-admin/",
      sitemapXml: `<urlset><url><loc>${releaseGate.finalHtmlFixture.url}</loc></url></urlset>`,
      expectedTitle: releaseGate.finalHtmlFixture.title, expectedDescription: releaseGate.finalHtmlFixture.description,
      fixture: { type: releaseGate.finalHtmlFixture.type, frontendCommitSha: releaseGate.frontend.commitSha },
    });
    const variants = compareRenderedVariants({ mobile: html, desktop: html });
    if (!result.valid || !variants.valid) throw new Error([...result.errors, ...variants.errors].map((item) => item.code).join(", "));
    report.pass("Quality Dimensions", "content_quality", result.dimensions.content_quality.status);
    report.pass("Quality Dimensions", "seo_artifact", result.dimensions.seo_artifact.status);
    report.pass("Quality Dimensions", "structured_data", result.dimensions.structured_data.status);
    report.pass("Quality Dimensions", "rendered_html", `${result.dimensions.rendered_html.status}; fixed fixture only`);
    report.pass("Quality Dimensions", "crawler_configuration", result.dimensions.crawler_configuration.status);
    report.notTested("Quality Dimensions", "production_cost", "No paid model or production request was made by the offline fixture.");
  });
  report.notTested("Technical Accessibility", "Production WordPress/theme HTML and crawler response", "Requires a fixed Frontend SHA deployed in a real WordPress/theme environment; the CMS fixture is not production proof.");
}

async function smokeReadApis(baseUrl) {
  const routes = [
    ["Dashboard API", "/api/dashboard", (body) => body && typeof body.totals === "object"],
    ["System strategy API", "/api/system/info", (body) => body?.contentStrategy?.version === CONTENT_STRATEGY.version && body?.contentStrategy?.status === "active"],
    ["Sources API", "/api/sources", (body) => Array.isArray(body?.items)],
    ["Knowledge API", "/api/knowledge", (body) => Array.isArray(body?.items)],
    ["Editorial blueprints API", "/api/editorial-blueprints", (body) => Array.isArray(body?.items)],
    ["Content API", "/api/content", (body) => Array.isArray(body?.items)],
    ["Recommendations API", "/api/recommendations", (body) => Array.isArray(body?.items) && Object.hasOwn(body || {}, "nextCursor")],
    ["WordPress inventory API", "/api/wordpress/inventory", (body) => typeof body?.configured === "boolean" && Array.isArray(body?.items)],
    ["Search Console API", "/api/search-console", (body) => typeof body?.configured === "boolean" && Array.isArray(body?.items)],
    ["Commercial offers API", "/api/commercial/offers", (body) => Array.isArray(body?.items)],
    ["Affiliate Provider/Asset API", "/api/commercial", (body) => Array.isArray(body?.providers) && Array.isArray(body?.items) && Array.isArray(body?.opportunities)],
    ["Exception queue scan", "/api/exceptions", (body) => Array.isArray(body?.items) && body.items.length === 0],
    ["Maintenance API", "/api/maintenance", (body) => typeof body?.enabled === "boolean" && Array.isArray(body?.runs)],
  ];
  for (const [label, pathname, valid] of routes) {
    const result = await getJson(`${baseUrl}${pathname}`);
    if (result.status !== 200 || !valid(result.body)) throw new Error(`${pathname} returned an invalid response (HTTP ${result.status}).`);
    report.pass("API", label, "200 JSON");
  }
  const unknown = await getJson(`${baseUrl}/api/release-check-missing`);
  if (unknown.status !== 404 || typeof unknown.body?.error !== "string") throw new Error("Unknown API route did not return a JSON 404.");
  report.pass("API", "Unknown route handling", "404 JSON without server failure");
}

async function smokeCaptureApi(baseUrl) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const url = `https://www.xiaohongshu.com/explore/release-test-${suffix}`;
  const create = await postJson(`${baseUrl}/api/captures`, {
    url,
    title: `Release test ${suffix}`,
    text: "A manually selected release-check note with enough visible travel detail to validate capture storage safely.",
    images: [],
  });
  if (create.status !== 202 || !/^src_/.test(create.body?.id || "")) throw new Error(`Capture create failed (HTTP ${create.status}).`);
  const update = await postJson(`${baseUrl}/api/captures`, {
    url,
    title: `Release test ${suffix} updated`,
    text: "An updated manually selected release-check note proves source revision handling against the temporary database.",
    images: [],
  });
  if (update.status !== 202 || update.body?.id !== create.body.id) throw new Error(`Capture update failed (HTTP ${update.status}).`);
  const source = await getJson(`${baseUrl}/api/sources/${create.body.id}`);
  if (source.status !== 200 || source.body?.capture_version !== 2) throw new Error("Capture revision was not persisted and readable.");
  report.pass("API", "Capture write/read smoke", "temporary source insert, revision update, and detail read succeeded");
}

async function smokeWebUi(baseUrl) {
  const response = await fetchWithTimeout(`${baseUrl}/`);
  const html = await response.text();
  if (response.status !== 200 || !response.headers.get("content-type")?.includes("text/html") || !/<div\s+id=["']root["']/.test(html)) {
    throw new Error("Web UI root did not return the expected React HTML shell.");
  }
  report.pass("Web UI", "GET /", "200 HTML with React root");
  const assets = assetReferences(html);
  for (const asset of assets) {
    const assetResponse = await fetchWithTimeout(`${baseUrl}${asset}`);
    if (assetResponse.status !== 200) throw new Error(`Referenced asset ${asset} returned HTTP ${assetResponse.status}.`);
  }
  report.pass("Web UI", "Referenced JS/CSS assets", `${assets.length} production asset(s) returned 200`);
}

function verifyTemporaryDatabase(databasePath) {
  const database = openDatabase(databasePath);
  try {
    const integrity = database.prepare("PRAGMA integrity_check").get();
    if (Object.values(integrity)[0] !== "ok") throw new Error("Temporary database integrity check failed.");
    const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeys.length) throw new Error("Temporary database has foreign key violations.");
    const source = database.prepare("SELECT capture_version, title FROM sources").get();
    if (source?.capture_version !== 2 || !/updated/.test(source.title)) throw new Error("Temporary capture update was not retained.");
  } finally {
    database.close();
  }
}

function verifyHealth(result) {
  if (result.status !== 200 || result.body?.ok !== true || typeof result.body?.version !== "string" || result.body.version !== packageJson.version || result.body?.contentStrategy?.version !== CONTENT_STRATEGY.version) {
    throw new Error(`/api/health did not return the expected ready state (HTTP ${result.status}).`);
  }
}

async function waitForReadiness(baseUrl, child, logs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "connection refused";
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`Test server exited before readiness (code ${child.exitCode}).\n${logs()}`);
    try {
      const result = await getJson(`${baseUrl}/api/health`, 2_000);
      verifyHealth(result);
      return result;
    } catch (error) {
      lastError = error.message || String(error);
      await delay(300);
    }
  }
  throw new Error(`HTTP readiness timed out after ${timeoutMs}ms: ${lastError}`);
}

function isolatedEnvironment({ port, databasePath, backupDir }) {
  return {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    DATABASE_PATH: databasePath,
    BACKUP_DIR: backupDir,
    MAINTENANCE_ENABLED: "false",
    LOG_LEVEL: "info",
    LOG_FORMAT: "json",
    CAPTURE_TOKEN: "",
    ADMIN_TOKEN: "",
    KIMI_API_KEY: "",
    OPENAI_API_KEY: "",
    WORDPRESS_SITE_URL: "",
    WORDPRESS_USERNAME: "",
    WORDPRESS_APPLICATION_PASSWORD: "",
    SEARCH_CONSOLE_SITE_URL: "",
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "",
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "",
    EXCEPTION_WEBHOOK_URL: "",
    EXCEPTION_WEBHOOK_TOKEN: "",
  };
}

async function verifyExtension() {
  const extensionDir = path.join(root, "extension");
  const manifestPath = path.join(extensionDir, "manifest.json");
  let manifest;
  report.check("Chrome Extension", "Manifest JSON", () => {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.manifest_version !== 3) throw new Error("manifest_version must be 3.");
    if (manifest.version !== packageJson.version) throw new Error(`Extension version ${manifest.version} does not match package version ${packageJson.version}.`);
  });
  report.check("Chrome Extension", "Permissions and local Engine host", () => {
    for (const permission of ["activeTab", "scripting", "storage", "tabs", "alarms"]) {
      if (!manifest.permissions?.includes(permission)) throw new Error(`Missing required permission: ${permission}.`);
    }
    if (!manifest.host_permissions?.includes("http://127.0.0.1:4310/*")) throw new Error("Missing local Engine host permission.");
    if (!manifest.host_permissions?.includes("https://*.xiaohongshu.com/*")) throw new Error("Missing Xiaohongshu page host permission.");
  });
  report.check("Chrome Extension", "Referenced extension assets", () => {
    const assets = extensionAssets(manifest);
    for (const asset of assets) assertFile(path.join(extensionDir, asset), `extension/${asset}`);
    const popup = fs.readFileSync(path.join(extensionDir, manifest.action.default_popup), "utf8");
    if (!/http:\/\/127\.0\.0\.1:4310/.test(popup)) throw new Error("Popup default Engine URL is not aligned with the local server.");
    for (const injectedAsset of ["page-extractor.js", "sync-core.js", "popup-state.js"]) assertFile(path.join(extensionDir, injectedAsset), `extension/${injectedAsset}`);
  });
  report.check("Chrome Extension", "Durable repair scheduler", () => {
    const core = fs.readFileSync(path.join(extensionDir, "sync-core.js"), "utf8");
    const background = fs.readFileSync(path.join(extensionDir, "background.js"), "utf8");
    const extractor = fs.readFileSync(path.join(extensionDir, "page-extractor.js"), "utf8");
    for (const token of ["leaseNextTask", "reconcileStrandedTasks", "completed_with_failures", "concurrencyWindowSize", "mediaConcurrency"]) {
      if (!core.includes(token)) throw new Error(`Missing durable repair primitive: ${token}.`);
    }
    for (const token of ["ensureWorkerPool", "applySettingsToSession", "mediaRequests", "void drive()", "watchdog"]) {
      if (!background.includes(token)) throw new Error(`Missing background repair behavior: ${token}.`);
    }
    if (!extractor.includes("MutationObserver")) throw new Error("Background extraction must prefer DOM events over fixed polling.");
  });
}

async function runExtensionChecks() {
  try { await verifyExtension(); } catch (error) { report.fail("Chrome Extension", "Static validation", error.message || String(error)); }
}

function extensionAssets(manifest) {
  const assets = new Set();
  if (manifest.action?.default_popup) assets.add(manifest.action.default_popup);
  if (manifest.options_page) assets.add(manifest.options_page);
  if (manifest.background?.service_worker) assets.add(manifest.background.service_worker);
  for (const script of manifest.content_scripts || []) for (const asset of [...(script.js || []), ...(script.css || [])]) assets.add(asset);
  for (const asset of Object.values(manifest.icons || {})) assets.add(asset);
  const queue = [...assets];
  for (const asset of queue) {
    if (!asset.endsWith(".html")) continue;
    const html = fs.readFileSync(path.join(root, "extension", asset), "utf8");
    for (const match of html.matchAll(/<(?:script|link)[^>]+(?:src|href)=["']([^"']+)["']/g)) assets.add(match[1]);
  }
  return [...assets];
}

function verifyReferencedAssets(html, extension = null) {
  const assets = assetReferences(html).filter((asset) => !extension || asset.endsWith(extension));
  if (!assets.length) throw new Error(`No ${extension || "frontend"} assets are referenced by index.html.`);
  for (const asset of assets) {
    if (extension && !asset.endsWith(extension)) continue;
    assertFile(path.join(root, "dist", asset.replace(/^\//, "")), asset);
  }
}

function assetReferences(html) {
  return [...new Set([...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)].map((match) => match[1]))];
}

function assertCleanLogs(value) {
  const significant = String(value).replace(/ExperimentalWarning: SQLite is an experimental feature[^\n]*/gi, "");
  const pattern = /\b(?:uncaught|unhandled|fatal|EADDRINUSE|SQLITE_ERROR|Internal Server Error|UnhandledPromiseRejection)\b/i;
  const match = significant.match(pattern);
  if (match) throw new Error(`Server log contains ${match[0]}.`);
}

async function getJson(url, requestTimeout = 5_000) {
  const response = await fetchWithTimeout(url, {}, requestTimeout);
  let body;
  try { body = await response.json(); } catch { throw new Error(`${url} did not return valid JSON.`); }
  return { status: response.status, body, headers: response.headers };
}

async function postJson(url, body) {
  const response = await fetchWithTimeout(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let payload;
  try { payload = await response.json(); } catch { throw new Error(`${url} did not return valid JSON.`); }
  return { status: response.status, body: payload, headers: response.headers };
}

async function fetchWithTimeout(url, options = {}, requestTimeout = 5_000) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(requestTimeout) });
}

async function availablePort() {
  const probe = http.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function stopChild(child) {
  if (child.exitCode != null) return;
  const stopped = onceExit(child, 3_000);
  child.kill("SIGTERM");
  if (await stopped) return;
  const forced = onceExit(child, 3_000);
  child.kill("SIGKILL");
  if (!(await forced)) throw new Error(`Test server PID ${child.pid} did not exit after termination.`);
}

function onceExit(child, milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.off("exit", onExit); resolve(false); }, milliseconds);
    const onExit = () => { clearTimeout(timer); resolve(true); };
    child.once("exit", onExit);
  });
}

async function runProcess(command, args, milliseconds) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(command, args, {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // Windows command shims (including npm.cmd) need cmd.exe. Node itself does not.
        shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
      });
    } catch (error) {
      resolve({ ok: false, output: error.message || String(error), durationMs: Date.now() - startedAt });
      return;
    }
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, output: `${output}\nTimed out after ${milliseconds}ms.`, durationMs: Date.now() - startedAt });
    }, milliseconds);
    child.once("error", (error) => { clearTimeout(timer); resolve({ ok: false, output: `${output}\n${error.message}`, durationMs: Date.now() - startedAt }); });
    child.once("exit", (code) => { clearTimeout(timer); resolve({ ok: code === 0, output, durationMs: Date.now() - startedAt }); });
  });
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function npmInvocation(args) {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean);
  const cliPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (cliPath) return { command: process.execPath, args: [cliPath, ...args] };
  return { command: npmCommand(), args };
}

function assertFile(filename, label, directory = false) {
  if (!fs.existsSync(filename)) throw new Error(`${label} is missing.`);
  const stat = fs.statSync(filename);
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error(`${label} has the wrong file type.`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class ReleaseReport {
  constructor(version) {
    this.version = version;
    this.entries = [];
  }

  heading() {
    console.log("========================================");
    console.log("SoloToChina Release Check");
    console.log(`Version: ${this.version}`);
    console.log("========================================");
  }

  check(section, name, work) {
    try { work(); this.pass(section, name); return true; }
    catch (error) { this.fail(section, name, error.message || String(error)); return false; }
  }

  async command(section, name, command, args, milliseconds) {
    const result = await runProcess(command, args, milliseconds);
    const logRoot = path.join(root, 'output', 'release-check-logs');
    fs.mkdirSync(logRoot, {recursive:true});
    const logFile = path.join(logRoot, `${Date.now()}-${name.replace(/[^a-z0-9]+/gi,'-')}.log`);
    fs.writeFileSync(logFile, result.output, 'utf8');
    if (result.ok) { this.pass(section, name, `${result.durationMs} ms`); return result; }
    this.fail(section, name, `${summarize(result.output)} Full output: ${path.relative(root,logFile)}`);
    return result;
  }

  pass(section, name, detail = "") { this.entries.push({ status: "PASS", section, name, detail }); }
  warning(section, name, detail) { this.entries.push({ status: "WARNING", section, name, detail }); }
  fail(section, name, detail) { this.entries.push({ status: "FAIL", section, name, detail }); }
  notTested(section, name, detail) { this.entries.push({ status: "NOT TESTED", section, name, detail }); }

  sectionPassed(section) {
    return this.entries.filter((entry) => entry.section === section).length > 0
      && !this.entries.some((entry) => entry.section === section && entry.status === "FAIL");
  }

  finish() {
    console.log("");
    let current = "";
    for (const entry of this.entries) {
      if (entry.section !== current) { current = entry.section; console.log(`\n${current}`); }
      console.log(`${entry.status.padEnd(10)} ${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}`);
    }
    const failures = this.entries.filter((entry) => entry.status === "FAIL");
    const warnings = this.entries.filter((entry) => entry.status === "WARNING");
    const notTested = this.entries.filter((entry) => entry.status === "NOT TESTED");
    const passed = this.entries.filter((entry) => entry.status === "PASS");
    console.log("\n========================================");
    console.log(failures.length ? "RESULT: OFFLINE RELEASE GATE FAILED" : "RESULT: OFFLINE RELEASE GATE PASSED");
    console.log(`Mandatory checks: ${passed.length} passed`);
    console.log(`Warnings: ${warnings.length}`);
    console.log(`Not tested/unconfigured: ${notTested.length}`);
    console.log(`Failures: ${failures.length}`);
    if (failures.length) {
      console.log("\nFAILURES:");
      failures.forEach((entry, index) => console.log(`${index + 1}. ${entry.section} / ${entry.name}: ${entry.detail}`));
    }
    console.log("========================================");
    if (failures.length) process.exitCode = 1;
  }
}

function summarize(value) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  return text.length > 700 ? `...${text.slice(-697)}` : text || "Process failed without output.";
}

report = new ReleaseReport(packageJson.version);
await main();
