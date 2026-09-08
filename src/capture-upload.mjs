import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_CHUNK_BYTES = 2 * 1024 * 1024;

export class CaptureUploadManager {
  constructor(config = {}) {
    this.root = path.resolve(config.uploadDir || "data/capture-uploads");
    this.maxBytes = Math.max(DEFAULT_CHUNK_BYTES, Number(config.maxBytes || 128 * 1024 * 1024));
    this.chunkBytes = Math.max(256 * 1024, Math.min(5 * 1024 * 1024, Number(config.chunkBytes || DEFAULT_CHUNK_BYTES)));
    this.maxAgeMs = Math.max(60_000, Number(config.maxAgeMs || 24 * 60 * 60 * 1000));
  }

  create({ size, sha256 }) {
    this.cleanupExpired();
    const bytes = Number(size);
    const expectedSha256 = String(sha256 || "").toLowerCase();
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > this.maxBytes) throw uploadError("CAPTURE_TOO_LARGE", `Capture payload must be between 1 byte and ${this.maxBytes} bytes.`, 413);
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw uploadError("INVALID_CAPTURE_HASH", "A full SHA-256 digest is required.", 400);
    const uploadId = crypto.randomUUID();
    const directory = this.directory(uploadId);
    fs.mkdirSync(directory, { recursive: true });
    const metadata = { uploadId, size: bytes, sha256: expectedSha256, chunkBytes: this.chunkBytes,
      chunkCount: Math.ceil(bytes / this.chunkBytes), createdAt: new Date().toISOString() };
    fs.writeFileSync(path.join(directory, "upload.json"), JSON.stringify(metadata), { flag: "wx" });
    return { uploadId, chunkBytes: metadata.chunkBytes, chunkCount: metadata.chunkCount };
  }

  writeChunk(uploadId, index, value) {
    const metadata = this.read(uploadId);
    const chunkIndex = Number(index);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= metadata.chunkCount) throw uploadError("INVALID_CHUNK", "Capture chunk index is invalid.", 400);
    const bytes = Buffer.from(value || []);
    const expected = chunkIndex === metadata.chunkCount - 1 ? metadata.size - chunkIndex * metadata.chunkBytes : metadata.chunkBytes;
    if (bytes.length !== expected) throw uploadError("INVALID_CHUNK_SIZE", `Capture chunk ${chunkIndex} has ${bytes.length} bytes; expected ${expected}.`, 400);
    fs.writeFileSync(path.join(this.directory(uploadId), `${String(chunkIndex).padStart(6, "0")}.part`), bytes, { flag: "w" });
    return { uploadId, index: chunkIndex, receivedBytes: bytes.length, chunkCount: metadata.chunkCount };
  }

  complete(uploadId) {
    const metadata = this.read(uploadId);
    const directory = this.directory(uploadId);
    const hash = crypto.createHash("sha256");
    const buffers = [];
    let total = 0;
    for (let index = 0; index < metadata.chunkCount; index += 1) {
      const filename = path.join(directory, `${String(index).padStart(6, "0")}.part`);
      if (!fs.existsSync(filename)) throw uploadError("UPLOAD_INCOMPLETE", `Capture chunk ${index} is missing.`, 409);
      const bytes = fs.readFileSync(filename);
      buffers.push(bytes); hash.update(bytes); total += bytes.length;
    }
    if (total !== metadata.size || hash.digest("hex") !== metadata.sha256) throw uploadError("CAPTURE_HASH_MISMATCH", "Capture payload size or SHA-256 digest did not match the declared manifest.", 400);
    let payload;
    try { payload = JSON.parse(Buffer.concat(buffers, total).toString("utf8")); }
    catch { throw uploadError("INVALID_CAPTURE_JSON", "Assembled capture payload is not valid JSON.", 400); }
    return { payload, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
  }

  directory(uploadId) {
    const id = String(uploadId || "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw uploadError("INVALID_UPLOAD_ID", "Capture upload ID is invalid.", 400);
    return path.join(this.root, id);
  }

  read(uploadId) {
    const filename = path.join(this.directory(uploadId), "upload.json");
    if (!fs.existsSync(filename)) throw uploadError("UPLOAD_NOT_FOUND", "Capture upload session was not found or has expired.", 404);
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  }

  cleanupExpired(now = Date.now()) {
    if (!fs.existsSync(this.root)) return 0;
    let removed = 0;
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
      const directory = path.join(this.root, entry.name);
      const metadataPath = path.join(directory, "upload.json");
      let timestamp = fs.statSync(directory).mtimeMs;
      try {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
        timestamp = Date.parse(metadata.createdAt) || timestamp;
      } catch { /* malformed abandoned sessions expire by directory mtime */ }
      if (now - timestamp > this.maxAgeMs) {
        fs.rmSync(directory, { recursive: true, force: true });
        removed += 1;
      }
    }
    return removed;
  }
}

function uploadError(code, message, statusCode) { const error = new Error(message); error.code = code; error.statusCode = statusCode; return error; }
