import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { CONTENT_STRATEGY } from "../src/content-strategy.mjs";
import { createApplication } from "../src/server.mjs";
import { VERSION } from "../src/version.mjs";

test("HTTP API accepts a manual capture and exposes pipeline state", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-to-china-api-test-"));
  const config = loadConfig({
    HOST: "127.0.0.1",
    PORT: "0",
    DATABASE_PATH: path.join(directory, "api.sqlite"),
    MAINTENANCE_ENABLED: "false",
    LOG_LEVEL: "error",
  });
  const app = createApplication(config);
  await app.start();
  t.after(async () => {
    await app.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const address = app.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const response = await fetch(`${baseUrl}/api/captures`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://www.xiaohongshu.com/explore/api-test",
      title: "Chengdu first visit",
      text: "A manually selected Chengdu travel note with enough content to capture safely.",
      images: [],
    }),
  });
  assert.equal(response.status, 202);
  const saved = await response.json();
  assert.match(saved.id, /^src_/);

  while (app.pipeline.working) await new Promise((resolve) => setTimeout(resolve, 5));
  while (await app.pipeline.runOne()) { /* drain follow-up aggregation jobs */ }
  const dashboard = await (await fetch(`${baseUrl}/api/dashboard`)).json();
  assert.equal(dashboard.totals.sources, 1);
  const sources = await (await fetch(`${baseUrl}/api/sources`)).json();
  assert.equal(sources.items[0].destination_name, "Chengdu");
});

test("admin mutations require ADMIN_TOKEN and responses include security headers", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-to-china-auth-test-"));
  const config = loadConfig({
    HOST: "127.0.0.1",
    PORT: "0",
    DATABASE_PATH: path.join(directory, "auth.sqlite"),
    ADMIN_TOKEN: "admin-secret",
    MAINTENANCE_ENABLED: "false",
    LOG_LEVEL: "error",
  });
  const app = createApplication(config);
  await app.start();
  t.after(async () => {
    await app.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  const denied = await fetch(`${baseUrl}/api/pipeline/run-one`, { method: "POST" });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get("x-frame-options"), "DENY");
  const allowed = await fetch(`${baseUrl}/api/pipeline/run-one`, {
    method: "POST",
    headers: { authorization: "Bearer admin-secret", "x-request-id": "test-request-id" },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("x-request-id"), "test-request-id");
  const health = await (await fetch(`${baseUrl}/api/health`)).json();
  assert.equal(health.version, VERSION);
  assert.equal(typeof health.queueActive, "number");
  assert.equal(health.aiProvider, null);
  assert.equal(health.searchConsoleConfigured, false);
  const readyResponse = await fetch(`${baseUrl}/api/ready`);
  assert.equal(readyResponse.status, 200);
  assert.equal((await readyResponse.json()).database, "ready");
  const maintenance = await (await fetch(`${baseUrl}/api/maintenance`)).json();
  assert.equal(maintenance.enabled, false);
  assert.equal(maintenance.telemetry.windowHours, 24);
  assert.equal(maintenance.notifications.configured, false);
  assert.equal(maintenance.searchConsoleSync, null);
  const searchConsole = await (await fetch(`${baseUrl}/api/search-console`)).json();
  assert.deepEqual(searchConsole, { configured: false, sync: null, items: [] });
  const exceptions = await (await fetch(`${baseUrl}/api/exceptions`)).json();
  assert.deepEqual(exceptions.items, []);
  app.repository.db.prepare("INSERT INTO destinations(id, slug, name, created_at, updated_at) VALUES ('dst-api', 'chongqing', 'Chongqing', 'now', 'now')").run();
  app.repository.db.prepare(`
    INSERT INTO knowledge_facts(id, destination_id, normalized_key, subject, predicate, consensus_status,
      preferred_value, support_count, contradiction_count, evidence_json, updated_at,
      freshness_state, latest_evidence_at, verification_priority)
    VALUES ('fact-api', 'dst-api', 'hongyadong.lighting', 'Hongyadong', 'has evening lighting', 'conflicted',
      '20:00-23:00', 1, 1, '[]', '2026-09-02T00:00:00.000Z', 'current', '2026-09-02T00:00:00.000Z', 'requires_official')
  `).run();
  const unresolved = await fetch(`${baseUrl}/api/knowledge/fact-api/resolve`, { method: "POST" });
  assert.equal(unresolved.status, 401);
  const resolved = await fetch(`${baseUrl}/api/knowledge/fact-api/resolve`, {
    method: "POST",
    headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
    body: JSON.stringify({ preferredValue: "19:30-22:30", note: "Operator notice" }),
  });
  assert.equal(resolved.status, 200);
  assert.equal((await resolved.json()).preferredValue, "19:30-22:30");
  const content = await (await fetch(`${baseUrl}/api/content`)).json();
  assert.ok(Array.isArray(content.items));
  assert.ok(Array.isArray(content.opportunities));
  const missing = await fetch(`${baseUrl}/api/not-found`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "Not found." });

  const system = await (await fetch(`${baseUrl}/api/system/info`)).json();
  assert.equal(system.contentStrategy.version, CONTENT_STRATEGY.version);
  assert.equal(system.contentStrategy.status, "active");
  assert.equal(system.contentStrategy.document, CONTENT_STRATEGY.document);

  const strategy = await fetch(`${baseUrl}/api/content-strategy`, { headers: { authorization: "Bearer admin-secret" } });
  assert.equal(strategy.status, 200);
  const strategyBody = await strategy.json();
  assert.equal(strategyBody.version, CONTENT_STRATEGY.version);
  assert.equal(strategyBody.history[0].version, CONTENT_STRATEGY.version);
  assert.equal(strategyBody.history[0].status, "active");
  assert.match(strategyBody.markdown, /SoloToChina Content Production Strategy/);
  const download = await fetch(`${baseUrl}/api/content-strategy/download`, { headers: { authorization: "Bearer admin-secret" } });
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition"), /attachment/);
  assert.match(await download.text(), /Authorized source images and reader trust/);

  const settings = await (await fetch(`${baseUrl}/api/settings/ai`)).json();
  assert.equal(settings.model, "kimi-k3");
  assert.equal(settings.models.length, 4);
  assert.equal(settings.visual.id, "vertex-gemini-3.1-flash-image");
  assert.equal(settings.visual.supportsGeneration, true);
  assert.equal(settings.storage.mode, "local");
  assert.equal(settings.storage.crossDevice, false);
  const changed = await fetch(`${baseUrl}/api/settings/ai`, {
    method: "POST",
    headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "kimi-k3" }),
  });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).model, "kimi-k3");
  const visualChanged = await fetch(`${baseUrl}/api/settings/visuals`, {
    method: "POST",
    headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "vertex-gemini-3.1-flash-image" }),
  });
  assert.equal(visualChanged.status, 200);
  assert.equal((await visualChanged.json()).model, "gemini-3.1-flash-image");
});

test("Kimi configuration uses the provider's server-side defaults", () => {
  const config = loadConfig({ KIMI_API_KEY: "kimi-test-key" });
  assert.equal(config.kimi.apiKey, "kimi-test-key");
  assert.equal(config.kimi.model, "kimi-k2.7-code");
  assert.equal(config.ai.defaultModel, "kimi-k3");
  assert.equal(config.visuals.defaultModel, "vertex-gemini-3.1-flash-image");
  assert.equal(config.kimi.baseUrl, "https://api.moonshot.cn/v1");
  assert.equal(config.kimi.maxCompletionTokens, 16_000);
  assert.equal(config.kimi.requestTimeoutMs, 360_000);
  assert.equal(config.kimi.imageTimeoutMs, 20_000);
});

test("capture-only Cloudflare hostname cannot expose dashboard data", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-to-china-capture-host-test-"));
  const config = loadConfig({
    HOST: "127.0.0.1", PORT: "0", DATABASE_PATH: path.join(directory, "capture-host.sqlite"),
    CAPTURE_TOKEN: "capture-secret", ADMIN_TOKEN: "admin-secret", CAPTURE_HOST: "capture.example.test",
    MAINTENANCE_ENABLED: "false", LOG_LEVEL: "error",
  });
  const app = createApplication(config);
  await app.start();
  t.after(async () => {
    await app.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  const requestOnCaptureHost = (pathname, headers = {}) => new Promise((resolve, reject) => {
    const request = http.request(`${baseUrl}${pathname}`, { headers: { host: "capture.example.test", ...headers } }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.end();
  });
  assert.equal(await requestOnCaptureHost("/api/dashboard"), 404);
  assert.equal(await requestOnCaptureHost("/api/health"), 200);
  assert.equal(await requestOnCaptureHost("/api/sources/src_unknown"), 401);
  assert.equal(await requestOnCaptureHost("/api/sources/src_unknown", { authorization: "Bearer capture-secret" }), 404);
});

test("non-loopback binding refuses to start without both operational tokens", () => {
  const config = loadConfig({ HOST: "0.0.0.0", DATABASE_PATH: "data/should-not-open.sqlite" });
  assert.throws(() => createApplication(config), /requires CAPTURE_TOKEN, ADMIN_TOKEN, ADMIN_PASSWORD, and SESSION_SECRET/);
});

test("dashboard password login creates a secure session and requires an initial password change", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-to-china-password-auth-test-"));
  const config = loadConfig({
    HOST: "127.0.0.1", PORT: "0", DATABASE_PATH: path.join(directory, "password-auth.sqlite"),
    ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "123456", SESSION_SECRET: "test-session-secret-with-enough-entropy",
    MAINTENANCE_ENABLED: "false", LOG_LEVEL: "error",
  });
  const app = createApplication(config);
  await app.start();
  t.after(async () => { await app.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

  const before = await (await fetch(`${baseUrl}/api/auth/status`)).json();
  assert.deepEqual(before, { enabled: true, authenticated: false, username: null, mustChangePassword: false });
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "123456" }),
  });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).mustChangePassword, true);
  const cookie = login.headers.get("set-cookie");
  assert.ok(cookie?.includes("HttpOnly") && cookie.includes("SameSite=Strict"));
  const blocked = await fetch(`${baseUrl}/api/pipeline/run-one`, { method: "POST", headers: { cookie } });
  assert.equal(blocked.status, 403);
  const changed = await fetch(`${baseUrl}/api/auth/change-password`, {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ currentPassword: "123456", nextPassword: "longer-and-private-password" }),
  });
  assert.equal(changed.status, 200);
  const freshCookie = changed.headers.get("set-cookie");
  const allowed = await fetch(`${baseUrl}/api/pipeline/run-one`, { method: "POST", headers: { cookie: freshCookie } });
  assert.equal(allowed.status, 200);
  const credentials = await fetch(`${baseUrl}/api/auth/update-credentials`, {
    method: "POST", headers: { cookie: freshCookie, "content-type": "application/json" },
    body: JSON.stringify({ currentPassword: "longer-and-private-password", nextUsername: "solo-founder", nextPassword: "another-long-private-password" }),
  });
  assert.equal(credentials.status, 200);
  assert.equal((await credentials.json()).username, "solo-founder");
  const oldLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "longer-and-private-password" }),
  });
  assert.equal(oldLogin.status, 401);
  const newLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "solo-founder", password: "another-long-private-password" }),
  });
  assert.equal(newLogin.status, 200);
});

test("failed HTTP bind does not start pipeline or maintenance side effects", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-to-china-bind-test-"));
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => blocker.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const config = loadConfig({
    HOST: "127.0.0.1",
    PORT: String(blocker.address().port),
    DATABASE_PATH: path.join(directory, "bind.sqlite"),
    BACKUP_DIR: path.join(directory, "backups"),
  });
  const app = createApplication(config);
  await assert.rejects(() => app.start(), (error) => error.code === "EADDRINUSE");
  assert.equal(app.pipeline.timer, null);
  assert.equal(app.maintenance.timer, null);
  assert.deepEqual(app.repository.listMaintenanceRuns(), []);
  assert.equal(fs.existsSync(config.maintenance.backupDir), false);
  app.repository.db.close();
});
