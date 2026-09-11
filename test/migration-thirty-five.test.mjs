import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openDatabase } from "../src/db.mjs";

test("migration 35 adds lossless capture versions, rights, identity indexes, and race-safe jobs", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-migration-35-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "v34.sqlite");
  const source = fs.readFileSync(fileURLToPath(new URL("../src/db.mjs", import.meta.url)), "utf8")
    .replace(/^  if \(current < (\d+)\).*$/gm, (line, version) => Number(version) >= 35 ? "" : line);
  const modulePath = path.join(directory, "db-v34.mjs");
  fs.writeFileSync(modulePath, source);
  const { openDatabase: openV34Database } = await import(`${pathToFileURL(modulePath).href}?v=34`);
  const legacy = openV34Database(databasePath);
  legacy.prepare(`INSERT INTO sources(id,adapter,external_id,canonical_url,submitted_url,source_kind,submission_metadata_json,
    title,author_name,author_url,published_at,captured_at,raw_text,raw_html,raw_payload_json,content_hash,capture_version,status,created_at,updated_at)
    VALUES ('src-v34','xiaohongshu','note-v34','https://www.xiaohongshu.com/explore/note-v34','https://www.xiaohongshu.com/explore/note-v34',
    'xiaohongshu_note','{}','Legacy favorite','Owner','',NULL,'2026-09-01T00:00:00.000Z','complete legacy text','','{}','legacy-hash',2,'captured',
    '2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z')`).run();
  legacy.prepare("INSERT INTO source_assets(id,source_id,kind,remote_url,alt_text,position,local_path,mime_type,original_filename) VALUES ('asset-v34','src-v34','image','https://ci.xhscdn.com/legacy.jpg','legacy',0,'','image/jpeg','')").run();
  for (const id of ["job-a", "job-b"]) legacy.prepare("INSERT INTO jobs(id,type,entity_id,status,available_at,created_at,updated_at) VALUES (?,'extract_source','src-v34','queued',datetime('now'),datetime('now'),datetime('now'))").run(id);
  assert.equal(legacy.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 34);
  legacy.close();

  const upgraded = openDatabase(databasePath);
  try {
    assert.ok(upgraded.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version >= 35);
    const migrated = upgraded.prepare("SELECT * FROM sources WHERE id='src-v34'").get();
    assert.equal(migrated.completeness_status, "complete");
    assert.equal(migrated.authorization_status, "owner_confirmed");
    assert.equal(migrated.acquisition_origin, "xhs_manual_extension");
    assert.equal(migrated.publishable, 1);
    assert.equal(upgraded.prepare("SELECT authorization_status FROM source_assets WHERE id='asset-v34'").get().authorization_status, "owner_confirmed");
    const version = upgraded.prepare("SELECT * FROM capture_versions WHERE source_id='src-v34'").get();
    assert.equal(version.capture_version, 2);
    assert.equal(version.acquisition_origin, "xhs_manual_extension");
    assert.equal(JSON.parse(version.assets_json)[0].url, "https://ci.xhscdn.com/legacy.jpg");
    assert.equal(upgraded.prepare("SELECT COUNT(*) AS count FROM jobs WHERE dedupe_key='extract_source:src-v34' AND status IN ('queued','running')").get().count, 1);
    assert.equal(upgraded.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status='failed'").get().count, 1);
    assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='favorites_sync_runs'").get());
    assert.deepEqual(upgraded.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { upgraded.close(); }
});
