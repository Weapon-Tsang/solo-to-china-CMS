import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { markLocalDataRoot, readLocalDataRootIdentity } from "../src/local-runtime.mjs";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.resolve(process.env.CMS_RELEASE_ROOT || "");
const dataRoot = path.resolve(process.env.CMS_DATA_ROOT || "");
if (!process.env.CMS_RELEASE_ROOT || !process.env.CMS_DATA_ROOT) throw new Error("CMS_RELEASE_ROOT and CMS_DATA_ROOT are required.");
const runtimeConfig = loadConfig({ ...process.env, CMS_DATA_ROOT: dataRoot });
const inside = (root, candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`);
const rejectSymlinkAncestors = (filename) => {
  let current = path.resolve(filename);
  while (true) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symbolic-link path is not allowed: ${current}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
};
rejectSymlinkAncestors(target);
rejectSymlinkAncestors(dataRoot);
if (inside(source, target) || inside(target, source) || inside(dataRoot, target) || inside(target, dataRoot)) {
  throw new Error("Release, source checkout, and data root must be separate directories.");
}
if (!fs.existsSync(runtimeConfig.databasePath)) throw new Error("Stable release requires an existing CMS database; restore it before preparing the release.");
const identity = readLocalDataRootIdentity(runtimeConfig);
if (identity && identity.kind !== "local-production") throw new Error(`Stable release cannot adopt a ${identity.kind} CMS_DATA_ROOT.`);
if (fs.existsSync(target)) throw new Error(`Release directory already exists: ${target}`);
if (!fs.existsSync(path.join(source, "dist", "index.html"))) throw new Error("Build is missing; run npm run build first.");
const staging = `${target}.incomplete-${process.pid}`;
if (fs.existsSync(staging)) throw new Error(`Release staging directory already exists: ${staging}`);
fs.mkdirSync(staging, { recursive: true });
for (const entry of ["src", "config", "dist", "extension", "vendor", "public", "package.json", "package-lock.json"]) {
  fs.cpSync(path.join(source, entry), path.join(staging, entry), { recursive: true, errorOnExist: true });
}
fs.mkdirSync(path.join(staging, "scripts"));
for (const entry of ["inspect-local-data.mjs", "local-runtime-status.mjs", "promote-local-data.mjs"]) {
  fs.cpSync(path.join(source, "scripts", entry), path.join(staging, "scripts", entry), { errorOnExist: true });
}
fs.mkdirSync(path.join(staging, "docs"), { recursive: true });
fs.cpSync(path.join(source, "docs", "content-strategy"), path.join(staging, "docs", "content-strategy"), { recursive: true });
const npmCli = process.env.npm_execpath;
const install = npmCli
  ? spawnSync(process.execPath, [npmCli, "ci", "--omit=dev"], { cwd: staging, stdio: "inherit" })
  : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--omit=dev"], {
      cwd: staging, stdio: "inherit", shell: process.platform === "win32",
    });
if (install.status !== 0) throw new Error(`Production dependency installation failed; incomplete release kept at ${staging}`);
const sha256 = (filename) => crypto.createHash("sha256").update(fs.readFileSync(path.join(staging, filename))).digest("hex");
fs.writeFileSync(path.join(staging, ".cms-release.json"), `${JSON.stringify({
  format: "cms-local-release-1", preparedAt: new Date().toISOString(),
  packageLockSha256: sha256("package-lock.json"), indexSha256: sha256("dist/index.html"),
  dataRoot, sourceRevision: process.env.APP_REVISION || "unrecorded",
}, null, 2)}\n`, { flag: "wx" });
fs.renameSync(staging, target);
markLocalDataRoot(runtimeConfig, "local-production", { adoptExisting: true });
console.log(JSON.stringify({ releaseRoot: target, dataRoot, prepared: true, productionDeployment: false }, null, 2));
