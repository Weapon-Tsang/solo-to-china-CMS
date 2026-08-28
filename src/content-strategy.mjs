import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "config", "content-strategy.json");

export const CONTENT_STRATEGY = Object.freeze(loadManifest());

export function getContentStrategy() {
  return { ...CONTENT_STRATEGY };
}

function loadManifest() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const required = ["name", "current_version", "document", "status"];
  for (const key of required) {
    if (!String(manifest[key] || "").trim()) throw new Error(`Content strategy manifest is missing ${key}.`);
  }
  if (!/^\d+\.\d+$/.test(manifest.current_version)) throw new Error("Content strategy version must use major.minor format.");
  const documentPath = path.resolve(root, manifest.document);
  if (!documentPath.startsWith(`${root}${path.sep}`) || !fs.existsSync(documentPath)) {
    throw new Error(`Content strategy specification is missing: ${manifest.document}`);
  }
  return {
    name: manifest.name,
    version: manifest.current_version,
    document: manifest.document,
    status: manifest.status,
  };
}
