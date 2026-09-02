import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { openDatabase } from "./db.mjs";
import { normalizeXiaohongshuCapture, ValidationError } from "./adapters/xiaohongshu.mjs";
import { KimiExtractor } from "./ai/kimi.mjs";
import { ContentEngine } from "./ai/content-engine.mjs";
import { VertexImagen } from "./visuals/vertex-imagen.mjs";
import { Pipeline } from "./pipeline.mjs";
import { Repository } from "./repository.mjs";
import { WordPressDraftAdapter } from "./wordpress.mjs";
import { SearchConsoleAdapter } from "./search-console.mjs";
import { CommercialComposer, CommercialValidationError, normalizeCommercialOffer } from "./commercial.mjs";
import { MaintenanceScheduler } from "./maintenance.mjs";
import { createLogger } from "./logger.mjs";
import { ExceptionNotifier } from "./notifications.mjs";
import { createAuth } from "./auth.mjs";
import { getContentStrategyDocument } from "./content-strategy.mjs";
import { VERSION } from "./version.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

export function createApplication(config = loadConfig()) {
  if (!isLoopbackHost(config.host) && (!config.captureToken || !config.adminToken || !config.auth.password || !config.auth.sessionSecret)) {
    throw new Error("Non-loopback HOST requires CAPTURE_TOKEN, ADMIN_TOKEN, ADMIN_PASSWORD, and SESSION_SECRET.");
  }
  const logger = createLogger(config.logging);
  const db = openDatabase(config.databasePath);
  const auth = createAuth(db, config.auth);
  const repository = new Repository(db, {
    ...config.content, contentStrategy: config.contentStrategy,
    searchConsoleMinimumImpressions: config.searchConsole.minimumImpressions,
  });
  const selectedAi = repository.getAiSettings(config.ai.defaultModel);
  const activeAi = { ...config.kimi, ...config.vertex, ...selectedAi };
  const selectedVisual = repository.getVisualSettings(config.visuals.defaultModel);
  const activeVisuals = { ...config.visuals, ...selectedVisual };
  const extractor = new KimiExtractor(activeAi);
  const contentEngine = new ContentEngine(activeAi);
  const visuals = new VertexImagen(activeVisuals);
  const wordpress = new WordPressDraftAdapter(config.wordpress);
  const searchConsole = new SearchConsoleAdapter(config.searchConsole);
  const commercialComposer = new CommercialComposer(config.commercial);
  const pipeline = new Pipeline(repository, extractor, {
    contentEngine, visuals, wordpress, searchConsole, commercialComposer, contentConfig: config.content,
    logger: logger.child({ component: "pipeline" }),
  });
  const notifier = new ExceptionNotifier(repository, config.notifications);
  const maintenance = new MaintenanceScheduler(
    repository,
    pipeline,
    { ...config.maintenance, notificationIntervalMinutes: config.notifications.intervalMinutes },
    config.wordpress,
    { notifier, searchConsoleConfig: config.searchConsole, logger: logger.child({ component: "maintenance" }) },
  );
  if (wordpress.enabled) {
    repository.enqueueWordPressInventorySync(wordpress.config.siteUrl, wordpress.config.inventorySyncHours);
  }
  if (searchConsole.enabled) {
    repository.enqueueSearchConsoleSync(searchConsole.config.siteUrl, searchConsole.config.syncHours);
  }
  repository.enqueueStartupReconciliation({ wordpressEnabled: wordpress.enabled });
  const publicDir = path.join(config.root, "dist");

  const server = http.createServer(async (request, response) => {
    const requestId = normalizeRequestId(request.headers["x-request-id"]) || crypto.randomUUID();
    const requestStartedAt = Date.now();
    const requestPath = String(request.url || "/").split("?", 1)[0];
    response.setHeader("X-Request-Id", requestId);
    response.once("finish", () => {
      if (!requestPath.startsWith("/api/")) return;
      logger.info("http.request_completed", {
        requestId, method: request.method, path: requestPath, status: response.statusCode,
        durationMs: Date.now() - requestStartedAt,
      });
    });
    try {
      setSecurityHeaders(response);
      setCors(request, response);
      if (request.method === "OPTIONS") return response.writeHead(204).end();
      const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
      const captureOnly = isCaptureHost(request, config.captureHost);
      if (captureOnly && !isCaptureRoute(request.method, url.pathname)) return sendJson(response, 404, { error: "Not found." });

      if (!captureOnly && request.method === "GET" && url.pathname === "/api/auth/status") {
        return sendJson(response, 200, { enabled: auth.enabled, ...auth.status(request) });
      }
      if (!captureOnly && request.method === "POST" && url.pathname === "/api/auth/login") {
        if (!auth.enabled) return sendJson(response, 409, { error: "Password sign-in is not configured." });
        const payload = await readJson(request, 20_000);
        const session = auth.login(payload.username, payload.password);
        if (!session) return sendJson(response, 401, { error: "Incorrect username or password." });
        response.setHeader("Set-Cookie", session.cookie);
        return sendJson(response, 200, { authenticated: true, username: session.username, mustChangePassword: session.mustChangePassword });
      }
      if (!captureOnly && request.method === "POST" && url.pathname === "/api/auth/logout") {
        response.setHeader("Set-Cookie", auth.clearCookie());
        return sendJson(response, 204, {});
      }
      if (!captureOnly && request.method === "POST" && url.pathname === "/api/auth/change-password") {
        const payload = await readJson(request, 20_000);
        const session = auth.changePassword(request, payload.currentPassword, payload.nextPassword);
        if (!session) return sendJson(response, 401, { error: "Current password is incorrect." });
        response.setHeader("Set-Cookie", session.cookie);
        return sendJson(response, 200, { authenticated: true, username: session.username, mustChangePassword: false });
      }
      if (!captureOnly && request.method === "POST" && url.pathname === "/api/auth/update-credentials") {
        const payload = await readJson(request, 20_000);
        const session = auth.updateCredentials(request, payload.currentPassword, payload.nextUsername, payload.nextPassword);
        if (!session) return sendJson(response, 401, { error: "Current password is incorrect." });
        response.setHeader("Set-Cookie", session.cookie);
        return sendJson(response, 200, { authenticated: true, username: session.username, mustChangePassword: false });
      }
      if (!captureOnly && isDashboardApi(url.pathname) && !hasBearerToken(request, config.adminToken)) auth.require(request);

      if (request.method === "GET" && url.pathname === "/api/health") {
        const telemetry = repository.jobTelemetry(config.telemetry.windowHours);
        return sendJson(response, 200, {
          ok: true,
          version: VERSION,
          aiConfigured: extractor.enabled,
          aiProvider: extractor.enabled ? activeAi.provider : null,
          aiModel: extractor.enabled ? activeAi.model : null,
          visualProvider: visuals.enabled ? activeVisuals.provider : null,
          visualModel: visuals.enabled ? activeVisuals.model : null,
          contentStrategy: config.contentStrategy,
          contentAutomationConfigured: contentEngine.enabled,
          visualGenerationConfigured: visuals.enabled,
          wordpressConfigured: wordpress.enabled,
          searchConsoleConfigured: searchConsole.enabled,
          maintenanceEnabled: config.maintenance.enabled,
          notificationsConfigured: notifier.enabled,
          queueActive: telemetry.active,
        });
      }
      if (request.method === "GET" && url.pathname.startsWith("/media/")) {
        if (!captureOnly) auth.require(request);
        return serveMedia(config.visuals.mediaDir, url.pathname.slice("/media/".length), response);
      }
      if (request.method === "GET" && url.pathname === "/api/ready") {
        db.prepare("SELECT 1 AS ready").get();
        return sendJson(response, 200, { ready: true, version: VERSION, database: "ready" });
      }
      if (request.method === "GET" && url.pathname === "/api/content-strategy") {
        return sendJson(response, 200, getContentStrategyDocument());
      }
      if (request.method === "GET" && url.pathname === "/api/content-strategy/download") {
        const strategy = getContentStrategyDocument();
        response.writeHead(200, {
          "content-type": "text/markdown; charset=utf-8",
          "content-disposition": `attachment; filename="${strategy.filename}"`,
          "cache-control": "no-store",
        });
        return response.end(strategy.markdown);
      }
      if (request.method === "GET" && url.pathname === "/api/system/info") {
        return sendJson(response, 200, {
          appVersion: VERSION,
          contentStrategy: config.contentStrategy,
          storage: storageInfo(config),
          ai: repository.getAiSettings(config.ai.defaultModel),
          visual: repository.getVisualSettings(config.visuals.defaultModel),
        });
      }
      if (request.method === "GET" && url.pathname === "/api/settings/ai") {
        return sendJson(response, 200, {
          configured: extractor.enabled, visualGenerationConfigured: visuals.enabled, appVersion: VERSION,
          contentStrategy: config.contentStrategy, storage: storageInfo(config), visual: repository.getVisualSettings(config.visuals.defaultModel),
          ...repository.getAiSettings(config.ai.defaultModel),
        });
      }
      if (request.method === "POST" && url.pathname === "/api/settings/ai") {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 20_000);
        const settings = repository.setAiModel(String(payload.model || ""), config.ai.defaultModel);
        Object.assign(activeAi, settings);
        return sendJson(response, 200, {
          configured: extractor.enabled, visualGenerationConfigured: visuals.enabled,
          visual: repository.getVisualSettings(config.visuals.defaultModel), ...settings,
        });
      }
      if (request.method === "GET" && url.pathname === "/api/settings/visuals") {
        const settings = repository.getVisualSettings(config.visuals.defaultModel);
        return sendJson(response, 200, { configured: visuals.enabled, ...settings });
      }
      if (request.method === "POST" && url.pathname === "/api/settings/visuals") {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 20_000);
        const settings = repository.setVisualModel(String(payload.model || ""), config.visuals.defaultModel);
        Object.assign(activeVisuals, settings);
        return sendJson(response, 200, { configured: visuals.enabled, ...settings });
      }
      if (request.method === "POST" && url.pathname === "/api/captures") {
        authorizeCapture(request, config.captureToken);
        const capture = normalizeXiaohongshuCapture(await readJson(request, 4_000_000));
        const saved = repository.saveCapture(capture);
        void pipeline.runOne();
        return sendJson(response, saved.duplicate ? 200 : 202, saved);
      }
      if (request.method === "GET" && url.pathname === "/api/dashboard") {
        return sendJson(response, 200, repository.dashboard());
      }
      if (request.method === "GET" && url.pathname === "/api/sources") {
        return sendJson(response, 200, { items: repository.listSources(limit(url.searchParams.get("limit"))) });
      }
      const sourceMatch = url.pathname.match(/^\/api\/sources\/([^/]+)$/);
      if (request.method === "GET" && sourceMatch) {
        if (captureOnly) authorizeCapture(request, config.captureToken);
        const source = repository.getSource(sourceMatch[1]);
        return source ? sendJson(response, 200, source) : sendJson(response, 404, { error: "Source not found." });
      }
      const retryMatch = url.pathname.match(/^\/api\/sources\/([^/]+)\/retry$/);
      if (request.method === "POST" && retryMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const retried = repository.retrySource(retryMatch[1]);
        if (!retried) return sendJson(response, 404, { error: "Source not found." });
        void pipeline.runOne();
        return sendJson(response, 202, { queued: true });
      }
      if (request.method === "GET" && url.pathname === "/api/knowledge") {
        return sendJson(response, 200, { items: repository.getKnowledge() });
      }
      const knowledgeResolutionMatch = url.pathname.match(/^\/api\/knowledge\/([^/]+)\/resolve$/);
      if (request.method === "POST" && knowledgeResolutionMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 20_000);
        const resolved = repository.resolveKnowledgeConflict(decodeURIComponent(knowledgeResolutionMatch[1]), payload.preferredValue, payload.note || "");
        if (!resolved) return sendJson(response, 404, { error: "Knowledge conflict not found or already resolved." });
        return sendJson(response, 200, resolved);
      }
      if (request.method === "GET" && url.pathname === "/api/editorial-blueprints") {
        return sendJson(response, 200, { items: repository.getEditorialBlueprints() });
      }
      if (request.method === "GET" && url.pathname === "/api/content") {
        return sendJson(response, 200, {
          items: repository.listContent(),
          opportunities: repository.listContentOpportunities(limit(url.searchParams.get("limit"))),
        });
      }
      if (request.method === "GET" && url.pathname === "/api/recommendations") {
        return sendJson(response, 200, { items: repository.listContentRecommendations(limit(url.searchParams.get("limit"))), opportunities: repository.listContentOpportunities(limit(url.searchParams.get("limit"))) });
      }
      const recommendationDecisionMatch = url.pathname.match(/^\/api\/recommendations\/([^/]+)\/decision$/);
      if (request.method === "POST" && recommendationDecisionMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 20_000);
        const result = repository.decideRecommendation(recommendationDecisionMatch[1], String(payload.decision || ""), payload.note || "");
        if (!result) return sendJson(response, 404, { error: "Recommendation not found." });
        void pipeline.runOne();
        return sendJson(response, 202, result);
      }
      if (request.method === "GET" && url.pathname === "/api/exceptions") {
        return sendJson(response, 200, { items: repository.listOperationalExceptions() });
      }
      if (request.method === "GET" && url.pathname === "/api/maintenance") {
        return sendJson(response, 200, {
          enabled: config.maintenance.enabled,
          intervalMinutes: config.maintenance.intervalMinutes,
          runs: repository.listMaintenanceRuns(),
          wordpressSync: repository.getWordPressSyncState(wordpress.config.siteUrl),
          searchConsoleSync: repository.getSearchConsoleSyncState(searchConsole.config.siteUrl),
          telemetry: repository.jobTelemetry(config.telemetry.windowHours),
          notifications: {
            configured: notifier.enabled,
            minimumSeverity: config.notifications.minimumSeverity,
            repeatHours: config.notifications.repeatHours,
            ...repository.notificationOverview(),
          },
          logging: { level: config.logging.level, format: config.logging.format },
        });
      }
      if (request.method === "POST" && url.pathname === "/api/maintenance/run") {
        authorizeAdmin(request, config.adminToken, auth);
        return sendJson(response, 200, await maintenance.runDue({ force: true }));
      }
      const exceptionRetryMatch = url.pathname.match(/^\/api\/exceptions\/(.+)\/retry$/);
      if (request.method === "POST" && exceptionRetryMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const retried = repository.retryOperationalException(decodeURIComponent(exceptionRetryMatch[1]));
        if (!retried) return sendJson(response, 409, { error: "Exception is not retryable or no longer exists." });
        void pipeline.runOne();
        return sendJson(response, 202, { queued: true });
      }
      if (request.method === "GET" && url.pathname === "/api/wordpress/inventory") {
        return sendJson(response, 200, {
          configured: wordpress.enabled,
          sync: repository.getWordPressSyncState(wordpress.config.siteUrl),
          items: repository.listWordPressInventory(wordpress.config.siteUrl || null),
        });
      }
      if (request.method === "POST" && url.pathname === "/api/wordpress/inventory/sync") {
        authorizeAdmin(request, config.adminToken, auth);
        if (!wordpress.enabled) return sendJson(response, 409, { error: "WordPress inventory sync is not configured." });
        const jobId = repository.enqueueWordPressInventorySync(wordpress.config.siteUrl, wordpress.config.inventorySyncHours, true);
        void pipeline.runOne();
        return sendJson(response, 202, { queued: true, jobId });
      }
      if (request.method === "GET" && url.pathname === "/api/search-console") {
        return sendJson(response, 200, {
          configured: searchConsole.enabled,
          sync: repository.getSearchConsoleSyncState(searchConsole.config.siteUrl),
          items: repository.listSearchConsoleInventory(searchConsole.config.siteUrl || null, limit(url.searchParams.get("limit"))),
        });
      }
      if (request.method === "POST" && url.pathname === "/api/search-console/sync") {
        authorizeAdmin(request, config.adminToken, auth);
        if (!searchConsole.enabled) return sendJson(response, 409, { error: "Search Console sync is not configured." });
        const jobId = repository.enqueueSearchConsoleSync(searchConsole.config.siteUrl, searchConsole.config.syncHours, true);
        void pipeline.runOne();
        return sendJson(response, 202, { queued: true, jobId });
      }
      if (request.method === "GET" && url.pathname === "/api/commercial/offers") {
        return sendJson(response, 200, { items: repository.listCommercialOffers() });
      }
      if (request.method === "POST" && url.pathname === "/api/commercial/offers") {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 1_000_000);
        const inputs = Array.isArray(payload) ? payload : [payload];
        if (inputs.length > 500) return sendJson(response, 400, { error: "A sync batch may contain at most 500 offers." });
        const normalized = inputs.map((input) => normalizeCommercialOffer(input));
        const items = normalized.map((offer) => repository.upsertCommercialOffer(offer));
        for (const destination of new Set(normalized.map((offer) => offer.destinationSlug))) {
          repository.enqueueCommercialForDestination(destination);
        }
        void pipeline.runOne();
        return sendJson(response, 200, { items });
      }
      const generateMatch = url.pathname.match(/^\/api\/topics\/([^/]+)\/generate$/);
      if (request.method === "POST" && generateMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        return sendJson(response, 409, { error: "Approve an Intake Recommendation before planning content." });
      }
      const retryContentMatch = url.pathname.match(/^\/api\/topics\/([^/]+)\/retry$/);
      if (request.method === "POST" && retryContentMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        if (!contentEngine.enabled) return sendJson(response, 409, { error: "KIMI_API_KEY is required for content production." });
        const jobType = repository.retryContent(retryContentMatch[1]);
        if (!jobType) return sendJson(response, 409, { error: "Nothing retryable was found for this topic." });
        void pipeline.runOne();
        return sendJson(response, 202, { queued: true, jobType });
      }
      const draftMatch = url.pathname.match(/^\/api\/drafts\/([^/]+)$/);
      if (request.method === "GET" && draftMatch) {
        const draft = repository.getDraftPackage(draftMatch[1]);
        return draft ? sendJson(response, 200, draft) : sendJson(response, 404, { error: "Draft not found." });
      }
      const wordpressMatch = url.pathname.match(/^\/api\/drafts\/([^/]+)\/wordpress$/);
      if (request.method === "POST" && wordpressMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        if (!wordpress.enabled) return sendJson(response, 409, { error: "WordPress delivery is not configured." });
        const draft = repository.getDraftPackage(wordpressMatch[1]);
        if (!draft?.review?.passed) return sendJson(response, 409, { error: "Draft must pass QA before WordPress delivery." });
        repository.enqueue("compose_commercial", wordpressMatch[1]);
        void pipeline.runOne();
        return sendJson(response, 202, { queued: true });
      }
      if (request.method === "POST" && url.pathname === "/api/pipeline/run-one") {
        authorizeAdmin(request, config.adminToken, auth);
        const worked = await pipeline.runOne();
        return sendJson(response, 200, { worked });
      }

      if (url.pathname.startsWith("/api/")) return sendJson(response, 404, { error: "Not found." });
      if (request.method === "GET") return serveStatic(publicDir, url.pathname, response);
      return sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      const status = error instanceof ValidationError || error instanceof CommercialValidationError ? 400 : error?.statusCode || 500;
      const log = status >= 500 ? logger.error : logger.warn;
      log("http.request_failed", { requestId, method: request.method, path: requestPath, status, error });
      return sendJson(response, status, { error: error.message || "Unexpected server error." });
    }
  });

  return {
    server,
    repository,
    pipeline,
    maintenance,
    notifier,
    logger,
    start() {
      return new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.once("error", onError);
        server.listen(config.port, config.host, () => {
          server.off("error", onError);
          pipeline.start();
          maintenance.start();
          logger.info("server.started", { host: config.host, port: server.address().port, version: VERSION });
          resolve();
        });
      });
    },
    async stop() {
      maintenance.stop();
      pipeline.stop();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      db.close();
      logger.info("server.stopped", { version: VERSION });
    },
  };
}

function authorizeCapture(request, token) {
  authorize(request, token, "capture");
}

function authorizeAdmin(request, token, auth) {
  if (hasBearerToken(request, token)) return;
  if (auth.enabled) return auth.require(request);
  authorize(request, token, "admin");
}

function authorize(request, token, label) {
  if (!token) return;
  if (!hasBearerToken(request, token)) {
    const error = new Error(`Invalid ${label} token.`);
    error.statusCode = 401;
    throw error;
  }
}

function hasBearerToken(request, token) {
  if (!token) return false;
  const supplied = request.headers.authorization || "";
  const expected = `Bearer ${token}`;
  return supplied.length === expected.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

function isDashboardApi(pathname) {
  return pathname.startsWith("/api/") && !["/api/health", "/api/ready"].includes(pathname);
}

function isLoopbackHost(host) {
  return ["127.0.0.1", "localhost", "::1"].includes(host);
}

function storageInfo(config) {
  const local = isLoopbackHost(config.host);
  return {
    mode: local ? "local" : "cloud",
    label: local ? "本机离线持久化" : "云端持久化数据库",
    crossDevice: !local,
    description: local
      ? "当前服务运行在本机；数据保存在此电脑的数据库文件中，换设备前需要迁移或部署到云端。"
      : "当前服务运行在云端服务器的持久化数据卷中。更换电脑后只需访问同一后台并登录，研究来源、知识库和草稿都会保持一致。",
  };
}

function isCaptureHost(request, captureHost) {
  if (!captureHost) return false;
  const host = String(request.headers.host || "").replace(/:\d+$/, "").toLowerCase();
  return host === captureHost;
}

function isCaptureRoute(method, pathname) {
  return (method === "GET" && ["/api/health", "/api/ready"].includes(pathname))
    || (method === "POST" && pathname === "/api/captures")
    || (method === "GET" && /^\/api\/sources\/[^/]+$/.test(pathname));
}

function normalizeRequestId(value) {
  const candidate = Array.isArray(value) ? value[0] : String(value || "");
  return /^[A-Za-z0-9._-]{1,128}$/.test(candidate) ? candidate : "";
}

function setSecurityHeaders(response) {
  response.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

function setCors(request, response) {
  const origin = request.headers.origin || "";
  if (origin.startsWith("chrome-extension://") || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Headers", "authorization, content-type, x-request-id");
  response.setHeader("Access-Control-Expose-Headers", "x-request-id");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

async function readJson(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function serveStatic(publicDir, pathname, response) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  const filename = path.resolve(publicDir, relative);
  if (!filename.startsWith(`${path.resolve(publicDir)}${path.sep}`) && filename !== path.join(path.resolve(publicDir), "index.html")) {
    return sendJson(response, 404, { error: "Not found." });
  }
  try {
    const stat = fs.statSync(filename);
    if (!stat.isFile()) throw new Error("not a file");
    response.writeHead(200, {
      "content-type": MIME[path.extname(filename)] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    fs.createReadStream(filename).pipe(response);
  } catch {
    const fallback = path.join(publicDir, "index.html");
    if (fs.existsSync(fallback)) {
      response.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-cache" });
      fs.createReadStream(fallback).pipe(response);
    } else {
      sendJson(response, 404, { error: "Not found." });
    }
  }
}

function serveMedia(mediaDir, basename, response) {
  if (!/^[A-Za-z0-9_-]+\.(?:png|jpe?g|webp)$/.test(basename)) return sendJson(response, 404, { error: "Not found." });
  const filename = path.join(path.resolve(mediaDir), basename);
  try {
    const stat = fs.statSync(filename);
    if (!stat.isFile()) throw new Error("not a file");
    response.writeHead(200, {
      "content-type": MIME[path.extname(filename).toLowerCase()] || "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    });
    fs.createReadStream(filename).pipe(response);
  } catch {
    sendJson(response, 404, { error: "Not found." });
  }
}

function limit(value) {
  return Math.max(1, Math.min(500, Number.parseInt(value || "100", 10) || 100));
}

if (import.meta.main) {
  const config = loadConfig();
  const app = createApplication(config);
  await app.start();
  app.logger.info("preview.ready", { url: `http://${config.host}:${config.port}` });
  const shutdown = async () => {
    await app.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
