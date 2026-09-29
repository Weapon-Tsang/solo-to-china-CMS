import { createHash, createPublicKey } from 'node:crypto';

// Public identity, not a credential. Keep this ID and manifest.key across builds.
export const EXTENSION_ID = 'jjcdhgnlpbodpfjfnkgpcpmfjiaidmfn';
export function validateExtensionIdentity(manifest) {
  if (!manifest.key) throw new Error('Extension manifest.key is required to preserve its ID.');
  const key = Buffer.from(manifest.key, 'base64');
  createPublicKey({ key, format: 'der', type: 'spki' });
  const id = createHash('sha256').update(key).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
  if (id !== EXTENSION_ID) throw new Error('Extension identity changed; refusing to package.');
  return id;
}
