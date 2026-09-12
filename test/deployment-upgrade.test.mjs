import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const app = fileURLToPath(new URL('..', import.meta.url));
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stc-deploy-probe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const work = path.join(root, 'ops'); fs.mkdirSync(work);
  const legacy = fs.readFileSync(path.join(app, 'src/db.mjs'), 'utf8')
    .replace(/^  if \(current < (\d+)\).*$/gm, (line, n) => Number(n) > 59 ? '' : line);
  const module = path.join(root, 'db59.mjs'); fs.writeFileSync(module, legacy);
  const filename = path.join(root, 'solo-to-china.sqlite');
  const db = (await import(pathToFileURL(module).href)).openDatabase(filename);
  db.prepare(`INSERT INTO sources(id,adapter,external_id,canonical_url,captured_at,raw_text,raw_html,raw_payload_json,content_hash,created_at,updated_at,capture_version)
    VALUES ('original','manual','original','manual://original','now','PRIVATE original evidence','','{}','hash','now','now',3)`).run();
  fs.mkdirSync(path.join(root, 'source-uploads'));
  const original = path.join(root, 'source-uploads/original.bin'); fs.writeFileSync(original, 'original bytes');
  db.prepare("INSERT INTO source_assets(id,source_id,kind,remote_url,position,local_path) VALUES ('asset','original','image','https://example.test/image',0,?)").run(original);
  db.prepare(`INSERT INTO source_segments(id,source_id,segment_type,sequence,asset_id,content_hash,semantic_hash,created_at,updated_at,capture_version)
    VALUES ('segment','original','image',0,'asset','hash','hash','now','now',3)`).run();
  db.prepare("INSERT INTO evidence_spans(id,source_id,segment_id,asset_id,locator_type,created_at) VALUES ('span','original','segment','asset','asset','now')").run();
  db.close();
  const run = mode => spawnSync(process.execPath, ['deployment/gce/verify-upgrade.mjs', mode], {
    cwd: app, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, STC_PROBE_ROOT: root, STC_PROBE_WORK: work, STC_PROBE_APP: app, OLD_IMAGE: 'fixture-old-image' },
  });
  return { root, work, filename, original, run };
}
test('deployment probe rehearses schema 59 to 67, preserves cited IDs and rolls back paired DB without deleting originals', async t => {
  const f = await fixture(t);
  for (const mode of ['backup', 'rehearse', 'migrate']) {
    const result = f.run(mode);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /PRIVATE original evidence|original bytes/);
  }
  let db = new DatabaseSync(f.filename);
  assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 67);
  assert.equal(db.prepare('SELECT capture_version FROM source_assets').get().capture_version, 3);
  db.close();
  const restored = f.run('restore'); assert.equal(restored.status, 0, restored.stderr);
  db = new DatabaseSync(f.filename);
  assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 59);
  assert.equal(db.prepare('SELECT asset_id FROM evidence_spans').get().asset_id, 'asset'); db.close();
  assert.equal(fs.readFileSync(f.original, 'utf8'), 'original bytes');
  assert.ok(fs.readdirSync(f.root).some(name => name.startsWith('failed-database-')));
});
test('deployment probe blocks changed content and refuses to restore a corrupted snapshot', async t => {
  const f = await fixture(t);
  assert.equal(f.run('backup').status, 0);
  const baselineFile = path.join(f.work, 'baseline.json');
  const baseline = JSON.parse(fs.readFileSync(baselineFile)); baseline.sources.count++;
  fs.writeFileSync(baselineFile, JSON.stringify(baseline));
  assert.notEqual(f.run('rehearse').status, 0);
  const backup = JSON.parse(fs.readFileSync(path.join(f.work, 'backup.json')));
  fs.appendFileSync(backup.databaseBackupPath, 'tampered');
  assert.notEqual(f.run('restore').status, 0);
  const db = new DatabaseSync(f.filename);
  assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 59); db.close();
  assert.equal(fs.readFileSync(f.original, 'utf8'), 'original bytes');
});
