import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { loadConfig } from '../src/config.mjs';
import { createApplication } from '../src/server.mjs';

test('T03-21/22 real local HTTP exposes saved GSC state without scheduling or requesting Google', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-seo-state-'));
  const databasePath = path.join(directory, 'test.sqlite');
  openDatabase(databasePath).close();
  const config = loadConfig({ HOST: '127.0.0.1', PORT: '0', DATABASE_PATH: databasePath, CMS_DATA_ROOT: directory,
    GENERATED_MEDIA_DIR: path.join(directory, 'media'), SOURCE_UPLOADS_DIR: path.join(directory, 'sources'),
    CAPTURE_MEDIA_UPLOADS_DIR: path.join(directory, 'uploads'), CMS_PROCESS_ROLE: 'api', MAINTENANCE_ENABLED: 'false',
    LOG_LEVEL: 'error', ADMIN_TOKEN: 'seo-local-test-token' });
  config.searchConsole = { ...config.searchConsole, siteUrl: 'sc-domain:example.invalid', clientEmail: 'fixture@example.invalid', privateKey: 'fixture-not-a-key' };
  const app = createApplication(config);
  t.after(async () => { await app.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  await app.start();
  const endpoint = `http://127.0.0.1:${app.server.address().port}/api/search-console`;
  const get = async () => {
    const response = await fetch(endpoint, { headers: { authorization: 'Bearer seo-local-test-token' } });
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await get()).observation.status, 'not_observed');
  app.repository.replaceSearchConsoleInventory(config.searchConsole.siteUrl, { startDate: '2026-09-01', endDate: '2026-09-20', rows: [] });
  assert.equal((await get()).observation.status, 'no_data');
  app.repository.replaceSearchConsoleInventory(config.searchConsole.siteUrl, { startDate: '2026-09-01', endDate: '2026-09-20', rows: [
    { query: 'local fixture', pageUrl: 'https://example.invalid/guide/', clicks: 1, impressions: 5, ctr: .2, position: 3 },
  ] });
  assert.equal((await get()).observation.status, 'available');
  app.repository.failSearchConsoleSync(config.searchConsole.siteUrl, new Error('Fixture expired credential'));
  const failed = await get();
  assert.equal(failed.observation.status, 'request_failed');
  assert.equal(failed.items.length, 1, 'saved data survives a failed sync');
  assert.equal(failed.observation.aiCitations.status, 'unknown');
  assert.equal(app.repository.db.prepare("SELECT count(*) n FROM jobs WHERE type='sync_search_console'").get().n, 0);
  assert.equal(app.repository.db.prepare('SELECT count(*) n FROM model_call_metrics').get().n, 0);
});
