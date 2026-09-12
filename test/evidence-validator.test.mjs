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
  assert.equal(codes(validate(missingDate)).includes("VISIBLE_AS_OF_MISSING"), false);
  assert.equal(validate(missingDate).valid, true);

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

test("atomic blocks validate evidence only at an explicitly shared content-node boundary", () => {
  const heading = { type: "heading", variant: "section", data: { text: "Ticket plan", level: 2 } };
  const paragraph = { type: "paragraph", variant: "default", data: { content: "The Test Museum ticket costs CNY 50." } };
  const list = { type: "list", variant: "unordered", data: { items: ["Only on weekdays", "Checked September 7, 2026"] } };
  const contentPackage = packageFor(paragraph);
  const factual = contentPackage.frontend_page.validation.blockProvenance[0];
  contentPackage.frontend_page.validation.blockProvenance = [
    { ...factual, blockId: "block-heading", contentNodeId: "node-heading", factuality: "non_factual",
      claimKeys: [], sourceIds: [], claimTraces: [], blockSignature: pageBlockSignature(heading) },
    { ...factual, blockId: "block-paragraph", blockSignature: pageBlockSignature(paragraph) },
    { ...factual, blockId: "block-list", contentNodeId: factual.contentNodeId, blockSignature: pageBlockSignature(list) },
  ];
  const result = validatePageEvidence({ metadata: { title: "Guide" }, blocks: [heading, paragraph, list] }, contentPackage);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('current selected price excludes unselected historical evidence, and another node cannot mask a wrong price', () => {
  const block = { ...goodBlock, data: { body: 'The Test Museum ticket costs 60 CNY only on weekdays.' } };
  const pkg = packageFor(block);
  pkg.facts[0].preferred_value = 'CNY 60';
  pkg.facts[0].evidence = [
    { source_id: 'source-real', claim_id: 'claim-current', value: 'CNY 60', qualifiers: ['only on weekdays'] },
    { source_id: 'source-old', claim_id: 'claim-old', value: 'CNY 40', qualifiers: ['only on Sundays'] },
  ];
  pkg.frontend_page.validation.blockProvenance[0].claimTraces[0].claimId = 'claim-current';
  assert.equal(validatePageEvidence({ blocks: [block] }, pkg).valid, true);
  const wrong = { ...block, data: { body: 'The Test Museum ticket costs CNY 40 only on weekdays.' } };
  pkg.frontend_page.validation.blockProvenance.push({ ...pkg.frontend_page.validation.blockProvenance[0],
    contentNodeId: 'node_wrong', blockSignature: pageBlockSignature(wrong) });
  const result = validatePageEvidence({ blocks: [block, wrong] }, pkg);
  assert.ok(result.errors.some(x => x.code === 'EVIDENCE_VALUE_MISMATCH' && x.path === '$.blocks[1]'));
  assert.ok(!result.errors.some(x => x.path === '$.blocks[0]'));
});

test('explicit historical and conditional claims retain their own values and qualifiers', () => {
  const block = { ...goodBlock, data: { body: 'The Test Museum adult ticket costs ¥60; students pay CNY 30.' } };
  const pkg = packageFor(block);
  const fact = pkg.facts[0];
  fact.preferred_value = 'CNY 60';
  fact.evidence = [
    { claim_id: 'adult', source_id: 'source-real', value: 'CNY 60', qualifiers: ['adults'] },
    { claim_id: 'student', source_id: 'source-real', value: 'CNY 30', qualifiers: ['students'] },
  ];
  const entry = pkg.frontend_page.validation.blockProvenance[0];
  entry.claimTraces = fact.evidence.map(e => ({ claimKey: fact.normalized_key, claimId: e.claim_id, sourceId: e.source_id, evidenceRole: 'conditional' }));
  assert.equal(validatePageEvidence({ blocks: [block] }, pkg).valid, true);
  const swapped = { ...block, data: { body: 'The Test Museum adult ticket costs CNY 30; students pay CNY 60.' } };
  entry.blockSignature = pageBlockSignature(swapped);
  assert.equal(validatePageEvidence({ blocks: [swapped] }, pkg).valid, false);
  entry.claimTraces[1].claimId = 'forged';
  assert.ok(codes(validatePageEvidence({ blocks: [swapped] }, pkg)).includes('FORGED_CLAIM_REFERENCE'));
});

test("an empty ledger cannot support a factual page", () => {
  const contentPackage = packageFor(goodBlock);
  contentPackage.draft.evidence_ledger = [];
  assert.ok(codes(validatePageEvidence({ metadata: { title: "Guide" }, blocks: [goodBlock] }, contentPackage)).includes("EMPTY_FACTUAL_LEDGER"));
});

test('historical comparison keeps value and year paired; frozen block evidence survives live consensus changes', () => {
  const block={...goodBlock,data:{body:'The Test Museum ticket was CNY 40 in 2024; it is CNY 60 in 2026.'}};
  const pkg=packageFor(block),fact=pkg.facts[0],entry=pkg.frontend_page.validation.blockProvenance[0];
  fact.preferred_value='CNY 60';
  fact.evidence=[{claim_id:'old',source_id:'source-real',value:'CNY 40',qualifiers:['in 2024']},
    {claim_id:'current',source_id:'source-real',value:'CNY 60',qualifiers:['in 2026']}];
  entry.evidenceSnapshots=structuredClone([fact]);
  entry.claimTraces=fact.evidence.map(e=>({claimKey:fact.normalized_key,claimId:e.claim_id,sourceId:e.source_id,evidenceRole:e.claim_id==='old'?'historical':'current'}));
  fact.preferred_value='CNY 80';fact.evidence=[];
  assert.equal(validatePageEvidence({blocks:[block]},pkg).valid,true);
  const swapped={...block,data:{body:'The Test Museum ticket was CNY 60 in 2024; it is CNY 40 in 2026.'}};
  entry.blockSignature=pageBlockSignature(swapped);
  assert.ok(codes(validatePageEvidence({blocks:[swapped]},pkg)).includes('EVIDENCE_CONDITION_MISMATCH'));
});

test('equivalent clock and duration forms pass while lost negation and reversed ranges do not',()=>{
  const block={...goodBlock,data:{body:'Test Museum admission starts at 09:00; the visit takes 60 minutes. No entry after closing. Open 9 to 17.'}};
  const pkg=packageFor(block);pkg.facts[0].preferred_value='9:00 am; 1 hour; 9–17';pkg.facts[0].evidence=[{source_id:'source-real',qualifiers:['No entry after closing']}];
  assert.equal(validatePageEvidence({blocks:[block]},pkg).valid,true);
  const invalid={...block,data:{body:block.data.body.replace('No entry after closing','Entry after closing').replace('9 to 17','17 to 9')}};
  pkg.frontend_page.validation.blockProvenance[0].blockSignature=pageBlockSignature(invalid);
  assert.equal(validatePageEvidence({blocks:[invalid]},pkg).valid,false);
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
