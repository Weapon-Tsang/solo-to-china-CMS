import assert from "node:assert/strict";
import test from "node:test";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";

test("nonempty production-shaped workspace pages in SQL and omits heavy detail payloads", (t) => {
  const { db, repository } = repositoryFixture(t);
  const opportunities = db.prepare(`INSERT INTO content_opportunities
    (id,destination_slug,topic_key,strategy_version,candidate_id,title,content_type,readiness_score,
      readiness_json,coverage_json,status,approved_at,created_at,updated_at,lifecycle_state)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const candidates = db.prepare(`INSERT INTO topic_candidates
    (id,destination_slug,topic_key,proposed_title,rationale,coverage_score,evidence_count,
      conflict_count,status,created_at,updated_at) VALUES (?,?,?,?,?,80,2,0,'drafted',?,?)`);
  const briefs = db.prepare(`INSERT INTO content_briefs
    (id,destination_slug,topic,audience,search_intent,status,created_at,updated_at,candidate_id)
    VALUES (?,'beijing',?,'first-time traveler','informational','ready',?,?,?)`);
  const drafts = db.prepare(`INSERT INTO article_drafts
    (id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at,revision,content_hash)
    VALUES (?,?,?,?,?,?,'review',?,?,1,?)`);
  db.exec("BEGIN IMMEDIATE");
  for (let index = 0; index < 121; index += 1) {
    const id = String(index).padStart(3, "0");
    const timestamp = `2026-09-18T${String(index % 24).padStart(2, "0")}:00:00.000Z`;
    const candidate = `candidate-${id}`;
    candidates.run(candidate, "beijing", `candidate:${id}`, `Local guide ${id}`, "isolated fixture", timestamp, timestamp);
    opportunities.run(`opp-${id}`, "beijing", `opportunity:${id}`, "3.8", candidate, `Local guide ${id}`,
      "practical_guide", 80, '{"ready":true}', "{}", "approved_ready", timestamp, timestamp, timestamp, "approved");
    if (index < 60) {
      briefs.run(`brief-${id}`, `Local guide ${id}`, timestamp, timestamp, candidate);
      drafts.run(`draft-${id}`, `brief-${id}`, `Long test article ${id}`, `local-guide-${id}`,
        "Test body. ".repeat(400), '{"issues":[]}', timestamp, timestamp, `hash-${id}`);
    }
  }
  db.exec("COMMIT");

  const seen = new Set();
  let offset = 0;
  let pageCount = 0;
  do {
    const page = repository.listContentWorkspace({ productionOnly: true, limit: 50, offset, compact: true });
    assert.ok(page.items.length > 0 && page.items.length <= 50);
    assert.equal(page.sectionScope, "loaded");
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 180_000, "list must not serialize article/contract JSON");
    for (const item of page.items) {
      assert.ok(!seen.has(item.opportunity_id));
      seen.add(item.opportunity_id);
      assert.ok(item.production_state?.lifecycle);
      assert.equal(item.body_markdown, undefined);
      assert.equal(item.publish_package_json, undefined);
    }
    offset = page.nextCursor === null ? null : Number(page.nextCursor);
    pageCount += 1;
  } while (offset !== null);
  assert.equal(pageCount, 3);
  assert.equal(seen.size, 121);

  const originalGetBriefPackage = repository.getBriefPackage;
  repository.getBriefPackage = () => { throw new Error("compact workspace must not load full brief/media evidence"); };
  try {
    const compact = repository.listContentWorkspace({ productionOnly: true, limit: 50, offset: 0, compact: true });
    assert.equal(compact.items.length, 50);
  } finally {
    repository.getBriefPackage = originalGetBriefPackage;
  }

  let prepared=0;
  const originalPrepare=db.prepare.bind(db);
  db.prepare=(...args)=>{prepared+=1;return originalPrepare(...args);};
  const firstBefore=repository.listContentWorkspace({productionOnly:true,limit:50,offset:0,compact:true});
  const beforeStatements=prepared;
  assert.ok(beforeStatements <= 30, `compact status projection used ${beforeStatements} SQL statements`);
  const detailed=repository.listContent({productionOnly:true,limit:1,offset:0,compact:false})[0];
  const summary=repository.listContent({productionOnly:true,limit:1,offset:0,compact:true})[0].production_state;
  for (const key of ['lifecycle','stage_status','current_stage','completed_stages','latest_error','available_actions']) {
    assert.deepEqual(summary[key],detailed.production_state[key],`compact ${key} differs from detail`);
  }
  const beforeBytes=Buffer.byteLength(JSON.stringify(firstBefore));
  db.exec("BEGIN IMMEDIATE");
  for(let index=0;index<200;index+=1){
    const id=String(index).padStart(3,"0");
    candidates.run(`older-candidate-${id}`,"beijing",`older-candidate:${id}`,`Older guide ${id}`,
      "isolated scale fixture","2026-01-01","2026-01-01");
    opportunities.run(`older-opp-${id}`,"beijing",`older-opportunity:${id}`,"3.8",`older-candidate-${id}`,
      `Older guide ${id}`,"practical_guide",80,'{"ready":true}',"{}","approved_ready",
      "2026-01-01","2026-01-01","2026-01-01","approved");
  }
  db.exec("COMMIT");
  prepared=0;
  const firstAfter=repository.listContentWorkspace({productionOnly:true,limit:50,offset:0,compact:true});
  assert.deepEqual(firstAfter.items.map((item)=>item.opportunity_id),firstBefore.items.map((item)=>item.opportunity_id));
  assert.ok(prepared<=beforeStatements+2,"detail-level statement count must depend on page size, not database size");
  assert.ok(Buffer.byteLength(JSON.stringify(firstAfter))<=beforeBytes*1.1,"first-page payload must stay bounded");
});
