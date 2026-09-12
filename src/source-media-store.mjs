import fs from "node:fs";
import fsp from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { trustedMediaRecord, safeMediaPath, inspectMediaFile, recordVerifiedMedia, mediaStreamVerifier } from './media-storage.mjs';
import { openMediaResponse } from './safe-media-http.mjs';
import { AsyncSemaphore } from '../extension/sync-core.js';
const mediaInspections = new AsyncSemaphore(2);

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MIME_EXTENSIONS = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" };
const MEDIA_EXTENSIONS = { ...MIME_EXTENSIONS, "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov" };

// Upgrade legacy storage references off the synchronous repository path. Only
// server-computed receipts plus unchanged file stamps can use the fast path.
export async function prepareCaptureMedia(capture, storageRoot) {
  if (!storageRoot || !capture.assets) return capture;
  const assets = await Promise.all(capture.assets.map(asset => mediaInspections.run(async () => {
    if (asset.originalStorageRef && !/^media\/[a-f0-9]{2}\/[a-f0-9]{64}\.(jpg|png|webp|gif|mp4|webm|mov)$/.test(asset.originalStorageRef)) throw mediaError('INVALID_MEDIA_PATH','媒体引用格式无效。',false);
    if (!asset.originalStorageRef || trustedMediaRecord(storageRoot, asset.originalStorageRef, asset.originalSha256)) return asset;
    const filename = safeMediaPath(storageRoot, asset.originalStorageRef);
    try {
      const receipt = await inspectMediaFile(filename, {kind:asset.kind,mimeType:asset.mimeType,sha256:asset.originalSha256});
      await recordVerifiedMedia(storageRoot,asset.originalStorageRef,receipt);
      return asset;
    } catch (error) {
      if (!['ENOENT','MEDIA_HASH_MISMATCH','MEDIA_TOO_LARGE'].includes(error.code)) throw error;
      return {...asset,originalStorageRef:null,rejectedStorageRef:asset.originalStorageRef,persistenceError:{code:error.code,message:error.message}};
    }
  })));
  return {...capture,assets};
}

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
    if (stored) return persistDerivativeReference(stored, root);
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
  const originalBytes = hasOriginalPayload && Boolean(asset.originalSha256 && asset.originalSha256 === hash);
  const reference = originalBytes
    ? `media/${hash.slice(0, 2)}/${hash}${MIME_EXTENSIONS[actualMime]}`
    : `.derived/${hash.slice(0, 2)}/${hash}${MIME_EXTENSIONS[actualMime]}`;
  const filename = safeMediaPath(root, reference);
  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.existsSync(filename)) fs.writeFileSync(filename, bytes, { flag: "wx" });
  const explicitDerivativeRef = originalBytes ? derivativeReference(asset, root) : reference;
  return withoutEmbeddedMedia({
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
    originalStorageRef: originalBytes ? reference : (asset.originalStorageRef || ""),
    derivativeStorageRef: explicitDerivativeRef,
    derivativePath: explicitDerivativeRef ? safeMediaPath(root, explicitDerivativeRef) : "",
  });
}

function persistDerivativeReference(asset, root) {
  const ref = derivativeReference(asset, root);
  return withoutEmbeddedMedia({ ...asset, derivativeStorageRef: ref,
    derivativePath: ref ? safeMediaPath(root, ref) : "" });
}

function derivativeReference(asset, root) {
  const encoded = String(asset.aiDerivativeDataUrl || "");
  const match = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/u.exec(encoded);
  if (!match) return asset.derivativeStorageRef || "";
  const bytes = Buffer.from(match[2], "base64");
  const mime = imageMime(bytes);
  if (!mime || !bytes.length || bytes.length > MAX_IMAGE_BYTES) return "";
  const hash = createHash("sha256").update(bytes).digest("hex");
  const reference = `.derived/${hash.slice(0, 2)}/${hash}${MIME_EXTENSIONS[mime]}`;
  const filename = safeMediaPath(root, reference);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  if (!fs.existsSync(filename)) fs.writeFileSync(filename, bytes, { flag: "wx" });
  return reference;
}

function withoutEmbeddedMedia(asset) {
  const { originalDataUrl: _original, aiDerivativeDataUrl: _derivative, ...stored } = asset;
  return stored;
}

function storedOriginal(asset, root) {
  const reference = String(asset.originalStorageRef || "");
  if (!/^media\/[a-f0-9]{2}\/[a-f0-9]{64}\.(?:jpg|png|webp|gif|mp4|webm|mov)$/iu.test(reference)) return null;
  const filename = safeMediaPath(root, reference);
  if (!filename.startsWith(`${root}${path.sep}`) || !fs.existsSync(filename)) return null;
  const verified = trustedMediaRecord(root, reference, asset.originalSha256);
  if (verified && verified.kind === asset.kind && (!asset.mimeType || asset.mimeType === verified.mimeType)) {
    return { ...asset, localPath: filename, mimeType: verified.mimeType, originalSha256: verified.sha256, storedSha256: verified.sha256,
      storedSizeBytes: verified.sizeBytes, storageStatus: 'saved', originalBytesStatus: 'saved_original',
      durabilityStatus: 'ORIGINAL_STORED', aiReadabilityStatus: 'processable', repairStatus: 'not_needed' };
  }
  const bytes = fs.readFileSync(filename);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (asset.originalSha256 && hash !== asset.originalSha256) return null;
  const mimeType = mediaMime(bytes, asset.kind, asset.mimeType);
  if (!mimeType) return null;
  return { ...asset, localPath: filename, mimeType, originalSha256: hash, storedSha256: hash,
    storedSizeBytes: bytes.length, storageStatus: "saved", originalBytesStatus: "saved_original",
    durabilityStatus: "ORIGINAL_STORED", aiReadabilityStatus: "processable", repairStatus: "not_needed" };
}

export async function recoverRemoteOriginal(asset, storageRoot, { signal = null, maxBytes = 512 * 1024 * 1024,
  timeoutMs = 180_000, openResponse = openMediaResponse } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(mediaError('REMOTE_MEDIA_TIMEOUT', '远程媒体超过总时限。', true)), timeoutMs);
  const root = path.resolve(storageRoot);
  let response, temporary;
  try {
    response = await openResponse(String(asset?.remote_url || asset?.url || ''), { signal: controller.signal });
    if (!response.ok || !response.body) throw mediaError(`REMOTE_MEDIA_${response.status || 'UNAVAILABLE'}`, '远程媒体请求失败。', response.status >= 500 || response.status === 429);
    if (Number(response.headers.get('content-length') || 0) > maxBytes) throw mediaError('REMOTE_MEDIA_TOO_LARGE', '远程媒体超过字节限制。', false);
    const tempRoot = safeMediaPath(root, '.media-recovery');
    await fsp.mkdir(tempRoot, { recursive: true });
    temporary = safeMediaPath(root, `.media-recovery/${randomUUID()}.part`);
    let size = 0;
    const limiter = new Transform({ transform(chunk, _encoding, callback) {
      size += chunk.length;
      callback(size > maxBytes ? mediaError('REMOTE_MEDIA_TOO_LARGE', '远程媒体超过字节限制。', false) : null, chunk);
    } });
    const verifier=mediaStreamVerifier({ kind: asset.kind,
      mimeType: response.headers.get('content-type') || asset.mime_type, sha256: asset.original_sha256 || undefined, maxBytes });
    await pipeline(response.body, limiter, verifier, fs.createWriteStream(temporary, { flags: 'wx' }), { signal: controller.signal });
    const receipt=verifier.receipt;
    const reference = `media/${receipt.sha256.slice(0, 2)}/${receipt.sha256}${MEDIA_EXTENSIONS[receipt.mimeType]}`;
    const target = safeMediaPath(root, reference);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    try { await fsp.link(temporary, target); }
    catch (error) { if (error.code !== 'EEXIST') throw error; await inspectMediaFile(target, receipt); }
    await fsp.rm(temporary, { force: true }); temporary = null;
    await recordVerifiedMedia(root, reference, receipt);
    return { ...receipt, localPath: target };
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); response?.cancel?.();
    if (temporary) await fsp.rm(temporary, { force: true });
  }
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
  return Object.assign(new Error(message), { code, retryable, statusCode:retryable ? 503 : 400 });
}
