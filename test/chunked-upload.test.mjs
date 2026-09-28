import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ChunkedUploadManager } from "../src/chunked-upload.mjs";

test("legacy video chunks and final media publish complete bytes atomically", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solo-to-china-chunked-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = new ChunkedUploadManager({ uploadDir: root });
  const bytes = Buffer.from([0, 0, 0, 16, ...Buffer.from("ftypisom0000")]);
  const upload = manager.create({ name: "clip.mp4", mimeType: "video/mp4", size: bytes.length, kind: "video" });
  const chunk = path.join(manager.directory(upload.uploadId), "000000.part");
  const originalLink = fs.linkSync;
  fs.linkSync = (temporary, target) => {
    assert.equal(target, chunk);
    assert.equal(fs.existsSync(chunk), false);
    assert.deepEqual(fs.readFileSync(temporary), bytes);
    return originalLink(temporary, target);
  };
  try { manager.writeChunk(upload.uploadId, 0, bytes); }
  finally { fs.linkSync = originalLink; }
  manager.writeChunk(upload.uploadId, 0, bytes);
  assert.throws(() => manager.writeChunk(upload.uploadId, 0, Buffer.alloc(bytes.length)),
    (error) => error.code === "CHUNK_CONFLICT" && error.statusCode === 409);
  const originalRename = fs.renameSync;
  fs.renameSync = (temporary, target) => {
    assert.equal(path.extname(temporary), ".tmp");
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(fs.readFileSync(temporary), bytes);
    return originalRename(temporary, target);
  };
  let result;
  try { result = manager.complete(upload.uploadId); }
  finally { fs.renameSync = originalRename; }
  assert.deepEqual(fs.readFileSync(result.capture.files[0].storagePath), bytes);
  assert.equal(fs.existsSync(chunk), false);
});
