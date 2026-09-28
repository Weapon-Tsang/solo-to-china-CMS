import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION } from "./db.mjs";

function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function rejectSymlinkAncestors(filename) {
  let current = path.resolve(filename);
  while (true) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symbolic-link runtime path is not allowed: ${current}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

const DATA_ROOT_IDENTITY = ".cms-data-root.json";

export function readLocalDataRootIdentity(config) {
  if (!config.deployment?.dataRoot) return null;
  const filename = path.join(path.resolve(config.deployment.dataRoot), DATA_ROOT_IDENTITY);
  rejectSymlinkAncestors(filename);
  if (!fs.existsSync(filename)) return null;
  let identity;
  try { identity = JSON.parse(fs.readFileSync(filename, "utf8")); }
  catch { throw new Error("CMS_DATA_ROOT identity marker is unreadable."); }
  if (identity?.format !== "cms-data-root-1" || !["development", "local-production", "migration-review"].includes(identity.kind)
    || !/^[a-f0-9-]{36}$/i.test(String(identity.datasetId || ""))) throw new Error("CMS_DATA_ROOT identity marker is invalid.");
  return identity;
}

export function markLocalDataRoot(config, kind, { adoptExisting = false } = {}) {
  if (!["development", "local-production", "migration-review"].includes(kind)) throw new Error("Invalid CMS data root kind.");
  if (!config.deployment?.dataRoot) throw new Error("CMS_DATA_ROOT is required.");
  const root = path.resolve(config.deployment.dataRoot);
  rejectSymlinkAncestors(root);
  if (inside(config.root, root)) throw new Error("CMS_DATA_ROOT must be outside the source checkout.");
  const existing = readLocalDataRootIdentity(config);
  if (existing) {
    if (existing.kind !== kind) throw new Error(`CMS_DATA_ROOT is marked ${existing.kind}; refusing to use it as ${kind}.`);
    return existing;
  }
  if (fs.existsSync(config.databasePath) && !adoptExisting) {
    throw new Error("Existing CMS database has no data-root identity; explicit adoption is required.");
  }
  fs.mkdirSync(root, { recursive: true });
  const identity = { format: "cms-data-root-1", kind, datasetId: crypto.randomUUID(),
    createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(root, DATA_ROOT_IDENTITY), `${JSON.stringify(identity, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return identity;
}

export function promoteReviewedLocalDataRoot(config, { oldHostStopped = false } = {}) {
  if (!oldHostStopped) throw new Error("Old host stop confirmation is required before local-production promotion.");
  const identity = readLocalDataRootIdentity(config);
  if (identity?.kind !== "migration-review") throw new Error("Only a reviewed restore can be promoted to local-production.");
  if (localRuntimeStatus(config).instances.length) throw new Error("CMS instance leases remain; clear them before promotion.");
  if (!fs.existsSync(config.databasePath)) throw new Error("Reviewed CMS database is missing.");
  const db = new DatabaseSync(config.databasePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON");
    const version = db.prepare("SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations").get().version;
    if (version !== SCHEMA_VERSION || db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok"
      || db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Reviewed CMS database failed schema, integrity, or foreign-key checks.");
    const { reconciliationRequired } = inspectLocalHandoffState(db);
    if (reconciliationRequired.length) {
      throw new Error(`Reviewed CMS database has unresolved handoff state: ${reconciliationRequired.join(", ")}. Reconcile before promotion.`);
    }
  } finally { db.close(); }
  const filename = path.join(path.resolve(config.deployment.dataRoot), DATA_ROOT_IDENTITY);
  const staging = `${filename}.next-${process.pid}`;
  const updated = { ...identity, kind: "local-production", promotedAt: new Date().toISOString(),
    priorKind: identity.kind, oldHostStopAttested: true };
  fs.writeFileSync(staging, `${JSON.stringify(updated, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try { fs.renameSync(staging, filename); }
  catch (error) { fs.rmSync(staging, { force: true }); throw error; }
  return { kind: updated.kind, datasetId: updated.datasetId, promotedAt: updated.promotedAt,
    oldHostStopAttested: true };
}

export function inspectLocalHandoffState(db) {
  const hasTable = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const count = (table, where) => hasTable(table) ? db.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE ${where}`).get().total : null;
  const handoff = {
    queuedJobs: count("jobs", "status='queued'"),
    runningJobs: count("jobs", "status='running'"),
    activeVertexBatches: count("vertex_batch_runs", "status IN ('preparing','submitted')"),
    unresolvedWordPressPublishes: count("wordpress_publish_attempts", "state IN ('dispatch_started','outcome_unknown')"),
    unresolvedWordPressMediaRefreshes: count("wordpress_media_refresh_attempts", "state IN ('dispatch_started','outcome_unknown')"),
    unresolvedMediaDispatches: count("media_dispatches", "state IN ('dispatch_started','outcome_unknown')"),
  };
  return { handoff, reconciliationRequired: Object.entries(handoff)
    .filter(([key, value]) => key !== "queuedJobs" && value !== null && value > 0).map(([key]) => key) };
}

export function assertLocalRuntime(config) {
  const mode = config.deployment?.runMode;
  if (!mode) return;
  if (mode === "migration-review") {
    throw new Error("migration-review is read-only: use npm run local:inspect, not the API or Worker server.");
  }
  if (!config.deployment.dataRoot) throw new Error("CMS_DATA_ROOT is required for an explicit local run mode.");
  const root = path.resolve(config.deployment.dataRoot);
  rejectSymlinkAncestors(root);
  if (/^(?:\\\\|\/\/)/.test(root) || /[\\/](?:OneDrive(?: - [^\\/]+)?|Dropbox|Google Drive|iCloudDrive)(?:[\\/]|$)/i.test(root)) {
    throw new Error("CMS_DATA_ROOT must be on a local non-synchronized filesystem; SMB/NFS and known cloud-sync folders are unsupported for SQLite.");
  }
  if (inside(config.root, root)) throw new Error("CMS_DATA_ROOT must be outside the source checkout.");
  for (const [name, filename] of Object.entries({ database: config.databasePath, sourceUploads: config.manualSources.uploadDir,
    generatedMedia: config.visuals.mediaDir, captureUploads: config.captureUploads.uploadDir,
    captureMediaUploads: config.captureMediaUploads.uploadDir })) {
    if (!inside(root, filename)) throw new Error(`${name} must be inside CMS_DATA_ROOT.`);
  }
  const identity = readLocalDataRootIdentity(config);
  if (mode === "development") {
    if (identity && identity.kind !== "development") throw new Error(`development cannot use a ${identity.kind} CMS_DATA_ROOT.`);
    if (!identity && fs.existsSync(config.databasePath)) throw new Error("development cannot open an unmarked existing CMS database; use a dedicated initialized test data root.");
  }
  if (mode === "local-production") {
    if (!fs.existsSync(config.databasePath)) throw new Error("local-production database is missing; restore or initialize explicitly before startup.");
    if (!fs.existsSync(path.join(config.root, "dist", "index.html"))) throw new Error("Stable build is missing; run npm run build before local-production startup.");
    if (!config.deployment.releaseRoot || path.resolve(config.deployment.releaseRoot) !== path.resolve(config.root)) {
      throw new Error("local-production must run from its CMS_RELEASE_ROOT stable build, not the development checkout.");
    }
    if (identity?.kind !== "local-production") throw new Error("local-production requires an explicitly adopted local-production CMS_DATA_ROOT.");
  }
}

export function assertLocalCredentialReadiness(config, processRole, routing) {
  if (config.deployment?.runMode !== "local-production" || processRole === "api") return;
  if (routing.encryptionErrorCode && Object.values(routing.credentials || {}).some((credential) => credential.source === "encrypted_database")) {
    throw Object.assign(new Error(`Local production Worker cannot decrypt stored model credentials: ${routing.encryptionErrorCode}.`), {
      code: routing.encryptionErrorCode,
    });
  }
}

const ROLES = new Set(["all", "api", "worker"]);
const REGISTRATION = ".cms-instance-registration.lock";

export function localLogPath(config, role, { create = false } = {}) {
  if (!config.deployment?.dataRoot) throw new Error("CMS_DATA_ROOT is required for local logs.");
  if (!ROLES.has(role)) throw new Error(`Unsupported CMS process role: ${role}`);
  const directory = path.join(path.resolve(config.deployment.dataRoot), "logs");
  rejectSymlinkAncestors(directory);
  if (create) fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, `${role}.jsonl`);
  rejectSymlinkAncestors(filename);
  return filename;
}

function instanceDirectory(config, { create = false } = {}) {
  if (!config.deployment?.runMode) return null;
  const root = path.resolve(config.deployment.dataRoot);
  rejectSymlinkAncestors(root);
  if (!fs.existsSync(root)) {
    if (!create) return null;
    fs.mkdirSync(root, { recursive: true });
  }
  const directory = path.join(root, ".cms-instances");
  if (!fs.existsSync(directory)) {
    if (!create) return null;
    fs.mkdirSync(directory, { recursive: true });
  }
  rejectSymlinkAncestors(directory);
  return directory;
}

function withRegistration(config, action) {
  const directory = instanceDirectory(config, { create: true });
  if (!directory) return action(null);
  const registration = path.join(directory, REGISTRATION);
  try { fs.mkdirSync(registration); }
  catch (error) {
    if (error.code === "EEXIST") throw Object.assign(new Error("CMS instance registration is busy or stale; inspect local:status before retrying."), { code: "CMS_INSTANCE_REGISTRATION_BUSY" });
    throw error;
  }
  try { return action(directory); }
  finally { fs.rmdirSync(registration); }
}

function leasePath(directory, role) {
  if (!ROLES.has(role)) throw new Error(`Unsupported CMS process role: ${role}`);
  return path.join(directory, `${role}.json`);
}

function readLease(filename) {
  try { return JSON.parse(fs.readFileSync(filename, "utf8")); }
  catch (error) { return { invalid: true, error: error.code || "INVALID_JSON" }; }
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

export function localRuntimeStatus(config) {
  const directory = instanceDirectory(config);
  if (!directory) return { enabled: Boolean(config.deployment?.runMode), instances: [] };
  const instances = [...ROLES].flatMap((role) => {
    const filename = leasePath(directory, role);
    if (!fs.existsSync(filename)) return [];
    const lease = readLease(filename);
    return [{ role, pid: lease.pid || null, alive: pidAlive(lease.pid), mode: lease.mode || null,
      releaseRoot: lease.releaseRoot || null, invalid: lease.invalid === true }];
  });
  return { enabled: true, dataRoot: config.deployment.dataRoot, instances,
    registrationBusy: fs.existsSync(path.join(directory, REGISTRATION)) };
}

export function acquireLocalRuntimeLease(config) {
  const mode = config.deployment?.runMode;
  if (!mode) return () => {};
  if (mode === "migration-review") throw new Error("migration-review cannot acquire a writing instance lease.");
  const role = config.processRole || "all";
  const nonce = crypto.randomUUID();
  const filename = withRegistration(config, (directory) => {
    const incompatible = role === "all" ? ["all", "api", "worker"] : ["all", role];
    for (const candidate of incompatible) {
      if (fs.existsSync(leasePath(directory, candidate))) {
        throw Object.assign(new Error(`CMS ${candidate} instance already owns this data root; inspect local:status before retrying.`), { code: "CMS_INSTANCE_CONFLICT" });
      }
    }
    const target = leasePath(directory, role);
    fs.writeFileSync(target, `${JSON.stringify({ pid: process.pid, nonce, mode,
      releaseRoot: config.root, startedAt: new Date().toISOString() })}\n`, { flag: "wx" });
    return target;
  });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    withRegistration(config, () => {
      const lease = readLease(filename);
      if (lease.nonce === nonce) {
        const request = stopRequestPath(path.dirname(filename), role);
        if (fs.existsSync(request) && readLease(request).nonce === nonce) fs.rmSync(request);
        fs.rmSync(filename);
      }
    });
  };
  release.nonce = nonce;
  release.role = role;
  return release;
}

function stopRequestPath(directory, role) {
  return path.join(directory, `stop-${role}.json`);
}

export function requestLocalRuntimeStop(config, role) {
  const directory = instanceDirectory(config);
  if (!directory || !fs.existsSync(leasePath(directory, role))) return { role, alreadyStopped: true };
  const lease = readLease(leasePath(directory, role));
  if (!lease.nonce || !pidAlive(lease.pid)) throw new Error(`CMS ${role} has no live, valid instance lease; inspect local:status.`);
  const request = stopRequestPath(directory, role);
  if (fs.existsSync(request)) {
    const existing = readLease(request);
    if (existing.nonce === lease.nonce) return { role, pid: lease.pid, requestPath: request, alreadyRequested: true };
    fs.rmSync(request);
  }
  fs.writeFileSync(request, `${JSON.stringify({ nonce: lease.nonce, requestedAt: new Date().toISOString() })}\n`, { flag: "wx" });
  return { role, pid: lease.pid, requestPath: request };
}

export function consumeLocalRuntimeStopRequest(config, release) {
  if (!release.nonce) return false;
  const directory = instanceDirectory(config);
  if (!directory) return false;
  const filename = stopRequestPath(directory, release.role);
  if (!fs.existsSync(filename)) return false;
  const request = readLease(filename);
  fs.rmSync(filename);
  return request.nonce === release.nonce;
}

export function unlockStaleLocalRuntimeLease(config, role) {
  return withRegistration(config, (directory) => {
    if (!directory) throw new Error("An explicit local runtime mode is required.");
    const filename = leasePath(directory, role);
    if (!fs.existsSync(filename)) return { removed: false, reason: "absent" };
    const lease = readLease(filename);
    if (pidAlive(lease.pid)) throw new Error(`CMS ${role} PID ${lease.pid} is still alive; refusing to unlock.`);
    const request = stopRequestPath(directory, role);
    if (fs.existsSync(request) && readLease(request).nonce === lease.nonce) fs.rmSync(request);
    fs.rmSync(filename);
    return { removed: true, role, pid: lease.pid || null };
  });
}
