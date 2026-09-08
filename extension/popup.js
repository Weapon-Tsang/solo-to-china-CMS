const $ = (selector) => document.querySelector(selector);
const elements = {
  sync: $("#sync"), full: $("#full-sync"), save: $("#save"), pause: $("#pause"), resume: $("#resume"), cancel: $("#cancel"), stopQueue: $("#stop-queue"),
  endpoint: $("#endpoint"), token: $("#token"), saveSettings: $("#save-settings"), autoSync: $("#auto-sync"), concurrencyMode: $("#concurrency-mode"), customConcurrency: $("#custom-concurrency"), customConcurrencyField: $("#custom-concurrency-field"),
  identityBatchSize: $("#identity-batch-size"), discoveryBatchSize: $("#discovery-batch-size"), knownStreak: $("#known-streak"), queueHighWatermark: $("#queue-high-watermark"), maxRetries: $("#max-retries"), detailTimeout: $("#detail-timeout"),
  autoMinHours: $("#auto-min-hours"),
  scope: $("#scope"), lastSync: $("#last-sync"), status: $("#status"), counts: $("#counts"), actions: $("#actions"), settingsPanel: $("#connection-settings"),
};
const CLOUD_CONFIGURED = false;
const ERROR_MESSAGES = Object.freeze({
  INVALID_FAVORITES_SCOPE: "尚未识别到小红书收藏夹，请打开目标收藏夹页面后重试。",
  SESSION_ALREADY_RUNNING: "已有一个收藏同步任务正在运行，请先完成、暂停或取消当前任务。",
  NO_ACTIVE_SESSION: "当前没有正在运行的同步任务。",
  NO_RESUMABLE_SESSION: "当前没有可以继续的同步任务。",
  NO_AUTO_SCOPE: "请先打开收藏夹并手动同步一次，以便记录自动同步范围。",
  NOT_LOGGED_IN: "小红书登录状态已失效，请手动登录后继续同步。",
  VERIFICATION_REQUIRED: "小红书要求安全验证，请手动完成验证后继续同步。",
  NOTE_UNAVAILABLE: "该笔记已删除、不可见或当前账号无权访问。",
  TAB_LOAD_TIMEOUT: "笔记页面加载超时，系统会按重试策略再次尝试。",
  SELECTOR_MISMATCH: "页面结构暂时无法识别，请刷新页面；如仍失败可使用“保存当前笔记”。",
  CONTENT_NOT_READY: "笔记内容尚未完整加载，请稍后重试。",
  CAPTURE_API_UNAVAILABLE: "当前 CMS 版本不支持收藏同步，请先将 CMS 升级并部署到 1.17.0 或更高版本。",
  CAPTURE_SERVER_UNAVAILABLE: "CMS 服务暂时不可用，请检查服务状态后继续同步。",
  CAPTURE_REJECTED: "笔记采集结果不完整，已阻止进入研究流程。",
  CAPTURE_UNAUTHORIZED: "采集令牌无效，请核对扩展设置与 CMS 的 CAPTURE_TOKEN。",
  UNAUTHORIZED: "采集令牌无效，请检查扩展设置与 CMS 的 CAPTURE_TOKEN。",
  NETWORK_ERROR: "无法连接 CMS，请确认服务地址、采集令牌和 CMS 运行状态。",
});

let busy = false;
let refreshing = false;
let transientNotice = "";

void refresh();
const refreshTimer = setInterval(() => {
  if (!document.hidden && !document.querySelector("input:focus,select:focus")) void refresh();
}, 1_000);
window.addEventListener("unload", () => clearInterval(refreshTimer));

elements.sync.addEventListener("click", () => command("START_SYNC", { mode: "incremental" }));
elements.full.addEventListener("click", () => command("START_SYNC", { mode: "full" }));
elements.save.addEventListener("click", () => command("SAVE_CURRENT"));
elements.pause.addEventListener("click", () => command("PAUSE_SYNC"));
elements.resume.addEventListener("click", () => command("RESUME_SYNC"));
elements.cancel.addEventListener("click", () => command("CANCEL_SYNC"));
elements.stopQueue.addEventListener("click", () => command("STOP_AFTER_QUEUE"));
elements.saveSettings.addEventListener("click", saveSettings);

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_STATE" });
    if (!response?.ok) return showError(response?.error);
    render(response);
  } catch (error) {
    showError(error);
  } finally {
    refreshing = false;
  }
}

async function command(type, payload = {}) {
  setBusy(true);
  let refreshAfter = true;
  try {
    const response = await chrome.runtime.sendMessage({ type, ...payload });
    if (!response?.ok) {
      showError(response?.error);
      refreshAfter = false;
    } else if (type === "SAVE_CURRENT") {
      transientNotice = response.result?.duplicate
        ? "当前笔记已采集过，内容没有变化。"
        : "当前笔记已保存，CMS 已接收并加入研究抽取队列。";
    }
  } catch (error) {
    showError(error);
    refreshAfter = false;
  } finally {
    setBusy(false);
    if (refreshAfter) await refresh();
  }
}

async function saveSettings() {
  setBusy(true);
  try {
    const response = await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings: {
      endpoint: elements.endpoint.value,
      token: elements.token.value,
      autoSync: elements.autoSync.value,
      concurrencyMode: elements.concurrencyMode.value,
      customConcurrency: Number(elements.customConcurrency.value || 4),
      identityBatchSize: Number(elements.identityBatchSize.value || 50),
      discoveryBatchSize: Number(elements.discoveryBatchSize.value || 100),
      stopAfterConsecutiveKnown: Number(elements.knownStreak.value || 12),
      queueHighWatermark: Number(elements.queueHighWatermark.value || 500),
      maxRetries: Number(elements.maxRetries.value || 3),
      detailLoadTimeoutMs: Number(elements.detailTimeout.value || 30_000),
      autoMinIntervalHours: Number(elements.autoMinHours.value || 12),
    } });
    if (!response?.ok) return showError(response?.error);
    transientNotice = "设置已保存并通过连接检查。";
    await refresh();
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
}

function render({ session, currentScope, currentPageKind, settings, history }) {
  elements.status.className = "";
  elements.endpoint.value = settings.endpoint || "";
  elements.token.placeholder = settings.tokenConfigured ? "采集令牌已保存" : "请输入采集令牌";
  elements.autoSync.value = settings.autoSync || "off";
  elements.concurrencyMode.value = settings.concurrencyMode || "auto";
  elements.customConcurrency.value = settings.customConcurrency || 4;
  elements.identityBatchSize.value = settings.identityBatchSize || 50;
  elements.discoveryBatchSize.value = settings.discoveryBatchSize || 100;
  elements.knownStreak.value = settings.stopAfterConsecutiveKnown || 12;
  elements.queueHighWatermark.value = settings.queueHighWatermark || 500;
  elements.maxRetries.value = settings.maxRetries ?? 3;
  elements.detailTimeout.value = settings.detailLoadTimeoutMs || 30_000;
  elements.autoMinHours.value = settings.autoMinIntervalHours || 12;
  elements.customConcurrencyField.hidden = elements.concurrencyMode.value !== "custom";
  elements.concurrencyMode.onchange = () => { elements.customConcurrencyField.hidden = elements.concurrencyMode.value !== "custom"; };
  if (CLOUD_CONFIGURED) elements.settingsPanel.hidden = true;

  const activeSession = session && !["completed", "cancelled"].includes(session.status) ? session : null;
  const last = history?.find((item) => item.scopeKey === currentScope?.key) || history?.[0];
  elements.scope.textContent = activeSession?.scopeLabel || currentScope?.label
    || (currentPageKind === "album_overview" ? "专辑总览（请选择“笔记”或一个专辑）" : session?.scopeLabel || last?.scopeLabel || "未识别到收藏夹");
  elements.lastSync.textContent = last?.completedAt ? new Date(last.completedAt).toLocaleString("zh-CN") : "从未同步";

  const stats = session?.stats || { discovered: 0, known: 0, new: 0, captured: 0, duplicate: 0, failed: 0, retrying: 0 };
  const queued = session?.queue?.filter((item) => ["queued", "retry_wait"].includes(item.status)).length || 0;
  elements.counts.innerHTML = [
    ["已发现", stats.discovered], ["已存在", stats.known], ["新增", stats.new], ["已采集", stats.captured],
    ["内容重复", stats.duplicate], ["排队中", queued], ["失败", stats.failed],
  ].map(([label, value]) => `<div><span>${label}</span><strong>${Number(value || 0)}</strong></div>`).join("");

  const running = session?.status === "running";
  const paused = session?.status?.startsWith("paused_");
  elements.actions.hidden = !session || ["completed", "cancelled"].includes(session.status);
  elements.pause.hidden = !running;
  elements.resume.hidden = !paused;
  elements.stopQueue.hidden = !running || session.discoveryComplete;
  elements.sync.disabled = running || paused || (!activeSession && !currentScope);
  elements.full.disabled = running || paused || (!activeSession && !currentScope);

  if (transientNotice) {
    elements.status.textContent = transientNotice;
    transientNotice = "";
  } else {
    renderStatus({ session, currentScope, currentPageKind, settings, stats, queued });
  }
  $("#open-xhs")?.addEventListener("click", () => command("OPEN_XHS"));
  if (busy) setBusy(true);
}

function renderStatus({ session, currentScope, currentPageKind, settings, stats, queued }) {
  if (!session) {
    elements.status.textContent = currentScope
      ? "已正确识别当前收藏夹，等待采集指令……"
      : currentPageKind === "album_overview"
        ? "当前是“专辑”总览：点击“笔记”可同步全部收藏，或进入某个专辑只同步该专辑。"
        : "尚未识别到小红书收藏夹，请打开目标收藏夹页面。";
    if (!currentScope) elements.status.className = "error";
    return;
  }
  if (["completed", "cancelled"].includes(session.status) && currentScope && currentScope.key !== session.scopeKey) {
    elements.status.textContent = "已正确识别当前收藏夹，等待采集指令……";
    return;
  }
  if (["completed", "cancelled"].includes(session.status) && currentPageKind === "album_overview") {
    elements.status.textContent = "当前是“专辑”总览：点击“笔记”可同步全部收藏，或进入某个专辑只同步该专辑。";
    elements.status.className = "error";
    return;
  }
  if (session.status === "completed") {
    elements.status.textContent = stats.new
      ? `同步完成：CMS 已接收 ${stats.captured + stats.duplicate} 条新增收藏，失败 ${stats.failed} 条。`
      : "同步完成：当前收藏夹没有需要采集的新内容。";
    return;
  }
  if (session.status === "cancelled") {
    elements.status.textContent = "同步已取消；已成功采集的内容仍然保留。";
    return;
  }
  if (session.status === "paused_login_required") {
    elements.status.innerHTML = "同步已暂停：需要重新登录小红书。完成登录后点击“继续同步”。 <button class=\"link\" id=\"open-xhs\">打开小红书</button>";
    return;
  }
  if (session.status === "paused_verification_required") {
    elements.status.innerHTML = "同步已暂停：请手动完成小红书安全验证，然后点击“继续同步”。 <button class=\"link\" id=\"open-xhs\">打开小红书</button>";
    return;
  }
  if (session.status === "paused_recovered") {
    elements.status.textContent = "检测到上次未完成的同步任务，队列已恢复，请点击“继续同步”。";
    return;
  }
  if (session.status?.startsWith("paused_")) {
    elements.status.textContent = `同步已暂停：${localizedError(session.lastError) || "准备好后可继续同步。"}`;
    return;
  }
  if (session.phase === "discovery") {
    elements.status.textContent = `正在扫描收藏夹……已发现 ${stats.discovered} 条，其中新增 ${stats.new} 条。`;
    return;
  }
  if (session.phase === "acquisition") {
    const retrying = Number(stats.retrying || 0);
    elements.status.textContent = `正在采集新增收藏……排队 ${queued} 条，已完成 ${stats.captured + stats.duplicate} 条，当前并发 ${session.concurrency || settings.customConcurrency}${retrying ? `，等待重试 ${retrying} 条` : ""}。`;
    return;
  }
  elements.status.textContent = "正在保存同步结果和检查点……";
}

function setBusy(value) {
  busy = value;
  for (const button of document.querySelectorAll("button")) button.disabled = value;
}
function showError(error) {
  elements.status.textContent = localizedError(error) || "扩展操作失败，请稍后重试。";
  elements.status.className = "error";
}
function localizedError(error) {
  const code = String(error?.code || "");
  return ERROR_MESSAGES[code] || String(error?.message || error || "");
}
