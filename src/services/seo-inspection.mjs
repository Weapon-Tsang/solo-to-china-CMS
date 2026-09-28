import crypto from 'node:crypto';
import { createSeoPublicReader } from '../seo-public-reader.mjs';
import { parseSitemap } from '../seo-sitemap.mjs';
import { validateRenderedHtmlArtifact } from '../final-html-validator.mjs';
import {inspectCrawlerPolicies} from '../seo-crawlers.mjs';

// Explicit inspection only. Construction and reading stored results perform no I/O.
// The caller owns persistence and authorization; this service never writes content.
export function createSeoInspection({ reader = createSeoPublicReader(), maxDocuments = 12,
  maxDepth = 3, maxTotalBytes = 4_000_000 } = {}) {
  for (const budget of [maxDocuments, maxDepth, maxTotalBytes]) if (!Number.isSafeInteger(budget) || budget < 1) throw new TypeError('Invalid inspection budget');
  return {
    async inspect({ url, sitemapUrl, pageRevision = null, refresh = false, ...expected }) {
      const options = { pageHash: String(pageRevision ?? ''), refresh };
      const page = await reader.read(url, options);
      if (page.status !== 'observed') return {
        ...validateRenderedHtmlArtifact({ url, httpStatus: page.httpStatus || 0, pageRevision, evidenceSource: page.source || 'provided_artifact' }),
        access: page, requests: [{ url, status: page.status, reason: page.reason }],
      };
      const requests = [{ url, status: page.status, cached: page.cached }];
      const robotsUrl = new URL('/robots.txt', page.url || url).href;
      const robots = await reader.read(robotsUrl, options);
      requests.push({ url: robotsUrl, status: robots.status, reason: robots.reason, cached: robots.cached });
      const documents = {};
      let root = '', count = 0, bytes = 0;
      const visited = new Set();
      async function walk(target, depth) {
        if (visited.has(target) || count >= maxDocuments || depth > maxDepth || bytes >= maxTotalBytes) return;
        visited.add(target); count++;
        const result = await reader.read(target, options);
        requests.push({ url: target, status: result.status, reason: result.reason, cached: result.cached });
        if (result.status !== 'observed') return;
        bytes += Buffer.byteLength(result.body);
        if (bytes > maxTotalBytes) return;
        documents[target] = result.body;
        if (depth === 0) root = result.body;
        const parsed = parseSitemap(result.body);
        for (const child of parsed.children) await walk(child, depth + 1);
      }
      if (sitemapUrl) await walk(sitemapUrl, 0);
      const pageHash = crypto.createHash('sha256').update(page.body).digest('hex');
      const result = validateRenderedHtmlArtifact({ ...expected, url:page.url || url, html: page.body, httpStatus: page.httpStatus,
        headers: page.headers, robotsTxt: robots.status === 'observed' ? robots.body : null,
        robotsHttpStatus: robots.httpStatus || 0, sitemapXml: root, sitemapDocuments: documents,
        pageRevision, checkedAt: page.checkedAt, evidenceSource: page.source || 'provided_artifact', authenticated: false });
      return { ...result, pageHash, requests, finalUrl: page.url,
        crawler_policies:inspectCrawlerPolicies(robots.status==='observed'?robots.body:null,{url:page.url || url,httpStatus:robots.httpStatus || 0}),
        budgets: { documents: count, bytes },
        retry: result.status === 'pending' ? { automatic: false, action: 'manual_refresh' } : null };
    },
  };
}
