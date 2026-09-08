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
});

export const TASK_STATES = Object.freeze([
  "discovered", "queued", "opening", "loading", "extracting", "submitting", "captured", "duplicate",
  "retry_wait", "failed", "paused_login_required", "paused_verification_required", "cancelled",
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
  return {
    code: "CAPTURE_REJECTED", retryable: status === 408 || status === 429,
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
    mode: mode === "full" ? "full" : "incremental", startedAt: now, updatedAt: now, status: "running", phase: "discovery",
    queue: [], activeTasks: [], seenIdentityKeys: [], cursor: { scannedWindows: 0, scrollY: 0, collectionEnd: false, collectionEndStreak: 0 },
    checkpoint: checkpoint || { topIdentityKeys: [], lastSuccessfulSyncAt: null },
    scan: { consecutiveKnown: 0, checkpointSeen: false, reliableCheckpoint: Boolean(checkpoint?.topIdentityKeys?.length) },
    stats: { discovered: 0, known: 0, new: 0, captured: 0, duplicate: 0, failed: 0, retrying: 0 },
    config, concurrency: initialConcurrency(config), concurrencySamples: [], lastError: null,
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
    if (!completed.has(task.identityKey) && ["opening", "loading", "extracting", "submitting"].includes(task.status)) task.status = "queued";
  }
  session.activeTasks = [];
  if (!["completed", "cancelled"].includes(session.status)) session.status = session.status.startsWith("paused_") ? session.status : "paused_recovered";
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
    session.status = "paused_failed_items";
    session.completedAt = null;
    return session;
  }
  session.status = "completed";
  session.completedAt = now;
  return session;
}

export function prepareSessionResume(input, now = new Date().toISOString()) {
  const previousStatus = String(input?.status || "");
  const session = recoverSession(input, now);
  for (const task of session.queue) {
    if (task.status === "failed" || task.status.startsWith("paused_")) {
      task.status = "queued";
      task.attempts = 0;
      task.retryAt = null;
      task.tabId = null;
      task.error = null;
    }
  }
  session.status = "running";
  session.completedAt = null;
  session.lastError = null;
  session.stats.failed = 0;
  session.stats.retrying = 0;
  if (previousStatus === "paused_verification_required") session.concurrency = 1;
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
    if (identity.known) {
      session.stats.known += 1;
      session.scan.consecutiveKnown += 1;
      if ((session.checkpoint?.topIdentityKeys || []).includes(card.identityKey)) session.scan.checkpointSeen = true;
    } else {
      session.stats.new += 1;
      windowNew += 1;
      session.scan.consecutiveKnown = 0;
      session.queue.push({ ...card, taskId: crypto.randomUUID(), status: "queued", attempts: 0, retryAt: null, error: null });
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
  if (session.mode === "full") return confirmedCollectionEnd;
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
  session.stats.retrying = session.queue.filter((item) => item.status === "retry_wait").length;
  session.updatedAt = task.updatedAt;
  return session;
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

export function nextConcurrency(current, sample, settings = {}) {
  const config = normalizeSettings(settings);
  const fixed = fixedConcurrency(config);
  if (fixed != null) return fixed;
  let next = clamp(Number(current) || initialConcurrency(config), 1, config.concurrencyMax);
  if (sample.verification || sample.loginRequired) return 1;
  if (sample.memoryPressure || sample.rateLimited || sample.backpressure || sample.tabCrash || sample.timeoutRate >= 0.2 || sample.errorRate >= 0.15) {
    return Math.max(1, next >= 10 ? 8 : next >= 8 ? 6 : next >= 6 ? 4 : Math.floor(next / 2));
  }
  if ((sample.successRate ?? 0) >= 0.95 && (sample.p95LoadMs ?? Infinity) <= 12_000 && !sample.memoryPressure) {
    return clamp(next >= 8 ? next + 2 : next + 1, 1, config.concurrencyMax);
  }
  return next;
}

export function normalizeSettings(value = {}) {
  const settings = { ...SYNC_DEFAULTS, ...value };
  settings.identityBatchSize = clampInteger(settings.identityBatchSize, 1, 100, SYNC_DEFAULTS.identityBatchSize);
  settings.discoveryBatchSize = clampInteger(settings.discoveryBatchSize, 10, 200, SYNC_DEFAULTS.discoveryBatchSize);
  settings.stopAfterConsecutiveKnown = clampInteger(settings.stopAfterConsecutiveKnown, 3, 100, SYNC_DEFAULTS.stopAfterConsecutiveKnown);
  settings.queueHighWatermark = clampInteger(settings.queueHighWatermark, 50, 5_000, SYNC_DEFAULTS.queueHighWatermark);
  settings.maxRetries = clampInteger(settings.maxRetries, 0, 10, SYNC_DEFAULTS.maxRetries);
  settings.detailLoadTimeoutMs = clampInteger(settings.detailLoadTimeoutMs, 10_000, 120_000, SYNC_DEFAULTS.detailLoadTimeoutMs);
  settings.autoMinIntervalHours = clampInteger(settings.autoMinIntervalHours, 1, 168, SYNC_DEFAULTS.autoMinIntervalHours);
  settings.concurrencyMax = clampInteger(settings.concurrencyMax, 1, 12, SYNC_DEFAULTS.concurrencyMax);
  settings.concurrencyInitial = clampInteger(settings.concurrencyInitial, 1, settings.concurrencyMax, SYNC_DEFAULTS.concurrencyInitial);
  settings.customConcurrency = clampInteger(settings.customConcurrency, 1, 12, SYNC_DEFAULTS.customConcurrency);
  settings.concurrencyMode = ["auto", "conservative", "balanced", "aggressive", "custom"].includes(settings.concurrencyMode)
    ? settings.concurrencyMode : "auto";
  return settings;
}

export function initialConcurrency(settings = {}, hardwareConcurrency = globalThis.navigator?.hardwareConcurrency || 4) {
  const config = normalizeSettings(settings);
  const fixed = fixedConcurrency(config);
  return fixed ?? clamp(Math.floor(Number(hardwareConcurrency || 4) / 2), Math.min(4, config.concurrencyMax), Math.min(8, config.concurrencyMax));
}

function fixedConcurrency(config) {
  return { conservative: 2, balanced: 4, aggressive: 8, custom: config.customConcurrency }[config.concurrencyMode] ?? null;
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
