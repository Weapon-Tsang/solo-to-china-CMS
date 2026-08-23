import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { createApplication } from "../src/server.mjs";

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
  assert.equal(health.version, "1.2.0");
  assert.equal(typeof health.queueActive, "number");
  const readyResponse = await fetch(`${baseUrl}/api/ready`);
  assert.equal(readyResponse.status, 200);
  assert.equal((await readyResponse.json()).database, "ready");
  const maintenance = await (await fetch(`${baseUrl}/api/maintenance`)).json();
  assert.equal(maintenance.enabled, false);
  assert.equal(maintenance.telemetry.windowHours, 24);
  assert.equal(maintenance.notifications.configured, false);
  const exceptions = await (await fetch(`${baseUrl}/api/exceptions`)).json();
  assert.deepEqual(exceptions.items, []);
});

test("non-loopback binding refuses to start without both operational tokens", () => {
  const config = loadConfig({ HOST: "0.0.0.0", DATABASE_PATH: "data/should-not-open.sqlite" });
  assert.throws(() => createApplication(config), /requires both CAPTURE_TOKEN and ADMIN_TOKEN/);
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
