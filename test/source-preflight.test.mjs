import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeXiaohongshuCapture, ValidationError } from "../src/adapters/xiaohongshu.mjs";
import { ManualSourceIngestor } from "../src/adapters/manual-source.mjs";
import { Pipeline } from "../src/pipeline.mjs";
import { estimateSourceProcessing } from "../src/source-preflight.mjs";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";

test("short Xiaohongshu text with complete image evidence follows the media path", (t) => {
  const { repository } = repositoryFixture(t);
  const capture = normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/short-media-note",
    title: "Map screenshot",
    text: "路线图",
    images: [{ url: "https://sns-img.xhscdn.com/route.jpg", alt: "Metro exit and walking route" }],
    completeness: { images: { expected: 1, captured: 1, complete: true, traversed: true } },
  });
  const saved = repository.saveCapture(capture);
  const segments = repository.prepareSourceSegments(saved.id);
  assert.equal(segments.some((segment) => segment.segmentType === "image" && segment.assetId), true);
  assert.throws(() => normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/empty-note", text: "太短", images: [],
  }), ValidationError);
});

test("mixed PDF keeps selectable text and visual page locators without automatic OCR", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-pdf-preflight-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ingestor = new ManualSourceIngestor({ uploadDir: directory }, {
    extractPdfImpl: async () => ({ pages: [
      { pageNumber: 1, text: "Page one contains ticket and reservation guidance for the confirmed attraction.", hasVisualContent: false },
      { pageNumber: 2, text: "", hasVisualContent: true },
      { pageNumber: 3, text: "Page three contains the current opening schedule and visitor conditions.", hasVisualContent: true },
    ] }),
  });
  const prepared = await ingestor.prepare({ kind: "pdf", files: [{ name: "mixed.pdf", mimeType: "application/pdf",
    base64: Buffer.from("%PDF-1.7 mixed fixture").toString("base64") }] });
  assert.deepEqual(prepared.capture.submissionMetadata.pdf, {
    pageCount: 3, textPages: [1, 3], visualPages: [2, 3], extractionMode: "embedded_text_and_visual_inventory",
  });
  assert.equal(prepared.capture.assets.length, 1);
  assert.equal(prepared.capture.assets[0].mimeType, "application/pdf");

  const { repository } = repositoryFixture(t);
  const saved = repository.saveCapture(prepared.capture);
  const segments = repository.prepareSourceSegments(saved.id);
  assert.equal(segments.some((segment) => segment.segmentType === "pdf_page_group" && segment.pageStart === 1), true);
  const visual = segments.find((segment) => segment.segmentType === "pdf_page");
  assert.deepEqual({ pageStart: visual.pageStart, pageEnd: visual.pageEnd, imageIndex: visual.imageIndex },
    { pageStart: 2, pageEnd: 3, imageIndex: null });
  assert.match(visual.rawText, /pages 2, 3/);
});

test("unprocessable local PDF is blocked before any model extraction call", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-bad-pdf-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { repository } = repositoryFixture(t);
  const missing = path.join(directory, "missing.pdf");
  const capture = {
    adapter: "manual", externalId: "missing-pdf", canonicalUrl: "manual-source://missing-pdf", sourceKind: "pdf",
    title: "Missing PDF", authorName: "", authorUrl: "", publishedAt: null, capturedAt: new Date().toISOString(),
    rawText: "PDF visual evidence is preserved for page 1. No embedded text was available.", rawHtml: "", completeness: { overall: "complete" },
    submissionMetadata: { pdf: { pageCount: 1, textPages: [], visualPages: [1] } }, files: [],
    assets: [{ kind: "image", url: "manual-asset://missing-pdf/pdf-visual", alt: "PDF page 1", position: 0,
      localPath: missing, mimeType: "application/pdf", originalFilename: "missing.pdf", provenance: { documentKind: "pdf", pdfPages: [1] } }],
  };
  const saved = repository.saveCapture(capture);
  let modelCalls = 0;
  const extractor = { config: { provider: "vertex", sourceUploadsDir: directory },
    async extract() { modelCalls += 1; throw new Error("must not run"); } };
  const pipeline = new Pipeline(repository, extractor);
  assert.equal(await pipeline.runOne(), true);
  assert.equal(await pipeline.runOne(), false);
  assert.equal(modelCalls, 0);
  const source = repository.getSource(saved.id);
  assert.equal(source.status, "exception");
  assert.match(source.last_error, /SOURCE_ASSET_UNAVAILABLE/);
  assert.equal(JSON.parse(source.diagnostic_json).preflight.ready, false);
});

test("duplicates and heavy captures are auto-scheduled without a manual-start gate", (t) => {
  const { db, repository } = repositoryFixture(t);
  const images = Array.from({ length: 25 }, (_, index) => ({ url: `https://sns-img.xhscdn.com/high-${index}.jpg`, alt: `evidence ${index}` }));
  const capture = normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/high-cost-note", title: "Large confirmed source",
    text: "A manually confirmed source with a large but technically measurable media set.", images,
  });
  const estimate = estimateSourceProcessing(capture);
  assert.equal(estimate.requiresManualStart, false);
  assert.equal(estimate.processingClass, "heavy");
  assert.equal(estimate.estimatedExtractionCalls, 6);
  const first = repository.saveCapture(capture);
  const duplicate = repository.saveCapture(capture);
  assert.equal(first.requiresManualStart, false);
  assert.equal(first.queued, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM jobs WHERE type='repair_media_asset'").get().count,25);
});

test("18, 19 and 27 images never pause solely because of estimated model calls", () => {
  for (const count of [18,19,27]) {
    const estimate=estimateSourceProcessing({rawText:"One paragraph of source text.",assets:Array.from({length:count},(_,index)=>({kind:"image",url:`https://example.com/${index}.jpg`}))});
    assert.equal(estimate.blocked,false);
    assert.equal(estimate.requiresManualStart,false);
    assert.ok(["normal","heavy"].includes(estimate.processingClass));
  }
});

test("only an explicit technical hard limit blocks processing", () => {
  const estimate=estimateSourceProcessing({rawText:"Evidence",files:[{sizeBytes:513*1024*1024}],assets:[]});
  assert.equal(estimate.processingClass,"blocked_hard_limit");
  assert.equal(estimate.blocked,true);
  assert.equal(estimate.requiresManualStart,false);
});
