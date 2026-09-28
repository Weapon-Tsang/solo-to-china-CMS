import crypto from 'node:crypto';
export function assertFixedContractIdentity(documents,expected) {
  const actual=crypto.createHash('sha256').update(JSON.stringify(documents)).digest('hex');
  if(!/^[a-f0-9]{64}$/.test(expected || '') || actual!==expected)
    throw new Error(`Fixed Frontend artifact SHA256 mismatch: ${actual}.`);
  return actual;
}
