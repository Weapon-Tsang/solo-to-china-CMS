import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db.mjs";
import { Repository } from "../src/repository.mjs";
import { FrontendContractConsumer } from "../src/frontend-contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontend = path.resolve(process.env.FRONTEND_REPOSITORY_PATH || path.join(root, "..", "solo-to-china"));
const releaseGate = JSON.parse(fs.readFileSync(path.join(root, "config", "release-gate.json"), "utf8"));
const frontendCommit = String(process.env.FRONTEND_CONTRACT_COMMIT_SHA || releaseGate.frontend.commitSha || "").toLowerCase();
if (!/^[a-f0-9]{40}$/.test(frontendCommit)) throw new Error("A fixed Frontend commit SHA is required for the contract gate.");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "stc-cross-repo-"));
const files = {
  registry: { target: path.join(temporary, "component-registry.json"), source: "contracts/component-registry.json" },
  page: { target: path.join(temporary, "page-schema.json"), source: "contracts/page-schema.json" },
  publish: { target: path.join(temporary, "cms-publish-package.schema.json"), source: "contracts/cms-publish-package.schema.json" },
};
let database = null;
try {
for (const [name, file] of Object.entries(files)) {
  let contents;
  try {
    contents = execFileSync("git", ["-C", frontend, "show", `${frontendCommit}:${file.source}`], { encoding: "utf8", windowsHide: true });
  } catch (error) {
    throw new Error(`Frontend ${name} artifact is unavailable at fixed commit ${frontendCommit}: ${error?.stderr || error.message}`);
  }
  JSON.parse(contents);
  fs.writeFileSync(file.target, contents, "utf8");
}
// The Frontend generator records the exact distributed Registry checksum. Git
// normalizes its single terminal CRLF to LF in the blob, so reconstruct only
// that transport newline when (and only when) it matches the declared checksum.
const publishSchema = JSON.parse(fs.readFileSync(files.publish.target, "utf8"));
const declaredRegistryChecksum = publishSchema.properties?.contract?.properties?.contractChecksum?.const;
const registryText = fs.readFileSync(files.registry.target, "utf8");
if (declaredRegistryChecksum && sha256(registryText) !== declaredRegistryChecksum) {
  const distributedRegistryText = `${registryText.replace(/\r?\n$/, "")}\r\n`;
  if (sha256(distributedRegistryText) === declaredRegistryChecksum) fs.writeFileSync(files.registry.target, distributedRegistryText, "utf8");
}
database = openDatabase(path.join(temporary, "contract.sqlite"));
  const repository = new Repository(database);
  const consumer = new FrontendContractConsumer(repository, {
    registrySource: files.registry.target,
    pageSchemaSource: files.page.target,
    publishPackageSchemaSource: files.publish.target,
    sourceRepository: releaseGate.frontend.repository,
    frontendCommitSha: frontendCommit,
  });
  await consumer.sync();
  const active = consumer.active;
  if (active.contractVersion !== releaseGate.frontend.contractVersion) throw new Error(`Expected Frontend Contract ${releaseGate.frontend.contractVersion}, received ${active.contractVersion}.`);
  const paragraph = active.componentsById.get("paragraph");
  const payload = {
    metadata: { pageId: "cross-repo-gate", title: "Cross repository gate", slug: "cross-repository-gate", contentType: "practical_guide" },
    blocks: [{ type: "paragraph", variant: paragraph.variants[0], data: { content: "Visible evidence-backed content." } }],
  };
  const validation = consumer.validatePagePayload(payload);
  if (!validation.valid) throw new Error(`Generated Page Schema rejected a Registry-derived block: ${JSON.stringify(validation.errors)}`);
  if (!active.artifact_checksum || active.artifact_checksum.length !== 64) throw new Error("Composite Registry/Page/Publish artifact checksum was not persisted.");
  console.log(`Cross-repository contract gate passed for ${active.contractVersion} at ${frontendCommit} (${active.artifact_checksum}).`);
} finally {
  database?.close();
  fs.rmSync(temporary, { recursive: true, force: true });
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
