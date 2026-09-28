import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGoogleAccessTokenProvider } from "../src/google-access-token.mjs";

test("local ADC refreshes once across concurrent Vertex requests", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cms-adc-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const credential = path.join(directory, "adc.json");
  fs.writeFileSync(credential, "{}");
  const previous = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  process.env.GOOGLE_APPLICATION_CREDENTIALS = credential;
  t.after(() => { if (previous === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS; else process.env.GOOGLE_APPLICATION_CREDENTIALS = previous; });
  let calls = 0;
  const provider = createGoogleAccessTokenProvider({ googleAuthMode: "adc" },
    () => { throw new Error("local ADC must not call GCE metadata"); },
    () => ({ getClient: async () => ({ credentials: { expiry_date: Date.now() + 3_600_000 }, getAccessToken: async () => { calls += 1; return { token: "adc-token" }; } }) }));
  assert.deepEqual(await Promise.all(Array.from({ length: 12 }, () => provider())), Array(12).fill("adc-token"));
  assert.equal(calls, 1);
  assert.equal(await provider(), "adc-token");
  assert.equal(calls, 1);
});

test("missing local ADC fails before metadata and GCE metadata remains supported", async () => {
  const previous = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(os.tmpdir(), "cms-missing-adc.json");
  try {
    const local = createGoogleAccessTokenProvider({ googleAuthMode: "adc" }, () => { throw new Error("metadata requested"); });
    await assert.rejects(local(), (error) => error.code === "GOOGLE_ADC_UNAVAILABLE" && /No ADC credential file/.test(error.message));
  } finally { if (previous === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS; else process.env.GOOGLE_APPLICATION_CREDENTIALS = previous; }
  let calls = 0;
  const gce = createGoogleAccessTokenProvider({ googleAuthMode: "metadata" }, async (_url, options) => {
    calls += 1;
    assert.equal(options.headers["Metadata-Flavor"], "Google");
    return Response.json({ access_token: "gce-token", expires_in: 300 });
  });
  assert.equal(await gce(), "gce-token");
  assert.equal(await gce(), "gce-token");
  assert.equal(calls, 1);
});
