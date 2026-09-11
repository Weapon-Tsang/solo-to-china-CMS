import assert from "node:assert/strict";
import test from "node:test";
import { normalizeXiaohongshuCapture } from "../src/adapters/xiaohongshu.mjs";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";

test("operational exception queue exposes and safely retries an exhausted generic job", (t) => {
  const { db, repository } = repositoryFixture(t);
  const jobId = repository.enqueue("plan_content", "missing-topic");
  db.prepare("UPDATE jobs SET status='failed', attempts=3, last_error='planner unavailable' WHERE id=?").run(jobId);
  const exception = repository.listOperationalExceptions().find((item) => item.key === `job:${jobId}`);
  assert.equal(exception.severity, "blocker");
  assert.equal(exception.retryable, true);
  assert.equal(repository.retryOperationalException(exception.key), true);
  const job = db.prepare("SELECT status, attempts, last_error FROM jobs WHERE id=?").get(jobId);
  assert.equal(job.status, "queued");
  assert.equal(job.attempts, 0);
  assert.equal(job.last_error, null);
});

test("operational exception queue refuses a no-op retry for permanent provider and asset failures", (t) => {
  const { db, repository } = repositoryFixture(t);
  const providerJobId = repository.enqueue("compose_frontend_page", "draft-provider-400");
  db.prepare("UPDATE jobs SET status='failed', attempts=3, last_error='Vertex Gemini request failed (400): Request contains an invalid argument.' WHERE id=?").run(providerJobId);
  const assetJobId = repository.enqueue("compose_frontend_page", "draft-asset-403");
  db.prepare("UPDATE jobs SET status='failed', attempts=3, last_error='Authorized source image download failed (403).' WHERE id=?").run(assetJobId);

  const exceptions = repository.listOperationalExceptions();
  const providerException = exceptions.find((item) => item.key === `job:${providerJobId}`);
  const assetException = exceptions.find((item) => item.key === `job:${assetJobId}`);
  assert.equal(providerException.retryable, false);
  assert.equal(assetException.retryable, false);
  assert.match(providerException.title, /模型|页面/);
  assert.doesNotMatch(`${providerException.title} ${providerException.detail}`, /Vertex|invalid argument/i);
  assert.match(assetException.title, /图片/);
  assert.doesNotMatch(`${assetException.title} ${assetException.detail}`, /Authorized source image|403/i);
  assert.equal(repository.retryOperationalException(`job:${providerJobId}`), false);
  assert.equal(repository.retryOperationalException(`job:${assetJobId}`), false);
  assert.deepEqual(db.prepare("SELECT status FROM jobs WHERE id IN (?,?) ORDER BY id").all(providerJobId, assetJobId)
    .map((row) => row.status), ["failed", "failed"]);
});

test("browser media repair handoffs remain visible with accurate media guidance until repaired", (t) => {
  const { db, repository } = repositoryFixture(t);
  const source = repository.saveCapture(normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/media-repair-exception",
    title: "Media repair exception",
    text: "This selected source has enough text but its authorized original still needs browser repair.",
    images: [{ url: "https://sns-img.xhscdn.com/expired-original.jpg", mediaIdentity: "expired-original" }],
  }));
  const asset = db.prepare("SELECT id FROM source_assets WHERE source_id=?").get(source.id);
  const job = db.prepare("SELECT id FROM jobs WHERE type='repair_media_asset' AND entity_id=?").get(asset.id);
  db.prepare(`UPDATE jobs SET status='failed', attempts=3, failure_class='permanent_input',
    last_failure_code='REMOTE_MEDIA_403', last_error='Remote media returned HTTP 403.' WHERE id=?`).run(job.id);
  db.prepare(`UPDATE source_assets SET repair_status='browser_repair_required',
    storage_error='Remote media returned HTTP 403.' WHERE id=?`).run(asset.id);

  const repair = repository.listOperationalExceptions().find((item) => item.key === `job:${job.id}`);
  assert.match(repair.title, /原件.*浏览器修复/);
  assert.doesNotMatch(`${repair.title} ${repair.detail}`, /模型服务拒绝/);
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id=?").get(job.id).status, "failed");
  assert.equal(repository.mediaRepairManifest(source.id).mediaDurability.browserRepairRequired, 1);

  db.prepare("UPDATE source_assets SET durability_status='ORIGINAL_STORED', repair_status='not_needed' WHERE id=?").run(asset.id);
  assert.equal(repository.listOperationalExceptions().some((item) => item.key === `job:${job.id}`), false);
});

test("a derived draft exception inherits the permanent failed job retry decision", (t) => {
  const { db, repository } = repositoryFixture(t);
  db.prepare(`INSERT INTO topic_candidates(id,destination_slug,topic_key,proposed_title,rationale,coverage_score,evidence_count,conflict_count,status,created_at,updated_at)
    VALUES ('topic-derived','chongqing','derived','Derived guide','fixture',100,1,0,'drafted','now','now')`).run();
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at,candidate_id)
    VALUES ('brief-derived','chongqing','Derived guide','[]','informational','drafted','now','now','topic-derived')`).run();
  db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at,revision,content_hash)
    VALUES ('draft-derived','brief-derived','Derived guide','derived-guide','Body','{}','exception','now','now',1,'hash')`).run();
  const jobId = repository.enqueue("compose_frontend_page", "draft-derived");
  db.prepare("UPDATE jobs SET status='failed', attempts=3, last_error='Authorized source image download failed (403).' WHERE id=?").run(jobId);
  const exception = repository.listOperationalExceptions().find((item) => item.key === "draft:draft-derived");
  assert.equal(exception.retryable, false);
  assert.equal(repository.retryOperationalException(exception.key, { contractAware: true }), false);
});

test("a later successful job clears older duplicate failures from the active exception queue", (t) => {
  const { db, repository } = repositoryFixture(t);
  const failedId = repository.enqueue("resolve_entities", "chongqing");
  db.prepare("UPDATE jobs SET status='failed', attempts=3, last_error='invalid JSON', updated_at='2026-09-06T01:00:00.000Z' WHERE id=?").run(failedId);
  const recoveredId = repository.enqueue("resolve_entities", "chongqing");
  db.prepare("UPDATE jobs SET status='succeeded', completed_at='2026-09-06T01:01:00.000Z', updated_at='2026-09-06T01:01:00.000Z' WHERE id=?").run(recoveredId);
  assert.equal(repository.listOperationalExceptions().some((item) => item.key === `job:${failedId}`), false);
});

test("content navigation count includes briefs that need editorial action", (t) => {
  const { db, repository } = repositoryFixture(t);
  db.prepare(`
    INSERT INTO content_briefs(id, destination_slug, topic, audience, search_intent, status, last_error, created_at, updated_at)
    VALUES ('brief-action', 'chongqing', 'Action brief', '[]', 'informational', 'exception', 'planner failed', 'now', 'now')
  `).run();
  const dashboard = repository.dashboard();
  assert.equal(dashboard.actionCounts.content, 1);
  assert.equal(dashboard.totals.contentNeedsAttention, 1);
});

test("source retry resets a delayed queued extraction and never masks a running extraction as captured", (t) => {
  const { db, repository } = repositoryFixture(t);
  const source = repository.saveCapture(normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/retry-state",
    title: "Retry state",
    text: "This manually selected travel note has enough source text for a safe retry-state test.",
    images: [],
  }));
  const job = db.prepare("SELECT * FROM jobs WHERE type='extract_source' AND entity_id=?").get(source.id);
  db.prepare("UPDATE jobs SET attempts=2, available_at='2099-01-01T00:00:00.000Z', last_error='quota' WHERE id=?").run(job.id);
  db.prepare("UPDATE sources SET status='exception', last_error='quota' WHERE id=?").run(source.id);
  assert.equal(repository.dashboard().actionCounts.sources, 1);
  assert.equal(repository.dashboard().actionCounts.exceptions, 1);

  assert.equal(repository.retrySource(source.id), true);
  let retried = db.prepare("SELECT * FROM jobs WHERE id=?").get(job.id);
  assert.equal(retried.status, "queued");
  assert.equal(retried.attempts, 0);
  assert.equal(retried.last_error, null);
  assert.ok(Date.parse(retried.available_at) <= Date.now());
  assert.equal(db.prepare("SELECT status FROM sources WHERE id=?").get(source.id).status, "queued");
  assert.equal(repository.dashboard().actionCounts.sources, 0);

  assert.equal(repository.claimJob().id, job.id);
  assert.equal(repository.retrySource(source.id), true);
  retried = db.prepare("SELECT * FROM jobs WHERE type='extract_source' AND entity_id=? AND status IN ('queued','running')").all(source.id);
  assert.equal(retried.length, 1);
  assert.equal(retried[0].status, "running");
  assert.equal(db.prepare("SELECT status FROM sources WHERE id=?").get(source.id).status, "processing");
});

test("a warning knowledge conflict can be resolved by an administrator and then leaves the exception queue", (t) => {
  const { db, repository } = repositoryFixture(t);
  db.prepare("INSERT INTO destinations(id, slug, name, created_at, updated_at) VALUES ('dst1', 'chongqing', 'Chongqing', 'now', 'now')").run();
  db.prepare(`
    INSERT INTO knowledge_facts(id, destination_id, normalized_key, subject, predicate, consensus_status,
      preferred_value, support_count, contradiction_count, evidence_json, updated_at,
      freshness_state, latest_evidence_at, verification_priority)
    VALUES ('fact1', 'dst1', 'hongyadong.lighting', 'Hongyadong', 'has evening lighting', 'conflicted',
      '20:00-23:00', 1, 1, ?, '2026-09-02T00:00:00.000Z', 'current', '2026-09-02T00:00:00.000Z', 'requires_official')
  `).run(JSON.stringify([
    { source_id: 'source-a', value: '20:00-23:00', quote: 'lighting is on 20:00-23:00' },
    { source_id: 'source-b', value: '19:30-22:30', quote: 'lights start at 19:30' },
  ]));

  const exception = repository.listOperationalExceptions().find((item) => item.key === "knowledge:fact1");
  assert.equal(exception.severity, "warning");
  assert.equal(exception.title, "知识事实存在严格冲突，需要判断");
  assert.equal(exception.knowledge.id, "fact1");

  const resolution = repository.resolveKnowledgeConflict("fact1", "19:30-22:30", "Verified against the operator notice.");
  assert.equal(resolution.preferredValue, "19:30-22:30");
  assert.equal(repository.listOperationalExceptions().some((item) => item.key === "knowledge:fact1"), false);
  const fact = repository.getKnowledge().find((item) => item.id === "fact1");
  assert.equal(fact.consensus_status, "resolved");
  assert.equal(fact.preferred_value, "19:30-22:30");
  assert.equal(fact.verification_priority, "manual_confirmed");
  assert.equal(fact.manual_resolution.note, "Verified against the operator notice.");
  assert.equal(repository.dashboard().totals.conflicts, 0);
});

test("extraction review dismissals survive rebuilds while legacy acknowledgements reopen for real correction", (t) => {
  const { db, repository } = repositoryFixture(t);
  const source = repository.saveCapture(normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/extraction-review",
    title: "Chongqing reservation note",
    text: "这是一篇人工筛选保存的重庆旅行笔记，原文说明重庆景点无需提前预约。",
    images: [],
  }));
  repository.saveExtraction(source.id, {
    source: { language: "zh-CN", summary: "Reservation", destination_name: "Chongqing", destination_slug: "chongqing", traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.9 },
    claims: [{ key: "chongqing.reservation", subject: "Chongqing attraction", predicate: "reservation information", value: "advance reservation", qualifiers: [], source_quote: "无需提前预约", confidence: 0.9 }],
    blueprint: { format: "guide", hook: "Booking", angle: "practical", sections: [], strengths: [], gaps: [] },
  }, "test", "fixture-model");

  repository.rebuildKnowledge("chongqing");
  let review = db.prepare("SELECT * FROM claim_review_cases").get();
  assert.equal(review.status, "pending");
  const exception = repository.listOperationalExceptions().find((item) => item.claim_review?.id === review.id);
  assert.equal(exception.claim_review.claimA.sourceId, source.id);
  assert.equal(exception.title, "原文中的否定语义可能没有被完整提取");
  assert.match(exception.claim_review.explanation, /重新提取/);
  assert.throws(() => repository.decideClaimReviewCase(review.id, "resolved"), /can only be resolved by re-extracting/);

  repository.decideClaimReviewCase(review.id, "dismissed");
  repository.rebuildKnowledge("chongqing");
  review = db.prepare("SELECT * FROM claim_review_cases").get();
  assert.equal(review.status, "dismissed");
  assert.equal(repository.listOperationalExceptions().some((item) => item.claim_review?.id === review.id), false);

  db.prepare("UPDATE claim_review_cases SET status='resolved' WHERE id=?").run(review.id);
  repository.rebuildKnowledge("chongqing");
  review = db.prepare("SELECT * FROM claim_review_cases").get();
  assert.equal(review.status, "pending");
});

test("claim review exceptions include both source records, text context, and the exact evidence image", (t) => {
  const { db, repository } = repositoryFixture(t);
  const sourceA = repository.saveCapture(normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/evidenceSourceA123",
    title: "Raffles City riverfront view",
    author: { name: "source author A" },
    text: "The selected note says Raffles City is visible from the opposite riverfront promenade after sunset.",
    images: [],
  }));
  const sourceB = repository.saveCapture(normalizeXiaohongshuCapture({
    url: "https://www.xiaohongshu.com/explore/evidenceSourceB456",
    title: "Cableway corridor view",
    author: { name: "source author B" },
    text: "The selected note contains a photo showing the skyline from the cableway corridor.",
    images: [{ url: "https://ci.xhscdn.com/raffles-city.webp", alt: "Raffles City between residential towers",
      position: 0, aiDerivativeDataUrl: `data:image/webp;base64,${Buffer.from("evidence thumbnail").toString("base64")}` }],
  }));
  const extraction = (value, quote) => ({
    source: { language: "en", summary: "Visibility", destination_name: "Chongqing", destination_slug: "chongqing", traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.9 },
    claims: [{ key: "chongqing.raffles_city.visibility", subject: "Raffles City Chongqing", predicate: "viewpoint", value,
      qualifiers: [], source_quote: quote, confidence: 0.9 }],
    blueprint: { format: "guide", hook: "Views", angle: "practical", sections: [], strengths: [], gaps: [] },
  });
  repository.saveExtraction(sourceA.id, extraction("opposite riverfront promenade", "opposite riverfront promenade"), "test", "fixture", { deferDownstream: true });
  repository.saveExtraction(sourceB.id, extraction("between two residential towers", "[image]"), "test", "fixture", { deferDownstream: true });
  repository.prepareSourceSegments(sourceA.id);
  repository.prepareSourceSegments(sourceB.id);
  const claimA = db.prepare("SELECT id FROM claims WHERE source_id=?").get(sourceA.id);
  const claimB = db.prepare("SELECT id FROM claims WHERE source_id=?").get(sourceB.id);
  const segmentA = db.prepare("SELECT id FROM source_segments WHERE source_id=? AND segment_type='paragraph_group'").get(sourceA.id);
  const segmentB = db.prepare("SELECT id,asset_id,image_index FROM source_segments WHERE source_id=? AND segment_type='image'").get(sourceB.id);
  db.prepare(`INSERT INTO evidence_spans(id,source_id,segment_id,asset_id,locator_type,image_index,quote,region_json,created_at)
    VALUES ('span-text',?,?,NULL,'text',NULL,'opposite riverfront promenade','{}','now')`).run(sourceA.id, segmentA.id);
  db.prepare(`INSERT INTO evidence_spans(id,source_id,segment_id,asset_id,locator_type,image_index,quote,region_json,created_at)
    VALUES ('span-image',?,?,?,'asset',?,'[image]','{}','now')`).run(sourceB.id, segmentB.id, segmentB.asset_id, segmentB.image_index);
  db.prepare("UPDATE claims SET evidence_span_ids_json='[\"span-text\"]' WHERE id=?").run(claimA.id);
  db.prepare("UPDATE claims SET evidence_span_ids_json='[\"span-image\"]' WHERE id=?").run(claimB.id);
  db.prepare(`INSERT INTO claim_review_cases(id,destination_slug,claim_a_id,claim_b_id,review_type,reason,status,created_at,updated_at)
    VALUES ('review-evidence','chongqing',?,?,'SOURCE_CONFLICT','needs evidence','pending','now','now')`).run(claimA.id, claimB.id);
  db.prepare(`INSERT INTO claim_review_cases(id,destination_slug,claim_a_id,claim_b_id,review_type,reason,status,created_at,updated_at)
    VALUES ('review-evidence-duplicate','chongqing',?,?,'SOURCE_CONFLICT','same fact group','pending','now','now')`).run(claimB.id, claimA.id);

  const exceptionItems = repository.listOperationalExceptions();
  const review = exceptionItems.find((item) => item.claim_review?.id === "review-evidence").claim_review;
  const duplicate = exceptionItems.find((item) => item.claim_review?.id === "review-evidence-duplicate").claim_review;
  assert.equal(review.factGroupKey, duplicate.factGroupKey);
  assert.equal(repository.dashboard().totals.exceptions, 0,"editorial evidence decisions do not pollute System Health");
  assert.equal(repository.dashboard().totals.exceptionRecords, 0);
  assert.equal(review.claimA.sourceId, sourceA.id);
  assert.equal(review.claimB.sourceId, sourceB.id);
  assert.equal(review.claimA.evidence.available, true);
  assert.match(review.claimA.evidence.textExcerpt, /opposite riverfront promenade/);
  assert.equal(review.claimB.evidence.available, true);
  assert.equal(review.claimB.evidence.assets.length, 1);
  assert.equal(review.claimB.evidence.assets[0].matched, true);
  assert.equal(review.claimB.evidence.assets[0].previewStored, true);
  assert.match(review.claimB.evidence.assets[0].previewUrl, /^\/api\/source-assets\/asset_[^/]+\/preview$/);
});

test("mutually exclusive daily hard facts create one reusable operator decision", (t) => {
  const { db, repository } = repositoryFixture(t);
  for (const [externalId, value, quote, capturedAt] of [
    ["aaaaaaaaaaaaaaaaaaaaaaaa", "true", "Advance reservation is required.", "2026-01-01T00:00:00.000Z"],
    ["bbbbbbbbbbbbbbbbbbbbbbbb", "false", "No advance reservation is required.", "2026-09-09T00:00:00.000Z"],
  ]) {
    const source = repository.saveCapture(normalizeXiaohongshuCapture({
      url: `https://www.xiaohongshu.com/explore/${externalId}`,
      title: externalId,
      text: `A selected source reports: ${quote}`,
      capturedAt,
      images: [],
    }));
    repository.saveExtraction(source.id, {
      source: { language: "en", summary: "Reservations", destination_name: "Chongqing", destination_slug: "chongqing", traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.9 },
      claims: [{ key: "attraction.test.reservation_required", subject: "Test attraction", predicate: "reservation_required", value, qualifiers: [], source_quote: quote, confidence: 0.9 }],
      blueprint: { format: "guide", hook: "Reservations", angle: "practical", sections: [], strengths: [], gaps: [] },
    }, "test", "fixture-model");
  }

  repository.rebuildKnowledge("chongqing");
  const review = db.prepare("SELECT * FROM claim_review_cases WHERE review_type='SOURCE_CONFLICT'").get();
  assert.ok(review);
  const fact = repository.knowledgeForDestination("chongqing")[0];
  assert.equal(fact.consensus_status, "conflicted");
  assert.equal(fact.consensus_method, "STRICT_SEMANTIC_REVIEW");
  assert.equal(fact.verification_priority, "review");
  assert.equal(fact.contradiction_count, 1);
  assert.equal(fact.claim_relations[0].relation, "CONFLICT");
  assert.equal(repository.listOperationalExceptions().filter((item) => item.kind === "source_conflict").length, 1);
});
