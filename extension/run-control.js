// Browser calls cannot be withdrawn once dispatched. Callers fence both sides
// of each await and dispose only positively owned late-created tabs.
export const DEADLINES = Object.freeze({ injection: 30_000, scan: 30_000, extraction: 150_000, task: 30 * 60_000 });
export function stoppedError() {
  return Object.assign(new Error('采集运行许可已失效。'), { code: 'RUN_REVOKED', retryable: false });
}
export function sameRun(current, expected) {
  return Boolean(current && expected && current.sessionId === expected.sessionId
    && current.runRevision === expected.runRevision && current.status === 'running');
}
export function bounded(operation, { signal, timeoutMs, code = 'STAGE_TIMEOUT' }) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let finished = false;
    const done = (fn, value) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value);
    };
    const abort = () => done(reject, signal.reason || stoppedError());
    const timer = setTimeout(() => done(reject, Object.assign(new Error(`${code}: 阶段等待超过时限。`), { code, retryable: false })), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal?.throwIfAborted(); return operation(); }).then(value => done(resolve, value), error => done(reject, error));
  });
}
export function tabMatches(tab, record) {
  if (!tab || !record || tab.id !== record.tabId || tab.windowId !== record.windowId) return false;
  try {
    const actual = new URL(tab.pendingUrl || tab.url);
    const expected = new URL(record.url);
    // Collection links redirect to the canonical detail route for the same
    // note. Keep the tab/window and origin fences; only worker note routes
    // can be equivalent. Discovery scopes must still match their exact path.
    if (record.role === 'worker' && actual.origin === expected.origin
      && actual.protocol === 'https:' && /^(?:www\.)?xiaohongshu\.com$/.test(actual.hostname)) {
      const noteId = path => path.match(/^\/(?:explore|discovery\/item)\/([A-Za-z0-9]+)\/?$/)?.[1]
        || path.match(/^\/board\/[A-Za-z0-9]+\/([A-Za-z0-9]+)\/?$/)?.[1];
      const expectedId = noteId(expected.pathname);
      if (expectedId && expectedId === noteId(actual.pathname)) return true;
    }
    return actual.origin === expected.origin && actual.pathname === expected.pathname
      && actual.searchParams.get('tab') === expected.searchParams.get('tab');
  } catch { return false; }
}
