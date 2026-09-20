import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const databasePath = path.join(root, "output", "v3-preview", "cms-preview.sqlite");
if (process.argv[2] !== "--isolated-fixture" || process.env.NODE_ENV === "production") {
  throw new Error("This fixture only targets output/v3-preview/cms-preview.sqlite with --isolated-fixture.");
}

const db = openDatabase(databasePath);
try {
  const opportunities = db.prepare(`INSERT OR IGNORE INTO content_opportunities
    (id,destination_slug,topic_key,strategy_version,candidate_id,title,content_type,readiness_score,
      readiness_json,coverage_json,status,approved_at,created_at,updated_at,lifecycle_state)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const candidates = db.prepare(`INSERT OR IGNORE INTO topic_candidates
    (id,destination_slug,topic_key,proposed_title,rationale,coverage_score,evidence_count,
      conflict_count,status,created_at,updated_at) VALUES (?,?,?,?,?,80,2,0,'drafted',?,?)`);
  const briefs = db.prepare(`INSERT OR IGNORE INTO content_briefs
    (id,destination_slug,topic,audience,search_intent,status,created_at,updated_at,candidate_id)
    VALUES (?,'beijing',?,'first-time traveler','informational','ready',?,?,?)`);
  const drafts = db.prepare(`INSERT OR IGNORE INTO article_drafts
    (id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at,revision,content_hash)
    VALUES (?,?,?,?,?,?,'review',?,?,1,?)`);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < 121; index += 1) {
      const id = String(index).padStart(3, "0");
      const timestamp = `2026-09-18T${String(index % 24).padStart(2, "0")}:00:00.000Z`;
      const candidate = `v3-preview-candidate-${id}`;
      candidates.run(candidate, "beijing", `v3-preview:candidate:${id}`, `TEST DATA · Beijing guide ${id}`,
        "Isolated performance fixture, not editorial advice", timestamp, timestamp);
      opportunities.run(`v3-preview-opp-${id}`, "beijing", `v3-preview:opportunity:${id}`, "3.8", candidate,
        `TEST DATA · Beijing guide ${id}`, "practical_guide", 80, '{"ready":true}', "{}",
        "approved_ready", timestamp, timestamp, timestamp, "approved");
      if (index < 60) {
        briefs.run(`v3-preview-brief-${id}`, `TEST DATA · Beijing guide ${id}`, timestamp, timestamp, candidate);
        drafts.run(`v3-preview-draft-${id}`, `v3-preview-brief-${id}`, `TEST DATA · Long guide ${id}`,
          `test-data-guide-${id}`, "Test-only long article body. ".repeat(400), '{"issues":[]}',
          timestamp, timestamp, `v3-test-hash-${id}`);
      }
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  process.stdout.write(`Isolated fixture: ${db.prepare("SELECT COUNT(*) AS n FROM content_opportunities WHERE id LIKE 'v3-preview-%'").get().n} opportunities, ${db.prepare("SELECT COUNT(*) AS n FROM article_drafts WHERE id LIKE 'v3-preview-%'").get().n} drafts.\n`);
} finally { db.close(); }
