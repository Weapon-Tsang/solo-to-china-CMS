import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createBackup, drillBackup, restoreBackup, verifyBackup } from "../src/backup.mjs";
import { openDatabase, SCHEMA_VERSION } from "../src/db.mjs";

const JPEG_BYTES = Buffer.from("/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJXAIf/Z", "base64");
const PNG_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC", "base64");

test("system snapshot hashes the database, uploads and generated media and drills an offline delivery", (t) => {
  const fixture = backupFixture(t);
  const result = createBackup({
    databasePath: fixture.databasePath,
    backupDir: fixture.backupDir,
    sourceUploadsDir: fixture.uploadsDir,
    generatedMediaDir: fixture.mediaDir,
    retention: 2,
    offsiteLocation: "gs://controlled-backups/solo-to-china",
    offsiteRetentionDays: 90,
    codeRevision: "engine@sha256:fixture",
    reason: "pre-upgrade",
    clock: () => new Date("2026-08-23T12:00:00.000Z"),
  });

  assert.equal(result.schemaVersion, SCHEMA_VERSION);
  assert.equal(result.integrity, "ok");
  assert.ok(fs.statSync(result.backupPath).isDirectory());
  const verification = verifyBackup(result.backupPath);
  assert.equal(verification.sha256, result.sha256);
  assert.equal(verification.fileCount, 3);
  assert.equal(verification.referenceCount, 3);
  assert.equal(verification.manifest.reason, "pre-upgrade");
  assert.equal(verification.manifest.application.codeRevision, "engine@sha256:fixture");
  assert.equal(verification.manifest.retention.offsiteRetentionDays, 90);
  assert.equal(verification.manifest.secrets.included, false);
  assert.equal(verification.manifest.version, 3);
  assert.equal(verification.manifest.businessFingerprints.find((item) => item.table === "sources").count, 1);
  assert.equal(verification.manifest.businessFingerprints.find((item) => item.table === "article_drafts").count, 1);
  assert.doesNotMatch(fs.readFileSync(result.manifestPath, "utf8"), /fixture-password/);

  const drill = drillBackup(result.backupPath);
  assert.equal(drill.drill, "passed");
  assert.equal(drill.externalSideEffects, false);
  assert.equal(drill.counts.source_files, 1);
  assert.equal(drill.counts.article_drafts, 1);
  assert.equal(drill.evidencePreviewsOpened, 2);
  assert.equal(drill.draftMediaOpened, 1);
  assert.deepEqual(drill.references.map((item) => item.opened), [true, true, true]);
  assert.deepEqual(drill.references.map((item) => item.mimeVerified), [true, true, true]);
  assert.deepEqual(drill.deliveryProbe, {
    status: "passed", draftId: "draft-1", state: "ready_for_wordpress", mockDeliveryCalls: 1,
    externalModelCalls: 0, externalWordPressCalls: 0, restoredMediaCount: 1,
  });
});

test("restore verification rejects a deleted database-referenced image", (t) => {
  const fixture = backupFixture(t);
  const result = createBackup({
    databasePath: fixture.databasePath, backupDir: fixture.backupDir,
    sourceUploadsDir: fixture.uploadsDir, generatedMediaDir: fixture.mediaDir,
    clock: () => new Date("2026-08-24T12:00:00.000Z"),
  });
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
  const referenced = manifest.databaseReferences.find((item) => item.table === "source_files");
  fs.rmSync(path.join(result.backupPath, ...referenced.archivePath.split("/")));
  assert.throws(() => drillBackup(result.backupPath), /Snapshot file is missing/);
});

test("snapshot refuses source bytes that disagree with the database fingerprint", (t) => {
  const fixture = backupFixture(t);
  fs.writeFileSync(path.join(fixture.uploadsDir, "route.jpg"), "different source bytes");
  assert.throws(() => createBackup({ databasePath: fixture.databasePath, backupDir: fixture.backupDir,
    sourceUploadsDir: fixture.uploadsDir, generatedMediaDir: fixture.mediaDir }), /Database media hash mismatch/);
});

test("restore drill rejects media whose bytes disagree with its declared MIME", (t) => {
  const fixture = backupFixture(t);
  const database = openDatabase(fixture.databasePath, { migrate: false });
  database.prepare("UPDATE source_files SET mime_type='image/png' WHERE id='file-1'").run();
  database.close();
  const result = createBackup({ databasePath: fixture.databasePath, backupDir: fixture.backupDir,
    sourceUploadsDir: fixture.uploadsDir, generatedMediaDir: fixture.mediaDir });
  assert.throws(() => drillBackup(result.backupPath), /Restored media MIME mismatch \(image\/png\)/);
});

test("direct restore rejects media whose bytes disagree with its declared MIME before activation", (t) => {
  const fixture = backupFixture(t);
  const database = openDatabase(fixture.databasePath, { migrate: false });
  database.prepare("UPDATE source_files SET mime_type='image/png' WHERE id='file-1'").run();
  database.close();
  const result = createBackup({ databasePath: fixture.databasePath, backupDir: fixture.backupDir,
    sourceUploadsDir: fixture.uploadsDir, generatedMediaDir: fixture.mediaDir });
  const target = path.join(fixture.directory, "mime-mismatch-restore");
  assert.throws(() => restoreBackup(result.backupPath, target), /Restored media MIME mismatch \(image\/png\)/);
  assert.equal(fs.existsSync(target), false);
});

test("restore refuses a snapshot from a newer schema before creating a target", (t) => {
  const fixture = backupFixture(t);
  const snapshot = createBackup({ databasePath: fixture.databasePath, backupDir: fixture.backupDir,
    sourceUploadsDir: fixture.uploadsDir, generatedMediaDir: fixture.mediaDir,
    clock: () => new Date("2026-08-24T13:00:00.000Z") });
  const databaseFile = path.join(snapshot.backupPath, "database.sqlite");
  const db = openDatabase(databaseFile);
  try { db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)").run(SCHEMA_VERSION + 1, "2026-08-24T13:00:00Z"); }
  finally { db.close(); }
  const manifest = JSON.parse(fs.readFileSync(snapshot.manifestPath, "utf8"));
  manifest.application.schemaVersion = SCHEMA_VERSION + 1;
  const entry = manifest.files.find((file) => file.archivePath === "database.sqlite");
  entry.bytes = fs.statSync(databaseFile).size;
  entry.sha256 = crypto.createHash("sha256").update(fs.readFileSync(databaseFile)).digest("hex");
  fs.writeFileSync(snapshot.manifestPath, JSON.stringify(manifest));
  const target = path.join(fixture.directory, "future-restore");
  assert.throws(() => restoreBackup(snapshot.backupPath, target), /newer than supported schema/);
  assert.equal(fs.existsSync(target), false);
});

test("restore refuses insufficient free space before creating target or staging", (t) => {
  const fixture = backupFixture(t);
  const snapshot = createBackup({ databasePath: fixture.databasePath, backupDir: fixture.backupDir,
    sourceUploadsDir: fixture.uploadsDir, generatedMediaDir: fixture.mediaDir });
  const target = path.join(fixture.directory, "no-space-target");
  const statfsSync = fs.statfsSync;
  fs.statfsSync = () => ({ bavail: 1n, bsize: 1n });
  try {
    assert.throws(() => restoreBackup(snapshot.backupPath, target),
      (error) => error.code === "RESTORE_INSUFFICIENT_SPACE" && BigInt(error.requiredBytes) > 1n);
  } finally { fs.statfsSync = statfsSync; }
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(`${target}.incomplete`), false);
  assert.equal(verifyBackup(snapshot.backupPath).integrity, "ok");
});

test("an interrupted restore resumes only the same snapshot and repairs partial files", (t) => {
  const fixture = backupFixture(t);
  const first = createBackup({ databasePath: fixture.databasePath, backupDir: fixture.backupDir,
    sourceUploadsDir: fixture.uploadsDir, generatedMediaDir: fixture.mediaDir, retention: 2,
    clock: () => new Date("2026-08-25T13:00:00.000Z") });
  const second = createBackup({ databasePath: fixture.databasePath, backupDir: fixture.backupDir,
    sourceUploadsDir: fixture.uploadsDir, generatedMediaDir: fixture.mediaDir, retention: 2,
    clock: () => new Date("2026-08-25T14:00:00.000Z") });
  const target = path.join(fixture.directory, "interrupted-target");
  const copyFileSync = fs.copyFileSync;
  let copied = 0;
  fs.copyFileSync = (...args) => {
    copied++;
    if (copied === 2) {
      fs.writeFileSync(args[1], "partial bytes");
      throw Object.assign(new Error("Injected copy interruption"), { code: "ENOSPC" });
    }
    return copyFileSync(...args);
  };
  try { assert.throws(() => restoreBackup(first.backupPath, target), /Injected copy interruption/); }
  finally { fs.copyFileSync = copyFileSync; }
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(`${target}.incomplete`), true);
  assert.throws(() => restoreBackup(first.backupPath, target), /use --restore-resume/);
  assert.throws(() => restoreBackup(second.backupPath, target, { resume: true }), /does not belong/);
  const restored = restoreBackup(first.backupPath, target, { resume: true });
  assert.equal(restored.mode, "migration-review");
  assert.equal(fs.existsSync(target), true);
  assert.equal(fs.existsSync(`${target}.incomplete`), false);
  assert.equal(verifyBackup(first.backupPath).integrity, "ok");
});

test("restore migrates an older snapshot only inside the isolated target", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cms-old-restore-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = fs.readFileSync(new URL("../src/db.mjs", import.meta.url), "utf8")
    .replace(/^  if \(current < 79\) migrationSeventyNine\(db\);$/m, "")
    .replace(/^  if \(current < 81\) migrationEightyOne\(db\);$/m, '')
    .replace(/^  if \(current < 82\) migrationEightyTwo\(db\);$/m, '')
    .replace(/^  if \(current < 80\) migrationEighty\(db\);$/m, "");
  const oldModule = path.join(directory, "db-v78.mjs");
  fs.writeFileSync(oldModule, source);
  const { openDatabase: openV78 } = await import(pathToFileURL(oldModule).href);
  const databasePath = path.join(directory, "original.sqlite");
  openV78(databasePath).close();
  const snapshot = createBackup({ databasePath, backupDir: path.join(directory, "backups"),
    clock: () => new Date("2026-08-24T14:00:00.000Z") });
  assert.equal(snapshot.schemaVersion, 78);
  const target = path.join(directory, "restored");
  const result = restoreBackup(snapshot.backupPath, target);
  assert.equal(result.schemaVersionFrom, 78);
  assert.equal(result.schemaVersionTo, SCHEMA_VERSION);
  const restored = openDatabase(result.databasePath, { migrate: false });
  try { assert.equal(restored.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, SCHEMA_VERSION); }
  finally { restored.close(); }
  const sourceDb = openV78(databasePath);
  try { assert.equal(sourceDb.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 78); }
  finally { sourceDb.close(); }
});

test("snapshot verification compares manifest hashes rather than only file sizes", (t) => {
  const fixture = backupFixture(t);
  const result = createBackup({
    databasePath: fixture.databasePath, backupDir: fixture.backupDir,
    sourceUploadsDir: fixture.uploadsDir, generatedMediaDir: fixture.mediaDir,
    clock: () => new Date("2026-08-25T12:00:00.000Z"),
  });
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
  const media = manifest.files.find((item) => item.category === "generated_media");
  const filename = path.join(result.backupPath, ...media.archivePath.split("/"));
  const bytes = fs.readFileSync(filename);
  bytes[0] ^= 0xff;
  fs.writeFileSync(filename, bytes);
  assert.throws(() => verifyBackup(result.backupPath), /Snapshot hash mismatch/);
});

test("snapshot verification rejects an omitted database file reference", (t) => {
  const fixture = backupFixture(t);
  const result = createBackup({ databasePath: fixture.databasePath, backupDir: fixture.backupDir,
    sourceUploadsDir: fixture.uploadsDir, generatedMediaDir: fixture.mediaDir });
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
  manifest.databaseReferences.pop();
  fs.writeFileSync(result.manifestPath, JSON.stringify(manifest));
  assert.throws(() => verifyBackup(result.backupPath), /reference inventory is incomplete/);
});

test("snapshot verification rejects omitted, altered, and untrusted business fingerprints", (t) => {
  const fixture = backupFixture(t);
  const result = createBackup({ databasePath: fixture.databasePath, backupDir: fixture.backupDir,
    sourceUploadsDir: fixture.uploadsDir, generatedMediaDir: fixture.mediaDir });
  const original = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
  const write = (manifest) => fs.writeFileSync(result.manifestPath, JSON.stringify(manifest));

  const missing = structuredClone(original);
  delete missing.businessFingerprints;
  write(missing);
  assert.throws(() => verifyBackup(result.backupPath), /no business fingerprint inventory/);

  const altered = structuredClone(original);
  altered.businessFingerprints.find((item) => item.table === "sources").count++;
  write(altered);
  assert.throws(() => verifyBackup(result.backupPath), /business fingerprint mismatch: sources/);

  const unknownColumn = structuredClone(original);
  unknownColumn.businessFingerprints.find((item) => item.table === "sources").columns.push("nonexistent_column");
  write(unknownColumn);
  assert.throws(() => verifyBackup(result.backupPath), /business fingerprint definition is invalid/);

  write(original);
  assert.equal(verifyBackup(result.backupPath).integrity, "ok");
});

test("business fingerprint catches changed source state after the database file hash is updated", (t) => {
  const fixture = backupFixture(t);
  const result = createBackup({ databasePath: fixture.databasePath, backupDir: fixture.backupDir,
    sourceUploadsDir: fixture.uploadsDir, generatedMediaDir: fixture.mediaDir });
  const databaseFile = path.join(result.backupPath, "database.sqlite");
  const db = openDatabase(databaseFile, { migrate: false });
  try { db.prepare("UPDATE sources SET status='failed' WHERE id='source-1'").run(); }
  finally { db.close(); }
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
  const entry = manifest.files.find((item) => item.archivePath === "database.sqlite");
  entry.bytes = fs.statSync(databaseFile).size;
  entry.sha256 = crypto.createHash("sha256").update(fs.readFileSync(databaseFile)).digest("hex");
  manifest.database.bytes = entry.bytes;
  manifest.database.sha256 = entry.sha256;
  fs.writeFileSync(result.manifestPath, JSON.stringify(manifest));
  assert.throws(() => verifyBackup(result.backupPath), /business fingerprint mismatch: sources/);
});

test("snapshot includes durable source storage references and pending capture chunks", (t) => {
  const fixture = backupFixture(t);
  const original = path.join(fixture.uploadsDir, "original.bin");
  const derivative = path.join(fixture.uploadsDir, "derivative.bin");
  const captures = path.join(fixture.directory, "capture-uploads");
  const mediaCaptures = path.join(fixture.directory, "capture-media-uploads");
  fs.mkdirSync(captures);
  fs.mkdirSync(mediaCaptures);
  fs.writeFileSync(original, "original bytes");
  fs.writeFileSync(derivative, "derivative bytes");
  fs.writeFileSync(path.join(fixture.uploadsDir, "new-original.jpg.tmp"), "incomplete source upload");
  fs.writeFileSync(path.join(fixture.uploadsDir, "unfinished-original.part"), "incomplete assembly");
  fs.mkdirSync(path.join(fixture.uploadsDir, ".media-recovery"));
  fs.writeFileSync(path.join(fixture.uploadsDir, ".media-recovery", "in-flight.part"), "incomplete recovery");
  fs.mkdirSync(path.join(fixture.uploadsDir, ".staging"));
  fs.writeFileSync(path.join(fixture.uploadsDir, ".staging", "pending.part"), "committed legacy upload chunk");
  fs.writeFileSync(path.join(captures, "pending.part"), "pending chunk");
  fs.writeFileSync(path.join(captures, "in-progress.part.tmp"), "incomplete chunk");
  fs.writeFileSync(path.join(mediaCaptures, "000000.part"), "committed media chunk");
  fs.writeFileSync(path.join(mediaCaptures, "receipt.json.tmp"), "incomplete receipt");
  const db = openDatabase(fixture.databasePath, { migrate: false });
  db.prepare(`INSERT INTO source_asset_storage_refs(asset_id,original_storage_ref,derivative_storage_ref,created_at,updated_at)
    VALUES ('asset-1',?,?, 'now','now')`).run(original, derivative);
  db.close();
  const result = createBackup({ databasePath: fixture.databasePath, backupDir: fixture.backupDir,
    sourceUploadsDir: fixture.uploadsDir, generatedMediaDir: fixture.mediaDir,
    captureUploadsDir: captures, captureMediaUploadsDir: mediaCaptures });
  const verification = verifyBackup(result.backupPath);
  assert.equal(verification.manifest.databaseReferences.filter((item) => item.table === "source_asset_storage_refs").length, 2);
  assert.ok(verification.manifest.files.some((item) => item.category === "capture_upload"));
  assert.ok(verification.manifest.files.some((item) => item.category === "capture_media_upload" && item.archivePath.endsWith("000000.part")));
  assert.equal(verification.manifest.files.some((item) => item.archivePath.endsWith("in-progress.part.tmp")), false);
  assert.equal(verification.manifest.files.some((item) => item.archivePath.endsWith("receipt.json.tmp")), false);
  assert.equal(verification.manifest.files.some((item) => item.archivePath.endsWith("new-original.jpg.tmp")), false);
  assert.equal(verification.manifest.files.some((item) => item.archivePath.endsWith("unfinished-original.part")), false);
  assert.equal(verification.manifest.files.some((item) => item.archivePath.includes(".media-recovery")), false);
  assert.equal(verification.manifest.files.some((item) => item.archivePath.endsWith(".staging/pending.part")), true);
  assert.equal(drillBackup(result.backupPath).drill, "passed");
});

test("snapshot restores an unpromoted visual candidate file and its database path", (t) => {
  const fixture = backupFixture(t);
  const candidatePath = path.join(fixture.mediaDir, "pending-candidate.png");
  fs.writeFileSync(candidatePath, PNG_BYTES);
  const db = openDatabase(fixture.databasePath, { migrate: false });
  db.prepare(`INSERT INTO visual_candidates(id,visual_id,draft_id,transform_input_hash,output_hash,
    media_path,mime_type,byte_size,provider,model,created_at,updated_at)
    VALUES ('candidate-1','visual-1','draft-1','input-hash','output-hash',?,'image/png',?,
      'fixture','fixture','now','now')`).run(candidatePath, fs.statSync(candidatePath).size);
  db.close();
  const snapshot = createBackup({ databasePath: fixture.databasePath, backupDir: fixture.backupDir,
    sourceUploadsDir: fixture.uploadsDir, generatedMediaDir: fixture.mediaDir });
  assert.equal(verifyBackup(snapshot.backupPath).manifest.databaseReferences.some((item) =>
    item.table === "visual_candidates" && item.rowId === "candidate-1"), true);
  const restored = restoreBackup(snapshot.backupPath, path.join(fixture.directory, "candidate-restored"));
  const restoredDb = openDatabase(restored.databasePath, { migrate: false });
  try {
    const candidate = restoredDb.prepare("SELECT media_path,status FROM visual_candidates WHERE id='candidate-1'").get();
    assert.equal(candidate.status, "pending_qa");
    assert.ok(candidate.media_path.startsWith(restored.restoredRoot));
    assert.equal(sha256(candidate.media_path), sha256(candidatePath));
  } finally { restoredDb.close(); }
});

test("snapshot preserves and remaps file paths nested in historical capture JSON", (t) => {
  const fixture = backupFixture(t);
  const historical = path.join(fixture.directory, "historical-original.bin");
  fs.writeFileSync(historical, "historical capture bytes");
  const payload = { assets: [{ localPath: historical, derivativeStorageRef: historical }],
    files: [{ storagePath: historical }] };
  const db = openDatabase(fixture.databasePath, { migrate: false });
  db.prepare("UPDATE sources SET raw_payload_json=? WHERE id='source-1'").run(JSON.stringify(payload));
  db.prepare(`INSERT INTO capture_versions(id,source_id,capture_version,captured_at,raw_text,raw_html,
    raw_payload_json,assets_json,content_hash,completeness_status,completeness_json,
    acquisition_origin,created_at) VALUES ('capture-1','source-1',1,'now','Evidence','',
    ?,?,'hash','complete','{}','manual_upload','now')`)
    .run(JSON.stringify(payload), JSON.stringify(payload.assets));
  db.close();

  const snapshot = createBackup({ databasePath: fixture.databasePath, backupDir: fixture.backupDir,
    sourceUploadsDir: fixture.uploadsDir, generatedMediaDir: fixture.mediaDir });
  const verified = verifyBackup(snapshot.backupPath);
  const nested = verified.manifest.databaseReferences.filter((item) => item.category === "capture_history");
  assert.equal(nested.length, 8);
  assert.ok(nested.every((item) => Array.isArray(item.jsonPath) && item.sha256 === sha256(historical)));
  const incompleteManifest = structuredClone(verified.manifest);
  incompleteManifest.databaseReferences = incompleteManifest.databaseReferences.filter((item) => item !== nested[0]
    && !(item.table === nested[0].table && item.rowId === nested[0].rowId
      && item.column === nested[0].column && JSON.stringify(item.jsonPath) === JSON.stringify(nested[0].jsonPath)));
  fs.writeFileSync(snapshot.manifestPath, JSON.stringify(incompleteManifest));
  assert.throws(() => verifyBackup(snapshot.backupPath), /reference inventory is incomplete/);
  fs.writeFileSync(snapshot.manifestPath, JSON.stringify(verified.manifest));
  const restored = restoreBackup(snapshot.backupPath, path.join(fixture.directory, "history-restored"));
  const recovered = openDatabase(restored.databasePath, { migrate: false });
  try {
    const source = JSON.parse(recovered.prepare("SELECT raw_payload_json FROM sources WHERE id='source-1'").get().raw_payload_json);
    const capture = recovered.prepare("SELECT raw_payload_json,assets_json FROM capture_versions WHERE id='capture-1'").get();
    const restoredPath = source.assets[0].localPath;
    assert.equal(fs.readFileSync(restoredPath, "utf8"), "historical capture bytes");
    assert.notEqual(restoredPath, historical);
    assert.equal(source.files[0].storagePath, restoredPath);
    assert.equal(JSON.parse(capture.raw_payload_json).assets[0].derivativeStorageRef, restoredPath);
    assert.equal(JSON.parse(capture.assets_json)[0].localPath, restoredPath);
  } finally { recovered.close(); }
});

test("snapshot rejects a missing file referenced only by historical capture JSON", (t) => {
  const fixture = backupFixture(t);
  const missing = path.join(fixture.directory, "lost-history.bin");
  const db = openDatabase(fixture.databasePath, { migrate: false });
  db.prepare("UPDATE sources SET raw_payload_json=? WHERE id='source-1'")
    .run(JSON.stringify({ assets: [{ localPath: missing }] }));
  db.close();
  assert.throws(() => createBackup({ databasePath: fixture.databasePath, backupDir: fixture.backupDir,
    sourceUploadsDir: fixture.uploadsDir, generatedMediaDir: fixture.mediaDir }),
  /Database references missing capture_history file/);
});

test("version 2 manifests remain readable without version 3 JSON references", (t) => {
  const fixture = backupFixture(t);
  const db = openDatabase(fixture.databasePath, { migrate: false });
  db.prepare("UPDATE sources SET raw_payload_json=? WHERE id='source-1'")
    .run(JSON.stringify({ assets: [{ localPath: path.join(fixture.uploadsDir, "route.jpg") }] }));
  db.close();
  const snapshot = createBackup({ databasePath: fixture.databasePath, backupDir: fixture.backupDir,
    sourceUploadsDir: fixture.uploadsDir, generatedMediaDir: fixture.mediaDir });
  const legacy = JSON.parse(fs.readFileSync(snapshot.manifestPath, "utf8"));
  legacy.version = 2;
  delete legacy.businessFingerprints;
  legacy.databaseReferences = legacy.databaseReferences.filter((item) => !item.jsonPath);
  fs.writeFileSync(snapshot.manifestPath, JSON.stringify(legacy));
  assert.equal(verifyBackup(snapshot.backupPath).integrity, "ok");
  assert.equal(drillBackup(snapshot.backupPath).drill, "passed");
});

test("version 2 recovers omitted relative source storage references only from archived files", (t) => {
  const fixture = backupFixture(t);
  const digest = crypto.createHash("sha256").update(JPEG_BYTES).digest("hex");
  const originalRef = `media/${digest.slice(0, 2)}/${digest}.jpg`;
  const derivativeRef = `.derived/${digest.slice(0, 2)}/${digest}.jpg`;
  for (const ref of [originalRef, derivativeRef]) {
    const filename = path.join(fixture.uploadsDir, ref);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, JPEG_BYTES);
  }
  const db = openDatabase(fixture.databasePath, { migrate: false });
  db.prepare(`INSERT INTO source_asset_storage_refs(asset_id,original_storage_ref,derivative_storage_ref,created_at,updated_at)
    VALUES ('asset-1',?,?,'now','now')`).run(originalRef, derivativeRef);
  db.close();
  const snapshot = createBackup({ databasePath: fixture.databasePath, backupDir: fixture.backupDir,
    sourceUploadsDir: fixture.uploadsDir, generatedMediaDir: fixture.mediaDir });
  const legacy = JSON.parse(fs.readFileSync(snapshot.manifestPath, "utf8"));
  legacy.version = 2;
  delete legacy.businessFingerprints;
  legacy.databaseReferences = legacy.databaseReferences.filter((item) => item.table !== "source_asset_storage_refs");
  fs.writeFileSync(snapshot.manifestPath, JSON.stringify(legacy));
  const verification = verifyBackup(snapshot.backupPath);
  assert.equal(verification.effectiveDatabaseReferences.filter((item) => item.table === "source_asset_storage_refs").length, 2);
  const restored = restoreBackup(snapshot.backupPath, path.join(fixture.directory, "legacy-relative-restored"));
  const restoredDb = openDatabase(restored.databasePath, { migrate: false });
  try {
    const row = restoredDb.prepare("SELECT original_storage_ref,derivative_storage_ref FROM source_asset_storage_refs WHERE asset_id='asset-1'").get();
    assert.equal(row.original_storage_ref, originalRef);
    assert.equal(row.derivative_storage_ref, derivativeRef);
    assert.ok(fs.existsSync(path.join(restored.restoredRoot, "source-uploads", originalRef)));
  } finally { restoredDb.close(); }

  const missing = legacy.files.find((item) => item.archivePath === `files/source-uploads/${derivativeRef}`);
  legacy.files = legacy.files.filter((item) => item !== missing);
  fs.writeFileSync(snapshot.manifestPath, JSON.stringify(legacy));
  assert.throws(() => verifyBackup(snapshot.backupPath), /reference file is missing/);
});

test("snapshot rejects case collisions and archive symlinks", (t) => {
  const fixture = backupFixture(t);
  const result = createBackup({ databasePath: fixture.databasePath, backupDir: fixture.backupDir,
    sourceUploadsDir: fixture.uploadsDir, generatedMediaDir: fixture.mediaDir });
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
  manifest.files.push({ ...manifest.files[0], archivePath: manifest.files[0].archivePath.toUpperCase() });
  fs.writeFileSync(result.manifestPath, JSON.stringify(manifest));
  assert.throws(() => verifyBackup(result.backupPath), /case-colliding/);
  manifest.files.pop();
  fs.writeFileSync(result.manifestPath, JSON.stringify(manifest));
  const media = manifest.files.find((item) => item.category === "generated_media");
  const filename = path.join(result.backupPath, ...media.archivePath.split("/"));
  const outside = path.join(fixture.directory, "outside.bin");
  fs.copyFileSync(filename, outside);
  fs.rmSync(filename);
  try { fs.symlinkSync(outside, filename, "file"); }
  catch (error) { if (["EPERM", "EACCES"].includes(error.code)) return; throw error; }
  assert.throws(() => verifyBackup(result.backupPath), /symbolic link/);
});

test("snapshot restores to a new external root and remaps only stored file references", (t) => {
  const fixture = backupFixture(t);
  const queued = openDatabase(fixture.databasePath, { migrate: false });
  const originalUpload = queued.prepare("SELECT storage_path FROM source_files WHERE id='file-1'").get().storage_path;
  queued.prepare("INSERT INTO source_delete_file_queue(path,queued_at) VALUES (?,?)").run(originalUpload, "2026-01-01");
  queued.prepare("INSERT INTO source_delete_file_queue(path,queued_at) VALUES (?,?)")
    .run(path.join(fixture.uploadsDir, "already-deleted.bin"), "2026-01-01");
  queued.close();
  const result = createBackup({ databasePath: fixture.databasePath, backupDir: fixture.backupDir,
    sourceUploadsDir: fixture.uploadsDir, generatedMediaDir: fixture.mediaDir });
  const target = path.join(fixture.directory, "restored-on-new-machine");
  const restored = restoreBackup(result.backupPath, target);
  assert.equal(restored.mode, "migration-review");
  assert.equal(restored.externalSideEffects, false);
  assert.deepEqual(restored.deletionQueue, { remapped: 1, discarded: 1 });
  const db = openDatabase(restored.databasePath, { migrate: false });
  try {
    const row = db.prepare("SELECT storage_path FROM source_files WHERE id='file-1'").get();
    assert.ok(row.storage_path.startsWith(target));
    assert.equal(sha256(row.storage_path), sha256(path.join(fixture.uploadsDir, "route.jpg")));
    assert.deepEqual(db.prepare("SELECT path FROM source_delete_file_queue").all().map((item) => item.path), [row.storage_path]);
    assert.equal(db.prepare("SELECT body_markdown FROM article_drafts WHERE id='draft-1'").get().body_markdown,
      "## Route\n\nRecovered body.");
  } finally { db.close(); }
  assert.throws(() => restoreBackup(result.backupPath, target), /already exists/);
});

test("restore remaps a POSIX stored path fixture on Windows without changing unrelated text", (t) => {
  const fixture = backupFixture(t);
  const result = createBackup({ databasePath: fixture.databasePath, backupDir: fixture.backupDir,
    sourceUploadsDir: fixture.uploadsDir, generatedMediaDir: fixture.mediaDir });
  const oldPath = "/old-linux/source-uploads/route.jpg";
  const databaseFile = path.join(result.backupPath, "database.sqlite");
  const snapshotDb = openDatabase(databaseFile, { migrate: false });
  snapshotDb.prepare("UPDATE source_files SET storage_path=? WHERE id='file-1'").run(oldPath);
  snapshotDb.close();
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
  manifest.databaseReferences.find((item) => item.table === "source_files").storedPath = oldPath;
  const dbEntry = manifest.files.find((item) => item.archivePath === "database.sqlite");
  dbEntry.bytes = fs.statSync(databaseFile).size;
  dbEntry.sha256 = sha256(databaseFile);
  manifest.database.bytes = dbEntry.bytes;
  manifest.database.sha256 = dbEntry.sha256;
  fs.writeFileSync(result.manifestPath, JSON.stringify(manifest));
  const restored = restoreBackup(result.backupPath, path.join(fixture.directory, "portable-restore"));
  const db = openDatabase(restored.databasePath, { migrate: false });
  try {
    const file = db.prepare("SELECT storage_path FROM source_files WHERE id='file-1'").get();
    assert.ok(file.storage_path.startsWith(restored.restoredRoot));
    assert.equal(sha256(file.storage_path), sha256(path.join(fixture.uploadsDir, "route.jpg")));
    assert.equal(db.prepare("SELECT body_markdown FROM article_drafts WHERE id='draft-1'").get().body_markdown,
      "## Route\n\nRecovered body.");
  } finally { db.close(); }
});

test("snapshot refuses to race an active media file mutation", (t) => {
  const fixture = backupFixture(t);
  const lease = path.join(fixture.directory, ".cms-media-mutation.lock");
  fs.writeFileSync(lease, "fixture");
  assert.throws(() => createBackup({ databasePath: fixture.databasePath, backupDir: fixture.backupDir,
    sourceUploadsDir: fixture.uploadsDir, generatedMediaDir: fixture.mediaDir }),
  (error) => error.code === "MEDIA_FILE_BUSY");
  assert.equal(fs.existsSync(fixture.backupDir), false);
});

test("restore refuses a symbolic-link ancestor before creating the target", (t) => {
  const fixture = backupFixture(t);
  const result = createBackup({ databasePath: fixture.databasePath, backupDir: fixture.backupDir,
    sourceUploadsDir: fixture.uploadsDir, generatedMediaDir: fixture.mediaDir });
  const real = path.join(fixture.directory, "real-target-parent");
  const alias = path.join(fixture.directory, "target-alias");
  fs.mkdirSync(real);
  try { fs.symlinkSync(real, alias, "dir"); }
  catch (error) { if (["EPERM", "EACCES"].includes(error.code)) return; throw error; }
  assert.throws(() => restoreBackup(result.backupPath, path.join(alias, "restored")), /Symbolic-link path/);
  assert.equal(fs.existsSync(path.join(real, "restored")), false);
});

function backupFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-to-china-backup-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "source.sqlite");
  const uploadsDir = path.join(directory, "source-uploads");
  const mediaDir = path.join(directory, "generated-media");
  const backupDir = path.join(directory, "backups");
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(mediaDir, { recursive: true });
  const evidencePath = path.join(uploadsDir, "route.jpg");
  const mediaPath = path.join(mediaDir, "draft-hero.png");
  fs.writeFileSync(evidencePath, JPEG_BYTES);
  fs.writeFileSync(mediaPath, PNG_BYTES);

  const database = openDatabase(databasePath);
  database.prepare(`INSERT INTO sources(id,adapter,canonical_url,captured_at,raw_text,raw_html,raw_payload_json,content_hash,created_at,updated_at)
    VALUES ('source-1','manual','manual-source://source-1','now','Evidence','','{}','hash','now','now')`).run();
  database.prepare(`INSERT INTO source_files(id,source_id,file_kind,original_filename,mime_type,storage_path,size_bytes,sha256,created_at)
    VALUES ('file-1','source-1','image','route.jpg','image/jpeg',?,?,?,'now')`)
    .run(evidencePath, fs.statSync(evidencePath).size, sha256(evidencePath));
  database.prepare(`INSERT INTO source_assets(id,source_id,kind,remote_url,position,local_path,mime_type,original_filename)
    VALUES ('asset-1','source-1','image','manual-asset://source-1/0',0,?,'image/jpeg','route.jpg')`).run(evidencePath);
  database.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,created_at,updated_at)
    VALUES ('brief-1','beijing','Test route','solo travelers','informational','now','now')`).run();
  database.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at)
    VALUES ('draft-1','brief-1','Recovered Beijing Route','recovered-beijing-route','## Route\n\nRecovered body.','{}','qa_queued','now','now')`).run();
  database.prepare(`INSERT INTO article_visuals(id,draft_id,slot,placement,purpose,alt_text,generation_prompt,status,media_path,created_at,updated_at)
    VALUES ('visual-1','draft-1',1,'hero','Orient the reader','Beijing route','','generated',?,'now','now')`).run(mediaPath);
  database.close();
  return { directory, databasePath, uploadsDir, mediaDir, backupDir };
}

function sha256(filename) {
  return crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}
