import assert from "node:assert/strict";
import test from "node:test";
import { adaptOpenApiSchema, ProviderRequestError, vertexStructuredOutput } from "../src/ai/provider-schema.mjs";

test("Vertex uses full JSON Schema mode and has a loss-aware OpenAPI fallback", () => {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object", additionalProperties: false, required: ["block"],
    properties: { block: { oneOf: [{ type: "string", const: "text" }, { type: ["integer", "null"], minimum: 1 }] } },
  };
  assert.equal(vertexStructuredOutput(schema).responseJsonSchema, schema);
  const adapted = adaptOpenApiSchema(schema);
  assert.equal(adapted.type, "OBJECT");
  assert.equal(adapted.additionalProperties, undefined);
  assert.deepEqual(adapted.properties.block.anyOf[0].enum, ["text"]);
  assert.equal(adapted.properties.block.anyOf[1].nullable, true);
});

test("provider errors classify permanent and transient HTTP failures", () => {
  assert.equal(new ProviderRequestError("Vertex", 400, "bad schema").retryable, false);
  assert.equal(new ProviderRequestError("Vertex", 429, "quota").retryable, true);
  assert.equal(new ProviderRequestError("Kimi", 503, "down").retryable, true);
});
