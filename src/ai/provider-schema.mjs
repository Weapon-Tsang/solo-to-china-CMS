const OPENAPI_SCHEMA_FIELDS = new Set([
  "type", "nullable", "required", "format", "description", "properties", "items", "enum", "anyOf", "$ref", "$defs",
  "title", "default", "minimum", "maximum", "minItems", "maxItems", "propertyOrdering",
]);

export class ProviderRequestError extends Error {
  constructor(provider, status, message, details = {}) {
    super(`${provider} request failed (${status}): ${message}`);
    this.name = "ProviderRequestError";
    this.code = "PROVIDER_REQUEST_FAILED";
    this.provider = provider;
    this.status = status;
    this.details = details;
    this.retryable = status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
    this.retryAfterMs = parseRetryAfter(details?.retryAfter);
  }
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

export function vertexStructuredOutput(schema, mode = "json_schema") {
  if (mode === "openapi") return { responseSchema: adaptOpenApiSchema(schema) };
  return { responseJsonSchema: schema };
}

export function adaptOpenApiSchema(schema) {
  return adapt(schema, schema, new Set());
}

function adapt(schema, root, refStack) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return {};
  if (schema.$ref?.startsWith("#/")) {
    if (refStack.has(schema.$ref)) return {};
    const resolved = schema.$ref.slice(2).split("/").reduce((value, key) => value?.[decodePointer(key)], root);
    return adapt(resolved, root, new Set([...refStack, schema.$ref]));
  }
  const result = {};
  const types = Array.isArray(schema.type) ? schema.type : [schema.type].filter(Boolean);
  if (types.includes("null")) result.nullable = true;
  const concreteType = types.find((type) => type !== "null");
  if (concreteType) result.type = String(concreteType).toUpperCase();
  if (schema.const !== undefined && typeof schema.const === "string") result.enum = [schema.const];
  for (const [key, value] of Object.entries(schema)) {
    if (["type", "const", "$ref", "oneOf", "allOf", "not", "additionalProperties", "$schema", "$id"].includes(key)) continue;
    if (!OPENAPI_SCHEMA_FIELDS.has(key)) continue;
    if (key === "properties") {
      result.properties = Object.fromEntries(Object.entries(value || {}).map(([name, child]) => [name, adapt(child, root, refStack)]));
    } else if (key === "items") result.items = adapt(value, root, refStack);
    else if (key === "anyOf") result.anyOf = value.map((child) => adapt(child, root, refStack));
    else if (key === "$defs") result.$defs = Object.fromEntries(Object.entries(value || {}).map(([name, child]) => [name, adapt(child, root, refStack)]));
    else if (key === "enum") {
      const stringValues = value.filter((item) => typeof item === "string");
      if (stringValues.length === value.length) result.enum = stringValues;
    } else result[key] = value;
  }
  if (schema.oneOf) result.anyOf = schema.oneOf.map((child) => adapt(child, root, refStack));
  if (schema.allOf?.length === 1) Object.assign(result, adapt(schema.allOf[0], root, refStack), result);
  if (result.properties && !result.propertyOrdering) result.propertyOrdering = Object.keys(result.properties);
  return result;
}

function decodePointer(value) { return value.replaceAll("~1", "/").replaceAll("~0", "~"); }
