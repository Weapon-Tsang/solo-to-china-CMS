import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openDatabase, SCHEMA_VERSION } from "../src/db.mjs";

test("migration 46 separates submission identity from source identity", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stc-migration-46-"));
  const db = openDatabase(path.join(directory, "test.sqlite"));
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, SCHEMA_VERSION);
  const columns = new Set(db.prepare("PRAGMA table_info(sources)").all().map((row) => row.name));
  for (const name of ["submitted_by", "source_publisher", "source_identity", "source_version_identity", "original_url", "final_url"]) {
    assert.ok(columns.has(name));
  }
});

test("migration 46 treats legacy manual-submission author as unknown", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stc-migration-46-legacy-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "v45.sqlite");
  const source = fs.readFileSync(fileURLToPath(new URL("../src/db.mjs", import.meta.url)), "utf8")
    .replace(/^  if \(current < (\d+)\).*$/gm, (line, version) => Number(version) >= 46 ? "" : line);
  const modulePath = path.join(directory, "db-v45.mjs");
  fs.writeFileSync(modulePath, source);
  const { openDatabase: openV45Database } = await import(`${pathToFileURL(modulePath).href}?v=45`);
  const legacy = openV45Database(databasePath);
  legacy.prepare(`INSERT INTO sources(id,adapter,external_id,canonical_url,submitted_url,source_kind,submission_metadata_json,
    title,author_name,author_url,published_at,captured_at,raw_text,raw_html,raw_payload_json,content_hash,status,created_at,updated_at)
    VALUES ('legacy-manual','manual','legacy','manual-source://legacy','https://example.com/article','web_url','{}',
    'Legacy','人工提交','',NULL,'2026-09-01T00:00:00.000Z','legacy evidence text','','{}','legacy-hash','captured',
    '2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z')`).run();
  legacy.close();

  const upgraded = openDatabase(databasePath);
  try {
    const migrated = upgraded.prepare("SELECT * FROM sources WHERE id='legacy-manual'").get();
    assert.equal(migrated.author_name, "");
    assert.equal(migrated.submitted_by, "");
    assert.equal(migrated.original_url, "https://example.com/article");
    assert.equal(migrated.source_identity, "url:https://example.com/article");
  } finally { upgraded.close(); }
});
