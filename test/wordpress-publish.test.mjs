import assert from 'node:assert/strict';
import test from 'node:test';
import { repositoryFixture } from '../test-support/repository-fixture.mjs';
import { WordPressDraftAdapter } from '../src/wordpress.mjs';

function publishedFixture(t) {
  const fixture = repositoryFixture(t);
  const { db } = fixture;
  db.prepare(`INSERT INTO topic_candidates(id,destination_slug,topic_key,proposed_title,rationale,coverage_score,evidence_count,conflict_count,status,created_at,updated_at)
    VALUES ('publish-topic','beijing','publish','Publish','fixture',80,1,0,'drafted','now','now')`).run();
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at,candidate_id)
    VALUES ('publish-brief','beijing','Publish','[]','informational','drafted','now','now','publish-topic')`).run();
  db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at,revision,content_hash)
    VALUES ('publish-draft','publish-brief','Publish','publish','Body.','{}','wordpress_draft','now','now',1,'hash-publish')`).run();
  db.prepare(`INSERT INTO wordpress_publications(id,draft_id,site_url,post_id,status,created_at,updated_at)
    VALUES ('publish-wp','publish-draft','https://site.test',42,'synced','now','now')`).run();
  return fixture;
}

test('WordPress inventory reconciles external publication and later unpublish by exact post ID', (t) => {
  const { db, repository } = publishedFixture(t);
  repository.replaceWordPressInventory('https://site.test', [{ postId: 42, slug: 'publish', title: 'Publish',
    status: 'publish', postUrl: 'https://site.test/publish', modifiedAt: '2026-09-22T00:00:00Z' }]);
  assert.equal(db.prepare('SELECT status FROM article_drafts WHERE id=?').get('publish-draft').status, 'published');
  assert.equal(repository.listWordPressPublicationStates()[0].delivery_state, 'published');
  repository.replaceWordPressInventory('https://site.test', [{ postId: 42, slug: 'publish', title: 'Publish',
    status: 'draft', postUrl: 'https://site.test/?p=42', modifiedAt: '2026-09-22T01:00:00Z' }]);
  assert.equal(db.prepare('SELECT status FROM article_drafts WHERE id=?').get('publish-draft').status, 'wordpress_draft');
});

test('WordPress inventory reports remote publication without clearing a local review blocker', (t) => {
  const { db, repository } = publishedFixture(t);
  db.prepare("UPDATE article_drafts SET status='needs_review' WHERE id='publish-draft'").run();
  repository.replaceWordPressInventory('https://site.test', [{ postId: 42, slug: 'publish', title: 'Publish',
    status: 'publish', postUrl: 'https://site.test/publish', modifiedAt: '2026-09-22T00:00:00Z' }]);
  const state = repository.listWordPressPublicationStates()[0];
  assert.equal(state.draft_status, 'needs_review');
  assert.equal(state.remote_status, 'publish');
  assert.equal(state.delivery_state, 'needs_review');
});

test('publish attempt persists an unknown result and prevents blind resend', (t) => {
  const { db, repository } = publishedFixture(t);
  repository.beginWordPressPublishAttempt('publish-draft', 42, 'job-1');
  repository.markWordPressPublishUnknown('publish-draft');
  assert.throws(() => repository.beginWordPressPublishAttempt('publish-draft', 42, 'job-2'),
    { code: 'WORDPRESS_PUBLISH_OUTCOME_UNKNOWN' });
  repository.completeWordPressPublish('publish-draft', { id: 42, status: 'publish', slug: 'publish',
    title: { rendered: 'Publish' }, link: 'https://site.test/publish' });
  assert.equal(db.prepare('SELECT status FROM article_drafts WHERE id=?').get('publish-draft').status, 'published');
  assert.equal(db.prepare('SELECT state FROM wordpress_publish_attempts WHERE draft_id=?').get('publish-draft').state, 'completed');
});

test('WordPress publish adapter writes only the status transition and verifies the receipt', async () => {
  let body;
  const adapter = new WordPressDraftAdapter({ siteUrl: 'https://site.test', username: 'editor',
    applicationPassword: 'secret' }, async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({ id: 42, status: 'publish', link: 'https://site.test/publish' }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const result = await adapter.publishPost(42, { idempotencyKey: 'job-1' });
  assert.deepEqual(body, { status: 'publish' });
  assert.equal(result.status, 'publish');
});
