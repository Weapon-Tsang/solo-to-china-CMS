import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CaptureUploadManager } from "../src/capture-upload.mjs";

test("chunked capture upload assembles a multi-megabyte JSON payload without loss", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stc-capture-upload-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manager = new CaptureUploadManager({ uploadDir: directory, chunkBytes: 512 * 1024, maxBytes: 20 * 1024 * 1024 });
  const payload = { url: "https://www.xiaohongshu.com/explore/large", text: "尾".repeat(2_100_000), html: `<article>${"完整".repeat(900_000)}</article>` };
  const bytes = Buffer.from(JSON.stringify(payload));
  const manifest = manager.create({ size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
  for (let index = 0; index < manifest.chunkCount; index += 1) {
    const start = index * manifest.chunkBytes;
    manager.writeChunk(manifest.uploadId, index, bytes.subarray(start, Math.min(bytes.length, start + manifest.chunkBytes)));
  }
  const completed = manager.complete(manifest.uploadId);
  assert.equal(completed.payload.text.length, payload.text.length);
  assert.equal(completed.payload.text.at(-1), "尾");
  assert.equal(completed.payload.html.length, payload.html.length);
  completed.cleanup();
  assert.equal(fs.existsSync(path.join(directory, manifest.uploadId)), false);
});

test("chunked capture upload rejects an incomplete or hash-mismatched manifest", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stc-capture-upload-error-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manager = new CaptureUploadManager({ uploadDir: directory, chunkBytes: 256 * 1024 });
  const bytes = Buffer.alloc(300_000, 1);
  const manifest = manager.create({ size: bytes.length, sha256: "0".repeat(64) });
  manager.writeChunk(manifest.uploadId, 0, bytes.subarray(0, manifest.chunkBytes));
  assert.throws(() => manager.complete(manifest.uploadId), (error) => error.code === "UPLOAD_INCOMPLETE");
  manager.writeChunk(manifest.uploadId, 1, bytes.subarray(manifest.chunkBytes));
  assert.throws(() => manager.complete(manifest.uploadId), (error) => error.code === "CAPTURE_HASH_MISMATCH");
});

test("creating an upload removes abandoned sessions after the configured TTL", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stc-capture-upload-ttl-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manager = new CaptureUploadManager({ uploadDir: directory, maxAgeMs: 60_000 });
  const stale = manager.create({ size: 1, sha256: crypto.createHash("sha256").update("x").digest("hex") });
  const metadataPath = path.join(directory, stale.uploadId, "upload.json");
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  metadata.createdAt = new Date(Date.now() - 120_000).toISOString();
  fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  manager.create({ size: 1, sha256: crypto.createHash("sha256").update("y").digest("hex") });
  assert.equal(fs.existsSync(path.join(directory, stale.uploadId)), false);
});
