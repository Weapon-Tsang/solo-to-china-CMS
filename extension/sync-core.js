export const SYNC_DEFAULTS = Object.freeze({
  identityBatchSize: 50,
  discoveryBatchSize: 100,
  stopAfterConsecutiveKnown: 12,
  queueHighWatermark: 500,
  maxRetries: 3,
  detailLoadTimeoutMs: 30_000,
  autoMinIntervalHours: 12,
  concurrencyMode: "auto",
  concurrencyInitial: 4,
  concurrencyMax: 12,
  customConcurrency: 4,
  mediaConcurrency: 12,
  mediaUploadConcurrency: 6,
  mediaMemoryBudgetBytes: 96 * 1024 * 1024,
  taskLeaseMs: 3 * 60 * 1000,
  watchdogStallMs: 2 * 60 * 1000,
  retryBaseMs: 5_000,
  retryMaxMs: 2 * 60 * 1000,
  concurrencyWindowSize: 24,
  concurrencyMinSamples: 20,
});

export const TASK_STATES = Object.freeze([
  "discovered", "queued", "opening", "loading", "extracting", "submitting", "captured", "duplicate",
  "retry_wait", "failed", "paused_login_required", "paused_verification_required", "paused_capture_unauthorized", "cancelled",
]);

export const HUMAN_PAUSE_STATES = Object.freeze([
  "paused_login_required", "paused_verification_required", "paused_capture_unauthorized", "paused_by_user",
]);

const IN_FLIGHT_TASK_STATES = new Set(["opening", "loading", "extracting", "submitting"]);
const LOCAL_FAILURE_CODES = new Set([
  "NOTE_UNAVAILABLE", "MEDIA_HTTP_403", "MEDIA_HTTP_404", "MEDIA_TYPE_UNSUPPORTED", "MEDIA_URL_EXPIRED", "SELECTOR_MISMATCH",
]);

export function classifyCaptureApiError(status, payload = {}) {
  const serverMessage = typeof payload?.error === "string" ? payload.error.trim() : "";
  if (status === 401 || status === 403) return {
    code: "CAPTURE_UNAUTHORIZED", retryable: false,
    message: serverMessage || "Capture authorization failed.",
  };
  if (status === 404) return {
    code: "CAPTURE_API_UNAVAILABLE", retryable: false,
    message: serverMessage || "This SoloToChina Engine version does not provide the Favorites Sync API.",
  };
  if (status >= 500) return {
    code: "CAPTURE_SERVER_UNAVAILABLE", retryable: true,
    message: serverMessage || "The capture server returned an error.",
  };
  if (status === 429) return {
    code: "CAPTURE_RATE_LIMITED", retryable: true,
    message: serverMessage || "The capture server asked the extension to slow down.",
  };
  return {
    code: "CAPTURE_REJECTED", retryable: status === 408,
    message: serverMessage || `Capture request failed (${status}).`,
  };
}

export function canonicalizeNoteUrl(value) {
  try {
    const url = new URL(value);
    if (!/^(?:www\.)?xiaohongshu\.com$/i.test(url.hostname)) return "";
    const id = noteIdFromPath(url.pathname);
    if (!id) return "";
    url.protocol = "https:";
    url.hostname = "www.xiaohongshu.com";
    url.pathname = `/explore/${id}`;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|source$|share_|xsec_|xhsshare|appuid$)/i.test(key)) url.searchParams.delete(key);
    }
    const entries = [...url.searchParams.entries()].sort(([left], [right]) => left.localeCompare(right));
    url.search = "";
    for (const [key, item] of entries) url.searchParams.append(key, item);
    return url.toString();
  } catch {
    return "";
  }
}

export function noteIdentity(value) {
  const canonicalUrl = canonicalizeNoteUrl(value?.canonicalUrl || value?.url || value);
  const externalId = String(value?.externalId || canonicalUrl.match(/\/explore\/([A-Za-z0-9]+)/)?.[1] || "").trim();
  return externalId ? `xiaohongshu:${externalId}` : canonicalUrl ? `url:${canonicalUrl}` : "";
}

export function scopeFromUrl(value) {
  try {
    const url = new URL(value);
    if (!/^(?:www\.)?xiaohongshu\.com$/i.test(url.hostname)) return null;
    if (isAlbumOverview(url)) return null;
    if (!isFavoritesScopePath(url)) return null;
    url.protocol = "https:";
    url.hostname = "www.xiaohongshu.com";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (/^(?:utm_|source$|share_|xsec_|xhsshare|appuid$)/i.test(key)) url.searchParams.delete(key);
    const entries = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
    url.search = "";
    for (const [key, item] of entries) url.searchParams.append(key, item);
    const normalized = url.toString();
    return { key: `xhs_scope:${normalized}`, url: normalized, label: documentFreeScopeLabel(url) };
  } catch {
    return null;
  }
}

export function normalizeCard(input, position = 0) {
  const rawNavigationUrl = input?.navigationUrl || input?.url || input?.canonicalUrl || "";
  const canonicalUrl = canonicalizeNoteUrl(input?.canonicalUrl || rawNavigationUrl);
  const externalId = String(input?.externalId || canonicalUrl.match(/\/explore\/([A-Za-z0-9]+)/)?.[1] || "").trim();
  if (!canonicalUrl || !externalId) return null;
  return {
    externalId,
    canonicalUrl,
    navigationUrl: safeNoteNavigationUrl(rawNavigationUrl, externalId) || canonicalUrl,
    title: String(input?.title || "").trim().slice(0, 1_000),
    author: String(input?.author || "").trim().slice(0, 500),
    coverUrl: safeHttps(input?.coverUrl),
    position: Number.isInteger(input?.position) ? input.position : position,
    identityKey: `xiaohongshu:${externalId}`,
  };
}

export function createSession({ scope, mode = "incremental", settings = {}, checkpoint = null, now = new Date().toISOString() }) {
  const config = normalizeSettings(settings);
  return {
    sessionId: crypto.randomUUID(), scopeKey: scope.key, scopeUrl: scope.url, scopeLabel: scope.label || "Xiaohongshu favorites",
    mode: ["incremental", "repair", "full"].includes(mode) ? mode : "incremental", startedAt: now, updatedAt: now, status: "running", phase: "discovery",
    queue: [], activeTasks: [], seenIdentityKeys: [], cursor: { scannedWindows: 0, scrollY: 0, collectionEnd: false, collectionEndStreak: 0 },
    checkpoint: checkpoint || { topIdentityKeys: [], lastSuccessfulSyncAt: null },
    scan: { consecutiveKnown: 0, checkpointSeen: false, reliableCheckpoint: Boolean(checkpoint?.topIdentityKeys?.length) },
    stats: { discovered: 0, known: 0, new: 0, repair: 0, captured: 0, duplicate: 0, failed: 0, unavailable: 0, retrying: 0 },
    config, concurrency: initialConcurrency(config), concurrencySamples: [],
    concurrencyController: { reason: "warming_up", lastChangeAt: null },
    mediaConcurrency: config.mediaConcurrency, mediaConcurrencyController: { reason: "settings", lastChangeAt: null },
    workerSlots: [], lastProgressAt: now, recoveryNoticeAt: null, lastError: null,
  };
}

export function recoverSession(input, now = new Date().toISOString()) {
  const session = structuredClone(input);
  const legacyNavigationKeys = new Set(session.queue
    .filter((task) => !["captured", "duplicate"].includes(task.status) && !task.navigationUrl)
    .map((task) => task.identityKey));
  if (legacyNavigationKeys.size) {
    session.queue = session.queue.filter((task) => !legacyNavigationKeys.has(task.identityKey));
    session.seenIdentityKeys = (session.seenIdentityKeys || []).filter((key) => !legacyNavigationKeys.has(key));
    session.phase = "discovery";
    session.discoveryComplete = false;
    session.cursor = { ...(session.cursor || {}), domOffset: 0, scrollY: 0, collectionEnd: false, collectionEndStreak: 0 };
    session.scan = { ...(session.scan || {}), consecutiveKnown: 0, windowNew: 0 };
    session.stats.discovered = Math.max(0, Number(session.stats.discovered || 0) - legacyNavigationKeys.size);
    session.stats.new = Math.max(0, Number(session.stats.new || 0) - legacyNavigationKeys.size);
    session.stats.failed = session.queue.filter((task) => task.status === "failed").length;
    session.stats.retrying = 0;
  }
  const completed = new Set(session.queue.filter((task) => ["captured", "duplicate"].includes(task.status)).map((task) => task.identityKey));
  for (const task of session.queue) {
    if (!completed.has(task.identityKey) && IN_FLIGHT_TASK_STATES.has(task.status)) {
      task.status = "queued";
      clearTaskLease(task);
      task.retryAt = null;
      task.tabId = null;
      task.recoveredAt = now;
    }
  }
  session.activeTasks = [];
  session.config = normalizeSettings(session.config || {});
  session.concurrency = fixedConcurrency(session.config) ?? clamp(Number(session.concurrency) || initialConcurrency(session.config), 1, session.config.concurrencyMax);
  session.concurrencySamples = Array.isArray(session.concurrencySamples)
    ? session.concurrencySamples.slice(-session.config.concurrencyWindowSize) : [];
  session.workerSlots = Array.isArray(session.workerSlots) ? session.workerSlots : [];
  session.mediaConcurrency = clamp(Number(session.mediaConcurrency) || session.config.mediaConcurrency, 1, session.config.mediaConcurrency);
  session.mediaConcurrencyController ||= { reason: "settings", lastChangeAt: null };
  session.stats = { unavailable: 0, ...session.stats };
  if (session.status === "paused_failed_items" || (session.phase === "completed" && hasUnresolvedFailures(session))) {
    session.status = "completed_with_failures";
    session.phase = "completed";
    session.completedAt ||= now;
  } else if (!["completed", "completed_with_failures", "cancelled"].includes(session.status)
    && !HUMAN_PAUSE_STATES.includes(session.status)) {
    session.status = "running";
    session.completedAt = null;
    session.recoveryNoticeAt = now;
  }
  session.lastProgressAt = now;
  session.updatedAt = now;
  return session;
}

export function hasUnresolvedFailures(session) {
  return Number(session?.stats?.failed || 0) > 0
    || Boolean(session?.queue?.some((task) => task.status === "failed"));
}

export function prepareSessionCompletion(input, now = new Date().toISOString()) {
  const session = structuredClone(input);
  session.phase = "completed";
  session.updatedAt = now;
  if (hasUnresolvedFailures(session)) {
    session.status = "completed_with_failures";
    session.completedAt = now;
    return session;
  }
  session.status = "completed";
  session.completedAt = now;
  return session;
}

export function prepareSessionResume(input, now = new Date().toISOString()) {
  const session = recoverSession(input, now);
  for (const task of session.queue) {
    if (task.status === "failed" || task.status.startsWith("paused_")) {
      task.status = "queued";
      task.attempts = 0;
      task.retryAt = null;
      task.tabId = null;
      task.error = null;
      task.permanent = false;
      task.unavailable = false;
      clearTaskLease(task);
    }
  }
  session.status = "running";
  session.completedAt = null;
  session.lastError = null;
  session.stats.failed = 0;
  session.stats.unavailable = 0;
  session.stats.retrying = 0;
  if (session.queue.some((task) => task.status === "queued")) session.phase = "acquisition";
  else if (session.phase === "completed") session.phase = "discovery";
  session.updatedAt = now;
  return session;
}

export function applyIdentityBatch(sessionInput, cardsInput, identityResults = [], options = {}) {
  const session = structuredClone(sessionInput);
  const existing = new Set(session.seenIdentityKeys || []);
  const byExternalId = new Map(identityResults.map((item) => [String(item.externalId || ""), item]));
  const byUrl = new Map(identityResults.map((item) => [String(item.canonicalUrl || ""), item]));
  const topKeys = [];
  let windowNew = 0;
  for (const [index, rawCard] of cardsInput.entries()) {
    const card = normalizeCard(rawCard, index);
    if (!card || existing.has(card.identityKey)) continue;
    existing.add(card.identityKey);
    topKeys.push(card.identityKey);
    const identity = byExternalId.get(card.externalId) || byUrl.get(card.canonicalUrl) || { known: false };
    session.stats.discovered += 1;
    const repairActions = Array.isArray(identity.requiredActions) ? identity.requiredActions : [];
    const needsBrowserCapture = Boolean(identity.sourceExists && repairActions.some((action) =>
      ["BROWSER_MEDIA_REPAIR", "RECAPTURE_TEXT_DOM"].includes(action)));
    const shouldQueue = session.mode === "repair" ? needsBrowserCapture
      : session.mode === "full" ? (!identity.sourceExists || needsBrowserCapture)
        : !identity.known;
    if (!shouldQueue) {
      session.stats.known += 1;
      session.scan.consecutiveKnown += 1;
      if ((session.checkpoint?.topIdentityKeys || []).includes(card.identityKey)) session.scan.checkpointSeen = true;
    } else {
      if (needsBrowserCapture) session.stats.repair = Number(session.stats.repair || 0) + 1;
      else session.stats.new += 1;
      windowNew += 1;
      session.scan.consecutiveKnown = 0;
      const repairMediaIdentities = Array.isArray(identity.repairMedia?.missingOriginals)
        ? identity.repairMedia.missingOriginals.map((asset) => String(asset.mediaIdentity || "")).filter(Boolean) : null;
      session.queue.push({ ...card, repairActions, repairMediaIdentities, sourceId:identity.sourceId || null,
        taskId: crypto.randomUUID(), status: "queued", attempts: 0, retryAt: null, error: null });
    }
  }
  session.seenIdentityKeys = [...existing];
  session.cursor.scannedWindows += 1;
  session.cursor.collectionEnd = Boolean(options.collectionEnd);
  session.cursor.collectionEndStreak = options.collectionEnd ? Number(session.cursor.collectionEndStreak || 0) + 1 : 0;
  session.cursor.scrollY = Number(options.scrollY || session.cursor.scrollY || 0);
  session.currentTopIdentityKeys = session.cursor.scannedWindows === 1 ? topKeys.slice(0, 50) : session.currentTopIdentityKeys || [];
  session.scan.windowNew = windowNew;
  if (options.collectionEnd) session.scan.checkpointSeen = true;
  session.updatedAt = options.now || new Date().toISOString();
  return session;
}

export function shouldStopDiscovery(session) {
  const confirmedCollectionEnd = Boolean(session.cursor?.collectionEnd && Number(session.cursor?.collectionEndStreak || 0) >= 2);
  if (["repair", "full"].includes(session.mode)) return confirmedCollectionEnd;
  if (confirmedCollectionEnd) return true;
  return Boolean(session.scan?.checkpointSeen && session.scan?.reliableCheckpoint
    && session.scan?.consecutiveKnown >= session.config.stopAfterConsecutiveKnown
    && Number(session.scan?.windowNew || 0) === 0);
}

export function transitionTask(sessionInput, taskId, status, details = {}) {
  if (!TASK_STATES.includes(status)) throw new Error(`Unsupported sync task state: ${status}`);
  const session = structuredClone(sessionInput);
  const task = session.queue.find((item) => item.taskId === taskId);
  if (!task) return session;
  const previous = task.status;
  Object.assign(task, details, { status, updatedAt: details.updatedAt || new Date().toISOString() });
  if (status === "captured" && previous !== "captured") session.stats.captured += 1;
  if (status === "duplicate" && previous !== "duplicate") session.stats.duplicate += 1;
  if (status === "failed" && previous !== "failed") session.stats.failed += 1;
  if (status === "failed" && details.unavailable && !task.unavailableCounted) {
    session.stats.unavailable = Number(session.stats.unavailable || 0) + 1;
    task.unavailableCounted = true;
  }
  if (["captured", "duplicate"].includes(status) && previous === "failed") {
    session.stats.failed = Math.max(0, Number(session.stats.failed || 0) - 1);
    if (task.unavailableCounted) session.stats.unavailable = Math.max(0, Number(session.stats.unavailable || 0) - 1);
  }
  session.stats.retrying = session.queue.filter((item) => item.status === "retry_wait").length;
  session.activeTasks = session.queue.filter((item) => IN_FLIGHT_TASK_STATES.has(item.status)).map((item) => item.taskId);
  session.lastProgressAt = task.updatedAt;
  session.updatedAt = task.updatedAt;
  return session;
}

export function applySettingsToSession(input, settings, now = new Date().toISOString()) {
  const session = structuredClone(input);
  session.config = normalizeSettings({ ...(session.config || {}), ...(settings || {}) });
  const fixed = fixedConcurrency(session.config);
  session.concurrency = fixed == null
    ? clamp(Number(session.concurrency) || initialConcurrency(session.config), 1, session.config.concurrencyMax)
    : fixed;
  session.concurrencyController = {
    ...(session.concurrencyController || {}),
    reason: fixed == null ? (session.concurrencyController?.reason || "auto_optimizing") : "settings",
  };
  session.mediaConcurrency = session.config.mediaConcurrency;
  session.mediaConcurrencyController = { reason: "settings", lastChangeAt: now };
  session.updatedAt = now;
  return session;
}

export function leaseNextTask(input, { workerId, leaseId = crypto.randomUUID(), now = new Date().toISOString() } = {}) {
  let session = structuredClone(input);
  if (session.status !== "running" || session.phase !== "acquisition") return { session, task: null };
  const nowMs = Date.parse(now);
  const task = session.queue.find((item) => item.status === "queued"
    || (item.status === "retry_wait" && Date.parse(item.retryAt || 0) <= nowMs));
  if (!task) return { session, task: null };
  const leaseExpiresAt = new Date(nowMs + session.config.taskLeaseMs).toISOString();
  session = transitionTask(session, task.taskId, "opening", {
    attempts: Number(task.attempts || 0) + 1,
    workerId: String(workerId || "worker"), leaseId, leaseStartedAt: now, leaseExpiresAt,
    startedAt: task.startedAt || now, retryAt: null, tabId: null, error: null, updatedAt: now,
  });
  return { session, task: structuredClone(session.queue.find((item) => item.taskId === task.taskId)) };
}

export function reconcileStrandedTasks(input, { now = new Date().toISOString(), force = false } = {}) {
  let session = structuredClone(input);
  const nowMs = Date.parse(now);
  let recovered = 0;
  for (const task of session.queue || []) {
    if (!IN_FLIGHT_TASK_STATES.has(task.status)) continue;
    const expired = !Number.isFinite(Date.parse(task.leaseExpiresAt || "")) || Date.parse(task.leaseExpiresAt) <= nowMs;
    if (!force && !expired) continue;
    const taskId = task.taskId;
    session = transitionTask(session, taskId, "queued", {
      retryAt: null, tabId: null, recoveredAt: now,
      error: task.error || { code: "LEASE_RECOVERED", message: "A stranded browser task was safely requeued.", retryable: true },
      updatedAt: now,
    });
    clearTaskLease(session.queue.find((item) => item.taskId === taskId));
    recovered += 1;
  }
  if (recovered) {
    session.recoveryNoticeAt = now;
    session.lastProgressAt = now;
  }
  return { session, recovered };
}

export function classifyTaskDisposition(error = {}, attempts = 0, maxRetries = SYNC_DEFAULTS.maxRetries) {
  const code = String(error.code || "NETWORK_ERROR");
  if (code === "NOT_LOGGED_IN") return { action: "pause", status: "paused_login_required" };
  if (code === "VERIFICATION_REQUIRED") return { action: "pause", status: "paused_verification_required" };
  if (code === "CAPTURE_UNAUTHORIZED" || code === "UNAUTHORIZED") return { action: "pause", status: "paused_capture_unauthorized" };
  if (error.retryable !== false && Number(attempts || 0) < Number(maxRetries || 0)) return { action: "retry", status: "retry_wait" };
  return { action: "fail", status: "failed", unavailable: code === "NOTE_UNAVAILABLE" };
}

export function retryDelayMs(attempt, { baseMs = SYNC_DEFAULTS.retryBaseMs, maxMs = SYNC_DEFAULTS.retryMaxMs, random = Math.random } = {}) {
  const exponential = Math.min(maxMs, baseMs * (2 ** Math.max(0, Number(attempt || 1) - 1)));
  const jitter = 0.8 + Math.max(0, Math.min(1, Number(random()))) * 0.4;
  return Math.max(100, Math.round(exponential * jitter));
}

export function compactSessionState(sessionInput, terminalRetention = 50) {
  const session = structuredClone(sessionInput);
  const compactableStates = new Set(["captured", "duplicate", "cancelled"]);
  const terminal = session.queue.filter((task) => compactableStates.has(task.status));
  const retention = Math.max(0, terminalRetention);
  const retainedTerminalIds = new Set((retention ? terminal.slice(-retention) : []).map((task) => task.taskId));
  session.queue = session.queue.filter((task) => !compactableStates.has(task.status) || retainedTerminalIds.has(task.taskId));
  for (const task of session.queue) if (compactableStates.has(task.status)) delete task.navigationUrl;
  const required = new Set([
    ...(session.currentTopIdentityKeys || []),
    ...session.queue.filter((task) => !compactableStates.has(task.status)).map((task) => task.identityKey),
  ]);
  const recentLimit = Math.max(500, Math.min(2_000, Number(session.config?.queueHighWatermark || 500) * 2));
  for (const key of (session.seenIdentityKeys || []).slice(-recentLimit)) required.add(key);
  session.seenIdentityKeys = [...required];
  return session;
}

export function updateSessionConcurrency(input, sample, now = new Date().toISOString()) {
  const session = structuredClone(input);
  const config = normalizeSettings(session.config || {});
  session.config = config;
  const fixed = fixedConcurrency(config);
  const normalized = normalizeTaskSample(sample, now);
  session.concurrencySamples = [...(session.concurrencySamples || []), normalized].slice(-config.concurrencyWindowSize);
  session.concurrencyController = { ...(session.concurrencyController || {}) };
  if (fixed != null) {
    session.concurrency = fixed;
    session.concurrencyController.reason = "settings";
    const reason = pressureReason(normalized);
    const mediaCurrent = clamp(Number(session.mediaConcurrency) || config.mediaConcurrency, 1, config.mediaConcurrency);
    if (["rate_limited", "memory_pressure", "cms_backpressure"].includes(reason)) {
      session.mediaConcurrency = Math.max(2, mediaCurrent - Math.max(1, Math.ceil(mediaCurrent * 0.25)));
      session.mediaConcurrencyController = { reason, lastChangeAt: now, samplesAtLastChange: session.concurrencySamples.length };
    } else {
      const recent = session.concurrencySamples.slice(-config.concurrencyMinSamples);
      const healthy = recent.length >= config.concurrencyMinSamples
        && recent.every((item) => item.result === "succeeded" || item.localFailure)
        && recent.every((item) => !pressureReason(item));
      const samplesSinceChange = session.concurrencySamples.length - Number(session.mediaConcurrencyController?.samplesAtLastChange || 0);
      session.mediaConcurrency = healthy && mediaCurrent < config.mediaConcurrency && samplesSinceChange >= 4 ? mediaCurrent + 1 : mediaCurrent;
      session.mediaConcurrencyController ||= { reason: "settings", lastChangeAt: null };
      if (session.mediaConcurrency > mediaCurrent) session.mediaConcurrencyController = {
        reason: "auto_optimizing", lastChangeAt: now, samplesAtLastChange: session.concurrencySamples.length,
      };
    }
    return session;
  }

  const samples = session.concurrencySamples;
  const recent = samples.slice(-config.concurrencyMinSamples);
  const current = clamp(Number(session.concurrency) || initialConcurrency(config), 1, config.concurrencyMax);
  const elapsed = Date.parse(now) - Date.parse(session.concurrencyController.lastChangeAt || 0);
  const samplesSinceChange = samples.length - Number(session.concurrencyController.samplesAtLastChange || 0);
  const latestPressure = pressureReason(normalized);
  const tabCrashBurst = recent.slice(-3).filter((item) => item.tabCrash).length >= 2;
  const enough = recent.length >= config.concurrencyMinSamples;
  const systemicFailures = enough ? recent.filter((item) => item.result === "failed" && !item.localFailure).length / recent.length : 0;
  const timeoutRate = enough ? recent.filter((item) => item.timeout).length / recent.length : 0;
  const rollingPressureCandidate = tabCrashBurst ? "tab_crash"
    : systemicFailures >= 0.3 ? "sustained_failures"
      : timeoutRate >= 0.25 ? "note_timeouts" : "";
  const rollingPressure = samplesSinceChange >= 4 ? rollingPressureCandidate : "";
  const reason = latestPressure || rollingPressure;
  if (reason) {
    session.concurrency = Math.max(1, current - Math.max(1, Math.ceil(current * 0.25)));
    session.concurrencyController = { reason, lastChangeAt: now, samplesAtLastChange: samples.length };
    if (["rate_limited", "memory_pressure", "cms_backpressure"].includes(reason)) {
      const mediaCurrent = clamp(Number(session.mediaConcurrency) || config.mediaConcurrency, 1, config.mediaConcurrency);
      session.mediaConcurrency = Math.max(2, mediaCurrent - Math.max(1, Math.ceil(mediaCurrent * 0.25)));
      session.mediaConcurrencyController = { reason, lastChangeAt: now, samplesAtLastChange: samples.length };
    }
    return session;
  }

  const healthy = enough && recent.every((item) => item.result === "succeeded" || item.localFailure)
    && recent.every((item) => !pressureReason(item));
  if (healthy && current < config.concurrencyMax && samplesSinceChange >= 4 && (!Number.isFinite(elapsed) || elapsed >= 30_000)) {
    session.concurrency = current + 1;
    session.concurrencyController = { reason: "auto_optimizing", lastChangeAt: now, samplesAtLastChange: samples.length };
  } else {
    session.concurrency = current;
    const retainedPressure = [...recent].reverse().map(pressureReason).find(Boolean) || rollingPressureCandidate;
    session.concurrencyController.reason = retainedPressure
      || (samples.length < config.concurrencyMinSamples ? "warming_up" : "auto_optimizing");
  }
  const mediaCurrent = clamp(Number(session.mediaConcurrency) || config.mediaConcurrency, 1, config.mediaConcurrency);
  const mediaSamplesSinceChange = samples.length - Number(session.mediaConcurrencyController?.samplesAtLastChange || 0);
  if (healthy && mediaCurrent < config.mediaConcurrency && mediaSamplesSinceChange >= 4) {
    session.mediaConcurrency = mediaCurrent + 1;
    session.mediaConcurrencyController = { reason: "auto_optimizing", lastChangeAt: now, samplesAtLastChange: samples.length };
  } else {
    session.mediaConcurrency = mediaCurrent;
    session.mediaConcurrencyController ||= { reason: "settings", lastChangeAt: null };
  }
  return session;
}

export function nextConcurrency(current, samples, settings = {}) {
  const config = normalizeSettings(settings);
  const list = Array.isArray(samples) ? samples : [samples];
  let session = { config, concurrency: current, concurrencySamples: [], concurrencyController: {} };
  for (const [index, sample] of list.entries()) {
    session = updateSessionConcurrency(session, sample, new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString());
  }
  return session.concurrency;
}

export function normalizeSettings(value = {}) {
  const settings = { ...SYNC_DEFAULTS };
  for (const key of Object.keys(SYNC_DEFAULTS)) if (value[key] !== undefined) settings[key] = value[key];
  settings.identityBatchSize = clampInteger(settings.identityBatchSize, 1, 100, SYNC_DEFAULTS.identityBatchSize);
  settings.discoveryBatchSize = clampInteger(settings.discoveryBatchSize, 10, 200, SYNC_DEFAULTS.discoveryBatchSize);
  settings.stopAfterConsecutiveKnown = clampInteger(settings.stopAfterConsecutiveKnown, 3, 100, SYNC_DEFAULTS.stopAfterConsecutiveKnown);
  settings.queueHighWatermark = clampInteger(settings.queueHighWatermark, 50, 5_000, SYNC_DEFAULTS.queueHighWatermark);
  settings.maxRetries = clampInteger(settings.maxRetries, 0, 10, SYNC_DEFAULTS.maxRetries);
  settings.detailLoadTimeoutMs = clampInteger(settings.detailLoadTimeoutMs, 10_000, 120_000, SYNC_DEFAULTS.detailLoadTimeoutMs);
  settings.autoMinIntervalHours = clampInteger(settings.autoMinIntervalHours, 1, 168, SYNC_DEFAULTS.autoMinIntervalHours);
  settings.concurrencyMax = clampInteger(settings.concurrencyMax, 1, 16, SYNC_DEFAULTS.concurrencyMax);
  settings.concurrencyInitial = clampInteger(settings.concurrencyInitial, 1, settings.concurrencyMax, SYNC_DEFAULTS.concurrencyInitial);
  settings.customConcurrency = clampInteger(settings.customConcurrency, 1, 16, SYNC_DEFAULTS.customConcurrency);
  settings.mediaConcurrency = clampInteger(settings.mediaConcurrency, 1, 16, SYNC_DEFAULTS.mediaConcurrency);
  settings.mediaUploadConcurrency = clampInteger(settings.mediaUploadConcurrency, 1, settings.mediaConcurrency, SYNC_DEFAULTS.mediaUploadConcurrency);
  settings.mediaMemoryBudgetBytes = clampInteger(settings.mediaMemoryBudgetBytes, 32 * 1024 * 1024, 512 * 1024 * 1024, SYNC_DEFAULTS.mediaMemoryBudgetBytes);
  settings.taskLeaseMs = clampInteger(settings.taskLeaseMs, 60_000, 15 * 60 * 1000, SYNC_DEFAULTS.taskLeaseMs);
  settings.watchdogStallMs = clampInteger(settings.watchdogStallMs, 30_000, 10 * 60 * 1000, SYNC_DEFAULTS.watchdogStallMs);
  settings.retryBaseMs = clampInteger(settings.retryBaseMs, 1_000, 60_000, SYNC_DEFAULTS.retryBaseMs);
  settings.retryMaxMs = clampInteger(settings.retryMaxMs, settings.retryBaseMs, 10 * 60 * 1000, SYNC_DEFAULTS.retryMaxMs);
  settings.concurrencyWindowSize = clampInteger(settings.concurrencyWindowSize, 20, 30, SYNC_DEFAULTS.concurrencyWindowSize);
  settings.concurrencyMinSamples = clampInteger(settings.concurrencyMinSamples, 20, settings.concurrencyWindowSize, SYNC_DEFAULTS.concurrencyMinSamples);
  settings.concurrencyMode = ["auto", "conservative", "balanced", "aggressive", "custom"].includes(settings.concurrencyMode)
    ? settings.concurrencyMode : "auto";
  return settings;
}

export function initialConcurrency(settings = {}, hardwareConcurrency = globalThis.navigator?.hardwareConcurrency || 4) {
  const config = normalizeSettings(settings);
  const fixed = fixedConcurrency(config);
  return fixed ?? clamp(Math.floor(Number(hardwareConcurrency || 4) / 2), Math.min(4, config.concurrencyMax), Math.min(8, config.concurrencyMax));
}

export class AsyncSemaphore {
  constructor(limit = 1) {
    this.limit = Math.max(1, Number(limit) || 1);
    this.active = 0;
    this.waiters = [];
  }
  setLimit(limit) {
    this.limit = Math.max(1, Number(limit) || 1);
    this.#drain();
  }
  async acquire(weight = 1) {
    const requested = Math.max(1, Math.min(this.limit, Number(weight) || 1));
    if (!this.waiters.length && this.active + requested <= this.limit) {
      this.active += requested;
      return this.#release(requested);
    }
    return new Promise((resolve) => {
      this.waiters.push({ requested, resolve });
      this.#drain();
    });
  }
  async run(handler, weight = 1) {
    const release = await this.acquire(weight);
    try { return await handler(); }
    finally { release(); }
  }
  #release(weight) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - weight);
      this.#drain();
    };
  }
  #drain() {
    while (this.waiters.length && this.active + this.waiters[0].requested <= this.limit) {
      const waiter = this.waiters.shift();
      this.active += waiter.requested;
      waiter.resolve(this.#release(waiter.requested));
    }
  }
}

export async function runContinuousPool(items, concurrency, handler) {
  const values = Array.from(items || []);
  const results = new Array(values.length);
  let cursor = 0;
  const worker = async (slot) => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      try { results[index] = { status: "fulfilled", value: await handler(values[index], index, slot) }; }
      catch (reason) { results[index] = { status: "rejected", reason }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(values.length, Math.max(1, Number(concurrency) || 1)) }, (_, slot) => worker(slot)));
  return results;
}

function fixedConcurrency(config) {
  return { conservative: 2, balanced: 4, aggressive: 8, custom: config.customConcurrency }[config.concurrencyMode] ?? null;
}
function pressureReason(sample) {
  if (sample.verificationDetected || sample.loginRequired) return "verification_risk";
  if (sample.rateLimited) return "rate_limited";
  if (sample.memoryPressure) return "memory_pressure";
  if (sample.cmsBackpressure || sample.backpressure) return "cms_backpressure";
  return "";
}
function normalizeTaskSample(value = {}, now) {
  const errorClass = String(value.errorClass || value.errorCode || "");
  return {
    noteLoadMs: finite(value.noteLoadMs), extractionMs: finite(value.extractionMs),
    mediaDownloadMs: finite(value.mediaDownloadMs), mediaUploadMs: finite(value.mediaUploadMs),
    submitMs: finite(value.submitMs), totalMs: finite(value.totalMs),
    result: value.result === "failed" ? "failed" : "succeeded", errorClass,
    rateLimited: Boolean(value.rateLimited || errorClass === "MEDIA_HTTP_429" || errorClass === "CAPTURE_RATE_LIMITED"),
    verificationDetected: Boolean(value.verificationDetected || errorClass === "VERIFICATION_REQUIRED"),
    loginRequired: Boolean(value.loginRequired || errorClass === "NOT_LOGGED_IN"),
    tabCrash: Boolean(value.tabCrash || ["WORKER_TAB_CLOSED", "TAB_CRASH"].includes(errorClass)),
    timeout: Boolean(value.timeout || /TIMEOUT/.test(errorClass)),
    cmsBackpressure: Boolean(value.cmsBackpressure || value.backpressure),
    memoryPressure: Boolean(value.memoryPressure), mediaCount: finite(value.mediaCount), mediaBytes: finite(value.mediaBytes),
    localFailure: value.localFailure === true || LOCAL_FAILURE_CODES.has(errorClass), completedAt: value.completedAt || now,
  };
}
function finite(value) { const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : 0; }
function clearTaskLease(task) {
  if (!task) return;
  task.leaseId = null;
  task.leaseStartedAt = null;
  task.leaseExpiresAt = null;
  task.workerId = null;
}
function clampInteger(value, min, max, fallback) { const number = Number(value); return Number.isInteger(number) ? clamp(number, min, max) : clamp(fallback, min, max); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function safeHttps(value) { try { const url = new URL(value || ""); return url.protocol === "https:" ? url.toString() : ""; } catch { return ""; } }
function noteIdFromPath(pathname) {
  return pathname.match(/\/(?:explore|discovery\/item)\/([A-Za-z0-9]+)/)?.[1]
    || pathname.match(/\/board\/[A-Za-z0-9]+\/([A-Za-z0-9]+)/)?.[1]
    || "";
}
function safeNoteNavigationUrl(value, expectedId) {
  try {
    const url = new URL(value || "");
    if (!/^(?:www\.)?xiaohongshu\.com$/i.test(url.hostname) || noteIdFromPath(url.pathname) !== expectedId) return "";
    url.protocol = "https:";
    url.hostname = "www.xiaohongshu.com";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (/^(?:utm_|source$|share_|xhsshare|appuid$)/i.test(key)) url.searchParams.delete(key);
    return url.toString();
  } catch {
    return "";
  }
}
function isFavoritesScopePath(url) {
  if (/^\/board\/[A-Za-z0-9]+\/?$/i.test(url.pathname)) return true;
  if (/^\/user\/profile\/[A-Za-z0-9]+\/(?:collect|favorites?)\/?$/i.test(url.pathname)) return true;
  if (/^\/user\/profile\/[A-Za-z0-9]+\/?$/i.test(url.pathname)) {
    return /^(?:collect|fav|favorite|favorites)$/i.test(url.searchParams.get("tab") || "");
  }
  return false;
}
export function isFavoritesAlbumOverviewUrl(value) {
  try {
    const url = new URL(value);
    return /^(?:www\.)?xiaohongshu\.com$/i.test(url.hostname) && isAlbumOverview(url);
  } catch {
    return false;
  }
}
function isAlbumOverview(url) {
  return /^\/user\/profile\/[A-Za-z0-9]+\/?$/i.test(url.pathname)
    && /^(?:collect|fav|favorite|favorites)$/i.test(url.searchParams.get("tab") || "")
    && /^board$/i.test(url.searchParams.get("subTab") || "");
}
function documentFreeScopeLabel(url) {
  const boardId = url.pathname.match(/^\/board\/([A-Za-z0-9]+)/i)?.[1];
  return boardId ? `小红书收藏夹 · ${boardId.slice(0, 8)}` : "小红书收藏";
}
