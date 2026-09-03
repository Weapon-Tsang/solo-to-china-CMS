import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./utils.mjs";

const MAX_CONTRACT_BYTES = 2 * 1024 * 1024;
const COMPONENT_STATUSES = new Set(["stable", "deprecated", "experimental", "beta"]);

export class FrontendContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "FrontendContractError";
    this.code = code;
    this.details = details;
  }
}

export class FrontendContractConsumer {
  constructor(repository, config = {}, fetchImpl = fetch) {
    this.repository = repository;
    this.config = config;
    this.fetch = fetchImpl;
  }

  get configured() {
    return Boolean(this.config.registrySource && this.config.pageSchemaSource);
  }

  get active() {
    const snapshot = this.repository.getActiveFrontendContractSnapshot();
    return snapshot ? hydrateSnapshot(snapshot) : null;
  }

  diagnostics() {
    const state = this.repository.getFrontendContractState();
    const active = this.active;
    return {
      configured: this.configured,
      status: state?.status || "unconfigured",
      sourceRepository: this.config.sourceRepository || "",
      registrySource: this.config.registrySource || "",
      pageSchemaSource: this.config.pageSchemaSource || "",
      lastAttemptAt: state?.last_attempt_at || null,
      lastSuccessAt: state?.last_success_at || null,
      lastError: state?.last_error || null,
      active: active ? snapshotSummary(active) : null,
      availableComponents: active?.components.length || 0,
      stableComponents: active?.components.filter((item) => item.status === "stable").length || 0,
      deprecatedComponents: active?.components.filter((item) => item.status === "deprecated").map((item) => item.id) || [],
      canCompose: Boolean(active && (state?.status === "healthy" || state?.status === "stale")),
    };
  }

  capabilities({ semantics = [], includeDeprecated = false } = {}) {
    const active = this.active;
    if (!active) return { status: "NO_VALID_FRONTEND_CONTRACT", components: [] };
    const terms = new Set((Array.isArray(semantics) ? semantics : [semantics]).flatMap(tokenize));
    const components = active.components
      .filter((component) => includeDeprecated || component.status !== "deprecated")
      .map((component) => ({ ...component, relevance: capabilityRelevance(component, terms) }))
      .filter((component) => !terms.size || component.relevance > 0)
      .sort((a, b) => b.relevance - a.relevance || a.id.localeCompare(b.id));
    return {
      status: "OK", contractVersion: active.contractVersion, schemaVersion: active.schemaVersion,
      checksum: active.checksum, components,
    };
  }

  resolveForArticle({ canonical = {}, draft = {} } = {}) {
    const semanticText = [
      canonical.content_type, canonical.content_intent, canonical.quick_answer,
      ...(canonical.warnings || []), ...(canonical.transport || []), ...(canonical.faq || []).map((item) => item.question),
      draft.title, draft.body_markdown,
    ].filter(Boolean).join(" ");
    const resolved = editorialCapabilities(this.capabilities({ semantics: tokenize(semanticText) }));
    if (resolved.components.length) return resolved;
    const fallback = editorialCapabilities(this.capabilities());
    return { ...fallback, components: fallback.components.slice(0, 24) };
  }

  hasComponent(componentId) {
    const component = this.active?.componentsById.get(componentId);
    return Boolean(component && component.status !== "deprecated");
  }

  commercialCapabilities(componentIds = []) {
    const active = this.active;
    const requested = [...new Set(componentIds)];
    if (!active) return { status: "NO_VALID_FRONTEND_CONTRACT", supported: [], missing: requested };
    const supported = requested.filter((componentId) => this.hasComponent(componentId));
    return { status: "OK", supported, missing: requested.filter((componentId) => !supported.includes(componentId)), contract: snapshotSummary(active) };
  }

  async sync() {
    if (!this.configured) {
      const error = new FrontendContractError("FRONTEND_CONTRACT_UNCONFIGURED", "Both FRONTEND_COMPONENT_REGISTRY_SOURCE and FRONTEND_PAGE_SCHEMA_SOURCE are required.");
      this.repository.recordFrontendContractAttempt("unconfigured", error.message);
      throw error;
    }
    this.repository.recordFrontendContractAttempt("syncing", null);
    try {
      const [registryDocument, pageSchemaDocument] = await Promise.all([
        readJsonDocument(this.config.registrySource, this.fetch, this.config.timeoutMs),
        readJsonDocument(this.config.pageSchemaSource, this.fetch, this.config.timeoutMs),
      ]);
      const registry = normalizeRegistry(registryDocument);
      const pageSchema = normalizePageSchema(pageSchemaDocument, registry.schemaVersion);
      if (pageSchema.schemaVersion !== registry.schemaVersion) {
        throw new FrontendContractError("SCHEMA_VERSION_MISMATCH", `Registry schemaVersion ${registry.schemaVersion} does not match Page Schema ${pageSchema.schemaVersion}.`);
      }
      const previous = this.active;
      const checksum = sha256(stableStringify({ registry: registry.raw, pageSchema: pageSchema.raw }));
      const diff = previous ? diffContracts(previous, { ...registry, pageSchema }) : emptyDiff();
      const majorMismatch = Boolean(previous && semverMajor(previous.contractVersion) !== semverMajor(registry.contractVersion));
      const result = this.repository.saveFrontendContractSnapshot({
        sourceRepository: this.config.sourceRepository || "",
        registrySource: this.config.registrySource,
        pageSchemaSource: this.config.pageSchemaSource,
        frontendCommitSha: registry.frontendCommitSha || pageSchema.frontendCommitSha || this.config.frontendCommitSha || null,
        contractVersion: registry.contractVersion,
        schemaVersion: registry.schemaVersion,
        checksum,
        registry: registry.raw,
        pageSchema: pageSchema.raw,
        diff,
        activate: !majorMismatch,
        majorMismatch,
      });
      return { ...this.diagnostics(), synced: true, update: diff, majorMismatch, snapshot: result };
    } catch (error) {
      const message = error?.message || String(error);
      this.repository.recordFrontendContractAttempt(this.active ? "stale" : "invalid", message);
      if (error instanceof FrontendContractError) throw error;
      throw new FrontendContractError("FRONTEND_CONTRACT_SYNC_FAILED", message);
    }
  }

  acceptMajorSnapshot(snapshotId) {
    const snapshot = this.repository.acceptFrontendContractSnapshot(snapshotId);
    if (!snapshot) throw new FrontendContractError("UNKNOWN_CONTRACT_SNAPSHOT", "The requested Frontend Contract snapshot does not exist.");
    return this.diagnostics();
  }

  validateCompositionPlan(plan, { allowDeprecated = false } = {}) {
    const active = this.active;
    if (!active) return invalid("NO_VALID_FRONTEND_CONTRACT", "No validated Frontend Contract is available for page composition.");
    const blocks = Array.isArray(plan?.blocks) ? plan.blocks : [];
    if (!blocks.length) return invalid("MISSING_PAGE_BLOCKS", "A composition plan requires a non-empty blocks array.");
    const errors = [];
    const warnings = [];
    blocks.forEach((block, index) => {
      const component = active.componentsById.get(block?.type);
      if (!component) return errors.push(issue("UNKNOWN_COMPONENT", `blocks[${index}].type '${block?.type || ""}' is not in the current Frontend Registry.`, `blocks[${index}].type`));
      if (component.status === "deprecated") {
        const target = issue("DEPRECATED_COMPONENT", `Component '${component.id}' is deprecated.`, `blocks[${index}].type`);
        (allowDeprecated ? warnings : errors).push(target);
      }
      if (block?.variant != null && !component.variants.includes(block.variant)) {
        errors.push(issue("UNSUPPORTED_VARIANT", `Variant '${block.variant}' is not supported by '${component.id}'.`, `blocks[${index}].variant`));
      }
    });
    return { valid: errors.length === 0, errors, warnings, contract: snapshotSummary(active) };
  }

  validatePagePayload(payload, { existingPage = false } = {}) {
    const active = this.active;
    if (!active) return invalid("NO_VALID_FRONTEND_CONTRACT", "No Last Known Good Frontend Contract is available; component-aware publishing is blocked.");
    const blocks = Array.isArray(payload?.blocks) ? payload.blocks : null;
    const errors = [];
    const warnings = [];
    if (!blocks) errors.push(issue("MISSING_PAGE_BLOCKS", "Page payload must contain a blocks array in final render order.", "blocks"));
    for (const [index, block] of (blocks || []).entries()) {
      const component = active.componentsById.get(block?.type);
      if (!component) {
        errors.push(issue("UNKNOWN_COMPONENT", `blocks[${index}].type '${block?.type || ""}' is not in the current Frontend Registry.`, `blocks[${index}].type`));
        continue;
      }
      if (component.status === "deprecated") {
        const deprecated = issue("DEPRECATED_COMPONENT", `Component '${component.id}' is deprecated; retain it only for historical compatibility.`, `blocks[${index}].type`);
        (existingPage ? warnings : errors).push(deprecated);
      }
      if (block?.variant != null && !component.variants.includes(block.variant)) {
        errors.push(issue("UNSUPPORTED_VARIANT", `Variant '${block.variant}' is not supported by '${component.id}'.`, `blocks[${index}].variant`));
      }
      const dataErrors = validateJsonSchema(block?.data, component.schema, { root: component.schema, path: `blocks[${index}].data` });
      errors.push(...dataErrors.map((entry) => ({ ...entry, code: entry.code || "INVALID_COMPONENT_DATA" })));
    }
    const pageErrors = validateJsonSchema(payload, active.pageSchema.schema, { root: active.pageSchema.schema, path: "$" });
    errors.push(...pageErrors.map((entry) => ({ ...entry, code: entry.code || "INVALID_PAGE_SCHEMA" })));
    return { valid: errors.length === 0, errors, warnings, contract: snapshotSummary(active), existingPage };
  }

  compatibilityReport() {
    const active = this.active;
    const pages = this.repository.listFrontendPageCompositions();
    if (!active) return { status: "NO_VALID_FRONTEND_CONTRACT", pages: [], summary: { checked: 0, compatible: 0, incompatible: 0 } };
    const results = pages.map((page) => {
      const validation = this.validatePagePayload(page.payload, { existingPage: true });
      return {
        draftId: page.draft_id, title: page.title, generatedContractVersion: page.contract_version,
        generatedSchemaVersion: page.schema_version, current: validation,
      };
    });
    return {
      status: "OK", contract: snapshotSummary(active), pages: results,
      summary: { checked: results.length, compatible: results.filter((item) => item.current.valid).length, incompatible: results.filter((item) => !item.current.valid).length },
    };
  }
}

export function normalizeRegistry(raw) {
  if (!isObject(raw) || !Array.isArray(raw.components)) throw new FrontendContractError("INVALID_COMPONENT_REGISTRY", "Component Registry must be an object with a components array.");
  const contractVersion = requiredVersion(raw.contractVersion, "contractVersion");
  const schemaVersion = requiredSchemaVersion(raw.schemaVersion, "schemaVersion");
  const components = raw.components.map(normalizeComponent);
  const duplicates = components.filter((item, index) => components.findIndex((candidate) => candidate.id === item.id) !== index).map((item) => item.id);
  if (duplicates.length) throw new FrontendContractError("DUPLICATE_COMPONENT_ID", `Component Registry has duplicate IDs: ${[...new Set(duplicates)].join(", ")}.`);
  return { raw, contractVersion, schemaVersion, frontendCommitSha: readCommit(raw), components };
}

export function normalizePageSchema(raw, fallbackVersion = "") {
  if (!isObject(raw)) throw new FrontendContractError("INVALID_PAGE_SCHEMA", "Page Schema must be a JSON object.");
  const schemaVersion = requiredSchemaVersion(raw.schemaVersion || fallbackVersion, "schemaVersion");
  const schema = isObject(raw.schema) ? raw.schema : raw;
  if (!isObject(schema) || !Object.keys(schema).length) throw new FrontendContractError("INVALID_PAGE_SCHEMA", "Page Schema must contain a non-empty JSON Schema object.");
  return { raw, schemaVersion, frontendCommitSha: readCommit(raw), schema };
}

function normalizeComponent(component) {
  if (!isObject(component) || !/^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(component.id || "")) {
    throw new FrontendContractError("INVALID_COMPONENT", "Each registry component requires a stable semantic id.");
  }
  const status = String(component.status || "").toLowerCase();
  if (!COMPONENT_STATUSES.has(status)) throw new FrontendContractError("INVALID_COMPONENT_STATUS", `Component '${component.id}' must declare a supported status.`);
  const schema = component.schema || component.inputSchema || component.input_schema || component.dataSchema || component.data_schema;
  if (!isObject(schema)) throw new FrontendContractError("MISSING_COMPONENT_SCHEMA", `Component '${component.id}' must publish its data schema.`);
  const variants = (Array.isArray(component.variants) ? component.variants : []).map((variant) => typeof variant === "string" ? variant : variant?.id || variant?.name).filter((value) => typeof value === "string" && value);
  return {
    id: component.id,
    category: String(component.category || "uncategorized"),
    purpose: String(component.purpose || ""),
    status,
    variants: [...new Set(variants)],
    schema,
    requiredFields: Array.isArray(schema.required) ? schema.required : [],
    optionalFields: Object.keys(schema.properties || {}).filter((key) => !(schema.required || []).includes(key)),
    deprecation: component.deprecation || component.deprecated || null,
  };
}

function editorialCapabilities(result) {
  return {
    ...result,
    components: (result.components || []).filter((component) => {
      const category = String(component.category || "").toLowerCase();
      return category !== "commercial" && category !== "affiliate" && !String(component.id || "").toLowerCase().startsWith("affiliate_");
    }),
  };
}

function hydrateSnapshot(snapshot) {
  const registry = normalizeRegistry(parseJson(snapshot.registry_json, "registry snapshot"));
  const pageSchema = normalizePageSchema(parseJson(snapshot.page_schema_json, "page schema snapshot"), registry.schemaVersion);
  const components = registry.components;
  return {
    ...snapshot,
    contractVersion: registry.contractVersion,
    schemaVersion: registry.schemaVersion,
    components,
    componentsById: new Map(components.map((component) => [component.id, component])),
    pageSchema,
  };
}

function snapshotSummary(snapshot) {
  return {
    id: snapshot.id, contractVersion: snapshot.contractVersion, schemaVersion: snapshot.schemaVersion,
    checksum: snapshot.checksum, frontendCommitSha: snapshot.frontend_commit_sha || null,
    syncedAt: snapshot.synced_at, sourceRepository: snapshot.source_repository,
  };
}

function diffContracts(previous, current) {
  const oldById = new Map(previous.components.map((item) => [item.id, item]));
  const newById = new Map(current.components.map((item) => [item.id, item]));
  const addedComponents = [...newById.keys()].filter((id) => !oldById.has(id));
  const removedComponents = [...oldById.keys()].filter((id) => !newById.has(id));
  const deprecatedComponents = [...newById.values()].filter((item) => oldById.has(item.id) && item.status === "deprecated" && oldById.get(item.id).status !== "deprecated").map((item) => item.id);
  const variantChanges = [];
  const schemaChanges = [];
  for (const [id, component] of newById) {
    const before = oldById.get(id);
    if (!before) continue;
    const added = component.variants.filter((item) => !before.variants.includes(item));
    const removed = before.variants.filter((item) => !component.variants.includes(item));
    if (added.length || removed.length) variantChanges.push({ id, added, removed });
    if (stableStringify(before.schema) !== stableStringify(component.schema)) schemaChanges.push(id);
  }
  return { addedComponents, removedComponents, deprecatedComponents, variantChanges, schemaChanges, pageSchemaChanged: stableStringify(previous.pageSchema.schema) !== stableStringify(current.pageSchema.schema) };
}

function emptyDiff() {
  return { addedComponents: [], removedComponents: [], deprecatedComponents: [], variantChanges: [], schemaChanges: [], pageSchemaChanged: false };
}

async function readJsonDocument(source, fetchImpl, timeoutMs = 15_000) {
  const location = String(source || "").trim();
  if (!location) throw new FrontendContractError("MISSING_CONTRACT_SOURCE", "A Frontend Contract source is missing.");
  let text;
  if (/^https:\/\//i.test(location)) {
    const response = await fetchImpl(location, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new FrontendContractError("CONTRACT_FETCH_FAILED", `Unable to fetch ${location} (${response.status}).`);
    const declaredLength = Number.parseInt(response.headers.get("content-length") || "", 10);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_CONTRACT_BYTES) throw new FrontendContractError("CONTRACT_TOO_LARGE", `Contract at ${location} exceeds ${MAX_CONTRACT_BYTES} bytes.`);
    text = await response.text();
  } else {
    const filename = location.startsWith("file:") ? fileURLToPath(location) : path.resolve(location);
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) throw new FrontendContractError("CONTRACT_SOURCE_NOT_FOUND", `Contract source does not exist: ${filename}`);
    if (fs.statSync(filename).size > MAX_CONTRACT_BYTES) throw new FrontendContractError("CONTRACT_TOO_LARGE", `Contract at ${filename} exceeds ${MAX_CONTRACT_BYTES} bytes.`);
    text = fs.readFileSync(filename, "utf8");
  }
  try { return JSON.parse(text); } catch { throw new FrontendContractError("INVALID_CONTRACT_JSON", `Contract source '${location}' is not valid JSON.`); }
}

function validateJsonSchema(value, schema, context) {
  const errors = [];
  const resolved = resolveSchema(schema, context.root);
  if (!isObject(resolved)) return [issue("INVALID_SCHEMA", "Schema is not an object.", context.path)];
  if (resolved.allOf) for (const child of resolved.allOf) errors.push(...validateJsonSchema(value, child, context));
  if (resolved.anyOf && !resolved.anyOf.some((child) => validateJsonSchema(value, child, context).length === 0)) errors.push(issue("INVALID_COMPONENT_DATA", "Value does not match any allowed schema.", context.path));
  if (resolved.oneOf && resolved.oneOf.filter((child) => validateJsonSchema(value, child, context).length === 0).length !== 1) errors.push(issue("INVALID_COMPONENT_DATA", "Value must match exactly one allowed schema.", context.path));
  if (resolved.not && validateJsonSchema(value, resolved.not, context).length === 0) errors.push(issue("INVALID_COMPONENT_DATA", "Value matches a prohibited schema.", context.path));
  if (resolved.const !== undefined && stableStringify(value) !== stableStringify(resolved.const)) errors.push(issue("INVALID_COMPONENT_DATA", "Value does not equal the required constant.", context.path));
  if (Array.isArray(resolved.enum) && !resolved.enum.some((item) => stableStringify(item) === stableStringify(value))) errors.push(issue("INVALID_COMPONENT_DATA", "Value is not one of the allowed values.", context.path));
  if (resolved.type && !matchesType(value, resolved.type)) errors.push(issue("INVALID_COMPONENT_DATA", `Expected ${Array.isArray(resolved.type) ? resolved.type.join(" or ") : resolved.type}.`, context.path));
  if (typeof value === "string") {
    if (resolved.minLength != null && value.length < resolved.minLength) errors.push(issue("INVALID_COMPONENT_DATA", `String is shorter than ${resolved.minLength}.`, context.path));
    if (resolved.maxLength != null && value.length > resolved.maxLength) errors.push(issue("INVALID_COMPONENT_DATA", `String is longer than ${resolved.maxLength}.`, context.path));
    if (resolved.pattern && !(new RegExp(resolved.pattern).test(value))) errors.push(issue("INVALID_COMPONENT_DATA", "String does not match the required pattern.", context.path));
  }
  if (typeof value === "number") {
    if (resolved.minimum != null && value < resolved.minimum) errors.push(issue("INVALID_COMPONENT_DATA", `Number is below ${resolved.minimum}.`, context.path));
    if (resolved.maximum != null && value > resolved.maximum) errors.push(issue("INVALID_COMPONENT_DATA", `Number is above ${resolved.maximum}.`, context.path));
  }
  if (Array.isArray(value)) {
    if (resolved.minItems != null && value.length < resolved.minItems) errors.push(issue("INVALID_COMPONENT_DATA", `Array has fewer than ${resolved.minItems} items.`, context.path));
    if (resolved.maxItems != null && value.length > resolved.maxItems) errors.push(issue("INVALID_COMPONENT_DATA", `Array has more than ${resolved.maxItems} items.`, context.path));
    if (resolved.items) value.forEach((item, index) => errors.push(...validateJsonSchema(item, resolved.items, { ...context, path: `${context.path}[${index}]` })));
  }
  if (isObject(value)) {
    for (const key of resolved.required || []) if (!(key in value)) errors.push(issue("MISSING_REQUIRED_FIELD", `Required field '${key}' is missing.`, `${context.path}.${key}`));
    const properties = resolved.properties || {};
    for (const [key, item] of Object.entries(value)) {
      if (properties[key]) errors.push(...validateJsonSchema(item, properties[key], { ...context, path: `${context.path}.${key}` }));
      else if (resolved.additionalProperties === false) errors.push(issue("INVALID_COMPONENT_DATA", `Undocumented field '${key}' is not allowed.`, `${context.path}.${key}`));
      else if (isObject(resolved.additionalProperties)) errors.push(...validateJsonSchema(item, resolved.additionalProperties, { ...context, path: `${context.path}.${key}` }));
    }
  }
  return errors;
}

function resolveSchema(schema, root) {
  if (!schema?.$ref) return schema;
  if (!schema.$ref.startsWith("#/")) return schema;
  return schema.$ref.slice(2).split("/").reduce((value, key) => value?.[key.replaceAll("~1", "/").replaceAll("~0", "~")], root);
}

function matchesType(value, type) {
  const types = Array.isArray(type) ? type : [type];
  return types.some((candidate) => (candidate === "null" && value === null)
    || (candidate === "array" && Array.isArray(value))
    || (candidate === "object" && isObject(value))
    || (candidate === "string" && typeof value === "string")
    || (candidate === "number" && typeof value === "number" && Number.isFinite(value))
    || (candidate === "integer" && Number.isInteger(value))
    || (candidate === "boolean" && typeof value === "boolean"));
}

function requiredVersion(value, field) {
  const version = String(value || "");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new FrontendContractError("INVALID_CONTRACT_VERSION", `${field} must use semantic versioning.`);
  return version;
}

function requiredSchemaVersion(value, field) {
  const version = String(value || "").trim();
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(version)) throw new FrontendContractError("INVALID_SCHEMA_VERSION", `${field} must be a safe schema-version identifier.`);
  return version;
}

function semverMajor(version) { return Number.parseInt(String(version).split(".", 1)[0], 10); }
function readCommit(value) { return value?.frontendCommitSha || value?.commitSha || value?.commit || value?.source?.commitSha || null; }
function parseJson(value, label) { try { return JSON.parse(value); } catch { throw new FrontendContractError("INVALID_CACHED_CONTRACT", `Stored ${label} JSON is invalid.`); } }
function capabilityRelevance(component, terms) { return [...terms].reduce((score, term) => score + tokenize(`${component.id} ${component.category} ${component.purpose}`).includes(term), 0); }
function tokenize(value) { return String(value || "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean); }
function issue(code, message, path) { return { code, message, path }; }
function invalid(code, message) { return { valid: false, errors: [issue(code, message, "$")], warnings: [], contract: null }; }
function isObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function stableStringify(value) { if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`; if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`; return JSON.stringify(value); }
