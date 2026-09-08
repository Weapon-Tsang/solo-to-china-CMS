import {
  applyIdentityBatch, classifyCaptureApiError, compactSessionState, createSession, hasUnresolvedFailures, initialConcurrency, nextConcurrency,
  isFavoritesAlbumOverviewUrl, normalizeSettings, recoverSession, scopeFromUrl, shouldStopDiscovery, transitionTask,
  prepareSessionResume,
} from "./sync-core.js";

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
let driving = false;
let driveTimer = null;
let stateMutation = Promise.resolve();

chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
  void refreshAutoAlarm();
});
chrome.runtime.onStartup.addListener(() => { void restoreAfterRestart(); void refreshAutoAlarm(); });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) void drive();
  if (alarm.name === AUTO_ALARM) void startAutomaticSync();
});

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
      await refreshAutoAlarm();
      return { ok: true, settings: publicSettings(settings) };
    }
    case "START_SYNC": return startSync(message.mode === "full" ? "full" : "incremental");
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
  if (state && !["completed", "cancelled"].includes(state.status)) return { ok: false, error: syncError("SESSION_ALREADY_RUNNING", "A Favorites Sync session is already active.", false) };
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
    if (session.phase === "discovery") {
      session = await discoverWindow(session);
      session = await persistProgress(session);
      if (session.status !== "running") return;
    }
    if (session.phase === "acquisition") {
      session = await acquireQueue(session);
      session = await persistProgress(session);
      if (session.status !== "running") return;
    }
    if (session.phase === "completed") await completeSession(session);
  } catch (error) {
    const session = await loadState();
    if (session && session.status === "running") {
      session.status = "paused_error";
      session.lastError = serializeError(error);
      session.updatedAt = new Date().toISOString();
      await saveState(session);
    }
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
    limit: session.config.discoveryBatchSize, offset,
  });
  // Virtualized collections remove older cards from the DOM. Reset the DOM offset
  // and rely on stable identity de-duplication when the current window is exhausted.
  if (offset && scan?.cards?.length === 0 && !scan.collectionEnd) {
    session.cursor.domOffset = 0;
    scan = await execute(tab.id, (options) => globalThis.SoloToChinaXhs.scanFavorites(options), {
      limit: session.config.discoveryBatchSize, offset: 0,
    });
  }
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
  const ready = session.queue.filter((task) => task.status === "queued" || (task.status === "retry_wait" && Date.parse(task.retryAt || 0) <= Date.now()));
  if (!ready.length) {
    const retrying = session.queue.some((task) => task.status === "retry_wait");
    if (retrying) return session;
    if (hasUnresolvedFailures(session)) {
      session.status = "paused_failed_items";
      return session;
    }
    if (!session.discoveryComplete && !session.stopAfterQueue) { session.phase = "discovery"; return session; }
    session.phase = "completed";
    return session;
  }
  const count = Math.max(1, Math.min(session.concurrency || initialConcurrency(session.config), ready.length));
  const started = Date.now();
  const results = await Promise.allSettled(ready.slice(0, count).map((task, slot) => acquireTask(session.sessionId, task.taskId, slot)));
  session = await loadState();
  if (!session || session.status !== "running") return session;
  const failures = results.filter((result) => result.status === "rejected").length;
  session.concurrency = nextConcurrency(session.concurrency, {
    successRate: (results.length - failures) / results.length,
    errorRate: failures / results.length,
    p95LoadMs: Date.now() - started,
    backpressure: results.some((result) => result.status === "fulfilled" && result.value?.advice === "slow_down"),
  }, session.config);
  session = compactSessionState(session);
  session = await persistProgress(session);
  return session;
}

async function acquireTask(sessionId, taskId, slot) {
  let session;
  let task;
  await mutateState(sessionId, (current) => {
    task = current?.queue.find((item) => item.taskId === taskId);
    if (!current || current.status !== "running" || !task || !["queued", "retry_wait"].includes(task.status)) return current;
    session = transitionTask(current, taskId, "opening", { attempts: Number(task.attempts || 0) + 1 });
    return session;
  });
  if (!session) return null;
  try {
    const tab = await workerTab(session, slot, task.navigationUrl || task.canonicalUrl);
    session = await updateTask(sessionId, taskId, "loading", { tabId: tab.id });
    assertNotCancelled(session);
    await waitForTab(tab.id, session.config.detailLoadTimeoutMs);
    await injectExtractor(tab.id);
    session = await updateTask(sessionId, taskId, "extracting");
    assertNotCancelled(session);
    const extracted = await execute(tab.id, (options) => globalThis.SoloToChinaXhs.prepareAndExtract(options), {
      acquisitionOrigin: "xhs_favorites_sync", syncScopeKey: session.scopeKey,
    });
    if (!extracted?.ok) throw Object.assign(new Error(extracted?.error?.message || "Note extraction failed."), extracted?.error || {});
    const capture = await enrichImageDerivatives(extracted.capture);
    session = await updateTask(sessionId, taskId, "submitting");
    assertNotCancelled(session);
    const response = await submitCapture(capture);
    if (response.completenessStatus !== "complete") throw Object.assign(new Error("Capture was persisted as partial and will be retried before entering Research."), {
      code: "CONTENT_NOT_READY", retryable: true,
    });
    session = await updateTask(sessionId, taskId, response.duplicate ? "duplicate" : "captured", {
      sourceId: response.id, captureVersion: response.captureVersion, tabId: null, error: null,
    });
    return response;
  } catch (caught) {
    await handleTaskError(sessionId, taskId, caught);
    throw caught;
  }
}

async function handleTaskError(sessionId, taskId, caught) {
  const error = serializeError(caught);
  const updated = await mutateState(sessionId, (current) => {
    if (!current) return current;
    const task = current.queue.find((item) => item.taskId === taskId);
    if (!task || current.status === "cancelled" || task.status === "cancelled") return current;
    let session = current;
    if (["paused_login_required", "paused_verification_required"].includes(current.status)
      && !["NOT_LOGGED_IN", "VERIFICATION_REQUIRED", "NAVIGATION_INTERRUPTED"].includes(error.code)) {
      session = transitionTask(session, taskId, "queued", { error, retryAt: null, tabId: null });
      return session;
    }
    if (error.code === "NOT_LOGGED_IN") {
      session = transitionTask(session, taskId, "paused_login_required", { error });
      session.status = "paused_login_required";
      session.stats.paused = (session.stats.paused || 0) + 1;
    } else if (["VERIFICATION_REQUIRED", "NAVIGATION_INTERRUPTED"].includes(error.code)) {
      session = transitionTask(session, taskId, "paused_verification_required", { error });
      session.status = "paused_verification_required";
      session.concurrency = 1;
      session.stats.paused = (session.stats.paused || 0) + 1;
    } else if (error.code === "CAPTURE_UNAUTHORIZED") {
      session = transitionTask(session, taskId, "failed", { error });
      session.status = "paused_capture_unauthorized";
    } else if (error.retryable !== false && Number(task.attempts || 0) < session.config.maxRetries) {
      const delays = [5_000, 15_000, 45_000];
      session = transitionTask(session, taskId, "retry_wait", { error,
        retryAt: new Date(Date.now() + (delays[Math.max(0, task.attempts - 1)] || 45_000)).toISOString() });
    } else {
      session = transitionTask(session, taskId, "failed", { error });
    }
    session.lastError = error;
    return session;
  });
  if (updated?.status?.startsWith("paused_")) await reportSession(updated).catch(() => null);
}

async function submitCapture(capture) {
  const settings = await loadSettings();
  const json = JSON.stringify(capture);
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength <= DIRECT_CAPTURE_BYTES) return apiJson(`${settings.endpoint}/api/captures`, { method: "POST", body: json }, settings.token);
  const sha256 = await hashBytes(bytes);
  const upload = await apiJson(`${settings.endpoint}/api/capture-uploads`, { method: "POST", body: JSON.stringify({ size: bytes.byteLength, sha256 }) }, settings.token);
  for (let offset = 0, index = 0; offset < bytes.length; offset += UPLOAD_CHUNK_BYTES, index += 1) {
    await apiJson(`${settings.endpoint}/api/capture-uploads/${encodeURIComponent(upload.uploadId)}/chunks/${index}`,
      { method: "PUT", body: bytes.slice(offset, offset + UPLOAD_CHUNK_BYTES), raw: true }, settings.token);
  }
  return apiJson(`${settings.endpoint}/api/capture-uploads/${encodeURIComponent(upload.uploadId)}/complete`, { method: "POST", body: "{}" }, settings.token);
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
    response = await fetch(url, { method: options.method, headers: {
      ...(options.raw ? { "content-type": "application/octet-stream" } : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    }, body: options.body });
  } catch (cause) {
    throw Object.assign(new Error("The SoloToChina Engine is unavailable."), { code: "CAPTURE_SERVER_UNAVAILABLE", retryable: true, cause });
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const details = classifyCaptureApiError(response.status, payload);
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
  return { ok: true, capture: { title: extracted.capture.title }, result: await submitCapture(await enrichImageDerivatives(extracted.capture)) };
}

async function enrichImageDerivatives(capture) {
  for (const image of capture.images || []) {
    try {
      const response = await fetch(image.url);
      if (!response.ok) continue;
      const blob = await response.blob();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      image.originalSha256 = await hashBytes(bytes);
      if (bytes.byteLength <= 5_500_000) continue;
      const bitmap = await createImageBitmap(blob);
      let scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
      let derivative;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
        canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        derivative = await canvas.convertToBlob({ type: "image/webp", quality: Math.max(0.55, 0.84 - attempt * 0.08) });
        if (derivative.size <= 5_500_000) break;
        scale *= 0.72;
      }
      bitmap.close();
      if (derivative?.size <= 5_500_000) {
        const derivativeBytes = new Uint8Array(await derivative.arrayBuffer());
        image.aiDerivativeDataUrl = `data:image/webp;base64,${bytesToBase64(derivativeBytes)}`;
        image.aiDerivativeSha256 = await hashBytes(derivativeBytes);
      }
    } catch {
      // Original URL and completeness provenance remain; provider coverage will surface an unavailable derivative.
    }
  }
  return capture;
}

async function pauseSync(status) {
  const session = await mutateState(null, (current) => {
    if (!current || current.status !== "running") return current;
    current.status = status;
    return current;
  });
  if (!session || session.status !== status) return { ok: false, error: syncError("NO_ACTIVE_SESSION", "No running sync session was found.", false) };
  await reportSession(session).catch(() => null);
  return { ok: true, session };
}
async function resumeSync() {
  const current = await loadState();
  if (!current || current.status === "cancelled" || (current.status === "completed" && !hasUnresolvedFailures(current))) {
    return { ok: false, error: syncError("NO_RESUMABLE_SESSION", "No resumable sync session was found.", false) };
  }
  try {
    await assertFavoritesSyncApi();
  } catch (error) {
    await mutateState(null, (current) => {
      if (!current || current.status === "cancelled" || (current.status === "completed" && !hasUnresolvedFailures(current))) return current;
      current.status = "paused_error";
      current.lastError = serializeError(error);
      return current;
    });
    throw error;
  }
  const session = await mutateState(null, (current) => {
    if (!current || current.status === "cancelled" || (current.status === "completed" && !hasUnresolvedFailures(current))) return current;
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
  await closeWorkerTabs(session); await archiveSession(session); await reportSession(session).catch(() => null);
  return { ok: true, session };
}
async function stopAfterQueue() { const session = await mutateState(null, (current) => { if (!current) return current; current.stopAfterQueue = true; current.phase = "acquisition"; return current; }); if (!session) return { ok: false }; void drive(); return { ok: true, session }; }

async function completeSession(session) {
  if (hasUnresolvedFailures(session)) {
    session.status = "paused_failed_items";
    await saveState(session);
    await reportSession(session).catch(() => null);
    return;
  }
  session.status = "completed"; session.completedAt = new Date().toISOString(); session.updatedAt = session.completedAt;
  const scopes = await loadScopes();
  scopes[session.scopeKey] = { scopeUrl: session.scopeUrl, lastSuccessfulSyncAt: session.completedAt,
    checkpoint: { topIdentityKeys: session.currentTopIdentityKeys || [], lastSuccessfulSyncAt: session.completedAt }, summary: session.stats };
  await chrome.storage.local.set({ [SCOPES_KEY]: scopes });
  await closeWorkerTabs(session); await saveState(session); await archiveSession(session); await reportSession(session).catch(() => null);
}

async function archiveSession(session) { const history = (await chrome.storage.local.get({ [HISTORY_KEY]: [] }))[HISTORY_KEY]; await chrome.storage.local.set({ [HISTORY_KEY]: [summary(session), ...history.filter((item) => item.sessionId !== session.sessionId)].slice(0, 20) }); }
async function restoreAfterRestart() { const session = await loadState(); if (session && !["completed", "cancelled"].includes(session.status)) await saveState(recoverSession(session)); }
async function startAutomaticSync() { const settings = await loadSettings(); if (settings.autoSync === "off") return; const history = (await chrome.storage.local.get({ [HISTORY_KEY]: [] }))[HISTORY_KEY]; const last = history.find((item) => item.scopeKey === settings.lastScopeKey); if (last && Date.now() - Date.parse(last.completedAt || last.updatedAt) < settings.autoMinIntervalHours * 3_600_000) return; await startSync("incremental", true); }
async function refreshAutoAlarm() { const settings = await loadSettings(); await chrome.alarms.clear(AUTO_ALARM); if (settings.autoSync === "daily") await chrome.alarms.create(AUTO_ALARM, { periodInMinutes: 24 * 60 }); if (settings.autoSync === "startup") void startAutomaticSync(); }

async function workerTab(session, slot, url) { let id = session.workerTabs?.[slot]; if (id) { try { const tab = await chrome.tabs.update(id, { url, active: false }); return tab; } catch { id = null; } } const tab = await chrome.tabs.create({ url, active: false }); await mutateState(session.sessionId, (fresh) => { fresh.workerTabs ||= []; fresh.workerTabs[slot] = tab.id; return fresh; }); return tab; }
async function ensureDiscoveryTab(session) { try { return await chrome.tabs.get(session.discoveryTabId); } catch { const tab = await chrome.tabs.create({ url: session.scopeUrl, active: false }); session.discoveryTabId = tab.id; session.cursor.domOffset = 0; await persistProgress(session); return tab; } }
async function closeWorkerTabs(session) { for (const id of session.workerTabs || []) if (id) await chrome.tabs.remove(id).catch(() => null); if (session.automatic && session.discoveryTabId) await chrome.tabs.remove(session.discoveryTabId).catch(() => null); }
async function openXiaohongshu() { const session = await loadState(); const url = session?.scopeUrl || "https://www.xiaohongshu.com/"; const tab = await chrome.tabs.create({ url, active: true }); return { ok: true, tabId: tab.id }; }
async function injectExtractor(tabId) { await chrome.scripting.executeScript({ target: { tabId }, files: ["page-extractor.js"] }); }
async function execute(tabId, func, args) { const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func, args: args === undefined ? [] : [args] }); return result; }
async function waitForTab(tabId, timeoutMs) { const current = await chrome.tabs.get(tabId); if (current.status === "complete") return; await new Promise((resolve, reject) => { const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); reject(syncError("TAB_LOAD_TIMEOUT", "The note detail page did not finish loading.", true)); }, timeoutMs); const listener = (id, info) => { if (id === tabId && info.status === "complete") { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve(); } }; chrome.tabs.onUpdated.addListener(listener); }); }

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
async function updateTask(sessionId, taskId, status, details = {}) {
  return mutateState(sessionId, (current) => {
    const task = current?.queue.find((item) => item.taskId === taskId);
    if (!current || current.status === "cancelled" || task?.status === "cancelled") return current;
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
    return candidate;
  });
}
function scheduleDrive(session) {
  if (driveTimer) clearTimeout(driveTimer);
  const retryTimes = session.phase === "acquisition"
    ? session.queue.filter((task) => task.status === "retry_wait").map((task) => Date.parse(task.retryAt || 0)).filter(Number.isFinite)
    : [];
  const delay = retryTimes.length && !session.queue.some((task) => task.status === "queued")
    ? Math.max(100, Math.min(60_000, Math.min(...retryTimes) - Date.now())) : 100;
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
function serializeError(value) { return { code: String(value?.code || "NETWORK_ERROR"), message: String(value?.message || value || "Unknown error"), retryable: value?.retryable !== false, timestamp: new Date().toISOString() }; }
function syncError(code, message, retryable) { return Object.assign(new Error(message), { code, retryable }); }
function assertNotCancelled(session) { if (session?.status === "cancelled") throw syncError("SESSION_CANCELLED", "The Favorites Sync session was cancelled.", false); }
async function hashBytes(bytes) { const digest = await crypto.subtle.digest("SHA-256", bytes); return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join(""); }
function bytesToBase64(bytes) { let output = ""; const block = 0x8000; for (let index = 0; index < bytes.length; index += block) output += String.fromCharCode(...bytes.subarray(index, index + block)); return btoa(output); }
