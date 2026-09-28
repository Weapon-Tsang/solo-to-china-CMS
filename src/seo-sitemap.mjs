import { SaxesParser } from 'saxes';
import { normalizeObservedUrl } from './seo-observation.mjs';

const SITEMAP_NS = 'http://www.sitemaps.org/schemas/sitemap/0.9';

export function parseSitemap(xml, { maxBytes = 2_000_000, maxEntries = 50_000 } = {}) {
  if (!xml || Buffer.byteLength(String(xml)) > maxBytes) return { status: 'unknown', reason: 'missing_or_size_budget', urls: [], children: [] };
  const stack = [], urls = [], children = [];
  let root = null, loc = null;
  try {
    const parser = new SaxesParser({ xmlns: true });
    parser.on('doctype', () => { throw new Error('doctype_forbidden'); });
    parser.on('opentag', node => {
      stack.push(node);
      if (stack.length > 32) throw new Error('depth_budget');
      if (stack.length === 1) {
        if (!['urlset', 'sitemapindex'].includes(node.local) || !['', SITEMAP_NS].includes(node.uri)) throw new Error('invalid_sitemap_root');
        root = node.local;
      }
      if (stack.length === 3 && node.local === 'loc' && node.uri === stack[0].uri
        && stack[1].uri === stack[0].uri && stack[1].local === (root === 'urlset' ? 'url' : 'sitemap')) loc = '';
      else if (loc !== null) throw new Error('nested_loc');
    });
    const append = text => { if (loc !== null) loc += text; };
    parser.on('text', append);
    parser.on('cdata', append);
    parser.on('closetag', () => {
      if (loc !== null && stack.length === 3) {
        const url = normalizeObservedUrl(loc.trim());
        if (!url) throw new Error('invalid_loc');
        (root === 'urlset' ? urls : children).push(url);
        if (urls.length + children.length > maxEntries) throw new Error('entry_budget');
        loc = null;
      }
      stack.pop();
    });
    parser.write(String(xml)).close();
    return { status: 'parsed', root, urls, children };
  } catch (error) { return { status: 'unknown', reason: error.message, urls: [], children: [] }; }
}

// Child documents must already have been acquired by an authorized bounded reader.
// Missing children are unknown, never evidence that the article is absent.
export function inspectSitemap(xml, targetUrl, { documents = {}, maxDocuments = 20, maxDepth = 3, maxTotalBytes = 4_000_000, ...parseOptions } = {}) {
  const target = normalizeObservedUrl(targetUrl);
  if (!target) return { status: 'unknown', included: null, reason: 'invalid_target' };
  let count = 0, bytes = 0, incomplete = false, found = false;
  const visited = new Set(), observations = [];
  function walk(input, depth, url = 'root') {
    bytes += Buffer.byteLength(String(input || ''));
    if (++count > maxDocuments || depth > maxDepth || bytes > maxTotalBytes) { incomplete = true; return; }
    const parsed = parseSitemap(input, parseOptions);
    observations.push({ url, status: parsed.status, reason: parsed.reason || null });
    if (parsed.status !== 'parsed') { incomplete = true; return; }
    if (parsed.urls.includes(target)) found = true;
    for (const child of parsed.children) {
      if (visited.has(child)) { incomplete = true; continue; }
      visited.add(child);
      if (!Object.hasOwn(documents, child)) { incomplete = true; continue; }
      walk(documents[child], depth + 1, child);
    }
  }
  walk(xml, 0);
  return { status: found ? 'present' : incomplete ? 'unknown' : 'absent', included: found ? true : incomplete ? null : false, observations };
}
