import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { loadConfig } from '../src/config.mjs';
import { createApplication } from '../src/server.mjs';
import { createSeoInspection } from '../src/services/seo-inspection.mjs';
import { seedCoverFixture } from '../test-support/cover-fixture.mjs';
import { publishedRouteFixture } from '../test-support/route-decision-fixture.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-phase03-browser-'));
const databasePath = path.join(directory, 'test.sqlite'); openDatabase(databasePath).close();
const visits = [];
const seoInspector = createSeoInspection({ reader: { async read(url) {
  visits.push({ url, at: new Date().toISOString() });
  fs.writeFileSync(path.join(directory, 'requests.json'), JSON.stringify(visits, null, 2));
  const body = url.endsWith('/robots.txt') ? 'User-agent: *\nAllow: /'
    : url.endsWith('/sitemap_index.xml') ? '<urlset><url><loc>https://example.invalid/guide/</loc></url></urlset>'
    : '<html><head><title>Cover selection fixture</title><meta name="description" content="Test guide"><link rel="canonical" href="https://example.invalid/guide/"></head><body><article><h1>Cover selection fixture</h1><p>This original body must not change.</p></article></body></html>';
  return { status: 'observed', url, body, httpStatus: 200, headers: {}, checkedAt: new Date().toISOString() };
} } });
const app = createApplication(loadConfig({ HOST: '127.0.0.1', PORT: '0', DATABASE_PATH: databasePath, CMS_DATA_ROOT: directory,
  GENERATED_MEDIA_DIR: path.join(directory, 'media'), SOURCE_UPLOADS_DIR: path.join(directory, 'sources'),
  CAPTURE_UPLOADS_DIR: path.join(directory, 'capture'), CAPTURE_MEDIA_UPLOADS_DIR: path.join(directory, 'uploads'),
  CMS_PROCESS_ROLE: 'api', MAINTENANCE_ENABLED: 'false', LOG_LEVEL: 'error',
  ADMIN_TOKEN: 'stage03-local-only', ADMIN_USERNAME: 'stage03', ADMIN_PASSWORD: 'stage03-fixture-only',
  SESSION_SECRET: 'stage03-isolated-local-session', PUBLIC_CONTENT_SITE_URL: 'https://example.invalid' }), { seoInspector });
await seedCoverFixture(app.repository, path.join(directory, 'media'));
fs.mkdirSync('output/playwright',{recursive:true});
fs.copyFileSync(path.join(directory,'media','cover-test-master.png'),'output/playwright/phase03-synthetic.png');
// Both fixture families refer to the same synthetic East Hall entity.
app.repository.db.prepare("UPDATE entity_aliases SET entity_key='east' WHERE id='cover-hall'").run();
const route = publishedRouteFixture(app.repository);
app.repository.db.prepare("UPDATE article_drafts SET status='published',meta_description='Test guide' WHERE id='cover-draft'").run();
app.repository.prepareWordPressPublication('cover-draft', 'https://example.invalid');
app.repository.db.prepare("UPDATE wordpress_publications SET post_url='https://example.invalid/guide/',status='synced' WHERE draft_id='cover-draft'").run();
await app.start();
const stopFile = path.join(directory, 'STOP'); let stopped = false;
async function stop() { if (stopped) return; stopped = true; clearInterval(poll); clearTimeout(deadline); await app.stop(); }
const poll = setInterval(() => { if (fs.existsSync(stopFile)) void stop(); }, 500);
const deadline = setTimeout(() => void stop(), 30 * 60_000);
process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
console.log(JSON.stringify({ directory, stopFile, routeDraftId:route.draft, url: `http://127.0.0.1:${app.server.address().port}`, pid: process.pid }));
