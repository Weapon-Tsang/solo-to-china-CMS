import {
  applyIdentityBatch, applySettingsToSession, AsyncSemaphore, classifyCaptureApiError, classifyTaskDisposition, compactSessionState, createSession,
  hasUnresolvedFailures, initialConcurrency, isFavoritesAlbumOverviewUrl, leaseNextTask, normalizeSettings, reconcileStrandedTasks,
  recoverSession, retryDelayMs, scopeFromUrl, shouldStopDiscovery, transitionTask, updateSessionConcurrency,
  prepareSessionCompletion, prepareSessionResume,
} from "./sync-core.js";
import { normalizeCaptureMedia, detectMediaMime } from "./media-contract.js";
import { fetchBody } from "./transport.js";
import { mediaJournal } from './media-journal.js';
import { derivativeCache } from './derivative-cache.js';

const DEFAULT_ENDPOINT = "http://127.0.0.1:4310";
const DEFAULT_CAPTURE_TOKEN = "";
const STATE_KEY = "favoritesSyncState";
const SETTINGS_KEY = "favoritesSyncSettings";
const SCOPES_KEY = "favoritesSyncScopes";
const HISTORY_KEY = "favoritesSyncHistory";
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

chrome.runtime.onInstalled.addListener(() => {
  void ensureAlarms();
  void refreshAutoAlarm();
});
chrome.runtime.onStartup.addListener(() => { void restoreAfterRestart(); void refreshAutoAlarm(); });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) void watchdog();
  if (alarm.name === AUTO_ALARM) void startAutomaticSync();
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
    case "START_SYNC": return startSync(["incremental","repair","full"].includes(message.mode) ? message.mode : "incremental");
    case "PAUSE_SYNC": return pauseSync("paused_by_user");
    case "RESUME_SYNC": return resumeSync();
    case "CANCEL_SYNC": return cancelSync();
    case "STOP_AFTER_QUEUE": return stopAfterQueue();
    case "OPEN_XHS": return openXiaohongshu();
    case "SAVE_CURRENT": return saveCurrentNote();
    default: return { ok: false, error: { code: "UNKNOWN_COMMAND", message: "Unsupported extension command." } };
  }
}

async function startSync(mode, automatic = false) {
  const state = await loadState();
  if (state && !["completed", "completed_with_failures", "cancelled"].includes(state.status)) return { ok: false, error: syncError("SESSION_ALREADY_RUNNING", "A Favorites Sync session is already active.", false) };
  const settings = await loadSettings();
  let tab;
  if (automatic) {
    if (!settings.lastScopeUrl) return { ok: false, error: syncError("NO_AUTO_SCOPE", "Open a Favorites collection and run one manual sync first.", false) };
    tab = await chrome.tabs.create({ url: settings.lastScopeUrl, active: false });
  } else {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  const scope = scopeFromUrl(tab?.url || "");
  if (!tab?.id || !scope || /\/explore\//.test(new URL(scope.url).pathname)) {
    return { ok: false, error: syncError("INVALID_FAVORITES_SCOPE", "Open the target Xiaohongshu favorites collection before starting sync.", false) };
  }
  await assertFavoritesSyncApi(settings);
  configureMediaResources(settings);
  const scopes = await loadScopes();
  const session = createSession({ scope, mode, settings, checkpoint: scopes[scope.key]?.checkpoint || null });
  session.discoveryTabId = tab.id;
  session.automatic = automatic;
  session.workerTabs = [];
  session.stopAfterQueue = false;
  await saveState(session);
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...settings, lastScopeUrl: scope.url, lastScopeKey: scope.key } });
  void drive();
  return { ok: true, session };
}

async function drive() {
  if (driving) return;
  driving = true;
  try {
    let session = await loadState();
    if (!session || session.status !== "running") return;
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
    await handleDriverError(error);
  } finally {
    driving = false;
    const current = await loadState().catch(() => null);
    if (current?.status === "running") scheduleDrive(current);
  }
}

async function discoverWindow(session) {
  const tab = await ensureDiscoveryTab(session);
  await injectExtractor(tab.id);
  const offset = Number(session.cursor?.domOffset || 0);
  let scan = await execute(tab.id, (options) => globalThis.SoloToChinaXhs.scanFavorites(options), {
    limit: session.config.discoveryBatchSize, offset: 0, seenIdentities: session.seenIdentityKeys,
  });
  // Virtualized collections remove older cards from the DOM. Reset the DOM offset
  // and rely on stable identity de-duplication when the current window is exhausted.
  if (offset && scan?.cards?.length === 0 && !scan.collectionEnd) {
    session.cursor.domOffset = 0;
    scan = await execute(tab.id, (options) => globalThis.SoloToChinaXhs.scanFavorites(options), {
      limit: session.config.discoveryBatchSize, offset: 0, seenIdentities: session.seenIdentityKeys,
    });
  }
  if (scan?.blocking) throw Object.assign(new Error(scan.blocking.message), scan.blocking);
  if (!scan?.cards) throw syncError("SELECTOR_MISMATCH", "No favorites cards could be read from the current collection.", true);
  const unseenCards = scan.cards.filter((card) => !session.seenIdentityKeys.includes(`xiaohongshu:${card.externalId}`));
  const identityRows = [];
  for (let index = 0; index < unseenCards.length; index += session.config.identityBatchSize) {
    identityRows.push(...await identityCheck(unseenCards.slice(index, index + session.config.identityBatchSize)));
  }
  session = applyIdentityBatch(session, scan.cards, identityRows, { collectionEnd: scan.collectionEnd, scrollY: scan.scrollY });
  session.cursor.domOffset = Number(session.cursor.domOffset || offset) + scan.cards.length;
  session = await persistProgress(session);
  if (session.status !== "running") return session;
  const shouldStop = shouldStopDiscovery(session);
  const backlog = session.queue.filter((task) => ["queued", "retry_wait"].includes(task.status)).length;
  if (shouldStop || session.stopAfterQueue || backlog >= session.config.queueHighWatermark) {
    session.discoveryComplete = shouldStop || session.stopAfterQueue;
    session.phase = "acquisition";
    return session;
  }
  const scroll = await execute(tab.id, () => globalThis.SoloToChinaXhs.scrollFavoritesWindow());
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
  if (!session || session.status !== "running" || session.phase !== "acquisition") return;
  if (!session.queue.some(task => task.status === 'queued' || (task.status === 'retry_wait' && Date.parse(task.retryAt || 0) <= Date.now()))) return;
  const target = Math.max(1, Math.min(16, session.concurrency || initialConcurrency(session.config)));
  for (let slot = 0; slot < target; slot += 1) {
    const key = `${session.sessionId}:${slot}`;
    if (workerLoops.has(key)) continue;
    const workerId = session.workerSlots?.[slot]?.workerId || `note-worker-${slot}-${crypto.randomUUID()}`;
    const promise = runWorkerSlot(session.sessionId, slot, workerId)
      .catch(() => null)
      .finally(() => {
        workerLoops.delete(key);
        void drive();
      });
    workerLoops.set(key, promise);
  }
}

async function runWorkerSlot(sessionId, slot, workerId) {
  while (true) {
    let claimed = null;
    const state = await mutateState(sessionId, (current) => {
      if (!current || current.status !== "running" || current.phase !== "acquisition"
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
  taskRequests.set(leaseId, { sessionId, controller });
  const captureJournalKey = `capture:${sessionId}:${taskId}`;
  try {
    let extracted = (await mediaJournal.get(captureJournalKey))?.capture;
    let stageStarted;
    if (!extracted || extracted.completeness?.overall !== 'complete') {
    const tab = await workerTab(sessionId, slot, workerId, task.navigationUrl || task.canonicalUrl);
    session = await updateTask(sessionId, taskId, "loading", { tabId: tab.id }, leaseId);
    assertRunnable(session, taskId, leaseId);
    stageStarted = Date.now();
    await waitForTab(tab.id, session.config.detailLoadTimeoutMs);
    metric.noteLoadMs = Date.now() - stageStarted;
    await injectExtractor(tab.id);
    session = await updateTask(sessionId, taskId, "extracting", {}, leaseId);
    assertRunnable(session, taskId, leaseId);
    stageStarted = Date.now();
    const result = await execute(tab.id, (options) => globalThis.SoloToChinaXhs.prepareAndExtract(options), {
      acquisitionOrigin: "xhs_favorites_sync", syncScopeKey: session.scopeKey,
    });
    metric.extractionMs = Date.now() - stageStarted;
    if (!result?.ok) throw Object.assign(new Error(result?.error?.message || "Note extraction failed."), result?.error || {});
    extracted = result.capture;
    await mediaJournal.put(captureJournalKey, { capture: extracted, savedAt: new Date().toISOString() });
    }
    const onlyMediaIdentities = task.sourceId && Array.isArray(task.repairMediaIdentities)
      ? new Set(task.repairMediaIdentities) : null;
    await submitCapture({ ...extracted, completeness: { ...extracted.completeness,
      images: { ...extracted.completeness?.images, complete: false }, overall: 'partial_retryable' } }, controller.signal);
    const persisted = await persistCaptureMedia(extracted, async () => {
      try { await assertTaskLease(sessionId, taskId, leaseId); await heartbeatTask(sessionId, taskId, leaseId); }
      catch (error) { controller.abort(); throw error; }
    }, onlyMediaIdentities, controller.signal);
    const capture = persisted.capture;
    Object.assign(metric, persisted.metrics);
    metric.memoryPressure = browserMemoryPressure();
    session = await updateTask(sessionId, taskId, "submitting", {}, leaseId);
    assertRunnable(session, taskId, leaseId);
    stageStarted = Date.now();
    const response = await submitCapture(capture, controller.signal);
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
    await mediaJournal.remove(captureJournalKey);
    return response;
  } catch (caught) {
    metric.totalMs = Date.now() - metric.startedAt;
    await handleTaskError(sessionId, taskId, leaseId, caught, metric);
    return null;
  } finally { controller.abort(); taskRequests.delete(leaseId); }
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
    current.lastProgressAt = now;
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

async function identityCheck(cards, configuredSettings = null) {
  const settings = configuredSettings || await loadSettings();
  const result = await apiJson(`${settings.endpoint}/api/captures/identity-check`, { method: "POST",
    body: JSON.stringify({ items: cards.map((card) => ({ externalId: card.externalId, url: card.canonicalUrl || card.url })) }) }, settings.token);
  return result.items || [];
}

async function assertFavoritesSyncApi(settings = null) {
  await identityCheck([], settings);
}

async function apiJson(url, options, token) {
  let response;
  try {
    response = await fetchBody(url, { method: options.method, signal: options.signal, headers: {
      ...(options.raw ? { "content-type": "application/octet-stream" } : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.uploadToken ? { 'x-upload-token': options.uploadToken } : {}),
    }, body: options.body }, { timeoutMs: options.timeoutMs || ENGINE_REQUEST_TIMEOUT_MS });
  } catch (cause) {
    if (["REQUEST_CANCELLED", "RESPONSE_STALLED", "RESPONSE_TOO_LARGE"].includes(cause?.code)) throw cause;
    const timedOut = cause?.name === "AbortError" || cause?.code === "REQUEST_TIMEOUT";
    throw Object.assign(new Error(timedOut ? "The SoloToChina Engine request timed out." : "The SoloToChina Engine is unavailable."), {
      code: timedOut ? "CAPTURE_REQUEST_TIMEOUT" : "CAPTURE_SERVER_UNAVAILABLE", retryable: true, cause,
    });
  }
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

async function pauseSync(status) {
  const session = await mutateState(null, (current) => {
    if (!current || current.status !== "running") return current;
    current.status = status;
    const reconciled = reconcileStrandedTasks(current, { force: true });
    current = reconciled.session;
    current.status = status;
    return current;
  });
  if (!session || session.status !== status) return { ok: false, error: syncError("NO_ACTIVE_SESSION", "No running sync session was found.", false) };
  for (const request of taskRequests.values()) if (request.sessionId === session.sessionId) request.controller.abort();
  await reportSession(session).catch(() => null);
  return { ok: true, session };
}
async function resumeSync() {
  const current = await loadState();
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
  const session = await mutateState(null, (current) => {
    if (!current || current.status === "cancelled" || current.status === "completed") return current;
    return prepareSessionResume(current);
  });
  if (!session || session.status !== "running") return { ok: false, error: syncError("NO_RESUMABLE_SESSION", "No resumable sync session was found.", false) };
  void drive();
  return { ok: true, session };
}
async function cancelSync() {
  const session = await mutateState(null, (current) => {
    if (!current) return current;
    current.status = "cancelled";
    for (const task of current.queue) {
      if (!["captured", "duplicate", "failed"].includes(task.status)) task.status = "cancelled";
      delete task.navigationUrl;
    }
    return current;
  });
  if (!session) return { ok: true };
  for (const request of taskRequests.values()) if (request.sessionId === session.sessionId) request.controller.abort();
  await closeWorkerTabs(session); await archiveSession(session); await reportSession(session).catch(() => null);
  return { ok: true, session };
}
async function stopAfterQueue() { const session = await mutateState(null, (current) => { if (!current) return current; current.stopAfterQueue = true; current.phase = "acquisition"; return current; }); if (!session) return { ok: false }; void drive(); return { ok: true, session }; }

async function completeSession(session) {
  session = prepareSessionCompletion(session);
  const scopes = await loadScopes();
  scopes[session.scopeKey] = { scopeUrl: session.scopeUrl, lastSuccessfulSyncAt: session.completedAt,
    checkpoint: { topIdentityKeys: session.currentTopIdentityKeys || [], lastSuccessfulSyncAt: session.completedAt }, summary: session.stats };
  // Commit the terminal state and checkpoint together before best-effort cleanup.
  // A slow tab close or telemetry request must never leave the popup in a
  // permanent running/completed limbo.
  await chrome.storage.local.set({ [STATE_KEY]: session, [SCOPES_KEY]: scopes });
  await Promise.allSettled([
    archiveSession(session),
    closeWorkerTabs(session),
    reportSession(session),
  ]);
}

async function archiveSession(session) { const history = (await chrome.storage.local.get({ [HISTORY_KEY]: [] }))[HISTORY_KEY]; await chrome.storage.local.set({ [HISTORY_KEY]: [summary(session), ...history.filter((item) => item.sessionId !== session.sessionId)].slice(0, 20) }); }
async function ensureAlarms() { await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 }); }
async function watchdog() {
  const session = await mutateState(null, (current) => {
    if (!current || current.status !== "running") return current;
    const stalled = Date.now() - Date.parse(current.lastProgressAt || current.updatedAt || 0) >= current.config.watchdogStallMs;
    const reconciled = reconcileStrandedTasks(current, { force: stalled });
    return reconciled.session;
  });
  if (session?.status === "running") {
    const activeLeases = new Set(session.queue.filter(task => task.leaseId).map(task => task.leaseId));
    for (const [lease, request] of taskRequests) if (request.sessionId === session.sessionId && !activeLeases.has(lease)) request.controller.abort();
    ensureWorkerPool(session);
    void drive();
  }
}
async function handleDriverError(caught) {
  const error = serializeError(caught);
  const session = await mutateState(null, (current) => {
    if (!current || current.status !== "running") return current;
    const disposition = classifyTaskDisposition(error, current.driverAttempts || 0, current.config.maxRetries);
    if (disposition.action === "pause") current.status = disposition.status;
    else {
      current.driverAttempts = Number(current.driverAttempts || 0) + 1;
      current.driveRetryAt = new Date(Date.now() + retryDelayMs(current.driverAttempts, {
        baseMs: current.config.retryBaseMs, maxMs: current.config.retryMaxMs,
      })).toISOString();
    }
    current.lastError = error;
    return current;
  });
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
  const session = await loadState();
  if (!session || ["completed", "completed_with_failures", "cancelled"].includes(session.status)) return;
  if (session.status === "running" && session.phase === "completed") {
    await completeSession(session);
    return;
  }
  const recovered = recoverSession(session);
  configureSessionMediaResources(recovered);
  await saveState(recovered);
  if (recovered.status === "running") void drive();
}
async function startAutomaticSync() { const settings = await loadSettings(); if (settings.autoSync === "off") return; const history = (await chrome.storage.local.get({ [HISTORY_KEY]: [] }))[HISTORY_KEY]; const last = history.find((item) => item.scopeKey === settings.lastScopeKey); if (last && Date.now() - Date.parse(last.completedAt || last.updatedAt) < settings.autoMinIntervalHours * 3_600_000) return; await startSync("incremental", true); }
async function refreshAutoAlarm() { const settings = await loadSettings(); await chrome.alarms.clear(AUTO_ALARM); if (settings.autoSync === "daily") await chrome.alarms.create(AUTO_ALARM, { periodInMinutes: 24 * 60 }); if (settings.autoSync === "startup") void startAutomaticSync(); }

async function workerTab(sessionId, slot, workerId, url) {
  const session = await loadState();
  let id = session?.workerSlots?.[slot]?.tabId || session?.workerTabs?.[slot];
  if (id) {
    try { return await chrome.tabs.update(id, { url, active: false }); }
    catch { id = null; }
  }
  const tab = await chrome.tabs.create({ url, active: false });
  await mutateState(sessionId, (fresh) => {
    fresh.workerSlots ||= [];
    fresh.workerSlots[slot] = { workerId, tabId: tab.id, updatedAt: new Date().toISOString() };
    fresh.workerTabs ||= [];
    fresh.workerTabs[slot] = tab.id;
    return fresh;
  });
  return tab;
}
async function ensureDiscoveryTab(session) { try { return await chrome.tabs.get(session.discoveryTabId); } catch { const tab = await chrome.tabs.create({ url: session.scopeUrl, active: false }); session.discoveryTabId = tab.id; session.cursor.domOffset = 0; await persistProgress(session); return tab; } }
async function closeWorkerTabs(session) { const ids = new Set([...(session.workerTabs || []), ...(session.workerSlots || []).map((slot) => slot?.tabId)].filter(Boolean)); for (const id of ids) await chrome.tabs.remove(id).catch(() => null); if (session.automatic && session.discoveryTabId) await chrome.tabs.remove(session.discoveryTabId).catch(() => null); }
async function openXiaohongshu() { const session = await loadState(); const url = session?.scopeUrl || "https://www.xiaohongshu.com/"; const tab = await chrome.tabs.create({ url, active: true }); return { ok: true, tabId: tab.id }; }
async function injectExtractor(tabId) { await chrome.scripting.executeScript({ target: { tabId }, files: ["capture-utils.js", "page-extractor.js"] }); }
async function execute(tabId, func, args) { const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func, args: args === undefined ? [] : [args] }); return result; }
async function waitForTab(tabId, timeoutMs) {
  let current;
  try { current = await chrome.tabs.get(tabId); }
  catch { throw syncError("WORKER_TAB_CLOSED", "The worker tab was closed and will be rebuilt.", true); }
  if (current.status === "complete") return;
  await new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(updated); chrome.tabs.onRemoved.removeListener(removed); };
    const timer = setTimeout(() => { cleanup(); reject(syncError("TAB_LOAD_TIMEOUT", "The note detail page did not finish loading.", true)); }, timeoutMs);
    const updated = (id, info) => { if (id === tabId && info.status === "complete") { cleanup(); resolve(); } };
    const removed = (id) => { if (id === tabId) { cleanup(); reject(syncError("WORKER_TAB_CLOSED", "The worker tab was closed and will be rebuilt.", true)); } };
    chrome.tabs.onUpdated.addListener(updated);
    chrome.tabs.onRemoved.addListener(removed);
  });
}

async function loadSettings() { const stored = await chrome.storage.local.get({ endpoint: DEFAULT_ENDPOINT, token: DEFAULT_CAPTURE_TOKEN, [SETTINGS_KEY]: {} }); return settingsWithConnection({ endpoint: stored.endpoint, token: stored.token, ...stored[SETTINGS_KEY] }); }
async function settingsWithConnection(value) { const endpoint = String(value.endpoint || DEFAULT_ENDPOINT).replace(/\/$/, ""); return { ...normalizeSettings(value), endpoint, token: String(value.token || DEFAULT_CAPTURE_TOKEN), autoSync: ["off", "startup", "daily"].includes(value.autoSync) ? value.autoSync : "off", lastScopeUrl: value.lastScopeUrl || "", lastScopeKey: value.lastScopeKey || "" }; }
async function loadState() { return (await chrome.storage.local.get({ [STATE_KEY]: null }))[STATE_KEY]; }
async function saveState(session) { session.updatedAt = new Date().toISOString(); await chrome.storage.local.set({ [STATE_KEY]: session }); }
async function mutateState(sessionId, mutator) {
  const operation = stateMutation.then(async () => {
    const current = await loadState();
    if (!current || (sessionId && current.sessionId !== sessionId)) return current;
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
    return transitionTask(current, taskId, status, details);
  });
}
async function persistProgress(candidate) {
  return mutateState(candidate?.sessionId, (current) => {
    if (!current || !candidate) return current;
    if (current.status !== "running") candidate.status = current.status;
    if (current.stopAfterQueue) {
      candidate.stopAfterQueue = true;
      candidate.phase = "acquisition";
    }
    candidate.driverAttempts = 0;
    candidate.driveRetryAt = null;
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
  return { session, currentScope, currentPageKind, settings: publicSettings(settings), history };
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

export { handleMessage, restoreAfterRestart, watchdog, persistCaptureMedia, apiJson };
