import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const argumentsMap = new Map(process.argv.slice(2).flatMap((value, index, values) => value.startsWith("--") ? [[value, values[index + 1]]] : []));
const origin = normalizeOrigin(argumentsMap.get("--origin"));
const output = path.resolve(argumentsMap.get("--out") || "output/extension-cloud");

if (!origin) {
  console.error("Usage: node scripts/package-extension-cloud.mjs --origin https://capture.example.com [--out output/extension-cloud]");
  process.exit(1);
}

const root = path.resolve("extension");
fs.rmSync(output, { recursive: true, force: true });
fs.cpSync(root, output, { recursive: true });
const manifestPath = path.join(output, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.host_permissions = [`${origin}/*`];
manifest.name = "Save to SoloToChina";
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
const popupPath = path.join(output, "popup.js");
const originalPopup = fs.readFileSync(popupPath, "utf8");
const popup = originalPopup.replace('const DEFAULT_ENDPOINT = "http://127.0.0.1:4310";', `const DEFAULT_ENDPOINT = ${JSON.stringify(origin)};`);
if (popup === originalPopup) throw new Error("Extension default endpoint marker was not found.");
fs.writeFileSync(popupPath, popup);
console.log(`Cloud extension package created at ${output}`);

function normalizeOrigin(value) {
  try {
    const url = new URL(value || "");
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}
