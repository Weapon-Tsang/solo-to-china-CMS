import { openMediaResponse } from './safe-media-http.mjs';

// Explicitly invoked, anonymous HTTPS reads only. This is not a menu loader or crawler.
export function createSeoPublicReader({ allowedOrigins = [], maxBytes = 2_000_000, timeoutMs = 10_000,
  maxRedirects = 3, concurrency = 2, maxCacheEntries = 16, ttlMs = 300_000, lookup, requestImpl } = {}) {
  for (const value of [maxBytes, timeoutMs, concurrency, maxCacheEntries, ttlMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Reader budgets must be positive integers.');
  }
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) throw new TypeError('Invalid redirect budget.');
  const allowed = new Set(allowedOrigins.map(value => new URL(value).origin));
  const cache = new Map(), pending = new Map();
  let active = 0;
  const validateTarget = url => {
    if (!allowed.has(url.origin) || url.protocol !== 'https:' || url.username || url.password) {
      throw Object.assign(new Error('Public observation target is not allowlisted.'), { code: 'SEO_TARGET_FORBIDDEN' });
    }
  };
  async function read(value, { pageHash = '', refresh = false } = {}) {
    let url;
    try { url = new URL(value); validateTarget(url); } catch { return { status: 'unknown', reason: 'SEO_TARGET_FORBIDDEN' }; }
    url.hash = '';
    const key = JSON.stringify([url.href, pageHash]);
    if (refresh) cache.delete(key);
    const saved = cache.get(key);
    if (saved && Date.now() - saved.time < ttlMs) return { ...structuredClone(saved.result), cached: true };
    if (pending.has(key)) return structuredClone(await pending.get(key));
    if (active >= concurrency) return { status: 'unknown', reason: 'concurrency_budget', cached: false };
    active++;
    const task = (async () => {
      const signal = AbortSignal.timeout(timeoutMs);
      let response;
      try {
        response = await openMediaResponse(url, { signal, lookup, requestImpl, maxRedirects, idleTimeoutMs: timeoutMs, validateTarget });
        if (!response.ok) return { status: 'unknown', reason: 'http_access', httpStatus: response.status };
        const declared = Number(response.headers.get('content-length') || 0);
        if (declared > maxBytes) return { status: 'unknown', reason: 'response_size_budget' };
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          signal.throwIfAborted();
          const buffer = Buffer.from(chunk);
          size += buffer.length;
          if (size > maxBytes) return { status: 'unknown', reason: 'response_size_budget' };
          chunks.push(buffer);
        }
        const body = Buffer.concat(chunks).toString('utf8');
        if (/wp-login\.php|name=["']user_login["']/i.test(body)) return { status: 'unknown', reason: 'authentication_required', httpStatus: response.status };
        return { status: 'observed', httpStatus: response.status, url: response.url, body, bytes: size,
          headers: Object.fromEntries(['content-type', 'x-robots-tag', 'cache-control'].map(key => [key, response.headers.get(key)])),
          checkedAt: new Date().toISOString(), source: 'anonymous_https', pageHash };
      } catch (error) { return { status: 'unknown', reason: error.code || error.name || 'request_failed' }; }
      finally { response?.cancel(); active--; }
    })();
    pending.set(key, task);
    try {
      const result = await task;
      while (cache.size >= maxCacheEntries) cache.delete(cache.keys().next().value);
      cache.set(key, { time: Date.now(), result });
      return { ...structuredClone(result), cached: false };
    } finally { pending.delete(key); }
  }
  return { read, clear: () => cache.clear() };
}
