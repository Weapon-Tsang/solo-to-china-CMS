import crypto from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/db.mjs";
import { Repository } from "../src/repository.mjs";

const args = process.argv.slice(2);
const value = (name, fallback = "") => args.includes(name) ? args[args.indexOf(name) + 1] || fallback : fallback;
const filename = path.resolve(value("--db"));
const scope = value("--scope", "commercial");
const apply = args.includes("--apply");
const developmentCopy = args.includes("--development-copy");
const requestedDrafts = args.filter((item, index) => args[index - 1] === "--draft");
if (!value("--db")) throw new Error("--db <sqlite-file> is required.");
if (!["commercial", "presentation", "media"].includes(scope)) throw new Error("--scope must be commercial, presentation, or media.");
if (apply && !developmentCopy) throw new Error("--apply requires --development-copy. This tool must never mutate the production database directly.");

const db = apply ? openDatabase(filename) : new DatabaseSync(filename, { readOnly:true });
try {
  const commercialColumns = new Set(db.prepare("PRAGMA table_info(commercial_compositions)").all().map((row) => row.name));
  const commercial = (name, fallback) => commercialColumns.has(name) ? `cc.${name}` : `${fallback} AS ${name}`;
  const clauses = requestedDrafts.length ? `WHERE ad.id IN (${requestedDrafts.map(() => "?").join(",")})` : "";
  const rows = db.prepare(`SELECT ad.id,ad.title,ad.status,ad.revision,ad.content_hash,ad.body_markdown,
      cb.destination_slug,fp.id AS page_id,fp.status AS page_status,fp.draft_revision AS page_revision,
      cc.status AS commercial_status,${commercial("outcome", "NULL")},${commercial("reason_code", "NULL")},cc.overlay_version,${commercial("refresh_required", "0")},
      pc.status AS publish_status,wp.post_id,wp.status AS wordpress_status,wp.response_json,
      (SELECT passed FROM quality_reviews q WHERE q.draft_id=ad.id ORDER BY q.created_at DESC LIMIT 1) AS qa_passed,
      (SELECT group_concat(asset_fingerprint,'|') FROM article_visuals v WHERE v.draft_id=ad.id ORDER BY slot) AS visual_fingerprints,
      EXISTS(SELECT 1 FROM jobs j WHERE j.entity_id=ad.id AND j.status IN ('queued','running')) AS active_job
    FROM article_drafts ad JOIN content_briefs cb ON cb.id=ad.brief_id
    LEFT JOIN frontend_page_compositions fp ON fp.draft_id=ad.id
    LEFT JOIN commercial_compositions cc ON cc.draft_id=ad.id
    LEFT JOIN frontend_publish_compositions pc ON pc.draft_id=ad.id
    LEFT JOIN wordpress_publications wp ON wp.draft_id=ad.id ${clauses}
    ORDER BY ad.updated_at DESC`).all(...requestedDrafts);
  const report = { mode:apply ? "apply_to_development_copy" : "dry_run_read_only", database:filename, scope,
    safeguards:["draft-only", "no body rewrite", "no visual regeneration outside media scope", "no direct WordPress write", "bounded stage enqueue", "active-job conflict stop"],
    items:[] };
  const repository = apply ? new Repository(db) : null;
  for (const row of rows) {
    const remote = safeJson(row.response_json);
    const remotePublished = remote.status && remote.status !== "draft";
    const preserve = { body_sha256:hash(row.body_markdown || ""), visual_fingerprint_sha256:hash(row.visual_fingerprints || "") };
    let action = scope === "commercial" ? "compose_commercial" : scope === "presentation" ? "compose_frontend_page" : "generate_visuals";
    let disposition = "eligible"; let reason = "refresh_only_selected_delivery_layers";
    if (remotePublished) { disposition="diagnose_only"; reason="remote_post_is_not_a_draft"; }
    else if (!row.qa_passed) { disposition="blocked"; reason="current_draft_has_not_passed_qa"; }
    else if (scope === "commercial" && !row.page_id) { disposition="blocked"; reason="validated_editorial_page_missing"; }
    else if (row.active_job) { disposition="conflict"; reason="active_job_exists"; }
    const item = { draft_id:row.id,title:row.title,destination_slug:row.destination_slug,revision:row.revision,
      wordpress_post_id:row.post_id || null,current:{ draft_status:row.status,page_status:row.page_status || null,
        commercial_status:row.commercial_status || null,commercial_outcome:row.outcome || null,
        commercial_reason:row.reason_code || null,publish_status:row.publish_status || null,wordpress_status:row.wordpress_status || null },
      disposition,reason,planned_stage:disposition === "eligible" ? action : null,preserve };
    if (apply && disposition === "eligible") {
      const recoveryRunId = `repair_${hash(`${scope}:${row.id}:${row.revision}`).slice(0,24)}`;
      if (scope === "commercial") db.prepare("UPDATE commercial_compositions SET refresh_required=1,refresh_reason='operator_scoped_repair' WHERE draft_id=?").run(row.id);
      item.job_id = repository.enqueue(action,row.id,{dedupeKey:`delivery-repair:${scope}:${row.id}:r${row.revision}`,
        workloadClass:"historical_recovery",recoveryRunId});
      item.recovery_run_id = recoveryRunId;
    }
    report.items.push(item);
  }
  report.summary = Object.fromEntries(["eligible","blocked","conflict","diagnose_only"].map((key) => [key,report.items.filter((item) => item.disposition === key).length]));
  process.stdout.write(`${JSON.stringify(report,null,2)}\n`);
} finally { db.close(); }

function hash(value) { return crypto.createHash("sha256").update(String(value || "")).digest("hex"); }
function safeJson(value) { try { return JSON.parse(value || "{}"); } catch { return {}; } }
