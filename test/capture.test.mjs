import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { normalizeXiaohongshuCapture, ValidationError } from "../src/adapters/xiaohongshu.mjs";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";

test("Xiaohongshu adapter accepts only an explicitly opened note and removes tracking", () => {
  const capture = normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/abc123?utm_source=share&xsec_token=secret&keep=yes",
    title: "Beijing note",
    text: "This is enough visible content from the manually opened note.",
    images: [{ url: "https://example.com/a.jpg", alt: "photo" }],
  });
  assert.equal(capture.externalId, "abc123");
  assert.equal(capture.canonicalUrl, "https://www.xiaohongshu.com/explore/abc123?keep=yes");
  assert.equal(capture.assets.length, 1);

  const boardCapture = normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/board/board123/abc123?xsec_token=temporary&xsec_source=pc_feed",
    title: "Beijing note",
    text: "This is enough visible content from the explicitly opened board note.",
  });
  assert.equal(boardCapture.externalId, "abc123");
  assert.equal(boardCapture.canonicalUrl, "https://www.xiaohongshu.com/explore/abc123");

  assert.throws(() => normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/search_result?keyword=beijing",
    text: "This page has lots of text but is not a manually selected note.",
  }), ValidationError);
});

test("capture storage is idempotent and preserves content revisions", (t) => {
  const fixture = repositoryFixture(t);
  const capture = normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/source1",
    title: "Shanghai solo guide",
    text: "A practical Shanghai solo travel note with useful details.",
    images: [],
  });
  const first = fixture.repository.saveCapture(capture);
  const duplicate = fixture.repository.saveCapture(capture);
  const revision = fixture.repository.saveCapture({ ...capture, rawText: `${capture.rawText} Updated.` });

  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(revision.id, first.id);
  assert.equal(fixture.repository.getSource(first.id).capture_version, 2);
  const queued = fixture.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type = 'extract_source' AND status = 'queued'").get().count;
  assert.equal(queued, 1);
});

test("duplicate recapture restores authorized image bytes without creating a content revision", (t) => {
  const fixture = repositoryFixture(t);
  const originalSha256 = "a".repeat(64);
  const input = { url:"https://www.xiaohongshu.com/explore/media-refresh",title:"Authorized Chongqing view",
    text:"A sufficiently detailed authorized note about a real Chongqing travel scene.",
    images:[{url:"https://sns-img.xhscdn.com/refresh.jpg",mediaIdentity:"photo-1",originalSha256,mimeType:"image/jpeg"}] };
  const first = fixture.repository.saveCapture(normalizeXiaohongshuCapture(input));
  assert.equal(fixture.db.prepare("SELECT ai_derivative_data_url FROM source_assets WHERE source_id=?").get(first.id).ai_derivative_data_url, "");
  const assetId = fixture.db.prepare("SELECT id FROM source_assets WHERE source_id=?").get(first.id).id;
  fixture.db.prepare(`INSERT INTO topic_candidates(id,destination_slug,topic_key,proposed_title,rationale,coverage_score,evidence_count,conflict_count,status,created_at,updated_at)
    VALUES ('topic-media','chongqing','media','Media recovery','fixture',80,1,0,'drafted','now','now')`).run();
  fixture.db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at,candidate_id)
    VALUES ('brief-media','chongqing','Media recovery','[]','informational','drafted','now','now','topic-media')`).run();
  fixture.db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at,revision,content_hash)
    VALUES ('draft-media','brief-media','Media recovery','media-recovery','Body.','{}','exception','now','now',1,'hash-media')`).run();
  fixture.db.prepare(`INSERT INTO article_visuals(id,draft_id,slot,placement,purpose,alt_text,generation_prompt,created_at,updated_at,source_asset_id)
    VALUES ('visual-media','draft-media',0,'hero','Recovered view','View','','now','now',?)`).run(assetId);
  const second = fixture.repository.saveCapture(normalizeXiaohongshuCapture({ ...input,images:[{...input.images[0],
    aiDerivativeDataUrl:"data:image/jpeg;base64,aGVsbG8=",aiDerivativeSha256:originalSha256}] }));
  assert.equal(second.duplicate,true);
  assert.equal(second.captureVersion,1);
  assert.equal(second.restoredAssets,1);
  assert.deepEqual(second.resumedDraftIds,['draft-media']);
  assert.equal(fixture.db.prepare("SELECT ai_derivative_data_url FROM source_assets WHERE source_id=?").get(first.id).ai_derivative_data_url,
    "data:image/jpeg;base64,aGVsbG8=");
  assert.equal(fixture.db.prepare("SELECT COUNT(*) count FROM jobs WHERE type='extract_source'").get().count,0);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) count FROM jobs WHERE type='repair_media_asset'").get().count,1);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) count FROM jobs WHERE type='compose_frontend_page'").get().count,1);
  const repeated = fixture.repository.saveCapture(normalizeXiaohongshuCapture({ ...input,images:[{...input.images[0],
    aiDerivativeDataUrl:"data:image/jpeg;base64,aGVsbG8=",aiDerivativeSha256:originalSha256}] }));
  assert.equal(repeated.restoredAssets,0);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) count FROM jobs WHERE type='compose_frontend_page'").get().count,1);
});

test("capture parser records edited source time separately from capture time", () => {
  const source = fs.readFileSync(new URL("../extension/capture-utils.js",import.meta.url),"utf8");
  const context = { Date };
  context.globalThis = context;
  vm.runInNewContext(source,context);
  const parsed = context.SoloToChinaCaptureUtils.parseSourceDate("编辑于 2026年9月8日 18:30",new Date("2026-09-10T12:00:00+08:00"));
  assert.equal(parsed.kind,"edited");
  assert.equal(parsed.confidence,"high");
  const relative = context.SoloToChinaCaptureUtils.parseSourceDate("发布于 2 天前",new Date("2026-09-10T12:00:00+08:00"));
  assert.equal(relative.kind,"published");
  assert.equal(relative.confidence,"low");
  const capture = normalizeXiaohongshuCapture({ url:"https://www.xiaohongshu.com/explore/source-time",title:"Dated note",
    text:"A sufficiently detailed note with an explicit source editing timestamp.",publishedAt:parsed.value,sourceTimestamp:parsed });
  assert.equal(capture.submissionMetadata.sourceTimestamp.kind,"edited");
  assert.equal(capture.publishedAt,null);
});

test("authorized source images are saved as verified local files with nearby text relations", (t) => {
  const fixture = repositoryFixture(t);
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const bytes = Buffer.from(base64, "base64");
  const originalSha256 = createHash("sha256").update(bytes).digest("hex");
  const capture = normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/saved-image-bytes",
    title: "Saved authorized image",
    text: "A selected note with a real scene and enough nearby explanatory text.",
    images: [{
      url: "https://sns-img.xhscdn.com/original.png", mimeType: "image/jpeg", originalSha256,
      originalDataUrl: `data:image/png;base64,${base64}`,
      nearbyText: "The east entrance beside the metro exit.", captionText: "East entrance", domOrder: 7,
    }],
  });
  const saved = fixture.repository.saveCapture(capture);
  const asset = fixture.db.prepare("SELECT * FROM source_assets WHERE source_id=?").get(saved.id);
  assert.equal(asset.storage_status, "saved");
  assert.equal(asset.original_bytes_status, "saved_original");
  assert.equal(asset.mime_type, "image/png");
  assert.equal(asset.stored_sha256, originalSha256);
  assert.equal(asset.stored_size_bytes, bytes.length);
  assert.equal(asset.nearby_text, "The east entrance beside the metro exit.");
  assert.equal(asset.caption_text, "East entrance");
  assert.equal(asset.dom_order, 7);
  assert.equal(fs.readFileSync(asset.local_path).equals(bytes), true);
});

test("capture identity uses the Xiaohongshu note ID before transient share URLs", (t) => {
  const fixture = repositoryFixture(t);
  const first = normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/identity1?source=share&xsec_token=first",
    title: "Chengdu booking notes",
    text: "A detailed Chengdu travel note with enough practical booking information.",
  });
  const changedShareUrl = normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/identity1?channel=desktop&xsec_token=second",
    title: "Chengdu booking notes",
    text: "A detailed Chengdu travel note with enough practical booking information.",
  });

  const saved = fixture.repository.saveCapture(first);
  const duplicate = fixture.repository.saveCapture(changedShareUrl);

  assert.equal(duplicate.id, saved.id);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.queued, false);
  assert.equal(duplicate.identity.externalId, "identity1");
  assert.equal(fixture.repository.listSources().length, 1);
  const queued = fixture.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type = 'extract_source' AND status = 'queued'").get().count;
  assert.equal(queued, 1);
});

test("Xiaohongshu capture retains large text, large DOM, every image and video with owner-confirmed rights", (t) => {
  const fixture = repositoryFixture(t);
  const text = `${"完整正文段落。".repeat(22_000)}尾部证据`;
  const html = `<article>${"完整 DOM 内容".repeat(250_000)}<span>DOM 尾部证据</span></article>`;
  const images = Array.from({ length: 90 }, (_, index) => ({
    url: `https://sns-img.xhscdn.com/image-${index}.jpg`, mediaIdentity: `image-${index}`, width: 2400, height: 1600,
  }));
  const videos = Array.from({ length: 3 }, (_, index) => ({
    url: `https://sns-video.xhscdn.com/video-${index}.mp4`, mediaIdentity: `video-${index}`, duration: 30 + index,
  }));
  const capture = normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/lossless-note", title: "Lossless favorite", text, html, images, videos,
    acquisitionOrigin: "xhs_favorites_sync", syncScopeKey: "scope:fixture", client: { extensionVersion: "1.17.0" },
    completeness: {
      text: { complete: true }, dom: { complete: true },
      images: { expected: 90, captured: 90, complete: true, traversed: true },
      videos: { expected: 3, captured: 3, complete: true, traversed: true }, overall: "complete",
    },
  });
  assert.equal(capture.rawText, text);
  assert.equal(capture.rawText.endsWith("尾部证据"), true);
  assert.equal(capture.rawHtml, html);
  assert.equal(capture.rawHtml.includes("DOM 尾部证据"), true);
  assert.equal(capture.assets.length, 93);
  assert.equal(capture.rights.authorizationStatus, "owner_confirmed");
  assert.equal(capture.rights.publishable, true);
  const saved = fixture.repository.saveCapture(capture);
  const source = fixture.repository.getSource(saved.id);
  assert.equal(source.raw_text, text);
  assert.equal(source.raw_html, html);
  assert.equal(source.assets.length, 93);
  assert.equal(source.publishable, true);
  assert.equal(source.capture_versions[0].capture_version, 1);
  assert.equal(source.assets.every((asset) => asset.publishable), true);
});

test("partial capture is persisted but blocked from extraction and can upgrade to complete without changing source identity", (t) => {
  const fixture = repositoryFixture(t);
  const base = {
    url: "https://www.xiaohongshu.com/explore/partial-note", title: "Partial note",
    text: "A complete-looking text body whose media traversal has not finished yet.", images: [], videos: [],
    acquisitionOrigin: "xhs_favorites_sync",
  };
  const partial = normalizeXiaohongshuCapture({ ...base, completeness: {
    text: { complete: true }, dom: { complete: true }, images: { expected: 1, captured: 0, complete: false, traversed: false },
    videos: { expected: 0, captured: 0, complete: true, traversed: true }, overall: "partial_retryable",
  } });
  const first = fixture.repository.saveCapture(partial);
  assert.equal(first.queued, false);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count, 0);
  assert.throws(() => fixture.repository.prepareSourceSegments(first.id), (error) => error.code === "SOURCE_CAPTURE_PARTIAL");
  assert.deepEqual(fixture.repository.checkCaptureIdentities([{ externalId: "partial-note", url: base.url }])
    .map((item) => ({ known: item.known, needsRecapture: item.needsRecapture })), [{ known: false, needsRecapture: true }]);

  const complete = normalizeXiaohongshuCapture({ ...base, completeness: {
    text: { complete: true }, dom: { complete: true }, images: { expected: 0, captured: 0, complete: true, traversed: true },
    videos: { expected: 0, captured: 0, complete: true, traversed: true }, overall: "complete",
  } });
  const upgraded = fixture.repository.saveCapture(complete);
  assert.equal(upgraded.id, first.id);
  assert.equal(upgraded.duplicate, false);
  assert.equal(upgraded.captureVersion, 2);
  assert.equal(upgraded.queued, true);
  assert.equal(fixture.repository.getSource(first.id).capture_versions.length, 2);
});

test("batch identity lookup returns known and unknown notes in one query-sized request", (t) => {
  const fixture = repositoryFixture(t);
  const capture = normalizeXiaohongshuCapture({ url: "https://www.xiaohongshu.com/explore/known-batch", title: "Known",
    text: "Enough captured evidence to create a stable known identity for batch lookup." });
  const saved = fixture.repository.saveCapture(capture);
  const items = fixture.repository.checkCaptureIdentities([
    { externalId: "known-batch", url: "https://www.xiaohongshu.com/explore/known-batch?xsec_token=changed" },
    { externalId: "unknown-batch", url: "https://www.xiaohongshu.com/explore/unknown-batch" },
  ]);
  assert.equal(items[0].known, true);
  assert.equal(items[0].sourceId, saved.id);
  assert.equal(items[1].known, false);
});
