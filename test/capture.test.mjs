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
