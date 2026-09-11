import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { createApplication } from "../src/server.mjs";

test("the removed manual planning module and dashboard counters stay absent", async () => {
  await assert.rejects(fs.promises.access(new URL("../src/editorial-assignments.mjs", import.meta.url)));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-planning-removal-"));
  const app = createApplication(loadConfig({
    HOST: "127.0.0.1", PORT: "0", DATABASE_PATH: path.join(directory, "removal.sqlite"),
    ADMIN_TOKEN: "planning-removal-token", MAINTENANCE_ENABLED: "false", LOG_LEVEL: "error",
  }));
  try {
    const dashboard = app.repository.dashboard();
    assert.equal("assignments" in dashboard.actionCounts, false);
    assert.equal("editorialAssignments" in dashboard.totals, false);
    assert.equal("editorialAssignmentsNeedingSources" in dashboard.totals, false);
  } finally {
    app.repository.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("removed manual planning HTTP endpoints cannot create, list, or mutate work", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-planning-removal-api-"));
  const app = createApplication(loadConfig({
    HOST: "127.0.0.1", PORT: "0", DATABASE_PATH: path.join(directory, "api.sqlite"),
    ADMIN_TOKEN: "planning-removal-token", MAINTENANCE_ENABLED: "false", LOG_LEVEL: "error",
  }));
  await app.start();
  t.after(async () => {
    await app.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { authorization: "Bearer planning-removal-token", "content-type": "application/json" };
  const requests = [
    fetch(`${baseUrl}/api/editorial-assignments`, { headers }),
    fetch(`${baseUrl}/api/editorial-assignments`, { method: "POST", headers, body: "{}" }),
    fetch(`${baseUrl}/api/editorial-assignments/legacy-id`, { method: "DELETE", headers }),
    fetch(`${baseUrl}/api/editorial-assignments/legacy-id/recheck`, { method: "POST", headers }),
    fetch(`${baseUrl}/api/editorial-assignments/legacy-id/queue`, { method: "POST", headers }),
  ];
  for (const response of await Promise.all(requests)) assert.equal(response.status, 404);
});
