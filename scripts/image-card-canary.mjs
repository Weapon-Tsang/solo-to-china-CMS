#!/usr/bin/env node
// L5 Real Provider Canary for Image Cards: sends a fixed set of local images
// through the real extraction path and checks that the provider accepts the
// schema, returns one image_card per image, and that plain photos become ready
// analyses. Hard-capped provider calls, one at a time; nothing is persisted.
//
//   DEEPSEEK_API_KEY=... node scripts/image-card-canary.mjs --provider=deepseek --images=<dir|file,...>
//   GOOGLE_CLOUD_PROJECT=... VERTEX_AI_ACCESS_TOKEN=... node scripts/image-card-canary.mjs --provider=vertex --images=<dir>
//
// Options: --max-calls=2 (hard cap), --per-call=5 (images per request, max 8),
// --out=output/image-card-canary/result.json
// --db=<sqlite> (server use): opened READ-ONLY to pick a fixed, deterministic
//   sample of stored source images (--pick=6) and, when the provider key is not in
//   the environment, to read the stored encrypted model credential.
import fs from "node:fs";
import path from "node:path";
import { KimiExtractor, imageCardMediaAnalysis } from "../src/ai/kimi.mjs";

const option = (name, fallback = null) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const provider = option("provider", "deepseek");
const maxCalls = Math.max(1, Math.min(4, Number(option("max-calls", 2))));
const perCall = Math.max(1, Math.min(8, Number(option("per-call", 5))));
const out = path.resolve(option("out", "output/image-card-canary/result.json"));
const imageArg = option("images");
const dbPath = option("db");
if (!imageArg && !dbPath) {
  console.error("--images=<directory or comma-separated files> or --db=<sqlite> is required.");
  process.exit(2);
}
let db = null;
if (dbPath) {
  const { DatabaseSync } = await import("node:sqlite");
  db = new DatabaseSync(path.resolve(dbPath), { readOnly: true });
  db.exec("PRAGMA query_only=ON");
}
// Deterministic sample: newest complete sources, first stored images of each,
// bounded size, spread across sources so the set mixes photos and cards.
function pickFromDatabase(count) {
  const rows = db.prepare(`SELECT sa.id, sa.local_path, sa.mime_type, sa.source_id FROM source_assets sa
    JOIN sources s ON s.id=sa.source_id AND s.capture_version=sa.capture_version
    WHERE sa.kind='image' AND sa.storage_status='saved' AND sa.local_path<>'' AND sa.original_bytes_status='saved_original'
      AND sa.mime_type IN ('image/jpeg','image/png','image/webp')
    ORDER BY s.captured_at DESC, sa.position ASC LIMIT 400`).all();
  const perSource = new Map();
  const picked = [];
  for (const row of rows) {
    if (picked.length >= count) break;
    if ((perSource.get(row.source_id) || 0) >= 2) continue;
    try { if (fs.statSync(row.local_path).size > 4 * 1024 * 1024) continue; } catch { continue; }
    perSource.set(row.source_id, (perSource.get(row.source_id) || 0) + 1);
    picked.push(row.local_path);
  }
  return picked;
}
const files = (imageArg ? imageArg.split(",") : pickFromDatabase(Math.max(1, Math.min(8, Number(option("pick", 6)))))).flatMap((entry) => {
  const resolved = path.resolve(entry);
  return fs.statSync(resolved).isDirectory()
    ? fs.readdirSync(resolved).filter((name) => /\.(?:jpe?g|png|webp)$/i.test(name)).sort().map((name) => path.join(resolved, name))
    : [resolved];
}).slice(0, maxCalls * perCall);
if (!files.length) throw new Error("No .jpg/.png/.webp images found.");

const mime = (file) => /\.png$/i.test(file) ? "image/png" : /\.webp$/i.test(file) ? "image/webp" : "image/jpeg";
const assets = files.map((file, index) => ({ id: `canary-asset-${index + 1}`, kind: "image", position: index,
  segment_id: `canary-segment-${index + 1}`, mime_type: mime(file), file: path.basename(file),
  ai_derivative_data_url: `data:${mime(file)};base64,${fs.readFileSync(file).toString("base64")}` }));

const env = process.env;
async function storedCredential(name) {
  if (!db) return "";
  const { Repository } = await import("../src/repository.mjs");
  return new Repository(db, { modelCredentialEncryptionKey: String(env.MODEL_CREDENTIAL_ENCRYPTION_KEY || "").trim() })
    .readModelCredential(name) || "";
}
if (provider === "deepseek" && !env.DEEPSEEK_API_KEY) env.DEEPSEEK_API_KEY = await storedCredential("deepseek");
const vertexConfig = provider === "vertex" ? (await import("../src/config.mjs")).loadConfig().vertex : {};
const baseConfig = {
  deepseek: { provider: "deepseek", apiKey: env.DEEPSEEK_API_KEY, model: env.DEEPSEEK_MODEL || "deepseek-flash", baseUrl: env.DEEPSEEK_BASE_URL || "https://api.deepseek.com" },
  vertex: { ...vertexConfig, provider: "vertex", location: env.VERTEX_AI_LOCATION || vertexConfig.location || "global",
    model: env.VERTEX_AI_MODEL || "gemini-3.8-flash" },
  kimi: { provider: "kimi", apiKey: env.KIMI_API_KEY, model: env.KIMI_MODEL, baseUrl: env.KIMI_BASE_URL },
}[provider];
if (!baseConfig) throw new Error("--provider must be deepseek, vertex or kimi.");

const attempts = [];
const extractor = new KimiExtractor({ ...baseConfig, imageBatchSize: perCall, maxImages: perCall, requestTimeoutMs: 180_000,
  stagePolicy: { version: "image-card-canary-1", stages: { source_research_extraction: { class: "extraction",
    requires: ["structured_output", "source_modality"], thinking: "LOW", maxOutputTokens: 16_000, timeoutMs: 180_000, maxAttempts: 1 } } },
  beforeRequest: () => { if (attempts.length >= maxCalls) throw new Error(`Canary exceeded ${maxCalls} provider calls.`); },
  onModelCall: (metric) => attempts.push({ status: metric.attemptStatus, errorCode: metric.errorCode, httpStatus: metric.httpStatus ?? null,
    inputTokens: metric.inputTokens, outputTokens: metric.outputTokens, thinkingTokens: metric.thinkingTokens,
    latencyMs: metric.latencyMs ?? metric.providerRequestMs ?? null, retryReason: metric.retryReason || null }) });
if (!extractor.enabled) throw new Error(`${provider} credentials are not configured in the environment.`);

const started = Date.now();
const report = { canary: "image-card-canary-1", provider, model: baseConfig.model, sampledFromDb: Boolean(db && !imageArg),
  images: assets.map(({ id, file }) => ({ id, file })) };
try {
  const extracted = await extractor.extract({ id: "canary-source", capture_version: 1, title: "Image Card canary",
    raw_text: "Fixed golden images for the Image Card provider canary.", source_kind: "manual_images", assets });
  const cards = extracted.result.image_cards || [];
  const cardsById = new Map(cards.map((card) => [card.asset_id, card]));
  const analyses = new Map((extracted.result.media_analysis || []).map((item) => [item.asset_id, item]));
  report.perImage = assets.map((asset) => {
    const card = cardsById.get(asset.id) || null;
    const analysis = analyses.get(asset.id);
    return { id: asset.id, file: asset.file, card, promotedToReady: Boolean(card && imageCardMediaAnalysis(card)),
      analysisStatus: analysis?.analysis_status || null, analysisVersion: analysis?.analysis_version || null };
  });
  const coverage = cards.length / assets.length;
  report.checks = {
    providerReached: attempts.length > 0,
    schemaAccepted: attempts.some((item) => item.status === "succeeded"),
    noSchemaFallback: !attempts.some((item) => item.errorCode === "SCHEMA_MODE_UNSUPPORTED"),
    no429: !attempts.some((item) => String(item.errorCode) === "429" || item.httpStatus === 429),
    noOutputLimit: !attempts.some((item) => item.errorCode === "MODEL_OUTPUT_LIMIT"),
    cardCoverage: Number(coverage.toFixed(2)),
    claimsReturned: extracted.result.claims.length,
  };
  report.result = report.checks.providerReached && report.checks.schemaAccepted && coverage >= 0.8 ? "PASS" : "FAIL";
  report.semanticReview = "Manually compare perImage[].card subjects, editorial_use and alt_text against the images before accepting.";
} catch (error) {
  report.result = "FAIL";
  report.error = { code: error?.code || error?.name || "UNKNOWN", status: error?.status || null, message: String(error?.message || "").slice(0, 400) };
}
report.calls = attempts.length;
report.attempts = attempts;
report.elapsedMs = Date.now() - started;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ result: report.result, calls: report.calls, checks: report.checks || null, error: report.error || null, out }, null, 2));
if (report.result !== "PASS") process.exitCode = 1;
