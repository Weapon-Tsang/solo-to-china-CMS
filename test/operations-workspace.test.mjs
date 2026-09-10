import assert from "node:assert/strict";
import test from "node:test";
import { buildContentTaskCard, paginateWorkspace } from "../src/services/operations-workspace.mjs";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";

test("workspace pagination separates page length from filtered total and resumes by cursor", () => {
  const rows = Array.from({ length: 137 }, (_, index) => ({ id: `item-${index}`, title: `Guide ${index}`, status: index % 2 ? "ready" : "blocked" }));
  const first = paginateWorkspace(rows, { limit: 100, search: "guide" });
  assert.equal(first.items.length, 100);
  assert.equal(first.totalCount, 137);
  assert.ok(first.nextCursor);
  const second = paginateWorkspace(rows, { limit: 100, search: "guide", cursor: first.nextCursor });
  assert.equal(second.items.length, 37);
  assert.equal(second.totalCount, 137);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 137);
});

test("quality failure remains independent from complete SEO fields and retries only the failed stage", () => {
  const operation = buildContentTaskCard({
    id: "topic-1", brief_id: "brief-1", draft_id: "draft-1", draft_strategy_version: "1.4",
    qa_passed: 0, qa_score: 92, quality_report_json: JSON.stringify({ issues: [{ message: "Unsupported fare claim", path: "content_ast.nodes[3]" }] }),
    seo_json: JSON.stringify({ meta_title: "Complete title", meta_description: "Complete description", canonical_url: "https://example.test/guide/", canonical_status: "valid" }),
    schema_jsonld: JSON.stringify({ "@graph": [{ "@type": "Article" }] }),
    content_ast_json: JSON.stringify({ nodes: [{ id: "node-1", visible_text: "Text" }] }),
    model_call_count: 0,
  });
  assert.equal(operation.status, "failed");
  assert.equal(operation.dimensions.content_quality.status, "failed");
  assert.equal(operation.dimensions.seo_technical.status, "not_tested");
  assert.equal(operation.dimensions.production_cost.status, "not_tested");
  assert.equal(operation.retry.stage, "revise_draft");
  assert.deepEqual(operation.estimatedAdditionalCalls.stages, ["revise_draft"]);
  assert.doesNotMatch(operation.disclaimer, /预计排名|预计流量|引用率/u);
});

test("CMS artifact checks never claim that final HTML was verified", () => {
  const operation = buildContentTaskCard({
    id: "topic-2", draft_id: "draft-2", brief_id: "brief-2", qa_passed: 1, qa_score: 100,
    seo_json: JSON.stringify({ meta_title: "Title", meta_description: "Description", canonical_url: "https://example.test/a/", canonical_status: "valid" }),
    schema_jsonld: JSON.stringify({ "@graph": [{ "@type": "Article" }] }),
    content_ast_json: JSON.stringify({ nodes: [{ id: "node-1", visible_text: "Text" }] }),
    wordpress_status: null, model_call_count: 2, unknown_cost_count: 2,
  });
  assert.equal(operation.dimensions.seo_technical.status, "not_tested");
  assert.match(operation.dimensions.seo_technical.reason, /final Frontend\/WordPress HTML/);
  assert.equal(operation.dimensions.geo_content_consistency.status, "passed");
  assert.equal(operation.dimensions.production_cost.status, "warning");
});

test("draft comparison and high-impact cancellation require a recorded preview", (t) => {
  const { db, repository } = repositoryFixture(t);
  db.prepare(`INSERT INTO topic_candidates(id,destination_slug,topic_key,proposed_title,rationale,coverage_score,evidence_count,conflict_count,status,created_at,updated_at)
    VALUES ('topic-history','beijing','history','History guide','fixture',80,0,0,'drafted','now','now')`).run();
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at,candidate_id)
    VALUES ('brief-history','beijing','History guide','[]','informational','drafted','now','now','topic-history')`).run();
  db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at,revision,content_hash)
    VALUES ('draft-history','brief-history','History guide','history-guide','First body','{}','qa_failed','now','now',1,'hash-1')`).run();
  repository.recordDraftRevision("draft-history", "fixture-v1");
  db.prepare("UPDATE article_drafts SET body_markdown='Second body',revision=2,content_hash='hash-2',updated_at='later' WHERE id='draft-history'").run();
  repository.recordDraftRevision("draft-history", "fixture-v2");
  const comparison = repository.compareDraftRevisions("draft-history", 1, 2);
  assert.deepEqual(comparison.changedFields, ["body_markdown"]);
  repository.enqueue("revise_draft", "draft-history");
  assert.throws(() => repository.cancelContent("topic-history", "missing-preview"), /preview is required/);
  const preview = repository.previewContentAction("topic-history", "cancel", "tester");
  assert.deepEqual(preview.preserves, ["sources", "claims", "knowledge", "draft_revisions", "commercial_events"]);
  assert.equal(preview.affectedJobs[0].type, "revise_draft");
  const result = repository.cancelContent("topic-history", preview.id, "tester");
  assert.equal(result.cancelledJobs, 1);
  assert.equal(repository.listDraftRevisions("draft-history").length, 2);
  assert.equal(repository.listContentOperationHistory("topic-history")[0].status, "completed");
});
