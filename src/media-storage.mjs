import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { detectMediaMime } from '../extension/media-contract.js';

export const MEDIA_EXTENSIONS = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov' };
export const mediaError = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });

export function safeMediaPath(root, relative) {
  root = path.resolve(root);
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw mediaError('INVALID_MEDIA_PATH', '媒体路径超出存储目录。');
  let current = root;
  for (const part of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw mediaError('INVALID_MEDIA_PATH', '媒体引用不得经过符号链接。');
  }
  return resolved;
}

const stamp = stat => ({ size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino });
const recordPath = (root, reference) => safeMediaPath(root, `.verified/${createHash('sha256').update(reference).digest('hex')}.json`);
export function trustedMediaRecord(root, reference, expectedHash) {
  if (!/^media\/[a-f0-9]{2}\/[a-f0-9]{64}\.(jpg|png|webp|gif|mp4|webm|mov)$/.test(reference || '')) return null;
  const filename = safeMediaPath(root, reference);
  try {
    const record = JSON.parse(fs.readFileSync(recordPath(root, reference), 'utf8'));
    const stat = fs.statSync(filename);
    if (record.version !== 1 || record.storageRef !== reference || !stat.isFile()
      || (expectedHash && record.sha256 !== expectedHash) || JSON.stringify(record.stamp) !== JSON.stringify(stamp(stat))) return null;
    return { ...record, localPath: filename };
  } catch (error) { if (error.code === 'INVALID_MEDIA_PATH') throw error; return null; }
}

export async function inspectMediaFile(filename, { kind, mimeType = '', sha256, size, maxBytes = 512 * 1024 * 1024 }) {
  const digest = createHash('sha256');
  let count = 0, head = Buffer.alloc(0);
  for await (const chunk of fs.createReadStream(filename, { highWaterMark: 256 * 1024 })) {
    if (head.length < 32) head = Buffer.concat([head, chunk.subarray(0, 32 - head.length)]);
    count += chunk.length;
    if (count > maxBytes) throw mediaError('MEDIA_TOO_LARGE', '媒体超过字节上限。', 413);
    digest.update(chunk);
  }
  const hash = digest.digest('hex');
  const detected = detectMediaMime(head, kind, mimeType);
  if (!detected || (sha256 && hash !== sha256) || (size != null && count !== size)) {
    throw mediaError('MEDIA_HASH_MISMATCH', '媒体格式、长度或 SHA-256 与清单不一致。');
  }
  return { sha256: hash, sizeBytes: count, mimeType: detected, kind };
}

export function mediaStreamVerifier({kind,mimeType='',sha256,size,maxBytes=512*1024*1024}) {
  const digest=createHash('sha256');let count=0,head=Buffer.alloc(0);
  const verifier=new Transform({
    transform(chunk,_encoding,callback) {
      count+=chunk.length;
      if(count>maxBytes)return callback(mediaError('MEDIA_TOO_LARGE','媒体超过字节上限。',413));
      if(head.length<32)head=Buffer.concat([head,chunk.subarray(0,32-head.length)]);
      digest.update(chunk);callback(null,chunk);
    },
    flush(callback) {
      const hash=digest.digest('hex'),detected=detectMediaMime(head,kind,mimeType);
      if(!detected||(sha256&&hash!==sha256)||(size!=null&&count!==size))return callback(mediaError('MEDIA_HASH_MISMATCH','媒体格式、长度或 SHA-256 与清单不一致。'));
      verifier.receipt={sha256:hash,sizeBytes:count,mimeType:detected,kind};callback();
    },
  });
  return verifier;
}

export async function recordVerifiedMedia(root, reference, receipt) {
  const filename = safeMediaPath(root, reference);
  const record = { version: 1, ...receipt, storageRef: reference, stamp: stamp(await fsp.stat(filename)) };
  const target = recordPath(root, reference);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(record), { flag: 'wx' });
  await fsp.rename(temp, target);
  return record;
}
