import { parseHTML } from 'linkedom';

// Static evidence only: external stylesheets and computed browser visibility need
// separate browser observations. Never execute scripts while inspecting an artifact.
export function parseSeoHtml(html) {
  return parseHTML(String(html || '')).document;
}

export function isStaticallyHidden(node) {
  for (let current = node; current?.nodeType === 1; current = current.parentElement) {
    if (['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT'].includes(current.tagName)
      || current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true'
      || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|content-visibility\s*:\s*hidden)\s*(?:!important)?\s*(?:;|$)/i.test(current.getAttribute('style') || '')) return true;
  }
  return false;
}

export function visibleText(node) {
  if (!node || isStaticallyHidden(node)) return '';
  if (node.nodeType === 3) return node.textContent;
  return [...node.childNodes].map(visibleText).join(' ').replace(/\s+/g, ' ').trim();
}

export function articleVisibleText(html) {
  const doc = parseSeoHtml(html);
  const articles = [...doc.querySelectorAll('article')].filter(node => !node.parentElement?.closest('article'));
  const nodes = articles.length ? articles : [...doc.querySelectorAll('main')];
  return nodes.map(visibleText).join(' ').replace(/\s+/g, ' ').trim();
}

export function htmlText(value) {
  return visibleText(parseSeoHtml(`<html><body><div>${String(value || '')}</div></body></html>`).querySelector('div'));
}

export function elementAttributes(node) {
  return Object.fromEntries([...node.attributes].map(item => [item.name.toLowerCase(), item.value]));
}
