import assert from "node:assert/strict";
import test from "node:test";
import { pageBlockSignature, validatePageEvidence } from "../src/evidence-validator.mjs";
import { validateFinalPageArtifact } from "../src/publish-page.mjs";

const goodBlock = { type: "articleSection", variant: "answer-first", data: {
  heading: "Ticket plan", body: "The Test Museum ticket costs CNY 50 only on weekdays, as of September 7, 2026.",
} };

test("final evidence validation rejects missing answers, changed values, qualifiers, dates, and forged Sources", () => {
  assert.equal(validate(goodBlock).valid, true);

  const headingOnly = { ...goodBlock, data: { heading: "Ticket plan", body: "Plan before visiting." } };
  assert.ok(codes(validate(headingOnly)).includes("FACTUAL_ANSWER_MISSING"));

  const changedValue = { ...goodBlock, data: { ...goodBlock.data, body: goodBlock.data.body.replace("CNY 50", "CNY 500") } };
  assert.ok(codes(validate(changedValue)).includes("EVIDENCE_VALUE_MISMATCH"));

  const missingQualifier = { ...goodBlock, data: { ...goodBlock.data, body: goodBlock.data.body.replace("only on weekdays", "every day") } };
  assert.ok(codes(validate(missingQualifier)).includes("EVIDENCE_VALUE_MISMATCH"));

  const missingDate = { ...goodBlock, data: { ...goodBlock.data, body: goodBlock.data.body.replace(", as of September 7, 2026", "") } };
  assert.ok(codes(validate(missingDate)).includes("VISIBLE_AS_OF_MISSING"));

  const forged = packageFor(goodBlock);
  forged.frontend_page.validation.blockProvenance[0].claimTraces[0].sourceId = "source-forged";
  assert.ok(codes(validatePageEvidence({ metadata: { title: "Guide" }, blocks: [goodBlock] }, forged)).includes("FORGED_SOURCE_REFERENCE"));
});

test("layout variants and an explicitly non-factual image do not break evidence mapping", () => {
  const block = { ...goodBlock, variant: "compact" };
  const image = { type: "image", variant: "wide", data: { media_id: 7, alt: "Museum exterior" } };
  const contentPackage = packageFor(block);
  contentPackage.frontend_page.validation.blockProvenance.push({ blockId: "block_image", contentNodeId: "node_image",
    type: "image", semanticRole: "non_factual", factuality: "non_factual", sourceSectionIds: [], claimKeys: [], sourceIds: [], claimTraces: [],
    mappingStatus: "explicit_v2", blockSignature: pageBlockSignature(image) });
  const result = validatePageEvidence({ metadata: { title: "Guide" }, blocks: [image, block] }, contentPackage);
  assert.equal(result.valid, true);
});

test("an empty ledger cannot support a factual page", () => {
  const contentPackage = packageFor(goodBlock);
  contentPackage.draft.evidence_ledger = [];
  assert.ok(codes(validatePageEvidence({ metadata: { title: "Guide" }, blocks: [goodBlock] }, contentPackage)).includes("EMPTY_FACTUAL_LEDGER"));
});

test("the final artifact gate consumes the semantic evidence validator", () => {
  const page = { metadata: { title: "Guide" }, blocks: [goodBlock] };
  const contentPackage = packageFor(goodBlock);
  contentPackage.draft.title = "Guide";
  assert.equal(validateFinalPageArtifact(page, contentPackage).valid, true);
  page.blocks[0] = { ...goodBlock, data: { ...goodBlock.data, body: goodBlock.data.body.replace("CNY 50", "CNY 500") } };
  assert.ok(codes(validateFinalPageArtifact(page, contentPackage)).includes("BLOCK_PROVENANCE_MISSING"));
});

function validate(block) {
  return validatePageEvidence({ metadata: { title: "Guide" }, blocks: [block] }, packageFor(block));
}

function packageFor(block) {
  return {
    facts: [{ normalized_key: "museum.ticket.price", subject: "Test Museum", predicate: "ticket price",
      preferred_value: "CNY 50", freshness_state: "time_sensitive", latest_evidence_at: "2026-09-07T00:00:00.000Z",
      consensus_method: "RECENCY_WEIGHTED_CONSENSUS",
      evidence: [{ source_id: "source-real", qualifiers: ["only on weekdays"] }] }],
    draft: { evidence_ledger: [{ section_id: "section_ticket", section: "Ticket plan",
      content_node_ids: ["node_ticket"], claim_keys: ["museum.ticket.price"], source_ids: ["source-real"] }] },
    frontend_page: { validation: { blockProvenance: [{ blockId: "block_ticket", contentNodeId: "node_ticket",
      type: "articleSection", semanticRole: "factual", factuality: "factual", sourceSectionIds: ["section_ticket"],
      claimKeys: ["museum.ticket.price"], sourceIds: ["source-real"],
      claimTraces: [{ claimKey: "museum.ticket.price", claimId: "claim-real", sourceId: "source-real", evidenceSpanIds: ["span-real"] }],
      mappingStatus: "explicit_v2", blockSignature: pageBlockSignature(block) }] } },
  };
}

function codes(result) { return result.errors.map((item) => item.code); }
