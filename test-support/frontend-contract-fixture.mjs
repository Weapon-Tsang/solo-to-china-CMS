import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function frontendContractFixture(t, { contractVersion = "1.2.0", schemaVersion = "1.0.0", components = defaultComponents(), pageSchema = defaultPageSchema(schemaVersion) } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-to-china-frontend-contract-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const registryPath = path.join(directory, "component-registry.json");
  const pageSchemaPath = path.join(directory, "page-schema.json");
  const write = (next = {}) => {
    const nextContractVersion = next.contractVersion || contractVersion;
    const nextSchemaVersion = next.schemaVersion || schemaVersion;
    fs.writeFileSync(registryPath, JSON.stringify({ contractVersion: nextContractVersion, schemaVersion: nextSchemaVersion, frontendCommitSha: "fixture-commit", components: next.components || components, ...next.registry }, null, 2));
    fs.writeFileSync(pageSchemaPath, JSON.stringify(next.pageSchema || pageSchema, null, 2));
  };
  write();
  return { directory, registryPath, pageSchemaPath, write };
}

export function defaultComponents() {
  return [
    {
      id: "articleSection", category: "article", purpose: "Reader-facing article answer and narrative section.", status: "stable", variants: ["default", "answer-first"],
      schema: { type: "object", additionalProperties: false, required: ["heading", "body"], properties: { heading: { type: "string", minLength: 1 }, body: { type: "string", minLength: 1 } } },
    },
    {
      id: "faqList", category: "discovery", purpose: "Evidence-backed frequently asked questions.", status: "stable", variants: ["default"],
      schema: { type: "object", additionalProperties: false, required: ["items"], properties: { items: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["question", "answer"], properties: { question: { type: "string" }, answer: { type: "string" } } } } } },
    },
    {
      id: "notice", category: "guidance", purpose: "Important warning or time-sensitive practical guidance.", status: "stable", variants: ["warning", "info"],
      schema: { type: "object", additionalProperties: false, required: ["title", "message"], properties: { title: { type: "string" }, message: { type: "string" } } },
    },
    {
      id: "legacyPanel", category: "article", purpose: "Old article content panel.", status: "deprecated", variants: ["default"], deprecation: { replacement: "articleSection" },
      schema: { type: "object", additionalProperties: false, required: ["body"], properties: { body: { type: "string" } } },
    },
  ];
}

export function defaultPageSchema(schemaVersion = "1.0.0") {
  return {
    schemaVersion,
    type: "object",
    additionalProperties: false,
    required: ["metadata", "blocks"],
    properties: {
      metadata: { type: "object", additionalProperties: false, required: ["title"], properties: { title: { type: "string", minLength: 1 } } },
      blocks: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["type", "data"], properties: { type: { type: "string" }, variant: { type: "string" }, data: { type: "object" } } } },
    },
  };
}
