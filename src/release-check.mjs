import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./db.mjs";
import { VERSION } from "./version.mjs";
import { CONTENT_STRATEGY } from "./content-strategy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension", "manifest.json"), "utf8"));
if (packageJson.version !== VERSION || manifest.version !== VERSION) {
  throw new Error(`Release versions must all be ${VERSION} (package=${packageJson.version}, extension=${manifest.version}).`);
}

const strategyDocument = path.join(root, CONTENT_STRATEGY.document);
const handoffPath = path.join(root, "docs", "HANDOFF.md");
const strategyText = fs.readFileSync(strategyDocument, "utf8");
const handoffText = fs.readFileSync(handoffPath, "utf8");
const dashboardSource = fs.readFileSync(path.join(root, "frontend", "src", "components", "dashboard.jsx"), "utf8");
const contentViewSource = fs.readFileSync(path.join(root, "frontend", "src", "views.jsx"), "utf8");
const serverSource = fs.readFileSync(path.join(root, "src", "server.mjs"), "utf8");
if (!strategyText.includes(`Content Production Strategy ${CONTENT_STRATEGY.version}`)) {
  throw new Error(`Strategy specification does not identify version ${CONTENT_STRATEGY.version}.`);
}
if (!CONTENT_STRATEGY.history.some((entry) => entry.version === CONTENT_STRATEGY.version && entry.status === "active")) {
  throw new Error("Content strategy has no active evolution-history entry for the manifest version.");
}
if (!handoffText.includes(`Content Production Strategy ${CONTENT_STRATEGY.version}`) || !handoffText.includes("config/content-strategy.json")) {
  throw new Error("Handoff does not reference the active strategy manifest and version.");
}
if (!dashboardSource.includes("health?.contentStrategy")) {
  throw new Error("Admin UI does not consume Content Strategy metadata from the backend.");
}
if (contentViewSource.includes("/api/topics/${item.id}/generate") || !serverSource.includes("Approve an Intake Recommendation before planning content.")) {
  throw new Error("Content planning is not protected by the Strategy human-approval gate.");
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-to-china-release-"));
try {
  const database = openDatabase(path.join(directory, "release.sqlite"));
  try {
    const versions = database.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((row) => row.version);
    if (versions.join(",") !== "1,2,3,4,5,6,7,8,9,10,11,12,13") throw new Error(`Unexpected migration chain: ${versions.join(",")}`);
    for (const [table, column] of [
      ["content_intake_analyses", "strategy_version"], ["content_recommendations", "strategy_version"],
      ["content_opportunities", "strategy_version"], ["topic_candidates", "strategy_version"],
      ["content_briefs", "strategy_version"], ["content_briefs", "canonical_json"],
      ["article_drafts", "strategy_version"], ["article_drafts", "content_blocks_json"],
      ["quality_reviews", "strategy_version"], ["wordpress_publications", "strategy_version"],
      ["article_visuals", "strategy_version"], ["article_visuals", "image_type"], ["article_visuals", "acquisition_strategy"],
    ]) {
      const columns = database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
      if (!columns.includes(column)) throw new Error(`${table}.${column} is required for Content Strategy governance.`);
    }
    const integrity = database.prepare("PRAGMA integrity_check").get();
    if (Object.values(integrity)[0] !== "ok") throw new Error("Release database integrity check failed.");
  } finally {
    database.close();
  }
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log(`Release check passed: app version alignment, Content Strategy ${CONTENT_STRATEGY.version} governance, migrations 1-12, and SQLite integrity.`);
