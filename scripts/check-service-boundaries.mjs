import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function checkServiceBoundaries(configFile = path.join(root, "config", "service-boundaries.json")) {
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  const failures = [];
  const checkedFiles = new Set();
  for (const rule of config.dependencyRules || []) {
    for (const entry of config.boundaries?.[rule.from] || []) {
      for (const filename of sourceFiles(path.join(root, entry))) {
        checkedFiles.add(filename);
        const source = fs.readFileSync(filename, "utf8");
        const imports = [...source.matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/g)].map((match) => match[1].replaceAll("\\", "/"));
        for (const imported of imports) {
          for (const fragment of rule.forbidImportFragments || []) {
            if (imported.endsWith(fragment) || imported.includes(fragment)) failures.push({
              rule: `${rule.from} cannot import Commercial`,
              file: path.relative(root, filename).replaceAll("\\", "/"), imported,
            });
          }
        }
      }
    }
  }
  return { valid: failures.length === 0, version: config.version, checkedFiles: checkedFiles.size, failures, boundaries: Object.keys(config.boundaries || {}) };
}

function sourceFiles(target) {
  if (!fs.existsSync(target)) return [];
  const stat = fs.statSync(target);
  if (stat.isFile()) return target.endsWith(".mjs") ? [target] : [];
  return fs.readdirSync(target, { withFileTypes: true }).flatMap((entry) => sourceFiles(path.join(target, entry.name)));
}

if (import.meta.main) {
  const result = checkServiceBoundaries();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.valid) process.exitCode = 1;
}
