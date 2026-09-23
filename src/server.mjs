import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EXTRACTION_MODELS, loadConfig } from "./config.mjs";
import { openDatabase } from "./db.mjs";
import { normalizeXiaohongshuCapture, ValidationError } from "./adapters/xiaohongshu.mjs";
import { ManualSourceError, ManualSourceIngestor } from "./adapters/manual-source.mjs";
import { KimiExtractor } from "./ai/kimi.mjs";
import { ExtractionRouter } from "./ai/extraction-router.mjs";
import { priceModelAttempt } from "./ai/stage-policy.mjs";
import { ContentEngine } from "./ai/content-engine.mjs";
import { VertexImagen } from "./visuals/vertex-imagen.mjs";
import { Pipeline } from "./pipeline.mjs";
import { Repository } from "./repository.mjs";
import { decideRecommendationCommand, decideRecommendationsBulk } from "./services/recommendation-bulk.mjs";
import { groupProposals } from "./services/editorial-proposal.mjs";
import { contentRecoveryReport, executeContentRecovery } from "./services/content-recovery.mjs";
import { WordPressDraftAdapter } from "./wordpress.mjs";
import { SearchConsoleAdapter } from "./search-console.mjs";
import {
  CommercialComposer, CommercialValidationError, normalizeAffiliateAsset,
  normalizeAffiliateProviderAccount, normalizeCommercialEvent, normalizeCommercialOffer, normalizeCommissionRule,
} from "./commercial.mjs";
import { MaintenanceScheduler } from "./maintenance.mjs";
import { assertPublicationEligibility } from './publication-eligibility.mjs';
import { createMediaRequestExecutor } from './media-request-executor.mjs';
import { createLogger } from "./logger.mjs";
import { ExceptionNotifier } from "./notifications.mjs";
import { createAuth } from "./auth.mjs";
import { createLoginThrottle, resolveClientSource } from "./login-throttle.mjs";
import { FrontendContractConsumer, FrontendContractError } from "./frontend-contract.mjs";
import { getContentStrategyDocument } from "./content-strategy.mjs";
import { VERSION } from "./version.mjs";
import { ChunkedUploadManager } from "./chunked-upload.mjs";
import { CaptureUploadManager } from "./capture-upload.mjs";
import { CaptureMediaUploadManager } from "./capture-media-upload.mjs";
import { createSummaryCache } from './services/summary-cache.mjs';
import { prepareCaptureMedia } from './source-media-store.mjs';
import { applyDeliveryRefresh, planDeliveryRefresh } from './services/delivery-refresh.mjs';

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
  assertProductionDatabaseConfiguration(config);
  const logger = createLogger(config.logging);
  const processRole = config.processRole || 'all';
  const db = openDatabase(config.databasePath, { migrate: processRole !== 'api' });
  const auth = createAuth(db, config.auth);
  const loginThrottle = createLoginThrottle(config.auth.loginThrottle, { logger: logger.child({ component: "auth" }) });
  const repository = new Repository(db, {
    ...config.content, ...config.extraction, contentStrategy: config.contentStrategy,
    sourceUploadsDir: config.manualSources.uploadDir,
    generatedMediaDir: config.generatedMediaDir,
    sourceComplexityRouting: config.extraction.sourceComplexityRouting === true,
    searchConsoleMinimumImpressions: config.searchConsole.minimumImpressions,
    affiliateOpportunityThreshold: config.commercial.opportunityThreshold,
    affiliateLinkTaskThreshold: config.commercial.linkTaskThreshold,
    modelCredentialEncryptionKey: config.modelCredentials.encryptionKey,
    environmentCredentialProviders: [config.deepseek.apiKey && "deepseek", config.gemini.apiKey && "gemini", config.openai.apiKey && "openai"].filter(Boolean),
  });
  const selectedAi = repository.getAiSettings(config.ai.defaultModel);
  const aiRequestGate = createRequestGate(config.extraction.requestSpacingMs);
  const modelCallTelemetry = (metric) => repository.recordModelCall(priceModelAttempt(metric, config.ai.pricing));
  const legacyAi = { ...config.kimi, ...config.vertex, ...selectedAi,
    stagePolicy: config.ai.stagePolicy, pricing: config.ai.pricing,
    beforeRequest: aiRequestGate,
    onModelCall: modelCallTelemetry };
  const writingAi = { ...config.vertex, provider: "vertex", model: "gemini-3.8-flash", role: "writing",
    stagePolicy: config.ai.stagePolicy, pricing: config.ai.pricing, beforeRequest: aiRequestGate, onModelCall: modelCallTelemetry };
  const resolveExtractionConfig = (profile = {}) => {
    if (profile.provider === "deepseek") return { ...config.deepseek,
      model: profile.model || config.deepseek.model,
      apiKey: repository.readModelCredential("deepseek") || config.deepseek.apiKey, role: "extraction",
      stagePolicy: config.ai.stagePolicy, pricing: config.ai.pricing, beforeRequest: aiRequestGate, onModelCall: modelCallTelemetry };
    if (profile.provider === "openai") return { ...config.openai,
      model: profile.model || config.openai.model,
      apiKey: repository.readModelCredential("openai") || config.openai.apiKey, role: profile.role || "extraction",
      stagePolicy: config.ai.stagePolicy, pricing: config.ai.pricing, beforeRequest: aiRequestGate, onModelCall: modelCallTelemetry };
    if (profile.provider === "gemini") return { ...config.gemini,
      model: profile.model || config.gemini.model,
      apiKey: repository.readModelCredential("gemini") || config.gemini.apiKey, role: "extraction",
      stagePolicy: config.ai.stagePolicy, pricing: config.ai.pricing, beforeRequest: aiRequestGate, onModelCall: modelCallTelemetry };
    return legacyAi;
  };
  const selectedVisual = repository.getVisualSettings(config.visuals.defaultModel);
  const mediaRequestExecutor = createMediaRequestExecutor(db, {
    rpm: config.visuals.quotaRpm, windowMs: config.visuals.quotaWindowMs,
    safetyMarginMs: config.visuals.quotaSafetyMarginMs,
    maxDispatches: config.visuals.maxDispatchesPerStep,
  });
  const activeVisuals = { ...config.visuals, ...selectedVisual,
    mediaRequestExecutor,
    onModelCallStart: (metric) => repository.recordModelCall(priceModelAttempt(metric, config.ai.pricing)),
    onModelCall: (metric) => repository.recordModelCall(priceModelAttempt(metric, config.ai.pricing)),
    findVisualCandidate: (query) => repository.findReusableVisualCandidate(query),
    saveVisualCandidate: (candidate) => repository.saveVisualCandidate(candidate),
    updateVisualCandidate: (candidateId,update) => repository.updateVisualCandidate(candidateId,update),
    findVisualTranslationArtifact: (query) => repository.findVisualTranslationArtifact(query),
    saveVisualTranslationArtifact: (artifact) => repository.saveVisualTranslationArtifact(artifact),
  };
  const frontendContracts = new FrontendContractConsumer(repository, config.frontendContract);
  const manualSources = new ManualSourceIngestor(config.manualSources);
  const chunkedUploads = new ChunkedUploadManager(config.manualSources);
  const captureUploads = new CaptureUploadManager(config.captureUploads);
  const captureMediaUploads = new CaptureMediaUploadManager(config.captureMediaUploads);
  const dashboardSummaryCache = createSummaryCache();
  const extractor = new ExtractionRouter({ currentProfile: () => repository.modelProfileForRole("extraction"), resolveConfig: resolveExtractionConfig });
  const contentEngine = new ContentEngine(writingAi);
  const visualReviewer = new KimiExtractor({ ...writingAi, role: "visual_review", mediaRequestExecutor });
  const visuals = new VertexImagen(activeVisuals);
  const wordpress = new WordPressDraftAdapter(config.wordpress);
  wordpress.deliveryGuard = (draftId, options) => assertPublicationEligibility(db, draftId, options);
  repository.configureProductionCapabilities({
    frontendContract: frontendContracts.configured,
    visuals: visuals.enabled,
    wordpress: wordpress.enabled,
  });
  const searchConsole = new SearchConsoleAdapter(config.searchConsole);
  const commercialComposer = new CommercialComposer(config.commercial);
  const pipeline = new Pipeline(repository, extractor, {
    contentEngine, sourceEngine:extractor, visualReviewer, visuals, wordpress, searchConsole, commercialComposer, frontendContracts, contentConfig: config.content,
    extractionConfig: config.extraction,
    databasePath:config.databasePath,processIsolationEnabled:config.extraction.processIsolationEnabled,
    logger: logger.child({ component: "pipeline" }),
  });
  const runQueued = () => { if (processRole === 'all') void pipeline.runOne(); };
  const notifier = new ExceptionNotifier(repository, config.notifications);
  const maintenance = new MaintenanceScheduler(
    repository,
    pipeline,
    { ...config.maintenance, notificationIntervalMinutes: config.notifications.intervalMinutes, frontendContract: config.frontendContract },
    config.wordpress,
    { notifier, searchConsoleConfig: config.searchConsole, logger: logger.child({ component: "maintenance" }) },
  );
  if (processRole !== 'api' && wordpress.enabled) {
    repository.enqueueWordPressInventorySync(wordpress.config.siteUrl, wordpress.config.inventorySyncHours);
  }
  if (processRole !== 'api' && searchConsole.enabled) {
    repository.enqueueSearchConsoleSync(searchConsole.config.siteUrl, searchConsole.config.syncHours);
  }
  if (processRole !== 'api') repository.enqueueStartupReconciliation({ wordpressEnabled: wordpress.enabled, contractAware: frontendContracts.configured });
  // Legacy heavy-source gates are converted into a deterministic recovery manifest.
  // Execution remains opt-in; startup never enqueues historical work by itself.
  if (processRole !== 'api') repository.createLegacySourceRecoveryManifest({execute:false});
  if (processRole !== 'api' && frontendContracts.configured) repository.enqueue("sync_frontend_contract", "default");
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
        durationMs: Date.now() - requestStartedAt,responseBytes:response.responseBytes ?? null,
        rowCount:response.responseRowCount ?? null,cacheStatus:response.responseCacheStatus ?? null,
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
        const clientSource = resolveClientSource(request, config.auth.loginThrottle);
        const throttle = loginThrottle.check(payload.username, clientSource);
        if (!throttle.allowed) {
          response.setHeader("Retry-After", String(Math.max(1, Math.ceil(throttle.retryAfterMs / 1_000))));
          return sendJson(response, 429, { error: "Sign-in temporarily unavailable. Try again later.", retryAfterMs: throttle.retryAfterMs });
        }
        const session = await auth.login(payload.username, payload.password);
        if (!session) {
          const afterFailure = loginThrottle.recordFailure(payload.username, clientSource);
          if (!afterFailure.allowed) {
            response.setHeader("Retry-After", String(Math.max(1, Math.ceil(afterFailure.retryAfterMs / 1_000))));
            return sendJson(response, 429, { error: "Sign-in temporarily unavailable. Try again later.", retryAfterMs: afterFailure.retryAfterMs });
          }
          return sendJson(response, 401, { error: "Incorrect username or password." });
        }
        loginThrottle.recordSuccess(payload.username, clientSource);
        response.setHeader("Set-Cookie", session.cookie);
        return sendJson(response, 200, { authenticated: true, username: session.username, mustChangePassword: session.mustChangePassword });
      }
      if (!captureOnly && request.method === "POST" && url.pathname === "/api/auth/logout") {
        auth.logout(request);
        response.setHeader("Set-Cookie", auth.clearCookie());
        return sendJson(response, 204, {});
      }
      if (!captureOnly && request.method === "POST" && url.pathname === "/api/auth/change-password") {
        const payload = await readJson(request, 20_000);
        const session = await auth.changePassword(request, payload.currentPassword, payload.nextPassword);
        if (!session) return sendJson(response, 401, { error: "Current password is incorrect." });
        response.setHeader("Set-Cookie", session.cookie);
        return sendJson(response, 200, { authenticated: true, username: session.username, mustChangePassword: false });
      }
      if (!captureOnly && request.method === "POST" && url.pathname === "/api/auth/update-credentials") {
        const payload = await readJson(request, 20_000);
        const session = await auth.updateCredentials(request, payload.currentPassword, payload.nextUsername, payload.nextPassword);
        if (!session) return sendJson(response, 401, { error: "Current password is incorrect." });
        response.setHeader("Set-Cookie", session.cookie);
        return sendJson(response, 200, { authenticated: true, username: session.username, mustChangePassword: false });
      }
      if (!captureOnly && isDashboardApi(url.pathname) && !hasBearerToken(request, config.adminToken)) auth.require(request);

      if (request.method === "GET" && url.pathname === "/api/health") {
        const queueActive = Number(db.prepare("SELECT COUNT(*) n FROM jobs WHERE status IN ('queued','running')").get().n);
        const routing=repository.getModelRoutingSettings();
        const runtimeProfile=repository.modelProfileForRole("extraction");
        const providerRuntime=repository.providerRuntime({provider:runtimeProfile.provider,model:runtimeProfile.model,configured:extractor.enabled});
        return sendJson(response, 200, {
          ok: true,
          version: VERSION,
          serviceHealth: { ready:true,http:"ready",database:"ready",version:VERSION },
          aiConfiguration: { configured:extractor.enabled,provider:extractor.enabled?runtimeProfile.provider:null,
            model:extractor.enabled?runtimeProfile.model:null,credentialsConfigured:extractor.enabled,routingRevision:routing.revision },
          providerRuntime,
          queueHealth: { active:queueActive,queued:Number(db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='queued'").get().n),
            running:Number(db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='running'").get().n) },
          aiConfigured: extractor.enabled,
          aiProvider: extractor.enabled ? runtimeProfile.provider : null,
          aiModel: extractor.enabled ? runtimeProfile.model : null,
          vertexBatchConfigured: extractor.batchEnabled,
          vertexBatchActive: repository.activeVertexBatchCount(),
          visualProvider: visuals.enabled ? activeVisuals.provider : null,
          visualModel: visuals.enabled ? activeVisuals.model : null,
          contentStrategy: config.contentStrategy,
          frontendContract: frontendContracts.diagnostics(),
          contentAutomationConfigured: contentEngine.enabled,
          visualGenerationConfigured: visuals.enabled,
          wordpressConfigured: wordpress.enabled,
          searchConsoleConfigured: searchConsole.enabled,
          maintenanceEnabled: config.maintenance.enabled,
          notificationsConfigured: notifier.enabled,
          queueActive,
          captureMediaProtocol: { version: 2, resume: true, uploadCapability: true, maxBytes: captureMediaUploads.maxBytes },
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
          ai: repository.getModelRoutingSettings(),
          visual: repository.getVisualSettings(config.visuals.defaultModel),
          frontendContract: frontendContracts.diagnostics(),
        });
      }
      if (request.method === "GET" && url.pathname === "/api/settings/ai") {
        return sendJson(response, 200, {
          configured: extractor.enabled, vertexBatchConfigured: extractor.batchEnabled,
          vertexBatchActive: repository.activeVertexBatchCount(), visualGenerationConfigured: visuals.enabled, appVersion: VERSION,
          contentStrategy: config.contentStrategy, storage: storageInfo(config), visual: repository.getVisualSettings(config.visuals.defaultModel),
          frontendContract: frontendContracts.diagnostics(),
          ...repository.getAiSettings(config.ai.defaultModel), ...repository.getModelRoutingSettings(),
        });
      }
      if (request.method === "GET" && url.pathname === "/api/settings") {
        return sendJson(response, 200, {
          configured: extractor.enabled, vertexBatchConfigured: extractor.batchEnabled,
          vertexBatchActive: repository.activeVertexBatchCount(), visualGenerationConfigured: visuals.enabled, appVersion: VERSION,
          contentStrategy: config.contentStrategy, storage: storageInfo(config), visual: repository.getVisualSettings(config.visuals.defaultModel),
          frontendContract: frontendContracts.diagnostics(), ...repository.getAiSettings(config.ai.defaultModel), ...repository.getModelRoutingSettings(),
          operations: {
            counts: {
              systemHealth: repository.systemHealthIssueCount(),
              maintenance: repository.db.prepare("SELECT COUNT(*) AS count FROM maintenance_runs").get().count,
              wordpressInventory: repository.db.prepare("SELECT COUNT(*) AS count FROM wordpress_content_inventory").get().count,
              blueprints: repository.db.prepare("SELECT COUNT(*) AS count FROM editorial_blueprints").get().count,
              experiences: repository.db.prepare("SELECT COUNT(*) AS count FROM experience_blocks").get().count,
              failureLessons: repository.db.prepare("SELECT COUNT(*) AS count FROM failure_lessons").get().count,
              goldenArticles: repository.db.prepare("SELECT COUNT(*) AS count FROM golden_articles WHERE active=1").get().count,
              backfills: repository.db.prepare("SELECT COUNT(*) AS count FROM source_media_backfill_runs").get().count
                + repository.db.prepare("SELECT COUNT(*) AS count FROM system_backfill_runs").get().count,
            },
          },
        });
      }
      if (request.method === "GET" && url.pathname === "/api/settings/system-health") {
        return sendJson(response, 200, repository.listSystemHealthWorkspace(workspaceQuery(url, 100)));
      }
      if (request.method === "GET" && url.pathname === "/api/settings/maintenance") {
        return sendJson(response, 200, { runs:repository.listMaintenanceRuns(),telemetry:repository.jobTelemetry(config.telemetry.windowHours),
          favoritesSyncRuns:repository.listFavoritesSyncRuns(20),...repository.maintenanceOverview() });
      }
      if (request.method === "GET" && url.pathname === "/api/settings/wordpress-inventory") {
        return sendJson(response, 200, { items:repository.listWordPressInventory() });
      }
      if (request.method === "GET" && url.pathname === "/api/settings/blueprints") {
        return sendJson(response, 200, { items:repository.getEditorialBlueprints() });
      }
      if (request.method === "GET" && url.pathname === "/api/settings/experiences") {
        return sendJson(response, 200, { items:repository.listExperienceBlocks().slice(0,limit(url.searchParams.get("limit"))) });
      }
      if (request.method === "GET" && url.pathname === "/api/settings/failure-lessons") {
        return sendJson(response, 200, { items:repository.listFailureLessons(limit(url.searchParams.get("limit"))) });
      }
      if (request.method === "GET" && url.pathname === "/api/settings/golden-articles") {
        return sendJson(response, 200, { items:repository.db.prepare(`SELECT ga.* FROM golden_articles ga
          WHERE ga.active=1 ORDER BY ga.updated_at DESC LIMIT ?`).all(limit(url.searchParams.get("limit"))) });
      }
      if (request.method === "GET" && url.pathname === "/api/settings/backfills") {
        return sendJson(response, 200, { mediaBackfills:repository.db.prepare("SELECT * FROM source_media_backfill_runs ORDER BY updated_at DESC LIMIT 50").all(),
          systemBackfills:repository.listSystemBackfillRuns(50) });
      }
      if (request.method === "GET" && url.pathname === "/api/frontend-contract") {
        return sendJson(response, 200, { ...frontendContracts.diagnostics(), snapshots: repository.listFrontendContractSnapshots() });
      }
      if (request.method === "GET" && url.pathname === "/api/frontend-contract/capabilities") {
        const semantics = String(url.searchParams.get("semantics") || "").split(",").map((item) => item.trim()).filter(Boolean);
        return sendJson(response, 200, frontendContracts.capabilities({ semantics }));
      }
      if (request.method === "GET" && url.pathname === "/api/frontend-contract/compatibility") {
        return sendJson(response, 200, frontendContracts.compatibilityReport());
      }
      if (request.method === "GET" && url.pathname === "/api/frontend-contract/capability-requests") {
        return sendJson(response, 200, { items: repository.listFrontendCapabilityRequests() });
      }
      if (request.method === "POST" && url.pathname === "/api/frontend-contract/sync") {
        authorizeAdmin(request, config.adminToken, auth);
        if (!frontendContracts.configured) return sendJson(response, 409, { error: "Frontend Contract sources are not configured." });
        const jobId = repository.enqueue("sync_frontend_contract", "default");
        runQueued();
        return sendJson(response, 202, { queued: true, jobId });
      }
      const frontendContractAcceptMatch = url.pathname.match(/^\/api\/frontend-contract\/snapshots\/([^/]+)\/accept$/);
      if (request.method === "POST" && frontendContractAcceptMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        return sendJson(response, 200, frontendContracts.acceptMajorSnapshot(decodeURIComponent(frontendContractAcceptMatch[1])));
      }
      if (request.method === "POST" && url.pathname === "/api/settings/ai") {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 20_000);
        if (payload.model && !payload.provider) {
          const settings = repository.setAiModel(String(payload.model || ""), config.ai.defaultModel);
          return sendJson(response, 200, { legacy: true, ...settings });
        }
        const settings = repository.updateModelRouting({ provider:String(payload.provider || ""),apiKey:payload.apiKey,
          deleteKey:payload.deleteKey === true,activate:payload.activate === true,expectedRevision:Number(payload.expectedRevision),actor:auth.status(request)?.username || "admin" });
        return sendJson(response, 200, {
          configured: extractor.enabled, visualGenerationConfigured: visuals.enabled,
          visual: repository.getVisualSettings(config.visuals.defaultModel), ...settings,
        });
      }
      if(request.method==="POST"&&url.pathname==="/api/settings/ai/test-connection"){
        authorizeAdmin(request,config.adminToken,auth);
        const payload=await readJson(request,20_000);
        const provider=String(payload.provider || repository.getModelRoutingSettings().selectedProvider || "");
        if(!["deepseek","gemini","openai"].includes(provider))return sendJson(response,400,{error:"Select an extraction model for a manual connection test."});
        const profile={role:"extraction",provider,model:EXTRACTION_MODELS.find((item)=>item.provider===provider).model};
        try {
          const textResult=await extractor.testConnection({modelProfile:profile,telemetryContext:{role:"extraction"}});
          repository.recordModelCredentialValidation(provider,textResult.ok?"text_verified":"failed",{model:textResult.model,latencyMs:textResult.latencyMs});
          if(!textResult.ok)return sendJson(response,200,{ok:false,text:textResult,multimodal:null});
          const imageResult=await extractor.testImageConnection({modelProfile:profile,telemetryContext:{role:"extraction"}});
          repository.recordModelCredentialValidation(provider,imageResult.ok?"multimodal_verified":"failed",{
            model:imageResult.model,textLatencyMs:textResult.latencyMs,imageLatencyMs:imageResult.latencyMs});
          return sendJson(response,200,{ok:Boolean(textResult.ok&&imageResult.ok),text:textResult,multimodal:imageResult});
        } catch(error) {
          repository.recordModelCredentialValidation(provider,"failed",{code:error?.code||"TEST_FAILED",message:String(error?.message||error).slice(0,500)});
          throw error;
        }
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
      if (request.method === "POST" && url.pathname === "/api/captures/identity-check") {
        authorizeCapture(request, config.captureToken);
        const payload = await readJson(request, 100_000);
        if (!Array.isArray(payload.items) || payload.items.length > 100) {
          const error = new Error("Identity check requires an items array with at most 100 entries."); error.statusCode = 400; throw error;
        }
        return sendJson(response, 200, { items: repository.checkCaptureIdentities(payload.items) });
      }
      if (request.method === "POST" && url.pathname === "/api/capture-media-uploads") {
        authorizeCapture(request, config.captureToken);
        return sendJson(response, 201, await captureMediaUploads.create(await readJson(request, 20_000)));
      }
      const captureMediaChunkMatch = url.pathname.match(/^\/api\/capture-media-uploads\/([^/]+)\/chunks\/(\d+)$/);
      if (request.method === "PUT" && captureMediaChunkMatch) {
        authorizeCapture(request, config.captureToken);
        const bytes = await readBytes(request, config.captureMediaUploads.chunkBytes + 1024);
        return sendJson(response, 200, await captureMediaUploads.writeChunk(captureMediaChunkMatch[1], Number(captureMediaChunkMatch[2]), bytes, request.headers['x-upload-token']));
      }
      const captureMediaCompleteMatch = url.pathname.match(/^\/api\/capture-media-uploads\/([^/]+)\/complete$/);
      if (request.method === "POST" && captureMediaCompleteMatch) {
        authorizeCapture(request, config.captureToken);
        return sendJson(response, 200, await captureMediaUploads.complete(captureMediaCompleteMatch[1], request.headers['x-upload-token']));
      }
      const mediaStatusMatch = url.pathname.match(/^\/api\/capture-media-uploads\/([^/]+)$/);
      if (request.method === 'GET' && mediaStatusMatch) {
        authorizeCapture(request, config.captureToken);
        return sendJson(response, 200, await captureMediaUploads.status(mediaStatusMatch[1], request.headers['x-upload-token']));
      }
      if (request.method === "POST" && url.pathname === "/api/favorites-sync-runs") {
        authorizeCapture(request, config.captureToken);
        return sendJson(response, 200, repository.recordFavoritesSyncRun(await readJson(request, 100_000)));
      }
      if (request.method === "GET" && url.pathname === "/api/favorites-sync-runs") {
        if (captureOnly) authorizeCapture(request, config.captureToken);
        return sendJson(response, 200, { items: repository.listFavoritesSyncRuns(limit(url.searchParams.get("limit"))) });
      }
      if (request.method === "POST" && url.pathname === "/api/captures") {
        authorizeCapture(request, config.captureToken);
        const capture = await prepareCaptureMedia(normalizeXiaohongshuCapture(await readJson(request, 4_000_000)), config.manualSources.uploadDir);
        const saved = repository.saveCapture(capture);
        runQueued();
        return sendJson(response, saved.duplicate ? 200 : 202, saved);
      }
      if (request.method === "POST" && url.pathname === "/api/capture-uploads") {
        authorizeCapture(request, config.captureToken);
        return sendJson(response, 201, captureUploads.create(await readJson(request, 20_000)));
      }
      const captureChunkMatch = url.pathname.match(/^\/api\/capture-uploads\/([^/]+)\/chunks\/(\d+)$/);
      if (request.method === "PUT" && captureChunkMatch) {
        authorizeCapture(request, config.captureToken);
        const bytes = await readBytes(request, config.captureUploads.chunkBytes + 1024);
        return sendJson(response, 200, captureUploads.writeChunk(captureChunkMatch[1], Number(captureChunkMatch[2]), bytes));
      }
      const captureCompleteMatch = url.pathname.match(/^\/api\/capture-uploads\/([^/]+)\/complete$/);
      if (request.method === "POST" && captureCompleteMatch) {
        authorizeCapture(request, config.captureToken);
        await readJson(request, 20_000);
        const assembled = captureUploads.complete(captureCompleteMatch[1]);
        try {
          const capture = await prepareCaptureMedia(normalizeXiaohongshuCapture(assembled.payload), config.manualSources.uploadDir);
          const saved = repository.saveCapture(capture);
          runQueued();
          return sendJson(response, saved.duplicate ? 200 : 202, saved);
        } finally { assembled.cleanup(); }
      }
      if (request.method === "POST" && url.pathname === "/api/manual-sources") {
        authorizeAdmin(request, config.adminToken, auth);
        const maxBodyBytes = Math.ceil(config.manualSources.maxTotalBytes * 1.4) + 250_000;
        const prepared = await manualSources.prepare(await readJson(request, maxBodyBytes));
        let saved;
        try {
          saved = repository.saveCapture(prepared.capture);
        } catch (error) {
          prepared.cleanup();
          throw error;
        }
        if (saved.duplicate) prepared.cleanup();
        runQueued();
        return sendJson(response, saved.duplicate ? 200 : 202, {
          ...saved,
          sourceKind: prepared.capture.sourceKind,
          warnings: prepared.warnings,
          message: saved.duplicate ? "该来源版本已存在，未重复排队。"
            : saved.hardLimitBlocked ? "来源已安全保存，但超过明确的硬限制；请在来源详情中查看限制原因。"
              : "来源已安全保存并进入提取、知识整理和内容评估流程。",
        });
      }
      if (request.method === "POST" && url.pathname === "/api/manual-source-uploads") {
        authorizeAdmin(request, config.adminToken, auth);
        return sendJson(response, 201, chunkedUploads.create(await readJson(request, 20_000)));
      }
      const uploadChunkMatch = url.pathname.match(/^\/api\/manual-source-uploads\/([^/]+)\/chunks\/(\d+)$/);
      if (request.method === "PUT" && uploadChunkMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const bytes = await readBytes(request, 6 * 1024 * 1024);
        return sendJson(response, 200, chunkedUploads.writeChunk(uploadChunkMatch[1], Number(uploadChunkMatch[2]), bytes));
      }
      const uploadCompleteMatch = url.pathname.match(/^\/api\/manual-source-uploads\/([^/]+)\/complete$/);
      if (request.method === "POST" && uploadCompleteMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const prepared = chunkedUploads.complete(uploadCompleteMatch[1], await readJson(request, 2_000_000));
        let saved;
        try { saved = repository.saveCapture(prepared.capture); } catch (error) { prepared.cleanup(); throw error; }
        if (saved.duplicate) prepared.cleanup();
        runQueued();
        return sendJson(response, saved.duplicate ? 200 : 202, { ...saved, sourceKind: "video", warnings: prepared.warnings,
          message: saved.duplicate ? "该来源已存在，未重复排队。" : "视频已完整保存并进入 Strategy 1.4 分段提取流程。" });
      }
      if (request.method === "GET" && url.pathname === "/api/dashboard") {
        const dashboard = repository.dashboard();
        const contractStatus = frontendContracts.diagnostics().status;
        dashboard.actionCounts.settings = (extractor.enabled ? 0 : 1)
          + (["major_mismatch", "invalid"].includes(contractStatus) ? 1 : 0);
        return sendJson(response, 200, dashboard);
      }
      if (request.method === "GET" && url.pathname === "/api/dashboard/summary") {
        const dashboard = dashboardSummaryCache.read(() => repository.dashboardSummary(),
          db.prepare('PRAGMA data_version').get().data_version);
        const contractStatus = frontendContracts.diagnostics().status;
        dashboard.actionCounts.settings = (extractor.enabled ? 0 : 1)
          + (["major_mismatch", "invalid"].includes(contractStatus) ? 1 : 0);
        return sendJson(response, 200, dashboard);
      }
      if (request.method === "GET" && url.pathname === "/api/sources") {
        return sendJson(response, 200, repository.listSourcesPage({ limit:limit(url.searchParams.get('limit') || '20'),
          cursor:url.searchParams.get('cursor') || '', status:url.searchParams.get('status') || '',
          search:url.searchParams.get('search') || '' }));
      }
      if (request.method === "GET" && url.pathname === "/api/sources/status") {
        const ids=String(url.searchParams.get("ids")||"").split(",").map((value)=>value.trim()).filter(Boolean);
        return sendJson(response,200,{items:repository.listSourceStatusProjection({ids,limit:limit(url.searchParams.get("limit"))})});
      }
      if (request.method === "POST" && url.pathname === "/api/backfills/media") {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 20_000);
        const result = repository.enqueueMediaDurabilityBackfill({ dryRun: payload.dryRun !== false });
        if (!result.dryRun && result.queued) runQueued();
        return sendJson(response, result.dryRun ? 200 : 202, result);
      }
      const systemBackfillMatch = url.pathname.match(/^\/api\/backfills\/(experience|recommendations|failed-production-cleanup|knowledge-resolution)$/);
      if (request.method === "POST" && systemBackfillMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 20_000);
        const options = {dryRun:payload.dryRun !== false,approvedFromRunId:payload.approvedFromRunId || null};
        const result = systemBackfillMatch[1] === "experience" ? repository.runExperienceBackfill(options)
          : systemBackfillMatch[1] === "recommendations" ? repository.runRecommendationReconciliationBackfill(options)
            : systemBackfillMatch[1] === "knowledge-resolution" ? repository.runKnowledgeResolutionBackfill(options)
              : repository.runFailedProductionCleanupBackfill(options);
        if (!result.dryRun && result.queued) runQueued();
        return sendJson(response,result.dryRun ? 200 : 202,result);
      }
      if(request.method==="POST"&&url.pathname==="/api/backfills/processing-gaps"){
        authorizeAdmin(request,config.adminToken,auth);
        const payload=await readJson(request,20_000);
        const result=repository.runSourceProcessingGapRecovery({dryRun:payload.dryRun!==false,approvedFromRunId:payload.approvedFromRunId||null});
        if(!result.dryRun&&result.queued)runQueued();
        return sendJson(response,result.dryRun?200:202,result);
      }
      if(request.method==="GET"&&url.pathname==="/api/knowledge/resolution-status"){
        authorizeAdmin(request,config.adminToken,auth);
        return sendJson(response,200,repository.getKnowledgeResolutionStatus(url.searchParams.get("destination")||null));
      }
      if(request.method==="GET"&&url.pathname==="/api/knowledge/resolution-history"){
        authorizeAdmin(request,config.adminToken,auth);
        return sendJson(response,200,{items:repository.listKnowledgeResolutionHistory({
          destinationSlug:url.searchParams.get("destination")||null,limit:limit(url.searchParams.get("limit"))})});
      }
      if(request.method==="GET"&&url.pathname==="/api/knowledge/verification-jobs"){
        authorizeAdmin(request,config.adminToken,auth);
        return sendJson(response,200,{items:repository.listKnowledgeVerificationJobs({destinationSlug:url.searchParams.get("destination")||null,
          status:url.searchParams.get("status")||"",limit:limit(url.searchParams.get("limit"))})});
      }
      const verificationActionMatch=url.pathname.match(/^\/api\/knowledge\/verification-jobs\/([^/]+)\/(retry|complete)$/);
      if(request.method==="POST"&&verificationActionMatch){
        authorizeAdmin(request,config.adminToken,auth);
        const payload=await readJson(request,20_000);
        const result=repository.updateKnowledgeVerificationJob(decodeURIComponent(verificationActionMatch[1]),{
          action:verificationActionMatch[2],result:payload.result||{}});
        return result?sendJson(response,200,result):sendJson(response,404,{error:"Verification job not found."});
      }
      const sourceAssetPreviewMatch = url.pathname.match(/^\/api\/source-assets\/([^/]+)\/preview$/);
      if (request.method === "GET" && sourceAssetPreviewMatch) {
        const asset = repository.getSourceAssetPreview(decodeURIComponent(sourceAssetPreviewMatch[1]));
        if (!asset) return sendJson(response, 404, { error: "没有找到这张来源图片。" });
        return serveSourceAssetPreview(asset, response, config.manualSources.uploadDir);
      }
      const sourceVersionMatch = url.pathname.match(/^\/api\/sources\/([^/]+)\/versions\/(\d+)$/);
      if (request.method === 'GET' && sourceVersionMatch) {
        const version=repository.getSourceCaptureVersion(decodeURIComponent(sourceVersionMatch[1]),Number(sourceVersionMatch[2]));
        if(!version)return sendJson(response,404,{error:'Source capture version not found.'});
        const {raw_payload_json,assets_json,assetSnapshots,...publicVersion}=version;
        return sendJson(response,200,{...publicVersion,
          assets:version.assets.map(({local_path,ai_derivative_data_url,...asset})=>({...asset,previewUrl:`/api/source-assets/${encodeURIComponent(asset.id)}/preview`})),
          files:version.files.map(({storage_path,...file})=>file),
          snapshotAssetCount:assetSnapshots.length});
      }
      const sourceMatch = url.pathname.match(/^\/api\/sources\/([^/]+)$/);
      if (request.method === "DELETE" && sourceMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const deleted = repository.deleteSource(decodeURIComponent(sourceMatch[1]),
          auth.status(request)?.username || 'administrator');
        return deleted ? sendJson(response, 200, deleted) : sendJson(response, 404, { error: 'Source not found.' });
      }
      if (request.method === 'POST' && url.pathname === '/api/backfills/source-photo-audit') {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 20_000);
        const dryRun = payload.dryRun !== false;
        const assetIds = repository.enqueueSourcePhotoAudits(payload.sourceId || null,
          { limit: Math.min(2000, Math.max(1, Number(payload.limit || 100))), dryRun, priority:70 });
        if (!dryRun && assetIds.length) runQueued();
        return sendJson(response, dryRun ? 200 : 202,
          { dryRun, queued: dryRun ? 0 : assetIds.length, candidateCount:assetIds.length,
            assetIds:dryRun ? assetIds : undefined });
      }
      if (request.method === 'POST' && url.pathname === '/api/backfills/article-photo-refresh') {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 30_000);
        const draftIds = Array.isArray(payload.draftIds) ? payload.draftIds : [];
        const result = payload.apply === true
          ? repository.applyArticlePhotoRefresh(draftIds, String(payload.confirmation || ''), auth?.subject || 'administrator')
          : repository.planArticlePhotoRefresh(draftIds);
        if (result.mode === 'apply' && result.queued.length) runQueued();
        return sendJson(response, result.mode === 'apply' ? 202 : 200, result);
      }
      if (request.method === "GET" && sourceMatch) {
        if (captureOnly) authorizeCapture(request, config.captureToken);
        const source = repository.getSource(sourceMatch[1]);
        return source ? sendJson(response, 200, {...sourceForApi(source),
          status_projection:repository.listSourceStatusProjection({ids:[source.id]})[0]||null,
          timeline:repository.sourceTimeline(source.id,100)}) : sendJson(response, 404, { error: "Source not found." });
      }
      const sourceTimelineMatch=url.pathname.match(/^\/api\/sources\/([^/]+)\/timeline$/);
      if(request.method==="GET"&&sourceTimelineMatch){
        return sendJson(response,200,{items:repository.sourceTimeline(decodeURIComponent(sourceTimelineMatch[1]),limit(url.searchParams.get("limit")))});
      }
      const sourceRepairManifestMatch = url.pathname.match(/^\/api\/sources\/([^/]+)\/repair-manifest$/);
      if (request.method === "GET" && sourceRepairManifestMatch) {
        const manifest = repository.mediaRepairManifest(decodeURIComponent(sourceRepairManifestMatch[1]));
        return manifest ? sendJson(response, 200, manifest) : sendJson(response, 404, { error: "Source not found." });
      }
      const segmentCoverageReviewMatch = url.pathname.match(/^\/api\/sources\/([^/]+)\/segments\/([^/]+)\/coverage-review$/);
      if (request.method === "POST" && segmentCoverageReviewMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 20_000);
        const result = repository.reviewSegmentCoverage(
          decodeURIComponent(segmentCoverageReviewMatch[1]),
          decodeURIComponent(segmentCoverageReviewMatch[2]),
          { decision: String(payload.decision || ""), note: payload.note || "", operator: auth.status(request).username || "administrator" },
        );
        if (!result) return sendJson(response, 404, { error: "Source segment or coverage review was not found." });
        runQueued();
        return sendJson(response, 202, result);
      }
      const sourceEvidenceReviewMatch = url.pathname.match(/^\/api\/sources\/([^/]+)\/evidence-review$/);
      if (request.method === "POST" && sourceEvidenceReviewMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 20_000);
        const result = repository.reviewSourceEvidence(decodeURIComponent(sourceEvidenceReviewMatch[1]), {
          decision: String(payload.decision || ""),
          authorityLevel: payload.authorityLevel,
          verifiedAt: payload.verifiedAt,
          note: payload.note || "",
          operator: auth.status(request).username || "administrator",
        });
        if (!result) return sendJson(response, 404, { error: "Source not found." });
        runQueued();
        return sendJson(response, 202, result);
      }
      const sourceEvidenceHistoryMatch = url.pathname.match(/^\/api\/sources\/([^/]+)\/evidence-reviews$/);
      if (request.method === "GET" && sourceEvidenceHistoryMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        return sendJson(response, 200, { items: repository.listSourceEvidenceReviews(decodeURIComponent(sourceEvidenceHistoryMatch[1])) });
      }
      const retryMatch = url.pathname.match(/^\/api\/sources\/([^/]+)\/retry$/);
      if (request.method === "POST" && retryMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const retried = repository.retrySource(retryMatch[1]);
        if (!retried) return sendJson(response, 404, { error: "Source not found." });
        runQueued();
        return sendJson(response, 202, { queued: true });
      }
      if (request.method === "GET" && url.pathname === "/api/knowledge") {
        return sendJson(response, 200, repository.listKnowledgeFacts({
          destination:url.searchParams.get("destination") || "",subjectKey:url.searchParams.get("subject") || "",
          theme:url.searchParams.get("theme") || "",conflictOnly:url.searchParams.get("conflicts") === "1",
          limit:limit(url.searchParams.get("limit")),cursor:url.searchParams.get("cursor") || "",
        }));
      }
      if (request.method === "GET" && url.pathname === "/api/knowledge/summary") {
        return sendJson(response, 200, repository.knowledgeSummary({ destination:url.searchParams.get("destination") || "" }));
      }
      if (request.method === "GET" && url.pathname === "/api/knowledge/subjects") {
        return sendJson(response, 200, repository.listKnowledgeSubjects({ destination:url.searchParams.get("destination") || "",
          search:url.searchParams.get("search") || "",limit:limit(url.searchParams.get("limit")),cursor:url.searchParams.get("cursor") || "" }));
      }
      if (request.method === "GET" && url.pathname === "/api/knowledge/reviews") {
        return sendJson(response, 200, repository.listKnowledgeReviews({ destination:url.searchParams.get("destination") || "",
          limit:limit(url.searchParams.get("limit")),cursor:url.searchParams.get("cursor") || "" }));
      }
      if (request.method === "GET" && url.pathname === "/api/knowledge/entity-aliases") {
        const destination = String(url.searchParams.get("destination") || "").trim();
        return sendJson(response, 200, {
          aliases: repository.listEntityAliases(destination || null),
          candidates: repository.listEntityMergeCandidates(),
          relations: repository.listEntityRelations(destination || null),
          mergeHistory: repository.listEntityMergeHistory(destination || null),
        });
      }
      if (request.method === "POST" && url.pathname === "/api/knowledge/entity-aliases/reconcile") {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 20_000);
        const destination = String(payload.destinationSlug || "").trim();
        const queued = destination ? Boolean(repository.enqueue("resolve_entities", destination)) : repository.enqueueEntityResolutionForAllDestinations() > 0;
        if (queued) runQueued();
        return sendJson(response, 202, { queued, destinationSlug: destination || null });
      }
      const entityCandidateDecisionMatch = url.pathname.match(/^\/api\/knowledge\/entity-aliases\/candidates\/([^/]+)\/decision$/);
      if (request.method === "POST" && entityCandidateDecisionMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 20_000);
        const result = repository.decideEntityMergeCandidate(decodeURIComponent(entityCandidateDecisionMatch[1]), String(payload.decision || ""), {
          relationType: payload.relationType, reason: payload.reason, operator: payload.operator || "administrator",
        });
        if (!result) return sendJson(response, 404, { error: "Entity alias candidate not found or already decided." });
        runQueued();
        return sendJson(response, 200, result);
      }
      const entityMergeUndoMatch = url.pathname.match(/^\/api\/knowledge\/entity-merges\/([^/]+)\/undo$/);
      if (request.method === "POST" && entityMergeUndoMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const result = repository.undoEntityMerge(decodeURIComponent(entityMergeUndoMatch[1]));
        if (!result) return sendJson(response, 404, { error: "Active entity merge history not found." });
        runQueued();
        return sendJson(response, 200, result);
      }
      const claimReviewDecisionMatch = url.pathname.match(/^\/api\/knowledge\/claim-reviews\/([^/]+)\/decision$/);
      if (request.method === "POST" && claimReviewDecisionMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 20_000);
        const result = repository.decideClaimReviewCase(decodeURIComponent(claimReviewDecisionMatch[1]), String(payload.decision || ""), payload.note || "");
        if (!result) return sendJson(response, 404, { error: "Pending claim review not found." });
        return sendJson(response, 200, result);
      }
      const lunaReviewMatch = url.pathname.match(/^\/api\/knowledge\/claim-reviews\/([^/]+)\/luna-review$/);
      if (request.method === "POST" && lunaReviewMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const caseId=decodeURIComponent(lunaReviewMatch[1]);
        const evidence=repository.getLunaDisputePackage(caseId);
        if(!evidence)return sendJson(response,404,{error:"Pending claim review not found."});
        if(!repository.hasModelCredential("openai"))return sendJson(response,409,{error:"Configure the GPT-5.6 Luna API key before requesting a manual dispute review."});
        const profile={role:"dispute_review",provider:"openai",model:"gpt-5.6-luna"};
        const existing=db.prepare("SELECT * FROM luna_dispute_reviews WHERE issue_key=? AND evidence_hash=? AND status='succeeded'").get(caseId,evidence.evidenceHash);
        if(existing)return sendJson(response,200,{id:existing.id,status:existing.status,result:JSON.parse(existing.result_json),reused:true});
        const reviewed=await extractor.reviewDispute(evidence,{modelProfile:profile,telemetryContext:{role:"dispute_review",entityId:caseId}});
        return sendJson(response,200,repository.saveLunaDisputeReview(caseId,evidence,reviewed.output,profile));
      }
      const knowledgeResolutionMatch = url.pathname.match(/^\/api\/knowledge\/([^/]+)\/resolve$/);
      if (request.method === "POST" && knowledgeResolutionMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 20_000);
        const resolved = repository.resolveKnowledgeConflict(decodeURIComponent(knowledgeResolutionMatch[1]), payload.preferredValue, payload.note || "",payload.resolutionType || "preferred_value");
        if (!resolved) return sendJson(response, 404, { error: "Knowledge conflict not found or already resolved." });
        return sendJson(response, 200, resolved);
      }
      if (request.method === "GET" && url.pathname === "/api/editorial-blueprints") {
        return sendJson(response, 200, { items: repository.getEditorialBlueprints() });
      }
      if (request.method === "GET" && url.pathname === "/api/content") {
        const cursor = url.searchParams.get("cursor") || "0";
        if (!/^(0|[1-9]\d{0,8})$/.test(cursor)) return sendJson(response, 400, { error: "Invalid content cursor." });
        return sendJson(response, 200, repository.listContentWorkspace({ productionOnly: true,
          limit: Math.min(100, limit(url.searchParams.get("limit") || "20")), offset: Number(cursor), compact: true }));
      }
      const productionDetailMatch = url.pathname.match(/^\/api\/content\/([^/]+)\/production-state$/);
      if (request.method === "GET" && productionDetailMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const detail = repository.getContentProductionDetail(decodeURIComponent(productionDetailMatch[1]));
        if (!detail) return sendJson(response, 404, { error: "Content production record not found." });
        const blocker=unresolvedMediaBudgetFailure(db,detail);
        const budgets = detail.draft_id ? db.prepare(`SELECT DISTINCT md.visual_id,md.substage FROM media_dispatches md
          JOIN article_visuals av ON av.id=md.visual_id WHERE av.draft_id=? ORDER BY md.visual_id,md.substage`)
          .all(detail.draft_id).map((row) => {
            return {...mediaRequestExecutor.budget({visualId:row.visual_id,substage:row.substage}),
              grantable:Boolean(blocker && (!blocker.visual_id || blocker.visual_id===row.visual_id)
                && (!blocker.substage || blocker.substage===row.substage))};
          }) : [];
        return sendJson(response, 200, {...detail,media_budgets:budgets});
      }
      const mediaGrantMatch = url.pathname.match(/^\/api\/content\/([^/]+)\/media-budget-grants$/);
      if (request.method === "POST" && mediaGrantMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const detail = repository.getContentProductionDetail(decodeURIComponent(mediaGrantMatch[1]));
        if (!detail) return sendJson(response, 404, {error:"Content production record not found."});
        const payload = await readJson(request, 4_000);
        const visualId = String(payload.visualId || '');
        const substage = String(payload.substage || '');
        const visual = db.prepare('SELECT id,status FROM article_visuals WHERE id=? AND draft_id=?').get(visualId,detail.draft_id);
        const blocker=unresolvedMediaBudgetFailure(db,detail);
        if (!visual || !['planned','failed'].includes(visual.status)
          || !blocker || blocker.visual_id && blocker.visual_id!==visualId
          || blocker?.substage && blocker.substage!==substage) {
          return sendJson(response, 409, {error:'Media grant requires the current failed visual and exact exhausted substage.'});
        }
        const result = mediaRequestExecutor.grant({visualId,substage,
          additionalDispatches:payload.additionalDispatches,actor:auth.status(request).username || 'administrator',
          reason:payload.reason,idempotencyKey:request.headers['idempotency-key'] || payload.idempotencyKey});
        return sendJson(response, 200, {...result,opportunity_id:detail.opportunity_id});
      }
      const qaReconcileMatch = url.pathname.match(/^\/api\/content\/([^/]+)\/visual-qa-reconciliation$/);
      if (request.method === 'POST' && qaReconcileMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const detail = repository.getContentProductionDetail(decodeURIComponent(qaReconcileMatch[1]));
        if (!detail?.draft_id || !detail?.opportunity_id) {
          return sendJson(response, 404, {error:'Content production record was not found.'});
        }
        const payload=await readJson(request,4_000);
        const result=mediaRequestExecutor.reconcileUnknownQa({opportunityId:detail.opportunity_id,
          visualId:String(payload.visualId || ''),candidateId:String(payload.candidateId || ''),
          candidateHash:String(payload.candidateHash || ''),dispatchId:String(payload.dispatchId || ''),
          actor:auth.status(request).username || 'administrator',reason:String(payload.reason || ''),
          idempotencyKey:request.headers['idempotency-key'] || payload.idempotencyKey});
        return sendJson(response,200,{...result,opportunity_id:detail.opportunity_id,
          next_action:'retry_failed_stage',stage:'generate_visuals'});
      }
      const productionHistoryMatch = url.pathname.match(/^\/api\/content\/([^/]+)\/history$/);
      if (request.method === "GET" && productionHistoryMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const items = repository.listProductionRecordHistory(decodeURIComponent(productionHistoryMatch[1]));
        return items ? sendJson(response, 200, { items }) : sendJson(response, 404, { error: "Content production record not found." });
      }
      const productionRecoverMatch = url.pathname.match(/^\/api\/content\/([^/]+)\/recover$/);
      if (request.method === "POST" && productionRecoverMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 50_000);
        const result = executeContentRecovery(repository, decodeURIComponent(productionRecoverMatch[1]), payload,
          auth.status(request).username || "administrator");
        if (result?.queued) runQueued();
        return result ? sendJson(response, result.queued ? 202 : 200, result) : sendJson(response, 404, { error: "Content production record not found." });
      }
      const productionArchiveMatch = url.pathname.match(/^\/api\/content\/([^/]+)\/archive$/);
      if (request.method === "POST" && productionArchiveMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 20_000);
        const result = repository.archiveProductionRecord(decodeURIComponent(productionArchiveMatch[1]), {
          actor: auth.status(request).username || "administrator", reason: String(payload.reason || ""),
          idempotencyKey: request.headers["idempotency-key"] || payload.idempotency_key || null,
        });
        return result ? sendJson(response, 200, result) : sendJson(response, 404, { error: "Content production record not found." });
      }
      const productionRestoreMatch = url.pathname.match(/^\/api\/content\/([^/]+)\/restore$/);
      if (request.method === "POST" && productionRestoreMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 20_000);
        const result = repository.restoreProductionRecord(decodeURIComponent(productionRestoreMatch[1]), {
          actor: auth.status(request).username || "administrator", reason: String(payload.reason || ""),
          idempotencyKey: request.headers["idempotency-key"] || payload.idempotency_key || null,
        });
        return result ? sendJson(response, 200, result) : sendJson(response, 404, { error: "Content production record not found." });
      }
      const productionDeleteMatch = url.pathname.match(/^\/api\/content\/([^/]+)\/production-record$/);
      if (request.method === "DELETE" && productionDeleteMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 20_000);
        const result = repository.deleteProductionRecord(decodeURIComponent(productionDeleteMatch[1]), {
          actor: auth.status(request).username || "administrator", reason: String(payload.reason || ""),
          idempotencyKey: request.headers["idempotency-key"] || payload.idempotency_key || null,
        });
        return result ? sendJson(response, 200, result) : sendJson(response, 404, { error: "Content production record not found." });
      }
      if (request.method === "GET" && url.pathname === "/api/recommendations") {
        const pageSize=Math.min(100,limit(url.searchParams.get("limit") || '20'));
        const offset=Math.max(0,Number.parseInt(url.searchParams.get("cursor") || "0",10) || 0);
        const inbox = repository.listRecommendationInbox(pageSize + 1,{reconcile:false,cursor:offset});
        const items=inbox.slice(0,pageSize).map((item) => ({
          id:item.id,title:item.title,destination_name:item.destination_name,destination_slug:item.destination_slug,
          source_id:item.source_id,source_title:item.source_title,content_type:item.content_type,
          status:item.status,lifecycle_state:item.lifecycle_state,processing_state:item.processing_state,
          seo_action:item.seo_action,readiness_score:item.readiness_score,
          readiness:{ready:Boolean(item.readiness?.ready),blockingRequirements:item.readiness?.blockingRequirements || []},
          displayStatus:item.displayStatus,productionTypeLabel:item.productionTypeLabel,
          recommendationReason:item.recommendationReason,previousFailureSummary:item.previousFailureSummary,
        }));
        return sendJson(response, 200, { items,
          comparisonGroups: groupProposals(inbox),
          nextCursor:inbox.length>pageSize ? String(offset+pageSize) : null,
          summary: {
            recommendations: repository.db.prepare('SELECT count(*) n FROM content_recommendations').get().n,
            pending: repository.db.prepare("SELECT count(*) n FROM content_recommendations WHERE decision='pending'").get().n,
            opportunities: repository.db.prepare(`SELECT count(*) n FROM content_opportunities
              WHERE recommendation_id IS NULL OR approved_at IS NOT NULL OR candidate_id IS NOT NULL
                OR status IN ('approved_waiting_for_evidence','approved_ready','producing','drafted','qa_failed','ready_for_wordpress','wordpress_draft','suppressed')`).get().n,
            approved: repository.db.prepare('SELECT count(*) n FROM content_opportunities WHERE approved_at IS NOT NULL').get().n,
            internalOpportunities: repository.db.prepare("SELECT COUNT(*) n FROM content_opportunities WHERE inbox_state='INTERNAL' AND lifecycle_state IN ('recommended','recommended_again','deferred')").get().n,
            actionableInbox: repository.db.prepare("SELECT COUNT(*) n FROM content_opportunities WHERE inbox_state='ACTIONABLE' AND lifecycle_state IN ('recommended','recommended_again','deferred')").get().n,
            processingGap: repository.db.prepare("SELECT COUNT(*) n FROM content_opportunities WHERE inbox_state='INTERNAL' AND processing_state='PROCESSING_GAP' AND lifecycle_state IN ('recommended','recommended_again','deferred')").get().n,
            evidenceGap: repository.db.prepare("SELECT COUNT(*) n FROM content_opportunities WHERE processing_state='EVIDENCE_GAP' AND lifecycle_state IN ('recommended','recommended_again','deferred')").get().n,
            merged: repository.db.prepare("SELECT COUNT(*) n FROM content_opportunities WHERE inbox_state='MERGED' AND lifecycle_state IN ('recommended','recommended_again','deferred')").get().n,
            superseded: repository.db.prepare("SELECT COUNT(*) n FROM content_opportunities WHERE inbox_state='SUPERSEDED' AND lifecycle_state IN ('recommended','recommended_again','deferred')").get().n,
          } });
      }
      const opportunityDecisionMatch = url.pathname.match(/^\/api\/opportunities\/([^/]+)\/decision$/);
      if (request.method === "POST" && opportunityDecisionMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 20_000);
        const result = repository.decideOpportunity(decodeURIComponent(opportunityDecisionMatch[1]), String(payload.decision || ""), payload.note || "");
        if (!result) return sendJson(response, 404, { error: "Content opportunity not found." });
        if (result.queued) runQueued();
        return sendJson(response, result.queued ? 202 : 200, result);
      }
      if (request.method === "POST" && url.pathname === "/api/opportunities/bulk-decision") {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 100_000);
        const ids = [...new Set(Array.isArray(payload.ids) ? payload.ids.map(String) : [])];
        if (!ids.length || ids.length > 100) return sendJson(response, 400, { error: "Choose 1-100 opportunity IDs." });
        const results = ids.map((opportunityId) => {
          try { return { ok:true,...repository.decideOpportunity(opportunityId,String(payload.decision || ""),payload.note || "") }; }
          catch (error) { return { ok:false,opportunityId,error:error.message }; }
        });
        const queued = results.filter((item) => item.queued).length;
        if (queued) runQueued();
        return sendJson(response, 200, { processed:results.filter((item) => item.ok).length,failed:results.filter((item) => !item.ok).length,queued,results });
      }
      const opportunityLifecycleMatch = url.pathname.match(/^\/api\/opportunities\/([^/]+)\/lifecycle$/);
      if (request.method === "POST" && opportunityLifecycleMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 20_000);
        const result = repository.setOpportunityLifecycle(
          decodeURIComponent(opportunityLifecycleMatch[1]),
          String(payload.action || ""),
          {
            targetPostId: payload.targetPostId,
            note: payload.note,
            operator: auth.status(request).username || "administrator",
          },
        );
        if (!result) return sendJson(response, 404, { error: "Content opportunity not found." });
        return sendJson(response, 200, result);
      }
      const editorialTopicDismissMatch = url.pathname.match(/^\/api\/editorial-topics\/([^/]+)$/);
      if (request.method === "DELETE" && editorialTopicDismissMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const dismissed = repository.dismissEditorialTopic(decodeURIComponent(editorialTopicDismissMatch[1]));
        return dismissed ? sendJson(response, 200, dismissed) : sendJson(response, 404, { error: "Editorial topic not found." });
      }
      if (request.method === "POST" && url.pathname === "/api/recommendations/bulk-decision") {
        authorizeAdmin(request, config.adminToken, auth);
        const result = decideRecommendationsBulk(repository, await readJson(request, 100_000));
        if (result.queued) runQueued();
        return sendJson(response, 200, result);
      }
      const recommendationDecisionMatch = url.pathname.match(/^\/api\/recommendations\/([^/]+)\/decision$/);
      if (request.method === "POST" && recommendationDecisionMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 20_000);
        const result = decideRecommendationCommand(repository, {recommendationId:recommendationDecisionMatch[1],decision:String(payload.decision || ""),
          note:payload.note || "",opportunityId:payload.opportunityId || null,updatedAt:payload.updatedAt,proposalFingerprint:payload.proposalFingerprint});
        if (!result) return sendJson(response, 404, { error: "Recommendation not found." });
        if (result.queued) runQueued();
        return sendJson(response, 202, result);
      }
      if (request.method === "GET" && url.pathname === "/api/exceptions") {
        return sendJson(response, 200, repository.listSystemHealthWorkspace(workspaceQuery(url, 100)));
      }
      if (request.method === "GET" && url.pathname === "/api/maintenance") {
        return sendJson(response, 200, {
          enabled: config.maintenance.enabled,
          intervalMinutes: config.maintenance.intervalMinutes,
          runs: repository.listMaintenanceRuns(),
          wordpressSync: repository.getWordPressSyncState(wordpress.config.siteUrl),
          searchConsoleSync: repository.getSearchConsoleSyncState(searchConsole.config.siteUrl),
          telemetry: repository.jobTelemetry(config.telemetry.windowHours),
          favoritesSyncRuns: repository.listFavoritesSyncRuns(20),
          ...repository.maintenanceOverview(),
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
        if (processRole !== 'all') return sendJson(response, 409, { error:'Inline maintenance is disabled for the API role.' });
        authorizeAdmin(request, config.adminToken, auth);
        return sendJson(response, 200, await maintenance.runDue({ force: true }));
      }
      if (request.method === "POST" && url.pathname === "/api/maintenance/reset-derived-research") {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 20_000);
        if (payload.confirmation !== "RESET_DERIVED_RESEARCH") return sendJson(response, 400, { error: "Confirmation phrase is required." });
        const result = repository.resetDerivedResearchAndRequeue();
        runQueued();
        return sendJson(response, 202, result);
      }
      const claimLifecycleMatch = url.pathname.match(/^\/api\/claims\/([^/]+)\/(exclude|restore)$/);
      if (request.method === "POST" && claimLifecycleMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 20_000);
        const result = repository.setClaimLifecycle(claimLifecycleMatch[1], claimLifecycleMatch[2], payload.reason || "", auth.status(request).username || "admin");
        if (!result) return sendJson(response, 404, { error: "Claim not found." });
        runQueued();
        return sendJson(response, 202, result);
      }
      const knowledgeVisibilityMatch = url.pathname.match(/^\/api\/knowledge\/([^/]+)\/(hide|restore)$/);
      if (request.method === "POST" && knowledgeVisibilityMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 20_000);
        const result = repository.setKnowledgeVisibility(knowledgeVisibilityMatch[1], knowledgeVisibilityMatch[2], payload.reason || "", auth.status(request).username || "admin");
        if (!result) return sendJson(response, 404, { error: "Knowledge fact not found." });
        return sendJson(response, 200, result);
      }
      const exceptionRetryMatch = url.pathname.match(/^\/api\/exceptions\/(.+)\/retry$/);
      if (request.method === "POST" && exceptionRetryMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const retried = repository.retryOperationalException(decodeURIComponent(exceptionRetryMatch[1]), { contractAware: frontendContracts.configured });
        if (!retried) return sendJson(response, 409, { error: "Exception is not retryable or no longer exists." });
        runQueued();
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
        runQueued();
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
        runQueued();
        return sendJson(response, 202, { queued: true, jobId });
      }
      if (request.method === "GET" && url.pathname === "/api/commercial") {
        const pageSize=Math.min(100,limit(url.searchParams.get('limit') || '20'));
        const offset=Math.max(0,Number.parseInt(url.searchParams.get('cursor') || '0',10) || 0);
        const assetFilter=['all','active','inactive','expired'].includes(url.searchParams.get('filter'))
          ? url.searchParams.get('filter') : 'all';
        const assets=repository.listAffiliateAssets({lifecycleState:'operational',statusFilter:assetFilter,
          limit:pageSize+1,cursor:offset});
        return sendJson(response, 200, {
          providers: repository.listAffiliateProviderAccounts().filter((item) => item.status==='CONFIGURED'),
          items: assets.slice(0,pageSize),nextCursor:assets.length>pageSize ? String(offset+pageSize) : null,
          totalAssets:repository.db.prepare(`SELECT COUNT(*) AS count FROM affiliate_assets WHERE lifecycle_state='operational'`).get().count,
          assetFilter,
          mappings: repository.listAffiliateAssetMappings({activeOnly:true}), opportunities: repository.listAffiliateOpportunities().filter((item) => Number(item.score)>=0.75),
          queue: repository.listAffiliateQueueTasks({status:'ACTIVE'}), performance: repository.commercialPerformance(), commissionRules: repository.listCommissionRules(),
        });
      }
      if (request.method === "GET" && url.pathname === "/api/commercial/history") {
        return sendJson(response, 200, { assets:repository.listAffiliateAssets().filter((item) => item.lifecycle_state!=='operational'),
          queue:repository.listAffiliateQueueTasks().filter((item) => !['PENDING','READY_FOR_MANUAL','INVALID'].includes(item.status)) });
      }
      if (request.method === "GET" && url.pathname === "/api/commercial/affiliate-queue") {
        return sendJson(response, 200, { items: repository.listAffiliateQueueTasks({
          status: url.searchParams.get("status") || "", productCategory: url.searchParams.get("product_category") || "",
          scopeType: url.searchParams.get("scope_type") || "", provider: url.searchParams.get("provider") || "",
        }) });
      }
      if (request.method === "POST" && url.pathname === "/api/commercial/affiliate-queue/seed") {
        authorizeAdmin(request, config.adminToken, auth);
        return sendJson(response, 200, repository.seedAffiliateQueue());
      }
      if (request.method === "POST" && url.pathname === "/api/commercial/affiliate-queue/export") {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 50_000);
        const format = String(payload.format || "json").toLowerCase();
        const content = repository.exportAffiliateQueue({
          format, status: payload.status || "", productCategory: payload.productCategory || payload.product_category || "",
          scopeType: payload.scopeType || payload.scope_type || "", provider: payload.provider || "",
        });
        return sendJson(response, 200, {
          format, content, contentType: format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
          filename: `affiliate-asset-queue.${format}`,
        });
      }
      if (request.method === "POST" && url.pathname === "/api/commercial/affiliate-queue/import") {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 2_000_000);
        const importData = Array.isArray(payload) ? payload : payload.data ?? payload.items ?? [];
        return sendJson(response, 200, repository.importAffiliateQueue(importData, {
          format: payload.format || (Array.isArray(importData) ? "json" : "csv"), dryRun: payload.dryRun ?? payload.dry_run ?? false,
        }));
      }
      const affiliateQueueCompleteMatch = url.pathname.match(/^\/api\/commercial\/affiliate-queue\/([^/]+)\/complete$/);
      if (request.method === "POST" && affiliateQueueCompleteMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const taskId = decodeURIComponent(affiliateQueueCompleteMatch[1]);
        const payload = await readJson(request, 200_000);
        try {
          const result = repository.completeAffiliateQueueTask(taskId, payload);
          return result ? sendJson(response, 200, result) : sendJson(response, 404, { error: "Affiliate queue task not found." });
        } catch (error) {
          if (error instanceof CommercialValidationError) repository.invalidateAffiliateQueueTask(taskId, error.message);
          throw error;
        }
      }
      const affiliateQueueSkipMatch = url.pathname.match(/^\/api\/commercial\/affiliate-queue\/([^/]+)\/skip$/);
      if (request.method === "POST" && affiliateQueueSkipMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const result = repository.skipAffiliateQueueTask(decodeURIComponent(affiliateQueueSkipMatch[1]));
        return result ? sendJson(response, 200, result) : sendJson(response, 404, { error: "Affiliate queue task not found." });
      }
      if (request.method === "GET" && url.pathname === "/api/commercial/providers") {
        return sendJson(response, 200, { items: repository.listAffiliateProviderAccounts() });
      }
      if (request.method === "POST" && url.pathname === "/api/commercial/providers") {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 50_000);
        return sendJson(response, 200, repository.upsertAffiliateProviderAccount(normalizeAffiliateProviderAccount(payload)));
      }
      const commercialProviderMatch = url.pathname.match(/^\/api\/commercial\/providers\/([^/]+)$/);
      if (request.method === "GET" && commercialProviderMatch) {
        const providerId = decodeURIComponent(commercialProviderMatch[1]);
        const provider = repository.getAffiliateProviderAccount(providerId);
        if (!provider) return sendJson(response, 404, { error: "Affiliate provider not found." });
        return sendJson(response, 200, {
          provider, assets: repository.listAffiliateAssets({ providerAccountId: providerId }),
          mappings: repository.listAffiliateAssetMappings().filter((item) => repository.getAffiliateAsset(item.affiliate_asset_id)?.provider_account_id === providerId),
          performance: repository.commercialPerformance().filter((item) => item.provider === provider.display_name),
        });
      }
      if (request.method === "GET" && url.pathname === "/api/commercial/assets") {
        return sendJson(response, 200, { items: repository.listAffiliateAssets() });
      }
      if (request.method === "POST" && url.pathname === "/api/commercial/assets") {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 200_000);
        const provider = repository.getAffiliateProviderAccount(payload.providerAccountId || payload.provider_account_id);
        if (!provider) return sendJson(response, 400, { error: "Affiliate provider account does not exist." });
        return sendJson(response, 200, repository.upsertAffiliateAsset(normalizeAffiliateAsset(payload, {
          id: provider.id, displayName: provider.display_name,
        }),{actor:"admin",queueRefresh:false}));
      }
      const commercialAssetUsageMatch=url.pathname.match(/^\/api\/commercial\/assets\/([^/]+)\/usage$/);
      if (request.method === "GET" && commercialAssetUsageMatch) {
        const result=repository.affiliateAssetUsage(decodeURIComponent(commercialAssetUsageMatch[1]),{
          limit:limit(url.searchParams.get("limit")),offset:Number(url.searchParams.get("offset") || 0),
        });
        return result ? sendJson(response,200,result) : sendJson(response,404,{error:"Affiliate asset not found."});
      }
      const commercialAssetVersionsMatch=url.pathname.match(/^\/api\/commercial\/assets\/([^/]+)\/versions$/);
      if (request.method === "GET" && commercialAssetVersionsMatch) {
        const assetId=decodeURIComponent(commercialAssetVersionsMatch[1]);
        if (!repository.getAffiliateAsset(assetId)) return sendJson(response,404,{error:"Affiliate asset not found."});
        return sendJson(response,200,{items:repository.listAffiliateAssetVersions(assetId)});
      }
      const commercialAssetMatch=url.pathname.match(/^\/api\/commercial\/assets\/([^/]+)$/);
      if (request.method === "GET" && commercialAssetMatch) {
        const assetId=decodeURIComponent(commercialAssetMatch[1]);
        const asset=repository.getAffiliateAsset(assetId);
        if (!asset) return sendJson(response,404,{error:"Affiliate asset not found."});
        response.setHeader("etag",`\"${asset.revision || 1}\"`);
        return sendJson(response,200,{asset,usage:repository.affiliateAssetUsage(assetId,{limit:20,offset:0}),
          versions:repository.listAffiliateAssetVersions(assetId).slice(0,20)});
      }
      if (request.method === "PATCH" && commercialAssetMatch) {
        authorizeAdmin(request,config.adminToken,auth);
        const assetId=decodeURIComponent(commercialAssetMatch[1]);
        const payload=await readJson(request,200_000);
        const headerRevision=String(request.headers["if-match"] || "").replaceAll('"',"");
        const expectedRevision=payload.expectedRevision ?? payload.expected_revision ?? (headerRevision ? Number(headerRevision) : null);
        const {expectedRevision:_expectedRevision,expected_revision:_expectedRevisionSnake,applyRefresh:_applyRefresh,
          apply_refresh:_applyRefreshSnake,patch:patchPayload,...directPatch}=payload;
        const result=repository.updateAffiliateAsset(assetId,patchPayload || directPatch,{expectedRevision,actor:"admin",
          queueRefresh:false});
        if (!result) return sendJson(response,404,{error:"Affiliate asset not found."});
        response.setHeader("etag",`\"${result.revision}\"`);
        return sendJson(response,200,result);
      }
      if (request.method === "GET" && url.pathname === "/api/commercial/mappings") {
        return sendJson(response, 200, { items: repository.listAffiliateAssetMappings() });
      }
      if (request.method === "GET" && url.pathname === "/api/commercial/opportunities") {
        return sendJson(response, 200, { items: repository.listAffiliateOpportunities(String(url.searchParams.get("status") || "open")) });
      }
      if (request.method === "GET" && url.pathname === "/api/commercial/performance") {
        return sendJson(response, 200, { items: repository.commercialPerformance() });
      }
      if (request.method === "GET" && url.pathname === "/api/commercial/commission-rules") {
        return sendJson(response, 200, { items: repository.listCommissionRules() });
      }
      if (request.method === "POST" && url.pathname === "/api/commercial/commission-rules") {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 50_000);
        return sendJson(response, 200, repository.upsertCommissionRule(normalizeCommissionRule(payload)));
      }
      if (request.method === "POST" && url.pathname === "/api/commercial/events") {
        const payload = await readJson(request, 50_000);
        return sendJson(response, 202, repository.recordCommercialEvent(normalizeCommercialEvent(payload, repository.strategyVersion)));
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
        runQueued();
        return sendJson(response, 200, { items });
      }
      const generateMatch = url.pathname.match(/^\/api\/topics\/([^/]+)\/generate$/);
      if (request.method === "POST" && generateMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        return sendJson(response, 409, { error: "Approve an Intake Recommendation before planning content." });
      }
      const recoveryMatch = url.pathname.match(/^\/api\/topics\/([^/]+)\/recovery$/);
      if (recoveryMatch && ["GET", "POST"].includes(request.method)) {
        authorizeAdmin(request, config.adminToken, auth);
        const candidateId = decodeURIComponent(recoveryMatch[1]);
        const result = request.method === "GET" ? contentRecoveryReport(repository, candidateId)
          : executeContentRecovery(repository, candidateId, await readJson(request, 500_000), auth.status(request).username || "administrator");
        if (result?.queued) runQueued();
        return sendJson(response, result ? (result.queued ? 202 : 200) : 404, result || { error: "Content task not found." });
      }
      const retryContentMatch = url.pathname.match(/^\/api\/topics\/([^/]+)\/retry$/);
      if (request.method === "POST" && retryContentMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        if (!contentEngine.enabled) return sendJson(response, 409, { error: "KIMI_API_KEY is required for content production." });
        const jobType = repository.retryContent(retryContentMatch[1], { contractAware: frontendContracts.configured });
        if (!jobType) return sendJson(response, 409, { error: "Nothing retryable was found for this topic." });
        runQueued();
        return sendJson(response, 202, { queued: true, jobType });
      }
      const contentActionPreviewMatch = url.pathname.match(/^\/api\/topics\/([^/]+)\/action-preview$/);
      if (request.method === "GET" && contentActionPreviewMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const preview = repository.previewContentAction(decodeURIComponent(contentActionPreviewMatch[1]), String(url.searchParams.get("action") || "retry_failed_stage"), auth.status(request).username || "administrator");
        return preview ? sendJson(response, 200, preview) : sendJson(response, 404, { error: "Content task not found." });
      }
      const contentCancelMatch = url.pathname.match(/^\/api\/topics\/([^/]+)\/cancel$/);
      if (request.method === "POST" && contentCancelMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 20_000);
        const result = repository.cancelContent(decodeURIComponent(contentCancelMatch[1]), String(payload.previewId || payload.preview_id || ""), auth.status(request).username || "administrator");
        return result ? sendJson(response, 200, result) : sendJson(response, 404, { error: "Content task not found." });
      }
      const contentHistoryMatch = url.pathname.match(/^\/api\/topics\/([^/]+)\/history$/);
      if (request.method === "GET" && contentHistoryMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        return sendJson(response, 200, { items: repository.listContentOperationHistory(decodeURIComponent(contentHistoryMatch[1])) });
      }
      const draftMatch = url.pathname.match(/^\/api\/drafts\/([^/]+)$/);
      if (request.method === "GET" && draftMatch) {
        const draft = repository.getDraftPackage(draftMatch[1]);
        return draft ? sendJson(response, 200, draft) : sendJson(response, 404, { error: "Draft not found." });
      }
      if (request.method === "PATCH" && draftMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 50_000);
        const draft = repository.updateDraftMetadata(draftMatch[1], {
          title: payload.title ?? null, metaDescription: payload.meta_description ?? null,
        });
        return sendJson(response, 200, { draft, queued: "review_draft" });
      }
      const draftRevisionsMatch = url.pathname.match(/^\/api\/drafts\/([^/]+)\/revisions$/);
      if (request.method === "GET" && draftRevisionsMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const draftId = decodeURIComponent(draftRevisionsMatch[1]);
        const from = Number.parseInt(url.searchParams.get("from") || "", 10);
        const to = Number.parseInt(url.searchParams.get("to") || "", 10);
        if (Number.isInteger(from) && Number.isInteger(to)) {
          const comparison = repository.compareDraftRevisions(draftId, from, to);
          return comparison ? sendJson(response, 200, comparison) : sendJson(response, 404, { error: "Both draft revisions are required." });
        }
        return sendJson(response, 200, { items: repository.listDraftRevisions(draftId) });
      }
      const draftRevisionRestoreMatch = url.pathname.match(/^\/api\/drafts\/([^/]+)\/restore-frozen-revision$/);
      if (request.method === "POST" && draftRevisionRestoreMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const payload=await readJson(request,20_000);
        const result=repository.restoreFrozenDraftRevision(decodeURIComponent(draftRevisionRestoreMatch[1]),{
          targetRevision:Number(payload.target_revision),expectedCurrentRevision:Number(payload.expected_current_revision),
          expectedContentHash:String(payload.expected_content_hash || ""),actor:auth.status(request).username || "administrator",
        });
        if (result?.job_id) runQueued();
        return result ? sendJson(response,202,result) : sendJson(response,404,{error:"Draft not found."});
      }
      const draftFeedbackMatch = url.pathname.match(/^\/api\/drafts\/([^/]+)\/editorial-feedback$/);
      if (request.method === "POST" && draftFeedbackMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const payload=await readJson(request,20_000);
        const result=repository.recordEditorialFeedback(decodeURIComponent(draftFeedbackMatch[1]),String(payload.feedback || ""),payload.principle || "");
        return result ? sendJson(response,200,result) : sendJson(response,404,{error:"Draft not found."});
      }
      const draftGoldenMatch = url.pathname.match(/^\/api\/drafts\/([^/]+)\/golden$/);
      if (request.method === "POST" && draftGoldenMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const payload=await readJson(request,20_000);
        const result=repository.markGoldenArticle(decodeURIComponent(draftGoldenMatch[1]),payload.principles || []);
        return result ? sendJson(response,200,result) : sendJson(response,404,{error:"Draft not found."});
      }
      const wordpressMatch = url.pathname.match(/^\/api\/drafts\/([^/]+)\/wordpress$/);
      if (request.method === "POST" && wordpressMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        if (!wordpress.enabled) return sendJson(response, 409, { error: "WordPress delivery is not configured." });
        const draft = repository.getDraftPackage(wordpressMatch[1]);
        if (!draft?.review?.passed) return sendJson(response, 409, { error: "Draft must pass QA before WordPress delivery." });
        repository.enqueue("compose_commercial", wordpressMatch[1]);
        runQueued();
        return sendJson(response, 202, { queued: true });
      }
      const publishMatch = url.pathname.match(/^\/api\/drafts\/([^/]+)\/publish$/);
      if (request.method === 'POST' && publishMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        if (!wordpress.enabled) return sendJson(response, 409, { error: 'WordPress is not configured.' });
        const draftId = decodeURIComponent(publishMatch[1]);
        const content = repository.getDraftPackage(draftId);
        if (!content) return sendJson(response, 404, { error: 'Draft not found.' });
        if (content.draft.status === 'published') return sendJson(response, 200, { published: true });
        if (!content.publication?.post_id || content.publication.status !== 'synced'
          || !content.review?.passed || !content.commercial_composition?.current
          || content.publish_composition?.status !== 'delivered') {
          return sendJson(response, 409, { error: 'Current QA and complete WordPress draft delivery are required.',
            code: 'PUBLICATION_NOT_READY' });
        }
        assertPublicationEligibility(db, draftId, { phase: 'delivery',
          pagePayload: content.publish_composition?.publish_package?.page || null });
        const jobId = repository.enqueue('publish_wordpress_post', draftId);
        runQueued();
        return sendJson(response, 202, { queued: true, jobId });
      }
      if (request.method === "POST" && url.pathname === "/api/delivery-refresh") {
        authorizeAdmin(request, config.adminToken, auth);
        const payload = await readJson(request, 100_000);
        const result = payload.apply
          ? applyDeliveryRefresh(repository,payload,auth.status(request).username || "administrator")
          : planDeliveryRefresh(repository,payload);
        if (payload.apply && result.queued.length) runQueued();
        return sendJson(response,payload.apply ? 202 : 200,result);
      }
      const finalPreviewMatch = url.pathname.match(/^\/api\/drafts\/([^/]+)\/final-preview$/);
      if (request.method === "POST" && finalPreviewMatch) {
        authorizeAdmin(request, config.adminToken, auth);
        const content = repository.getDraftPackage(decodeURIComponent(finalPreviewMatch[1]));
        if (!content?.publication?.post_id || !content.publication.preview_url) {
          return sendJson(response, 409, { error:"This draft has not been delivered to WordPress, so no final preview exists.", code:"FINAL_PREVIEW_UNAVAILABLE" });
        }
        if (!content.commercial_composition?.current || content.publish_composition?.status !== "delivered") {
          return sendJson(response,409,{error:"The stored WordPress preview is not the current complete commercial delivery. Refresh only the required delivery layers before calling it final.",
            code:"FINAL_PREVIEW_STALE",draftId:content.draft.id,revision:content.draft.revision});
        }
        const preview = safeWordPressPreviewUrl(content.publication.preview_url, config.wordpress.siteUrl);
        if (!preview) return sendJson(response, 409, { error:"The stored preview URL is not bound to the configured WordPress site.", code:"FINAL_PREVIEW_IDENTITY_MISMATCH" });
        const inventory=db.prepare(`SELECT status,post_url FROM wordpress_content_inventory
          WHERE site_url=? AND post_id=?`).get(content.publication.site_url,content.publication.post_id);
        const publicUrl=inventory?.status==='publish'
          ? safeWordPressPreviewUrl(inventory.post_url,config.wordpress.siteUrl) : null;
        if (publicUrl) {
          response.setHeader("cache-control", "no-store, private");
          return sendJson(response,200,{mode:"published_page",url:publicUrl,
            postId:content.publication.post_id,draftId:content.draft.id,revision:content.draft.revision});
        }
        const deliveryManifest=safeJsonObject(content.publication.delivery_manifest_json);
        let ticketFailureStatus = null;
        try {
          const ticket=await wordpress.createScopedPreviewTicket({postId:content.publication.post_id,draftId:content.draft.id,
            revision:content.draft.revision,pagePayloadHash:deliveryManifest.page_payload_hash || ""});
          response.setHeader("cache-control", "no-store, private");
          response.setHeader("referrer-policy", "no-referrer");
          response.setHeader("x-robots-tag", "noindex, nofollow, noarchive");
          return sendJson(response,200,ticket);
        } catch (error) {
          // A scoped ticket is an enhancement, not the only route to a draft
          // preview. Some existing WordPress installations reject the ticket
          // endpoint for the CMS application password even though an editor
          // can authenticate interactively and preview the same post.
          if (![401,403,404,501].includes(error?.statusCode)) throw error;
          ticketFailureStatus = error.statusCode;
        }
        const login = new URL("/wp-login.php", config.wordpress.siteUrl);
        login.searchParams.set("redirect_to", preview);
        response.setHeader("cache-control", "no-store, private");
        response.setHeader("referrer-policy", "no-referrer");
        response.setHeader("x-robots-tag", "noindex, nofollow, noarchive");
        return sendJson(response, 200, { mode:"wordpress_login_required", url:login.toString(), postId:content.publication.post_id,
          draftId:content.draft.id, revision:content.draft.revision,
          message:ticketFailureStatus === 401 || ticketFailureStatus === 403
            ? "WordPress rejected the scoped preview ticket. Sign in with an editor account to preview this post; check the CMS WordPress credentials and ticket permission separately."
            : "WordPress login is required because no scoped final-preview capability is configured." });
      }
      if (request.method === "POST" && url.pathname === "/api/pipeline/run-one") {
        authorizeAdmin(request, config.adminToken, auth);
        if (processRole !== 'all') return sendJson(response, 409, { error:'Direct pipeline execution is disabled for the API role.' });
        const worked = await pipeline.runOne();
        return sendJson(response, 200, { worked });
      }

      if (url.pathname.startsWith("/api/")) return sendJson(response, 404, { error: "Not found." });
      if (request.method === "GET") return serveStatic(publicDir, url.pathname, response);
      return sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      const status = error instanceof ValidationError || error instanceof CommercialValidationError ? 400 : error instanceof FrontendContractError ? 409 : error?.statusCode || 500;
      const log = status >= 500 ? logger.error : logger.warn;
      log("http.request_failed", { requestId, method: request.method, path: requestPath, status, error });
      return sendJson(response, status, {
        error: error.message || "Unexpected server error.",
        requestId,
        ...(error?.code ? { code: error.code, details: error.details || null } : {}),
      });
    } finally {
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) dashboardSummaryCache.invalidate();
    }
  });
  // cloudflared keeps a small pool of HTTP/1.1 connections to this private
  // origin. Keep those sockets alive longer than the connector's reuse window
  // so an idle pooled socket cannot race Node's five-second default timeout.
  server.keepAliveTimeout = 120_000;
  if ("keepAliveTimeoutBuffer" in server) server.keepAliveTimeoutBuffer = 5_000;
  server.headersTimeout = 130_000;

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
          if (processRole === 'all') { pipeline.start(); maintenance.start(); }
          logger.info("server.started", { host: config.host, port: server.address().port, version: VERSION });
          resolve();
        });
      });
    },
    startWorker() {
      if (processRole !== 'worker') throw new Error('startWorker requires CMS_PROCESS_ROLE=worker.');
      pipeline.start({ keepAlive: true });
      maintenance.start();
    },
    async stop() {
      maintenance.stop();
      pipeline.stop();
      if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      db.close();
      logger.info("server.stopped", { version: VERSION });
    },
  };
}

function safeWordPressPreviewUrl(value, siteUrl) {
  try {
    const preview = new URL(String(value || ""));
    const site = new URL(String(siteUrl || ""));
    return preview.origin === site.origin && /^https?:$/.test(preview.protocol) && !preview.username && !preview.password
      ? preview.toString() : "";
  } catch { return ""; }
}

function safeJsonObject(value) {
  try { const parsed=JSON.parse(String(value || "{}")); return parsed && typeof parsed === "object" ? parsed : {}; }
  catch { return {}; }
}

export function assertProductionDatabaseConfiguration(config) {
  if (config.deployment?.environment !== "production") return;
  if (!config.deployment.databasePathConfigured) {
    throw new Error("Production startup requires an explicit DATABASE_PATH; refusing to open the image-local default database.");
  }
  if (!fs.existsSync(config.databasePath) && !config.deployment.allowProductionDatabaseBootstrap) {
    throw new Error("Production DATABASE_PATH does not exist; set ALLOW_PRODUCTION_DATABASE_BOOTSTRAP=true only for an intentional first deployment.");
  }
}

function createRequestGate(spacingMs = 0) {
  const spacing = Math.max(0, Number(spacingMs || 0));
  let nextStartAt = 0;
  return async () => {
    const scheduledAt = Math.max(Date.now(), nextStartAt);
    nextStartAt = scheduledAt + spacing;
    const waitMs = scheduledAt - Date.now();
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
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
    || (method === 'GET' && /^\/api\/capture-media-uploads\/[^/]+$/.test(pathname))
    || (method === "POST" && ["/api/captures", "/api/captures/identity-check", "/api/capture-uploads", "/api/capture-media-uploads", "/api/favorites-sync-runs"].includes(pathname))
    || (method === "PUT" && /^\/api\/(?:capture-uploads|capture-media-uploads)\/[^/]+\/chunks\/\d+$/.test(pathname))
    || (method === "POST" && /^\/api\/(?:capture-uploads|capture-media-uploads)\/[^/]+\/complete$/.test(pathname))
    || (method === "GET" && (pathname === "/api/favorites-sync-runs" || /^\/api\/sources\/[^/]+$/.test(pathname)));
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
  response.setHeader("Access-Control-Allow-Headers", "authorization, content-type, x-request-id, x-upload-token, idempotency-key");
  response.setHeader("Access-Control-Expose-Headers", "x-request-id");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
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

async function readBytes(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) { const error = new Error("Upload chunk is too large."); error.statusCode = 413; throw error; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.responseBytes = Buffer.byteLength(body);
  response.responseRowCount = Array.isArray(value?.items) ? value.items.length
    : Array.isArray(value) ? value.length : null;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(body);
}

function unresolvedMediaBudgetFailure(db, detail) {
  if (!detail.draft_id || detail.draft_status !== 'needs_review'
    || !detail.production_state?.timeline?.some((step) => step.key === 'generate_visuals')) return null;
  const failed = db.prepare(`SELECT failed.id FROM jobs failed WHERE failed.entity_id=?
    AND failed.production_owner_opportunity_id=? AND failed.type='generate_visuals'
    AND failed.status='failed' AND failed.last_failure_code='MEDIA_BUDGET_EXHAUSTED'
    AND NOT EXISTS (SELECT 1 FROM jobs next WHERE next.entity_id=failed.entity_id
      AND next.production_owner_opportunity_id=failed.production_owner_opportunity_id
      AND next.type='generate_visuals' AND next.id<>failed.id
      AND (next.status IN ('queued','running') OR (next.status='succeeded' AND next.updated_at>=failed.updated_at)))
    ORDER BY failed.updated_at DESC LIMIT 1`).get(detail.draft_id,detail.opportunity_id);
  if (!failed) return null;
  const call=db.prepare(`SELECT visual_id,substage FROM model_call_metrics WHERE run_id=?
    AND error_code='MEDIA_BUDGET_EXHAUSTED' ORDER BY created_at DESC,id DESC LIMIT 1`).get(failed.id);
  return {...failed,visual_id:call?.visual_id || null,substage:call?.substage || null};
}

function sourceForApi(source) {
  return {
    ...source,
    assets: (source.assets || []).map(({ local_path, ...asset }) => asset),
  };
}

function serveSourceAssetPreview(asset, response, storageRoot) {
  const filename = path.resolve(String(asset.local_path || ""));
  const root = path.resolve(storageRoot);
  if (asset.local_path && filename.startsWith(`${root}${path.sep}`)) {
    try {
      const stat = fs.statSync(filename);
      if (stat.isFile()) {
        response.writeHead(200, {
          "content-type": asset.mime_type || MIME[path.extname(filename)] || "application/octet-stream",
          "content-length": stat.size,
          "cache-control": "private, max-age=300",
          "x-content-type-options": "nosniff",
        });
        return fs.createReadStream(filename).pipe(response);
      }
    } catch { /* continue to the legacy inline preview */ }
  }
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/u.exec(String(asset.ai_derivative_data_url || ""));
  if (match) {
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.length && bytes.length <= 8 * 1024 * 1024) {
      response.writeHead(200, {
        "content-type": match[1],
        "content-length": bytes.length,
        "cache-control": "private, max-age=300",
        "x-content-type-options": "nosniff",
      });
      return response.end(bytes);
    }
  }
  return sendJson(response, 404, { error: "这张图片尚未保存到系统中，请重新采集原文后再处理。" });
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

function workspaceQuery(url, defaultLimit = 100) {
  return {
    limit: limit(url.searchParams.get("limit") || String(defaultLimit)),
    cursor: url.searchParams.get("cursor") || "",
    search: url.searchParams.get("search") || "",
    status: url.searchParams.get("status") || "",
  };
}

if (import.meta.main) {
  const config = loadConfig();
  const app = createApplication(config);
  if (config.processRole === 'worker') {
    app.startWorker();
    app.logger.info('worker.ready', { databasePath:config.databasePath });
  } else {
    await app.start();
    app.logger.info("preview.ready", { url: `http://${config.host}:${config.port}` });
  }
  const shutdown = async () => {
    await app.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
