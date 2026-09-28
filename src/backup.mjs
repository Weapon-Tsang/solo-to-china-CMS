import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { CONTENT_STRATEGY } from "./content-strategy.mjs";
import { openDatabase, SCHEMA_VERSION } from "./db.mjs";
import { VERSION } from "./version.mjs";
import { withMediaFileLease } from "./media-file-lease.mjs";
import { markLocalDataRoot } from "./local-runtime.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET_REFERENCES = Object.freeze([
  "ADMIN_PASSWORD", "ADMIN_TOKEN", "CAPTURE_TOKEN", "SESSION_SECRET", "KIMI_API_KEY",
  "VERTEX_AI_ACCESS_TOKEN", "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY", "WORDPRESS_APPLICATION_PASSWORD",
  "CLOUDFLARE_TUNNEL_TOKEN", "EXCEPTION_WEBHOOK_TOKEN",
]);
const REFERENCED_FILE_COLUMNS = Object.freeze([
  { table: "route_artifacts", id: "id", column: "media_path", category: "draft_media", expectedHashColumn: "file_sha256" },
  { table: "source_files", id: "id", column: "storage_path", category: "source_upload", expectedHashColumn: "sha256" },
  { table: "source_assets", id: "id", column: "local_path", category: "evidence_preview", expectedHashColumn: "stored_sha256" },
  { table: "source_asset_storage_refs", id: "asset_id", column: "original_storage_ref", category: "source_original" },
  { table: "source_asset_storage_refs", id: "asset_id", column: "derivative_storage_ref", category: "source_derivative" },
  { table: "article_visuals", id: "id", column: "media_path", category: "draft_media" },
  { table: "visual_candidates", id: "id", column: "media_path", category: "visual_candidate" },
]);
const REFERENCED_JSON_FILE_COLUMNS = Object.freeze([
  { table: "article_media_uploads", id: "id", column: "upload_json" },
  { table: "article_media_uploads", id: "id", column: "receipt_json" },
  { table: "article_media_revisions", id: "id", column: "receipt_json" },
  { table: "article_visuals", id: "id", column: "media_metadata_json" },
  { table: "sources", id: "id", column: "raw_payload_json" },
  { table: "capture_versions", id: "id", column: "raw_payload_json" },
  { table: "capture_versions", id: "id", column: "assets_json" },
]);
const JSON_FILE_PATH_KEYS = new Set(["localPath", "storagePath", "originalStorageRef", "derivativeStorageRef"]);
const LEGACY_V2_OMITTED_REFERENCES = new Set([
  "source_asset_storage_refs.original_storage_ref",
  "source_asset_storage_refs.derivative_storage_ref",
  "visual_candidates.media_path",
]);
const BUSINESS_FINGERPRINT_COLUMNS = Object.freeze([
  ["route_bundles", "route_id", "revision", "owner_id", "approved_route_hash", "content_hash", "status", "bundle_json"],
  ["route_artifacts", "id", "route_id", "route_revision", "approved_route_hash", "artifact_kind", "content_hash", "file_sha256", "receipt_json"],
  ["sources", "id", "capture_version", "status"],
  ["source_files", "id", "source_id", "capture_version", "sha256"],
  ["source_assets", "id", "source_id", "capture_version", "stored_sha256"],
  ["media_occurrences", "id", "asset_id", "source_id", "capture_version", "original_sha256", "context_hash", "context_json", "status", "policy_version"],
  ["media_bindings", "id", "occurrence_id", "asset_id", "destination_slug", "entity_key", "canonical_subject", "relation_type", "status", "evidence_json", "allowed_uses_json", "prohibited_inferences_json", "actor", "policy_version"],
  ["source_asset_storage_refs", "asset_id", "derivative_cache_key"],
  ["capture_versions", "id", "source_id", "capture_version"],
  ["claims", "id", "source_id", "normalized_key"],
  ["knowledge_facts", "id", "destination_id", "normalized_key"],
  ["jobs", "id", "type", "entity_id", "status", "production_owner_opportunity_id"],
  ["content_opportunities", "id", "candidate_id", "status"],
  ["article_drafts", "id", "brief_id", "revision", "status"],
  ["article_visuals", "id", "draft_id", "status"],
  ["visual_candidates", "id", "visual_id", "draft_id", "status"],
  ["wordpress_publications", "draft_id", "post_id", "status"],
  ["vertex_batch_runs", "id", "provider_job_name", "status"],
  ["model_call_metrics", "id", "run_id", "status"],
]);

export function createBackup({
  databasePath,
  backupDir,
  sourceUploadsDir = null,
  generatedMediaDir = null,
  captureUploadsDir = null,
  captureMediaUploadsDir = null,
  retention = 1,
  prune = true,
  offsiteLocation = "",
  offsiteRetentionDays = 0,
  codeRevision = "",
  reason = "scheduled",
  clock = () => new Date(),
}) {
  return withMediaFileLease(databasePath, () => createBackupLocked({ databasePath, backupDir, sourceUploadsDir,
    generatedMediaDir, captureUploadsDir, captureMediaUploadsDir, retention, prune, offsiteLocation,
    offsiteRetentionDays, codeRevision, reason, clock }));
}

function createBackupLocked({ databasePath, backupDir, sourceUploadsDir, generatedMediaDir,
  captureUploadsDir, captureMediaUploadsDir, retention, prune, offsiteLocation, offsiteRetentionDays,
  codeRevision, reason, clock }) {
  const source = path.resolve(databasePath);
  const destinationDir = path.resolve(backupDir);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`Database does not exist: ${source}`);
  fs.mkdirSync(destinationDir, { recursive: true });
  const createdAt = clock().toISOString();
  const stamp = createdAt.replace(/[:.]/g, "-");
  const snapshotName = `solo-to-china-${stamp}.snapshot`;
  const snapshotPath = path.join(destinationDir, snapshotName);
  const stagingPath = path.join(destinationDir, `.${snapshotName}.incomplete-${process.pid}`);
  assertInside(destinationDir, snapshotPath);
  assertInside(destinationDir, stagingPath);
  if (fs.existsSync(snapshotPath) || fs.existsSync(stagingPath)) throw new Error(`Backup already exists: ${snapshotPath}`);
  fs.mkdirSync(stagingPath, { recursive: false });

  try {
    const databaseArchivePath = "database.sqlite";
    const databaseBackupPath = archiveFilename(stagingPath, databaseArchivePath);
    const database = new DatabaseSync(source);
    try {
      database.exec("PRAGMA busy_timeout = 5000");
      assertIntegrity(database, source);
      database.exec(`VACUUM INTO '${databaseBackupPath.replaceAll("'", "''")}'`);
    } finally {
      database.close();
    }

    const snapshotDatabase = new DatabaseSync(databaseBackupPath, { readOnly: true });
    let schemaVersion;
    let databaseReferences;
    let businessFingerprints;
    try {
      assertIntegrity(snapshotDatabase, databaseBackupPath);
      schemaVersion = snapshotDatabase.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get().version;
      databaseReferences = collectDatabaseReferences(snapshotDatabase);
      businessFingerprints = collectBusinessFingerprints(snapshotDatabase);
    } finally {
      snapshotDatabase.close();
    }

    const files = [];
    const copiedByOriginalPath = new Map();
    addManifestFile(files, stagingPath, databaseArchivePath, source, "database", copiedByOriginalPath);
    const roots = [
      { category: "source_upload", directory: sourceUploadsDir, archiveRoot: "files/source-uploads", configKey: "SOURCE_UPLOADS_DIR" },
      { category: "generated_media", directory: generatedMediaDir, archiveRoot: "files/generated-media", configKey: "GENERATED_MEDIA_DIR" },
      { category: "capture_upload", directory: captureUploadsDir, archiveRoot: "files/capture-uploads", configKey: "CAPTURE_UPLOADS_DIR" },
      { category: "capture_media_upload", directory: captureMediaUploadsDir, archiveRoot: "files/capture-media-uploads", configKey: "CAPTURE_MEDIA_UPLOADS_DIR" },
    ];
    for (const item of roots) copyContentRoot(item, stagingPath, files, copiedByOriginalPath);

    const resolvedReferences = databaseReferences.map((reference) => {
      const originalPath = resolveStoredPath(reference.storedPath, reference.category, sourceUploadsDir);
      let file = copiedByOriginalPath.get(pathKey(originalPath));
      if (!file) {
        if (!fs.existsSync(originalPath) || !fs.statSync(originalPath).isFile()) {
          throw new Error(`Database references missing ${reference.category} file: ${reference.table}.${reference.column} ${reference.rowId} -> ${originalPath}`);
        }
        const archivePath = `files/referenced/${crypto.createHash("sha256").update(pathKey(originalPath)).digest("hex").slice(0, 16)}/${path.basename(originalPath)}`;
        copyOneFile(originalPath, stagingPath, archivePath);
        file = addManifestFile(files, stagingPath, archivePath, originalPath, reference.category, copiedByOriginalPath);
      }
      if (reference.expectedSha256 && reference.expectedSha256 !== file.sha256) {
        throw new Error(`Database media hash mismatch: ${reference.table}.${reference.column} ${reference.rowId}`);
      }
      return { ...reference, originalPath, archivePath: file.archivePath, sha256: file.sha256, bytes: file.bytes };
    });

    const completedAt = clock().toISOString();
    const databaseFile = files.find((file) => file.category === "database");
    const manifest = {
      format: "solo-to-china-system-snapshot",
      version: 3,
      createdAt,
      completedAt,
      reason: String(reason || "scheduled"),
      consistency: {
        database: "SQLite VACUUM INTO",
        contentFiles: "immutable files copied after the database consistency point",
        startsAt: createdAt,
        completesAt: completedAt,
      },
      application: {
        version: VERSION,
        contentStrategyVersion: CONTENT_STRATEGY.version,
        schemaVersion,
        codeRevision: String(codeRevision || process.env.ENGINE_IMAGE || process.env.APP_REVISION || "unrecorded"),
      },
      rollback: {
        databaseArchivePath,
        restoreDatabaseAndFilesTogether: true,
        requiredApplicationVersion: VERSION,
        requiredCodeRevision: String(codeRevision || process.env.ENGINE_IMAGE || process.env.APP_REVISION || "unrecorded"),
      },
      runtimeConfigReferences: {
        database: "DATABASE_PATH",
        sourceUploads: "SOURCE_UPLOADS_DIR",
        generatedMedia: "GENERATED_MEDIA_DIR",
        frontendContractRevision: "FRONTEND_CONTRACT_COMMIT_SHA",
      },
      secrets: { included: false, databaseContainsEncryptedCredentials: true,
        store: "controlled secret store", references: SECRET_REFERENCES },
      retention: {
        localSnapshotCount: Math.max(1, Number.parseInt(retention, 10) || 1),
        offsiteLocation: String(offsiteLocation || "not-configured"),
        offsiteRetentionDays: Math.max(0, Number.parseInt(offsiteRetentionDays, 10) || 0),
        offsiteReplication: offsiteLocation ? "operator-managed" : "not-configured",
      },
      roots: roots.map((item) => ({
        category: item.category,
        configKey: item.configKey,
        originalPath: item.directory ? path.resolve(item.directory) : null,
        archiveRoot: item.archiveRoot,
        present: Boolean(item.directory && fs.existsSync(path.resolve(item.directory))),
      })),
      files: files.sort((a, b) => a.archivePath.localeCompare(b.archivePath)),
      databaseReferences: resolvedReferences,
      businessFingerprints,
      totals: { files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) },
      database: { bytes: databaseFile.bytes, sha256: databaseFile.sha256, integrity: "ok" },
    };
    const manifestPath = path.join(stagingPath, "manifest.json");
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    verifyBackup(stagingPath);
    fs.renameSync(stagingPath, snapshotPath);
    const verification = verifyBackup(snapshotPath);
    if (prune) pruneBackups(destinationDir, retention);
    return {
      backupPath: snapshotPath,
      databaseBackupPath: path.join(snapshotPath, databaseArchivePath),
      manifestPath: path.join(snapshotPath, "manifest.json"),
      backup: snapshotName,
      bytes: verification.bytes,
      sha256: verification.sha256,
      schemaVersion,
      integrity: verification.integrity,
      fileCount: verification.fileCount,
    };
  } catch (error) {
    if (fs.existsSync(stagingPath)) fs.rmSync(stagingPath, { recursive: true, force: true });
    throw error;
  }
}

export function verifyBackup(filename) {
  const resolved = path.resolve(filename);
  rejectSymlinkAncestors(resolved);
  if (!fs.existsSync(resolved)) throw new Error(`Backup does not exist: ${resolved}`);
  if (fs.statSync(resolved).isFile() && path.extname(resolved).toLowerCase() !== ".json") return verifyLegacyDatabase(resolved);
  const manifestPath = fs.statSync(resolved).isDirectory() ? path.join(resolved, "manifest.json") : resolved;
  if (!fs.existsSync(manifestPath)) throw new Error(`Snapshot manifest does not exist: ${manifestPath}`);
  const snapshotRoot = path.dirname(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.format !== "solo-to-china-system-snapshot" || ![2, 3].includes(manifest.version) || !Array.isArray(manifest.files)) {
    throw new Error(`Unsupported snapshot manifest: ${manifestPath}`);
  }
  let totalBytes = 0;
  const archivePaths = new Set();
  for (const file of manifest.files) {
    const caseFolded = String(file.archivePath || "").replaceAll("\\", "/").toLowerCase();
    if (archivePaths.has(caseFolded)) throw new Error(`Duplicate or case-colliding snapshot path: ${file.archivePath}`);
    archivePaths.add(caseFolded);
    const actualPath = archiveFilename(snapshotRoot, file.archivePath);
    if (!fs.existsSync(actualPath) || !fs.statSync(actualPath).isFile()) throw new Error(`Snapshot file is missing: ${file.archivePath}`);
    const bytes = fs.statSync(actualPath).size;
    if (bytes !== file.bytes) throw new Error(`Snapshot size mismatch: ${file.archivePath}`);
    const sha256 = hashFile(actualPath);
    if (sha256 !== file.sha256) throw new Error(`Snapshot hash mismatch: ${file.archivePath}`);
    totalBytes += bytes;
  }
  const databaseFile = manifest.files.find((file) => file.archivePath === manifest.rollback?.databaseArchivePath && file.category === "database");
  if (!databaseFile) throw new Error("Snapshot manifest does not identify its database file.");
  const databaseVerification = verifyLegacyDatabase(archiveFilename(snapshotRoot, databaseFile.archivePath));
  if (databaseVerification.schemaVersion !== manifest.application?.schemaVersion) throw new Error("Snapshot schema version does not match its manifest.");
  if (!Array.isArray(manifest.databaseReferences)) throw new Error("Snapshot manifest has no database reference inventory.");
  const filesByArchive = new Map(manifest.files.map((entry) => [entry.archivePath, entry]));
  const filesByOriginal = new Map(manifest.files.filter((entry) => entry.originalPath)
    .map((entry) => [String(entry.originalPath).replaceAll("\\", "/"), entry]));
  const references = new Map();
  for (const reference of manifest.databaseReferences) {
    const key = referenceKey(reference);
    if (references.has(key)) throw new Error(`Duplicate snapshot database reference: ${key}`);
    const file = filesByArchive.get(reference.archivePath);
    if (!file || reference.sha256 !== file.sha256 || reference.bytes !== file.bytes) {
      throw new Error(`Snapshot database reference has no matching file fingerprint: ${key}`);
    }
    references.set(key, reference);
  }
  const snapshotDatabase = new DatabaseSync(archiveFilename(snapshotRoot, databaseFile.archivePath), { readOnly: true });
  try {
    const actualReferences = collectDatabaseReferences(snapshotDatabase, { includeJson: manifest.version >= 3 });
    if (manifest.version === 2) {
      for (const actual of actualReferences) {
        const key = referenceKey(actual);
        if (references.has(key)) continue;
        if (!LEGACY_V2_OMITTED_REFERENCES.has(`${actual.table}.${actual.column}`)) {
          throw new Error(`Snapshot database reference inventory is incomplete: ${key}`);
        }
        const file = legacyV2ReferencedFile(actual, filesByArchive, filesByOriginal);
        if (!file) throw new Error(`Snapshot database reference file is missing: ${key}`);
        references.set(key, { ...actual, originalPath: file.originalPath,
          archivePath: file.archivePath, sha256: file.sha256, bytes: file.bytes });
      }
    }
    if (actualReferences.length !== references.size) throw new Error("Snapshot database reference inventory is incomplete.");
    for (const actual of actualReferences) {
      const reference = references.get(referenceKey(actual));
      if (!reference || reference.storedPath !== actual.storedPath
        || (actual.expectedSha256 && reference.sha256 !== actual.expectedSha256)) {
        throw new Error(`Snapshot database reference disagrees with its manifest: ${referenceKey(actual)}`);
      }
    }
    if (manifest.version >= 3 && !Array.isArray(manifest.businessFingerprints)) {
      throw new Error("Snapshot manifest has no business fingerprint inventory.");
    }
    verifyBusinessFingerprints(snapshotDatabase, manifest.businessFingerprints);
  } finally { snapshotDatabase.close(); }
  return {
    filename: snapshotRoot,
    manifestPath,
    integrity: databaseVerification.integrity,
    schemaVersion: databaseVerification.schemaVersion,
    bytes: databaseVerification.bytes,
    sha256: databaseVerification.sha256,
    totalBytes,
    fileCount: manifest.files.length,
    referenceCount: references.size,
    effectiveDatabaseReferences: [...references.values()],
    manifest,
  };
}

export function drillBackup(filename) {
  const resolved = path.resolve(filename);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile() && path.extname(resolved).toLowerCase() !== ".json") {
    return drillLegacyDatabase(resolved);
  }
  const sourceVerification = verifyBackup(resolved);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-to-china-restore-drill-"));
  const restoredRoot = path.join(directory, "snapshot");
  try {
    fs.cpSync(sourceVerification.filename, restoredRoot, { recursive: true, errorOnExist: true });
    const restoredVerification = verifyBackup(restoredRoot);
    const manifest = restoredVerification.manifest;
    const databasePath = archiveFilename(restoredRoot, manifest.rollback.databaseArchivePath);
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000");
      const references = verifyRestoredReferences(database, manifest, restoredRoot,
        restoredVerification.effectiveDatabaseReferences);
      const deliveryProbe = probeRecoveredDraft(database, references);
      const counts = tableCounts(database);
      return {
        drill: "passed",
        isolated: true,
        externalSideEffects: false,
        source: compactVerification(sourceVerification),
        restored: { ...compactVerification(restoredVerification), filename: "temporary-restored.snapshot" },
        counts,
        references,
        evidencePreviewsOpened: references.filter((item) => ["source_files", "source_assets"].includes(item.table)).length,
        draftMediaOpened: references.filter((item) => item.table === "article_visuals").length,
        deliveryProbe,
      };
    } finally {
      database.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function restoreBackup(filename, targetRoot, { resume = false } = {}) {
  const snapshot = verifyBackup(filename);
  if (!snapshot.manifest) throw new Error("A database-only legacy backup cannot be restored as a complete system snapshot.");
  if (snapshot.schemaVersion > SCHEMA_VERSION) throw new Error(`Snapshot schema ${snapshot.schemaVersion} is newer than supported schema ${SCHEMA_VERSION}.`);
  const target = path.resolve(targetRoot);
  rejectSymlinkAncestors(target);
  if (target === projectRoot || target.startsWith(`${projectRoot}${path.sep}`)) throw new Error("Restore target must be outside the source checkout.");
  if (fs.existsSync(target)) throw new Error(`Restore target already exists: ${target}`);
  assertRestoreFreeSpace(target, snapshot);
  const staging = `${target}.incomplete`;
  rejectSymlinkAncestors(staging);
  const restoreMarker = path.join(staging, ".cms-restore-state.json");
  const markerIdentity = { format: "cms-restore-state-1", target,
    snapshotSha256: hashFile(snapshot.manifestPath) };
  if (fs.existsSync(staging)) {
    if (!resume) throw new Error(`Restore staging directory already exists; use --restore-resume after inspection: ${staging}`);
    let existing;
    try { existing = JSON.parse(fs.readFileSync(restoreMarker, "utf8")); }
    catch { throw new Error(`Restore staging marker is unreadable: ${restoreMarker}`); }
    if (existing.format !== markerIdentity.format || existing.target !== target
      || existing.snapshotSha256 !== markerIdentity.snapshotSha256) {
      throw new Error("Restore staging does not belong to this snapshot and target.");
    }
  } else {
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(restoreMarker, `${JSON.stringify(markerIdentity)}\n`, { flag: "wx", mode: 0o600 });
  }
  try {
    const finalDatabase = path.join(target, "solo-to-china.sqlite");
    const stagedDatabase = path.join(staging, "solo-to-china.sqlite");
    const paths = new Map();
    const restoredSourceUploads = path.join(target, "source-uploads");
    const restoredFilesByOriginalPath = new Map();
    for (const entry of snapshot.manifest.files) {
      const source = archiveFilename(snapshot.filename, entry.archivePath);
      const suffix = entry.category === "database" ? "solo-to-china.sqlite"
        : entry.archivePath.startsWith("files/") ? entry.archivePath.slice("files/".length) : null;
      if (!suffix) throw new Error(`Unsupported snapshot file layout: ${entry.archivePath}`);
      const staged = archiveFilename(staging, suffix);
      fs.mkdirSync(path.dirname(staged), { recursive: true });
      if (fs.existsSync(staged)) {
        if (!fs.statSync(staged).isFile()) throw new Error(`Restore staged path is not a file: ${staged}`);
        if (fs.statSync(staged).size !== entry.bytes || hashFile(staged) !== entry.sha256) fs.rmSync(staged);
      }
      if (!fs.existsSync(staged)) fs.copyFileSync(source, staged, fs.constants.COPYFILE_EXCL);
      if (hashFile(staged) !== entry.sha256) throw new Error(`Restored file hash mismatch: ${entry.archivePath}`);
      paths.set(entry.archivePath, { staged, final: archiveFilename(target, suffix) });
      if (entry.category !== "database" && entry.originalPath) {
        restoredFilesByOriginalPath.set(pathKey(entry.originalPath), { final: archiveFilename(target, suffix), category: entry.category });
      }
    }
    const db = new DatabaseSync(stagedDatabase);
    let remappedDeletionQueue = 0;
    let discardedDeletionQueue = 0;
    try {
      db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
      for (const reference of snapshot.effectiveDatabaseReferences) {
        const file = paths.get(reference.archivePath);
        if (!file) throw new Error(`Snapshot reference is missing: ${reference.archivePath}`);
        if (reference.jsonPath) {
          const specification = REFERENCED_JSON_FILE_COLUMNS.find((item) => item.table === reference.table && item.column === reference.column);
          if (!specification || !Array.isArray(reference.jsonPath) || !reference.jsonPath.length
            || !JSON_FILE_PATH_KEYS.has(reference.jsonPath.at(-1))) {
            throw new Error(`Unsupported snapshot JSON reference: ${reference.table}.${reference.column}`);
          }
          const stored = db.prepare(`SELECT ${specification.column} AS value FROM ${specification.table} WHERE ${specification.id}=?`).get(reference.rowId);
          if (!stored) throw new Error(`Snapshot JSON reference row is missing: ${reference.table} ${reference.rowId}`);
          const parsed = JSON.parse(stored.value);
          const owner = jsonPathOwner(parsed, reference.jsonPath);
          const leaf = reference.jsonPath.at(-1);
          if (owner?.[leaf] !== reference.storedPath) throw new Error(`Snapshot JSON reference changed: ${reference.table}.${reference.column} ${reference.rowId}`);
          owner[leaf] = file.final;
          db.prepare(`UPDATE ${specification.table} SET ${specification.column}=? WHERE ${specification.id}=?`)
            .run(JSON.stringify(parsed), reference.rowId);
          continue;
        }
        const specification = REFERENCED_FILE_COLUMNS.find((item) => item.table === reference.table && item.column === reference.column);
        if (!specification) throw new Error(`Unsupported snapshot reference: ${reference.table}.${reference.column}`);
        const finalReference = ["source_original", "source_derivative"].includes(reference.category)
          && !path.isAbsolute(reference.storedPath) ? reference.storedPath : file.final;
        const updated = db.prepare(`UPDATE ${specification.table} SET ${specification.column}=? WHERE ${specification.id}=? AND ${specification.column}=?`)
          .run(finalReference, reference.rowId, reference.storedPath);
        if (updated.changes !== 1) throw new Error(`Snapshot reference changed: ${reference.table}.${reference.column} ${reference.rowId}`);
      }
      if (tableExists(db, "source_delete_file_queue")) {
        for (const row of db.prepare("SELECT path,queued_at FROM source_delete_file_queue").all()) {
          const restored = restoredFilesByOriginalPath.get(pathKey(row.path));
          db.prepare("DELETE FROM source_delete_file_queue WHERE path=?").run(row.path);
          if (restored?.category === "source_upload" && restored.final.startsWith(`${restoredSourceUploads}${path.sep}`)) {
            db.prepare("INSERT OR IGNORE INTO source_delete_file_queue(path,queued_at) VALUES (?,?)")
              .run(restored.final, row.queued_at);
            remappedDeletionQueue++;
          } else discardedDeletionQueue++;
        }
      }
      db.exec("COMMIT");
      assertIntegrity(db, stagedDatabase);
      if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Restored database has foreign-key violations.");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* transaction may already have committed */ }
      throw error;
    } finally { db.close(); }
    if (snapshot.schemaVersion < SCHEMA_VERSION) {
      const migrated = openDatabase(stagedDatabase);
      try {
        assertIntegrity(migrated, stagedDatabase);
        if (migrated.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Migrated database has foreign-key violations.");
      } finally { migrated.close(); }
    }
    const restoredDatabase = new DatabaseSync(stagedDatabase, { readOnly: true });
    try {
      if (snapshot.manifest.businessFingerprints) {
        verifyBusinessFingerprints(restoredDatabase, snapshot.manifest.businessFingerprints, { allowExtraTables: true });
      }
      verifyStagedMediaMimes(restoredDatabase, snapshot.effectiveDatabaseReferences, paths);
    } finally { restoredDatabase.close(); }
    markLocalDataRoot({ root: projectRoot, databasePath: stagedDatabase,
      deployment: { dataRoot: staging } }, "migration-review", { adoptExisting: true });
    fs.renameSync(staging, target);
    return { restoredRoot: target, databasePath: finalDatabase, mode: "migration-review", fileCount: snapshot.fileCount,
      referenceCount: snapshot.referenceCount, schemaVersionFrom: snapshot.schemaVersion, schemaVersionTo: SCHEMA_VERSION,
      deletionQueue: { remapped: remappedDeletionQueue, discarded: discardedDeletionQueue }, externalSideEffects: false };
  } catch (error) {
    error.restoreStagingPath = staging;
    throw error;
  }
}

function assertRestoreFreeSpace(target, snapshot) {
  let existing = path.dirname(target);
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error(`No existing parent for restore target: ${target}`);
    existing = parent;
  }
  if (!fs.statSync(existing).isDirectory()) throw new Error(`Restore parent is not a directory: ${existing}`);
  let disk;
  try { disk = fs.statfsSync(existing, { bigint: true }); }
  catch (error) {
    if (["ENOSYS", "ENOTSUP"].includes(error.code)) return;
    throw error;
  }
  const free = disk.bavail * disk.bsize;
  const archivedBytes = BigInt(snapshot.totalBytes);
  const databaseBytes = BigInt(snapshot.bytes);
  const required = archivedBytes + databaseBytes + (archivedBytes / 20n > 64n * 1024n * 1024n
    ? archivedBytes / 20n : 64n * 1024n * 1024n);
  if (free < required) {
    throw Object.assign(new Error(`Restore needs at least ${required} free bytes but only ${free} are available.`),
      { code: "RESTORE_INSUFFICIENT_SPACE", requiredBytes: String(required), availableBytes: String(free) });
  }
}

function collectDatabaseReferences(database, { includeJson = true } = {}) {
  const output = [];
  for (const specification of REFERENCED_FILE_COLUMNS) {
    if (!tableExists(database, specification.table)) continue;
    const hasHashColumn = specification.expectedHashColumn && database.prepare(`PRAGMA table_info(${specification.table})`).all()
      .some((column) => column.name === specification.expectedHashColumn);
    const expectedHash = hasHashColumn ? `, ${specification.expectedHashColumn} AS expected_hash` : "";
    const rows = database.prepare(`SELECT ${specification.id} AS row_id, ${specification.column} AS stored_path${expectedHash} FROM ${specification.table} WHERE COALESCE(${specification.column}, '') <> '' ORDER BY ${specification.id}`).all();
    for (const row of rows) output.push({
      table: specification.table,
      rowId: String(row.row_id),
      column: specification.column,
      category: specification.category,
      storedPath: String(row.stored_path),
      expectedSha256: /^[a-f0-9]{64}$/i.test(String(row.expected_hash || "")) ? String(row.expected_hash).toLowerCase() : null,
    });
  }
  for (const specification of includeJson ? REFERENCED_JSON_FILE_COLUMNS : []) {
    if (!tableExists(database, specification.table)) continue;
    const available = new Set(database.prepare(`PRAGMA table_info(${specification.table})`).all().map((item) => item.name));
    if (!available.has(specification.column)) continue;
    const rows = database.prepare(`SELECT ${specification.id} AS row_id, ${specification.column} AS value FROM ${specification.table} ORDER BY ${specification.id}`).iterate();
    for (const row of rows) {
      let parsed;
      try { parsed = JSON.parse(row.value); }
      catch { throw new Error(`Database JSON is invalid: ${specification.table}.${specification.column} ${row.row_id}`); }
      visitJsonFilePaths(parsed, [], (jsonPath, storedPath) => output.push({
        table: specification.table, rowId: String(row.row_id), column: specification.column,
        jsonPath, category: "capture_history", storedPath, expectedSha256: null,
      }));
    }
  }
  return output;
}

function visitJsonFilePaths(value, pathParts, emit) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...pathParts, key];
    if (JSON_FILE_PATH_KEYS.has(key) && typeof child === "string" && child.trim()) emit(childPath, child);
    else if (child && typeof child === "object") visitJsonFilePaths(child, childPath, emit);
  }
}

function jsonPathOwner(value, pathParts) {
  let owner = value;
  for (const part of pathParts.slice(0, -1)) {
    if (!owner || typeof owner !== "object" || !Object.hasOwn(owner, part)) return null;
    owner = owner[part];
  }
  return owner && typeof owner === "object" ? owner : null;
}

function collectBusinessFingerprints(database, definition = null) {
  const allowed = new Map(BUSINESS_FINGERPRINT_COLUMNS.map(([table, ...columns]) => [table, columns]));
  const tableDefinitions = definition ? definition.map((item) => {
    const permitted = allowed.get(item?.table);
    if (!permitted || !Array.isArray(item.columns) || !item.columns.length
      || item.columns[0] !== permitted[0]
      || JSON.stringify(item.columns) !== JSON.stringify(permitted.filter((column) => item.columns.includes(column)))) {
      throw new Error("Snapshot business fingerprint definition is invalid.");
    }
    return [item.table, ...item.columns];
  }) : BUSINESS_FINGERPRINT_COLUMNS;
  return tableDefinitions.filter(([table]) => tableExists(database, table)).map(([table, ...wanted]) => {
    const available = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name));
    if (definition && wanted.some((column) => !available.has(column))) throw new Error(`Restored fingerprint column is missing: ${table}.`);
    const columns = wanted.filter((column) => available.has(column));
    if (!columns.length) throw new Error(`No fingerprint columns remain for ${table}.`);
    const digest = crypto.createHash("sha256");
    let count = 0;
    for (const row of database.prepare(`SELECT ${columns.join(",")} FROM ${table} ORDER BY ${columns[0]}`).iterate()) {
      digest.update(JSON.stringify(columns.map((column) => row[column])));
      digest.update("\n");
      count++;
    }
    return { table, columns, count, sha256: digest.digest("hex") };
  });
}

function verifyBusinessFingerprints(database, expected, { allowExtraTables = false } = {}) {
  if (expected == null) return;
  if (!Array.isArray(expected)) throw new Error("Snapshot business fingerprint inventory is invalid.");
  const actual = new Map(collectBusinessFingerprints(database, expected).map((item) => [item.table, item]));
  if (expected.length !== actual.size) throw new Error("Snapshot business fingerprint table inventory differs.");
  if (!allowExtraTables && expected.length !== collectBusinessFingerprints(database).length) {
    throw new Error("Snapshot business fingerprint table inventory is incomplete.");
  }
  for (const item of expected) {
    const observed = actual.get(item.table);
    if (!observed || JSON.stringify(observed.columns) !== JSON.stringify(item.columns)
      || observed.count !== item.count || observed.sha256 !== item.sha256) {
      throw new Error(`Snapshot business fingerprint mismatch: ${item.table}`);
    }
  }
}

function copyContentRoot(item, snapshotRoot, files, copiedByOriginalPath) {
  if (!item.directory) return;
  const directory = path.resolve(item.directory);
  if (!fs.existsSync(directory)) return;
  if (!fs.statSync(directory).isDirectory()) throw new Error(`${item.configKey} is not a directory: ${directory}`);
  const visit = (current) => {
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const filename = path.join(current, entry.name);
      if (entry.isFile() && entry.name.endsWith(".tmp")) continue;
      if (item.category === "source_upload" && entry.isDirectory() && entry.name === ".media-recovery") continue;
      if (item.category === "source_upload" && entry.isFile() && entry.name.endsWith(".part")
        && !path.relative(directory, current).split(path.sep).includes(".staging")) continue;
      if (entry.isSymbolicLink()) throw new Error(`Snapshot content root contains an unsupported symbolic link: ${filename}`);
      if (entry.isDirectory()) visit(filename);
      else if (entry.isFile()) {
        const relative = path.relative(directory, filename);
        const archivePath = path.posix.join(item.archiveRoot, ...relative.split(path.sep));
        copyOneFile(filename, snapshotRoot, archivePath);
        addManifestFile(files, snapshotRoot, archivePath, filename, item.category, copiedByOriginalPath);
      }
    }
  };
  visit(directory);
}

function copyOneFile(source, snapshotRoot, archivePath) {
  const destination = archiveFilename(snapshotRoot, archivePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
}

function addManifestFile(files, snapshotRoot, archivePath, originalPath, category, copiedByOriginalPath) {
  const normalizedArchivePath = archivePath.replaceAll("\\", "/");
  const filename = archiveFilename(snapshotRoot, normalizedArchivePath);
  const entry = {
    category,
    archivePath: normalizedArchivePath,
    originalPath: path.resolve(originalPath),
    bytes: fs.statSync(filename).size,
    sha256: hashFile(filename),
  };
  files.push(entry);
  copiedByOriginalPath.set(pathKey(originalPath), entry);
  return entry;
}

function verifyRestoredReferences(database, manifest, restoredRoot, effectiveReferences = manifest.databaseReferences || []) {
  const expected = new Map(effectiveReferences.map((item) => [referenceKey(item), item]));
  const declaredMimes = collectDeclaredMimes(database);
  return collectDatabaseReferences(database, { includeJson: manifest.version >= 3 }).map((actual) => {
    const item = expected.get(referenceKey(actual));
    if (!item || item.storedPath !== actual.storedPath) {
      throw new Error(`Restored database reference is absent from the snapshot manifest: ${actual.table}.${actual.column} ${actual.rowId}`);
    }
    const filename = archiveFilename(restoredRoot, item.archivePath);
    if (!fs.existsSync(filename)) throw new Error(`Restored database reference is missing: ${item.archivePath}`);
    const header = readRestoredMediaHeader(filename, item.archivePath);
    const mime = declaredMimes.get(`${actual.table}:${actual.rowId}`)
      || inferredMediaMime(actual.table, item.archivePath);
    const mimeVerified = verifyMediaHeader(header, mime, item.archivePath);
    return { table: item.table, rowId: item.rowId, column: item.column,
      archivePath: item.archivePath, opened: true, mimeVerified };
  });
}

function verifyStagedMediaMimes(database, references, paths) {
  const declaredMimes = collectDeclaredMimes(database);
  for (const item of references) {
    const mime = declaredMimes.get(`${item.table}:${item.rowId}`)
      || inferredMediaMime(item.table, item.archivePath);
    if (!mime) continue;
    const filename = paths.get(item.archivePath)?.staged;
    if (!filename) throw new Error(`Restored media reference is missing: ${item.archivePath}`);
    verifyMediaHeader(readRestoredMediaHeader(filename, item.archivePath), mime, item.archivePath);
  }
}

function collectDeclaredMimes(database) {
  const result = new Map();
  for (const table of ["source_files", "source_assets", "visual_candidates"]) {
    if (!tableExists(database, table)) continue;
    for (const row of database.prepare(`SELECT id,mime_type FROM ${table}`).all()) {
      result.set(`${table}:${row.id}`, String(row.mime_type || "").toLowerCase().split(";", 1)[0].trim());
    }
  }
  return result;
}

function readRestoredMediaHeader(filename, archivePath) {
  const descriptor = fs.openSync(filename, "r");
  try {
    const header = Buffer.alloc(16);
    const bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
    if (!bytesRead) throw new Error(`Restored database reference is empty: ${archivePath}`);
    return header.subarray(0, bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
}

function inferredMediaMime(table, archivePath) {
  if (!["article_visuals", "visual_candidates"].includes(table)) return "";
  const extension = path.posix.extname(archivePath).toLowerCase();
  return ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp" })[extension] || "";
}

function verifyMediaHeader(header, mime, archivePath) {
  if (!mime) return false;
  const text = header.toString("ascii");
  const valid = ({
    "image/jpeg": () => header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff,
    "image/jpg": () => header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff,
    "image/png": () => header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "image/gif": () => text.startsWith("GIF87a") || text.startsWith("GIF89a"),
    "image/webp": () => text.startsWith("RIFF") && text.slice(8, 12) === "WEBP",
    "application/pdf": () => text.startsWith("%PDF-"),
  })[mime];
  if (!valid) return false;
  if (!valid()) throw new Error(`Restored media MIME mismatch (${mime}): ${archivePath}`);
  return true;
}

function probeRecoveredDraft(database, references) {
  if (!tableExists(database, "article_drafts")) return { status: "not_applicable", reason: "article_drafts table is absent" };
  const draft = database.prepare("SELECT id,title,body_markdown,status FROM article_drafts ORDER BY created_at LIMIT 1").get();
  if (!draft) return { status: "not_applicable", reason: "snapshot contains no article draft", externalModelCalls: 0, externalWordPressCalls: 0 };
  database.exec("SAVEPOINT backup_delivery_probe");
  try {
    database.prepare("UPDATE article_drafts SET status='ready_for_wordpress' WHERE id=?").run(draft.id);
    const ready = database.prepare("SELECT id,title,body_markdown,status FROM article_drafts WHERE id=?").get(draft.id);
    if (!ready.title?.trim() || !ready.body_markdown?.trim() || ready.status !== "ready_for_wordpress") {
      throw new Error(`Recovered draft ${draft.id} could not reach the mock delivery boundary.`);
    }
    const media = references.filter((item) => item.table === "article_visuals");
    const mockPackage = { draftId: ready.id, title: ready.title, bodyMarkdown: ready.body_markdown, media };
    if (!mockPackage.draftId) throw new Error("Offline mock rejected the recovered draft.");
    return {
      status: "passed",
      draftId: ready.id,
      state: ready.status,
      mockDeliveryCalls: 1,
      externalModelCalls: 0,
      externalWordPressCalls: 0,
      restoredMediaCount: media.length,
    };
  } finally {
    database.exec("ROLLBACK TO backup_delivery_probe; RELEASE backup_delivery_probe");
  }
}

function verifyLegacyDatabase(filename) {
  const resolved = path.resolve(filename);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`Backup does not exist: ${resolved}`);
  const database = new DatabaseSync(resolved, { readOnly: true });
  try {
    const integrity = assertIntegrity(database, resolved);
    const schemaVersion = database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get().version;
    return { filename: resolved, integrity, schemaVersion, bytes: fs.statSync(resolved).size, sha256: hashFile(resolved) };
  } finally {
    database.close();
  }
}

function drillLegacyDatabase(source) {
  const sourceVerification = verifyLegacyDatabase(source);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-to-china-restore-drill-"));
  const restoredPath = path.join(directory, "restored.sqlite");
  try {
    fs.copyFileSync(source, restoredPath, fs.constants.COPYFILE_EXCL);
    const database = new DatabaseSync(restoredPath);
    let counts;
    try {
      counts = tableCounts(database);
    } finally {
      database.close();
    }
    const restoredVerification = verifyLegacyDatabase(restoredPath);
    return { drill: "passed", legacyDatabaseOnly: true, source: sourceVerification,
      restored: { ...restoredVerification, filename: "temporary-restored.sqlite" }, counts };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function tableCounts(database) {
  return Object.fromEntries(["sources", "source_files", "claims", "claim_history", "extraction_runs", "knowledge_facts", "article_drafts", "search_console_inventory", "jobs"]
    .filter((table) => tableExists(database, table))
    .map((table) => [table, database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
}

function tableExists(database, table) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function compactVerification(verification) {
  return {
    filename: verification.filename,
    integrity: verification.integrity,
    schemaVersion: verification.schemaVersion,
    bytes: verification.bytes,
    sha256: verification.sha256,
    totalBytes: verification.totalBytes,
    fileCount: verification.fileCount,
    referenceCount: verification.referenceCount,
  };
}

function referenceKey(reference) {
  return `${reference.table}:${reference.rowId}:${reference.column}:${JSON.stringify(reference.jsonPath || [])}`;
}

function resolveStoredPath(value, category, sourceUploadsDir) {
  if (path.isAbsolute(String(value))) return path.resolve(String(value));
  if (["source_original", "source_derivative"].includes(category)) {
    if (!sourceUploadsDir || !/^(?:media|\.derived)\/[a-f0-9]{2}\/[a-f0-9]{64}\.[a-z0-9]+$/i.test(String(value))) {
      throw new Error(`Unsafe source media reference: ${value}`);
    }
    return path.resolve(sourceUploadsDir, String(value));
  }
  return path.resolve(projectRoot, String(value));
}

function legacyV2ReferencedFile(reference, filesByArchive, filesByOriginal) {
  if (["source_original", "source_derivative"].includes(reference.category) && !path.isAbsolute(reference.storedPath)) {
    if (!/^(?:media|\.derived)\/[a-f0-9]{2}\/[a-f0-9]{64}\.[a-z0-9]+$/i.test(reference.storedPath)) return null;
    const file = filesByArchive.get(`files/source-uploads/${reference.storedPath}`);
    const embeddedHash = path.posix.basename(reference.storedPath).split('.')[0].toLowerCase();
    return file?.category === 'source_upload' && file.sha256 === embeddedHash ? file : null;
  }
  if (!path.isAbsolute(reference.storedPath) && !path.posix.isAbsolute(reference.storedPath)) return null;
  const file = filesByOriginal.get(reference.storedPath.replaceAll("\\", "/"));
  return file?.category === 'generated_media' ? file : null;
}

function archiveFilename(snapshotRoot, archivePath) {
  const normalized = String(archivePath || "").replaceAll("\\", "/");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe snapshot archive path: ${archivePath}`);
  }
  const filename = path.resolve(snapshotRoot, ...normalized.split("/"));
  assertInside(snapshotRoot, filename);
  let current = path.resolve(snapshotRoot);
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`Snapshot root is a symbolic link: ${current}`);
  for (const segment of normalized.split("/")) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`Snapshot path contains a symbolic link: ${archivePath}`);
  }
  return filename;
}

function rejectSymlinkAncestors(filename) {
  let current = path.resolve(filename);
  while (true) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symbolic-link path is not allowed: ${current}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function assertIntegrity(database, filename) {
  const rows = database.prepare("PRAGMA integrity_check").all();
  const messages = rows.map((row) => Object.values(row)[0]);
  if (messages.length !== 1 || messages[0] !== "ok") throw new Error(`SQLite integrity check failed for ${filename}: ${messages.join("; ")}`);
  return "ok";
}

function hashFile(filename) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filename, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function pruneBackups(directory, retention) {
  const keep = Math.max(1, Number.parseInt(retention, 10) || 1);
  const backups = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => (entry.isDirectory() && /^solo-to-china-.+\.snapshot$/.test(entry.name))
      || (entry.isFile() && /^solo-to-china-.+\.sqlite$/.test(entry.name)))
    .map((entry) => entry.name).sort().reverse();
  for (const name of backups.slice(keep)) {
    const backupPath = path.resolve(directory, name);
    assertInside(directory, backupPath);
    if (fs.statSync(backupPath).isDirectory()) fs.rmSync(backupPath, { recursive: true });
    else {
      fs.rmSync(backupPath);
      if (fs.existsSync(`${backupPath}.json`)) fs.rmSync(`${backupPath}.json`);
    }
  }
}

function pathKey(filename) {
  const resolved = path.resolve(filename);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function assertInside(directory, filename) {
  const rootWithSeparator = `${path.resolve(directory)}${path.sep}`;
  if (!path.resolve(filename).startsWith(rootWithSeparator)) throw new Error(`Refusing to access outside backup directory: ${filename}`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--drill") {
    if (!args[1]) throw new Error("Usage: npm run backup:drill -- <snapshot-directory|manifest.json|legacy.sqlite>");
    console.log(JSON.stringify(drillBackup(args[1]), null, 2));
  } else if (args[0] === "--verify") {
    if (!args[1]) throw new Error("Usage: npm run backup:verify -- <snapshot-directory|manifest.json|legacy.sqlite>");
    console.log(JSON.stringify(verifyBackup(args[1]), null, 2));
  } else if (args[0] === "--restore") {
    if (!args[1] || !args[2]) throw new Error("Usage: node src/backup.mjs --restore <snapshot-directory> <new-external-data-root>");
    console.log(JSON.stringify(restoreBackup(args[1], args[2]), null, 2));
  } else if (args[0] === "--restore-resume") {
    if (!args[1] || !args[2]) throw new Error("Usage: node src/backup.mjs --restore-resume <snapshot-directory> <new-external-data-root>");
    console.log(JSON.stringify(restoreBackup(args[1], args[2], { resume: true }), null, 2));
  } else {
    const dataRoot = process.env.CMS_DATA_ROOT ? path.resolve(process.env.CMS_DATA_ROOT) : path.join(projectRoot, "data");
    const databasePath = path.resolve(args[0] || process.env.DATABASE_PATH || path.join(dataRoot, "solo-to-china.sqlite"));
    const backupDir = path.resolve(args[1] || process.env.BACKUP_DIR || (process.env.CMS_DATA_ROOT ? path.join(dataRoot, "backups") : path.join(projectRoot, "backups")));
    const retention = Number.parseInt(process.env.BACKUP_RETENTION || "1", 10);
    console.log(JSON.stringify(createBackup({
      databasePath,
      backupDir,
      sourceUploadsDir: path.resolve(process.env.SOURCE_UPLOADS_DIR || path.join(dataRoot, "source-uploads")),
      generatedMediaDir: path.resolve(process.env.GENERATED_MEDIA_DIR || path.join(dataRoot, "generated-media")),
      captureUploadsDir: path.resolve(process.env.CAPTURE_UPLOADS_DIR || path.join(dataRoot, "capture-uploads")),
      captureMediaUploadsDir: path.resolve(process.env.CAPTURE_MEDIA_UPLOADS_DIR || path.join(dataRoot, "capture-media-uploads")),
      retention,
      offsiteLocation: process.env.BACKUP_OFFSITE_LOCATION || "",
      offsiteRetentionDays: Number.parseInt(process.env.BACKUP_OFFSITE_RETENTION_DAYS || "0", 10),
      codeRevision: process.env.ENGINE_IMAGE || process.env.APP_REVISION || "",
      reason: process.env.BACKUP_REASON || "manual",
    }), null, 2));
  }
}
