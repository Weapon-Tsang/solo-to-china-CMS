import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import test from 'node:test';
import { createServer } from 'vite';

test('Content workbench renders published and draft WordPress state without crashing', async () => {
  const vite = await createServer({ configFile: 'vite.config.js', server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { ViewRenderer } = await vite.ssrLoadModule('/src/views.jsx');
    const items = ['publish', 'draft'].map((status) => ({
      opportunity_id: `article-${status}`,
      draft_id: `draft-${status}`,
      title: `Article ${status}`,
      wordpress_remote_status: status,
      production_state: { lifecycle: 'active', stage_status: 'waiting', available_actions: [] },
    }));
    const html = renderToString(createElement(ViewRenderer, {
      view: 'content', data: { items, sections: {} },
      onNavigate() {}, onOpenProduction() {}, onAction() {}, onLoadMoreContent() {},
    }));
    assert.match(html, /WordPress 已发布/);
    assert.match(html, /WordPress 草稿/);
    assert.match(html, /content-mobile-cards/);
    assert.match(html, /content-desktop-table/);
  } finally {
    await vite.close();
  }
});
