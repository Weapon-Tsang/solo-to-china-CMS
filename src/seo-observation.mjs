import { isIP } from 'node:net';
import { isPublicMediaAddress } from './safe-media-http.mjs';

// Pure observation helpers: no requests, settings changes or crawler impersonation.
// Domain DNS reachability still requires the bounded reader; this rejects known
// local literals before they can become public metadata or image URLs.
export function isPublicArtifactUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && !/(?:^|\.)(?:localhost|local|internal)$/.test(host)
      && (isIP(host) ? isPublicMediaAddress(host) : host.includes('.'));
  } catch { return false; }
}
export function normalizeObservedUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    url.hash = '';
    // Strip only known campaign attribution; preserve routing queries and slash semantics.
    for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch { return ''; }
}

export function structuredDataNodes(value) {
  if (Array.isArray(value)) return value.flatMap(structuredDataNodes);
  if (!value || typeof value !== 'object') return [];
  return [...(value['@type'] ? [value] : []), ...structuredDataNodes(value['@graph'])];
}

export function inspectRobotsTxt(text, { agent = 'Googlebot', path = '/', httpStatus = 200 } = {}) {
  if (text == null || httpStatus < 200 || httpStatus >= 300) {
    return { status: 'unknown', allowed: null, agent, httpStatus, reason: 'robots_response_unavailable' };
  }
  if (Buffer.byteLength(String(text)) > 512_000) return { status: 'unknown', allowed: null, agent, reason: 'robots_size_budget' };
  const groups = [];
  let group = null;
  let hasRules = false;
  for (const line of String(text).replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    const match = line.replace(/#.*/, '').trim().match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase(), value = match[2].trim();
    if (key === 'user-agent') {
      if (!group || hasRules) { group = { agents: [], rules: [] }; groups.push(group); hasRules = false; }
      group.agents.push(value.toLowerCase());
    } else if (group && ['allow', 'disallow'].includes(key)) {
      hasRules = true;
      if (value.startsWith('/')) group.rules.push({ allow: key === 'allow', pattern: value });
    }
  }
  const name = agent.toLowerCase();
  const specificity = group => Math.max(-1, ...group.agents.map(token => token === '*' ? 0 : token && name.startsWith(token) ? token.length : -1));
  const best = Math.max(-1, ...groups.map(specificity));
  const selected = groups.filter(group => specificity(group) === best && best >= 0);
  const candidate = encodedPath(path);
  const matches = selected.flatMap(group => group.rules).filter(rule => {
    const pattern = encodedPath(rule.pattern);
    const anchored = pattern.endsWith('$');
    const parts = (anchored ? pattern.slice(0, -1) : pattern).split('*');
    // Match wildcard segments without a backtracking regexp on untrusted input.
    let cursor = 0;
    if (!candidate.startsWith(parts[0])) return false;
    cursor = parts[0].length;
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      const found = anchored && i === parts.length - 1 ? candidate.length - part.length : candidate.indexOf(part, cursor);
      if (found < cursor || candidate.slice(found, found + part.length) !== part) return false;
      cursor = found + part.length;
    }
    return !anchored || cursor === candidate.length;
  }).map(rule => ({ ...rule, length: encodedPath(rule.pattern).replace(/%[\dA-F]{2}/g, 'x').replace(/\*/g, '').replace(/\$$/, '').length }));
  matches.sort((a, b) => b.length - a.length || Number(b.allow) - Number(a.allow));
  return { status: 'observed', allowed: matches[0]?.allow ?? true, agent, httpStatus,
    groups: selected.map(group => group.agents), matchedRule: matches[0] || null };
}

function encodedPath(value) {
  return String(value).replace(/[^\x00-\x7F]/gu, character => encodeURIComponent(character))
    .replace(/%[\da-f]{2}/gi, octet => {
      const character = String.fromCharCode(parseInt(octet.slice(1), 16));
      return /[a-z\d._~-]/i.test(character) ? character : octet.toUpperCase();
    });
}

export function inspectIndexDirectives({ meta = [], headers = {}, agent = 'googlebot' } = {}) {
  const directives = [];
  const name = agent.toLowerCase();
  const add = (value, source) => {
    for (const token of String(value).toLowerCase().split(/[\s,]+/).filter(Boolean)) {
      directives.push({ token, source });
      if (token === 'none') directives.push({ token: 'noindex', source }, { token: 'nofollow', source });
      if (token === 'all') directives.push({ token: 'index', source }, { token: 'follow', source });
    }
  };
  for (const item of meta) if (['robots', name].includes(String(item.name).toLowerCase())) add(item.content, `meta:${item.name}`);
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'x-robots-tag') continue;
    for (const entry of [value].flat()) {
      let scope = '*';
      for (const part of String(entry).split(',')) {
        const scoped = part.trim().match(/^([\w-]+):\s*(.*)$/);
        if (scoped && !['max-snippet', 'max-image-preview', 'max-video-preview', 'unavailable_after'].includes(scoped[1].toLowerCase())) {
          scope = scoped[1].toLowerCase();
          if (scope === '*' || scope === name) add(scoped[2], `header:${scope}`);
        } else if (scope === '*' || scope === name) add(part, `header:${scope}`);
      }
    }
  }
  const tokens = new Set(directives.map(item => item.token));
  return { indexable: !tokens.has('noindex'), directives,
    conflicts: [['index', 'noindex'], ['follow', 'nofollow']].filter(pair => pair.every(token => tokens.has(token))) };
}
