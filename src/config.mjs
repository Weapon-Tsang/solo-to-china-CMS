import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig(env = process.env) {
  const databasePath = path.resolve(root, env.DATABASE_PATH || "data/solo-to-china.sqlite");
  return {
    root,
    host: env.HOST || "127.0.0.1",
    port: integer(env.PORT, 4310),
    databasePath,
    captureToken: env.CAPTURE_TOKEN || "",
    adminToken: env.ADMIN_TOKEN || "",
    kimi: {
      apiKey: env.KIMI_API_KEY || "",
      model: env.KIMI_MODEL || "kimi-k2.6",
      baseUrl: (env.KIMI_BASE_URL || "https://api.moonshot.cn/v1").replace(/\/$/, ""),
      maxImages: integer(env.KIMI_MAX_IMAGES || env.AI_MAX_IMAGES, 8),
      maxCompletionTokens: integer(env.KIMI_MAX_COMPLETION_TOKENS, 16_000),
    },
    content: {
      minFacts: integer(env.AUTO_CONTENT_MIN_FACTS, 5),
      maxPerDestination: integer(env.AUTO_CONTENT_MAX_PER_DESTINATION, 1),
      staleAfterDays: integer(env.CONTENT_STALE_AFTER_DAYS, 365),
      volatileStaleAfterDays: integer(env.CONTENT_VOLATILE_STALE_AFTER_DAYS, 90),
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
