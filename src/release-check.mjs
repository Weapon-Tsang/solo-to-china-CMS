import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./db.mjs";
import { VERSION } from "./version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension", "manifest.json"), "utf8"));
if (packageJson.version !== VERSION || manifest.version !== VERSION) {
  throw new Error(`Release versions must all be ${VERSION} (package=${packageJson.version}, extension=${manifest.version}).`);
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-to-china-release-"));
try {
  const database = openDatabase(path.join(directory, "release.sqlite"));
  try {
    const versions = database.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((row) => row.version);
    if (versions.join(",") !== "1,2,3,4,5,6,7,8,9,10,11") throw new Error(`Unexpected migration chain: ${versions.join(",")}`);
    const integrity = database.prepare("PRAGMA integrity_check").get();
    if (Object.values(integrity)[0] !== "ok") throw new Error("Release database integrity check failed.");
  } finally {
    database.close();
  }
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log("Release check passed: version alignment, migrations 1-11, and SQLite integrity.");
