// Per provider/model admission control. Requests wait for request-rate and
// token-rate capacity before dispatch instead of discovering the quota through
// billed or wasted 429 responses. A 429 observed anyway pauses only that lane.

const MINUTE_MS = 60_000;

export function createProviderRateLimiter({ spacingMs = 0, limits = {}, now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), maxPauseMs = 300_000 } = {}) {
  const spacing = Math.max(0, Number(spacingMs || 0));
  const lanes = new Map();
  let nextGlobalStartAt = 0;

  const limitFor = (provider, model) => limits[`${provider}:${model}`] || limits[provider] || limits.default || {};
  const lane = (provider, model) => {
    const key = `${provider || "unknown"}:${model || "unknown"}`;
    if (!lanes.has(key)) {
      const limit = limitFor(provider, model);
      lanes.set(key, { key, rpm: Math.max(0, Number(limit.rpm || 0)), tpm: Math.max(0, Number(limit.tpm || 0)),
        requests: [], tokens: [], pausedUntil: 0, tail: Promise.resolve() });
    }
    return lanes.get(key);
  };
  const prune = (state, at) => {
    while (state.requests.length && state.requests[0] <= at - MINUTE_MS) state.requests.shift();
    while (state.tokens.length && state.tokens[0].at <= at - MINUTE_MS) state.tokens.shift();
  };
  const waitFor = (state, estimatedTokens, at) => {
    prune(state, at);
    let wait = Math.max(0, state.pausedUntil - at);
    if (state.rpm && state.requests.length >= state.rpm) wait = Math.max(wait, state.requests[0] + MINUTE_MS - at);
    if (state.tpm) {
      // A single request larger than the whole budget is admitted alone once the
      // window is empty; it can never fit otherwise.
      const needed = Math.min(state.tpm, estimatedTokens);
      let used = state.tokens.reduce((sum, item) => sum + item.tokens, 0);
      for (const item of state.tokens) {
        if (used + needed <= state.tpm) break;
        used -= item.tokens;
        wait = Math.max(wait, item.at + MINUTE_MS - at);
      }
    }
    return wait;
  };

  async function acquire({ provider, model, estimatedTokens = 0 } = {}) {
    const state = lane(provider, model);
    const tokens = Math.max(0, Math.ceil(Number(estimatedTokens || 0)));
    // Serialize admissions per lane so concurrent callers cannot all observe the
    // same free capacity.
    const previous = state.tail;
    let release;
    state.tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      let waitedMs = 0;
      for (;;) {
        const wait = waitFor(state, tokens, now());
        if (wait <= 0) break;
        waitedMs += wait;
        await sleep(wait);
      }
      const scheduledAt = Math.max(now(), nextGlobalStartAt);
      nextGlobalStartAt = scheduledAt + spacing;
      if (scheduledAt > now()) {
        waitedMs += scheduledAt - now();
        await sleep(scheduledAt - now());
      }
      const at = now();
      state.requests.push(at);
      if (tokens) state.tokens.push({ at, tokens });
      return { lane: state.key, waitedMs };
    } finally {
      release();
    }
  }

  function penalize({ provider, model, retryAfterMs = null } = {}) {
    const state = lane(provider, model);
    const pause = Math.min(maxPauseMs, Math.max(1_000, Number(retryAfterMs) || 10_000));
    state.pausedUntil = Math.max(state.pausedUntil, now() + pause);
    return state.pausedUntil;
  }

  function snapshot() {
    const at = now();
    return [...lanes.values()].map((state) => {
      prune(state, at);
      return { lane: state.key, rpm: state.rpm, tpm: state.tpm, requestsLastMinute: state.requests.length,
        tokensLastMinute: state.tokens.reduce((sum, item) => sum + item.tokens, 0),
        pausedForMs: Math.max(0, state.pausedUntil - at) };
    });
  }

  // Compatible with the clients' existing `beforeRequest` hook.
  const beforeRequest = (request = {}) => acquire(request);
  return { acquire, penalize, snapshot, beforeRequest };
}

export function isRateLimitMetric(metric = {}) {
  return String(metric.errorCode) === "429" || Number(metric.httpStatus) === 429
    || /RESOURCE_EXHAUSTED|RATE_LIMIT/i.test(String(metric.errorCode || metric.providerCode || ""));
}

const MEDIA_PART_TOKENS = 1_500;

// Text is estimated from UTF-8 size; each media part is a fixed allowance,
// since providers bill images by tile, not by base64 payload length.
export function estimateRequestTokens(...values) {
  let bytes = 0;
  let media = 0;
  const visit = (value) => {
    if (value == null) return;
    if (typeof value === "string") { bytes += Buffer.byteLength(value); return; }
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (typeof value !== "object") return;
    if (value.inlineData || value.inline_data || value.fileData || value.file_data
      || value.image_url || value.type === "image_url" || value.type === "input_image") { media += 1; return; }
    Object.values(value).forEach(visit);
  };
  values.forEach(visit);
  return Math.ceil(bytes / 3.5) + media * MEDIA_PART_TOKENS;
}
