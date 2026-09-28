import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectIndexDirectives, inspectRobotsTxt, normalizeObservedUrl } from '../src/seo-observation.mjs';

test('T03-04 robots groups distinguish agents and combine equally specific groups', () => {
  const text = 'User-agent: *\nDisallow: /\nUser-agent: GPTBot\nDisallow: /\nUser-agent: Googlebot\nDisallow: /private\nUser-agent: Googlebot\nAllow: /private/open';
  assert.equal(inspectRobotsTxt(text, { path: '/guide' }).allowed, true);
  assert.equal(inspectRobotsTxt(text, { agent: 'GPTBot', path: '/guide' }).allowed, false);
  assert.equal(inspectRobotsTxt(text, { path: '/private' }).allowed, false);
  assert.equal(inspectRobotsTxt(text, { path: '/private/open' }).allowed, true);
  assert.equal(inspectRobotsTxt(text + '\nUser-agent: Googlebot-Image\nDisallow: /images', { agent: 'Googlebot-Image', path: '/private' }).allowed, true);
});

test('T03-05 longest path, allow ties, wildcards, terminal anchors, comments and encoded paths', () => {
  const text = '\uFEFFUser-agent: *\rDisallow:\rDisallow: /*.pdf$\rAllow: /open.pdf$\rDisallow: /same\rAllow: /same # tie\rDisallow: /景点\rDisallow: /a%62c\rDisallow: /a%2fb';
  for (const [path, allowed] of [['/file.pdf', false], ['/file.pdf?q=1', true], ['/open.pdf', true], ['/same', true], ['/anything', true], ['/%E6%99%AF%E7%82%B9', false], ['/abc', false], ['/a%2Fb', false], ['/a/b', true]]) {
    assert.equal(inspectRobotsTxt(text, { path }).allowed, allowed, path);
  }
  assert.equal(inspectRobotsTxt('User-agent: *\nDisallow: /a*b*c$', { path: '/aZZbZZc' }).allowed, false);
  assert.equal(inspectRobotsTxt('User-agent: *\nDisallow: /a*b*c$', { path: '/aZZbZZcx' }).allowed, true);
  assert.equal(inspectRobotsTxt('', { httpStatus: 403 }).status, 'unknown');
  assert.equal(inspectRobotsTxt(null).allowed, null);
});

test('T03-05 all applicable meta and header directives apply, other agents remain separate', () => {
  const result = inspectIndexDirectives({ meta: [{ name: 'robots', content: 'index' }, { name: 'ROBOTS', content: 'NOINDEX' }] });
  assert.equal(result.indexable, false);
  assert.deepEqual(result.conflicts, [['index', 'noindex']]);
  assert.equal(inspectIndexDirectives({ headers: { 'X-Robots-Tag': ['otherbot: noindex', 'Googlebot: nofollow, noindex'] } }).indexable, false);
  assert.equal(inspectIndexDirectives({ headers: { 'X-Robots-Tag': 'otherbot: noindex, nofollow' } }).indexable, true);
  assert.equal(inspectIndexDirectives({ headers: { 'x-robots-tag': 'none' } }).indexable, false);
});

test('T03-08 preserve confirmed permalink routing, pagination and slash distinctions', () => {
  assert.equal(normalizeObservedUrl('https://example.com/?p=17&page=2&utm_source=x#section'), 'https://example.com/?p=17&page=2');
  assert.equal(normalizeObservedUrl('https://example.com/guide'), 'https://example.com/guide');
  assert.notEqual(normalizeObservedUrl('https://example.com/?p=17'), normalizeObservedUrl('https://example.com/?p=18'));
});
