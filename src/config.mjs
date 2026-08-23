import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig(env = process.env) {
  return {
    root,
    host: env.HOST || "127.0.0.1",
    port: integer(env.PORT, 4310),
    databasePath: path.resolve(root, env.DATABASE_PATH || "data/solo-to-china.sqlite"),
    captureToken: env.CAPTURE_TOKEN || "",
    openai: {
      apiKey: env.OPENAI_API_KEY || "",
      model: env.OPENAI_MODEL || "gpt-5-mini",
      baseUrl: (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
      maxImages: integer(env.AI_MAX_IMAGES, 8),
    },
    content: {
      minFacts: integer(env.AUTO_CONTENT_MIN_FACTS, 5),
      maxPerDestination: integer(env.AUTO_CONTENT_MAX_PER_DESTINATION, 1),
    },
    wordpress: {
      siteUrl: (env.WORDPRESS_SITE_URL || "").replace(/\/$/, ""),
      username: env.WORDPRESS_USERNAME || "",
      applicationPassword: env.WORDPRESS_APPLICATION_PASSWORD || "",
    },
    commercial: {
      maxOffersPerDraft: integer(env.COMMERCIAL_MAX_OFFERS_PER_DRAFT, 3),
      disclosure: env.AFFILIATE_DISCLOSURE || "SoloToChina may earn a commission from eligible bookings, at no extra cost to you.",
    },
  };
}

function integer(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
