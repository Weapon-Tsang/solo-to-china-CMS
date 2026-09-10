import assert from "node:assert/strict";
import test from "node:test";
import { checkServiceBoundaries } from "../scripts/check-service-boundaries.mjs";

test("Research and Knowledge dependency graph cannot import Commercial", () => {
  const result = checkServiceBoundaries();
  assert.equal(result.valid, true, JSON.stringify(result.failures));
  assert.deepEqual(result.boundaries.sort(), ["commercial", "editorial", "job_batch", "knowledge", "publishing", "source_evidence", "statistics"]);
  assert.ok(result.checkedFiles > 5);
});
