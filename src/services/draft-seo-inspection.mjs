import crypto from 'node:crypto';
import { createSeoInspection } from './seo-inspection.mjs';
import { createSeoPublicReader } from '../seo-public-reader.mjs';
import { isPublicArtifactUrl } from '../seo-observation.mjs';

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse = value => { try { return JSON.parse(value || '{}'); } catch { return {}; } };
const failure = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
export const SEO_INSPECTION_POLICY = 'seo-inspection-1';

// One bounded latest observation per draft, in the existing backed-up JSON store.
// It is not a publication receipt, approval, queue task or content mutation.
export function createDraftSeoInspection(db, { siteUrl = '', inspector, now = Date.now, ttlMs = 300_000 } = {}) {
  let origin = '';
  try { if (isPublicArtifactUrl(siteUrl) && new URL(siteUrl).protocol === 'https:') origin = new URL(siteUrl).origin; } catch {}
  const inspection = inspector || createSeoInspection({ reader: createSeoPublicReader({ allowedOrigins: origin ? [origin] : [] }) });
  const pending = new Map();
  const key = id => `seo_observation:${id}`;
  function context(id) {
    const draft = db.prepare('SELECT id,revision,content_hash,title,meta_description,seo_json,status FROM article_drafts WHERE id=?').get(id);
    if (!draft) throw failure('DRAFT_NOT_FOUND', 'Draft not found.', 404);
    const publication = db.prepare('SELECT post_url,response_json,updated_at FROM wordpress_publications WHERE draft_id=?').get(id);
    const seo = parse(draft.seo_json), receipt = parse(publication?.response_json);
    const url = publication?.post_url || '';
    const publicPage = draft.status === 'published' || receipt.status === 'publish' || receipt.post?.status === 'publish';
    const available = Boolean(origin && publicPage && isPublicArtifactUrl(url) && new URL(url).origin === origin
      && new URL(url).protocol === 'https:' && !/[?&](?:preview|preview_id|preview_nonce)=/i.test(url));
    const input = { url, pageRevision: draft.revision, status: 'publish', expectedH1: draft.title,
      expectedDocumentTitle: seo.meta_title || draft.title, expectedDescription: draft.meta_description,
      expectedFacts: (Array.isArray(seo.key_takeaways) ? seo.key_takeaways : []).filter(item => typeof item === 'string'),
      sitemapUrl: origin ? `${origin}/sitemap_index.xml` : '' };
    const fingerprint = hash({ policy:SEO_INSPECTION_POLICY, input, contentHash: draft.content_hash, publication, publicPage });
    return { draft, input, fingerprint, available, reason: !origin ? 'PUBLIC_SITE_NOT_CONFIGURED'
      : !publicPage ? 'PUBLICATION_NOT_PUBLIC' : !available ? 'CONFIRMED_PUBLIC_URL_REQUIRED' : null };
  }
  function read(id) {
    const current = context(id);
    const row = db.prepare('SELECT value_json FROM runtime_settings WHERE setting_key=?').get(key(id));
    const stored = row ? parse(row.value_json) : null;
    const saved = stored?.result ? stored : null;
    const checked = Date.parse(saved?.checked_at || '');
    const stale = Boolean(saved && (saved.input_fingerprint !== current.fingerprint || !Number.isFinite(checked) || checked > now() || now() - checked >= ttlMs));
    return { draft_id: id, page_revision: current.draft.revision, input_fingerprint: current.fingerprint,
      available: current.available, reason: current.reason, url: current.available ? current.input.url : null,
      state: pending.has(id) ? 'checking' : !saved ? 'not_observed' : stale ? 'stale' : saved.result.status,
      stale, observation: saved, policy_version:SEO_INSPECTION_POLICY, automatic_retry: false };
  }
  async function inspect(id, { expected_revision, input_fingerprint, refresh = false } = {}) {
    const current = context(id);
    if (expected_revision !== current.draft.revision || input_fingerprint !== current.fingerprint)
      throw failure('SEO_REVISION_CONFLICT', 'Article or publication changed; reload the saved observation first.');
    if (!current.available) throw failure(current.reason, 'Only a confirmed public permalink on the configured public site can be inspected.');
    if (pending.has(id)) { await pending.get(id); return read(id); }
    const saved = read(id);
    if (!refresh && saved.observation && !saved.stale) return saved;
    if (pending.size >= 2) throw failure('SEO_INSPECTION_BUSY', 'Two page inspections are already running.', 429);
    const task = (async () => {
      const result = await inspection.inspect({ ...current.input, refresh });
      if (context(id).fingerprint !== current.fingerprint)
        throw failure('SEO_REVISION_CONFLICT', 'Article changed during inspection; the old result was not saved.');
      const record = { checked_at: new Date(now()).toISOString(), input_fingerprint: current.fingerprint,
        page_revision: current.draft.revision, content_hash:current.draft.content_hash, url: current.input.url, policy_version:SEO_INSPECTION_POLICY, result };
      const encoded = JSON.stringify(record);
      if (Buffer.byteLength(encoded) > 512_000) throw failure('SEO_RESULT_BUDGET', 'Inspection result exceeded its storage budget.');
      db.prepare(`INSERT INTO runtime_settings(setting_key,value_json,updated_at) VALUES (?,?,?)
        ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
        .run(key(id), encoded, record.checked_at);
    })();
    pending.set(id, task);
    try { await task; } finally { pending.delete(id); }
    return read(id);
  }
  return { read, inspect };
}
