import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function createBackup({ databasePath, backupDir, retention = 14, clock = () => new Date() }) {
  const source = path.resolve(databasePath);
  const destinationDir = path.resolve(backupDir);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`Database does not exist: ${source}`);
  fs.mkdirSync(destinationDir, { recursive: true });
  const stamp = clock().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(destinationDir, `solo-to-china-${stamp}.sqlite`);
  assertInside(destinationDir, backupPath);

  const database = new DatabaseSync(source);
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    assertIntegrity(database, source);
    database.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
  } finally {
    database.close();
  }

  const verification = verifyBackup(backupPath);
  const manifest = {
    version: 1,
    createdAt: clock().toISOString(),
    source,
    backup: path.basename(backupPath),
    bytes: fs.statSync(backupPath).size,
    sha256: hashFile(backupPath),
    schemaVersion: verification.schemaVersion,
    integrity: verification.integrity,
  };
  fs.writeFileSync(`${backupPath}.json`, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  pruneBackups(destinationDir, retention);
  return { backupPath, manifestPath: `${backupPath}.json`, ...manifest };
}

export function verifyBackup(filename) {
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
  const backups = fs.readdirSync(directory).filter((name) => /^solo-to-china-.+\.sqlite$/.test(name)).sort().reverse();
  for (const name of backups.slice(keep)) {
    const backupPath = path.resolve(directory, name);
    assertInside(directory, backupPath);
    fs.rmSync(backupPath);
    if (fs.existsSync(`${backupPath}.json`)) fs.rmSync(`${backupPath}.json`);
  }
}

function assertInside(directory, filename) {
  const rootWithSeparator = `${path.resolve(directory)}${path.sep}`;
  if (!path.resolve(filename).startsWith(rootWithSeparator)) throw new Error(`Refusing to write outside backup directory: ${filename}`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--verify") {
    if (!args[1]) throw new Error("Usage: npm run backup:verify -- <backup.sqlite>");
    console.log(JSON.stringify(verifyBackup(args[1]), null, 2));
  } else {
    const databasePath = path.resolve(args[0] || process.env.DATABASE_PATH || path.join(root, "data", "solo-to-china.sqlite"));
    const backupDir = path.resolve(args[1] || process.env.BACKUP_DIR || path.join(root, "backups"));
    const retention = Number.parseInt(process.env.BACKUP_RETENTION || "14", 10);
    console.log(JSON.stringify(createBackup({ databasePath, backupDir, retention }), null, 2));
  }
}
