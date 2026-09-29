#!/usr/bin/env node
// One-time Image Card backfill for stored source photos that have no pixel
// analysis (or only a deferral placeholder). Default is a read-only dry run that
// reports candidates and an estimated request/token budget.
//
//   node scripts/backfill-image-cards.mjs <db.sqlite>                                   # dry run
//   node scripts/backfill-image-cards.mjs <work.sqlite> --execute --limit=40             # writes a copy
//   node scripts/backfill-image-cards.mjs <live.sqlite> --execute --production --limit=N # writes production
//   node scripts/backfill-image-cards.mjs <db.sqlite> --rollback=<ledger.jsonl>          # undo a run
//
// --execute calls Vertex Gemini (at most 8 images per request, one request at a
// time, provider admission limits). Without --production only a copied
// replay/work/canary database is accepted. Writes are additive: an asset that
// already has a non-placeholder analysis is never overwritten. Every written
// asset id is appended to a ledger so --rollback removes exactly those rows.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../src/config.mjs";
import { KimiExtractor, IMAGE_CARD_VERSION, imageCardMediaAnalysis } from "../src/ai/kimi.mjs";
import { createProviderRateLimiter } from "../src/ai/provider-rate-limiter.mjs";
import { isDeferredMediaAnalysisPlaceholder, Repository } from "../src/repository.mjs";

const args = process.argv.slice(2);
const option = (name) => args.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const databasePath = path.resolve(args.find((value) => !value.startsWith("--")) || "");
const execute = args.includes("--execute");
const production = args.includes("--production");
const rollback = option("rollback");
const limit = Math.max(1, Number(option("limit") || 40));
const perRequest = Math.max(1, Math.min(8, Number(option("per-request") || 8)));
const ledgerPath = path.resolve(option("ledger") || `image-card-backfill-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
if (!args.find((value) => !value.startsWith("--"))) {
  console.error("Usage: node scripts/backfill-image-cards.mjs <database.sqlite> [--execute [--production]] [--limit=40] [--per-request=8] [--ledger=path] | --rollback=<ledger>");
  process.exit(2);
}
if (execute && !production && !/(?:replay|work|canary)/i.test(path.basename(databasePath))) {
  throw new Error("--execute only accepts a copied replay/work/canary SQLite file unless --production is given.");
}

const writes = execute || rollback;
const db = new DatabaseSync(databasePath, writes ? {} : { readOnly: true });
// The running worker shares the live database; wait for its write lock instead of failing.
db.exec("PRAGMA busy_timeout=15000");

if (rollback) {
  const ids = fs.readFileSync(path.resolve(rollback), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).assetId);
  const remove = db.prepare("DELETE FROM source_asset_analyses WHERE asset_id=? AND analysis_version=?");
  let removed = 0;
  for (const id of ids) removed += remove.run(id, IMAGE_CARD_VERSION).changes;
  console.log(JSON.stringify({ rollback: path.resolve(rollback), ledgerEntries: ids.length, removed }));
  db.close();
  process.exit(0);
}

const rows = db.prepare(`SELECT sa.id, sa.source_id, sa.local_path, sa.remote_url, sa.mime_type, sa.original_sha256,
    sa.capture_version, saa.analysis_status, saa.asset_kind, saa.confidence AS analysis_confidence,
    saa.primary_subjects_json, saa.text_regions_json, saa.entities_json
  FROM source_assets sa JOIN sources s ON s.id=sa.source_id AND s.capture_version=sa.capture_version
  LEFT JOIN source_asset_analyses saa ON saa.asset_id=sa.id
  WHERE sa.kind='image' AND sa.storage_status='saved' AND sa.local_path<>''
    AND sa.original_bytes_status='saved_original'
  ORDER BY s.captured_at DESC, sa.position ASC`).all();
const candidates = rows.filter((row) => !row.analysis_status || isDeferredMediaAnalysisPlaceholder(row));
const bySource = new Map();
for (const row of candidates) bySource.set(row.source_id, (bySource.get(row.source_id) || 0) + 1);
const requests = Math.ceil(candidates.length / perRequest);
const summary = { database: path.basename(databasePath), production, storedImages: rows.length, candidates: candidates.length,
  sources: bySource.size, estimatedRequests: requests,
  estimatedInputTokens: candidates.length * 1_600 + requests * 700, estimatedOutputTokens: candidates.length * 180 };
console.log(JSON.stringify(summary, null, 2));
if (!execute) {
  console.log("Dry run only. Re-run with --execute (and --production for the live database) to write Image Cards.");
  process.exit(0);
}

const config = loadConfig();
const limiter = createProviderRateLimiter({ spacingMs: config.extraction.requestSpacingMs, limits: config.extraction.providerLimits });
const extractor = new KimiExtractor({ ...config.kimi, ...config.vertex, provider: "vertex", model: "gemini-3.8-flash",
  location: config.vertex.location || "global", stagePolicy: config.ai.stagePolicy, beforeRequest: limiter.beforeRequest,
  sourceUploadsDir: config.manualSources.uploadDir });
if (!extractor.enabled) throw new Error("Vertex Gemini is not configured (GOOGLE_CLOUD_PROJECT).");
const repository = new Repository(db, { sourceUploadsDir: config.manualSources.uploadDir });
const stillUnanalyzed = db.prepare("SELECT analysis_status, asset_kind, confidence AS analysis_confidence, primary_subjects_json, text_regions_json, entities_json FROM source_asset_analyses WHERE asset_id=?");
const selected = candidates.slice(0, limit);
const outcome = { requested: 0, cards: 0, ready: 0, deferred: 0, skipped: 0, raced: 0, failed: 0, ledger: ledgerPath };
for (let index = 0; index < selected.length; index += perRequest) {
  const group = selected.slice(index, index + perRequest);
  try {
    outcome.requested += 1;
    const { cards, model, skipped } = await extractor.describeImageCards(group);
    outcome.skipped += skipped.length;
    for (const card of cards) {
      outcome.cards += 1;
      const analysis = imageCardMediaAnalysis(card);
      // Non-photo cards remain unanalyzed so the dedicated text-region review
      // still discovers them; their card is not a reuse decision.
      if (!analysis) { outcome.deferred += 1; continue; }
      // The live worker may have analysed this asset meanwhile: never overwrite.
      const current = stillUnanalyzed.get(card.asset_id);
      if (current && !isDeferredMediaAnalysisPlaceholder(current)) { outcome.raced += 1; continue; }
      if (repository.saveSourceAssetAnalysis(card.asset_id, analysis, { provider: "vertex", model })) {
        outcome.ready += 1;
        fs.appendFileSync(ledgerPath, `${JSON.stringify({ assetId: card.asset_id, at: new Date().toISOString(), version: IMAGE_CARD_VERSION })}\n`);
      }
    }
  } catch (error) {
    outcome.failed += 1;
    console.error(`request ${outcome.requested} failed: ${error.code || error.message}`);
    if (outcome.failed >= 3) { console.error("Stopping after 3 failed requests."); break; }
  }
}
console.log(JSON.stringify({ ...outcome, remaining: Math.max(0, candidates.length - selected.length) }, null, 2));
db.close();
