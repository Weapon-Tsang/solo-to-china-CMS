import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { EXTENSION_ID, validateExtensionIdentity } from '../scripts/lib/extension-identity.mjs';

test('packaging across different directories preserves the pinned extension identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-extension-identity-'));
  try {
    for (const folder of ['first', 'next-version']) {
      const out = path.join(root, folder);
      execFileSync(process.execPath, ['scripts/package-extension-cloud.mjs', '--origin', 'https://capture.solotochina.com', '--preserve-stored-token', '--out', out]);
      assert.equal(validateExtensionIdentity(JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'))), EXTENSION_ID);
      assert.match(fs.readFileSync(path.join(out, 'background.js'), 'utf8'), /const DEFAULT_CAPTURE_TOKEN = "";/);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('missing or regenerated keys fail the packaging identity gate', () => {
  assert.throws(() => validateExtensionIdentity({}), /required/);
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  assert.throws(() => validateExtensionIdentity({ key }), /identity changed/);
});
