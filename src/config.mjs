import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { CONTENT_STRATEGY } from "./content-strategy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelStagePolicy = JSON.parse(fs.readFileSync(path.join(root, "config", "model-stage-policy.json"), "utf8"));
const modelPricing = JSON.parse(fs.readFileSync(path.join(root, "config", "model-pricing.json"), "utf8"));

export const AI_MODELS = [
  { id: "vertex-gemini-3.8-flash", provider: "vertex", model: "gemini-3.8-flash", location: "global", label: "Vertex AI · Gemini 3.8 Flash", description: "默认的 Google 多模态工作模型，用于图文理解、结构化提取、写作与审核。", supportsImages: true, isDefault: true },
  { id: "kimi-k2.7-code", provider: "kimi", model: "kimi-k2.7-code", label: "Kimi K2.7 Code", description: "适合结构化提取与内容生产的代码模型。", supportsImages: true },
  { id: "kimi-k3", provider: "kimi", model: "kimi-k3", label: "Kimi K3", description: "高能力多模态模型，用于图文理解、写作与审核。", supportsImages: true },
  { id: "vertex-gemini-3.1-pro-preview", provider: "vertex", model: "gemini-3.1-pro-preview", label: "Vertex AI · Gemini 3.1 Pro（预览）", description: "Vertex AI 当前最新的 Gemini 高阶推理预览模型；需要项目配额与地区可用性。", supportsImages: true, preview: true },
  { id: "vertex-gemini-2.5-pro", provider: "vertex", model: "gemini-2.5-pro", label: "Vertex AI · Gemini 2.5 Pro", description: "Vertex AI 的稳定 Gemini 高阶推理模型。", supportsImages: true },
];
export const KIMI_MODELS = AI_MODELS.filter((item) => item.provider === "kimi").map((item) => item.id);

export const VISUAL_MODELS = [
  {
    id: "vertex-gemini-3.1-flash-image",
    provider: "vertex_gemini",
    model: "gemini-3.1-flash-image",
    location: "global",
    label: "Gemini 3.1 Flash Image（Nano Banana 2）",
    description: "Google 的原生图像生成与编辑模型；用于原创、非事实性旅行插画。",
    supportsGeneration: true,
  },
  {
    id: "kimi-k3",
    provider: "kimi",
    model: "kimi-k3",
    label: "Kimi K3",
    description: "可用于图文理解与文章写作，但 Kimi API 当前不返回图片字节，不能作为生图渲染器。",
    supportsGeneration: false,
  },
];

export function loadConfig(env = process.env) {
  const databasePath = path.resolve(root, env.DATABASE_PATH || "data/solo-to-china.sqlite");
  const sourceUploadsDir = path.resolve(root, env.SOURCE_UPLOADS_DIR || "data/source-uploads");
  const captureUploadsDir = path.resolve(root, env.CAPTURE_UPLOADS_DIR || "data/capture-uploads");
  const generatedMediaDir = path.resolve(root, env.GENERATED_MEDIA_DIR || "data/generated-media");
  const imageProvider = env.IMAGE_PROVIDER || env.VISUAL_PROVIDER || "none";
  return {
    root,
    contentStrategy: CONTENT_STRATEGY,
    host: env.HOST || "127.0.0.1",
    port: integer(env.PORT, 4310),
    databasePath,
    captureToken: env.CAPTURE_TOKEN || "",
    adminToken: env.ADMIN_TOKEN || "",
    auth: {
      username: safeUsername(env.ADMIN_USERNAME || "admin"),
      password: env.ADMIN_PASSWORD || "",
      sessionSecret: env.SESSION_SECRET || "",
      forcePasswordChange: boolean(env.ADMIN_PASSWORD_FORCE_CHANGE, env.ADMIN_PASSWORD === "123456"),
      loginThrottle: {
        accountAttempts: integer(env.LOGIN_RATE_LIMIT_ACCOUNT_ATTEMPTS, 5),
        sourceAttempts: integer(env.LOGIN_RATE_LIMIT_SOURCE_ATTEMPTS, 20),
        windowMs: integer(env.LOGIN_RATE_LIMIT_WINDOW_SECONDS, 900) * 1_000,
        baseCooldownMs: integer(env.LOGIN_RATE_LIMIT_BASE_COOLDOWN_SECONDS, 2) * 1_000,
        maxCooldownMs: integer(env.LOGIN_RATE_LIMIT_MAX_COOLDOWN_SECONDS, 300) * 1_000,
        maxEntries: integer(env.LOGIN_RATE_LIMIT_MAX_ENTRIES, 5_000),
        trustedProxyHeader: choice(env.TRUSTED_PROXY_HEADER, ["", "cf-connecting-ip", "x-forwarded-for"], ""),
        trustedProxySources: stringList(env.TRUSTED_PROXY_SOURCES),
      },
    },
    captureHost: hostname(env.CAPTURE_HOST),
    ai: {
      defaultModel: AI_MODELS.some((item) => item.id === env.AI_MODEL) ? env.AI_MODEL : "vertex-gemini-3.8-flash",
      stagePolicy: modelStagePolicy,
      pricing: modelPricing,
    },
    kimi: {
      apiKey: env.KIMI_API_KEY || "",
      model: KIMI_MODELS.includes(env.KIMI_MODEL) ? env.KIMI_MODEL : "kimi-k2.7-code",
      baseUrl: (env.KIMI_BASE_URL || "https://api.moonshot.cn/v1").replace(/\/$/, ""),
      maxImages: integer(env.AI_IMAGE_BATCH_SIZE || env.KIMI_MAX_IMAGES || env.AI_MAX_IMAGES, 32),
      imageBatchSize: integer(env.AI_IMAGE_BATCH_SIZE || env.KIMI_MAX_IMAGES || env.AI_MAX_IMAGES, 32),
      maxCompletionTokens: integer(env.KIMI_MAX_COMPLETION_TOKENS, 16_000),
      requestTimeoutMs: integer(env.KIMI_REQUEST_TIMEOUT_MS, 360_000),
      imageTimeoutMs: integer(env.KIMI_IMAGE_TIMEOUT_MS, 20_000),
      sourceUploadsDir,
    },
    vertex: {
      projectId: env.GOOGLE_CLOUD_PROJECT || "",
      location: env.VERTEX_AI_LOCATION || "us-central1",
      accessToken: env.VERTEX_AI_ACCESS_TOKEN || "",
      requestTimeoutMs: integer(env.VERTEX_AI_REQUEST_TIMEOUT_MS, 360_000),
      imageTimeoutMs: integer(env.VERTEX_AI_IMAGE_TIMEOUT_MS, 20_000),
      maxImages: integer(env.AI_IMAGE_BATCH_SIZE || env.VERTEX_AI_MAX_IMAGES || env.AI_MAX_IMAGES, 32),
      imageBatchSize: integer(env.AI_IMAGE_BATCH_SIZE || env.VERTEX_AI_MAX_IMAGES || env.AI_MAX_IMAGES, 32),
      maxCompletionTokens: integer(env.VERTEX_AI_MAX_COMPLETION_TOKENS, 16_000),
      thinkingLevel: choice(String(env.VERTEX_AI_THINKING_LEVEL || "LOW").toUpperCase(), ["MINIMAL", "LOW", "MEDIUM", "HIGH"], "LOW"),
      reasoningThinkingLevel: choice(String(env.VERTEX_AI_REASONING_THINKING_LEVEL || "MEDIUM").toUpperCase(), ["MINIMAL", "LOW", "MEDIUM", "HIGH"], "MEDIUM"),
      sourceUploadsDir,
      maxVideoBytes: integer(env.MANUAL_SOURCE_MAX_VIDEO_BYTES, 256 * 1024 * 1024),
      videoBucket: String(env.MANUAL_SOURCE_GCS_BUCKET || "").trim(),
      batchEnabled: boolean(env.VERTEX_AI_BATCH_ENABLED, true),
      batchBucket: String(env.VERTEX_AI_BATCH_BUCKET || env.MANUAL_SOURCE_GCS_BUCKET || "").trim(),
      batchMinimumRequests: integer(env.VERTEX_AI_BATCH_MIN_REQUESTS, 20),
      batchMaximumRequests: integer(env.VERTEX_AI_BATCH_MAX_REQUESTS, 1_000),
      batchPollMs: integer(env.VERTEX_AI_BATCH_POLL_MS, 60_000),
      batchMaxInputBytes: integer(env.VERTEX_AI_BATCH_MAX_INPUT_BYTES, 128 * 1024 * 1024),
    },
    manualSources: {
      uploadDir: sourceUploadsDir,
      requestTimeoutMs: integer(env.MANUAL_SOURCE_REQUEST_TIMEOUT_MS, 20_000),
      maxFileBytes: integer(env.MANUAL_SOURCE_MAX_FILE_BYTES, 64 * 1024 * 1024),
      maxImageBytes: integer(env.MANUAL_SOURCE_MAX_IMAGE_BYTES, 20 * 1024 * 1024),
      maxVideoBytes: integer(env.MANUAL_SOURCE_MAX_VIDEO_BYTES, 256 * 1024 * 1024),
      maxTotalBytes: integer(env.MANUAL_SOURCE_MAX_TOTAL_BYTES, 300 * 1024 * 1024),
      maxRemoteBytes: integer(env.MANUAL_SOURCE_MAX_REMOTE_BYTES, 8 * 1024 * 1024),
      maxImages: integer(env.MANUAL_SOURCE_MAX_IMAGES, 30),
    },
    captureUploads: {
      uploadDir: captureUploadsDir,
      maxBytes: integer(env.CAPTURE_UPLOAD_MAX_BYTES, 128 * 1024 * 1024),
      chunkBytes: integer(env.CAPTURE_UPLOAD_CHUNK_BYTES, 2 * 1024 * 1024),
      maxAgeMs: integer(env.CAPTURE_UPLOAD_MAX_AGE_HOURS, 24) * 60 * 60 * 1000,
    },
    extraction: {
      concurrencyMode: choice(env.AI_CONCURRENCY_MODE || env.EXTRACT_CONCURRENCY_MODE, ["auto", "fixed"], "auto"),
      concurrencyInitial: integer(env.AI_CONCURRENCY_INITIAL || env.EXTRACT_CONCURRENCY_INITIAL, 2),
      concurrencyMax: integer(env.AI_CONCURRENCY_MAX || env.EXTRACT_CONCURRENCY_MAX, 4),
      concurrencySuccessWindow: integer(env.AI_CONCURRENCY_SUCCESS_WINDOW || env.EXTRACT_CONCURRENCY_SUCCESS_WINDOW, 12),
      requestSpacingMs: integer(env.AI_REQUEST_SPACING_MS, 1_000),
      providerBackoffInitialMs: integer(env.AI_PROVIDER_BACKOFF_INITIAL_MS, 5_000),
      providerBackoffMaxMs: integer(env.AI_PROVIDER_BACKOFF_MAX_MS, 300_000),
      providerRecoverySuccesses: integer(env.AI_PROVIDER_RECOVERY_SUCCESSES, 5),
      sourceTextSegmentMaxChars: integer(env.SOURCE_TEXT_SEGMENT_MAX_CHARS, 120_000),
    },
    visuals: {
      enabled: boolean(env.IMAGE_ENABLED, false),
      provider: choice(imageProvider, ["none", "vertex_imagen", "vertex_gemini"], "none"),
      projectId: env.GOOGLE_CLOUD_PROJECT || "",
      location: env.VERTEX_AI_LOCATION || "us-central1",
      defaultModel: VISUAL_MODELS.some((item) => item.id === env.VISUAL_MODEL) ? env.VISUAL_MODEL : "vertex-gemini-3.1-flash-image",
      model: env.IMAGE_MODEL || env.VERTEX_IMAGEN_MODEL || "gemini-3.1-flash-image",
      coverQuality: env.IMAGE_COVER_QUALITY || "1K",
      inlineQuality: env.IMAGE_INLINE_QUALITY || "1K",
      mediaDir: generatedMediaDir,
      publicBaseUrl: (env.PUBLIC_BASE_URL || "").replace(/\/$/, ""),
      accessToken: env.VERTEX_AI_ACCESS_TOKEN || "",
      requestTimeoutMs: integer(env.VERTEX_IMAGE_TIMEOUT_MS, 120_000),
    },
    content: {
      minFacts: integer(env.AUTO_CONTENT_MIN_FACTS, 5),
      maxPerDestination: integer(env.AUTO_CONTENT_MAX_PER_DESTINATION, 1),
      staleAfterDays: integer(env.CONTENT_STALE_AFTER_DAYS, 365),
      volatileStaleAfterDays: integer(env.CONTENT_VOLATILE_STALE_AFTER_DAYS, 90),
      publicSiteUrl: (env.PUBLIC_CONTENT_SITE_URL || "").replace(/\/$/, ""),
      publisherName: env.CONTENT_PUBLISHER_NAME || "SoloToChina",
      publisherLogoUrl: env.CONTENT_PUBLISHER_LOGO_URL || "",
    },
    frontendContract: {
      sourceRepository: env.FRONTEND_CONTRACT_SOURCE_REPOSITORY || "",
      registrySource: env.FRONTEND_COMPONENT_REGISTRY_SOURCE || "",
      pageSchemaSource: env.FRONTEND_PAGE_SCHEMA_SOURCE || "",
      publishPackageSchemaSource: env.FRONTEND_PUBLISH_PACKAGE_SCHEMA_SOURCE || env.WORDPRESS_CMS_PUBLISH_PACKAGE_SCHEMA || "",
      frontendCommitSha: env.FRONTEND_CONTRACT_COMMIT_SHA || "",
      timeoutMs: integer(env.FRONTEND_CONTRACT_TIMEOUT_MS, 15_000),
      syncHours: integer(env.FRONTEND_CONTRACT_SYNC_HOURS, 6),
    },
    wordpress: {
      siteUrl: (env.WORDPRESS_SITE_URL || "").replace(/\/$/, ""),
      username: env.WORDPRESS_USERNAME || "",
      applicationPassword: env.WORDPRESS_APPLICATION_PASSWORD || "",
      inventorySyncHours: integer(env.WORDPRESS_INVENTORY_SYNC_HOURS, 24),
      authorId: integer(env.WORDPRESS_AUTHOR_ID, 0),
      categoryIds: integerList(env.WORDPRESS_CATEGORY_IDS),
      tagIds: integerList(env.WORDPRESS_TAG_IDS),
      featuredMediaId: integer(env.WORDPRESS_FEATURED_MEDIA_ID, 0),
      template: safeTemplate(env.WORDPRESS_TEMPLATE),
      contentFormat: choice(env.WORDPRESS_CONTENT_FORMAT, ["blocks", "html"], "blocks"),
      cmsArticleEndpoint: env.WORDPRESS_CMS_ARTICLE_ENDPOINT || "",
      seoTitleMetaKey: safeMetaKey(env.WORDPRESS_SEO_TITLE_META_KEY),
      seoDescriptionMetaKey: safeMetaKey(env.WORDPRESS_SEO_DESCRIPTION_META_KEY),
      schemaJsonldMetaKey: safeMetaKey(env.WORDPRESS_SCHEMA_JSONLD_META_KEY),
      strategyVersionMetaKey: safeMetaKey(env.WORDPRESS_STRATEGY_VERSION_META_KEY),
    },
    searchConsole: {
      siteUrl: env.SEARCH_CONSOLE_SITE_URL || "",
      clientEmail: env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "",
      privateKey: env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "",
      syncHours: integer(env.SEARCH_CONSOLE_SYNC_HOURS, 24),
      lookbackDays: integer(env.SEARCH_CONSOLE_LOOKBACK_DAYS, 28),
      rowLimit: integer(env.SEARCH_CONSOLE_ROW_LIMIT, 5_000),
      minimumImpressions: integer(env.SEARCH_CONSOLE_MIN_IMPRESSIONS, 10),
    },
    commercial: {
      maxOffersPerDraft: integer(env.COMMERCIAL_MAX_OFFERS_PER_DRAFT, 3),
      maxContextualUnits: integer(env.COMMERCIAL_MAX_CONTEXTUAL_UNITS, 2),
      maxEndResourceUnits: integer(env.COMMERCIAL_MAX_END_RESOURCE_UNITS, 1),
      minBlockDistance: integer(env.COMMERCIAL_MIN_BLOCK_DISTANCE, 3),
      minimumContentBlocks: integer(env.COMMERCIAL_MINIMUM_CONTENT_BLOCKS, 2),
      opportunityThreshold: integer(env.AFFILIATE_OPPORTUNITY_THRESHOLD, 70),
      disclosure: env.AFFILIATE_DISCLOSURE || "SoloToChina may earn a commission from eligible bookings, at no extra cost to you.",
    },
    telemetry: {
      windowHours: integer(env.TELEMETRY_WINDOW_HOURS, 24),
    },
    logging: {
      level: choice(env.LOG_LEVEL, ["debug", "info", "warn", "error"], "info"),
      format: choice(env.LOG_FORMAT, ["json", "pretty"], "json"),
    },
    notifications: {
      webhookUrl: env.EXCEPTION_WEBHOOK_URL || "",
      webhookToken: env.EXCEPTION_WEBHOOK_TOKEN || "",
      minimumSeverity: choice(env.EXCEPTION_NOTIFICATION_MIN_SEVERITY, ["warning", "blocker"], "blocker"),
      intervalMinutes: integer(env.EXCEPTION_NOTIFICATION_INTERVAL_MINUTES, 15),
      repeatHours: integer(env.EXCEPTION_NOTIFICATION_REPEAT_HOURS, 24),
      timeoutMs: integer(env.EXCEPTION_WEBHOOK_TIMEOUT_MS, 10_000),
    },
    maintenance: {
      enabled: boolean(env.MAINTENANCE_ENABLED, true),
      intervalMinutes: integer(env.MAINTENANCE_INTERVAL_MINUTES, 15),
      knowledgeReconcileHours: integer(env.KNOWLEDGE_RECONCILE_HOURS, 24),
      entityResolutionHours: integer(env.ENTITY_RESOLUTION_HOURS, 24),
      autoBackupHours: integer(env.AUTO_BACKUP_HOURS, 24),
      jobHistoryRetentionDays: integer(env.JOB_HISTORY_RETENTION_DAYS, 30),
      backupDir: path.resolve(root, env.BACKUP_DIR || "backups"),
      backupRetention: integer(env.BACKUP_RETENTION, 14),
      backupOffsiteLocation: String(env.BACKUP_OFFSITE_LOCATION || "").trim(),
      backupOffsiteRetentionDays: integer(env.BACKUP_OFFSITE_RETENTION_DAYS, 0),
      sourceUploadsDir,
      generatedMediaDir,
      codeRevision: String(env.ENGINE_IMAGE || env.APP_REVISION || "").trim(),
      databasePath,
    },
  };
}

function integer(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function integerList(value) {
  return String(value || "").split(",").map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isInteger(item) && item > 0);
}

function stringList(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function boolean(value, fallback) {
  if (value == null || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function choice(value, allowed, fallback) {
  const normalized = String(value || "").toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function safeMetaKey(value) {
  const normalized = String(value || "").trim();
  return /^[A-Za-z0-9_.:-]{1,191}$/.test(normalized) ? normalized : "";
}

function safeTemplate(value) {
  const normalized = String(value || "").trim();
  return normalized && !normalized.includes("..") && /^[A-Za-z0-9_./-]{1,191}$/.test(normalized) ? normalized : "";
}

function safeUsername(value) {
  const normalized = String(value || "").trim();
  return /^[A-Za-z0-9_.-]{3,64}$/.test(normalized) ? normalized : "admin";
}

function hostname(value) {
  try {
    return value ? new URL(value.includes("://") ? value : `https://${value}`).hostname.toLowerCase() : "";
  } catch {
    return "";
  }
}
