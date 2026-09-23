import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { openDatabase, SCHEMA_VERSION } from '../src/db.mjs';
import { Repository } from '../src/repository.mjs';

test('migration 79 preserves configured credentials and routes while adding Gemini', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stc-migration-79-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = fs.readFileSync(new URL('../src/db.mjs', import.meta.url), 'utf8')
    .replace(/^  if \(current < 79\) migrationSeventyNine\(db\);$/m, '');
  const oldPath = path.join(directory, 'db-v78.mjs');
  fs.writeFileSync(oldPath, source);
  const { openDatabase: openV78 } = await import(pathToFileURL(oldPath).href);
  const filename = path.join(directory, 'migration.sqlite');
  let db = openV78(filename);
  db.prepare(`INSERT INTO model_credentials(provider,encrypted_secret,iv,auth_tag,key_version,masked_suffix,
    validation_status,validation_detail_json,created_at,updated_at) VALUES ('openai','encrypted','iv','tag',2,'1234',
    'text_verified','{}','now','now')`).run();
  db.prepare(`UPDATE model_routing_settings SET selected_provider='openai',active_provider='openai',
    active_model='gpt-5.6-luna',activation_state='active',revision=7 WHERE singleton=1`).run();
  db.close();
  db = openDatabase(filename);
  assert.equal(db.prepare('SELECT MAX(version) version FROM schema_migrations').get().version, SCHEMA_VERSION);
  assert.equal(db.prepare("SELECT masked_suffix FROM model_credentials WHERE provider='openai'").get().masked_suffix, '1234');
  assert.deepEqual({ ...db.prepare('SELECT active_provider,active_model,revision FROM model_routing_settings').get() },
    { active_provider: 'openai', active_model: 'gpt-5.6-luna', revision: 7 });
  assert.equal(new Repository(db).modelProfileForRole('extraction').model, 'gpt-5.6-luna');
  db.prepare(`INSERT INTO model_credentials(provider,encrypted_secret,iv,auth_tag,key_version,masked_suffix,
    validation_status,validation_detail_json,created_at,updated_at) VALUES ('gemini','encrypted','iv','tag',1,'5678',
    'untested','{}','now','now')`).run();
  db.prepare("UPDATE model_routing_settings SET selected_provider='gemini',active_provider='gemini',active_model='gemini-3.8-flash'").run();
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
});
