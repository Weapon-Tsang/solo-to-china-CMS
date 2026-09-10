// Read-only incident snapshot. Never prints credentials or writes to the service.
import { mkdir, writeFile } from 'node:fs/promises';
const base = process.env.STC_DIAGNOSTIC_URL || 'https://engine.solotochina.com';
const token = process.env.STC_DIAGNOSTIC_TOKEN;
if (!token) throw new Error('STC_DIAGNOSTIC_TOKEN is required');
async function get(path) {
  const response = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}
const content = await get('/api/content');
const exceptions = await get('/api/exceptions?limit=500');
const drafts = [];
for (const row of content.items || []) {
  if (!row.draft_id) continue;
  const item = await get(`/api/drafts/${encodeURIComponent(row.draft_id)}`);
  drafts.push(item);
  console.log(JSON.stringify({ id: row.draft_id, title: row.draft_title, status: row.draft_status,
    revision: item.draft?.revision, score: item.review?.score,
    issues: item.review?.issues?.map(({code,severity}) => ({code,severity})) }));
}
await mkdir('output', { recursive: true });
await writeFile('output/content-recovery-snapshot.json', JSON.stringify({ at: new Date().toISOString(), content, exceptions, drafts }, null, 2));
console.log('Saved output/content-recovery-snapshot.json (local, ignored; no credentials).');
