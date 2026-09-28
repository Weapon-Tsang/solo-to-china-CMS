import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createSeoPublicReader } from '../src/seo-public-reader.mjs';

function fixture({ status = 200, headers = {}, body = '<html>public</html>', visits = [] } = {}) {
  return (url, options, receive) => {
    visits.push(url.href);
    assert.equal(options.headers.cookie, undefined);
    assert.equal(options.headers.authorization, undefined);
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.end = () => queueMicrotask(() => {
      const response = Readable.from([Buffer.from(body)]);
      response.statusCode = status; response.headers = headers; receive(response);
    });
    return request;
  };
}
const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
const allowedOrigins = ['https://example.com'];

test('T03-16 allowlist validates every redirect before connection; DNS/private addresses remain blocked', async () => {
  const visits = [];
  const reader = createSeoPublicReader({ allowedOrigins, lookup, requestImpl: fixture({ visits, status: 302, headers: { location: 'https://outside.example/path' } }) });
  assert.equal((await reader.read('https://example.com')).reason, 'SEO_TARGET_FORBIDDEN');
  assert.equal(visits.length, 1);
  assert.equal((await reader.read('https://outside.example')).status, 'unknown');
  assert.equal(visits.length, 1);
  const privateReader = createSeoPublicReader({ allowedOrigins, lookup: async () => [{ address: '127.0.0.1', family: 4 }], requestImpl: fixture({ visits }) });
  assert.equal((await privateReader.read('https://example.com')).reason, 'REMOTE_MEDIA_ADDRESS_FORBIDDEN');
  assert.equal(visits.length, 1);
});

test('T03-16 page-hash cache, manual invalidation and bounded responses', async () => {
  const visits = [];
  const reader = createSeoPublicReader({ allowedOrigins, lookup, requestImpl: fixture({ visits }) });
  assert.equal((await reader.read('https://example.com', { pageHash: 'a' })).status, 'observed');
  assert.equal((await reader.read('https://example.com', { pageHash: 'a' })).cached, true);
  await reader.read('https://example.com', { pageHash: 'b' });
  await reader.read('https://example.com', { pageHash: 'b', refresh: true });
  assert.equal(visits.length, 3);
  const large = createSeoPublicReader({ allowedOrigins, lookup, maxBytes: 10, requestImpl: fixture() });
  assert.equal((await large.read('https://example.com')).reason, 'response_size_budget');
});

test('T03-17 403 and authentication are unknown; concurrency and DNS time are bounded', async () => {
  for (const options of [{ status: 403 }, { body: '<form action="wp-login.php">Login</form>' }]) {
    const reader = createSeoPublicReader({ allowedOrigins, lookup, requestImpl: fixture(options) });
    assert.equal((await reader.read('https://example.com')).status, 'unknown');
  }
  const keepAlive = setInterval(() => {}, 20);
  try {
    const reader = createSeoPublicReader({ allowedOrigins, concurrency: 1, timeoutMs: 30, lookup: () => new Promise(() => {}), requestImpl: fixture() });
    const first = reader.read('https://example.com/one');
    assert.equal((await reader.read('https://example.com/two')).reason, 'concurrency_budget');
    assert.equal((await first).status, 'unknown');
  } finally { clearInterval(keepAlive); }
});
