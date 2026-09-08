import assert from "node:assert/strict";
import test from "node:test";
import { normalizeXiaohongshuCapture } from "../src/adapters/xiaohongshu.mjs";
import { Pipeline } from "../src/pipeline.mjs";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";

test("model output exhaustion resegments source evidence instead of dropping claims or source tail", async (t) => {
  const { db, repository } = repositoryFixture(t);
  const rawText = `${"A".repeat(1_400)}TAIL-EVIDENCE`;
  const saved = repository.saveCapture(normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/output-limit", title: "Output limit", text: rawText,
  }));
  const extractor = {
    async extract(source) {
      if (source.raw_text.length > 800) throw Object.assign(new Error("model output token limit"), { code: "MODEL_OUTPUT_LIMIT", retryable: true });
      return { result: { source: { language: "en", summary: "segment", destination_name: "Unknown", destination_slug: "unknown",
        traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.5 }, claims: [],
        blueprint: { format: "pending", hook: "", angle: "", sections: [], strengths: [], gaps: [] } }, method: "fixture", model: "fixture" };
    },
  };
  const pipeline = new Pipeline(repository, extractor, { maxConcurrent: 1 });
  assert.equal(await pipeline.runOne(), true); // extract_source -> preflight
  assert.equal(await pipeline.runOne(), true); // preflight -> segment
  assert.equal(await pipeline.runOne(), true); // segment -> extraction
  assert.equal(await pipeline.runOne(), true); // output limit -> two smaller segments
  const segments = db.prepare("SELECT raw_text FROM source_segments WHERE source_id=? ORDER BY sequence").all(saved.id);
  assert.equal(segments.length, 2);
  assert.equal(segments.map((item) => item.raw_text).join(""), rawText);
  assert.equal(segments.at(-1).raw_text.endsWith("TAIL-EVIDENCE"), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type='extract_segment_claims' AND status='queued'").get().count, 2);
});

test("CMS extraction concurrency grows only after sustained success and immediately backs off on transient pressure", () => {
  const pipeline = new Pipeline({}, {}, { extractionConfig: { concurrencyMode: "auto", concurrencyInitial: 4, concurrencyMax: 8, concurrencySuccessWindow: 12 } });
  const job = { type: "generate_draft" };
  for (let index = 0; index < 11; index += 1) pipeline.recordExtractionOutcome(job, { ok: true });
  assert.equal(pipeline.maxConcurrent, 4);
  pipeline.recordExtractionOutcome(job, { ok: true });
  assert.equal(pipeline.maxConcurrent, 5);
  pipeline.recordExtractionOutcome(job, { ok: false, error: Object.assign(new Error("rate limit"), { provider: "vertex", status: 429, retryable: true }) });
  assert.equal(pipeline.maxConcurrent, 2);
});
