import path from 'node:path';
import { auditSourcePhoto, closeLocalPhotoAudit } from '../src/local-photo-audit.mjs';

if (process.argv.length < 3) throw new Error('Pass one or more local image paths.');
try {
  for (const filename of process.argv.slice(2)) {
    const audit = await auditSourcePhoto(filename, { assetKind: 'documentary_photo' });
    console.log(JSON.stringify({ filename: path.basename(filename), ...audit }));
  }
} finally {
  await closeLocalPhotoAudit();
}
