export function createLatestRequestCoordinator() {
  let generation = 0;
  let controller = null;
  return {
    begin() {
      controller?.abort();
      controller = new AbortController();
      const activeController = controller;
      const token = ++generation;
      return { token, signal: activeController.signal, isCurrent: () => token === generation && !activeController.signal.aborted };
    },
    invalidate() {
      generation += 1;
      controller?.abort();
      controller = null;
    },
  };
}

export function createInFlightRequestCoordinator() {
  let active = null;
  return {
    run(key, task) {
      const normalizedKey = String(key);
      if (active?.key === normalizedKey) return active.promise;
      active?.controller.abort();
      const controller = new AbortController();
      let promise;
      try {
        promise = Promise.resolve(task({ signal: controller.signal }));
      } catch (error) {
        promise = Promise.reject(error);
      }
      active = { key: normalizedKey, controller, promise };
      const clear = () => {
        if (active?.promise === promise) active = null;
      };
      promise.then(clear, clear);
      return promise;
    },
    isPending(key) {
      return active?.key === String(key);
    },
    invalidate() {
      active?.controller.abort();
      active = null;
    },
  };
}

export function classifyRefreshOutcome(overviewResult, viewResult) {
  const overviewOk = overviewResult.status === "fulfilled";
  const viewOk = viewResult.status === "fulfilled" && viewResult.value?.ok === true;
  if (overviewOk && viewOk) return { state: "success", message: "已刷新全部状态" };
  const errors = [overviewOk ? null : overviewResult.reason, viewOk ? null : viewResult.value?.error || viewResult.reason]
    .filter(Boolean).map((error) => error?.message || String(error));
  if (overviewOk || viewOk) return { state: "partial", message: `部分刷新成功：${errors.join("；") || "另一个请求未完成"}` };
  return { state: "failed", message: errors.join("；") || "刷新失败" };
}
export function startStatusPolling({ document, active, refresh, onError = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer, stopped = false, refreshing = false;
  const schedule = () => {
    clearTimer(timer);
    if (!stopped) timer = setTimer(tick, document.hidden ? 120_000 : active ? 7_500 : 60_000);
  };
  const tick = async () => {
    clearTimer(timer);
    if (stopped || refreshing) return;
    refreshing = true;
    try { await refresh(); } catch (error) { onError(error); }
    finally { refreshing = false; schedule(); }
  };
  const visibilityChanged = () => { if (!document.hidden) void tick(); else schedule(); };
  document.addEventListener('visibilitychange', visibilityChanged);
  schedule();
  return () => { stopped = true; clearTimer(timer); document.removeEventListener('visibilitychange', visibilityChanged); };
}
