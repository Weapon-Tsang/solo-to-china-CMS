import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTENT_STRATEGY } from "./content-strategy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
    },
    captureHost: hostname(env.CAPTURE_HOST),
    ai: {
      defaultModel: AI_MODELS.some((item) => item.id === env.AI_MODEL) ? env.AI_MODEL : "vertex-gemini-3.8-flash",
    },
    kimi: {
      apiKey: env.KIMI_API_KEY || "",
      model: KIMI_MODELS.includes(env.KIMI_MODEL) ? env.KIMI_MODEL : "kimi-k2.7-code",
      baseUrl: (env.KIMI_BASE_URL || "https://api.moonshot.cn/v1").replace(/\/$/, ""),
      maxImages: integer(env.KIMI_MAX_IMAGES || env.AI_MAX_IMAGES, 8),
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
      maxImages: integer(env.VERTEX_AI_MAX_IMAGES || env.AI_MAX_IMAGES, 8),
      maxCompletionTokens: integer(env.VERTEX_AI_MAX_COMPLETION_TOKENS, 16_000),
      sourceUploadsDir,
    },
    manualSources: {
      uploadDir: sourceUploadsDir,
      requestTimeoutMs: integer(env.MANUAL_SOURCE_REQUEST_TIMEOUT_MS, 20_000),
      maxFileBytes: integer(env.MANUAL_SOURCE_MAX_FILE_BYTES, 12 * 1024 * 1024),
      maxImageBytes: integer(env.MANUAL_SOURCE_MAX_IMAGE_BYTES, 6 * 1024 * 1024),
      maxTotalBytes: integer(env.MANUAL_SOURCE_MAX_TOTAL_BYTES, 25 * 1024 * 1024),
      maxRemoteBytes: integer(env.MANUAL_SOURCE_MAX_REMOTE_BYTES, 8 * 1024 * 1024),
      maxImages: integer(env.MANUAL_SOURCE_MAX_IMAGES, 8),
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
      mediaDir: path.resolve(root, env.GENERATED_MEDIA_DIR || "data/generated-media"),
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
