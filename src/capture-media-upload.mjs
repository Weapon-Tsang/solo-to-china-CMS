import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { AsyncSemaphore } from '../extension/sync-core.js';
import { MEDIA_EXTENSIONS, mediaError, safeMediaPath, trustedMediaRecord, inspectMediaFile, recordVerifiedMedia, mediaStreamVerifier } from './media-storage.mjs';

// V1 remains readable. V2 adds resumable status and an upload capability.
export class CaptureMediaUploadManager {
  constructor(config = {}) {
    this.temporaryRoot = path.resolve(config.uploadDir || 'data/capture-media-uploads');
    this.storageRoot = path.resolve(config.storageDir || 'data/source-uploads');
    this.maxBytes = Number(config.maxBytes || 512 * 1024 * 1024);
    this.chunkBytes = Math.max(512 * 1024, Math.min(8 * 1024 * 1024, Number(config.chunkBytes || 4 * 1024 * 1024)));
    this.locks = new Map();
    this.finalizers = new AsyncSemaphore(2);
    this.retentionMs = Math.max(30 * 86400_000, Number(config.retentionMs || 0));
  }
  async create(input = {}) {
    const size = Number(input.size), sha256 = String(input.sha256 || '').toLowerCase();
    const kind = input.kind === 'video' ? 'video' : input.kind === 'image' || !input.kind ? 'image' : '';
    const mimeType = String(input.mimeType || '').toLowerCase().split(';')[0].trim();
    if (!Number.isSafeInteger(size) || size <= 0 || size > this.maxBytes) throw mediaError('MEDIA_TOO_LARGE', '媒体大小超出限制。', 413);
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw mediaError('INVALID_MEDIA_HASH', '需要完整 SHA-256。');
    if (!kind || !MEDIA_EXTENSIONS[mimeType] || !mimeType.startsWith(kind + '/')) throw mediaError('UNSUPPORTED_MEDIA_TYPE', '媒体类型与格式不一致。');
    const reference = `media/${sha256.slice(0, 2)}/${sha256}${MEDIA_EXTENSIONS[mimeType]}`;
    const stored = trustedMediaRecord(this.storageRoot, reference, sha256);
    if (input.protocolVersion === 2 && stored?.sizeBytes === size) return { protocolVersion: 2, receipt: publicReceipt(stored), receivedChunks: [] };
    const uploadId = crypto.randomUUID();
    const metadata = { uploadId, size, sha256, kind, mimeType, chunkBytes: this.chunkBytes, chunkCount: Math.ceil(size / this.chunkBytes),
      protocolVersion: input.protocolVersion === 2 ? 2 : 1, uploadToken: input.protocolVersion === 2 ? crypto.randomBytes(32).toString('hex') : null,
      createdAt: new Date().toISOString() };
    await fsp.mkdir(this.directory(uploadId), { recursive: true });
    await fsp.writeFile(path.join(this.directory(uploadId), 'upload.json'), JSON.stringify(metadata), { flag: 'wx' });
    return { uploadId, uploadToken: metadata.uploadToken, protocolVersion: metadata.protocolVersion, chunkBytes: metadata.chunkBytes, chunkCount: metadata.chunkCount, receivedChunks: [] };
  }
  async status(uploadId, token) {
    const metadata = await this.read(uploadId, token), receipt = await this.receipt(uploadId);
    if (receipt) {
      if (!trustedMediaRecord(this.storageRoot, receipt.storageRef, receipt.sha256)) {
        try {
          await inspectMediaFile(safeMediaPath(this.storageRoot,receipt.storageRef),metadata);
          await recordVerifiedMedia(this.storageRoot,receipt.storageRef,receipt);
        } catch { throw mediaError('MEDIA_STORED_FILE_CHANGED', '已保存原件丢失或发生变化。', 409); }
      }
      return { uploadId, protocolVersion: metadata.protocolVersion, receipt, receivedChunks: [] };
    }
    const receivedChunks = [];
    for (let i = 0; i < metadata.chunkCount; i++) {
      try { if ((await fsp.stat(this.chunkPath(uploadId, i))).size === this.chunkSize(metadata, i)) receivedChunks.push(i); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return { uploadId, chunkBytes: metadata.chunkBytes, chunkCount: metadata.chunkCount, receivedChunks };
  }
  async writeChunk(uploadId, index, value, token) {
    return this.lock(uploadId, async () => {
      const metadata = await this.read(uploadId, token), chunkIndex = Number(index);
      if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= metadata.chunkCount) throw mediaError('INVALID_MEDIA_CHUNK', '媒体分块编号无效。');
      const bytes = Buffer.from(value || []);
      if (bytes.length !== this.chunkSize(metadata, chunkIndex)) throw mediaError('INVALID_MEDIA_CHUNK_SIZE', '媒体分块长度不一致。');
      if (await this.receipt(uploadId)) throw mediaError('MEDIA_UPLOAD_FINALIZED', '媒体已完成，请读取回执。', 409);
      const filename = this.chunkPath(uploadId, chunkIndex);
      try {
        const existing = await fsp.readFile(filename);
        if (!existing.equals(bytes)) throw mediaError('MEDIA_CHUNK_CONFLICT', '重复分块内容不同。', 409);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
        await fsp.writeFile(temporary, bytes, { flag: 'wx' });
        await fsp.rename(temporary, filename);
      }
      return { uploadId, index: chunkIndex, receivedBytes: bytes.length, chunkCount: metadata.chunkCount };
    });
  }
  async complete(uploadId, token) {
    return this.lock(uploadId, () => this.finalizers.run(async () => {
      const metadata = await this.read(uploadId, token), previous = await this.receipt(uploadId);
      if (previous) { await this.status(uploadId, token); return previous; }
      const reference = `media/${metadata.sha256.slice(0, 2)}/${metadata.sha256}${MEDIA_EXTENSIONS[metadata.mimeType]}`;
      const target = safeMediaPath(this.storageRoot, reference);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const temporary = safeMediaPath(this.storageRoot, `${reference}.${uploadId}.part`), self = this;
      async function* chunks() {
        for (let index = 0; index < metadata.chunkCount; index++) {
          const filename = self.chunkPath(uploadId, index);
          let stat;
          try { stat = await fsp.stat(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (!stat || stat.size !== self.chunkSize(metadata, index)) throw mediaError('MEDIA_UPLOAD_INCOMPLETE', `Media chunk ${index} is missing or incomplete.`, 409);
          yield* fs.createReadStream(filename, { highWaterMark: 256 * 1024 });
        }
      }
      try {
        await fsp.rm(temporary, { force: true });
        const verifier=mediaStreamVerifier(metadata);
        await pipeline(Readable.from(chunks()), verifier, fs.createWriteStream(temporary, { flags: 'wx' }));
        const receipt = { ...verifier.receipt, storageRef: reference };
        try { await fsp.link(temporary, target); }
        catch (error) { if (error.code !== 'EEXIST') throw error; await inspectMediaFile(target, metadata); }
        // Remove the temporary hard link before recording the inode stamp.
        await fsp.rm(temporary, { force: true });
        await recordVerifiedMedia(this.storageRoot, reference, receipt);
        const receiptPath = path.join(this.directory(uploadId), 'receipt.json');
        await fsp.writeFile(receiptPath + '.tmp', JSON.stringify(receipt));
        await fsp.rename(receiptPath + '.tmp', receiptPath);
        for (let index = 0; index < metadata.chunkCount; index++) await fsp.rm(this.chunkPath(uploadId, index), { force: true });
        return receipt;
      } finally { await fsp.rm(temporary, { force: true }); }
    }));
  }
  directory(uploadId) {
    if (!/^[a-f0-9-]{36}$/i.test(String(uploadId || ''))) throw mediaError('INVALID_MEDIA_UPLOAD_ID', '媒体上传标识无效。');
    return safeMediaPath(this.temporaryRoot, uploadId);
  }
  chunkPath(uploadId, index) { return safeMediaPath(this.temporaryRoot, `${uploadId}/${String(index).padStart(6, '0')}.part`); }
  chunkSize(metadata, index) { return Math.min(metadata.chunkBytes, metadata.size - index * metadata.chunkBytes); }
  async read(uploadId, token) {
    this.directory(uploadId);
    let metadata;
    try { metadata = JSON.parse(await fsp.readFile(safeMediaPath(this.temporaryRoot, `${uploadId}/upload.json`), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; throw mediaError('MEDIA_UPLOAD_NOT_FOUND', '上传会话不存在。', 404); }
    if (metadata.protocolVersion === 2 && token !== metadata.uploadToken) throw mediaError('MEDIA_UPLOAD_UNAUTHORIZED', '上传会话授权不匹配。', 403);
    if (Date.now() - Date.parse(metadata.createdAt) > this.retentionMs && !await this.receipt(uploadId)) throw mediaError('MEDIA_UPLOAD_EXPIRED', '上传会话已超过保留期；可从本地暂存重新上传。', 410);
    return metadata;
  }
  // Explicit maintenance only. Receipts and source originals are never pruned.
  // The preview and execution both recheck age, completion and active locks.
  async cleanupExpired({ dryRun = true, activeUploadIds = [] } = {}) {
    const result = { dryRun, expiredUploads:0, bytes:0, removedUploads:0, uploadIds:[] };
    let entries;
    try { entries = await fsp.readdir(this.temporaryRoot, {withFileTypes:true}); }
    catch (error) { if (error.code === 'ENOENT') return result; throw error; }
    const active = new Set(activeUploadIds);
    for (const entry of entries) {
      if (!entry.isDirectory() || active.has(entry.name) || this.locks.has(entry.name) || !/^[a-f0-9-]{36}$/i.test(entry.name)) continue;
      await this.lock(entry.name, async () => {
        const directory = this.directory(entry.name);
        let metadata;
        try { metadata=JSON.parse(await fsp.readFile(path.join(directory,'upload.json'),'utf8')); } catch { return; }
        if (!(Date.now()-Date.parse(metadata.createdAt)>this.retentionMs) || await this.receipt(entry.name)) return;
        let bytes=0;
        for (const file of await fsp.readdir(directory)) {
          const filename=safeMediaPath(this.temporaryRoot,`${entry.name}/${file}`);
          const stat=await fsp.lstat(filename); if (!stat.isFile()) return;
          bytes+=stat.size;
        }
        result.expiredUploads++;result.bytes+=bytes;result.uploadIds.push(entry.name);
        if (!dryRun) { await fsp.rm(directory,{recursive:true,force:true});result.removedUploads++; }
      });
    }
    return result;
  }
  async receipt(uploadId) {
    try { return JSON.parse(await fsp.readFile(safeMediaPath(this.temporaryRoot, `${uploadId}/receipt.json`), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
  }
  async lock(key, work) {
    const next = (this.locks.get(key) || Promise.resolve()).catch(() => {}).then(work);
    this.locks.set(key, next);
    try { return await next; } finally { if (this.locks.get(key) === next) this.locks.delete(key); }
  }
}
function publicReceipt(record) { return Object.fromEntries(['storageRef','sha256','sizeBytes','mimeType','kind'].map(key => [key, record[key]])); }
