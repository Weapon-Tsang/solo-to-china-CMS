import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractPdfText, ManualSourceError, ManualSourceIngestor } from "../src/adapters/manual-source.mjs";
import { KimiClient } from "../src/ai/kimi-client.mjs";

function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-manual-source-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ingestor = new ManualSourceIngestor({ uploadDir: directory, maxImages: 2 }, {
    lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
    ...overrides,
  });
  return { directory, ingestor };
}

test("manual public-link submission extracts visible content and classifies WeChat", async (t) => {
  const { ingestor } = fixture(t, {
    fetchImpl: async () => new Response(`<!doctype html><html><head><title>重庆两日攻略</title><meta name="description" content="适合第一次到重庆的独立旅行者"></head><body><article><p>洪崖洞晚上亮灯，建议提前查看当天开放信息。</p><p>李子坝观景台可乘坐轨道交通二号线抵达。</p></article></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } }),
  });
  const prepared = await ingestor.prepare({ kind: "auto_url", url: "https://mp.weixin.qq.com/s/example" });
  assert.equal(prepared.capture.adapter, "manual");
  assert.equal(prepared.capture.sourceKind, "wechat_url");
  assert.equal(prepared.capture.submittedUrl, "https://mp.weixin.qq.com/s/example");
  assert.equal(prepared.capture.title, "重庆两日攻略");
  assert.match(prepared.capture.rawText, /洪崖洞晚上亮灯/);
  assert.match(prepared.capture.canonicalUrl, /^manual-source:\/\//);
});

test("manual link failures expose an actionable authentication code", async (t) => {
  const { ingestor } = fixture(t, { fetchImpl: async () => new Response("login", { status: 401 }) });
  await assert.rejects(
    () => ingestor.prepare({ kind: "web_url", url: "https://example.com/private" }),
    (error) => error instanceof ManualSourceError && error.code === "AUTH_REQUIRED" && error.statusCode === 422,
  );
});

test("public YouTube submissions stay usable as direct Vertex video evidence without scraping the watch page", async (t) => {
  let fetched = false;
  const { ingestor } = fixture(t, { fetchImpl: async () => { fetched = true; return new Response("unexpected"); } });
  const prepared = await ingestor.prepare({ kind: "video_url", url: "https://www.youtube.com/watch?v=public-fixture" });
  assert.equal(fetched, false);
  assert.equal(prepared.capture.sourceKind, "video_url");
  assert.match(prepared.capture.rawText, /画面与音频证据/);
  assert.match(prepared.warnings[0], /Vertex Gemini/);
});

test("manual link fetch blocks loopback and private network targets", async (t) => {
  let fetched = false;
  const { ingestor } = fixture(t, { fetchImpl: async () => { fetched = true; return new Response("unexpected"); } });
  await assert.rejects(
    () => ingestor.prepare({ kind: "web_url", url: "http://127.0.0.1/admin" }),
    (error) => error instanceof ManualSourceError && error.code === "PRIVATE_NETWORK_BLOCKED",
  );
  assert.equal(fetched, false);
});

test("manual image submission persists originals and supplies local multimodal assets", async (t) => {
  const { directory, ingestor } = fixture(t);
  const prepared = await ingestor.prepare({
    kind: "images",
    title: "重庆路线截图",
    files: [{ name: "route.png", mimeType: "image/png", base64: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fixture")]).toString("base64") }],
  });
  assert.equal(prepared.capture.assets.length, 1);
  assert.equal(prepared.capture.files.length, 1);
  assert.equal(prepared.capture.assets[0].mimeType, "image/png");
  assert.ok(fs.existsSync(prepared.capture.files[0].storagePath));
  assert.ok(prepared.capture.files[0].storagePath.startsWith(`${path.resolve(directory)}${path.sep}`));
  const client = new KimiClient({ apiKey: "fixture", sourceUploadsDir: directory, maxImages: 2 });
  const imageParts = await client.imageParts([{ local_path: prepared.capture.assets[0].localPath, mime_type: "image/png" }]);
  assert.equal(imageParts.parts.length, 1);
  assert.match(imageParts.parts[0].image_url.url, /^data:image\/png;base64,/);
  prepared.cleanup();
  assert.equal(fs.existsSync(path.dirname(prepared.capture.files[0].storagePath)), false);
});

test("manual video submission validates and persists one supported video as model evidence", async (t) => {
  const { directory, ingestor } = fixture(t);
  const videoBytes = Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp"), Buffer.from("isom0000fixture video bytes")]);
  const prepared = await ingestor.prepare({
    kind: "video",
    title: "Chongqing walking route",
    files: [{ name: "route.mp4", mimeType: "video/mp4", base64: videoBytes.toString("base64") }],
  });
  assert.equal(prepared.capture.sourceKind, "video");
  assert.equal(prepared.capture.assets[0].kind, "video");
  assert.equal(prepared.capture.assets[0].mimeType, "video/mp4");
  assert.equal(prepared.capture.files[0].fileKind, "video");
  assert.ok(fs.existsSync(prepared.capture.files[0].storagePath));
  assert.ok(prepared.capture.files[0].storagePath.startsWith(`${path.resolve(directory)}${path.sep}`));
});

test("manual video default accepts files above the former 12 MB limit", async (t) => {
  const { ingestor } = fixture(t);
  const videoBytes = Buffer.alloc(13 * 1024 * 1024);
  videoBytes.write("ftyp", 4, "ascii");
  const prepared = await ingestor.prepare({
    kind: "video",
    files: [{ name: "long-route.mp4", mimeType: "video/mp4", base64: videoBytes.toString("base64") }],
  });
  assert.equal(prepared.capture.files[0].sizeBytes, 13 * 1024 * 1024);
});

test("manual video submission rejects renamed non-video content", async (t) => {
  const { ingestor } = fixture(t);
  await assert.rejects(
    () => ingestor.prepare({ kind: "video", files: [{ name: "fake.mp4", mimeType: "video/mp4", base64: Buffer.from("not a video").toString("base64") }] }),
    (error) => error instanceof ManualSourceError && error.code === "INVALID_VIDEO_FILE",
  );
});

test("manual PDF and Word submissions feed extracted text into the same capture contract", async (t) => {
  const { ingestor } = fixture(t, {
    extractPdfImpl: async () => "重庆博物馆周二至周日开放，入馆前应查看官方预约规则。",
    extractWordImpl: async () => "成都地铁出行资料，包含面向第一次到访者的换乘说明。",
  });
  const pdfBytes = Buffer.from("%PDF-1.7 fixture");
  const pdf = await ingestor.prepare({ kind: "pdf", files: [{ name: "guide.pdf", mimeType: "application/pdf", base64: pdfBytes.toString("base64") }] });
  assert.equal(pdf.capture.sourceKind, "pdf");
  assert.match(pdf.capture.rawText, /重庆博物馆/);

  const docxBytes = Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.from("docx fixture")]);
  const word = await ingestor.prepare({ kind: "word", files: [{ name: "guide.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", base64: docxBytes.toString("base64") }] });
  assert.equal(word.capture.sourceKind, "word");
  assert.match(word.capture.rawText, /成都地铁/);
});

test("bundled PDF parser extracts selectable document text", async () => {
  const text = await extractPdfText(minimalPdf("Chongqing public transport guide"));
  assert.match(text, /Chongqing public transport guide/);
});

function minimalPdf(text) {
  const escaped = text.replace(/[()\\]/g, "\\$&");
  const stream = `BT /F1 12 Tf 50 100 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, "binary");
}
