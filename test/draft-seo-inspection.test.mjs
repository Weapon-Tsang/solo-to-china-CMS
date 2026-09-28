import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { Repository } from '../src/repository.mjs';
import { loadConfig } from '../src/config.mjs';
import { createApplication } from '../src/server.mjs';
import { seedCoverFixture } from '../test-support/cover-fixture.mjs';
import { createDraftSeoInspection } from '../src/services/draft-seo-inspection.mjs';
import { createSeoInspection } from '../src/services/seo-inspection.mjs';
import { createBackup, restoreBackup } from '../src/backup.mjs';
import { DatabaseSync } from 'node:sqlite';

export function fixtureInspector(visits = []) {
  return createSeoInspection({ reader: { async read(url) {
    visits.push(url);
    const body = url.endsWith('/robots.txt') ? 'User-agent: *\nAllow: /'
      : url.endsWith('/sitemap_index.xml') ? '<urlset><url><loc>https://example.invalid/guide/</loc></url></urlset>'
      : '<html><head><title>Cover selection fixture</title><meta name="description" content="Test guide"><link rel="canonical" href="https://example.invalid/guide/"></head><body><article><h1>Cover selection fixture</h1><p>This original body must not change.</p></article></body></html>';
    return { status: 'observed', url, body, httpStatus: 200, checkedAt: new Date().toISOString(), headers: {} };
  } } });
}
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-phase03-seo-'));
  const filename = path.join(directory, 'test.sqlite'), db = openDatabase(filename);
  t.after(() => { if (db.isOpen) db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const repository = new Repository(db);
  await seedCoverFixture(repository, path.join(directory, 'media'));
  db.prepare("UPDATE article_drafts SET status='published',meta_description='Test guide' WHERE id='cover-draft'").run();
  repository.prepareWordPressPublication('cover-draft', 'https://example.invalid');
  db.prepare("UPDATE wordpress_publications SET post_url='https://example.invalid/guide/',status='synced' WHERE draft_id='cover-draft'").run();
  return { directory, filename, db, repository };
}
const requestFor = service => {
  const saved = service.read('cover-draft');
  return { expected_revision: saved.page_revision, input_fingerprint: saved.input_fingerprint };
};

test('T03-01/16 observations persist, menu reads never fetch, TTL/manual refresh and revisions are distinct', async t => {
  const { db, directory, filename } = await fixture(t), visits = []; let time = Date.now();
  const options = { siteUrl: 'https://example.invalid', inspector: fixtureInspector(visits), now: () => time };
  const service = createDraftSeoInspection(db, options);
  const protectedBefore = db.prepare("SELECT * FROM article_drafts WHERE id='cover-draft'").get();
  for (let i = 0; i < 30; i++) assert.equal(service.read('cover-draft').state, 'not_observed');
  assert.equal(visits.length, 0);
  let observed = await service.inspect('cover-draft', requestFor(service));
  assert.equal(observed.observation.result.health.content.status, 'passed');
  assert.equal(visits.length, 3);
  await service.inspect('cover-draft', requestFor(service)); assert.equal(visits.length, 3);
  const restarted = createDraftSeoInspection(db, options);
  assert.deepEqual(restarted.read('cover-draft').observation, observed.observation);
  const backup=createBackup({databasePath:filename,backupDir:path.join(directory,'backups'),generatedMediaDir:path.join(directory,'media'),sourceUploadsDir:path.join(directory,'sources')});
  const restored=restoreBackup(backup.backupPath,path.join(directory,'restored'));
  assert.equal(restored.mode,'migration-review');
  const copy=new DatabaseSync(restored.databasePath,{readOnly:true});
  try{assert.deepEqual(createDraftSeoInspection(copy,options).read('cover-draft').observation,observed.observation);}
  finally{copy.close();}
  assert.equal(visits.length,3,'snapshot and review-mode reads perform no external inspection');
  await restarted.inspect('cover-draft', { ...requestFor(restarted), refresh: true }); assert.equal(visits.length, 6);
  time += 300_001; assert.equal(restarted.read('cover-draft').state, 'stale');
  assert.deepEqual(db.prepare("SELECT * FROM article_drafts WHERE id='cover-draft'").get(), protectedBefore);
  const stale = requestFor(service);
  db.prepare("UPDATE article_drafts SET revision=revision+1 WHERE id='cover-draft'").run();
  await assert.rejects(service.inspect('cover-draft', stale), { code: 'SEO_REVISION_CONFLICT' });
  assert.equal(visits.length, 6);
});

test('T03-16 concurrent clicks coalesce; late results never overwrite a newer revision', async t => {
  const { db } = await fixture(t); let release, calls = 0;
  const service = createDraftSeoInspection(db, { siteUrl: 'https://example.invalid', inspector: { inspect: async () => {
    calls++; await new Promise(resolve => { release = resolve; }); return { status: 'pending' };
  } } });
  const input = requestFor(service), a = service.inspect('cover-draft', input), b = service.inspect('cover-draft', input);
  assert.equal(calls, 1); assert.equal(service.read('cover-draft').state, 'checking');
  db.prepare("UPDATE article_drafts SET revision=revision+1 WHERE id='cover-draft'").run(); release();
  for (const result of await Promise.allSettled([a, b])) { assert.equal(result.status, 'rejected'); assert.equal(result.reason.code, 'SEO_REVISION_CONFLICT'); }
  assert.equal(service.read('cover-draft').observation, null);
});

test('T03-02/17 private/preview/off-site permalinks cannot be requested or overridden', async t => {
  const { db } = await fixture(t), visits = [];
  const service = createDraftSeoInspection(db, { siteUrl: 'https://example.invalid', inspector: fixtureInspector(visits) });
  for (const url of ['https://elsewhere.invalid/guide/', 'http://127.0.0.1/a', 'https://example.invalid/?preview=true']) {
    db.prepare("UPDATE wordpress_publications SET post_url=? WHERE draft_id='cover-draft'").run(url);
    await assert.rejects(service.inspect('cover-draft', { ...requestFor(service), url: 'https://example.invalid/guide/' }), { code: 'CONFIRMED_PUBLIC_URL_REQUIRED' });
  }
  db.prepare("UPDATE article_drafts SET status='review' WHERE id='cover-draft'").run();
  await assert.rejects(service.inspect('cover-draft', requestFor(service)), { code: 'PUBLICATION_NOT_PUBLIC' });
  assert.equal(visits.length, 0);
});

test('T03-16 actual local API authenticates and persists inspections without queue/model/content changes', async t => {
  const { directory, filename, db } = await fixture(t); db.close();
  const visits = [];
  const app = createApplication(loadConfig({ HOST: '127.0.0.1', PORT: '0', DATABASE_PATH: filename, CMS_DATA_ROOT: directory,
    GENERATED_MEDIA_DIR: path.join(directory, 'media'), SOURCE_UPLOADS_DIR: path.join(directory, 'sources'),
    CAPTURE_MEDIA_UPLOADS_DIR: path.join(directory, 'uploads'), CMS_PROCESS_ROLE: 'api', MAINTENANCE_ENABLED: 'false',
    LOG_LEVEL: 'error', ADMIN_TOKEN: 'fixture-only', PUBLIC_CONTENT_SITE_URL: 'https://example.invalid' }), { seoInspector: fixtureInspector(visits) });
  // Registered after fixture cleanup; node:test hooks execute in registration order.
  await app.start();
  try {
    const url = `http://127.0.0.1:${app.server.address().port}/api/drafts/cover-draft/seo-inspection`;
    assert.equal((await fetch(url)).status, 401);
    const headers = { authorization: 'Bearer fixture-only', 'content-type': 'application/json' };
    const snapshot = await (await fetch(url, { headers })).json(); assert.equal(visits.length, 0);
    assert.equal((await fetch(url,{headers:{...headers,origin:'https://elsewhere.invalid'},method:'POST',body:'{}'})).status,403);
    const jobs = app.repository.db.prepare('SELECT count(*) n FROM jobs').get().n;
    const response = await fetch(url, { headers, method: 'POST', body: JSON.stringify({ expected_revision: snapshot.page_revision, input_fingerprint: snapshot.input_fingerprint }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).observation.page_revision, 2);
    assert.equal(app.repository.db.prepare('SELECT count(*) n FROM jobs').get().n, jobs);
    assert.equal(app.repository.db.prepare('SELECT count(*) n FROM model_call_metrics').get().n, 0);
    assert.equal(visits.length, 3);
  } finally { await app.stop(); }
});
