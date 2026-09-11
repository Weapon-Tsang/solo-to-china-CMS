import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MIME_EXTENSIONS = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" };

export function persistCaptureAssets(capture, storageRoot) {
  if (!storageRoot || !Array.isArray(capture?.assets)) return capture;
  const root = path.resolve(storageRoot);
  fs.mkdirSync(root, { recursive: true });
  const assets = capture.assets.map((asset) => persistAsset(asset, root));
  return { ...capture, assets };
}

function persistAsset(asset, root) {
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
  const originalBytes = Boolean(asset.originalSha256 && asset.originalSha256 === hash);
  return {
    ...asset,
    localPath: filename,
    mimeType: actualMime,
    storedSha256: hash,
    storedSizeBytes: bytes.length,
    storageStatus: "saved",
    originalBytesStatus: originalBytes ? "saved_original" : "saved_derivative",
  };
}

function imageMime(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.length >= 6 && /^GIF8[79]a$/u.test(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  return "";
}
