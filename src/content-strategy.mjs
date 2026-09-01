import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "config", "content-strategy.json");

export const CONTENT_STRATEGY = Object.freeze(loadManifest());

export function getContentStrategy() {
  return { ...CONTENT_STRATEGY, history: CONTENT_STRATEGY.history.map((entry) => ({ ...entry, changes: [...entry.changes] })) };
}

export function getContentStrategyDocument() {
  const documentPath = path.resolve(root, CONTENT_STRATEGY.document);
  return {
    ...getContentStrategy(),
    filename: path.basename(documentPath),
    markdown: fs.readFileSync(documentPath, "utf8"),
  };
}

function loadManifest() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const required = ["name", "current_version", "document", "status", "history"];
  for (const key of required) {
    if (!String(manifest[key] || "").trim()) throw new Error(`Content strategy manifest is missing ${key}.`);
  }
  if (!/^\d+\.\d+$/.test(manifest.current_version)) throw new Error("Content strategy version must use major.minor format.");
  if (!Array.isArray(manifest.history) || manifest.history.length === 0) {
    throw new Error("Content strategy manifest must include a non-empty evolution history.");
  }
  const history = manifest.history.map((entry, index) => {
    const version = String(entry?.version || "").trim();
    const effectiveDate = String(entry?.effective_date || "").trim();
    const status = String(entry?.status || "").trim();
    const summary = String(entry?.summary || "").trim();
    const changes = Array.isArray(entry?.changes) ? entry.changes.map((change) => String(change || "").trim()).filter(Boolean) : [];
    if (!/^\d+\.\d+$/.test(version) || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) || !status || !summary || changes.length === 0) {
      throw new Error(`Content strategy history entry ${index + 1} is incomplete.`);
    }
    return Object.freeze({ version, effectiveDate, status, summary, changes: Object.freeze(changes) });
  });
  const activeEntries = history.filter((entry) => entry.version === manifest.current_version && entry.status === "active");
  if (activeEntries.length !== 1) throw new Error("Content strategy history must contain exactly one active entry for current_version.");
  const documentPath = path.resolve(root, manifest.document);
  if (!documentPath.startsWith(`${root}${path.sep}`) || !fs.existsSync(documentPath)) {
    throw new Error(`Content strategy specification is missing: ${manifest.document}`);
  }
  return Object.freeze({
    name: manifest.name,
    version: manifest.current_version,
    document: manifest.document,
    status: manifest.status,
    history: Object.freeze(history),
  });
}
