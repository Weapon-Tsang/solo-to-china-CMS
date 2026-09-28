import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { openDatabase } from "../src/db.mjs";
import { createApplication } from "../src/server.mjs";
import { markLocalDataRoot } from "../src/local-runtime.mjs";
import { WordPressDraftAdapter } from "../src/wordpress.mjs";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

test("an independent HTTP receiver retains draft JSON and uploaded image after CMS stops", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cms-delivery-"));
  const dataRoot = path.join(root, "cms-data");
  const receiverRoot = path.join(root, "receiver-data");
  fs.mkdirSync(dataRoot);
  fs.mkdirSync(receiverRoot);
  const imagePath = path.join(dataRoot, "cover.png");
  fs.writeFileSync(imagePath, png);
  markLocalDataRoot(loadConfig({ CMS_RUN_MODE: "development", CMS_DATA_ROOT: dataRoot }), "development");
  openDatabase(path.join(dataRoot, "solo-to-china.sqlite")).close();
  const receiver = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://receiver.test");
    if (request.method === "POST" && url.pathname === "/wp-json/wp/v2/media") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      fs.writeFileSync(path.join(receiverRoot, "media.png"), Buffer.concat(chunks));
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: 1, source_url: "https://receiver.test/media/1.png",
        mime_type: "image/png", media_details: { width: 1, height: 1, sizes: {} } }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/wp-json/wp/v2/posts") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      fs.writeFileSync(path.join(receiverRoot, "post.json"), Buffer.concat(chunks));
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: 7, status: "draft", link: "https://receiver.test/posts/7" }));
      return;
    }
    if (url.pathname === "/media/1.png" && fs.existsSync(path.join(receiverRoot, "media.png"))) {
      response.writeHead(200, { "content-type": "image/png" });
      fs.createReadStream(path.join(receiverRoot, "media.png")).pipe(response);
      return;
    }
    if (url.pathname === "/posts/7" && fs.existsSync(path.join(receiverRoot, "post.json"))) {
      response.writeHead(200, { "content-type": "application/json" });
      fs.createReadStream(path.join(receiverRoot, "post.json")).pipe(response);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  let app;
  try {
    await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    const receiverUrl = `http://127.0.0.1:${receiver.address().port}`;
    const localFetch = (url, options) => fetch(String(url).replace("https://receiver.test", receiverUrl), options);
    app = createApplication(loadConfig({ CMS_RUN_MODE: "development", CMS_DATA_ROOT: dataRoot,
      CMS_PROCESS_ROLE: "api", HOST: "127.0.0.1", PORT: "0", MAINTENANCE_ENABLED: "false", NODE_TEST_CONTEXT: "1", LOG_LEVEL: "error" }));
    await app.start();
    const adapter = new WordPressDraftAdapter({ siteUrl: "https://receiver.test", username: "editor",
      applicationPassword: "fixture", contentFormat: "blocks" }, localFetch);
    const result = await adapter.upsertDraft({ title: "Isolated delivery", slug: "isolated-delivery",
      meta_description: "Fixture", body_markdown: "## Guide\n\nContent remains in the receiver.",
      visuals: [{ id: "cover", status: "generated", media_path: imagePath, alt_text: "One pixel cover",
        caption: "Fixture", image_role: "cover" }] });
    assert.equal(result.postId, 7);
    assert.equal(result.visuals[0].url, "https://receiver.test/media/1.png");
    await app.stop();
    app = null;
    fs.rmSync(imagePath);
    const [postResponse, mediaResponse] = await Promise.all([
      localFetch("https://receiver.test/posts/7"), localFetch("https://receiver.test/media/1.png"),
    ]);
    assert.equal(postResponse.status, 200);
    assert.equal(mediaResponse.status, 200);
    const storedPost = await postResponse.json();
    assert.equal(storedPost.status, "draft");
    assert.equal(storedPost.featured_media, 1);
    assert.equal(JSON.stringify(storedPost).includes(dataRoot), false);
    assert.deepEqual(Buffer.from(await mediaResponse.arrayBuffer()), png);
  } finally {
    if (app) await app.stop();
    if (receiver.listening) await new Promise((resolve) => receiver.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a receiver write with a lost response is read back before publishing again", async (t) => {
  const { db, repository, directory } = repositoryFixture(t);
  db.prepare(`INSERT INTO topic_candidates(id,destination_slug,topic_key,proposed_title,rationale,coverage_score,evidence_count,conflict_count,status,created_at,updated_at)
    VALUES ('lost-topic','beijing','lost','Lost response','fixture',80,1,0,'drafted','now','now')`).run();
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at,candidate_id)
    VALUES ('lost-brief','beijing','Lost response','[]','informational','drafted','now','now','lost-topic')`).run();
  db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at,revision,content_hash)
    VALUES ('lost-draft','lost-brief','Lost response','lost-response','Body.','{}','wordpress_draft','now','now',1,'lost-hash')`).run();
  db.prepare(`INSERT INTO wordpress_publications(id,draft_id,site_url,post_id,status,created_at,updated_at)
    VALUES ('lost-wp','lost-draft','https://receiver.test',42,'synced','now','now')`).run();
  const receiptPath = path.join(directory, 'receiver-published.json');
  let writes = 0;
  const receiver = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://receiver.test').pathname;
    if (request.method === 'POST' && pathname === '/wp-json/wp/v2/posts/42') {
      for await (const _chunk of request) { /* consume the complete request before persisting */ }
      writes++;
      fs.writeFileSync(receiptPath, JSON.stringify({ id:42, status:'publish', slug:'lost-response',
        title:{ rendered:'Lost response' }, link:'https://receiver.test/posts/42' }));
      request.socket.destroy(); // The response is lost after the independent receiver persisted it.
      return;
    }
    if (request.method === 'GET' && pathname === '/wp-json/wp/v2/posts/42'
      && fs.existsSync(receiptPath)) {
      response.writeHead(200, { 'content-type':'application/json' });
      response.end(fs.readFileSync(receiptPath));
      return;
    }
    response.writeHead(404); response.end();
  });
  try {
    await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
    const localUrl = `http://127.0.0.1:${receiver.address().port}`;
    const adapter = new WordPressDraftAdapter({ siteUrl:'https://receiver.test', username:'editor',
      applicationPassword:'fixture' }, (url, options) => fetch(String(url).replace('https://receiver.test', localUrl), options));
    repository.beginWordPressPublishAttempt('lost-draft', 42, 'lost-job');
    await assert.rejects(adapter.publishPost(42, { idempotencyKey:'lost-job' }));
    repository.markWordPressPublishUnknown('lost-draft');
    assert.equal(writes, 1);
    assert.throws(() => repository.beginWordPressPublishAttempt('lost-draft', 42, 'duplicate-job'),
      { code:'WORDPRESS_PUBLISH_OUTCOME_UNKNOWN' });
    const verified = await adapter.getPost(42);
    assert.equal(verified.status, 'publish');
    repository.completeWordPressPublish('lost-draft', verified);
    assert.equal(writes, 1);
    assert.equal(db.prepare("SELECT state FROM wordpress_publish_attempts WHERE draft_id='lost-draft'").get().state,
      'completed');
  } finally {
    if (receiver.listening) await new Promise(resolve => receiver.close(resolve));
  }
});
