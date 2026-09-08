import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { createApplication } from "../src/server.mjs";

test("Favorites Sync APIs batch identities, persist a chunked lossless capture, and expose aggregate run telemetry", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stc-favorites-api-"));
  const config = loadConfig({
    HOST: "127.0.0.1", PORT: "0", DATABASE_PATH: path.join(directory, "api.sqlite"),
    CAPTURE_TOKEN: "capture-fixture", CAPTURE_UPLOADS_DIR: path.join(directory, "capture-uploads"),
    CAPTURE_UPLOAD_CHUNK_BYTES: String(512 * 1024), MAINTENANCE_ENABLED: "false", LOG_LEVEL: "error",
  });
  const app = createApplication(config);
  await app.start();
  t.after(async () => { await app.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { authorization: "Bearer capture-fixture", "content-type": "application/json" };

  const denied = await fetch(`${baseUrl}/api/captures/identity-check`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"items":[]}' });
  assert.equal(denied.status, 401);
  const initial = await fetch(`${baseUrl}/api/captures/identity-check`, { method: "POST", headers,
    body: JSON.stringify({ items: [{ externalId: "chunked-note", url: "https://www.xiaohongshu.com/explore/chunked-note" }] }) });
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).items[0].known, false);

  const text = `${"完整正文。".repeat(24_000)}TEXT-TAIL`;
  const html = `<article>${"lossless-dom".repeat(420_000)}DOM-TAIL</article>`;
  const payload = {
    url: "https://www.xiaohongshu.com/explore/chunked-note", title: "Chunked capture", text, html,
    acquisitionOrigin: "xhs_favorites_sync", syncScopeKey: "scope:api-fixture", images: [], videos: [],
    completeness: { text: { complete: true }, dom: { complete: true },
      images: { expected: 0, captured: 0, complete: true, traversed: true },
      videos: { expected: 0, captured: 0, complete: true, traversed: true }, overall: "complete" },
    client: { extensionVersion: "1.17.0" },
  };
  const bytes = Buffer.from(JSON.stringify(payload));
  assert.ok(bytes.length > 4_000_000);
  const create = await fetch(`${baseUrl}/api/capture-uploads`, { method: "POST", headers,
    body: JSON.stringify({ size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") }) });
  assert.equal(create.status, 201);
  const upload = await create.json();
  for (let index = 0; index < upload.chunkCount; index += 1) {
    const start = index * upload.chunkBytes;
    const response = await fetch(`${baseUrl}/api/capture-uploads/${upload.uploadId}/chunks/${index}`, {
      method: "PUT", headers: { authorization: "Bearer capture-fixture", "content-type": "application/octet-stream" },
      body: bytes.subarray(start, Math.min(bytes.length, start + upload.chunkBytes)),
    });
    assert.equal(response.status, 200);
  }
  const completed = await fetch(`${baseUrl}/api/capture-uploads/${upload.uploadId}/complete`, { method: "POST", headers, body: "{}" });
  assert.equal(completed.status, 202);
  const saved = await completed.json();
  assert.equal(app.repository.getSource(saved.id).raw_text, text);
  assert.equal(app.repository.getSource(saved.id).raw_html, html);

  const identity = await fetch(`${baseUrl}/api/captures/identity-check`, { method: "POST", headers,
    body: JSON.stringify({ items: [{ externalId: "chunked-note", url: payload.url }, { externalId: "unknown-note", url: "https://www.xiaohongshu.com/explore/unknown-note" }] }) });
  const identityRows = (await identity.json()).items;
  assert.deepEqual(identityRows.map((item) => item.known), [true, false]);

  const telemetry = await fetch(`${baseUrl}/api/favorites-sync-runs`, { method: "POST", headers, body: JSON.stringify({
    sessionId: "11111111-1111-4111-8111-111111111111", scopeKey: "scope:api-fixture", scopeUrl: "https://www.xiaohongshu.com/user/profile/test?tab=fav",
    scopeLabel: "Favorites", mode: "incremental", status: "completed", stats: { scanned: 20, known: 19, new: 1, captured: 1 },
    startedAt: "2026-09-08T00:00:00.000Z", completedAt: "2026-09-08T00:01:00.000Z", extensionVersion: "1.17.0",
  }) });
  assert.equal(telemetry.status, 200);
  assert.equal((await telemetry.json()).duration_ms, 60_000);
  const runs = await (await fetch(`${baseUrl}/api/favorites-sync-runs`, { headers: { authorization: "Bearer capture-fixture" } })).json();
  assert.equal(runs.items[0].stats.captured, 1);
  assert.equal(runs.items[0].stats.favorites_scanned, 20);
  assert.equal(runs.items[0].stats.favorites_capture_success, 1);
  assert.equal(runs.items[0].stats.favorites_sync_duration, 60_000);

  while (app.pipeline.working) await new Promise((resolve) => setTimeout(resolve, 5));
});
