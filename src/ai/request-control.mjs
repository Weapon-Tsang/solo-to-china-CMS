// Cancellation and durable dispatch accounting belong to each HTTP attempt,
// including schema fallbacks. Cache reuse must never acquire a paid permit.
export function abortable(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

export async function beginProviderAttempt({ signal, onProviderDispatch, response, emit }) {
  signal?.throwIfAborted();
  // Keep local quota/budget errors outside transport catch blocks: nothing was
  // dispatched, so they must not become billable failures or provider pressure.
  const permit = await onProviderDispatch?.();
  if (signal?.aborted) {
    permit?.finish?.({error:{code:'CANCELLED_BEFORE_DISPATCH'},responseReceived:false,outcomeKnown:true});
    signal.throwIfAborted();
  }
  let finished = false;
  return metric => {
    if (!finished) {
      finished = true;
      const received = response();
      const failed = (metric.attemptStatus || metric.status) !== 'succeeded';
      permit?.finish?.({
        error: failed ? { code: metric.errorCode, status: received?.ok === false ? received.status : null,
          retryAfter: received?.headers?.get('retry-after') } : null,
        responseReceived: Boolean(received),
      });
    }
    emit(metric);
  };
}
