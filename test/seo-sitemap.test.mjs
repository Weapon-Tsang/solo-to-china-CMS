import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectSitemap, parseSitemap } from '../src/seo-sitemap.mjs';

test('T03-07 namespace XML parses escaped page URLs and ignores image loc and comments', () => {
  const xml = '<s:urlset xmlns:s="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"><s:url><s:loc>https://example.com/?p=1&amp;page=2</s:loc><image:image><image:loc>https://example.com/other</image:loc></image:image></s:url><!-- https://example.com/comment --></s:urlset>';
  assert.deepEqual(parseSitemap(xml).urls, ['https://example.com/?p=1&page=2']);
  assert.equal(inspectSitemap(xml, 'https://example.com/?p=1&page=2').status, 'present');
  assert.equal(inspectSitemap(xml, 'https://example.com/comment').status, 'absent');
});

test('T03-07 unresolved children, malformed XML, DTD and exhausted budgets remain unknown', () => {
  const xml = '<sitemapindex><sitemap><loc>https://example.com/child.xml</loc></sitemap></sitemapindex>';
  const target = 'https://example.com/guide';
  assert.equal(inspectSitemap(xml, target).status, 'unknown');
  const documents = { 'https://example.com/child.xml': `<urlset><url><loc>${target}</loc></url></urlset>` };
  assert.equal(inspectSitemap(xml, target, { documents }).status, 'present');
  assert.equal(inspectSitemap(xml, target, { documents, maxDocuments: 1 }).status, 'unknown');
  assert.equal(inspectSitemap(xml, target, { documents, maxDepth: 0 }).status, 'unknown');
  for (const invalid of ['<urlset><loc>x</urlset>', '<!DOCTYPE urlset><urlset/>', '<urlset/><urlset/>']) assert.equal(parseSitemap(invalid).status, 'unknown');
  assert.equal(parseSitemap('<urlset/>', { maxBytes: 2 }).status, 'unknown');
});
