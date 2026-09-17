const failure = (code, message, retryable = false) => Object.assign(new Error(message), { code, retryable });

// Resolve only after the body has been consumed. The abort signal owns both
// network and body lifetime, including error responses and slot waits.
export async function fetchBody(url, options = {}, {
  timeoutMs = 45_000, idleTimeoutMs = 15_000, maxBytes = 4 * 1024 * 1024,
  fetchImpl = fetch,
} = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(failure("REQUEST_CANCELLED", "请求已取消。"));
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const totalTimer = setTimeout(() => controller.abort(failure("REQUEST_TIMEOUT", "请求超过总时限。", true)), timeoutMs);
  let idleTimer, reader;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(failure("RESPONSE_STALLED", "响应正文长时间没有进展。", true)), idleTimeoutMs);
  };
  try {
    controller.signal.throwIfAborted();
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > maxBytes) throw failure("RESPONSE_TOO_LARGE", "响应超过允许的字节上限。");
    reader = response.body?.getReader();
    const chunks = [];
    let size = 0;
    armIdle();
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        controller.signal.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw failure("RESPONSE_TOO_LARGE", "响应超过允许的字节上限。");
        chunks.push(value);
        armIdle();
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { ok: response.ok, status: response.status, headers: response.headers, bytes };
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(totalTimer);
    clearTimeout(idleTimer);
    options.signal?.removeEventListener("abort", abort);
    controller.abort();
    try { await reader?.cancel(); } catch { /* The network may already be aborted. */ }
    reader?.releaseLock();
  }
}
