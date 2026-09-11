import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;
const EXTENSIONS = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
  "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
};

export class CaptureMediaUploadManager {
  constructor(config = {}) {
    this.temporaryRoot = path.resolve(config.uploadDir || "data/capture-media-uploads");
    this.storageRoot = path.resolve(config.storageDir || "data/source-uploads");
    this.maxBytes = Math.max(DEFAULT_CHUNK_BYTES, Number(config.maxBytes || 512 * 1024 * 1024));
    this.chunkBytes = Math.max(512 * 1024, Math.min(8 * 1024 * 1024, Number(config.chunkBytes || DEFAULT_CHUNK_BYTES)));
  }

  create(input = {}) {
    const size = Number(input.size);
    const sha256 = String(input.sha256 || "").toLowerCase();
    const kind = input.kind === "video" ? "video" : "image";
    const mimeType = normalizeMime(input.mimeType, kind);
    if (!Number.isSafeInteger(size) || size <= 0 || size > this.maxBytes) throw uploadError("MEDIA_TOO_LARGE", `Media must be between 1 byte and ${this.maxBytes} bytes.`, 413);
    if (!/^[a-f0-9]{64}$/u.test(sha256)) throw uploadError("INVALID_MEDIA_HASH", "A full SHA-256 digest is required.", 400);
    if (!mimeType) throw uploadError("UNSUPPORTED_MEDIA_TYPE", "Only supported image and video originals can be persisted.", 400);
    const uploadId = crypto.randomUUID();
    const directory = this.directory(uploadId);
    fs.mkdirSync(directory, { recursive: true });
    const metadata = { uploadId, size, sha256, kind, mimeType, chunkBytes: this.chunkBytes,
      chunkCount: Math.ceil(size / this.chunkBytes), createdAt: new Date().toISOString() };
    fs.writeFileSync(path.join(directory, "upload.json"), JSON.stringify(metadata), { flag: "wx" });
    return { uploadId, chunkBytes: metadata.chunkBytes, chunkCount: metadata.chunkCount };
  }

  writeChunk(uploadId, index, value) {
    const metadata = this.read(uploadId);
    const chunkIndex = Number(index);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= metadata.chunkCount) throw uploadError("INVALID_MEDIA_CHUNK", "Media chunk index is invalid.", 400);
    const bytes = Buffer.from(value || []);
    const expected = chunkIndex === metadata.chunkCount - 1 ? metadata.size - chunkIndex * metadata.chunkBytes : metadata.chunkBytes;
    if (bytes.length !== expected) throw uploadError("INVALID_MEDIA_CHUNK_SIZE", `Media chunk ${chunkIndex} has ${bytes.length} bytes; expected ${expected}.`, 400);
    fs.writeFileSync(path.join(this.directory(uploadId), `${String(chunkIndex).padStart(6, "0")}.part`), bytes, { flag: "w" });
    return { uploadId, index: chunkIndex, receivedBytes: bytes.length, chunkCount: metadata.chunkCount };
  }

  complete(uploadId) {
    const metadata = this.read(uploadId);
    const directory = this.directory(uploadId);
    const relative = path.join("media", metadata.sha256.slice(0, 2), `${metadata.sha256}${EXTENSIONS[metadata.mimeType]}`);
    const target = safeResolve(this.storageRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${uploadId}.part`;
    const output = fs.openSync(temporary, "wx");
    const digest = crypto.createHash("sha256");
    let total = 0;
    try {
      for (let index = 0; index < metadata.chunkCount; index += 1) {
        const filename = path.join(directory, `${String(index).padStart(6, "0")}.part`);
        if (!fs.existsSync(filename)) throw uploadError("MEDIA_UPLOAD_INCOMPLETE", `Media chunk ${index} is missing.`, 409);
        const bytes = fs.readFileSync(filename);
        fs.writeSync(output, bytes); digest.update(bytes); total += bytes.length;
      }
    } catch (error) {
      fs.closeSync(output);
      fs.rmSync(temporary, { force: true });
      throw error;
    }
    fs.closeSync(output);
    const actualHash = digest.digest("hex");
    if (total !== metadata.size || actualHash !== metadata.sha256 || !validSignature(temporary, metadata.kind, metadata.mimeType)) {
      fs.rmSync(temporary, { force: true });
      throw uploadError("MEDIA_HASH_MISMATCH", "Media bytes, signature, size, or SHA-256 did not match the declared manifest.", 400);
    }
    if (!fs.existsSync(target)) fs.renameSync(temporary, target);
    else fs.rmSync(temporary, { force: true });
    fs.rmSync(directory, { recursive: true, force: true });
    return { storageRef: relative.replaceAll("\\", "/"), sha256: actualHash, sizeBytes: total,
      mimeType: metadata.mimeType, kind: metadata.kind };
  }

  directory(uploadId) {
    const value = String(uploadId || "");
    if (!/^[0-9a-f-]{36}$/iu.test(value)) throw uploadError("INVALID_MEDIA_UPLOAD_ID", "Media upload ID is invalid.", 400);
    return safeResolve(this.temporaryRoot, value);
  }

  read(uploadId) {
    const filename = path.join(this.directory(uploadId), "upload.json");
    if (!fs.existsSync(filename)) throw uploadError("MEDIA_UPLOAD_NOT_FOUND", "Media upload session was not found.", 404);
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  }
}

function normalizeMime(value, kind) {
  const mime = String(value || "").toLowerCase().split(";")[0].trim();
  if (kind === "image" && /^image\/(?:jpeg|png|webp|gif)$/u.test(mime)) return mime;
  if (kind === "video" && /^video\/(?:mp4|webm|quicktime)$/u.test(mime)) return mime;
  return "";
}

function validSignature(filename, kind, mimeType) {
  const fd = fs.openSync(filename, "r");
  const bytes = Buffer.alloc(32);
  let length = 0;
  try { length = fs.readSync(fd, bytes, 0, bytes.length, 0); } finally { fs.closeSync(fd); }
  const head = bytes.subarray(0, length);
  if (kind === "image") {
    if (mimeType === "image/jpeg") return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    if (mimeType === "image/png") return head.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
    if (mimeType === "image/webp") return head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP";
    return /^GIF8[79]a$/u.test(head.subarray(0, 6).toString("ascii"));
  }
  if (mimeType === "video/webm") return head.subarray(0, 4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
  return head.subarray(4, 12).toString("ascii").includes("ftyp");
}

function safeResolve(root, value) {
  const resolved = path.resolve(root, value);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw uploadError("INVALID_MEDIA_PATH", "Media path escapes its configured storage root.", 400);
  return resolved;
}

function uploadError(code, message, statusCode) {
  const error = new Error(message); error.code = code; error.statusCode = statusCode; return error;
}
