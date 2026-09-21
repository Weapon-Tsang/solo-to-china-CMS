import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { transaction } from '../db.mjs';

const hashFile = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
const verifiedHash = (value) => /^[a-f0-9]{64}$/i.test(String(value || '')) ? String(value).toLowerCase() : null;
const qualityPassed = (quality) => ['language', 'completeness', 'style', 'semantic']
  .every((field) => quality?.[field]?.status === 'passed');

// Old successful transforms retained their bytes and four independent QA decisions,
// but some rows lost the local path or predate the file_hash receipt. Rebind only
// byte-identical output for the same frozen visual plan; never reinterpret a failed
// or unknown provider outcome as success.
export function recoverLegacyVisualReceipts(db, draftId, mediaDir, { apply = true } = {}) {
  if (!mediaDir || !fs.existsSync(mediaDir) || !/^[\w-]+$/.test(String(draftId))) return [];
  const draft = db.prepare('SELECT revision FROM article_drafts WHERE id=?').get(draftId);
  if (!draft) return [];
  const manifest = db.prepare('SELECT slots_json FROM required_media_manifests WHERE draft_id=? AND revision=?')
    .get(draftId, draft.revision);
  let manifestSlots = null;
  try { if (manifest) manifestSlots = new Map(JSON.parse(manifest.slots_json).map((slot) => [slot.slotId, slot])); }
  catch { return []; }
  const rows = db.prepare(`SELECT id,slot,status,asset_fingerprint,media_path,media_url,media_metadata_json
    FROM article_visuals WHERE draft_id=? ORDER BY slot`).all(draftId);
  let candidates;
  try {
    candidates = fs.readdirSync(mediaDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith(`${draftId}-`)
        && /\.(?:png|jpe?g|webp)$/i.test(entry.name))
      .map((entry) => path.join(mediaDir, entry.name));
  } catch { return []; }
  const candidateHashes = new Map();
  const changes = [];
  for (const row of rows) {
    if (!['generated', 'planned'].includes(row.status)) continue;
    const slot = manifestSlots?.get(row.id);
    if (manifestSlots && (!slot || slot.slot !== row.slot || slot.planFingerprint !== row.asset_fingerprint)) continue;
    let metadata;
    try { metadata = JSON.parse(row.media_metadata_json || '{}'); } catch { continue; }
    const expected = verifiedHash(metadata.binary_qa?.sha256 || metadata.pixel_qa?.sha256);
    const quality = metadata.quality_qa;
    if (!expected || metadata.binary_qa?.status !== 'passed' || !qualityPassed(quality)
      || (quality.file_hash && verifiedHash(quality.file_hash) !== expected)) continue;
    const paths = [...new Set([row.media_path, ...candidates].filter(Boolean))];
    const match = paths.find((filePath) => {
      if (!path.resolve(filePath).startsWith(`${path.resolve(mediaDir)}${path.sep}`)) return false;
      try {
        if (!candidateHashes.has(filePath)) candidateHashes.set(filePath,hashFile(filePath));
        return candidateHashes.get(filePath) === expected;
      } catch { return false; }
    });
    if (!match) continue;
    if (row.status === 'generated' && row.media_path === match && quality.file_hash === expected) continue;
    changes.push({ id: row.id, status: row.status, mediaPath: match, metadata: {
      ...metadata, quality_qa: { ...quality, status: 'passed', file_hash: expected },
    } });
  }
  if (!changes.length) return [];
  if (!apply) return changes.map(({id,mediaPath})=>({id,mediaPath}));
  const update = db.prepare(`UPDATE article_visuals SET status='generated',media_path=?,media_metadata_json=?,
    updated_at=datetime('now') WHERE id=? AND draft_id=? AND status=?`);
  return transaction(db, () => changes.filter((change) => update.run(change.mediaPath,
    JSON.stringify(change.metadata), change.id, draftId, change.status).changes === 1)
    .map(({ id, mediaPath }) => ({ id, mediaPath })));
}
