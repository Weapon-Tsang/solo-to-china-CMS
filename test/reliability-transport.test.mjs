import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { fetchBody } from '../extension/transport.js';
import { detectMediaMime, normalizeCaptureMedia } from '../extension/media-contract.js';
import { AsyncSemaphore } from '../extension/sync-core.js';
import { png } from '../test-support/media-fixtures.mjs';

test('media kind follows array membership and MIME follows bytes, never URL guesses', () => {
  const capture = { images: [{ kind: 'video' }], videos: [{}] };
  assert.deepEqual(normalizeCaptureMedia(capture).map(x => x.kind), ['image','video']);
  assert.equal(detectMediaMime(png, 'image', 'image/png'), 'image/png');
  assert.equal(detectMediaMime(png, 'video', 'video/mp4'), '');
  assert.equal(detectMediaMime(png, 'image', 'image/jpeg'), '');
  assert.equal(detectMediaMime(Buffer.from('<html>login required</html>'), 'image', 'text/html'), '');
});

test('network budget includes delayed headers, stalled body, JSON body and cancellation; slots recover', async t => {
  let closed = 0;
  const timers = new Set();
  const server = http.createServer((req, res) => {
    res.on('close', () => { closed++; });
    if (req.url === '/ok') return res.end('{"ok":true}');
    if (req.url === '/oversize') { res.setHeader('content-length', '9999'); res.flushHeaders(); return; }
    if (req.url === '/stream-limit') { res.write('123456789'); return; }
    if (req.url !== '/headers') { res.setHeader('content-type', 'application/json'); res.write('{'); }
    const timer = setTimeout(() => res.end('"done":true}'), 2000);
    timers.add(timer);
    res.on('close', () => { clearTimeout(timer); timers.delete(timer); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const timer of timers) clearTimeout(timer); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const pool = new AsyncSemaphore(1);
  for (const [route, budget, code] of [
    ['/headers', { timeoutMs: 200, idleTimeoutMs: 1000 }, 'REQUEST_TIMEOUT'],
    ['/body', { timeoutMs: 200, idleTimeoutMs: 1000 }, 'REQUEST_TIMEOUT'],
    ['/body', { timeoutMs: 1500, idleTimeoutMs: 150 }, 'RESPONSE_STALLED'],
    ['/oversize', { maxBytes: 8 }, 'RESPONSE_TOO_LARGE'],
    ['/stream-limit', { maxBytes: 8 }, 'RESPONSE_TOO_LARGE'],
  ]) {
    await assert.rejects(pool.run(() => fetchBody(base + route, {}, budget)), { code });
    assert.equal(pool.active, 0);
    assert.equal(JSON.parse(new TextDecoder().decode((await pool.run(() => fetchBody(base + '/ok'))).bytes)).ok, true);
  }
  const controller = new AbortController();
  const request = pool.run(() => fetchBody(base + '/body', { method: 'POST', body: 'upload', signal: controller.signal }));
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(request, { code: 'REQUEST_CANCELLED' });
  assert.equal(pool.active, 0);
  assert.ok(closed >= 5, 'abandoned responses must close before their delayed bodies finish');
});
