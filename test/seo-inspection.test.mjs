import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createSeoInspection } from '../src/services/seo-inspection.mjs';

const url = 'https://solotochina.com/chongqing-night-transport/';
const root = 'https://solotochina.com/sitemap.xml';
const child = 'https://solotochina.com/posts.xml';
const html = fs.readFileSync('test/fixtures/published-article.html', 'utf8');
function fixture(overrides = {}) {
  const visits = [];
  const pages = { [url]: html, 'https://solotochina.com/robots.txt': 'User-agent: *\nAllow: /',
    [root]: `<sitemapindex><sitemap><loc>${child}</loc></sitemap></sitemapindex>`,
    [child]: `<urlset><url><loc>${url}</loc></url></urlset>`, ...overrides };
  return { visits, reader: { async read(target, options) {
    visits.push({ target, options });
    return pages[target] == null ? { status: 'unknown', httpStatus: 403 } : { status: 'observed', httpStatus: 200,
      body: pages[target], url: target, headers: {}, checkedAt: '2026-09-28T00:00:00Z' };
  } } };
}
test('T03-07/16 explicit inspection traverses child sitemaps and propagates revision and refresh', async () => {
  const { reader, visits } = fixture();
  const service = createSeoInspection({ reader });
  assert.equal(visits.length, 0);
  const result = await service.inspect({ url, sitemapUrl: root, status: 'publish', pageRevision: 9, refresh: true });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.health.sitemap.status, 'passed');
  assert.equal(result.health.content.pageRevision, 9);
  assert.equal(result.pageHash.length, 64);
  assert.equal(visits.length, 4);
  assert.ok(visits.every(item => item.options.refresh && item.options.pageHash === '9'));
});
test('T03-07 budgets and inaccessible children preserve unknown rather than declaring absence', async () => {
  for (const opts of [{ maxDocuments: 1 }, { maxTotalBytes: 10 }]) {
    const { reader } = fixture();
    const result = await createSeoInspection({ reader, ...opts }).inspect({ url, sitemapUrl: root, status: 'publish' });
    assert.equal(result.health.sitemap.status, 'unknown');
    assert.equal(result.valid, null);
    assert.equal(result.retry.automatic, false);
  }
  const { reader } = fixture({ [child]: null });
  assert.equal((await createSeoInspection({ reader }).inspect({ url, sitemapUrl: root, status: 'publish' })).health.sitemap.status, 'unknown');
});
test('T03-17 inaccessible page stops inspection without pretending content is missing', async () => {
  const { reader, visits } = fixture({ [url]: null });
  const result = await createSeoInspection({ reader }).inspect({ url, sitemapUrl: root, status: 'publish' });
  assert.equal(result.health.content.status, 'unknown');
  assert.equal(result.valid, null);
  assert.equal(visits.length, 1);
});

test('T03-08 allowed redirect checks canonical and sitemap against the final anonymous URL',async()=>{
  const f=fixture(),original=f.reader.read;
  f.reader.read=async(target,options)=>target==='https://solotochina.com/old-route/'?original(url,options):original(target,options);
  const result=await createSeoInspection({reader:f.reader}).inspect({url:'https://solotochina.com/old-route/',sitemapUrl:root,status:'publish'});
  assert.equal(result.finalUrl,url);assert.equal(result.valid,true,JSON.stringify(result.errors));
  assert.equal(result.health.canonical.status,'passed');assert.equal(result.health.sitemap.status,'passed');
});
