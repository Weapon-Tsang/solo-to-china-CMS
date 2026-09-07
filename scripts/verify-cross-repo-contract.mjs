import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db.mjs";
import { Repository } from "../src/repository.mjs";
import { FrontendContractConsumer } from "../src/frontend-contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontend = path.resolve(process.env.FRONTEND_REPOSITORY_PATH || path.join(root, "..", "solo-to-china"));
const files = {
  registry: path.join(frontend, "contracts", "component-registry.json"),
  page: path.join(frontend, "contracts", "page-schema.json"),
  publish: path.join(frontend, "contracts", "cms-publish-package.schema.json"),
};
for (const [name, filename] of Object.entries(files)) {
  if (!fs.existsSync(filename)) throw new Error(`Frontend ${name} artifact is missing: ${filename}`);
}
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "stc-cross-repo-"));
const database = openDatabase(path.join(temporary, "contract.sqlite"));
try {
  const repository = new Repository(database);
  const consumer = new FrontendContractConsumer(repository, {
    registrySource: files.registry,
    pageSchemaSource: files.page,
    publishPackageSchemaSource: files.publish,
    sourceRepository: "https://github.com/Weapon-Tsang/solo-to-china",
  });
  await consumer.sync();
  const active = consumer.active;
  const paragraph = active.componentsById.get("paragraph");
  const payload = {
    metadata: { pageId: "cross-repo-gate", title: "Cross repository gate", slug: "cross-repository-gate", contentType: "practical_guide" },
    blocks: [{ type: "paragraph", variant: paragraph.variants[0], data: { content: "Visible evidence-backed content." } }],
  };
  const validation = consumer.validatePagePayload(payload);
  if (!validation.valid) throw new Error(`Generated Page Schema rejected a Registry-derived block: ${JSON.stringify(validation.errors)}`);
  if (!active.artifact_checksum || active.artifact_checksum.length !== 64) throw new Error("Composite Registry/Page/Publish artifact checksum was not persisted.");
  console.log(`Cross-repository contract gate passed for ${active.contractVersion} (${active.artifact_checksum}).`);
} finally {
  database.close();
  fs.rmSync(temporary, { recursive: true, force: true });
}
