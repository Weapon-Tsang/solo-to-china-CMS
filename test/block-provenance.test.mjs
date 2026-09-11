import assert from "node:assert/strict";
import test from "node:test";
import { buildBlockProvenance, pageBlockSignature } from "../src/repository.mjs";

test("stable node references survive decorative insertion, section splitting, and block reordering", () => {
  const hero = { type: "image", data: { media_id: 7, alt: "Decorative skyline" } };
  const booking = { type: "card", data: { heading: "Book ahead", body: "Reserve a timed entry." } };
  const transport = { type: "articleSection", data: { heading: "Getting there", body: "Use the metro." } };
  const payload = { blocks: [hero, transport, booking] };
  const ledger = [
    { section_id: "section_plan", section: "Plan", claim_keys: ["booking.rule", "transport.metro"], source_ids: ["model-invented"] },
  ];
  const explicit = { version: "2", valid: true, errors: [], entries: [
    { contentNodeId: "node_booking", blockSignature: pageBlockSignature(booking), sourceSectionIds: ["section_plan"], claimKeys: ["booking.rule"], factuality: "factual" },
    { contentNodeId: "node_hero", blockSignature: pageBlockSignature(hero), sourceSectionIds: [], claimKeys: [], factuality: "non_factual" },
    { contentNodeId: "node_transport", blockSignature: pageBlockSignature(transport), sourceSectionIds: ["section_plan"], claimKeys: ["transport.metro"], factuality: "factual" },
  ] };
  const sourceIds = new Map([["booking.rule", ["source-booking"]], ["transport.metro", ["source-metro"]]]);
  const traces = new Map([["booking.rule", [{ claimId: "claim-booking", sourceId: "source-booking", evidenceSpanIds: ["span-booking"] }]],
    ["transport.metro", [{ claimId: "claim-metro", sourceId: "source-metro", evidenceSpanIds: ["span-metro"] }]]]);
  const result = buildBlockProvenance(payload, ledger, explicit, sourceIds, traces);
  assert.equal(result.valid, true);
  assert.deepEqual(result.blocks.map((block) => block.contentNodeId), ["node_hero", "node_transport", "node_booking"]);
  assert.deepEqual(result.blocks[0].claimKeys, []);
  assert.equal(result.blocks[0].semanticRole, "non_factual");
  assert.deepEqual(result.blocks[1].sourceIds, ["source-metro"]);
  assert.deepEqual(result.blocks[2].sourceIds, ["source-booking"]);
  assert.deepEqual(result.blocks[2].claimTraces[0].evidenceSpanIds, ["span-booking"]);
  assert.equal(JSON.stringify(result).includes("model-invented"), false);
});

test("missing historical mappings remain explicitly legacy instead of inheriting ledger indexes", () => {
  const payload = { blocks: [
    { type: "image", data: { media_id: 1 } },
    { type: "articleSection", data: { heading: "Plan", body: "Use the metro." } },
  ] };
  const result = buildBlockProvenance(payload,
    [{ section_id: "section_plan", claim_keys: ["transport.metro"], source_ids: ["source-metro"] }], null,
    new Map([["transport.metro", ["source-metro"]]]));
  assert.equal(result.valid, false);
  assert.ok(result.blocks.every((block) => block.mappingStatus === "legacy_unknown" && block.claimKeys.length === 0));
});
