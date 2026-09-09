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

export function classifyRefreshOutcome(overviewResult, viewResult) {
  const overviewOk = overviewResult.status === "fulfilled";
  const viewOk = viewResult.status === "fulfilled" && viewResult.value?.ok === true;
  if (overviewOk && viewOk) return { state: "success", message: "已刷新全部状态" };
  const errors = [overviewOk ? null : overviewResult.reason, viewOk ? null : viewResult.value?.error || viewResult.reason]
    .filter(Boolean).map((error) => error?.message || String(error));
  if (overviewOk || viewOk) return { state: "partial", message: `部分刷新成功：${errors.join("；") || "另一个请求未完成"}` };
  return { state: "failed", message: errors.join("；") || "刷新失败" };
}
