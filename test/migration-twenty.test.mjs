import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openDatabase } from "../src/db.mjs";

test("migration 20 preserves populated legacy Sources and their evidence assets", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-migration-20-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "legacy.sqlite");
  const dbModulePath = fileURLToPath(new URL("../src/db.mjs", import.meta.url));
  const legacyModulePath = path.join(directory, "db-v19.mjs");
  const source = fs.readFileSync(dbModulePath, "utf8").replace("  if (current < 20) migrationTwenty(db);\n", "");
  fs.writeFileSync(legacyModulePath, source);
  const { openDatabase: openLegacyDatabase } = await import(`${pathToFileURL(legacyModulePath).href}?v=19`);
  const legacy = openLegacyDatabase(databasePath);
  legacy.prepare(`
    INSERT INTO sources(id, adapter, external_id, canonical_url, title, author_name, author_url, published_at,
      captured_at, raw_text, raw_html, raw_payload_json, content_hash, capture_version, status, created_at, updated_at)
    VALUES ('src-legacy','xiaohongshu','legacy-note','https://www.xiaohongshu.com/explore/legacy-note',
      'Legacy note','Author','',NULL,'2026-09-01T00:00:00.000Z','Legacy travel evidence long enough to retain.',
      '', '{}', 'legacy-hash', 2, 'captured', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
  `).run();
  legacy.prepare("INSERT INTO source_assets(id, source_id, kind, remote_url, alt_text, position) VALUES ('asset-legacy','src-legacy','image','https://ci.xiaohongshu.com/example.jpg','evidence',0)").run();
  assert.equal(legacy.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 19);
  legacy.close();

  const upgraded = openDatabase(databasePath);
  try {
    assert.equal(upgraded.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 20);
    const preserved = upgraded.prepare("SELECT * FROM sources WHERE id='src-legacy'").get();
    assert.equal(preserved.adapter, "xiaohongshu");
    assert.equal(preserved.source_kind, "xiaohongshu_note");
    assert.equal(preserved.submitted_url, "https://www.xiaohongshu.com/explore/legacy-note");
    assert.equal(preserved.capture_version, 2);
    const asset = upgraded.prepare("SELECT * FROM source_assets WHERE id='asset-legacy'").get();
    assert.equal(asset.source_id, "src-legacy");
    assert.equal(asset.local_path, "");
    assert.deepEqual(upgraded.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    upgraded.close();
  }
});
