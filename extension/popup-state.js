const IN_FLIGHT_STATES = new Set(["opening", "loading", "extracting", "submitting"]);

export function deriveSyncProgress(session = {}) {
  const stats = session.stats || {};
  const queue = Array.isArray(session.queue) ? session.queue : [];
  const completed = number(stats.captured) + number(stats.duplicate);
  const inFlight = queue.filter((task) => IN_FLIGHT_STATES.has(task.status)).length;
  const queued = queue.filter((task) => task.status === "queued").length;
  const retryWait = queue.filter((task) => task.status === "retry_wait").length;
  const failed = number(stats.failed);
  const accounted = completed + inFlight + queued + retryWait + failed;
  const declaredTotal = session.mode === "repair"
    ? number(stats.repair)
    : session.mode === "full" ? number(stats.new) + number(stats.repair) : number(stats.new);
  return { completed, inFlight, queued, retryWait, failed, total: Math.max(declaredTotal, accounted) };
}

export function progressCards(session = {}) {
  const stats = session.stats || {};
  const progress = deriveSyncProgress(session);
  if (session.mode === "repair") {
    return compact([
      ["修复进度", `${progress.completed} / ${progress.total}`],
      ["正在修复", progress.inFlight],
      ["等待修复", progress.queued],
      progress.retryWait ? ["等待重试", progress.retryWait] : null,
      ["失败", progress.failed],
    ]);
  }
  if (session.mode === "full") {
    return compact([
      ["需核验总数", progress.total],
      ["已核验", progress.completed],
      ["正在核验", progress.inFlight],
      ["等待核验", progress.queued],
      progress.retryWait ? ["等待重试", progress.retryWait] : null,
      ["失败", progress.failed],
    ]);
  }
  return compact([
    ["已发现", number(stats.discovered)],
    ["已存在", number(stats.known)],
    ["新增", number(stats.new)],
    ["已采集", number(stats.captured)],
    ["排队中", progress.queued + progress.retryWait],
    ["失败", progress.failed],
  ]);
}

export function acquisitionStatus(session = {}) {
  const progress = deriveSyncProgress(session);
  const concurrency = number(session.concurrency) || 1;
  const retry = progress.retryWait ? `，等待重试 ${progress.retryWait} 条` : "";
  if (session.mode === "repair") {
    return `正在修复缺失数据……进度 ${progress.completed} / ${progress.total}，正在处理 ${progress.inFlight} 条，等待 ${progress.queued} 条${retry}，当前并发 ${concurrency}。`;
  }
  if (session.mode === "full") {
    return `正在完整核验收藏……进度 ${progress.completed} / ${progress.total}，正在核验 ${progress.inFlight} 条，等待 ${progress.queued} 条${retry}，当前并发 ${concurrency}。`;
  }
  return `正在采集新增收藏……已采集 ${progress.completed} 条，正在处理 ${progress.inFlight} 条，排队 ${progress.queued} 条${retry}，当前并发 ${concurrency}。`;
}

export function completionStatus(session = {}) {
  const progress = deriveSyncProgress(session);
  if (session.mode === "repair") {
    return progress.failed
      ? `修复完成：已修复 ${progress.completed} / ${progress.total}，无法自动恢复 ${progress.failed}。`
      : `修复完成：已修复 ${progress.completed} / ${progress.total}，失败 0。`;
  }
  if (session.mode === "full") {
    return progress.failed
      ? `核验完成：已核验 ${progress.completed} / ${progress.total}，无法自动核验 ${progress.failed}。`
      : `核验完成：已核验 ${progress.completed} / ${progress.total}，失败 0。`;
  }
  return progress.failed
    ? `同步完成：已采集 ${progress.completed} 条，无法自动恢复 ${progress.failed}。`
    : `同步完成：已采集 ${progress.completed} 条，失败 0。`;
}

function compact(items) { return items.filter(Boolean); }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? parsed : 0; }
