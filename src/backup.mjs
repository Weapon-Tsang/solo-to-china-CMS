import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { CONTENT_STRATEGY } from "./content-strategy.mjs";
import { VERSION } from "./version.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET_REFERENCES = Object.freeze([
  "ADMIN_PASSWORD", "ADMIN_TOKEN", "CAPTURE_TOKEN", "SESSION_SECRET", "KIMI_API_KEY",
  "VERTEX_AI_ACCESS_TOKEN", "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY", "WORDPRESS_APPLICATION_PASSWORD",
  "CLOUDFLARE_TUNNEL_TOKEN", "EXCEPTION_WEBHOOK_TOKEN",
]);
const REFERENCED_FILE_COLUMNS = Object.freeze([
  { table: "source_files", id: "id", column: "storage_path", category: "source_upload" },
  { table: "source_assets", id: "id", column: "local_path", category: "evidence_preview" },
  { table: "article_visuals", id: "id", column: "media_path", category: "draft_media" },
]);

export function createBackup({
  databasePath,
  backupDir,
  sourceUploadsDir = null,
  generatedMediaDir = null,
  retention = 14,
  offsiteLocation = "",
  offsiteRetentionDays = 0,
  codeRevision = "",
  reason = "scheduled",
  clock = () => new Date(),
}) {
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
    try {
      assertIntegrity(snapshotDatabase, databaseBackupPath);
      schemaVersion = snapshotDatabase.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get().version;
      databaseReferences = collectDatabaseReferences(snapshotDatabase);
    } finally {
      snapshotDatabase.close();
    }

    const files = [];
    const copiedByOriginalPath = new Map();
    addManifestFile(files, stagingPath, databaseArchivePath, source, "database", copiedByOriginalPath);
    const roots = [
      { category: "source_upload", directory: sourceUploadsDir, archiveRoot: "files/source-uploads", configKey: "SOURCE_UPLOADS_DIR" },
      { category: "generated_media", directory: generatedMediaDir, archiveRoot: "files/generated-media", configKey: "GENERATED_MEDIA_DIR" },
    ];
    for (const item of roots) copyContentRoot(item, stagingPath, files, copiedByOriginalPath);

    const resolvedReferences = databaseReferences.map((reference) => {
      const originalPath = resolveStoredPath(reference.storedPath);
      let file = copiedByOriginalPath.get(pathKey(originalPath));
      if (!file) {
        if (!fs.existsSync(originalPath) || !fs.statSync(originalPath).isFile()) {
          throw new Error(`Database references missing ${reference.category} file: ${reference.table}.${reference.column} ${reference.rowId} -> ${originalPath}`);
        }
        const archivePath = `files/referenced/${crypto.createHash("sha256").update(pathKey(originalPath)).digest("hex").slice(0, 16)}/${path.basename(originalPath)}`;
        copyOneFile(originalPath, stagingPath, archivePath);
        file = addManifestFile(files, stagingPath, archivePath, originalPath, reference.category, copiedByOriginalPath);
      }
      return { ...reference, originalPath, archivePath: file.archivePath, sha256: file.sha256, bytes: file.bytes };
    });

    const completedAt = clock().toISOString();
    const databaseFile = files.find((file) => file.category === "database");
    const manifest = {
      format: "solo-to-china-system-snapshot",
      version: 2,
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
      secrets: { included: false, store: "controlled secret store", references: SECRET_REFERENCES },
      retention: {
        localSnapshotCount: Math.max(1, Number.parseInt(retention, 10) || 14),
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
      totals: { files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) },
      database: { bytes: databaseFile.bytes, sha256: databaseFile.sha256, integrity: "ok" },
    };
    const manifestPath = path.join(stagingPath, "manifest.json");
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    verifyBackup(stagingPath);
    fs.renameSync(stagingPath, snapshotPath);
    const verification = verifyBackup(snapshotPath);
    pruneBackups(destinationDir, retention);
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
  if (!fs.existsSync(resolved)) throw new Error(`Backup does not exist: ${resolved}`);
  if (fs.statSync(resolved).isFile() && path.extname(resolved).toLowerCase() !== ".json") return verifyLegacyDatabase(resolved);
  const manifestPath = fs.statSync(resolved).isDirectory() ? path.join(resolved, "manifest.json") : resolved;
  if (!fs.existsSync(manifestPath)) throw new Error(`Snapshot manifest does not exist: ${manifestPath}`);
  const snapshotRoot = path.dirname(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.format !== "solo-to-china-system-snapshot" || manifest.version !== 2 || !Array.isArray(manifest.files)) {
    throw new Error(`Unsupported snapshot manifest: ${manifestPath}`);
  }
  let totalBytes = 0;
  for (const file of manifest.files) {
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
  return {
    filename: snapshotRoot,
    manifestPath,
    integrity: databaseVerification.integrity,
    schemaVersion: databaseVerification.schemaVersion,
    bytes: databaseVerification.bytes,
    sha256: databaseVerification.sha256,
    totalBytes,
    fileCount: manifest.files.length,
    referenceCount: manifest.databaseReferences?.length || 0,
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
      const references = verifyRestoredReferences(database, manifest, restoredRoot);
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

function collectDatabaseReferences(database) {
  const output = [];
  for (const specification of REFERENCED_FILE_COLUMNS) {
    if (!tableExists(database, specification.table)) continue;
    const rows = database.prepare(`SELECT ${specification.id} AS row_id, ${specification.column} AS stored_path FROM ${specification.table} WHERE COALESCE(${specification.column}, '') <> '' ORDER BY ${specification.id}`).all();
    for (const row of rows) output.push({
      table: specification.table,
      rowId: String(row.row_id),
      column: specification.column,
      category: specification.category,
      storedPath: String(row.stored_path),
    });
  }
  return output;
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

function verifyRestoredReferences(database, manifest, restoredRoot) {
  const expected = new Map((manifest.databaseReferences || []).map((item) => [referenceKey(item), item]));
  return collectDatabaseReferences(database).map((actual) => {
    const item = expected.get(referenceKey(actual));
    if (!item || item.storedPath !== actual.storedPath) {
      throw new Error(`Restored database reference is absent from the snapshot manifest: ${actual.table}.${actual.column} ${actual.rowId}`);
    }
    const filename = archiveFilename(restoredRoot, item.archivePath);
    if (!fs.existsSync(filename)) throw new Error(`Restored database reference is missing: ${item.archivePath}`);
    const descriptor = fs.openSync(filename, "r");
    try {
      if (item.bytes > 0) fs.readSync(descriptor, Buffer.alloc(1), 0, 1, 0);
    } finally {
      fs.closeSync(descriptor);
    }
    return { table: item.table, rowId: item.rowId, column: item.column, archivePath: item.archivePath, opened: true };
  });
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
  return `${reference.table}:${reference.rowId}:${reference.column}`;
}

function resolveStoredPath(value) {
  return path.isAbsolute(String(value)) ? path.resolve(String(value)) : path.resolve(projectRoot, String(value));
}

function archiveFilename(snapshotRoot, archivePath) {
  const normalized = String(archivePath || "").replaceAll("\\", "/");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe snapshot archive path: ${archivePath}`);
  }
  const filename = path.resolve(snapshotRoot, ...normalized.split("/"));
  assertInside(snapshotRoot, filename);
  return filename;
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
  const keep = Math.max(1, Number.parseInt(retention, 10) || 14);
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
  } else {
    const databasePath = path.resolve(args[0] || process.env.DATABASE_PATH || path.join(projectRoot, "data", "solo-to-china.sqlite"));
    const backupDir = path.resolve(args[1] || process.env.BACKUP_DIR || path.join(projectRoot, "backups"));
    const retention = Number.parseInt(process.env.BACKUP_RETENTION || "14", 10);
    console.log(JSON.stringify(createBackup({
      databasePath,
      backupDir,
      sourceUploadsDir: path.resolve(process.env.SOURCE_UPLOADS_DIR || path.join(projectRoot, "data", "source-uploads")),
      generatedMediaDir: path.resolve(process.env.GENERATED_MEDIA_DIR || path.join(projectRoot, "data", "generated-media")),
      retention,
      offsiteLocation: process.env.BACKUP_OFFSITE_LOCATION || "",
      offsiteRetentionDays: Number.parseInt(process.env.BACKUP_OFFSITE_RETENTION_DAYS || "0", 10),
      codeRevision: process.env.ENGINE_IMAGE || process.env.APP_REVISION || "",
      reason: process.env.BACKUP_REASON || "manual",
    }), null, 2));
  }
}
