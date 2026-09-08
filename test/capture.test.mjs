import assert from "node:assert/strict";
import test from "node:test";
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
