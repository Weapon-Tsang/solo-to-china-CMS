import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MIME_EXTENSIONS = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" };
const MEDIA_EXTENSIONS = { ...MIME_EXTENSIONS, "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov" };

export function persistCaptureAssets(capture, storageRoot) {
  if (!storageRoot || !Array.isArray(capture?.assets)) return capture;
  const root = path.resolve(storageRoot);
  fs.mkdirSync(root, { recursive: true });
  const assets = capture.assets.map((asset) => persistAsset(asset, root));
  return { ...capture, assets };
}

function persistAsset(asset, root) {
  if (asset.originalStorageRef) {
    const stored = storedOriginal(asset, root);
    if (stored) return stored;
  }
  const hasOriginalPayload = Boolean(asset.originalDataUrl);
  const encoded = String(asset.originalDataUrl || asset.aiDerivativeDataUrl || "");
  const match = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/u.exec(encoded);
  if (!match) return { ...asset, storageStatus: asset.localPath ? "saved" : "discovered", originalBytesStatus: asset.localPath ? "saved_unknown" : "missing" };
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return { ...asset, storageStatus: "pending", originalBytesStatus: "missing" };
  const actualMime = imageMime(bytes);
  if (!actualMime) return { ...asset, storageStatus: "pending", originalBytesStatus: "invalid" };
  const hash = createHash("sha256").update(bytes).digest("hex");
  const directory = path.join(root, hash.slice(0, 2));
  const filename = path.join(directory, `${hash}${MIME_EXTENSIONS[actualMime]}`);
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.existsSync(filename)) fs.writeFileSync(filename, bytes, { flag: "wx" });
  const originalBytes = hasOriginalPayload && Boolean(asset.originalSha256 && asset.originalSha256 === hash);
  return {
    ...asset,
    localPath: filename,
    mimeType: actualMime,
    storedSha256: hash,
    storedSizeBytes: bytes.length,
    storageStatus: "saved",
    originalBytesStatus: originalBytes ? "saved_original" : "saved_derivative",
    durabilityStatus: originalBytes ? "ORIGINAL_STORED" : "DERIVATIVE_ONLY",
    aiReadabilityStatus: "processable",
    repairStatus: originalBytes ? "not_needed" : "server_recovery_pending",
  };
}

function storedOriginal(asset, root) {
  const reference = String(asset.originalStorageRef || "");
  if (!/^media\/[a-f0-9]{2}\/[a-f0-9]{64}\.(?:jpg|png|webp|gif|mp4|webm|mov)$/iu.test(reference)) return null;
  const filename = path.resolve(root, ...reference.split("/"));
  if (!filename.startsWith(`${root}${path.sep}`) || !fs.existsSync(filename)) return null;
  const bytes = fs.readFileSync(filename);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (asset.originalSha256 && hash !== asset.originalSha256) return null;
  const mimeType = mediaMime(bytes, asset.kind, asset.mimeType);
  if (!mimeType) return null;
  return { ...asset, localPath: filename, mimeType, originalSha256: hash, storedSha256: hash,
    storedSizeBytes: bytes.length, storageStatus: "saved", originalBytesStatus: "saved_original",
    durabilityStatus: "ORIGINAL_STORED", aiReadabilityStatus: "processable", repairStatus: "not_needed" };
}

export async function recoverRemoteOriginal(asset, storageRoot, { fetchImpl = fetch, signal = null, maxBytes = 512 * 1024 * 1024 } = {}) {
  const remoteUrl = new URL(String(asset?.remote_url || asset?.url || ""));
  if (remoteUrl.protocol !== "https:") throw mediaError("REMOTE_MEDIA_INVALID", "Remote media recovery requires HTTPS.", false);
  const response = await fetchImpl(remoteUrl, { signal, redirect: "follow", headers: { "user-agent": "SoloToChina-Media-Recovery/2.0" } });
  if (!response.ok || !response.body) throw mediaError(`REMOTE_MEDIA_${response.status || "UNAVAILABLE"}`, `Remote media returned HTTP ${response.status || "unavailable"}.`, response.status >= 500 || response.status === 429);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw mediaError("REMOTE_MEDIA_TOO_LARGE", "Remote media exceeds the durable recovery limit.", false);
  const root = path.resolve(storageRoot);
  const tempRoot = path.join(root, ".media-recovery");
  fs.mkdirSync(tempRoot, { recursive: true });
  const temporary = path.join(tempRoot, `${randomUUID()}.part`);
  const output = fs.openSync(temporary, "wx");
  const digest = createHash("sha256");
  let size = 0;
  try {
    for await (const value of response.body) {
      const bytes = Buffer.from(value); size += bytes.length;
      if (size > maxBytes) throw mediaError("REMOTE_MEDIA_TOO_LARGE", "Remote media exceeded the durable recovery limit while streaming.", false);
      fs.writeSync(output, bytes); digest.update(bytes);
    }
  } catch (error) {
    fs.closeSync(output); fs.rmSync(temporary, { force: true }); throw error;
  }
  fs.closeSync(output);
  const sha256 = digest.digest("hex");
  if (asset.original_sha256 && asset.original_sha256 !== sha256) {
    fs.rmSync(temporary, { force: true });
    throw mediaError("REMOTE_MEDIA_HASH_MISMATCH", "Recovered bytes do not match the previously observed SHA-256.", false);
  }
  const prefix = Buffer.alloc(Math.min(32, size));
  const input = fs.openSync(temporary, "r");
  try { fs.readSync(input, prefix, 0, prefix.length, 0); }
  finally { fs.closeSync(input); }
  const mimeType = mediaMime(prefix, asset.kind, response.headers.get("content-type") || asset.mime_type);
  if (!mimeType) { fs.rmSync(temporary, { force: true }); throw mediaError("REMOTE_MEDIA_UNSUPPORTED", "Recovered bytes are not a supported image or video original.", false); }
  const target = path.join(root, "media", sha256.slice(0, 2), `${sha256}${MEDIA_EXTENSIONS[mimeType]}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!fs.existsSync(target)) fs.renameSync(temporary, target); else fs.rmSync(temporary, { force: true });
  return { localPath: target, mimeType, sha256, sizeBytes: size };
}

function imageMime(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.length >= 6 && /^GIF8[79]a$/u.test(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  return "";
}

function mediaMime(bytes, kind, suppliedMime = "") {
  if (kind !== "video") return imageMime(bytes);
  const mime = String(suppliedMime || "").toLowerCase().split(";")[0];
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))) return "video/webm";
  if (bytes.length >= 12 && bytes.subarray(4, 12).toString("ascii").includes("ftyp")) return mime === "video/quicktime" ? mime : "video/mp4";
  return "";
}

function mediaError(code, message, retryable) {
  return Object.assign(new Error(message), { code, retryable });
}
