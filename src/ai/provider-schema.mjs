const OPENAPI_SCHEMA_FIELDS = new Set([
  "type", "nullable", "required", "format", "description", "properties", "items", "enum", "anyOf", "$ref", "$defs",
  "title", "default", "minimum", "maximum", "propertyOrdering",
]);

// The current Vertex Gemini global endpoint rejects responseSchema requests that
// contain minItems/maxItems even though those bounds remain useful to our local
// JSON Schema validator. Keep them in the canonical contract and omit them only
// from the provider transport; post-response validation still enforces them.

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

export function providerTransportError(provider, error) {
  if (error?.provider && error?.code) return error;
  const timedOut = ["AbortError", "TimeoutError"].includes(String(error?.name || ""));
  const wrapped = new Error(`${provider} ${timedOut ? "request timed out" : "transport failed"}: ${String(error?.message || error || "network request failed")}`,
    { cause: error });
  wrapped.name = "ProviderTransportError";
  wrapped.code = timedOut ? "PROVIDER_TIMEOUT" : "PROVIDER_TRANSPORT_FAILED";
  wrapped.provider = provider;
  wrapped.retryable = true;
  return wrapped;
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

export function vertexStructuredOutput(schema, mode = "json_schema") {
  if (mode === "prompt_only") return {};
  if (mode === "openapi") return { responseSchema: adaptOpenApiSchema(schema) };
  return { responseJsonSchema: schema };
}

// OpenAI strict Structured Outputs requires closed objects and every property
// to be required. Canonical CMS contracts deliberately contain optional and
// open metadata objects, so the wire contract encodes those open objects as a
// JSON string and restores them before canonical validation. This keeps one
// business schema without silently dropping media-region metadata.
export function openAiWireSchema(schema) {
  return strictProjection(schema);
}

export function decodeOpenAiWire(value, canonicalSchema) {
  return decodeProjection(value, canonicalSchema);
}

export function providerReasoningOptions(provider, level = "LOW") {
  const normalized = String(level || "LOW").toUpperCase();
  if (provider === "deepseek") {
    if (["NONE", "DISABLED"].includes(normalized)) return { thinking: { type: "disabled" } };
    const effort = normalized === "MAX" ? "max" : normalized === "HIGH" ? "high" : "low";
    return { thinking: { type: "enabled" }, reasoning_effort: effort };
  }
  if (provider === "openai") {
    const effort = ["NONE", "DISABLED"].includes(normalized) ? "none"
      : normalized === "MAX" ? "max" : normalized === "HIGH" ? "high" : "low";
    return { reasoning: { effort } };
  }
  if (provider === "vertex") {
    if (normalized === "MINIMAL") throw Object.assign(new Error("Gemini 3.8 Flash does not accept MINIMAL thinking."), {
      code: "UNSUPPORTED_REASONING_LEVEL", retryable: false,
    });
    if (!["LOW", "MEDIUM", "HIGH"].includes(normalized)) throw Object.assign(new Error(`Unsupported Vertex thinking level: ${normalized}.`), {
      code: "UNSUPPORTED_REASONING_LEVEL", retryable: false,
    });
    return { thinkingConfig: { thinkingLevel: normalized } };
  }
  throw Object.assign(new Error(`Unknown AI provider: ${provider || "empty"}.`), {
    code: "UNKNOWN_AI_PROVIDER", retryable: false,
  });
}

function strictProjection(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(strictProjection);
  const schemaTypes=Array.isArray(schema.type)?schema.type:[schema.type].filter(Boolean);
  if ((schemaTypes.includes("object") || schema.properties) && schema.additionalProperties === true) {
    return { type: schemaTypes.includes("null") ? ["string","null"] : "string",
      description: `${schema.description || "Open metadata object"} Return this value as compact JSON text.` };
  }
  const projected = { ...schema };
  delete projected.default;
  if (projected.properties) {
    projected.type = "object";
    projected.additionalProperties = false;
    projected.properties = Object.fromEntries(Object.entries(projected.properties)
      .map(([key, child]) => [key, strictProjection(makeNullableIfOptional(child, (schema.required || []).includes(key)))]));
    projected.required = Object.keys(projected.properties);
  }
  if (projected.items) projected.items = strictProjection(projected.items);
  for (const key of ["anyOf", "oneOf", "allOf"]) if (projected[key]) projected[key] = projected[key].map(strictProjection);
  if (projected.$defs) projected.$defs = Object.fromEntries(Object.entries(projected.$defs).map(([key, child]) => [key, strictProjection(child)]));
  return projected;
}

function makeNullableIfOptional(schema, required) {
  if (required || !schema || typeof schema !== "object") return schema;
  if (schema.$ref) return { anyOf: [schema, { type: "null" }] };
  if (Array.isArray(schema.type)) return { ...schema, type: [...new Set([...schema.type, "null"])] };
  if (schema.type) return { ...schema, type: [schema.type, "null"] };
  return { anyOf: [schema, { type: "null" }] };
}

function decodeProjection(value, schema) {
  if (value == null || !schema || typeof schema !== "object") return value;
  if ((schema.type === "object" || schema.properties) && schema.additionalProperties === true && typeof value === "string") {
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; }
    catch { return {}; }
  }
  if (Array.isArray(value) && schema.items) return value.map((item) => decodeProjection(item, schema.items));
  if (value && typeof value === "object" && !Array.isArray(value) && schema.properties) {
    const required = new Set(schema.required || []);
    return Object.fromEntries(Object.entries(value)
      .filter(([key, child]) => child != null || required.has(key))
      .map(([key, child]) => [key, decodeProjection(child, schema.properties[key])]));
  }
  return value;
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
