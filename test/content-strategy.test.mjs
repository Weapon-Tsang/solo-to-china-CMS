import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { CONTENT_STRATEGY, getContentStrategy } from "../src/content-strategy.mjs";
import { contentBlockSummary, markdownToContentBlocks } from "../src/content-blocks.mjs";

test("active content strategy manifest resolves its immutable specification", () => {
  assert.match(CONTENT_STRATEGY.version, /^\d+\.\d+$/);
  assert.equal(getContentStrategy().status, "active");
  assert.ok(fs.existsSync(path.resolve(CONTENT_STRATEGY.document)));
  assert.match(fs.readFileSync(path.resolve(CONTENT_STRATEGY.document), "utf8"), new RegExp(`Content Production Strategy ${CONTENT_STRATEGY.version.replace(".", "\\.")}`));
});

test("structured content blocks preserve article hierarchy without rendering HTML", () => {
  const blocks = markdownToContentBlocks("## Quick answer\n\nPractical answer.\n\n- One\n- Two\n\n## Frequently asked questions");
  assert.deepEqual(blocks[0], { type: "heading", level: 2, text: "Quick answer" });
  assert.equal(blocks[2].type, "list");
  assert.deepEqual(contentBlockSummary(blocks), { paragraphs: 1, headings: 2, lists: 1, faq: true });
});
