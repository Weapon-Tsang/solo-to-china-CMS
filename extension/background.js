import {
  applyIdentityBatch, applySettingsToSession, AsyncSemaphore, classifyCaptureApiError, classifyTaskDisposition, compactSessionState, createSession,
  hasUnresolvedFailures, initialConcurrency, isFavoritesAlbumOverviewUrl, leaseNextTask, mediaIdentitiesToRepair, normalizeSettings, reconcileStrandedTasks,
  recoverSession, retryDelayMs, scopeFromUrl, shouldStopDiscovery, transitionTask, updateSessionConcurrency,
  prepareSessionCompletion, prepareSessionResume,
} from "./sync-core.js";
import { normalizeCaptureMedia, detectMediaMime } from "./media-contract.js";
import { fetchBody } from "./transport.js";
import { mediaJournal } from './media-journal.js';
import { derivativeCache } from './derivative-cache.js';
import { bounded, DEADLINES, sameRun, stoppedError, tabMatches } from './run-control.js';

const DEFAULT_ENDPOINT = "http://127.0.0.1:4310";
const DEFAULT_CAPTURE_TOKEN = "";
const STATE_KEY = "favoritesSyncState";
const SETTINGS_KEY = "favoritesSyncSettings";
const SCOPES_KEY = "favoritesSyncScopes";
const HISTORY_KEY = "favoritesSyncHistory";
const CONNECTION_ISSUE_KEY = "favoritesConnectionIssue";
const TICK_ALARM = "stc-favorites-tick";
const AUTO_ALARM = "stc-favorites-auto";
const DIRECT_CAPTURE_BYTES = 3_500_000;
const UPLOAD_CHUNK_BYTES = 2 * 1024 * 1024;
const DIRECT_DERIVATIVE_BYTES = 5_500_000;
const ENGINE_REQUEST_TIMEOUT_MS = 45_000;
const MEDIA_REQUEST_TIMEOUT_MS = 30_000;
const LARGE_MEDIA_THRESHOLD_BYTES = 8 * 1024 * 1024;
let driving = false;
let driveTimer = null;
let stateMutation = Promise.resolve();
const workerLoops = new Map();
const mediaRequests = new AsyncSemaphore(12);
const mediaUploads = new AsyncSemaphore(6);
const largeMediaPipelines = new AsyncSemaphore(2);
const mediaMemory = new AsyncSemaphore(96, { maxBypasses: 4 });
const taskRequests = new Map();
const runRequests = new Map();
const closeIntents = new Set();
let commandFlight = null;
let restoreFlight = null;
let stopEpoch = 0;
let diagnosticWrites = Promise.resolve();
const browserIdentity = (async () => {
  if (!chrome.storage.session) return null; // Legacy/unknown ownership must pause.
  const key = 'favoritesBrowserIdentity';
  const stored = await chrome.storage.session.get({ [key]: null });
  const id = stored[key] || crypto.randomUUID();
  if (!stored[key]) await chrome.storage.session.set({ [key]: id });
  return id;
})();

function singleCommand(operation) {
  if (commandFlight) return commandFlight;
  commandFlight = operation().finally(() => { commandFlight = null; });
  return commandFlight;
}
function trace(session, event, role, tabId, extra = {}) {
  const entry = { at: new Date().toISOString(), sessionId: session?.sessionId,
    revision: session?.runRevision, scope: session?.sessionId ? 'session-scope' : 'none',
    status: session?.status, event, role, tabId, attempts: session?.driverAttempts || 0, ...extra };
  diagnosticWrites = diagnosticWrites.catch(() => {}).then(async () => {
    const key = 'favoritesSyncDiagnostics';
    const stored = await chrome.storage.local.get({ [key]: [] });
    await chrome.storage.local.set({ [key]: [...stored[key], entry].slice(-200) });
  });
  return diagnosticWrites;
}
async function assertRun(expected) {
  const current = await loadState();
  if (!sameRun(current, expected)) throw stoppedError();
  return current;
}
function runSignal(session) {
  const key = `${session.sessionId}:${session.runRevision}`;
  if (!runRequests.has(key)) runRequests.set(key, new AbortController());
  return runRequests.get(key).signal;
}
function revokeRequests(session) {
  clearTimeout(driveTimer); driveTimer = null;
  for (const [key, controller] of runRequests) if (key.startsWith(`${session.sessionId}:`)) { controller.abort(stoppedError()); runRequests.delete(key); }
  for (const request of taskRequests.values()) if (request.sessionId === session.sessionId) request.controller.abort(stoppedError());
  for (const record of Object.values(session.tabOwnership || {})) {
    void chrome.scripting?.executeScript({ target: { tabId: record.tabId }, func: () => globalThis.SoloToChinaXhs?.cancel?.() }).catch(() => {});
  }
}
chrome.tabs?.onRemoved?.addListener((tabId, info) => {
  if (closeIntents.delete(tabId)) return;
  void loadState().then(async session => {
    if (session?.status !== 'running') return;
    if (session.discoveryTabId === tabId || session.workerTabs?.includes(tabId)) {
      await trace(session, 'tab-removed', 'associated', tabId, { windowClosing: Boolean(info?.isWindowClosing) });
      await pauseSync('paused_tab_closed', session);
    }
  }).catch(() => {});
});
chrome.tabs?.onUpdated?.addListener((tabId, change, tab) => {
  if (!change.url) return;
  void loadState().then(async session => {
    const record = session?.tabOwnership?.[tabId];
    if (session?.status !== 'running' || !record || tabMatches({ ...tab, url: change.url, pendingUrl: change.url }, record)) return;
    await trace(session, 'navigation-left-scope', record.role, tabId);
    const status = /login|signin/i.test(new URL(change.url).pathname) ? 'paused_login_required' : 'paused_tab_closed';
    await pauseSync(status, session);
  }).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  void ensureAlarms();
  void refreshAutoAlarm();
});
chrome.runtime.onStartup.addListener(() => {
  void (async () => { await restoreAfterRestart(); await refreshAutoAlarm();
    if ((await loadSettings()).autoSync === 'startup') await singleCommand(startAutomaticSync);
  })().catch(() => {});
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) void watchdog();
  if (alarm.name === AUTO_ALARM) void singleCommand(startAutomaticSync).catch(() => {});
});

// A service worker can be restarted independently of the Chrome profile.
// Reconcile persisted work immediately instead of waiting for the minute alarm.
void ensureAlarms();
void restoreAfterRestart();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleMessage(message, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, error: serializeError(error) }));
  return true;
});

async function handleMessage(message) {
  switch (message?.type) {
    case "GET_STATE": return { ok: true, ...(await publicState()) };
    case "SAVE_SETTINGS": {
      const previous = await loadSettings();
      const requested = message.settings || {};
      const settings = await settingsWithConnection({ ...previous, ...requested,
        token: String(requested.token || "").trim() || previous.token });
      await chrome.storage.local.set({ [SETTINGS_KEY]: settings, endpoint: settings.endpoint, token: settings.token });
      if (settings.endpoint !== previous.endpoint || settings.token !== previous.token) {
        await chrome.storage.local.set({ [CONNECTION_ISSUE_KEY]: null });
      }
      configureMediaResources(settings);
      const session = await mutateState(null, (current) => current && !["completed", "completed_with_failures", "cancelled"].includes(current.status)
        ? applySettingsToSession(current, settings) : current);
      if (session) configureSessionMediaResources(session);
      await refreshAutoAlarm();
      if (session?.status === "running") {
        ensureWorkerPool(session);
        void drive();
      }
      return { ok: true, settings: publicSettings(settings), session };
    }
    case "START_SYNC": return singleCommand(() => startSync(["incremental","repair","full"].includes(message.mode) ? message.mode : "incremental"));
    case "CHECK_CONNECTION": {
      await assertFavoritesSyncApi();
      return { ok: true };
    }
    case "PAUSE_SYNC": return pauseSync("paused_by_user");
    case "RESUME_SYNC": return singleCommand(resumeSync);
    case "CANCEL_SYNC": return cancelSync();
    case "STOP_AFTER_QUEUE": return stopAfterQueue();
    case "OPEN_XHS": return openXiaohongshu();
    case "SAVE_CURRENT": return saveCurrentNote();
    default: return { ok: false, error: { code: "UNKNOWN_COMMAND", message: "Unsupported extension command." } };
  }
}

async function startSync(mode, automatic = false) {
  const epoch = stopEpoch;
  const state = await loadState();
  if (state && !["completed", "completed_with_failures", "cancelled"].includes(state.status)) return { ok: false, error: syncError("SESSION_ALREADY_RUNNING", "A Favorites Sync session is already active.", false) };
  const settings = await loadSettings();
  if (automatic && ((state?.autoBlocked && state.scopeKey === settings.lastScopeKey)
    || (await loadScopes())[settings.lastScopeKey]?.autoBlocked)) return { ok: false, error: { code: 'AUTO_PAUSED' } };
  await assertFavoritesSyncApi(settings);
  if (epoch !== stopEpoch) throw stoppedError();
  let tab;
  if (automatic) {
    if (!settings.lastScopeUrl) return { ok: false, error: syncError("NO_AUTO_SCOPE", "Open a Favorites collection and run one manual sync first.", false) };
    await trace(null, 'create-dispatched', 'automatic-discovery', null);
    if (epoch !== stopEpoch) throw stoppedError();
    tab = await chrome.tabs.create({ url: settings.lastScopeUrl, active: false });
  } else {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  const scope = scopeFromUrl(tab?.url || "");
  if (!tab?.id || !scope || /\/explore\//.test(new URL(scope.url).pathname)) {
    return { ok: false, error: syncError("INVALID_FAVORITES_SCOPE", "Open the target Xiaohongshu favorites collection before starting sync.", false) };
  }
  configureMediaResources(settings);
  const scopes = await loadScopes();
  const session = createSession({ scope, mode, settings, checkpoint: scopes[scope.key]?.checkpoint || null });
  if (epoch !== stopEpoch) {
    if (automatic) await removeOwnedTab(null, { tabId: tab.id, windowId: tab.windowId, url: tab.url, role: 'discovery', owned: true });
    throw stoppedError();
  }
  session.runRevision = 1;
  session.controlSchema = 1;
  session.browserIdentity = await browserIdentity;
  if (epoch !== stopEpoch) {
    if (automatic) await removeOwnedTab(null, { tabId: tab.id, windowId: tab.windowId, url: tab.url, role: 'discovery', owned: true });
    throw stoppedError();
  }
  session.tabOwnership = { [tab.id]: { tabId: tab.id, windowId: tab.windowId, url: tab.url, role: 'discovery', owned: automatic } };
  session.discoveryTabId = tab.id;
  session.automatic = automatic;
  session.workerTabs = [];
  session.stopAfterQueue = false;
  const committed = await mutateState(null, current => epoch === stopEpoch ? session : current);
  if (committed?.sessionId !== session.sessionId) throw stoppedError();
  scopes[scope.key] = { ...scopes[scope.key], autoBlocked: false };
  await chrome.storage.local.set({ [SCOPES_KEY]: scopes });
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...settings, lastScopeUrl: scope.url, lastScopeKey: scope.key } });
  void drive();
  return { ok: true, session };
}

async function drive() {
  if (driving) return;
  driving = true;
  let run;
  try {
    let session = await loadState();
    run = session;
    if (!session || session.status !== "running" || session.resumePending) return;
    if (Date.parse(session.driveRetryAt || 0) > Date.now()) return;
    if (session.phase === "discovery") {
      session = await discoverWindow(session);
      session = await persistProgress(session);
      if (session.status !== "running") return;
    }
    if (session.phase === "acquisition") {
      session = await acquireQueue(session);
      if (session.status !== "running") return;
    }
    if (session.phase === "completed") await completeSession(session);
  } catch (error) {
    await handleDriverError(error, run);
  } finally {
    driving = false;
    const current = await loadState().catch(() => null);
    if (current?.status === "running") scheduleDrive(current);
  }
}

async function discoverWindow(session) {
  // Drain discovered work before scanning again. A short collection may never
  // render an explicit end marker; its scan timeout must not starve this queue.
  if (session.queue.some(task => task.status === 'queued')) {
    session.phase = 'acquisition';
    return session;
  }
  const signal = runSignal(session);
  const tab = await ensureDiscoveryTab(session);
  await injectExtractor(tab.id, signal);
  await assertRun(session);
  const offset = Number(session.cursor?.domOffset || 0);
  let scan = await execute(tab.id, (options) => globalThis.SoloToChinaXhs.scanFavorites(options), {
    limit: session.config.discoveryBatchSize, offset: 0, seenIdentities: session.seenIdentityKeys,
  }, signal, DEADLINES.scan);
  await assertRun(session);
  // Virtualized collections remove older cards from the DOM. Reset the DOM offset
  // and rely on stable identity de-duplication when the current window is exhausted.
  if (offset && scan?.cards?.length === 0 && !scan.collectionEnd) {
    session.cursor.domOffset = 0;
    scan = await execute(tab.id, (options) => globalThis.SoloToChinaXhs.scanFavorites(options), {
      limit: session.config.discoveryBatchSize, offset: 0, seenIdentities: session.seenIdentityKeys,
    }, signal, DEADLINES.scan);
  }
  if (scan?.blocking) throw Object.assign(new Error(scan.blocking.message), scan.blocking);
  if (!scan?.cards) throw syncError("SELECTOR_MISMATCH", "No favorites cards could be read from the current collection.", true);
  const unseenCards = scan.cards.filter((card) => !session.seenIdentityKeys.includes(`xiaohongshu:${card.externalId}`));
  const identityRows = [];
  for (let index = 0; index < unseenCards.length; index += session.config.identityBatchSize) {
    await assertRun(session);
    identityRows.push(...await identityCheck(unseenCards.slice(index, index + session.config.identityBatchSize), null, signal));
  }
  await assertRun(session);
  if (unseenCards.length) { session.lastProgressAt = new Date().toISOString(); session.lastBusinessProgress = 'new-identities'; session.noProgressSince = null; }
  else if (!scan.collectionEnd) {
    session.noProgressSince ||= Date.now();
    if (Date.now() - session.noProgressSince >= session.config.watchdogStallMs) throw syncError('DISCOVERY_STALLED', '列表没有新增身份，已暂停；请检查页面后继续。', false);
  }
  session = applyIdentityBatch(session, scan.cards, identityRows, { collectionEnd: scan.collectionEnd, scrollY: scan.scrollY });
  session.cursor.domOffset = Number(session.cursor.domOffset || offset) + scan.cards.length;
  session = await persistProgress(session);
  if (session.status !== "running") return session;
  const shouldStop = shouldStopDiscovery(session);
  const backlog = session.queue.filter((task) => ["queued", "retry_wait"].includes(task.status)).length;
  if (shouldStop || session.stopAfterQueue || backlog > 0) {
    session.discoveryComplete = shouldStop || session.stopAfterQueue;
    session.phase = "acquisition";
    return session;
  }
  const scroll = await execute(tab.id, () => globalThis.SoloToChinaXhs.scrollFavoritesWindow(), undefined, signal, DEADLINES.scan);
  await assertRun(session);
  if (scroll?.collectionEnd && scan.cards.length === 0) {
    session.cursor.collectionEnd = true;
    return session;
  }
  session.cursor.scrollY = scroll?.scrollY || session.cursor.scrollY;
  if (scroll?.collectionEnd) session.cursor.collectionEnd = true;
  session = await persistProgress(session);
  return session;
}

async function acquireQueue(session) {
  const reconciled = reconcileStrandedTasks(session);
  session = reconciled.session;
  const runnable = session.queue.some((task) => task.status === "queued"
    || (task.status === "retry_wait" && Date.parse(task.retryAt || 0) <= Date.now()));
  const inFlight = session.queue.some((task) => ["opening", "loading", "extracting", "submitting"].includes(task.status));
  const retrying = session.queue.some((task) => task.status === "retry_wait");
  if (!runnable && !inFlight) {
    if (retrying) return persistProgress(session);
    if (!session.discoveryComplete && !session.stopAfterQueue) session.phase = "discovery";
    else session.phase = "completed";
    return persistProgress(session);
  }
  session = compactSessionState(session);
  session = await persistProgress(session);
  ensureWorkerPool(session);
  return session;
}

function ensureWorkerPool(session) {
  if (!session || session.status !== "running" || session.resumePending || session.phase !== "acquisition") return;
  if (!session.queue.some(task => task.status === 'queued' || (task.status === 'retry_wait' && Date.parse(task.retryAt || 0) <= Date.now()))) return;
  const target = Math.max(1, Math.min(16, session.concurrency || initialConcurrency(session.config)));
  for (let slot = 0; slot < target; slot += 1) {
    const key = `${session.sessionId}:${session.runRevision}:${slot}`;
    if (workerLoops.has(key)) continue;
    const workerId = session.workerSlots?.[slot]?.workerId || `note-worker-${slot}-${crypto.randomUUID()}`;
    const promise = runWorkerSlot(session.sessionId, slot, workerId, session)
      .catch(() => null)
      .finally(() => {
        workerLoops.delete(key);
        void drive();
      });
    workerLoops.set(key, promise);
  }
}

async function runWorkerSlot(sessionId, slot, workerId, expected) {
  while (true) {
    let claimed = null;
    const state = await mutateState(sessionId, (current) => {
      if (!sameRun(current, expected) || current.phase !== "acquisition"
        || slot >= Number(current.concurrency || 1)) return current;
      const leased = leaseNextTask(current, { workerId });
      claimed = leased.task;
      return leased.session;
    });
    if (!claimed || !state || state.status !== "running") return;
    await acquireTask(sessionId, claimed.taskId, slot, workerId, claimed.leaseId);
  }
}

async function acquireTask(sessionId, taskId, slot, workerId, leaseId) {
  let session = await assertTaskLease(sessionId, taskId, leaseId);
  const task = session.queue.find((item) => item.taskId === taskId);
  const metric = { startedAt: Date.now(), result: "failed", mediaCount: 0, mediaBytes: 0 };
  const controller = new AbortController();
  // Extraction can spend up to two minutes waiting for XHS media/DOM to settle.
  // Keep the durable lease alive during those browser-only stages as well as
  // during media upload, otherwise the watchdog can start a duplicate worker.
  const heartbeatEveryMs = Math.max(5_000, Math.min(30_000, Math.floor(session.config.taskLeaseMs / 3)));
  const heartbeatTimer = setInterval(() => { void heartbeatTask(sessionId, taskId, leaseId).catch(() => null); }, heartbeatEveryMs);
  taskRequests.set(leaseId, { sessionId, controller });
  const parentSignal = runSignal(session);
  const abortTask = () => controller.abort(stoppedError());
  parentSignal.addEventListener('abort', abortTask, { once: true });
  const taskDeadline = setTimeout(() => controller.abort(syncError('TASK_DEADLINE', '采集任务超过总时限，保留原件和回执等待恢复。', false)), DEADLINES.task);
  const captureJournalKey = `capture:${sessionId}:${taskId}`;
  try {
    const journal = await mediaJournal.get(captureJournalKey);
    if (journal?.receipt?.mediaDurabilityComplete && journal.receipt.completenessStatus === 'complete') {
      await finishTask(sessionId, taskId, leaseId, 'captured', { sourceId: journal.receipt.id, captureVersion: journal.receipt.captureVersion, error: null }, metric);
      return journal.receipt;
    }
    if (task.attempts > 1 || task.recoveredAt) {
      const [known] = await identityCheck([task], null, controller.signal);
      await assertTaskLease(sessionId, taskId, leaseId);
      if (known?.known && !known.requiredActions?.length) {
        await finishTask(sessionId, taskId, leaseId, 'duplicate', { sourceId: known.sourceId, error: null }, metric);
        return known;
      }
    }
    let extracted = journal?.capture;
    let stageStarted;
    if (!extracted || extracted.completeness?.overall !== 'complete') {
    const tab = await workerTab(sessionId, slot, workerId, task.navigationUrl || task.canonicalUrl, session);
    session = await updateTask(sessionId, taskId, "loading", { tabId: tab.id }, leaseId);
    assertRunnable(session, taskId, leaseId);
    stageStarted = Date.now();
    await waitForTab(tab.id, session.config.detailLoadTimeoutMs, controller.signal);
    metric.noteLoadMs = Date.now() - stageStarted;
    await assertTaskLease(sessionId, taskId, leaseId);
    await injectExtractor(tab.id, controller.signal);
    session = await updateTask(sessionId, taskId, "extracting", {}, leaseId);
    assertRunnable(session, taskId, leaseId);
    stageStarted = Date.now();
    const result = await execute(tab.id, (options) => globalThis.SoloToChinaXhs.prepareAndExtract(options), {
      acquisitionOrigin: "xhs_favorites_sync", syncScopeKey: session.scopeKey,
    }, controller.signal, DEADLINES.extraction);
    metric.extractionMs = Date.now() - stageStarted;
    await assertTaskLease(sessionId, taskId, leaseId);
    if (!result?.ok) throw Object.assign(new Error(result?.error?.message || "Note extraction failed."), result?.error || {});
    extracted = result.capture;
    await mediaJournal.put(captureJournalKey, { capture: extracted, savedAt: new Date().toISOString() });
    }
    const onlyMediaIdentities = mediaIdentitiesToRepair(task);
    await submitCapture({ ...extracted, completeness: { ...extracted.completeness,
      images: { ...extracted.completeness?.images, complete: false }, overall: 'partial_retryable' } }, controller.signal);
    const persisted = await persistCaptureMedia(extracted, async () => {
      try {
        await assertTaskLease(sessionId, taskId, leaseId);
        await heartbeatTask(sessionId, taskId, leaseId);
        await mutateState(sessionId, current => {
          if (current.status === 'running' && current.queue.find(t => t.taskId === taskId)?.leaseId === leaseId) {
            current.lastProgressAt = new Date().toISOString(); current.lastBusinessProgress = 'media-ack';
          }
          return current;
        });
      }
      catch (error) { controller.abort(); throw error; }
    }, onlyMediaIdentities, controller.signal);
    const capture = persisted.capture;
    Object.assign(metric, persisted.metrics);
    metric.memoryPressure = browserMemoryPressure();
    session = await updateTask(sessionId, taskId, "submitting", {}, leaseId);
    assertRunnable(session, taskId, leaseId);
    stageStarted = Date.now();
    const response = await submitCapture(capture, controller.signal);
    await mediaJournal.put(captureJournalKey, { capture, receipt: response, savedAt: new Date().toISOString() });
    metric.submitMs = Date.now() - stageStarted;
    if (response.completenessStatus !== "complete") throw Object.assign(new Error("Capture was persisted as partial and will be retried before entering Research."), {
      code: "CONTENT_NOT_READY", retryable: true,
    });
    if (!response.mediaDurabilityComplete) throw Object.assign(new Error("Media discovery completed, but one or more original files were not durably stored. This note remains in the repair queue."), {
      code: "MEDIA_ORIGINAL_NOT_STORED", retryable: true,
    });
    metric.result = "succeeded";
    metric.cmsBackpressure = response.advice === "slow_down";
    metric.totalMs = Date.now() - metric.startedAt;
    session = await finishTask(sessionId, taskId, leaseId, response.duplicate ? "duplicate" : "captured", {
      sourceId: response.id, captureVersion: response.captureVersion, tabId: null, error: null,
    }, metric);
    if (session?.queue.find(item => item.taskId === taskId)?.status === 'captured'
      || session?.queue.find(item => item.taskId === taskId)?.status === 'duplicate') await mediaJournal.remove(captureJournalKey);
    return response;
  } catch (caught) {
    metric.totalMs = Date.now() - metric.startedAt;
    await handleTaskError(sessionId, taskId, leaseId, caught, metric);
    return null;
  } finally { clearInterval(heartbeatTimer); clearTimeout(taskDeadline); parentSignal.removeEventListener('abort', abortTask); controller.abort(); taskRequests.delete(leaseId); }
}

async function handleTaskError(sessionId, taskId, leaseId, caught, metric = {}) {
  const error = serializeError(caught);
  const updated = await mutateState(sessionId, (current) => {
    if (!current) return current;
    const task = current.queue.find((item) => item.taskId === taskId);
    if (!task || task.leaseId !== leaseId || current.status === "cancelled" || task.status === "cancelled") return current;
    let session = current;
    if (current.status !== "running") {
      session = transitionTask(session, taskId, "queued", { error, retryAt: null, tabId: null });
      clearLease(session, taskId);
      return session;
    }
    const disposition = classifyTaskDisposition(error, task.attempts, session.config.maxRetries);
    if (disposition.action === "pause") {
      session = transitionTask(session, taskId, disposition.status, { error, tabId: null });
      session.status = disposition.status;
      session.stats.paused = (session.stats.paused || 0) + 1;
    } else if (disposition.action === "retry") {
      const delay = Math.max(Number(error.retryAfterMs || metric.retryAfterMs || 0), retryDelayMs(task.attempts, {
        baseMs: session.config.retryBaseMs, maxMs: session.config.retryMaxMs,
      }));
      session = transitionTask(session, taskId, "retry_wait", { error,
        retryAt: new Date(Date.now() + delay).toISOString(), tabId: null });
    } else {
      session = transitionTask(session, taskId, "failed", { error, permanent: true,
        unavailable: disposition.unavailable, tabId: null });
    }
    clearLease(session, taskId);
    session.lastError = error;
    session = updateSessionConcurrency(session, metricFromError(metric, error));
    return session;
  });
  if (updated && ["paused_login_required", "paused_verification_required", "paused_capture_unauthorized"].includes(updated.status)) {
    await reportSession(updated).catch(() => null);
  }
  if (updated) configureSessionMediaResources(updated);
  if (updated && updated.status !== 'running') revokeRequests(updated);
}

async function finishTask(sessionId, taskId, leaseId, status, details, metric) {
  const updated = await mutateState(sessionId, (current) => {
    const task = current?.queue.find((item) => item.taskId === taskId);
    if (!current || current.status !== "running" || !task || task.leaseId !== leaseId) return current;
    let next = transitionTask(current, taskId, status, details);
    clearLease(next, taskId);
    next = updateSessionConcurrency(next, metric);
    return next;
  });
  if (updated) configureSessionMediaResources(updated);
  return updated;
}

async function heartbeatTask(sessionId, taskId, leaseId) {
  return mutateState(sessionId, (current) => {
    const task = current?.queue.find((item) => item.taskId === taskId);
    if (!current || current.status !== "running" || !task || task.leaseId !== leaseId) return current;
    const now = new Date().toISOString();
    task.leaseExpiresAt = new Date(Date.now() + current.config.taskLeaseMs).toISOString();
    task.updatedAt = now;
    task.lastHeartbeatAt = now;
    return current;
  });
}

async function assertTaskLease(sessionId, taskId, leaseId) {
  const session = await loadState();
  assertRunnable(session, taskId, leaseId, sessionId);
  return session;
}

function assertRunnable(session, taskId, leaseId, sessionId = session?.sessionId) {
  const task = session?.queue?.find((item) => item.taskId === taskId);
  if (!session || session.sessionId !== sessionId || session.status !== "running" || task?.leaseId !== leaseId) {
    throw syncError("TASK_LEASE_LOST", "The browser task lease is no longer active.", false);
  }
}

function clearLease(session, taskId) {
  const task = session?.queue?.find((item) => item.taskId === taskId);
  if (!task) return;
  task.leaseId = null;
  task.leaseStartedAt = null;
  task.leaseExpiresAt = null;
  task.workerId = null;
  session.activeTasks = session.queue.filter((item) => ["opening", "loading", "extracting", "submitting"].includes(item.status)).map((item) => item.taskId);
}

function metricFromError(metric, error) {
  const code = String(error.code || "NETWORK_ERROR");
  return {
    ...metric, result: "failed", errorClass: code,
    rateLimited: Boolean(metric.rateLimited) || code.endsWith("_429") || code === "CAPTURE_RATE_LIMITED",
    verificationDetected: code === "VERIFICATION_REQUIRED", loginRequired: code === "NOT_LOGGED_IN",
    tabCrash: ["WORKER_TAB_CLOSED", "TAB_CRASH"].includes(code), timeout: /TIMEOUT/.test(code),
    cmsBackpressure: Boolean(metric.cmsBackpressure) || Boolean(error.backpressure) || ["CAPTURE_SERVER_UNAVAILABLE"].includes(code),
  };
}

async function submitCapture(capture, signal) {
  const settings = await loadSettings();
  const json = JSON.stringify(capture);
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength <= DIRECT_CAPTURE_BYTES) {
    const result = await apiJson(`${settings.endpoint}/api/captures`, { method: "POST", body: json, signal }, settings.token);
    await clearAcceptedMedia(capture, result);
    return result;
  }
  const sha256 = await hashBytes(bytes);
  const upload = await apiJson(`${settings.endpoint}/api/capture-uploads`, { method: "POST", body: JSON.stringify({ size: bytes.byteLength, sha256 }), signal }, settings.token);
  for (let offset = 0, index = 0; offset < bytes.length; offset += UPLOAD_CHUNK_BYTES, index += 1) {
    await apiJson(`${settings.endpoint}/api/capture-uploads/${encodeURIComponent(upload.uploadId)}/chunks/${index}`,
      { method: "PUT", body: bytes.slice(offset, offset + UPLOAD_CHUNK_BYTES), raw: true, signal }, settings.token);
  }
  const result = await apiJson(`${settings.endpoint}/api/capture-uploads/${encodeURIComponent(upload.uploadId)}/complete`, { method: "POST", body: "{}", signal }, settings.token);
  await clearAcceptedMedia(capture, result);
  return result;
}

async function clearAcceptedMedia(capture, result) {
  if (!result.mediaDurabilityComplete || result.completenessStatus !== 'complete') return;
  const attempt = await hashBytes(new TextEncoder().encode(JSON.stringify([capture.url, capture.text, capture.html])));
  for (const asset of [...(capture.images || []), ...(capture.videos || [])]) {
    if (asset.originalStorageRef) await mediaJournal.remove(`${attempt}:${asset.mediaIdentity || asset.url}`);
  }
}

async function identityCheck(cards, configuredSettings = null, signal) {
  const settings = configuredSettings || await loadSettings();
  const result = await apiJson(`${settings.endpoint}/api/captures/identity-check`, { method: "POST", signal,
    body: JSON.stringify({ items: cards.map((card) => ({ externalId: card.externalId, url: card.canonicalUrl || card.url })) }) }, settings.token);
  if (!Array.isArray(result.items)) throw syncError('CAPTURE_PROTOCOL_ERROR', 'CMS 身份检查响应不兼容。', false);
  return result.items;
}

async function assertFavoritesSyncApi(settings = null) {
  settings ||= await loadSettings();
  try {
    let url;
    try { url = new URL(settings.endpoint); } catch { throw syncError('CAPTURE_ENDPOINT_INVALID', 'CMS 地址无效。', false); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw syncError('CAPTURE_ENDPOINT_INVALID', 'CMS 地址必须为 HTTP(S)，不能包含凭证。', false);
    if (!settings.token && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw syncError('CAPTURE_TOKEN_MISSING', '尚未配置采集令牌。', false);
    }
    if (chrome.permissions && !await chrome.permissions.contains({ origins: [`${url.origin}/*`] })) throw syncError('CAPTURE_HOST_PERMISSION', '扩展没有该 CMS 地址的访问权限。', false);
    await identityCheck([], settings);
    await chrome.storage.local.set({ [CONNECTION_ISSUE_KEY]: null });
  } catch (error) {
    // Persist only the failure code, never credentials or raw server responses.
    await chrome.storage.local.set({ [CONNECTION_ISSUE_KEY]: { code: String(error.code || 'NETWORK_ERROR'), timestamp: new Date().toISOString() } });
    throw error;
  }
}

async function apiJson(url, options, token) {
  const startedAt = Date.now();
  const observed = await loadState().catch(() => null);
  const route = new URL(url).pathname.split('/').slice(0, 3).join('/');
  void trace(observed, 'api-start', route, null, { method: options.method, deadlineMs: options.timeoutMs || ENGINE_REQUEST_TIMEOUT_MS }).catch(() => {});
  let response;
  try {
    response = await fetchBody(url, { method: options.method, signal: options.signal, headers: {
      ...(options.raw ? { "content-type": "application/octet-stream" } : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.uploadToken ? { 'x-upload-token': options.uploadToken } : {}),
    }, body: options.body }, { timeoutMs: options.timeoutMs || ENGINE_REQUEST_TIMEOUT_MS });
  } catch (cause) {
    void trace(observed, 'api-failed', route, null, { code: cause?.code || 'NETWORK_ERROR', elapsedMs: Date.now() - startedAt }).catch(() => {});
    if (["REQUEST_CANCELLED", "RESPONSE_STALLED", "RESPONSE_TOO_LARGE"].includes(cause?.code)) throw cause;
    const timedOut = cause?.name === "AbortError" || cause?.code === "REQUEST_TIMEOUT";
    throw Object.assign(new Error(timedOut ? "The SoloToChina Engine request timed out." : "The SoloToChina Engine is unavailable."), {
      code: timedOut ? "CAPTURE_REQUEST_TIMEOUT" : "CAPTURE_SERVER_UNAVAILABLE", retryable: true, cause,
    });
  }
  void trace(observed, 'api-response', route, null, { httpStatus: response.status, elapsedMs: Date.now() - startedAt }).catch(() => {});
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(response.bytes)); }
  catch { throw syncError("CAPTURE_PROTOCOL_ERROR", "CMS 返回了无效 JSON。", false); }
  if (!response.ok) {
    const details = classifyCaptureApiError(response.status, payload);
    if (/^MEDIA_(?:UPLOAD|CHUNK|HASH|TYPE|SIZE|PATH|FILE)_/.test(payload?.code || '')) details.code = payload.code;
    details.backpressure = response.status === 429 || response.status === 503;
    const retryAfter = retryAfterMs(response.headers.get("retry-after"));
    if (retryAfter > 0) details.retryAfterMs = retryAfter;
    throw Object.assign(new Error(details.message), details);
  }
  return payload;
}

async function saveCurrentNote() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !(/\/(?:explore|discovery\/item)\//.test(tab.url || "") || /\/board\/[A-Za-z0-9]+\/[A-Za-z0-9]+/.test(tab.url || ""))) throw syncError("INVALID_NOTE", "Open a Xiaohongshu note detail page first.", false);
  await injectExtractor(tab.id);
  const extracted = await execute(tab.id, (options) => globalThis.SoloToChinaXhs.prepareAndExtract(options), { acquisitionOrigin: "xhs_manual_extension" });
  if (!extracted?.ok) throw Object.assign(new Error(extracted?.error?.message || "Could not read this note."), extracted?.error || {});
  await submitCapture({ ...extracted.capture, completeness: { ...extracted.capture.completeness,
    images: { ...extracted.capture.completeness?.images, complete: false }, overall: 'partial_retryable' } });
  const persisted = await persistCaptureMedia(extracted.capture);
  const result = await submitCapture(persisted.capture);
  if (!result.mediaDurabilityComplete) throw syncError("MEDIA_ORIGINAL_NOT_STORED", "笔记正文已保存，但仍有媒体原件未持久化；请保持当前页面可访问后重试。", true);
  return { ok: true, capture: { title: extracted.capture.title }, result };
}

async function persistCaptureMedia(capture, onProgress = async () => {}, onlyMediaIdentities = null, signal) {
  const failures = [];
  const discoveredMedia = normalizeCaptureMedia(capture);
  const media = onlyMediaIdentities instanceof Set
    ? discoveredMedia.filter((asset) => onlyMediaIdentities.has(asset.mediaIdentity || asset.url)) : discoveredMedia;
  const metrics = { mediaCount: media.length, discoveredMediaCount: discoveredMedia.length, mediaBytes: 0, mediaDownloadMs: 0, mediaUploadMs: 0 };
  const attempt = await hashBytes(new TextEncoder().encode(JSON.stringify([capture.url, capture.text, capture.html])));
  const sourcePool = new AsyncSemaphore(4);
  const results = await Promise.all(media.map((asset) => sourcePool.run(() => persistMediaAsset(asset, onProgress, signal, `${attempt}:${asset.mediaIdentity || asset.url}`), 1, signal)));
  if (signal?.aborted) throw syncError("REQUEST_CANCELLED", "采集已取消。", false);
  for (const [index, result] of results.entries()) {
    const asset = media[index];
    metrics.mediaBytes += Number(result.metrics?.bytes || 0);
    metrics.mediaDownloadMs += Number(result.metrics?.downloadMs || 0);
    metrics.mediaUploadMs += Number(result.metrics?.uploadMs || 0);
    if (result.error) {
      asset.persistenceError = result.error;
      failures.push({ mediaIdentity: asset.mediaIdentity || asset.url, kind: asset.kind || "image", error: result.error });
      metrics.rateLimited ||= result.error.code === "MEDIA_HTTP_429" || result.error.code === "CAPTURE_RATE_LIMITED";
      metrics.cmsBackpressure ||= Boolean(result.error.backpressure) || result.error.code === "CAPTURE_SERVER_UNAVAILABLE";
      metrics.retryAfterMs = Math.max(Number(metrics.retryAfterMs || 0), Number(result.error.retryAfterMs || 0));
    }
  }
  capture.mediaPersistenceFailures = failures;
  return { capture, metrics };
}

async function persistMediaAsset(asset, onProgress, signal, journalKey) {
  const metrics = { bytes: 0, downloadMs: 0, uploadMs: 0 };
  try {
    return await mediaRequests.run(async () => {
      const downloadStarted = Date.now();
      signal?.throwIfAborted();
      // Reserve the full bounded buffering budget, including the joined copy.
      const maxBytes = Math.min(asset.kind === "video" ? 32 : 20, Math.max(1, Math.floor(mediaMemory.limit / 4))) * 1024 * 1024;
      const releaseMemory = await mediaMemory.acquire(Math.ceil(maxBytes * 2 / (1024 * 1024)), signal);
      try {
      const staged = await mediaJournal.get(journalKey);
      const response = staged?.bytes ? { ok: true, bytes: staged.bytes, headers: new Headers({ 'content-type': staged.mimeType }) }
        : await fetchBody(asset.url, { signal }, { timeoutMs: asset.kind === "video" ? 180_000 : MEDIA_REQUEST_TIMEOUT_MS,
          idleTimeoutMs: 15_000, maxBytes });
      if (!response.ok) {
        const failure = syncError(`MEDIA_HTTP_${response.status}`, `Media download returned HTTP ${response.status}.`, response.status >= 500 || response.status === 429);
        failure.backpressure = response.status === 429 || response.status === 503;
        const retryAfter = retryAfterMs(response.headers.get("retry-after"));
        if (retryAfter > 0) failure.retryAfterMs = retryAfter;
        throw failure;
      }
      const pipeline = async () => {
        const bytes = response.bytes;
        metrics.downloadMs = Date.now() - downloadStarted;
        metrics.bytes = bytes.byteLength;
        if (!bytes.byteLength) throw syncError("MEDIA_EMPTY", "Media download returned no bytes.", true);
        asset.originalSha256 = await hashBytes(bytes);
        asset.mimeType = detectMediaMime(bytes.subarray(0, 32), asset.kind, response.headers.get("content-type"));
        if (!asset.mimeType) throw syncError("MEDIA_TYPE_UNSUPPORTED", "Media response is not a supported image or video type.", false);
        await mediaJournal.put(journalKey, { ...staged, bytes, mimeType: asset.mimeType, sha256: asset.originalSha256 });
        const uploadStarted = Date.now();
        const stored = await mediaUploads.run(() => uploadMediaOriginal(asset, bytes, onProgress, signal, journalKey), 1, signal);
        metrics.uploadMs = Date.now() - uploadStarted;
        asset.originalStorageRef = stored.storageRef;
        await onProgress();
        if (asset.kind === "video") return;
        if (bytes.byteLength <= DIRECT_DERIVATIVE_BYTES) {
          delete asset.aiDerivativeDataUrl;
          delete asset.aiDerivativeSha256;
          return;
        }
        const transform = {converterVersion:'browser-webp-1',maxDimension:2048,maxBytes:DIRECT_DERIVATIVE_BYTES,
          passes:4,initialQuality:.84,qualityStep:.08,minimumQuality:.55,scaleStep:.72};
        const derivativeKey = derivativeCache.key(asset.originalSha256,transform);
        const cached = await derivativeCache.get(derivativeKey);
        if (cached?.bytes?.length && cached.bytes.length <= DIRECT_DERIVATIVE_BYTES && await hashBytes(cached.bytes) === cached.sha256) {
          asset.aiDerivativeDataUrl = `data:image/webp;base64,${bytesToBase64(cached.bytes)}`;
          asset.aiDerivativeSha256 = cached.sha256;
          asset.provenance = {...asset.provenance,derivative:{originalSha256:asset.originalSha256,...transform}};
          return;
        }
        const blob = new Blob([bytes], { type: asset.mimeType });
        const bitmap = await createImageBitmap(blob);
        let scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
        let derivative;
        try {
          for (let attempt = 0; attempt < 4; attempt += 1) {
            const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
            canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            derivative = await canvas.convertToBlob({ type: "image/webp", quality: Math.max(0.55, 0.84 - attempt * 0.08) });
            if (derivative.size <= DIRECT_DERIVATIVE_BYTES) break;
            scale *= 0.72;
          }
        } finally { bitmap.close(); }
        if (derivative?.size <= DIRECT_DERIVATIVE_BYTES) {
          const derivativeBytes = new Uint8Array(await derivative.arrayBuffer());
          asset.aiDerivativeDataUrl = `data:image/webp;base64,${bytesToBase64(derivativeBytes)}`;
          asset.aiDerivativeSha256 = await hashBytes(derivativeBytes);
          asset.provenance = {...asset.provenance,derivative:{originalSha256:asset.originalSha256,...transform}};
          await derivativeCache.save(derivativeKey,{bytes:derivativeBytes,sha256:asset.aiDerivativeSha256,originalSha256:asset.originalSha256,transform});
        }
      };
        if (response.bytes.length >= LARGE_MEDIA_THRESHOLD_BYTES) await largeMediaPipelines.run(pipeline, 1, signal);
        else await pipeline();
      } finally { releaseMemory(); }
      return { metrics };
    }, 1, signal);
  } catch (error) {
    return { metrics, error: serializeError(error) };
  }
}

async function uploadMediaOriginal(asset, bytes, onProgress = async () => {}, signal, journalKey) {
  const settings = await loadSettings();
  const staged = await mediaJournal.get(journalKey);
  let created = staged?.endpoint === settings.endpoint ? staged.upload : null;
  let status = null;
  if (created?.protocolVersion === 2) {
    try { status = await apiJson(`${settings.endpoint}/api/capture-media-uploads/${encodeURIComponent(created.uploadId)}`,
      { method: 'GET', signal, uploadToken: created.uploadToken }, settings.token); }
    catch (error) { if (!['MEDIA_UPLOAD_NOT_FOUND','MEDIA_UPLOAD_EXPIRED'].includes(error.code)) throw error; created = null; }
    if (status?.receipt) return status.receipt;
  }
  if (!created) created = await apiJson(`${settings.endpoint}/api/capture-media-uploads`, { method: "POST", body: JSON.stringify({
    protocolVersion: 2,
    kind: asset.kind === "video" ? "video" : "image", mimeType: asset.mimeType, size: bytes.byteLength, sha256: asset.originalSha256,
  }), signal }, settings.token);
  if (created.receipt) return created.receipt;
  await mediaJournal.put(journalKey, { ...staged, endpoint: settings.endpoint, upload: created });
  const received = new Set(status?.receivedChunks || created.receivedChunks || []);
  for (let offset = 0, index = 0; offset < bytes.length; offset += created.chunkBytes, index += 1) {
    if (received.has(index)) continue;
    await apiJson(`${settings.endpoint}/api/capture-media-uploads/${encodeURIComponent(created.uploadId)}/chunks/${index}`,
      { method: "PUT", body: bytes.slice(offset, Math.min(bytes.length, offset + created.chunkBytes)), raw: true, signal, uploadToken: created.uploadToken }, settings.token);
    await onProgress();
  }
  return apiJson(`${settings.endpoint}/api/capture-media-uploads/${encodeURIComponent(created.uploadId)}/complete`,
    { method: "POST", body: "{}", signal, uploadToken: created.uploadToken }, settings.token);
}

async function pauseSync(status, expected = null) {
  stopEpoch++;
  const session = await mutateState(null, (current) => {
    if (!current || (expected && !sameRun(current, expected))) return current;
    if (current.status === 'cancelled' || current.status.startsWith('completed')) return current;
    current.runRevision = Number(current.runRevision || 0) + 1;
    current.status = status;
    current.autoBlocked = true;
    if (status === 'paused_tab_closed') current.lastError = { code: 'CAPTURE_TAB_CLOSED', message: '采集页已关闭，任务已暂停，点击继续可恢复。', retryable: false };
    const reconciled = reconcileStrandedTasks(current, { force: true });
    current = reconciled.session;
    current.status = status;
    return current;
  });
  if (!session || session.status !== status) return { ok: false, error: syncError("NO_ACTIVE_SESSION", "No running sync session was found.", false) };
  revokeRequests(session);
  const scopes = await loadScopes();
  scopes[session.scopeKey] = { ...scopes[session.scopeKey], autoBlocked: true };
  await chrome.storage.local.set({ [SCOPES_KEY]: scopes });
  void reportDetached(session);
  return { ok: true, session };
}
async function resumeSync() {
  const current = await loadState();
  const epoch = stopEpoch;
  if (current?.status === 'running') return { ok: true, session: current };
  if (!current || current.status === "cancelled" || current.status === "completed") {
    return { ok: false, error: syncError("NO_RESUMABLE_SESSION", "No resumable sync session was found.", false) };
  }
  try {
    await assertFavoritesSyncApi();
  } catch (error) {
    await mutateState(null, (current) => {
      if (!current || current.status === "cancelled" || current.status === "completed") return current;
      current.lastError = serializeError(error);
      return current;
    });
    throw error;
  }
  if (epoch !== stopEpoch) throw stoppedError();
  const session = await mutateState(current.sessionId, (fresh) => {
    if (epoch !== stopEpoch || fresh.runRevision !== current.runRevision) return fresh;
    if (!fresh || fresh.status === "cancelled" || fresh.status === "completed") return fresh;
    const next = prepareSessionResume(fresh);
    next.runRevision = Number(fresh.runRevision || 0) + 1;
    next.controlSchema = 1; next.autoBlocked = false;
    next.resumePending = true;
    next.noProgressSince = null;
    return next;
  });
  if (!session || session.status !== "running") return { ok: false, error: syncError("NO_RESUMABLE_SESSION", "No resumable sync session was found.", false) };
  try {
  const identity = await browserIdentity;
  const validWorkers = new Set();
  if (session.browserIdentity === identity) {
    for (const record of Object.values(session.tabOwnership || {}).filter(record => record.role === 'worker')) {
      if (tabMatches(await chrome.tabs.get(record.tabId).catch(() => null), record)) validWorkers.add(record.tabId);
    }
  }
  let tab = await chrome.tabs.get(session.discoveryTabId).catch(() => null);
  if (session.browserIdentity !== identity || !identity || !tabMatches(tab, session.tabOwnership?.[session.discoveryTabId])) {
    tab = await createOwnedTab(session, session.scopeUrl, 'discovery');
  }
  await mutateState(session.sessionId, fresh => {
    if (!sameRun(fresh, session)) return fresh;
    fresh.browserIdentity = identity; fresh.discoveryTabId = tab.id;
    fresh.resumePending = false;
    // Foreign browser-session ids cannot be reused as worker ownership.
    fresh.workerTabs = (fresh.workerTabs || []).map(id => validWorkers.has(id) ? id : null);
    fresh.workerSlots = (fresh.workerSlots || []).map(slot => validWorkers.has(slot?.tabId) ? slot : null);
    return fresh;
  });
  const scopes = await loadScopes(); scopes[session.scopeKey] = { ...scopes[session.scopeKey], autoBlocked: false };
  await chrome.storage.local.set({ [SCOPES_KEY]: scopes });
  void drive();
  return { ok: true, session };
  } catch (error) {
    await pauseSync('paused_error', session);
    throw error;
  }
}
async function cancelSync() {
  stopEpoch++;
  const session = await mutateState(null, (current) => {
    if (!current) return current;
    current.status = "cancelled";
    current.runRevision = Number(current.runRevision || 0) + 1;
    current.autoBlocked = true;
    for (const task of current.queue) {
      if (!["captured", "duplicate", "failed"].includes(task.status)) task.status = "cancelled";
    }
    return current;
  });
  if (!session) return { ok: true };
  revokeRequests(session);
  const scopes = await loadScopes(); scopes[session.scopeKey] = { ...scopes[session.scopeKey], autoBlocked: true };
  await chrome.storage.local.set({ [SCOPES_KEY]: scopes });
  void Promise.allSettled([closeWorkerTabs(session), archiveSession(session), reportDetached(session)]);
  return { ok: true, session };
}
async function stopAfterQueue() { const session = await mutateState(null, (current) => { if (!current) return current; current.stopAfterQueue = true; current.phase = "acquisition"; return current; }); if (!session) return { ok: false }; void drive(); return { ok: true, session }; }

async function completeSession(session) {
  const completingId = session.sessionId;
  session = await mutateState(session.sessionId, current => sameRun(current, session) ? prepareSessionCompletion(current) : current);
  if (session?.sessionId !== completingId || !session?.status.startsWith('completed')) return;
  revokeRequests(session);
  const scopes = await loadScopes();
  scopes[session.scopeKey] = { scopeUrl: session.scopeUrl, lastSuccessfulSyncAt: session.completedAt,
    checkpoint: { topIdentityKeys: session.currentTopIdentityKeys || [], lastSuccessfulSyncAt: session.completedAt }, summary: session.stats };
  // Commit the terminal state and checkpoint together before best-effort cleanup.
  // A slow tab close or telemetry request must never leave the popup in a
  // permanent running/completed limbo.
  await chrome.storage.local.set({ [SCOPES_KEY]: scopes });
  void reportDetached(session);
  await Promise.allSettled([
    archiveSession(session),
    closeWorkerTabs(session),
  ]);
}

async function archiveSession(session) { const history = (await chrome.storage.local.get({ [HISTORY_KEY]: [] }))[HISTORY_KEY]; await chrome.storage.local.set({ [HISTORY_KEY]: [summary(session), ...history.filter((item) => item.sessionId !== session.sessionId)].slice(0, 20) }); }
async function ensureAlarms() { await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 }); }
async function watchdog() {
  await trace(await loadState(), 'watchdog', 'scheduler', null);
  void retryReport().catch(() => {});
  const session = await mutateState(null, (current) => {
    if (!current || current.status !== "running") return current;
    // Recover only expired task leases. A quiet extraction is not necessarily
    // stuck: forcing every in-flight task back into the queue duplicated notes
    // and opened fresh XHS tabs while the original worker was still running.
    const reconciled = reconcileStrandedTasks(current);
    return reconciled.session;
  });
  if (session?.status === "running") {
    const activeLeases = new Set(session.queue.filter(task => task.leaseId).map(task => task.leaseId));
    for (const [lease, request] of taskRequests) if (request.sessionId === session.sessionId && !activeLeases.has(lease)) request.controller.abort();
    ensureWorkerPool(session);
    void drive();
  }
}
async function handleDriverError(caught, expected = null) {
  if (caught?.code === 'RUN_REVOKED') return;
  const error = serializeError(caught);
  const session = await mutateState(null, (current) => {
    if (!current || current.status !== "running") return current;
    if (expected && !sameRun(current, expected)) return current;
    current.driverAttempts = Number(current.driverAttempts || 0) + 1;
    const disposition = classifyTaskDisposition(error, current.driverAttempts, current.config.maxRetries);
    if (disposition.action === "pause") current.status = disposition.status;
    else if (disposition.action === "fail") {
      // A collection selector or repeatedly failing discovery cannot be
      // retried forever; leave the session resumable with a visible error.
      current.status = "paused_error";
      current.driveRetryAt = null;
    } else {
      current.driveRetryAt = new Date(Date.now() + Math.max(error.retryAfterMs || 0, retryDelayMs(current.driverAttempts, {
        baseMs: current.config.retryBaseMs, maxMs: current.config.retryMaxMs,
      }))).toISOString();
    }
    current.lastError = error;
    return current;
  });
  if (session && session.status !== 'running') revokeRequests(session);
  if (session && ["paused_login_required", "paused_verification_required", "paused_capture_unauthorized"].includes(session.status)) {
    await reportSession(session).catch(() => null);
  }
}
function configureMediaResources(settings) {
  const config = normalizeSettings(settings);
  mediaRequests.setLimit(config.mediaConcurrency);
  mediaUploads.setLimit(config.mediaUploadConcurrency);
  mediaMemory.setLimit(Math.max(32, Math.floor(config.mediaMemoryBudgetBytes / (1024 * 1024))));
}
function configureSessionMediaResources(session) {
  const config = normalizeSettings(session?.config || {});
  mediaRequests.setLimit(Math.max(1, Math.min(config.mediaConcurrency, Number(session?.mediaConcurrency) || config.mediaConcurrency)));
  mediaUploads.setLimit(config.mediaUploadConcurrency);
  mediaMemory.setLimit(Math.max(32, Math.floor(config.mediaMemoryBudgetBytes / (1024 * 1024))));
}
function browserMemoryPressure() {
  const memory = globalThis.performance?.memory;
  return Boolean(memory?.jsHeapSizeLimit && memory.usedJSHeapSize / memory.jsHeapSizeLimit >= 0.85);
}
async function restoreAfterRestart() {
  if (restoreFlight) return restoreFlight;
  restoreFlight = restoreRunningSession().finally(() => { restoreFlight = null; });
  return restoreFlight;
}
async function restoreRunningSession() {
  const session = await loadState();
  if (!session || session.status !== 'running') return;
  if (session.resumePending) { await pauseSync('paused_recovered', session); return; }
  const identity = await browserIdentity;
  const tab = await chrome.tabs.get(session.discoveryTabId).catch(() => null);
  if (!identity || session.browserIdentity !== identity || !tabMatches(tab, session.tabOwnership?.[session.discoveryTabId])) {
    await pauseSync('paused_tab_closed', session); return;
  }
  for (const record of Object.values(session.tabOwnership || {}).filter(item => item.role === 'worker')) {
    if (!tabMatches(await chrome.tabs.get(record.tabId).catch(() => null), record)) { await pauseSync('paused_tab_closed', session); return; }
  }
  if (session.status === "running" && session.phase === "completed") {
    await completeSession(session);
    return;
  }
  const recovered = recoverSession(session);
  configureSessionMediaResources(recovered);
  await mutateState(session.sessionId, current => sameRun(current, session) ? recovered : current);
  if (recovered.status === "running") void drive();
}
async function startAutomaticSync() { const settings = await loadSettings(); if (settings.autoSync === "off") return; const history = (await chrome.storage.local.get({ [HISTORY_KEY]: [] }))[HISTORY_KEY]; const last = history.find((item) => item.scopeKey === settings.lastScopeKey); if (last && Date.now() - Date.parse(last.completedAt || last.updatedAt) < settings.autoMinIntervalHours * 3_600_000) return; await startSync("incremental", true); }
async function refreshAutoAlarm() { const settings = await loadSettings(); await chrome.alarms.clear(AUTO_ALARM); if (settings.autoSync === "daily") await chrome.alarms.create(AUTO_ALARM, { periodInMinutes: 24 * 60 }); }

async function workerTab(sessionId, slot, workerId, url, expected) {
  const session = await assertRun(expected);
  let id = session?.workerSlots?.[slot]?.tabId || session?.workerTabs?.[slot];
  if (id) {
    const existing = await chrome.tabs.get(id).catch(() => null);
    if (!tabMatches(existing, session.tabOwnership?.[id])) { await pauseSync('paused_tab_closed', session); throw stoppedError(); }
    await assertRun(session);
    await trace(session, 'update', 'worker', id);
    await assertRun(session);
    await mutateState(sessionId, fresh => { if (sameRun(fresh, session)) fresh.tabOwnership[id].url = url; return fresh; });
    await assertRun(session);
    const tab = await chrome.tabs.update(id, { url, active: false });
    await assertRun(session);
    await mutateState(sessionId, fresh => { if (sameRun(fresh, session)) fresh.tabOwnership[id].url = url; return fresh; });
    return tab;
  }
    const tab = await createOwnedTab(session, url, 'worker');
  await mutateState(sessionId, (fresh) => {
    if (!sameRun(fresh, session)) return fresh;
    fresh.workerSlots ||= [];
    fresh.workerSlots[slot] = { workerId, tabId: tab.id, updatedAt: new Date().toISOString() };
    fresh.workerTabs ||= [];
    fresh.workerTabs[slot] = tab.id;
    return fresh;
  });
  return tab;
}
async function createOwnedTab(session, url, role) {
  await assertRun(session);
  await trace(session, 'create-dispatched', role, null);
  await assertRun(session);
  const tab = await chrome.tabs.create({ url, active: false });
  const record = { tabId: tab.id, windowId: tab.windowId, url, role, owned: true };
  const fresh = await mutateState(session.sessionId, current => {
    if (sameRun(current, session)) { current.tabOwnership ||= {}; current.tabOwnership[tab.id] = record; }
    return current;
  });
  if (!sameRun(fresh, session)) {
    await trace(session, 'late-create', role, tab.id);
    await removeOwnedTab(session, record); throw stoppedError();
  }
  return tab;
}
async function ensureDiscoveryTab(session) {
  await assertRun(session);
  const tab = await chrome.tabs.get(session.discoveryTabId).catch(() => null);
  if (!tabMatches(tab, session.tabOwnership?.[session.discoveryTabId])) {
    await pauseSync('paused_tab_closed', session); throw stoppedError();
  }
  await assertRun(session); return tab;
}
async function removeOwnedTab(session, record) {
  if (!record?.owned) return;
  const tab = await chrome.tabs.get(record.tabId).catch(() => null);
  if (!tabMatches(tab, record)) return;
  closeIntents.add(tab.id);
  await trace(session, 'remove', record.role, tab.id);
  await chrome.tabs.remove(tab.id).catch(() => { closeIntents.delete(tab.id); });
}
async function closeWorkerTabs(session) {
  for (const record of Object.values(session.tabOwnership || {})) await removeOwnedTab(session, record);
}
async function openXiaohongshu() { const session = await loadState(); const url = session?.scopeUrl || "https://www.xiaohongshu.com/"; const tab = await chrome.tabs.create({ url, active: true }); return { ok: true, tabId: tab.id }; }
async function injectExtractor(tabId, signal) {
  signal?.throwIfAborted();
  void trace(await loadState(), 'stage-start', 'injection', tabId, { deadlineMs: DEADLINES.injection }).catch(() => {});
  await bounded(() => chrome.scripting.executeScript({ target: { tabId }, files: ["capture-utils.js", "page-extractor.js"] }), { signal, timeoutMs: DEADLINES.injection, code: 'INJECTION_TIMEOUT' });
}
async function execute(tabId, func, args, signal, timeoutMs = DEADLINES.extraction) {
  signal?.throwIfAborted();
  const observed = await loadState();
  const startedAt = Date.now();
  void trace(observed, 'stage-start', 'dom', tabId, { deadlineMs: timeoutMs }).catch(() => {});
  const script = { target: { tabId }, func, args: args === undefined ? [] : [args] };
  try {
    const [{ result }] = await bounded(() => chrome.scripting.executeScript(script), { signal, timeoutMs, code: 'DOM_TIMEOUT' });
    void trace(observed, 'stage-complete', 'dom', tabId, { elapsedMs: Date.now() - startedAt }).catch(() => {});
    return result;
  } catch (error) {
    void trace(observed, 'stage-failed', 'dom', tabId, { code: error.code || 'SCRIPT_ERROR', elapsedMs: Date.now() - startedAt }).catch(() => {});
    if (signal?.aborted || error.code === 'DOM_TIMEOUT') {
      void chrome.scripting.executeScript({ target: { tabId }, func: () => globalThis.SoloToChinaXhs?.cancel?.() }).catch(() => {});
      throw error;
    }
    // Xiaohongshu can replace its main frame after tabs.status becomes complete.
    // One bounded reinjection avoids consuming a whole task attempt for that
    // navigation race; persistent failures still use the normal retry budget.
    if (!/Frame with ID \d+ was removed|frame was removed/i.test(String(error?.message || ""))) throw error;
    await waitForTab(tabId, 30_000, signal);
    await injectExtractor(tabId, signal);
    try {
      const [{ result }] = await bounded(() => chrome.scripting.executeScript(script), { signal, timeoutMs, code: 'DOM_TIMEOUT' });
      return result;
    } catch (retryError) {
      if (/Frame with ID \d+ was removed|frame was removed/i.test(String(retryError?.message || ""))) {
        throw syncError("NAVIGATION_INTERRUPTED", "Xiaohongshu replaced the note frame during capture; the worker will reopen it.", true);
      }
      throw retryError;
    }
  }
}
async function waitForTab(tabId, timeoutMs, signal) {
  signal?.throwIfAborted();
  let current;
  try { current = await chrome.tabs.get(tabId); }
  catch { throw syncError("WORKER_TAB_CLOSED", "采集页已关闭，任务已暂停。", false); }
  if (current.status === "complete") return;
  await new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); chrome.tabs.onUpdated.removeListener(updated); chrome.tabs.onRemoved.removeListener(removed); };
    const abort = () => { cleanup(); reject(signal.reason || stoppedError()); };
    const timer = setTimeout(() => { cleanup(); reject(syncError("TAB_LOAD_TIMEOUT", "The note detail page did not finish loading.", true)); }, timeoutMs);
    const updated = (id, info) => { if (id === tabId && info.status === "complete") { cleanup(); resolve(); } };
    const removed = (id) => { if (id === tabId) { cleanup(); reject(syncError("WORKER_TAB_CLOSED", "采集页已关闭，任务已暂停。", false)); } };
    chrome.tabs.onUpdated.addListener(updated);
    chrome.tabs.onRemoved.addListener(removed);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function loadSettings() { const stored = await chrome.storage.local.get({ endpoint: DEFAULT_ENDPOINT, token: DEFAULT_CAPTURE_TOKEN, [SETTINGS_KEY]: {} }); return settingsWithConnection({ endpoint: stored.endpoint, token: stored.token, ...stored[SETTINGS_KEY] }); }
async function settingsWithConnection(value) { const endpoint = String(value.endpoint || DEFAULT_ENDPOINT).trim().replace(/\/$/, ""); return { ...normalizeSettings(value), endpoint, token: String(value.token || DEFAULT_CAPTURE_TOKEN).trim(), autoSync: ["off", "startup", "daily"].includes(value.autoSync) ? value.autoSync : "off", lastScopeUrl: value.lastScopeUrl || "", lastScopeKey: value.lastScopeKey || "" }; }
async function loadState() { return (await chrome.storage.local.get({ [STATE_KEY]: null }))[STATE_KEY]; }
async function saveState(session) { session.updatedAt = new Date().toISOString(); await chrome.storage.local.set({ [STATE_KEY]: session }); }
async function mutateState(sessionId, mutator) {
  const operation = stateMutation.then(async () => {
    const current = await loadState();
    if (sessionId && current?.sessionId !== sessionId) return current;
    const next = await mutator(current);
    if (next) await saveState(next);
    return next;
  });
  stateMutation = operation.catch(() => null);
  return operation;
}
async function updateTask(sessionId, taskId, status, details = {}, leaseId = null) {
  return mutateState(sessionId, (current) => {
    const task = current?.queue.find((item) => item.taskId === taskId);
    if (!current || current.status !== "running" || task?.status === "cancelled" || (leaseId && task?.leaseId !== leaseId)) return current;
    const next = transitionTask(current, taskId, status, details);
    next.stage = status; next.stageStartedAt = new Date().toISOString();
    next.lastBusinessProgress = status;
    return next;
  });
}
async function persistProgress(candidate) {
  return mutateState(candidate?.sessionId, (current) => {
    if (!sameRun(current, candidate)) return current;
    if (current.stopAfterQueue) {
      candidate.stopAfterQueue = true;
      candidate.phase = "acquisition";
    }
    if (candidate.lastProgressAt !== current.lastProgressAt) { candidate.driverAttempts = 0; candidate.driveRetryAt = null; }
    candidate.tabOwnership = current.tabOwnership;
    return candidate;
  });
}
function scheduleDrive(session) {
  if (driveTimer) clearTimeout(driveTimer);
  const retryTimes = session.phase === "acquisition"
    ? session.queue.filter((task) => task.status === "retry_wait").map((task) => Date.parse(task.retryAt || 0)).filter(Number.isFinite)
    : [];
  const requestedAt = Date.parse(session.driveRetryAt || 0);
  if (Number.isFinite(requestedAt)) retryTimes.push(requestedAt);
  const hasQueued = session.queue.some((task) => task.status === "queued");
  const delay = retryTimes.length && !hasQueued
    ? Math.max(250, Math.min(60_000, Math.min(...retryTimes) - Date.now()))
    : session.activeTasks?.length ? 1_000 : 100;
  driveTimer = setTimeout(() => { driveTimer = null; void drive(); }, delay);
}
async function loadScopes() { return (await chrome.storage.local.get({ [SCOPES_KEY]: {} }))[SCOPES_KEY]; }
async function publicState() {
  const settings = await loadSettings();
  const session = await loadState();
  const history = (await chrome.storage.local.get({ [HISTORY_KEY]: [] }))[HISTORY_KEY];
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const currentScope = scopeFromUrl(activeTab?.url || "");
  const currentPageKind = isFavoritesAlbumOverviewUrl(activeTab?.url || "") ? "album_overview" : currentScope ? "collection" : "other";
  const connectionIssue = (await chrome.storage.local.get({ [CONNECTION_ISSUE_KEY]: null }))[CONNECTION_ISSUE_KEY];
  return { session, currentScope, currentPageKind, settings: publicSettings(settings), history, connectionIssue };
}
async function reportSession(session) {
  const settings = await loadSettings();
  return apiJson(`${settings.endpoint}/api/favorites-sync-runs`, { method: "POST", body: JSON.stringify({
    sessionId: session.sessionId, scopeKey: session.scopeKey, scopeUrl: session.scopeUrl, scopeLabel: session.scopeLabel,
    mode: session.mode, status: session.status, stats: session.stats, startedAt: session.startedAt,
    completedAt: session.completedAt || null, lastError: session.lastError || null,
    extensionVersion: chrome.runtime.getManifest().version,
  }) }, settings.token);
}
async function reportDetached(session, attempts = 0) {
  const endpoint = (await loadSettings()).endpoint;
  try { await reportSession(session); }
  catch (error) {
    await trace(session, 'report-failed', 'cms', null, { code: error.code, reportAttempts: attempts + 1 });
    if (attempts < 2) await chrome.storage.local.set({ favoritesReportOutbox: {
      session: { ...summary(session), scopeUrl: session.scopeUrl }, endpoint,
      attempts: attempts + 1, nextAt: Date.now() + 60_000,
    } });
  }
}
let reporting = false;
async function retryReport() {
  if (reporting) return;
  reporting = true;
  try {
    const { favoritesReportOutbox: pending } = await chrome.storage.local.get({ favoritesReportOutbox: null });
    if (!pending || pending.nextAt > Date.now()) return;
    await chrome.storage.local.set({ favoritesReportOutbox: null });
    if ((await loadSettings()).endpoint !== pending.endpoint) return;
    const current = await loadState();
    if (current?.sessionId !== pending.session.sessionId || current.status !== pending.session.status) return;
    await reportDetached(pending.session, pending.attempts);
  } finally { reporting = false; }
}
function publicSettings(settings) { const { token, ...safe } = settings; return { ...safe, tokenConfigured: Boolean(token) }; }
function summary(session) { return { sessionId: session.sessionId, scopeKey: session.scopeKey, scopeLabel: session.scopeLabel, mode: session.mode, status: session.status, startedAt: session.startedAt, completedAt: session.completedAt || null, updatedAt: session.updatedAt, stats: session.stats, lastError: session.lastError }; }
function serializeError(value) { return { code: String(value?.code || "NETWORK_ERROR"), message: String(value?.message || value || "Unknown error"), retryable: value?.retryable !== false, backpressure: Boolean(value?.backpressure), retryAfterMs: Number(value?.retryAfterMs || 0), timestamp: new Date().toISOString() }; }
function syncError(code, message, retryable) { return Object.assign(new Error(message), { code, retryable }); }
function retryAfterMs(value) {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1_000);
  const at = Date.parse(String(value || ""));
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}
async function hashBytes(bytes) { const digest = await crypto.subtle.digest("SHA-256", bytes); return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join(""); }
function bytesToBase64(bytes) { let output = ""; const block = 0x8000; for (let index = 0; index < bytes.length; index += block) output += String.fromCharCode(...bytes.subarray(index, index + block)); return btoa(output); }

export { handleMessage, restoreAfterRestart, watchdog, persistCaptureMedia, apiJson, execute, handleDriverError,
  createOwnedTab, ensureDiscoveryTab, closeWorkerTabs, persistProgress, waitForTab, startAutomaticSync, discoverWindow };
