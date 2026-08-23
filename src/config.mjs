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
    openai: {
      apiKey: env.OPENAI_API_KEY || "",
      model: env.OPENAI_MODEL || "gpt-5-mini",
      baseUrl: (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
      maxImages: integer(env.AI_MAX_IMAGES, 8),
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
    },
    commercial: {
      maxOffersPerDraft: integer(env.COMMERCIAL_MAX_OFFERS_PER_DRAFT, 3),
      disclosure: env.AFFILIATE_DISCLOSURE || "SoloToChina may earn a commission from eligible bookings, at no extra cost to you.",
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
