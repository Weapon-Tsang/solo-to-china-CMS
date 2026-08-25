import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { openDatabase } from "./db.mjs";
import { normalizeXiaohongshuCapture, ValidationError } from "./adapters/xiaohongshu.mjs";
import { OpenAIExtractor } from "./ai/openai.mjs";
import { ContentEngine } from "./ai/content-engine.mjs";
import { Pipeline } from "./pipeline.mjs";
import { Repository } from "./repository.mjs";
import { WordPressDraftAdapter } from "./wordpress.mjs";
import { SearchConsoleAdapter } from "./search-console.mjs";
import { CommercialComposer, CommercialValidationError, normalizeCommercialOffer } from "./commercial.mjs";
import { MaintenanceScheduler } from "./maintenance.mjs";
import { createLogger } from "./logger.mjs";
import { ExceptionNotifier } from "./notifications.mjs";
import { VERSION } from "./version.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export function createApplication(config = loadConfig()) {
  if (!isLoopbackHost(config.host) && (!config.captureToken || !config.adminToken)) {
    throw new Error("Non-loopback HOST requires both CAPTURE_TOKEN and ADMIN_TOKEN.");
  }
  const logger = createLogger(config.logging);
  const db = openDatabase(config.databasePath);
  const repository = new Repository(db, { ...config.content, searchConsoleMinimumImpressions: config.searchConsole.minimumImpressions });
  const extractor = new OpenAIExtractor(config.openai);
  const contentEngine = new ContentEngine(config.openai);
  const wordpress = new WordPressDraftAdapter(config.wordpress);
  const searchConsole = new SearchConsoleAdapter(config.searchConsole);
  const commercialComposer = new CommercialComposer(config.commercial);
  const pipeline = new Pipeline(repository, extractor, {
    contentEngine, wordpress, searchConsole, commercialComposer, contentConfig: config.content,
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

      if (request.method === "GET" && url.pathname === "/api/health") {
        const telemetry = repository.jobTelemetry(config.telemetry.windowHours);
        return sendJson(response, 200, {
          ok: true,
          version: VERSION,
          aiConfigured: extractor.enabled,
          contentAutomationConfigured: contentEngine.enabled,
          wordpressConfigured: wordpress.enabled,
          searchConsoleConfigured: searchConsole.enabled,
          maintenanceEnabled: config.maintenance.enabled,
          notificationsConfigured: notifier.enabled,
          queueActive: telemetry.active,
        });
      }
      if (request.method === "GET" && url.pathname === "/api/ready") {
        db.prepare("SELECT 1 AS ready").get();
        return sendJson(response, 200, { ready: true, version: VERSION, database: "ready" });
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
        const source = repository.getSource(sourceMatch[1]);
        return source ? sendJson(response, 200, source) : sendJson(response, 404, { error: "Source not found." });
      }
      const retryMatch = url.pathname.match(/^\/api\/sources\/([^/]+)\/retry$/);
      if (request.method === "POST" && retryMatch) {
        authorizeAdmin(request, config.adminToken);
        const retried = repository.retrySource(retryMatch[1]);
        if (!retried) return sendJson(response, 404, { error: "Source not found." });
        void pipeline.runOne();
        return sendJson(response, 202, { queued: true });
      }
      if (request.method === "GET" && url.pathname === "/api/knowledge") {
        return sendJson(response, 200, { items: repository.getKnowledge() });
      }
      if (request.method === "GET" && url.pathname === "/api/editorial-blueprints") {
        return sendJson(response, 200, { items: repository.getEditorialBlueprints() });
      }
      if (request.method === "GET" && url.pathname === "/api/content") {
        return sendJson(response, 200, { items: repository.listContent() });
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
        authorizeAdmin(request, config.adminToken);
        return sendJson(response, 200, await maintenance.runDue({ force: true }));
      }
      const exceptionRetryMatch = url.pathname.match(/^\/api\/exceptions\/(.+)\/retry$/);
      if (request.method === "POST" && exceptionRetryMatch) {
        authorizeAdmin(request, config.adminToken);
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
        authorizeAdmin(request, config.adminToken);
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
        authorizeAdmin(request, config.adminToken);
        if (!searchConsole.enabled) return sendJson(response, 409, { error: "Search Console sync is not configured." });
        const jobId = repository.enqueueSearchConsoleSync(searchConsole.config.siteUrl, searchConsole.config.syncHours, true);
        void pipeline.runOne();
        return sendJson(response, 202, { queued: true, jobId });
      }
      if (request.method === "GET" && url.pathname === "/api/commercial/offers") {
        return sendJson(response, 200, { items: repository.listCommercialOffers() });
      }
      if (request.method === "POST" && url.pathname === "/api/commercial/offers") {
        authorizeAdmin(request, config.adminToken);
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
        authorizeAdmin(request, config.adminToken);
        if (!contentEngine.enabled) return sendJson(response, 409, { error: "OPENAI_API_KEY is required for content production." });
        const queued = repository.queueCandidate(generateMatch[1]);
        if (!queued) return sendJson(response, 409, { error: "Topic is missing or has already entered production." });
        void pipeline.runOne();
        return sendJson(response, 202, { queued: true });
      }
      const retryContentMatch = url.pathname.match(/^\/api\/topics\/([^/]+)\/retry$/);
      if (request.method === "POST" && retryContentMatch) {
        authorizeAdmin(request, config.adminToken);
        if (!contentEngine.enabled) return sendJson(response, 409, { error: "OPENAI_API_KEY is required for content production." });
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
        authorizeAdmin(request, config.adminToken);
        if (!wordpress.enabled) return sendJson(response, 409, { error: "WordPress delivery is not configured." });
        const draft = repository.getDraftPackage(wordpressMatch[1]);
        if (!draft?.review?.passed) return sendJson(response, 409, { error: "Draft must pass QA before WordPress delivery." });
        repository.enqueue("compose_commercial", wordpressMatch[1]);
        void pipeline.runOne();
        return sendJson(response, 202, { queued: true });
      }
      if (request.method === "POST" && url.pathname === "/api/pipeline/run-one") {
        authorizeAdmin(request, config.adminToken);
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

function authorizeAdmin(request, token) {
  authorize(request, token, "admin");
}

function authorize(request, token, label) {
  if (!token) return;
  const supplied = request.headers.authorization || "";
  const expected = `Bearer ${token}`;
  const valid = supplied.length === expected.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!valid) {
    const error = new Error(`Invalid ${label} token.`);
    error.statusCode = 401;
    throw error;
  }
}

function isLoopbackHost(host) {
  return ["127.0.0.1", "localhost", "::1"].includes(host);
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
