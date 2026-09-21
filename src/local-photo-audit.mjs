import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';

const languageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../vendor/ocr');
let ocrWorkerPromise;

async function ocrWorker() {
  ocrWorkerPromise ||= createWorker(['chi_sim', 'eng'], 1, {
    langPath: languageDirectory, gzip: false, cacheMethod: 'none',
  });
  return ocrWorkerPromise;
}

export async function closeLocalPhotoAudit() {
  if (!ocrWorkerPromise) return;
  const worker = await ocrWorkerPromise;
  ocrWorkerPromise = undefined;
  await worker.terminate();
}

// The OCR engine and image statistics run locally. No image or extracted text
// is sent to a Provider, and only counts/quality evidence are persisted.
export async function auditSourcePhoto(filename, { assetKind = 'unknown' } = {}) {
  const bytes = await fs.readFile(filename);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const metadata = await sharp(bytes).metadata();
  const dimensions = metadata.autoOrient || { width: metadata.width, height: metadata.height };
  const width = Number(dimensions.width || 0);
  const height = Number(dimensions.height || 0);
  const stats = await sharp(bytes).resize({ width: 1600, height: 1600, fit: 'inside',
    withoutEnlargement: true }).toBuffer().then((image) => sharp(image).stats());
  const reasons = [];
  if (width < 900 || height < 600) reasons.push('resolution_low');
  if (!Number.isFinite(stats.sharpness) || stats.sharpness < 1) reasons.push('focus_low');
  if (!Number.isFinite(stats.entropy) || stats.entropy < 4) reasons.push('detail_low');
  if (assetKind && !['unknown', 'documentary_photo', 'real_world_photo'].includes(assetKind))
    reasons.push('not_documentary_photo');
  // OCR is expensive and cannot change an already rejected photo candidate.
  // Infographics keep their separate translation path regardless of this audit.
  let chineseChars = null;
  let textChars = null;
  if (!reasons.length) {
    const ocrInput = await sharp(bytes).resize({ width: 1280, height: 1280, fit: 'inside',
      withoutEnlargement: true }).png().toBuffer();
    const worker = await ocrWorker();
    const { data } = await worker.recognize(ocrInput);
    const recognized = String(data?.text || '').replace(/\s+/g, '');
    chineseChars = (recognized.match(/[\u3400-\u9fff]/gu) || []).length;
    textChars = [...recognized].length;
    if (chineseChars > 35 || (chineseChars > 12 && chineseChars / Math.max(1, textChars) > 0.18))
      reasons.push('chinese_text_dense');
    if (textChars > 400) reasons.push('text_dense');
  }
  return {
    version: 'local-photo-audit-1', sha256, width, height,
    sharpness: Number(stats.sharpness.toFixed(2)), entropy: Number(stats.entropy.toFixed(2)),
    chineseChars, textChars, status: reasons.length ? 'needs_review' : 'eligible', reasons,
    checkedAt: new Date().toISOString(), method: textChars === null ? 'sharp_local' : 'sharp+tesseract_local', providerCalls: 0,
  };
}
