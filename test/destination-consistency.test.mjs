import assert from "node:assert/strict";
import test from "node:test";
import { validatePlanningDestination } from "../src/destination-consistency.mjs";

test("planning blocks an explicit Chongqing topic assigned to a Beijing destination", () => {
  const result = validatePlanningDestination({
    candidate: {
      id: "topic-mixed", destination_slug: "beijing-palace-museum",
      proposed_title: "The Feasible 3-Day Chongqing Route: Pacing, Taxis, and Vertical Navigation",
    },
    source_reference: { title: "A practical 3-day Chongqing itinerary" },
  });
  assert.equal(result.valid, false);
  assert.equal(result.code, "DESTINATION_TOPIC_MISMATCH");
  assert.deepEqual(result.explicitDestinations, ["chongqing"]);
  assert.equal(result.assignedDestination, "beijing");
});

test("planning allows a matching destination and does not guess when no city is explicit", () => {
  assert.equal(validatePlanningDestination({ candidate: {
    destination_slug: "chongqing", proposed_title: "First-Time Chongqing Solo Travel Guide",
  } }).valid, true);
  assert.equal(validatePlanningDestination({ candidate: {
    destination_slug: "chongqing", proposed_title: "A Low-Effort Weekend Route",
  } }).valid, true);
});
