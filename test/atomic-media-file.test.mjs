import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publishMediaBytes } from "../src/atomic-media-file.mjs";

test("media bytes become visible only after the final filename is linked", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solo-to-china-atomic-media-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, "media", "source.jpg");
  const bytes = Buffer.from("complete media bytes");
  const originalLink = fs.linkSync;
  fs.linkSync = (temporary, target) => {
    assert.equal(target, filename);
    assert.equal(fs.existsSync(filename), false);
    assert.deepEqual(fs.readFileSync(temporary), bytes);
    return originalLink(temporary, target);
  };
  try { assert.equal(publishMediaBytes(filename, bytes), true); }
  finally { fs.linkSync = originalLink; }
  assert.deepEqual(fs.readFileSync(filename), bytes);
  assert.equal(publishMediaBytes(filename, bytes), false);
  assert.throws(() => publishMediaBytes(filename, Buffer.from("different bytes")),
    (error) => error.code === "MEDIA_FILE_CONFLICT");
  assert.deepEqual(fs.readdirSync(path.dirname(filename)), ["source.jpg"]);
});
