import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CHUNK_BYTES = 5 * 1024 * 1024;

export class ChunkedUploadManager {
  constructor(config = {}) {
    this.root = path.resolve(config.uploadDir || "data/source-uploads");
    this.maxVideoBytes = Number(config.maxVideoBytes || 256 * 1024 * 1024);
  }

  create({ name, mimeType, size, kind }) {
    const bytes = Number(size || 0);
    if (kind !== "video") throw uploadError("UNSUPPORTED_CHUNKED_KIND", "Chunked upload currently accepts video files.", 400);
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > this.maxVideoBytes) {
      throw uploadError("FILE_TOO_LARGE", `Video must be between 1 byte and ${Math.round(this.maxVideoBytes / 1024 / 1024)} MB.`, 413);
    }
    const uploadId = crypto.randomUUID();
    const directory = this.directory(uploadId);
    fs.mkdirSync(directory, { recursive: true });
    const metadata = { uploadId, name: safeName(name), mimeType: String(mimeType || "application/octet-stream"), size: bytes, kind, chunkBytes: CHUNK_BYTES, createdAt: new Date().toISOString() };
    fs.writeFileSync(path.join(directory, "upload.json"), JSON.stringify(metadata), { flag: "wx" });
    return { uploadId, chunkBytes: CHUNK_BYTES, chunkCount: Math.ceil(bytes / CHUNK_BYTES) };
  }

  writeChunk(uploadId, index, bytes) {
    const metadata = this.read(uploadId);
    const chunkIndex = Number(index);
    const expectedCount = Math.ceil(metadata.size / metadata.chunkBytes);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= expectedCount) throw uploadError("INVALID_CHUNK", "Chunk index is invalid.", 400);
    const body = Buffer.from(bytes || []);
    const expected = chunkIndex === expectedCount - 1 ? metadata.size - chunkIndex * metadata.chunkBytes : metadata.chunkBytes;
    if (body.length !== expected) throw uploadError("INVALID_CHUNK_SIZE", `Chunk ${chunkIndex + 1} has ${body.length} bytes; expected ${expected}.`, 400);
    fs.writeFileSync(path.join(this.directory(uploadId), `${String(chunkIndex).padStart(6, "0")}.part`), body, { flag: "w" });
    return { uploadId, index: chunkIndex, receivedBytes: body.length, chunkCount: expectedCount };
  }

  complete(uploadId, input = {}) {
    const metadata = this.read(uploadId);
    const directory = this.directory(uploadId);
    const count = Math.ceil(metadata.size / metadata.chunkBytes);
    const parts = Array.from({ length: count }, (_, index) => path.join(directory, `${String(index).padStart(6, "0")}.part`));
    if (parts.some((filename) => !fs.existsSync(filename))) throw uploadError("UPLOAD_INCOMPLETE", "One or more upload chunks are missing.", 409);
    const submissionId = crypto.randomUUID();
    const finalDirectory = path.join(this.root, submissionId);
    fs.mkdirSync(finalDirectory, { recursive: true });
    const extension = safeVideoExtension(metadata.name, metadata.mimeType);
    const storagePath = path.join(finalDirectory, `01-${crypto.randomUUID()}${extension}`);
    const output = fs.openSync(storagePath, "wx");
    try {
      for (const filename of parts) {
        const part = fs.readFileSync(filename);
        fs.writeSync(output, part);
      }
    } finally { fs.closeSync(output); }
    const stat = fs.statSync(storagePath);
    if (stat.size !== metadata.size) {
      fs.rmSync(finalDirectory, { recursive: true, force: true });
      throw uploadError("UPLOAD_SIZE_MISMATCH", "Completed upload size does not match the declared file size.", 400);
    }
    const signature = Buffer.alloc(16);
    const signatureFd = fs.openSync(storagePath, "r");
    let signatureBytes = 0;
    try { signatureBytes = fs.readSync(signatureFd, signature, 0, signature.length, 0); }
    finally { fs.closeSync(signatureFd); }
    if (!looksLikeVideo(signature.subarray(0, signatureBytes), extension)) {
      fs.rmSync(finalDirectory, { recursive: true, force: true });
      throw uploadError("INVALID_VIDEO_FILE", "Video signature does not match its filename. Convert the file to a supported video format and retry.", 400);
    }
    const sha = crypto.createHash("sha256");
    const fd = fs.openSync(storagePath, "r");
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let read;
      while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) sha.update(buffer.subarray(0, read));
    } finally { fs.closeSync(fd); }
    fs.rmSync(directory, { recursive: true, force: true });
    const title = String(input.title || metadata.name).slice(0, 1_000);
    const notes = String(input.notes || "");
    return {
      capture: {
        adapter: "manual", externalId: submissionId, canonicalUrl: `manual-source://${submissionId}`, submittedUrl: "", sourceKind: "video",
        submissionMetadata: { requestedKind: "video", warnings: [], operatorNotesProvided: Boolean(notes), chunkedUpload: true },
        title, authorName: "Manual submission", authorUrl: "", publishedAt: null, capturedAt: new Date().toISOString(),
        rawText: [notes, `Uploaded video evidence: ${metadata.name}. Analyze visible text, scenes, speech, and ambient audio.`].filter(Boolean).join("\n\n"), rawHtml: "",
        assets: [{ kind: "video", url: `manual-asset://${submissionId}/0`, alt: metadata.name, position: 0, localPath: storagePath, mimeType: metadata.mimeType, originalFilename: metadata.name }],
        files: [{ id: `source_file_${submissionId}_0`, fileKind: "video", originalFilename: metadata.name, mimeType: metadata.mimeType, storagePath, sizeBytes: stat.size, sha256: sha.digest("hex") }],
        client: { channel: "admin_chunked_submission" },
      },
      warnings: [],
      cleanup: () => fs.rmSync(finalDirectory, { recursive: true, force: true }),
    };
  }

  directory(uploadId) {
    const id = String(uploadId || "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw uploadError("INVALID_UPLOAD_ID", "Upload ID is invalid.", 400);
    return path.join(this.root, ".staging", id);
  }
  read(uploadId) {
    const filename = path.join(this.directory(uploadId), "upload.json");
    if (!fs.existsSync(filename)) throw uploadError("UPLOAD_NOT_FOUND", "Upload session was not found or has expired.", 404);
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  }
}

function safeName(value) { return path.basename(String(value || "video.mp4")).replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 180) || "video.mp4"; }
function safeVideoExtension(name, mime) {
  const extension = path.extname(name).toLowerCase();
  if ([".mp4", ".m4v", ".mov", ".mpeg", ".mpg", ".webm", ".avi", ".wmv", ".flv", ".3gp"].includes(extension)) return extension;
  return { "video/mp4": ".mp4", "video/quicktime": ".mov", "video/mpeg": ".mpeg", "video/webm": ".webm" }[mime] || ".mp4";
}
function looksLikeVideo(bytes, extension) {
  if ([".mp4", ".m4v", ".mov", ".3gp"].includes(extension)) return bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp";
  if (extension === ".webm") return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if ([".mpeg", ".mpg"].includes(extension)) return ["000001ba", "000001b3"].includes(bytes.subarray(0, 4).toString("hex"));
  if (extension === ".avi") return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "AVI ";
  if (extension === ".wmv") return bytes.subarray(0, 8).equals(Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11]));
  if (extension === ".flv") return bytes.subarray(0, 3).toString("ascii") === "FLV";
  return false;
}
function uploadError(code, message, statusCode) { const error = new Error(message); error.code = code; error.statusCode = statusCode; return error; }
