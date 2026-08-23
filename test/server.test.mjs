import assert from "node:assert/strict";
import fs from "node:fs";
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
    headers: { authorization: "Bearer admin-secret" },
  });
  assert.equal(allowed.status, 200);
  const exceptions = await (await fetch(`${baseUrl}/api/exceptions`)).json();
  assert.deepEqual(exceptions.items, []);
});

test("non-loopback binding refuses to start without both operational tokens", () => {
  const config = loadConfig({ HOST: "0.0.0.0", DATABASE_PATH: "data/should-not-open.sqlite" });
  assert.throws(() => createApplication(config), /requires both CAPTURE_TOKEN and ADMIN_TOKEN/);
});
