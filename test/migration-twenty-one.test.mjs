import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openDatabase } from "../src/db.mjs";

test("migration 21 preserves v20 file evidence and extends Source storage for video", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-migration-21-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "v20.sqlite");
  const dbModulePath = fileURLToPath(new URL("../src/db.mjs", import.meta.url));
  const v20ModulePath = path.join(directory, "db-v20.mjs");
  const source = fs.readFileSync(dbModulePath, "utf8").replace("  if (current < 21) migrationTwentyOne(db);\n", "");
  fs.writeFileSync(v20ModulePath, source);
  const { openDatabase: openV20Database } = await import(`${pathToFileURL(v20ModulePath).href}?v=20`);
  const v20 = openV20Database(databasePath);
  v20.prepare(`
    INSERT INTO sources(id, adapter, external_id, canonical_url, submitted_url, source_kind, submission_metadata_json,
      title, author_name, author_url, published_at, captured_at, raw_text, raw_html, raw_payload_json, content_hash,
      capture_version, status, created_at, updated_at)
    VALUES ('src-v20','manual','fixture','manual-source://fixture','','images','{}','Fixture','Operator','',NULL,
      '2026-09-05T00:00:00.000Z','Preserved manual source evidence text.','','{}','hash',1,'captured',
      '2026-09-05T00:00:00.000Z','2026-09-05T00:00:00.000Z')
  `).run();
  v20.prepare("INSERT INTO source_assets(id, source_id, kind, remote_url, alt_text, position, local_path, mime_type, original_filename) VALUES ('asset-v20','src-v20','image','manual-asset://fixture/0','fixture',0,'/data/fixture.png','image/png','fixture.png')").run();
  v20.prepare("INSERT INTO source_files(id, source_id, file_kind, original_filename, mime_type, storage_path, size_bytes, sha256, created_at) VALUES ('file-v20','src-v20','image','fixture.png','image/png','/data/fixture.png',42,'sha','2026-09-05T00:00:00.000Z')").run();
  assert.equal(v20.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 20);
  v20.close();

  const upgraded = openDatabase(databasePath);
  try {
    assert.equal(upgraded.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 21);
    assert.equal(upgraded.prepare("SELECT kind FROM source_assets WHERE id='asset-v20'").get().kind, "image");
    assert.equal(upgraded.prepare("SELECT file_kind FROM source_files WHERE id='file-v20'").get().file_kind, "image");
    upgraded.prepare("INSERT INTO source_assets(id, source_id, kind, remote_url, alt_text, position, local_path, mime_type, original_filename) VALUES ('asset-video','src-v20','video','manual-asset://fixture/video','video',1,'/data/video.mp4','video/mp4','video.mp4')").run();
    upgraded.prepare("INSERT INTO source_files(id, source_id, file_kind, original_filename, mime_type, storage_path, size_bytes, sha256, created_at) VALUES ('file-video','src-v20','video','video.mp4','video/mp4','/data/video.mp4',100,'video-sha','2026-09-06T00:00:00.000Z')").run();
    assert.deepEqual(upgraded.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    upgraded.close();
  }
});
